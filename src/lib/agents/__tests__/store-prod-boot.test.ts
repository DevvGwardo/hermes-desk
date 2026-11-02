import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  window.localStorage.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  window.localStorage.clear()
})

describe('local-only boot state', () => {
  it.each([false, true])('starts without demo data with PROD=%s', async (prod) => {
    vi.stubEnv('PROD', prod)
    const store = await import('../store')
    expect(store.getState().agents).toEqual([])
    expect(store.getState().conversations).toEqual([])
    expect(store.getHydrateStatus()).toMatchObject({ rosterHydrating: true, conversationsHydrating: true, readOnly: true })
    store.resetStore()
    expect(store.getState().agents).toEqual([])
  })

  it('keeps local metadata but never rehydrates persisted message content or hosted agents', async () => {
    const { savePersistedState } = await import('../persist')
    savePersistedState({
      agents: [
        { id: 'profile:runner', hermesProfile: 'runner', name: 'Runner', status: 'running', region: 'local', createdAt: '2026-10-06T00:00:00Z', summary: '' },
        { id: 'inst-hosted', name: 'Hosted', status: 'running', region: 'remote', createdAt: '2026-10-06T00:00:00Z', summary: '' },
      ],
      groups: [],
      conversations: [
        { id: 'local-chat', title: 'Local', target: { type: 'agent', agentId: 'profile:runner' }, createdAt: '2026-10-06T00:00:00Z', lastUsedAt: '2026-10-06T00:00:00Z' },
        { id: 'hosted-chat', title: 'Hosted', target: { type: 'agent', agentId: 'inst-hosted' }, createdAt: '2026-10-06T00:00:00Z', lastUsedAt: '2026-10-06T00:00:00Z' },
      ],
      messagesByThreadId: { 'local-chat': [{ id: 'm1', threadId: 'local-chat', role: 'agent', content: 'Synthetic private transcript', createdAt: '2026-10-06T00:00:00Z' }] },
      subagentsById: {}, turnsById: {}, selectedConversationId: 'local-chat',
    })
    vi.resetModules()
    const { getState } = await import('../store')
    expect(getState().agents.map((a) => a.id)).toEqual(['profile:runner'])
    expect(getState().conversations.map((c) => c.id)).toEqual(['local-chat'])
    expect(getState().messagesByThreadId).toEqual({})
  })

  it('keeps new transcripts in memory without writing their content to localStorage', async () => {
    const { appendMessage, createConversation, resetStore } = await import('../store')
    resetStore()
    const chat = createConversation({ type: 'agent', agentId: 'profile:runner' })
    appendMessage(chat.id, { id: 'm1', threadId: chat.id, role: 'agent', content: 'SYNTHETIC_TRANSCRIPT_MEMORY_ONLY', createdAt: '2026-10-06T00:00:00Z' })
    await vi.advanceTimersByTimeAsync(60_000)
    const disk = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!)).join('')
    expect(disk).not.toContain('SYNTHETIC_TRANSCRIPT_MEMORY_ONLY')
  })
})
