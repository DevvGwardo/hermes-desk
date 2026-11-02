import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The restored selection loads its transcript at boot, usually before serve is
// up. That fetch fails quietly; re-choosing the same thread (Home, sidebar) did
// not change the selection, so the chat stayed empty until another thread was opened.

const fake = vi.hoisted(() => ({ lookup: vi.fn(), getMessages: vi.fn(), subscribe: vi.fn(() => () => {}) }))
vi.mock('../active-transport', () => ({ getActiveTransport: fake.lookup, resetActiveTransport: () => {} }))
vi.mock('../useBootWarmup', () => ({ useBootWarmup: () => {}, useBehindWarmup: () => {} }))
vi.mock('../audit-log', () => ({ auditRowsFromTransportEvent: () => [], appendAuditRows: () => {} }))
vi.mock('../../hermes-agents', () => ({ syncRosterToHermes: async () => {}, syncDesktopAgentToHermes: async () => {} }))
vi.mock('../../avatar-intent', () => ({ maybeApplyAvatarIntent: () => {} }))
vi.mock('../../subagent-continue', () => ({ startDelegateContinuations: () => () => {}, continueAfterSubagent: () => {} }))

import { getState, resetStore, setHydrateStatus, setState } from '../store'
import { resetTranscriptFreshness } from '../transcript-freshness'
import { useAgentRuntime } from '../useAgentRuntime'

const createdAt = '2026-10-07T00:00:00Z'
const id = 'transcript-retry-c1'
const conversation = (hermesSessionId?: string) => ({
  id, title: 'Synthetic chat', target: { type: 'agent' as const, agentId: 'fixture-agent' }, createdAt, lastUsedAt: createdAt,
  ...(hermesSessionId ? { hermesSessionId } : {}),
})
const loaded = [{ id: 'm1', threadId: id, role: 'agent' as const, content: 'Synthetic reply.', createdAt }]
let serveUp = false

beforeEach(() => {
  resetStore()
  resetTranscriptFreshness()
  serveUp = false
  setHydrateStatus({ serveConnection: 'connecting' })
  setState({
    agents: [{ id: 'fixture-agent', name: 'Synthetic agent', status: 'running', region: 'local', summary: '', createdAt }],
    conversations: [conversation('session-1')], selectedConversationId: id, messagesByThreadId: {},
  })
  // Before serve is up the transport swallows the failure and returns the (empty) cache.
  fake.getMessages.mockReset().mockImplementation(async (conversationId: string) => {
    if (!serveUp) return []
    setState((state) => ({ messagesByThreadId: { ...state.messagesByThreadId, [conversationId]: loaded } }))
    return loaded
  })
  fake.lookup.mockReset().mockResolvedValue({ transport: { subscribe: fake.subscribe, getMessages: fake.getMessages }, mode: 'serve', source: 'synthetic' })
})
afterEach(() => cleanup())

async function boot() {
  const view = renderHook(() => useAgentRuntime())
  await waitFor(() => expect(fake.getMessages).toHaveBeenCalledTimes(1))
  await act(async () => {})
  expect(view.result.current.messages).toEqual([])
  return view
}

describe('selected transcript retries after a boot-time miss', () => {
  it('reloads when serve comes online', async () => {
    const view = await boot()
    serveUp = true
    act(() => setHydrateStatus({ serveConnection: 'online' }))
    await waitFor(() => expect(view.result.current.messages).toEqual(loaded))
    expect(fake.getMessages).toHaveBeenCalledTimes(2)
  })

  it('reloads when the same thread is chosen again while still empty', async () => {
    const view = await boot()
    serveUp = true
    act(() => view.result.current.handleSelect(id))
    await waitFor(() => expect(view.result.current.messages).toEqual(loaded))
    expect(fake.getMessages).toHaveBeenCalledTimes(2)
  })

  it('does not refetch a loaded thread when it is chosen again', async () => {
    serveUp = true
    const view = renderHook(() => useAgentRuntime())
    await waitFor(() => expect(getState().messagesByThreadId[id]).toEqual(loaded))
    act(() => view.result.current.handleSelect(id))
    await act(async () => {})
    expect(fake.getMessages).toHaveBeenCalledTimes(1)
  })

  it('loads once the restored thread gains its Hermes session', async () => {
    setState({ conversations: [conversation()] })
    serveUp = true
    const view = renderHook(() => useAgentRuntime())
    await act(async () => {})
    expect(fake.getMessages).not.toHaveBeenCalled()
    act(() => setState({ conversations: [conversation('session-1')] }))
    await waitFor(() => expect(view.result.current.messages).toEqual(loaded))
  })
})
