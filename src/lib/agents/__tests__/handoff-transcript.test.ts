import { describe, expect, it } from 'vitest'
import { buildHandoffTranscript, handoffReplyTarget, HANDOFF_TRANSCRIPT_MAX_DEPTH } from '../handoff-transcript'
import type { HandoffStrip } from '../rooms'
import type { ChatMessage } from '../types'

const msg = (id: string, fromAgentId: string | undefined, content: string): ChatMessage => ({
  id,
  threadId: 'g1',
  role: fromAgentId ? 'agent' : 'user',
  content,
  createdAt: '2026-09-29T13:00:00Z',
  fromAgentId,
})

const pill = (turnId: string, memberId: string, replyRowId: string | null, state: 'replied' | 'working' = 'replied') => ({
  turnId,
  memberId,
  name: memberId,
  state,
  label: state === 'replied' ? 'replied' : 'using shell',
  replyRowId,
})

const summarize = (rowId: string, strips: Map<string, HandoffStrip>, msgs: ChatMessage[]) =>
  buildHandoffTranscript(rowId, strips, new Map(msgs.map((m) => [m.id, m]))).map((e) =>
    e.kind === 'message' ? `${e.depth}:${e.rowId}` : `${e.depth}:${e.name} ${e.label}`,
  )

describe('buildHandoffTranscript', () => {
  it('ask, then each reply, nested hand-offs under the reply that made them, then the wrap', () => {
    const strips = new Map<string, HandoffStrip>([
      ['room_a', {
        rowId: 'room_a', fromMemberId: 'chief', done: false,
        pills: [pill('t1', 'alien', 'room_b'), pill('t2', 'bob', null, 'working')],
        wrap: { turnId: 't9', memberId: 'chief', name: 'chief', state: 'replied', label: 'wrapped up', replyRowId: 'room_z' },
      }],
      ['room_b', { rowId: 'room_b', fromMemberId: 'alien', done: true, pills: [pill('t3', 'x', 'room_c')], wrap: null }],
    ])
    const msgs = [msg('room_a', 'chief', 'ask'), msg('room_b', 'alien', '@x go'), msg('room_c', 'x', 'done'), msg('room_z', 'chief', 'wrap')]
    expect(summarize('room_a', strips, msgs)).toEqual([
      '0:room_a',
      '1:room_b',
      '2:room_c',
      '1:bob using shell',
      '1:room_z',
    ])
  })

  it('a reply that is no longer loaded shows as its status, not silently dropped', () => {
    const strips = new Map<string, HandoffStrip>([
      ['room_a', { rowId: 'room_a', fromMemberId: null, done: true, pills: [pill('t1', 'alien', 'room_gone')], wrap: null }],
    ])
    expect(summarize('room_a', strips, [msg('room_a', 'chief', 'ask')])).toEqual(['0:room_a', '1:alien replied'])
  })

  it('stops at the depth cap and never loops on a cycle', () => {
    const strips = new Map<string, HandoffStrip>()
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 10; i++) {
      const next = i === 9 ? 'room_0' : `room_${i + 1}`
      strips.set(`room_${i}`, { rowId: `room_${i}`, fromMemberId: null, done: true, pills: [pill(`t${i}`, 'm', next)], wrap: null })
      msgs.push(msg(`room_${i}`, 'm', `${i}`))
    }
    const out = summarize('room_0', strips, msgs)
    expect(out).toHaveLength(HANDOFF_TRANSCRIPT_MAX_DEPTH + 1)
  })
})

describe('buildHandoffTranscript follow-ups (chat inside the hand-off)', () => {
  const at = (s: number) => `2026-09-29T21:${String(40 + s).padStart(2, '0')}:00Z`
  const m = (id: string, from: string | undefined, content: string, s: number, replyTo?: string): ChatMessage => ({
    id, threadId: 'g', role: from ? 'agent' : 'user', content, createdAt: at(s), fromAgentId: from,
    ...(replyTo ? { replyTo: { id: replyTo, role: 'agent' as const, snippet: '' } } : {}),
  })

  it('a human reply to the thread joins it with the answer it started; unrelated messages stay out', () => {
    const strips = new Map<string, HandoffStrip>([
      ['room_a', { rowId: 'room_a', fromMemberId: 'alien', done: true, pills: [pill('t1', 'x', 'room_b')], wrap: null }],
    ])
    const threadStrips = new Map<string, HandoffStrip>([
      ...strips,
      // human-started turn: X answers the follow-up
      ['room_f', { rowId: 'room_f', fromMemberId: null, done: true, pills: [pill('t2', 'x', 'room_g')], wrap: null }],
      ['room_f2', { rowId: 'room_f2', fromMemberId: null, done: false, pills: [pill('t3', 'x', null, 'working')], wrap: null }],
    ])
    const ordered = [
      m('room_a', 'alien', '@X find the old handle', 0),
      m('room_b', 'x', 'It was @leon_old', 1),
      m('room_z', undefined, 'unrelated question', 2),
      m('room_f', undefined, 'are you sure?', 3, 'room_b'),
      m('room_g', 'x', 'Yes, archive.org confirms', 4),
      m('room_f2', undefined, 'thanks, and the date?', 5, 'room_g'),
    ]
    const out = buildHandoffTranscript('room_a', strips, new Map(ordered.map((x) => [x.id, x])), { threadStrips, ordered })
    expect(out.map((e) => (e.kind === 'message' ? `${e.depth}:${e.rowId}` : `${e.depth}:${e.name} ${e.label}`))).toEqual([
      '0:room_a',
      '1:room_b',
      '2:room_f',
      '3:room_g',
      '3:room_f2', // follow-up to a follow-up (capped below the depth limit)
      '4:x using shell',
    ])
    expect(handoffReplyTarget(out)?.message.id).toBe('room_g')
    // Opened from X's pill: X's own latest message.
    expect(handoffReplyTarget(out, 'x')).toEqual({ message: expect.objectContaining({ id: 'room_g' }), mention: null })
  })

  it('reply target falls back to the opening message when no agent has answered', () => {
    const out = buildHandoffTranscript('room_a', new Map(), new Map([['room_a', m('room_a', undefined, 'hi', 0)]]))
    expect(handoffReplyTarget(out)?.message.id).toBe('room_a')
  })

  it('a clicked member who has not posted yet is @mentioned on the latest message', () => {
    const strips = new Map<string, HandoffStrip>([
      ['room_a', { rowId: 'room_a', fromMemberId: 'alien', done: false, pills: [pill('t1', 'x', null, 'working')], wrap: null }],
    ])
    const out = buildHandoffTranscript('room_a', strips, new Map([['room_a', m('room_a', 'alien', '@X go', 0)]]))
    expect(handoffReplyTarget(out, 'x')).toEqual({ message: expect.objectContaining({ id: 'room_a' }), mention: { id: 'x', name: 'x' } })
  })
})
