import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  lookup: vi.fn(), send: vi.fn(), stop: vi.fn(), subscribe: vi.fn(() => () => {}),
}))
vi.mock('../active-transport', () => ({
  getActiveTransport: fake.lookup,
  resetActiveTransport: () => {},
}))
vi.mock('../useBootWarmup', () => ({ useBootWarmup: () => {}, useBehindWarmup: () => {} }))
vi.mock('../audit-log', () => ({ auditRowsFromTransportEvent: () => [], appendAuditRows: () => {} }))
vi.mock('../../hermes-agents', () => ({ syncRosterToHermes: async () => {}, syncDesktopAgentToHermes: async () => {} }))
vi.mock('../../avatar-intent', () => ({ maybeApplyAvatarIntent: () => {} }))
vi.mock('../../subagent-continue', () => ({ startDelegateContinuations: () => () => {}, continueAfterSubagent: () => {} }))

import { resetStore, setState } from '../store'
import { useAgentRuntime } from '../useAgentRuntime'
import { takeTurnStopped } from '../../ui-sounds'

const pendingCleanup: (() => void)[] = []
const transport: { subscribe: typeof fake.subscribe; sendMessage: typeof fake.send; stopTurn?: typeof fake.stop } =
  { subscribe: fake.subscribe, sendMessage: fake.send, stopTurn: fake.stop }
const ready = { transport, mode: 'serve', source: 'synthetic-runtime-stop' }
const a = 'runtime-stop-a', b = 'runtime-stop-b'

function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  pendingCleanup.push(() => resolve(cleanupValue))
  return { promise, resolve, reject }
}

beforeEach(() => {
  resetStore()
  const createdAt = '2026-10-07T00:00:00Z'
  setState({
    agents: [{ id: 'fixture-agent', name: 'Synthetic agent', status: 'running', region: 'local', summary: '', createdAt }],
    conversations: [a, b].map(id => ({ id, title: id, target: { type: 'agent' as const, agentId: 'fixture-agent' }, createdAt, lastUsedAt: createdAt })),
    selectedConversationId: a, messagesByThreadId: { [a]: [], [b]: [] },
  })
  fake.lookup.mockReset().mockResolvedValue(ready)
  fake.send.mockReset()
  fake.stop.mockReset().mockResolvedValue(false)
  transport.stopTurn = fake.stop
  fake.subscribe.mockClear()
  takeTurnStopped(a); takeTurnStopped(b)
})
afterEach(async () => {
  await act(async () => { for (const finish of pendingCleanup.splice(0)) finish() })
  cleanup()
  vi.useRealTimers()
  takeTurnStopped(a); takeTurnStopped(b)
})

async function runtime() {
  const view = renderHook(() => useAgentRuntime())
  await waitFor(() => expect(fake.subscribe).toHaveBeenCalled())
  vi.useFakeTimers()
  return view
}
async function start(view: Awaited<ReturnType<typeof runtime>>) {
  const reply = deferred<unknown>(undefined)
  fake.send.mockReturnValueOnce(reply.promise)
  let sent!: ReturnType<typeof view.result.current.handleSend>
  act(() => { sent = view.result.current.handleSend('Synthetic local turn.') })
  await act(async () => {})
  expect(view.result.current.activityPhase).toBe('listening')
  return { sent, reply }
}

describe('confirmed runtime Stop ownership', () => {
  it.each(['false', 'reject', 'throw', 'unsupported', 'lookup-reject'] as const)(
    'preserves local activity and completion cues when Stop fails with %s',
    async failure => {
      const view = await runtime()
      await start(view)
      if (failure === 'reject') fake.stop.mockRejectedValueOnce(new Error('Synthetic stop rejection'))
      if (failure === 'throw') fake.stop.mockImplementationOnce(() => { throw new Error('Synthetic stop throw') })
      if (failure === 'unsupported') transport.stopTurn = undefined
      if (failure === 'lookup-reject') fake.lookup.mockRejectedValueOnce(new Error('Synthetic lookup rejection'))
      let stopped!: boolean
      await act(async () => { stopped = await view.result.current.stopTurn() })
      expect(stopped).toBe(false)
      expect(takeTurnStopped(a)).toBe(false)
      expect(view.result.current.activityPhase).toBe('listening')
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(view.result.current.activityPhase).toBe('thinking')
    },
  )

  it('waits for positive confirmation before cancelling local activity and suppressing its cue', async () => {
    const view = await runtime()
    await start(view)
    const confirmation = deferred(false)
    fake.stop.mockReturnValueOnce(confirmation.promise)
    let stopping!: Promise<boolean>
    act(() => { stopping = view.result.current.stopTurn() })
    await act(async () => {})
    const whilePending = view.result.current.activityPhase
    const markedBeforeConfirmation = takeTurnStopped(a)
    let stopped!: boolean
    await act(async () => { confirmation.resolve(true); stopped = await stopping })
    expect(whilePending).toBe('listening')
    expect(markedBeforeConfirmation).toBe(false)
    expect(stopped).toBe(true)
    expect(takeTurnStopped(a)).toBe(true)
    expect(view.result.current.activityPhase).toBe('idle')
    await act(async () => { await vi.advanceTimersByTimeAsync(1900) })
    expect(view.result.current.activityPhase).toBe('idle')
  })

  it('preserves the current turn after failure and accepts an explicit confirmed retry', async () => {
    const view = await runtime()
    await start(view)
    fake.stop.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await act(async () => { expect(await view.result.current.stopTurn()).toBe(false) })
    expect(view.result.current.activityPhase).toBe('listening')
    expect(takeTurnStopped(a)).toBe(false)
    await act(async () => { expect(await view.result.current.stopTurn()).toBe(true) })
    expect(fake.stop).toHaveBeenCalledTimes(2)
    expect(fake.stop).toHaveBeenNthCalledWith(2, a)
    expect(view.result.current.activityPhase).toBe('idle')
    expect(takeTurnStopped(a)).toBe(true)
  })

  it.each([false, true])('does not decrement a pending send lookup on Stop=%s', async stopped => {
    const view = await runtime()
    const lookup = deferred(ready)
    fake.lookup.mockReturnValueOnce(lookup.promise)
    fake.send.mockResolvedValue(undefined)
    let sent!: ReturnType<typeof view.result.current.handleSend>
    act(() => { sent = view.result.current.handleSend('Synthetic lookup-pending send.') })
    expect(view.result.current.sending).toBe(true)
    fake.stop.mockResolvedValueOnce(stopped)
    await act(async () => { expect(await view.result.current.stopTurn()).toBe(stopped) })
    const sendingAfterStop = view.result.current.sending
    const stillLive = view.result.current.liveConversationIds.has(a)
    await act(async () => { lookup.resolve(ready); await sent })
    expect(sendingAfterStop).toBe(true)
    expect(stillLive).toBe(true)
    expect(view.result.current.sending).toBe(false)
  })

  it.each(['same-chat', 'other-chat', 'a-b-a'] as const)(
    'does not alter a newer local turn after a delayed confirmation in %s',
    async visit => {
      const view = await runtime()
      await start(view)
      const confirmation = deferred(false)
      fake.stop.mockReturnValueOnce(confirmation.promise)
      let stopping!: Promise<boolean>
      act(() => { stopping = view.result.current.stopTurn() })
      await act(async () => {})
      if (visit !== 'same-chat') act(() => view.result.current.handleSelect(b))
      if (visit === 'a-b-a') act(() => view.result.current.handleSelect(a))
      await start(view)
      let stopped!: boolean
      await act(async () => { confirmation.resolve(true); stopped = await stopping })
      expect(stopped).toBe(true)
      expect(view.result.current.activityPhase).toBe('listening')
      expect(takeTurnStopped(a)).toBe(false)
      expect(takeTurnStopped(b)).toBe(false)
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(view.result.current.activityPhase).toBe('thinking')
      expect(fake.stop).toHaveBeenCalledWith(a)
    },
  )

  it.each(['same-chat', 'other-chat', 'a-b-a', 'unmounted'] as const)(
    'does not dispatch an obsolete Stop after a delayed transport lookup in %s',
    async visit => {
      const view = await runtime()
      await start(view)
      const lookup = deferred(ready)
      fake.lookup.mockReturnValueOnce(lookup.promise)
      fake.stop.mockResolvedValueOnce(true)
      let stopping!: Promise<boolean>
      act(() => { stopping = view.result.current.stopTurn() })
      if (visit === 'unmounted') view.unmount()
      else {
        if (visit !== 'same-chat') act(() => view.result.current.handleSelect(b))
        if (visit === 'a-b-a') act(() => view.result.current.handleSelect(a))
        await start(view)
      }
      let stopped!: boolean
      await act(async () => { lookup.resolve(ready); stopped = await stopping })
      expect(stopped).toBe(false)
      expect(fake.stop).not.toHaveBeenCalled()
      expect(takeTurnStopped(a)).toBe(false)
      if (visit !== 'unmounted') expect(view.result.current.activityPhase).toBe('listening')
    },
  )

  it('invalidates local Stop completion after the runtime unmounts', async () => {
    const view = await runtime()
    await start(view)
    const confirmation = deferred(false)
    fake.stop.mockReturnValueOnce(confirmation.promise)
    let stopping!: Promise<boolean>
    act(() => { stopping = view.result.current.stopTurn() })
    await act(async () => {})
    view.unmount()
    await act(async () => { confirmation.resolve(true); expect(await stopping).toBe(true) })
    expect(takeTurnStopped(a)).toBe(false)
  })
})
