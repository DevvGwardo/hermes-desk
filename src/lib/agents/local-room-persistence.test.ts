import { afterEach, expect, it, vi } from 'vitest'
import { savePersistedState } from './persist'
import { LocalRoomEngine } from './local-rooms'
import type { AgentsState } from './store'

afterEach(() => { window.localStorage.clear(); vi.resetModules() })

it('boots local groups with settled history, routing journal and isolated bindings, but no hosted data', async () => {
  window.localStorage.clear()
  const room = new LocalRoomEngine('conversation-room', [{ id: 'profile:writer', profile: 'writer', name: 'Writer' }], 'Team')
  room.send('Fixture request')
  const turn = room.takeReady()[0]!
  room.setBinding('profile:writer', { profile: 'writer', runtimeId: 'runtime-real', storedId: 'stored-real', lastSeen: 4 })
  room.complete(turn.id, { text: 'Fixture result' })
  const at = new Date().toISOString()
  const state: AgentsState = {
    agents: [{ id: 'profile:writer', hermesProfile: 'writer', name: 'Writer', status: 'running', region: 'local', summary: '', createdAt: at }],
    groups: [
      { id: 'group-local', name: 'Team', memberAgentIds: ['profile:writer'], primaryAgentId: 'profile:writer', createdAt: at },
      { id: 'group-hosted', name: 'Hosted', memberAgentIds: ['hosted-agent'], primaryAgentId: 'hosted-agent', createdAt: at },
    ],
    conversations: [
      { id: 'conversation-room', target: { type: 'group', groupId: 'group-local' }, title: 'Team', createdAt: at, lastUsedAt: at, localRoom: room.state },
      { id: 'conversation-hosted', target: { type: 'group', groupId: 'group-hosted' }, title: 'Hosted', createdAt: at, lastUsedAt: at },
    ],
    messagesByThreadId: {}, turnsById: {}, subagentsById: {}, selectedConversationId: 'conversation-room',
  }
  savePersistedState(state)
  vi.resetModules()
  const { getState } = await import('./store')
  expect(getState().groups.map(g => g.id)).toEqual(['group-local'])
  expect(getState().conversations.map(c => c.id)).toEqual(['conversation-room'])
  expect(getState().conversations[0]!.localRoom).toEqual(room.state)
  expect(getState().selectedConversationId).toBe('conversation-room')
})
