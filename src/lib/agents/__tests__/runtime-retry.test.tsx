import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  lookup: vi.fn(), send: vi.fn(), retry: vi.fn(), subscribe: vi.fn(() => () => {}),
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
import { SendError } from '../send-outcome'

const pendingCleanup: (() => void)[] = []
const transport: { subscribe: typeof fake.subscribe; sendMessage: typeof fake.send; retryTurn?: typeof fake.retry } =
  { subscribe: fake.subscribe, sendMessage: fake.send, retryTurn: fake.retry }
const ready = { transport, mode: 'serve', source: 'synthetic-runtime-retry' }
const a = 'runtime-retry-a', b = 'runtime-retry-b'

function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  pendingCleanup.push(() => resolve(cleanupValue))
  return { promise, resolve }
}

beforeEach(() => {
  resetStore()
  const createdAt = '2026-10-07T00:00:00Z'
  setState({
    agents: [{ id: 'fixture-agent', name: 'Synthetic agent', status: 'running', region: 'local', summary: '', createdAt }],
    conversations: [a, b].map(id => ({ id, title: id, target: { type: 'agent' as const, agentId: 'fixture-agent' }, createdAt, lastUsedAt: createdAt })),
    selectedConversationId: a, messagesByThreadId: Object.fromEntries([a, b].map(id => [id, [
      { id: `${id}-user`, threadId: id, role: 'user' as const, content: 'Synthetic previous request.', createdAt },
      { id: `${id}-error`, threadId: id, role: 'agent' as const, content: 'Synthetic failed reply.', error: true, createdAt },
    ]])),
  })
  fake.lookup.mockReset().mockResolvedValue(ready)
  fake.send.mockReset()
  fake.retry.mockReset().mockResolvedValue(false)
  transport.retryTurn = fake.retry
  fake.subscribe.mockClear()
})
afterEach(async () => {
  await act(async () => { for (const finish of pendingCleanup.splice(0)) finish() })
  cleanup()
  vi.useRealTimers()
})

async function runtime() {
  const view = renderHook(() => useAgentRuntime())
  await waitFor(() => expect(fake.subscribe).toHaveBeenCalled())
  await act(async () => {})
  vi.useFakeTimers()
  return view
}
async function start(view: Awaited<ReturnType<typeof runtime>>) {
  const reply = deferred<unknown>(undefined)
  fake.send.mockReturnValueOnce(reply.promise)
  act(() => { void view.result.current.handleSend('Synthetic local turn.') })
  await act(async () => {})
  expect(view.result.current.activityPhase).toBe('listening')
}

describe('confirmed runtime Retry ownership', () => {
  it.each(['rejected', 'uncertain'] as const)('reports %s delivery rather than swallowing the send error', async status => {
    const view = await runtime()
    fake.send.mockRejectedValueOnce(new SendError(status))
    await act(async () => { expect(await view.result.current.handleSend('A retained draft')).toEqual({ status }) })
  })

  it('reports lookup failure as definitely not dispatched', async () => {
    const view = await runtime()
    fake.lookup.mockRejectedValueOnce(new Error('Synthetic lookup refusal'))
    await act(async () => { expect(await view.result.current.handleSend('A retained draft')).toEqual({ status: 'rejected' }) })
    expect(fake.send).not.toHaveBeenCalled()
  })

  it.each(['false', 'reject', 'throw', 'unsupported', 'lookup-reject'] as const)(
    'preserves local activity when Retry fails with %s',
    async failure => {
      const view = await runtime()
      await start(view)
      if (failure === 'reject') fake.retry.mockRejectedValueOnce(new Error('Synthetic retry rejection'))
      if (failure === 'throw') fake.retry.mockImplementationOnce(() => { throw new Error('Synthetic retry throw') })
      if (failure === 'unsupported') transport.retryTurn = undefined
      if (failure === 'lookup-reject') fake.lookup.mockRejectedValueOnce(new Error('Synthetic lookup rejection'))
      await act(async () => { expect(await view.result.current.retryTurn()).toBe(false) })
      expect(view.result.current.activityPhase).toBe('listening')
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(view.result.current.activityPhase).toBe('thinking')
    },
  )

  it('waits for positive retry confirmation before cancelling the prior local phase', async () => {
    const view = await runtime()
    await start(view)
    const confirmation = deferred(false)
    fake.retry.mockReturnValueOnce(confirmation.promise)
    let retrying!: Promise<boolean>
    act(() => { retrying = view.result.current.retryTurn() })
    await act(async () => {})
    const whilePending = view.result.current.activityPhase
    await act(async () => { confirmation.resolve(true); expect(await retrying).toBe(true) })
    expect(whilePending).toBe('listening')
    expect(view.result.current.activityPhase).toBe('idle')
    await act(async () => { await vi.advanceTimersByTimeAsync(1900) })
    expect(view.result.current.activityPhase).toBe('idle')
  })

  it('allows an explicit confirmed retry after a failed attempt without cancelling prematurely', async () => {
    const view = await runtime()
    await start(view)
    fake.retry.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await act(async () => { expect(await view.result.current.retryTurn()).toBe(false) })
    expect(view.result.current.activityPhase).toBe('listening')
    await act(async () => { expect(await view.result.current.retryTurn()).toBe(true) })
    expect(fake.retry).toHaveBeenCalledTimes(2)
    expect(fake.retry).toHaveBeenNthCalledWith(2, a)
    expect(view.result.current.activityPhase).toBe('idle')
  })

  it.each([false, true])('does not release a pending send lookup on Retry=%s', async retried => {
    const view = await runtime()
    const lookup = deferred(ready)
    fake.lookup.mockReturnValueOnce(lookup.promise)
    fake.send.mockResolvedValue(undefined)
    let sent!: ReturnType<typeof view.result.current.handleSend>
    act(() => { sent = view.result.current.handleSend('Synthetic lookup-pending send.') })
    expect(view.result.current.sending).toBe(true)
    fake.retry.mockResolvedValueOnce(retried)
    await act(async () => { expect(await view.result.current.retryTurn()).toBe(retried) })
    const sendingAfterRetry = view.result.current.sending
    const stillLive = view.result.current.liveConversationIds.has(a)
    await act(async () => { lookup.resolve(ready); await sent })
    expect(sendingAfterRetry).toBe(true)
    expect(stillLive).toBe(true)
    expect(view.result.current.sending).toBe(false)
  })

  it.each(['same-chat', 'other-chat', 'a-b-a', 'unmounted'] as const)(
    'does not dispatch an obsolete Retry after delayed transport lookup in %s',
    async visit => {
      const view = await runtime()
      await start(view)
      const lookup = deferred(ready)
      fake.lookup.mockReturnValueOnce(lookup.promise)
      fake.retry.mockResolvedValueOnce(true)
      let retrying!: Promise<boolean>
      act(() => { retrying = view.result.current.retryTurn() })
      if (visit === 'unmounted') view.unmount()
      else {
        if (visit !== 'same-chat') act(() => view.result.current.handleSelect(b))
        if (visit === 'a-b-a') act(() => view.result.current.handleSelect(a))
        await start(view)
      }
      await act(async () => { lookup.resolve(ready); expect(await retrying).toBe(false) })
      expect(fake.retry).not.toHaveBeenCalled()
      if (visit !== 'unmounted') expect(view.result.current.activityPhase).toBe('listening')
    },
  )

  it.each(['same-chat', 'other-chat', 'a-b-a'] as const)(
    'does not cancel a newer local turn after delayed Retry confirmation in %s',
    async visit => {
      const view = await runtime()
      await start(view)
      const confirmation = deferred(false)
      fake.retry.mockReturnValueOnce(confirmation.promise)
      let retrying!: Promise<boolean>
      act(() => { retrying = view.result.current.retryTurn() })
      await act(async () => {})
      if (visit !== 'same-chat') act(() => view.result.current.handleSelect(b))
      if (visit === 'a-b-a') act(() => view.result.current.handleSelect(a))
      await start(view)
      await act(async () => { confirmation.resolve(true); expect(await retrying).toBe(true) })
      expect(view.result.current.activityPhase).toBe('listening')
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(view.result.current.activityPhase).toBe('thinking')
      expect(fake.retry).toHaveBeenCalledWith(a)
    },
  )

  it('refuses a captured Retry callback after its conversation loses selection', async () => {
    const view = await runtime()
    const retry = view.result.current.retryTurn
    act(() => view.result.current.handleSelect(b))
    fake.lookup.mockClear()
    fake.retry.mockResolvedValueOnce(true)
    await act(async () => { expect(await retry()).toBe(false) })
    expect(fake.lookup).not.toHaveBeenCalled()
    expect(fake.retry).not.toHaveBeenCalled()
  })

  it('does not look up a transport when no conversation is selected', async () => {
    const view = await runtime()
    act(() => setState({ selectedConversationId: null, conversations: [] }))
    expect(view.result.current.selectedConversation).toBeNull()
    fake.lookup.mockClear()
    await act(async () => { expect(await view.result.current.retryTurn()).toBe(false) })
    expect(fake.lookup).not.toHaveBeenCalled()
    expect(fake.retry).not.toHaveBeenCalled()
  })
})
