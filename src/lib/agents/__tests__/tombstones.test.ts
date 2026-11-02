/**
 * Deleted conversations must STAY deleted. Until the server acks a DELETE the
 * sync feed can still carry the row; tombstones (persisted to localStorage)
 * keep the apply step from resurrecting it, then shrink to a short grace.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../build-env', () => ({ isProdBuild: vi.fn(() => false) }))

import {
  recordDeletedConversation,
  isDeletedConversation,
  resetDeletedTombstonesForTest,
  _clearTombstoneCacheForTest,
  expireDeletedConversation,
  TOMBSTONE_TTL_MS,
} from '../tombstones'
import {
  getState,
  setState,
  createConversation,
  deleteConversation,
  listConversations,
} from '../store'
import { applySyncPage, type ConversationDTO, type PendingView } from '../conversation-sync'

const NO_PENDING: PendingView = { op: () => undefined }

function dto(partial: Partial<ConversationDTO> & { id: string }): ConversationDTO {
  return {
    kind: 'agent',
    targetId: 'inst_nub',
    sessionId: null,
    memberSessions: null,
    title: 'Nub',
    titleSource: 'auto',
    hidden: false,
    pinned: false,
    preview: '',
    lastTurnAt: null,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    deletedAt: null,
    ...partial,
  }
}

function applyRow(row: ConversationDTO) {
  return applySyncPage(getState(), { conversations: [row], groups: [] }, NO_PENDING)
}

describe('conversation tombstones', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetDeletedTombstonesForTest()
    setState(
      {
        agents: [
          {
            id: 'inst_nub',
            name: 'Nub',
            status: 'running',
            region: 'remote',
            createdAt: '2026-08-01T00:00:00Z',
            summary: 'Paired Nub agent.',
          },
        ],
        conversations: [],
      },
      { persist: false },
    )
  })

  afterEach(() => {
    window.localStorage.clear()
    resetDeletedTombstonesForTest()
  })

  it('records the conversation id and its hermes session id', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_nub' })
    setState({
      conversations: getState().conversations.map((c) =>
        c.id === conv.id ? { ...c, hermesSessionId: 'api_deadbeef' } : c,
      ),
    }, { persist: false })

    deleteConversation(conv.id)

    expect(isDeletedConversation(conv.id)).toBe(true)
    expect(isDeletedConversation('api_deadbeef')).toBe(true)
    expect(listConversations()).toHaveLength(0)
  })

  it('blocks the sync feed from resurrecting a deleted row (and deletes it server-side)', () => {
    recordDeletedConversation('conv_roster_row', 'api_roster_session')
    const res = applyRow(dto({ id: 'conv_roster_row', sessionId: 'api_roster_session' }))
    expect(res.state.conversations).toHaveLength(0)
    expect(res.staleServerIds).toEqual(['conv_roster_row'])
  })

  it('blocks by session id alone (the server row has another id)', () => {
    recordDeletedConversation('', 'api_session_only')
    const res = applyRow(dto({ id: 'cs_api_session_only', sessionId: 'api_session_only' }))
    expect(res.state.conversations).toHaveLength(0)
    expect(res.staleServerIds).toEqual(['cs_api_session_only'])
  })

  it('tombstones survive a reload (localStorage-backed)', () => {
    recordDeletedConversation('conv_persisted', 'api_persisted')
    // Clear only the in-memory cache; the next read re-loads from localStorage.
    _clearTombstoneCacheForTest()
    expect(isDeletedConversation('conv_persisted')).toBe(true)
    expect(isDeletedConversation('api_persisted')).toBe(true)
  })

  it('non-deleted rows still flow through', () => {
    const res = applyRow(dto({ id: 'conv_alive', sessionId: 'api_alive' }))
    expect(res.state.conversations).toHaveLength(1)
    expect(res.state.conversations[0]?.id).toBe('conv_alive')
  })

  it('an acked delete shrinks the tombstone to a short grace window', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
      recordDeletedConversation('conv_acked', 'api_acked')
      expireDeletedConversation(['conv_acked', 'api_acked'], 60_000)
      expect(isDeletedConversation('conv_acked')).toBe(true)
      vi.setSystemTime(new Date('2026-09-01T00:01:01Z'))
      _clearTombstoneCacheForTest()
      expect(isDeletedConversation('conv_acked')).toBe(false)
      expect(isDeletedConversation('api_acked')).toBe(false)
      // Untouched tombstones keep the full TTL.
      recordDeletedConversation('conv_other')
      vi.setSystemTime(Date.now() + TOMBSTONE_TTL_MS - 1000)
      expect(isDeletedConversation('conv_other')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
