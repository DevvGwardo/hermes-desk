import { afterEach, expect, it, vi } from 'vitest'
import { LocalRoomEngine } from './local-rooms'
import type { AgentsState } from './store'

const empty = (): AgentsState => ({ agents: [], groups: [], conversations: [], messagesByThreadId: {},
  turnsById: {}, subagentsById: {}, selectedConversationId: null })
function fixture() {
  const room = new LocalRoomEngine('room', [{ id: 'profile:writer', profile: 'writer', name: 'Writer' }], 'Team')
  room.send('A synthetic durable ask')
  const at = '2026-10-10T00:00:00Z'
  return { ...empty(), agents: [{ id: 'profile:writer', name: 'Writer', status: 'running' as const,
    region: 'local', summary: '', createdAt: at }],
    groups: [{ id: 'team', name: 'Team', memberAgentIds: ['profile:writer'], primaryAgentId: 'profile:writer', createdAt: at }],
    conversations: [{ id: 'room', title: 'Team', target: { type: 'group' as const, groupId: 'team' },
      createdAt: at, lastUsedAt: at, localRoom: room.state }], selectedConversationId: 'room' }
}
function native() {
  let revision = 0, value: string | null = null
  const read = vi.fn(() => ({ ok: true, revision, value }))
  const save = vi.fn((expected: number, next: string) => {
    if (expected !== revision) return { ok: false }
    value = next
    return { ok: true, revision: ++revision }
  })
  Object.assign(window, { nubAgent: { roomJournal: { read, save } } })
  return { read, save }
}
afterEach(() => { delete (window as unknown as { nubAgent?: unknown }).nubAgent; window.localStorage.clear(); vi.resetModules() })

it('migrates the current legacy origin once, then restores rooms on a different empty origin', async () => {
  window.localStorage.clear()
  const previous = await import('./persist')
  const state = fixture()
  previous.savePersistedState(state)
  const disk = native()
  vi.resetModules()
  let persist = await import('./persist')
  expect(persist.loadPersistedState()?.conversations[0]?.localRoom).toEqual(state.conversations[0].localRoom)
  expect(disk.save).toHaveBeenCalledTimes(1)
  window.localStorage.clear() // A new renderer origin/port has no old web cache.
  vi.resetModules()
  persist = await import('./persist')
  const restored = persist.loadPersistedState()!
  expect(restored.groups).toEqual(state.groups)
  expect(restored.conversations).toEqual(state.conversations)
  expect(persist.isRoomJournalPersisted('room', restored.conversations[0].localRoom!)).toBe(true)
  expect(disk.save).toHaveBeenCalledTimes(1)
})

it('does not resurrect deleted rooms from a stale origin and never imports its old journal twice', async () => {
  const disk = native()
  const persist = await import('./persist')
  persist.loadPersistedState()
  const state = fixture()
  persist.savePersistedState(state)
  const oldOrigin = window.localStorage.getItem('maia:agents-store:v2')!
  persist.savePersistedState(empty())
  window.localStorage.setItem('maia:agents-store:v2', oldOrigin)
  vi.resetModules()
  const next = await import('./persist')
  expect(next.loadPersistedState()?.conversations).toEqual([])
  expect(disk.save).toHaveBeenCalledTimes(2)
})

it('does not acknowledge a journal through web-cache success when native storage fails or conflicts', async () => {
  const disk = native()
  const persist = await import('./persist')
  persist.loadPersistedState()
  const state = fixture()
  disk.save.mockReturnValue({ ok: false } as { ok: boolean; revision: number })
  persist.savePersistedState(state)
  expect(window.localStorage.getItem('maia:agents-store:v2')).toBeTruthy()
  expect(persist.isRoomJournalPersisted('room', state.conversations[0].localRoom!)).toBe(false)
})

it('preserves existing native data and refuses writes if the native read is corrupt', async () => {
  const disk = native()
  disk.read.mockReturnValue({ ok: false } as ReturnType<typeof disk.read>)
  const persist = await import('./persist')
  persist.loadPersistedState()
  const state = fixture()
  persist.savePersistedState(state)
  expect(disk.save).not.toHaveBeenCalled()
  expect(persist.isRoomJournalPersisted('room', state.conversations[0].localRoom!)).toBe(false)
})
