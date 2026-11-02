import { beforeEach, describe, expect, it } from 'vitest'
import {
  LAST_TURN_SKEW_MS,
  TRANSCRIPT_FRESH_MS,
  cachedTranscriptBehind,
  markTranscriptFresh,
  resetTranscriptFreshness,
  selectionRefreshPlan,
} from '../transcript-freshness'
import type { ChatMessage, Conversation } from '../types'

beforeEach(() => resetTranscriptFreshness())

describe('selection refresh plan (review pass 2 #3)', () => {
  it('an empty thread always does the full load', () => {
    markTranscriptFresh('c', 1_000)
    expect(selectionRefreshPlan('c', false, 1_001)).toBe('full')
  })

  it('a cached thread hydrated within the window is skipped', () => {
    markTranscriptFresh('c', 1_000)
    expect(selectionRefreshPlan('c', true, 1_000 + TRANSCRIPT_FRESH_MS - 1)).toBe('skip')
  })

  it('a stale or never-hydrated cached thread refreshes the transcript only', () => {
    expect(selectionRefreshPlan('c', true, 5_000)).toBe('transcript')
    markTranscriptFresh('c', 1_000)
    expect(selectionRefreshPlan('c', true, 1_000 + TRANSCRIPT_FRESH_MS)).toBe('transcript')
  })

  it('freshness is per conversation', () => {
    markTranscriptFresh('a', 1_000)
    expect(selectionRefreshPlan('b', true, 1_001)).toBe('transcript')
  })
})

describe('cached transcript behind the sync feed (2026-10-04)', () => {
  const conv = (lastUsedAt: string, partial: Partial<Conversation> = {}) => ({
    id: 'c',
    lastUsedAt,
    hermesSessionId: 'sess_c',
    target: { type: 'agent' as const, agentId: 'inst_1' },
    ...partial,
  })
  const row = (id: string, role: ChatMessage['role'], at?: string, partial: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    threadId: 'c',
    role,
    content: id,
    createdAt: at ?? '2026-10-04T10:00:00.000Z',
    ...(at ? { turnCreatedAt: at, turnId: id } : {}),
    ...partial,
  })
  const cached = [row('u1', 'user', '2026-10-04T10:00:00.000Z'), row('a1', 'agent', '2026-10-04T10:00:00.000Z')]

  it('a newer server turn than the newest cached row is behind', () => {
    expect(cachedTranscriptBehind(conv('2026-10-04T10:05:00.000Z'), cached, { live: false })).toBe(true)
  })

  it('the same turn, touched a moment after its row was created, is not', () => {
    const at = new Date(Date.parse('2026-10-04T10:00:00.000Z') + LAST_TURN_SKEW_MS).toISOString()
    expect(cachedTranscriptBehind(conv(at), cached, { live: false })).toBe(false)
  })

  it('a reply persisted mid-stream is behind once no turn is live', () => {
    const msgs = [cached[0], { ...cached[1], streaming: true }]
    expect(cachedTranscriptBehind(conv('2026-10-04T10:00:00.000Z'), msgs, { live: false })).toBe(true)
    expect(cachedTranscriptBehind(conv('2026-10-04T10:00:00.000Z'), msgs, { live: true })).toBe(false)
  })

  it('is never known for a local tail, a group, an unsynced thread or no stamps', () => {
    const later = conv('2026-10-04T10:05:00.000Z')
    expect(cachedTranscriptBehind(later, [...cached, row('msg_local', 'user')], { live: false })).toBe(false)
    expect(cachedTranscriptBehind({ ...later, target: { type: 'group', groupId: 'g' } }, cached, { live: false })).toBe(false)
    expect(cachedTranscriptBehind({ ...later, hermesSessionId: undefined }, cached, { live: false })).toBe(false)
    expect(cachedTranscriptBehind(later, [row('u', 'user'), row('a', 'agent')], { live: false })).toBe(false)
  })

  it('system rows do not count as the tail', () => {
    const msgs = [...cached, row('sys', 'system')]
    expect(cachedTranscriptBehind(conv('2026-10-04T10:05:00.000Z'), msgs, { live: false })).toBe(true)
  })

  it('a fetch started at that position settles it (a turn that adds no rows)', () => {
    const later = conv('2026-10-04T10:05:00.000Z')
    markTranscriptFresh('c', 1_000, '2026-10-04T10:05:00.000Z')
    expect(cachedTranscriptBehind(later, cached, { live: false })).toBe(false)
    expect(cachedTranscriptBehind(conv('2026-10-04T10:09:00.000Z'), cached, { live: false })).toBe(true)
  })

  it('a behind thread fetches even while fresh', () => {
    markTranscriptFresh('c', 1_000)
    expect(selectionRefreshPlan('c', true, 1_001, true)).toBe('behind')
    expect(selectionRefreshPlan('c', false, 1_001, true)).toBe('full')
  })
})
