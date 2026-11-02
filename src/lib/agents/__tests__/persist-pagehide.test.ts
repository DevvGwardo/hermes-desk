import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelPendingPersist,
  clearPersistedState,
  loadPersistedState,
  persistPendingNow,
  schedulePersist,
  scheduleSlowPersist,
} from '../persist'
import type { AgentsState } from '../store'
import type { ChatMessage } from '../types'

// Parked saves: written when the page hides (a phone backgrounding the app
// right after a reply), never written out of order, dropped on reset.

const conv = { id: 'c1', title: 'c1', target: { type: 'agent' as const, agentId: 'a1' }, createdAt: '2026-10-01T00:00:00Z', lastUsedAt: '2026-10-01T00:00:00Z' }
const msg = (id: string, content: string): ChatMessage => ({ id, threadId: 'c1', role: 'agent', content, createdAt: '2026-10-01T00:00:00Z' })
const state = (messages: ChatMessage[], extra: Partial<AgentsState> = {}): AgentsState => ({
  agents: [],
  groups: [],
  conversations: [conv],
  messagesByThreadId: { c1: messages },
  subagentsById: {},
  turnsById: {},
  selectedConversationId: 'c1',
  ...extra,
})
const loadedContents = () => (loadPersistedState()?.messagesByThreadId.c1 ?? []).map((m) => m.content)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  clearPersistedState()
  vi.useRealTimers()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})

describe('parked persists', () => {
  it('the page going hidden writes the parked state at once', () => {
    schedulePersist(state([msg('m1', 'first reply')]))
    expect(loadedContents()).toEqual([]) // still parked (800 ms debounce)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(loadedContents()).toEqual(['first reply'])
  })

  it('pagehide writes it too, and the debounce timer does not write it again', () => {
    schedulePersist(state([msg('m1', 'a')]))
    window.dispatchEvent(new Event('pagehide'))
    expect(loadedContents()).toEqual(['a'])
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    vi.advanceTimersByTime(1_000)
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })

  it('an older parked metadata save never overwrites a newer full save', () => {
    scheduleSlowPersist(state([msg('m1', 'old')]))
    schedulePersist(state([msg('m1', 'old'), msg('m2', 'new reply')]))
    vi.advanceTimersByTime(800) // the full save lands
    expect(loadedContents()).toEqual(['old', 'new reply'])
    vi.advanceTimersByTime(5_000) // the slow timer fires with the older state
    expect(loadedContents()).toEqual(['old', 'new reply'])
  })

  it('persistPendingNow writes the newest of a parked full and slow save', () => {
    schedulePersist(state([msg('m1', 'a')]))
    scheduleSlowPersist(state([msg('m1', 'a'), msg('m2', 'b')]))
    persistPendingNow()
    expect(loadedContents()).toEqual(['a', 'b'])
  })

  it('a reset drops parked saves instead of writing the discarded state back', () => {
    schedulePersist(state([msg('m1', 'discard me')]))
    cancelPendingPersist()
    vi.advanceTimersByTime(6_000)
    persistPendingNow()
    expect(loadPersistedState()).toBeNull()
  })
})
