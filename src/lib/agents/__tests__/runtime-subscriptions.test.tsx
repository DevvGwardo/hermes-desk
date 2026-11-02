import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransportEvent } from '../transport'

const fake = vi.hoisted(() => ({
  lookup: vi.fn(), subscribe: vi.fn(), watch: vi.fn(),
  rows: vi.fn(), append: vi.fn(), warn: vi.fn(),
}))
vi.mock('../active-transport', () => ({
  getActiveTransport: fake.lookup,
  resetActiveTransport: () => {},
}))
vi.mock('../useBootWarmup', () => ({ useBootWarmup: () => {}, useBehindWarmup: () => {} }))
vi.mock('../audit-log', () => ({ auditRowsFromTransportEvent: fake.rows, appendAuditRows: fake.append }))
vi.mock('../../logger', () => ({ logger: { log: vi.fn(), warn: fake.warn, error: vi.fn() } }))
vi.mock('../../hermes-agents', () => ({ syncRosterToHermes: async () => {}, syncDesktopAgentToHermes: async () => {} }))
vi.mock('../../avatar-intent', () => ({ maybeApplyAvatarIntent: () => {} }))
vi.mock('../../subagent-continue', () => ({ startDelegateContinuations: () => () => {}, continueAfterSubagent: () => {} }))

import { getState, resetStore, setState } from '../store'
import { useAgentRuntime } from '../useAgentRuntime'

const a = 'runtime-subscriptions-agent', g = 'runtime-subscriptions-room'
const listeners = new Set<(event: TransportEvent) => void>()
const releases: ReturnType<typeof vi.fn>[] = []
const roomReleases: ReturnType<typeof vi.fn>[] = []
const pendingCleanup: (() => void)[] = []
const transport: { subscribe: typeof fake.subscribe; watchRoom?: typeof fake.watch } =
  { subscribe: fake.subscribe, watchRoom: fake.watch }
const ready = { transport, mode: 'serve', source: 'synthetic-runtime-subscriptions' }
const auditRow = {
  ts: '2026-10-07T00:00:00Z', conversationId: a, verb: 'tool',
  target: 'Synthetic action', outcome: 'completed', origin: 'mac',
}
const activity: TransportEvent = {
  type: 'message', conversationId: a,
  message: { id: 'synthetic-action', threadId: a, role: 'agent', content: '', createdAt: auditRow.ts,
    toolEvents: [{ tool: 'synthetic_tool', status: 'completed' }] },
}
const queued: TransportEvent = {
  type: 'queued', conversationId: a, count: 1,
  items: [{ id: 'synthetic-queued', text: 'Synthetic queued request.', enqueuedAt: auditRow.ts }],
}

function deferredLookup() {
  let resolve!: (value: typeof ready) => void, reject!: (reason: unknown) => void
  const promise = new Promise<typeof ready>((yes, no) => { resolve = yes; reject = no })
  pendingCleanup.push(() => resolve(ready))
  return { promise, resolve, reject }
}
function emit(event: TransportEvent) {
  for (const listener of [...listeners]) listener(event)
}
async function mounted() {
  const view = renderHook(() => useAgentRuntime())
  await act(async () => { await vi.dynamicImportSettled() })
  await waitFor(() => expect(listeners.size).toBe(2))
  return view
}

beforeEach(async () => {
  const [active, audit] = await Promise.all([import('../active-transport'), import('../audit-log')])
  expect(active.getActiveTransport).toBe(fake.lookup)
  expect(audit.auditRowsFromTransportEvent).toBe(fake.rows)
  // Concurrent runtime imports can see the real namespace in this runner.
  // Intercept that path too, so every setup uses the same isolated fixture.
  const actualTransport = await vi.importActual<typeof import('../active-transport')>('../active-transport')
  const actualAudit = await vi.importActual<typeof import('../audit-log')>('../audit-log')
  vi.spyOn(actualTransport, 'getActiveTransport').mockImplementation(fake.lookup)
  vi.spyOn(actualAudit, 'auditRowsFromTransportEvent').mockImplementation(fake.rows)
  vi.spyOn(actualAudit, 'appendAuditRows').mockImplementation(fake.append)
  resetStore()
  const createdAt = auditRow.ts
  setState({
    agents: [{ id: 'fixture-agent', name: 'Synthetic agent', status: 'running', region: 'local', summary: '', createdAt }],
    groups: [{ id: 'fixture-group', name: 'Synthetic room', memberAgentIds: ['fixture-agent'], primaryAgentId: 'fixture-agent', createdAt }],
    conversations: [
      { id: a, title: 'Synthetic agent chat', target: { type: 'agent', agentId: 'fixture-agent' }, createdAt, lastUsedAt: createdAt },
      { id: g, title: 'Synthetic room chat', target: { type: 'group', groupId: 'fixture-group' }, createdAt, lastUsedAt: createdAt },
    ],
    selectedConversationId: a, messagesByThreadId: { [a]: [], [g]: [] },
  })
  listeners.clear(); releases.length = 0; roomReleases.length = 0
  fake.lookup.mockReset().mockResolvedValue(ready)
  fake.subscribe.mockReset().mockImplementation((listener: (event: TransportEvent) => void) => {
    listeners.add(listener)
    const release = vi.fn(() => { listeners.delete(listener) })
    releases.push(release)
    return release
  })
  fake.watch.mockReset().mockImplementation(() => {
    const release = vi.fn()
    roomReleases.push(release)
    return release
  })
  transport.watchRoom = fake.watch
  fake.rows.mockReset().mockImplementation((event: TransportEvent) => event.type === 'queued' ? [] : [auditRow])
  fake.append.mockReset()
  fake.warn.mockReset()
})
afterEach(async () => {
  await act(async () => { for (const finish of pendingCleanup.splice(0)) finish() })
  cleanup()
  listeners.clear()
})

describe('runtime subscription lifetime', () => {
  it('updates the queue, appends one audit row and releases both mounted listeners', async () => {
    const view = await mounted()
    act(() => { emit(queued); emit(activity) })
    expect(view.result.current.queuedCount(a)).toBe(1)
    expect(view.result.current.queuedMessages(a)).toEqual(queued.items)
    expect(fake.append).toHaveBeenCalledOnce()
    expect(fake.append).toHaveBeenCalledWith([auditRow])
    view.unmount()
    expect(listeners.size).toBe(0)
    for (const release of releases) expect(release).toHaveBeenCalledOnce()
    expect(fake.warn).not.toHaveBeenCalled()
  })

  it('does not attach listeners when transport lookup resolves after unmount', async () => {
    const lookup = deferredLookup()
    fake.lookup.mockReturnValue(lookup.promise)
    const view = renderHook(() => useAgentRuntime())
    await act(async () => { await vi.dynamicImportSettled() })
    await waitFor(() => expect(fake.lookup).toHaveBeenCalledTimes(2))
    view.unmount()
    await act(async () => { lookup.resolve(ready) })
    expect(listeners.size).toBe(0)
    expect(fake.subscribe).not.toHaveBeenCalled()
    emit(activity)
    expect(fake.append).not.toHaveBeenCalled()
  })

  it('keeps only the new mount listeners when an older lookup finishes', async () => {
    const lookup = deferredLookup()
    fake.lookup.mockReturnValue(lookup.promise)
    const old = renderHook(() => useAgentRuntime())
    await act(async () => { await vi.dynamicImportSettled() })
    await waitFor(() => expect(fake.lookup).toHaveBeenCalledTimes(2))
    old.unmount()
    fake.lookup.mockResolvedValue(ready)
    const current = await mounted()
    await act(async () => { lookup.resolve(ready) })
    expect(listeners.size).toBe(2)
    act(() => emit(activity))
    expect(fake.append).toHaveBeenCalledOnce()
    current.unmount()
    expect(listeners.size).toBe(0)
  })

  it('ignores callbacks retained in an emitter snapshot after cleanup', async () => {
    const view = await mounted()
    const captured = [...listeners]
    view.unmount()
    for (const listener of captured) listener(activity)
    expect(fake.rows).not.toHaveBeenCalled()
    expect(fake.append).not.toHaveBeenCalled()
  })

  it.each(['subscriptions', 'room'] as const)('contains a late %s lookup rejection after unmount without stale diagnostics', async kind => {
    const lookup = deferredLookup()
    let view: Awaited<ReturnType<typeof mounted>>
    if (kind === 'subscriptions') {
      fake.lookup.mockReturnValue(lookup.promise)
      view = renderHook(() => useAgentRuntime())
      await act(async () => { await vi.dynamicImportSettled() })
      await waitFor(() => expect(fake.lookup).toHaveBeenCalledTimes(2))
    } else {
      view = await mounted()
      fake.lookup.mockReturnValueOnce(lookup.promise)
      act(() => view.result.current.handleSelect(g))
    }
    view.unmount()
    await act(async () => { lookup.reject(new Error('Synthetic stale setup detail')) })
    expect(listeners.size).toBe(0)
    expect(fake.warn).not.toHaveBeenCalled()
    expect(fake.watch).not.toHaveBeenCalled()
  })

  it('releases the room watcher when selection leaves the room', async () => {
    const view = await mounted()
    act(() => view.result.current.handleSelect(g))
    await waitFor(() => expect(fake.watch).toHaveBeenCalledWith(g))
    act(() => view.result.current.handleSelect(a))
    expect(roomReleases[0]).toHaveBeenCalledOnce()
    view.unmount()
    expect(roomReleases[0]).toHaveBeenCalledOnce()
  })

  it.each(['other-chat', 'unmounted'] as const)('does not start a delayed obsolete room watcher after %s', async visit => {
    const view = await mounted()
    const lookup = deferredLookup()
    fake.lookup.mockReturnValueOnce(lookup.promise)
    act(() => view.result.current.handleSelect(g))
    if (visit === 'unmounted') view.unmount()
    else act(() => view.result.current.handleSelect(a))
    await act(async () => { lookup.resolve(ready) })
    expect(fake.watch).not.toHaveBeenCalled()
  })

  it('supports a transport with no room watcher', async () => {
    transport.watchRoom = undefined
    const view = await mounted()
    act(() => view.result.current.handleSelect(g))
    await act(async () => {})
    expect(getState().selectedConversationId).toBe(g)
    expect(fake.warn).not.toHaveBeenCalled()
    expect(fake.watch).not.toHaveBeenCalled()
  })

  it.each(['lookup', 'subscribe', 'room-lookup', 'room-watch'] as const)(
    'contains %s setup failure without logging its raw details',
    async failure => {
      const error = new Error('Synthetic private subscription setup detail')
      let view: Awaited<ReturnType<typeof mounted>>
      if (failure === 'lookup' || failure === 'subscribe') {
        if (failure === 'lookup') fake.lookup.mockRejectedValue(error)
        else fake.subscribe.mockImplementation(() => { throw error })
        view = renderHook(() => useAgentRuntime())
      } else {
        const room = await mounted()
        view = room
        if (failure === 'room-lookup') fake.lookup.mockRejectedValueOnce(error)
        else fake.watch.mockImplementation(() => { throw error })
        act(() => room.result.current.handleSelect(g))
      }
      await waitFor(() => expect(fake.warn).toHaveBeenCalled())
      expect(fake.warn.mock.calls.flat().join(' ')).not.toContain(error.message)
      view.unmount()
      expect(listeners.size).toBe(0)
    },
  )
})
