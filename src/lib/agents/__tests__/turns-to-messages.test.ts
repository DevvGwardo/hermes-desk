import { describe, expect, it } from 'vitest'
import {
  GENERIC_TURN_ERROR,
  dropServerRowsOlderThan,
  hasHistoryGap,
  isLocalMessageId,
  turnsToMessages,
  type ChatTurnState,
} from '../turns-to-messages'
import type { ChatMessage } from '../types'

const OPTS_BASE = {
  conversationId: 'conv_1',
  speakerId: 'inst_a',
  newId: ((n: number) => `minted_${n}`) as unknown as (prefix: string) => string,
  formatTurnError: (e: string | null | undefined) => e ?? '',
  now: () => '2026-09-21T00:00:00Z',
}
let mintSeq = 0
const opts = () => ({ ...OPTS_BASE, newId: (prefix: string) => `${prefix}_${++mintSeq}` })

function msg(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    threadId: 'conv_1',
    role: 'user',
    content: '',
    createdAt: '2026-09-21T00:00:00Z',
    ...partial,
  }
}

const turn = (partial: Partial<ChatTurnState> & { id: string }): ChatTurnState => ({
  status: 'complete',
  ...partial,
})

describe('turnsToMessages (C1)', () => {
  it('builds user + agent rows in turn order on an empty thread', () => {
    mintSeq = 0
    const result = turnsToMessages(
      [
        turn({ id: 't1', user: { text: 'hello' }, assistantContent: 'hi there' }),
        turn({ id: 't2', user: { text: 'again' }, assistantContent: 'sure' }),
      ],
      [],
      opts(),
    )
    expect(result.changed).toBe(true)
    expect(result.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello'],
      ['agent', 'hi there'],
      ['user', 'again'],
      ['agent', 'sure'],
    ])
    expect(result.messages[1].id).toBe('t1')
    expect(result.messages[3].id).toBe('t2')
  })

  it('merges onto the existing thread by turn id without duplicating', () => {
    const existing = [
      msg({ id: 'usr_1', role: 'user', content: 'hello', turnId: 't1' }),
      msg({ id: 't1', role: 'agent', content: 'hi there', turnId: 't1' }),
    ]
    const result = turnsToMessages(
      [turn({ id: 't1', user: { text: 'hello' }, assistantContent: 'hi there' })],
      existing,
      opts(),
    )
    // Already echoed + stamped + identical content → nothing changed.
    expect(result.changed).toBe(false)
    expect(result.messages).toBe(existing)
  })

  it('never takes a typed mid-reply answer for the turn\'s prompt', () => {
    mintSeq = 0
    // Only the answer survives locally (the prompt row was trimmed away).
    const answer = msg({ id: 'usr_a_b', content: 'my art', turnId: 't1', answerAt: { replyId: 't1', offset: 5, tail: 'Quick' } })
    const result = turnsToMessages(
      [turn({ id: 't1', user: { text: 'order stickers' }, assistantContent: 'Quick check. Done.', createdAt: '2026-09-21T00:00:00Z' })],
      [answer],
      opts(),
    )
    const users = result.messages.filter((m) => m.role === 'user')
    expect(users.map((m) => m.content).sort()).toEqual(['my art', 'order stickers'])
    // The answer keeps its mark and takes no server ordering stamp.
    expect(users.find((m) => m.content === 'my art')).toMatchObject({ answerAt: answer.answerAt })
    expect(users.find((m) => m.content === 'my art')?.turnCreatedAt).toBeUndefined()
  })

  it('a send with attached files hydrates as its text plus file chips, and matches its echo', () => {
    mintSeq = 0
    const noted = 'here is my art\n\nAttached files (saved on your computer):\n• /opt/data/workspace/image (82).png'
    // Fresh device: the row is rebuilt from the server text.
    const fresh = turnsToMessages([turn({ id: 't1', user: { text: noted }, assistantContent: 'Got it.' })], [], opts())
    const user = fresh.messages.find((m) => m.role === 'user')!
    expect(user.content).toBe('here is my art')
    expect(user.attachments).toEqual([
      { id: 't1-att-0', name: 'image (82).png', kind: 'image', path: '/opt/data/workspace/image (82).png' },
    ])
    // This device: the local echo (plain text) is the same row, not a second bubble.
    const echo = msg({ id: 'usr_a_b', content: 'here is my art', attachments: [{ id: 'x', name: 'image (82).png', kind: 'image' }] })
    const merged = turnsToMessages([turn({ id: 't1', user: { text: noted }, assistantContent: 'Got it.' })], [echo], opts())
    expect(merged.messages.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('hydrates the same prompt sent twice as two user bubbles', () => {
    mintSeq = 0
    const result = turnsToMessages(
      [
        turn({ id: 't1', user: { text: 'i got claude' }, assistantContent: 'good pick' }),
        turn({ id: 't2', user: { text: 'i got claude' }, assistantContent: 'already noted' }),
      ],
      [],
      opts(),
    )
    expect(result.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'i got claude'],
      ['agent', 'good pick'],
      ['user', 'i got claude'],
      ['agent', 'already noted'],
    ])
  })

  it('does not re-echo a repeated prompt the thread already shows twice', () => {
    const existing = [
      msg({ id: 'usr_1', role: 'user', content: 'ok', turnId: 't1' }),
      msg({ id: 't1', role: 'agent', content: 'one', turnId: 't1' }),
      msg({ id: 'usr_2', role: 'user', content: 'ok', turnId: 't2' }),
      msg({ id: 't2', role: 'agent', content: 'two', turnId: 't2' }),
    ]
    const result = turnsToMessages(
      [
        turn({ id: 't1', user: { text: 'ok' }, assistantContent: 'one' }),
        turn({ id: 't2', user: { text: 'ok' }, assistantContent: 'two' }),
      ],
      existing,
      opts(),
    )
    expect(result.changed).toBe(false)
    expect(result.messages).toBe(existing)
  })

  it('keeps local-only rows (pending outbox, subagent bubbles) the server does not know', () => {
    const existing = [
      msg({ id: 'usr_1', role: 'user', content: 'hello' }),
      msg({ id: 't1', role: 'agent', content: 'hi there' }),
      msg({ id: 'usr_pending', role: 'user', content: 'queued offline', pending: true }),
      msg({
        id: 'submsg_run1',
        role: 'subagent',
        content: 'scanning…',
        subagentRunId: 'run1',
      }),
    ]
    const result = turnsToMessages(
      [turn({ id: 't1', user: { text: 'hello' }, assistantContent: 'hi there' })],
      existing,
      opts(),
    )
    expect(result.messages.map((m) => m.id)).toContain('usr_pending')
    expect(result.messages.map((m) => m.id)).toContain('submsg_run1')
  })

  it('does not double-echo a reply-quoted send (server echo carries the reply note)', () => {
    const existing = [
      msg({ id: 'usr_1', role: 'user', content: 'look at this' }),
      msg({ id: 't0', role: 'agent', content: 'the prior answer' }),
    ]
    const result = turnsToMessages(
      [
        turn({
          id: 't1',
          user: {
            text: '[The user is replying to your message: "the prior answer"]\n\nlook at this again',
          },
          assistantContent: 'ok',
        }),
      ],
      existing,
      opts(),
    )
    // The quoted send was never sent locally, so the user echo IS new — but
    // the note is stripped and the quote recovered.
    const echoed = result.messages.find((m) => m.role === 'user' && m.content.includes('again'))
    expect(echoed?.replyTo?.snippet).toBe('the prior answer')
    // The original echo survives exactly once; the new send is its own row.
    expect(
      result.messages.filter((m) => m.role === 'user' && m.content === 'look at this'),
    ).toHaveLength(1)
  })

  it('matches an already-echoed reply send on the note-free text', () => {
    const existing = [
      msg({
        id: 'usr_1',
        role: 'user',
        content: 'look at this',
        replyTo: { id: '', role: 'agent', snippet: 'the prior answer' },
      }),
    ]
    const result = turnsToMessages(
      [
        turn({
          id: 't1',
          user: {
            text: '[The user is replying to your message: "the prior answer"]\n\nlook at this',
          },
          assistantContent: 'ok',
        }),
      ],
      existing,
      opts(),
    )
    // Same note-free text: no second user bubble. Only the agent row is added.
    expect(result.messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(result.messages.filter((m) => m.id === 't1')).toHaveLength(1)
  })

  it('preserves reactions and attachments through a content patch', () => {
    const existing = [
      msg({
        id: 't1',
        role: 'agent',
        content: 'draft',
        reactions: [{ emoji: '👍', author: 'user' }],
        attachments: [{ id: 'a1', name: 'x.png', kind: 'image' }],
      }),
    ]
    const result = turnsToMessages([turn({ id: 't1', assistantContent: 'final' })], existing, opts())
    expect(result.changed).toBe(true)
    expect(result.messages[0].reactions).toEqual([{ emoji: '👍', author: 'user' }])
    expect(result.messages[0].attachments).toEqual([{ id: 'a1', name: 'x.png', kind: 'image' }])
    expect(result.messages[0].content).toBe('final')
  })

  it('attributes group member rows with fromAgentId', () => {
    const result = turnsToMessages(
      [turn({ id: 't1', user: { text: 'hi' }, assistantContent: 'member reply' })],
      [],
      { ...opts(), fromAgentId: 'agent_b' },
    )
    expect(result.messages.find((m) => m.id === 't1')?.fromAgentId).toBe('agent_b')
  })

  it('keeps a still-streaming turn on the streaming bubble and reports the live id', () => {
    const existing = [msg({ id: 't1', role: 'agent', content: 'partial', streaming: true })]
    const result = turnsToMessages(
      [turn({ id: 't1', user: { text: 'go' }, assistantContent: 'partial + more', status: 'streaming' })],
      existing,
      opts(),
    )
    expect(result.changed).toBe(true)
    expect(result.liveTurnIds).toEqual(['t1'])
    expect(result.messages[0].streaming).toBe(true)
    expect(result.messages[0].content).toBe('partial + more')
  })

  it('binds a local streaming bubble to its server turn id', () => {
    const existing = [msg({ id: 'msg_mf1abc_x7k2p', role: 'agent', content: 'partial', streaming: true })]
    const result = turnsToMessages(
      [turn({ id: 'srv_turn', user: { text: 'go' }, assistantContent: 'partial + more', status: 'streaming' })],
      existing,
      opts(),
    )
    expect(result.messages.find((m) => m.streaming)?.id).toBe('srv_turn')
    expect(result.messages.filter((m) => m.role === 'agent')).toHaveLength(1)
  })

  it('a settled turn clears the error flag when the turn eventually succeeded', () => {
    const existing = [msg({ id: 't1', role: 'agent', content: '', error: true })]
    const result = turnsToMessages(
      [turn({ id: 't1', user: { text: 'go' }, assistantContent: 'done' })],
      existing,
      opts(),
    )
    expect(result.messages[0].error).toBe(false)
    expect(result.messages[0].content).toBe('done')
  })

  it('formats a failed turn into the error bubble copy (existing + fresh rows)', () => {
    // The error copy replaces the bubble content; a first-seen error turn
    // with no assistant text now paints its headline (Retry stays reachable).
    const existing = [msg({ id: 't1', role: 'agent', content: 'earlier partial' })]
    const result = turnsToMessages(
      [turn({ id: 't1', user: { text: 'go' }, status: 'error', error: 'VM unreachable' })],
      existing,
      opts(),
    )
    expect(result.messages[0].content).toBe('VM unreachable')
    expect(result.messages[0].error).toBe(true)
    expect(result.messages[0].streaming).toBe(false)

    const fresh = turnsToMessages(
      [turn({ id: 't9', user: { text: 'go' }, status: 'error', error: 'VM unreachable' })],
      [],
      opts(),
    )
    const row = fresh.messages.find((m) => m.id === 't9')
    expect(row?.content).toBe('VM unreachable')
    expect(row?.error).toBe(true)
  })

  it('tool events ride along and a live turn is urgent', () => {
    const result = turnsToMessages(
      [
        turn({
          id: 't1',
          user: { text: 'go' },
          assistantContent: 'working…',
          status: 'streaming',
          activity: { tool: 'shell', label: 'npm test', emoji: '🧪' },
        }),
      ],
      [],
      opts(),
    )
    expect(result.messages.find((m) => m.id === 't1')?.toolEvents).toEqual([
      { tool: 'shell', label: 'npm test', emoji: '🧪', status: 'running' },
    ])
  })

  it('a user re-echo matched on the second pass keeps rows unchanged', () => {
    // Legacy rows (persisted before stamps) take the stamp once, then idle.
    const existing = [
      msg({ id: 'usr_1', role: 'user', content: 'hello' }),
      msg({ id: 't1', role: 'agent', content: 'hi there' }),
    ]
    const first = turnsToMessages(
      [turn({ id: 't1', user: { text: 'hello' }, assistantContent: 'hi there' })],
      existing,
      opts(),
    )
    expect(first.changed).toBe(true)
    expect(first.messages.every((m) => m.turnId === 't1')).toBe(true)
    const second = turnsToMessages(
      [turn({ id: 't1', user: { text: 'hello' }, assistantContent: 'hi there' })],
      first.messages,
      opts(),
    )
    expect(second.changed).toBe(false)
  })
})

describe('turnsToMessages ordering + rebind guards', () => {
  const at = (min: number) => `2026-09-21T10:${String(min).padStart(2, '0')}:00.000Z`

  it('uses the server createdAt for message times', () => {
    const result = turnsToMessages(
      [turn({ id: 't1', createdAt: at(5), user: { text: 'hi' }, assistantContent: 'yo' })],
      [],
      opts(),
    )
    expect(result.messages.map((m) => m.createdAt)).toEqual([at(5), at(5)])
    expect(result.messages.map((m) => m.turnCreatedAt)).toEqual([at(5), at(5)])
  })

  it('places an unknown older turn in server order, not at the bottom', () => {
    const existing = [
      msg({ id: 'usr_2', role: 'user', content: 'second', turnId: 't2', turnCreatedAt: at(2) }),
      msg({ id: 't2', role: 'agent', content: 'b', turnId: 't2', turnCreatedAt: at(2) }),
    ]
    const result = turnsToMessages(
      [
        turn({ id: 't1', createdAt: at(1), user: { text: 'first' }, assistantContent: 'a' }),
        turn({ id: 't2', createdAt: at(2), user: { text: 'second' }, assistantContent: 'b' }),
      ],
      existing,
      opts(),
    )
    expect(result.messages.map((m) => m.content)).toEqual(['first', 'a', 'second', 'b'])
  })

  it('keeps local-only optimistic rows at the tail when a server turn lands', () => {
    const existing = [
      msg({ id: 'usr_1', role: 'user', content: 'one', turnId: 't1', turnCreatedAt: at(1) }),
      msg({ id: 't1', role: 'agent', content: 'A', turnId: 't1', turnCreatedAt: at(1) }),
      msg({ id: 'usr_mf1_local', role: 'user', content: 'just sent' }),
    ]
    const result = turnsToMessages(
      [turn({ id: 't_phone', createdAt: at(3), user: { text: 'from phone' }, assistantContent: 'P' })],
      existing,
      opts(),
    )
    expect(result.messages.map((m) => m.content)).toEqual([
      'one',
      'A',
      'from phone',
      'P',
      'just sent',
    ])
  })

  it('repairs a thread misordered by the old append-at-bottom merge', () => {
    const existing = [
      msg({ id: 'usr_2', role: 'user', content: 'second' }),
      msg({ id: 't2', role: 'agent', content: 'b' }),
      msg({ id: 'usr_1', role: 'user', content: 'first' }),
      msg({ id: 't1', role: 'agent', content: 'a' }),
    ]
    const result = turnsToMessages(
      [
        turn({ id: 't1', createdAt: at(1), user: { text: 'first' }, assistantContent: 'a' }),
        turn({ id: 't2', createdAt: at(2), user: { text: 'second' }, assistantContent: 'b' }),
      ],
      existing,
      opts(),
    )
    expect(result.messages.map((m) => m.content)).toEqual(['first', 'a', 'second', 'b'])
    expect(result.messages).toHaveLength(4)
  })

  it('an older page prepends in order and dedupes overlap + repeated prompts', () => {
    const existing = [
      msg({ id: 'sys_1', role: 'system', content: 'Conversation started.' }),
      msg({ id: 'usr_3', role: 'user', content: 'ok', turnId: 't3', turnCreatedAt: at(3) }),
      msg({ id: 't3', role: 'agent', content: 'three', turnId: 't3', turnCreatedAt: at(3) }),
      msg({ id: 'usr_4', role: 'user', content: 'four?', turnId: 't4', turnCreatedAt: at(4) }),
      msg({ id: 't4', role: 'agent', content: 'four', turnId: 't4', turnCreatedAt: at(4) }),
    ]
    const result = turnsToMessages(
      [
        turn({ id: 't1', createdAt: at(1), user: { text: 'ok' }, assistantContent: 'one' }),
        turn({ id: 't2', createdAt: at(2), user: { text: 'two?' }, assistantContent: 'two' }),
        // Overlap with the downloaded page — must not duplicate.
        turn({ id: 't3', createdAt: at(3), user: { text: 'ok' }, assistantContent: 'three' }),
      ],
      existing,
      { ...opts(), prepend: true },
    )
    expect(result.messages.map((m) => m.content)).toEqual([
      'Conversation started.',
      'ok',
      'one',
      'two?',
      'two',
      'ok',
      'three',
      'four?',
      'four',
    ])
  })

  it('an older page from a server without createdAt still lands above the thread', () => {
    const existing = [
      msg({ id: 'usr_9', role: 'user', content: 'newest', turnId: 't9' }),
      msg({ id: 't9', role: 'agent', content: 'z', turnId: 't9' }),
    ]
    const result = turnsToMessages(
      [
        turn({ id: 't1', user: { text: 'old 1' }, assistantContent: 'a' }),
        turn({ id: 't2', user: { text: 'old 2' }, assistantContent: 'b' }),
      ],
      existing,
      { ...opts(), prepend: true },
    )
    expect(result.messages.map((m) => m.content)).toEqual(['old 1', 'a', 'old 2', 'b', 'newest', 'z'])
  })

  it('a settled old turn never steals the live streaming bubble', () => {
    const existing = [
      msg({ id: 'msg_mf1abc_live1', role: 'agent', content: 'typing…', streaming: true }),
    ]
    const result = turnsToMessages(
      [turn({ id: 't_old', createdAt: at(1), user: { text: 'old' }, assistantContent: 'old reply' })],
      existing,
      opts(),
    )
    const live = result.messages.find((m) => m.streaming)
    expect(live?.id).toBe('msg_mf1abc_live1')
    expect(live?.content).toBe('typing…')
    expect(result.messages.find((m) => m.id === 't_old')?.content).toBe('old reply')
  })

  it('a live turn never renames another server turn’s streaming row', () => {
    const existing = [
      msg({ id: 't_a', role: 'agent', content: 'A streaming', streaming: true, turnId: 't_a' }),
    ]
    const result = turnsToMessages(
      [turn({ id: 't_b', status: 'streaming', user: { text: 'b' }, assistantContent: 'B' })],
      existing,
      opts(),
    )
    expect(result.messages.find((m) => m.id === 't_a')?.content).toBe('A streaming')
    expect(result.messages.find((m) => m.id === 't_b')?.content).toBe('B')
  })

  it('identical-text rebind never takes a row owned by another server turn', () => {
    const existing = [
      msg({ id: 'usr_a', role: 'user', content: 'thanks', turnId: 't_a' }),
      msg({ id: 't_a', role: 'agent', content: 'You got it.', turnId: 't_a' }),
    ]
    const result = turnsToMessages(
      [turn({ id: 't_b', user: { text: 'thanks again' }, assistantContent: 'You got it.' })],
      existing,
      opts(),
    )
    expect(result.messages.map((m) => m.id)).toContain('t_a')
    expect(result.messages.map((m) => m.id)).toContain('t_b')
    expect(result.messages.filter((m) => m.role === 'agent')).toHaveLength(2)
  })

  it('identical-text rebind still adopts a local-id bubble', () => {
    const existing = [msg({ id: 'msg_mf1abc_q1w2e', role: 'agent', content: 'Done.' })]
    const result = turnsToMessages(
      [turn({ id: 't_srv', user: { text: 'go' }, assistantContent: 'Done.' })],
      existing,
      opts(),
    )
    expect(result.messages.filter((m) => m.role === 'agent').map((m) => m.id)).toEqual(['t_srv'])
  })

  it('keeps a historical failed turn as an error row (generic headline fallback)', () => {
    const result = turnsToMessages(
      [turn({ id: 't_err', status: 'error', user: { text: 'go' } })],
      [],
      { ...opts(), formatTurnError: () => '' },
    )
    const row = result.messages.find((m) => m.id === 't_err')
    expect(row?.error).toBe(true)
    expect(row?.content).toBe(GENERIC_TURN_ERROR)
  })

  it('never rewrites the text of a turn a live SSE stream owns', () => {
    const existing = [
      msg({ id: 't_live', role: 'agent', content: 'replayed full text so far', streaming: true }),
    ]
    const result = turnsToMessages(
      [turn({ id: 't_live', status: 'streaming', createdAt: at(1), assistantContent: 'replayed' })],
      existing,
      { ...opts(), streamOwnedTurnIds: new Set(['t_live']) },
    )
    const row = result.messages.find((m) => m.id === 't_live')
    expect(row?.content).toBe('replayed full text so far')
    expect(row?.turnCreatedAt).toBe(at(1))
  })

  it('recognises only uid-shaped local ids', () => {
    expect(isLocalMessageId('msg_mf1abc_x7k2p')).toBe(true)
    expect(isLocalMessageId('usr_mf1abc_x7k2p')).toBe(true)
    expect(isLocalMessageId('turn_0')).toBe(false)
    expect(isLocalMessageId('cmfz1a2b3c4d5e6f7g8h9')).toBe(false)
  })
})

describe('turnsToMessages pass-2 review fixes', () => {
  const T = (h: number) => `2026-09-23T${String(h).padStart(2, '0')}:00:00.000Z`

  it('an older page never steals a just-sent unstamped echo (steal repro)', () => {
    const existing = [
      msg({ id: 'usr_a_1', role: 'user', content: 'hello', turnId: 't5', turnCreatedAt: T(10) }),
      msg({ id: 't5', role: 'agent', content: 'hi', turnId: 't5', turnCreatedAt: T(10) }),
      msg({ id: 'usr_b_2', role: 'user', content: 'continue' }),
      msg({ id: 't6', role: 'agent', content: 'wor', streaming: true }),
    ]
    const older = [turn({ id: 't1', user: { text: 'continue' }, assistantContent: 'old reply', createdAt: T(1) })]
    const r = turnsToMessages(older, existing, { ...opts(), prepend: true })
    const echo = r.messages.find((m) => m.id === 'usr_b_2')!
    expect(echo.turnId).toBeUndefined()
    // The old turn got its own echo, above the thread; the live tail is intact.
    expect(r.messages.map((m) => m.id).slice(-2)).toEqual(['usr_b_2', 't6'])
    const oldEcho = r.messages[0]
    expect(oldEcho.role).toBe('user')
    expect(oldEcho.turnId).toBe('t1')
    expect(r.messages[1].id).toBe('t1')
  })

  it('a newest-page OLD turn never adopts an echo sitting below a newer turn', () => {
    const existing = [
      msg({ id: 'usr_a_1', role: 'user', content: 'hello', turnId: 't5', turnCreatedAt: T(10) }),
      msg({ id: 't5', role: 'agent', content: 'hi', turnId: 't5', turnCreatedAt: T(10) }),
      msg({ id: 'usr_b_2', role: 'user', content: 'continue' }),
    ]
    const r = turnsToMessages(
      [turn({ id: 't3', user: { text: 'continue' }, assistantContent: 'x', createdAt: T(5) })],
      existing,
      opts(),
    )
    expect(r.messages.find((m) => m.id === 'usr_b_2')!.turnId).toBeUndefined()
  })

  it('the newest turn still adopts its unstamped echo at the tail', () => {
    const existing = [
      msg({ id: 'usr_a_1', role: 'user', content: 'hello', turnId: 't5', turnCreatedAt: T(10) }),
      msg({ id: 't5', role: 'agent', content: 'hi', turnId: 't5', turnCreatedAt: T(10) }),
      msg({ id: 'usr_b_2', role: 'user', content: 'continue' }),
    ]
    const r = turnsToMessages(
      [turn({ id: 't6', user: { text: 'continue' }, assistantContent: 'ok', createdAt: T(11) })],
      existing,
      opts(),
    )
    expect(r.messages.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(r.messages.find((m) => m.id === 'usr_b_2')!.turnId).toBe('t6')
  })

  it('never adopts an outbox (pending) row by text', () => {
    const existing = [msg({ id: 'usr_c_3', role: 'user', content: 'continue', pending: true })]
    const r = turnsToMessages(
      [turn({ id: 't7', user: { text: 'continue' }, assistantContent: 'ok', createdAt: T(12) })],
      existing,
      opts(),
    )
    expect(r.messages.find((m) => m.id === 'usr_c_3')!.turnId).toBeUndefined()
    expect(r.messages.filter((m) => m.role === 'user')).toHaveLength(2)
  })

  it('a turn-id-stamped echo (sendMessage header stamp) is matched by id, not text', () => {
    const existing = [
      msg({ id: 'usr_b_2', role: 'user', content: 'continue', turnId: 't6' }),
      msg({ id: 't6', role: 'agent', content: 'wor', streaming: true }),
    ]
    const r = turnsToMessages(
      [
        turn({ id: 't1', user: { text: 'continue' }, assistantContent: 'old', createdAt: T(1) }),
        turn({ id: 't6', status: 'streaming', user: { text: 'continue' }, assistantContent: 'wor', createdAt: T(12) }),
      ],
      existing,
      opts(),
    )
    expect(r.messages.find((m) => m.id === 'usr_b_2')!.turnCreatedAt).toBe(T(12))
    expect(r.messages.filter((m) => m.turnId === 't1' && m.role === 'user')).toHaveLength(1)
  })

  it('prefers errorHeadline over the raw error for display', () => {
    const r = turnsToMessages(
      [turn({ id: 't1', status: 'error', error: 'Traceback: long raw text', errorHeadline: 'Out of credits' })],
      [],
      opts(),
    )
    expect(r.messages[0].content).toBe('Out of credits')
    expect(r.messages[0].error).toBe(true)
  })

  it('complete with no reply over a local error row keeps the error', () => {
    const existing = [msg({ id: 't1', role: 'agent', content: 'Chat failed (502)', error: true })]
    const r = turnsToMessages([turn({ id: 't1', status: 'complete', assistantContent: '' })], existing, opts())
    expect(r.messages[0].error).toBe(true)
    expect(r.messages[0].content).toBe('Chat failed (502)')
  })

  it('hasHistoryGap: page that does not reach the newest cached turn', () => {
    const cached = [
      msg({ id: 'u1', role: 'user', content: 'a', turnId: 't1', turnCreatedAt: T(1) }),
      msg({ id: 't1', role: 'agent', content: 'b', turnId: 't1', turnCreatedAt: T(1) }),
    ]
    const page = [turn({ id: 't8', createdAt: T(8) }), turn({ id: 't9', createdAt: T(9) })]
    expect(hasHistoryGap(page, true, cached)).toBe(true)
    // Server has nothing older → no hole possible.
    expect(hasHistoryGap(page, false, cached)).toBe(false)
    // Page overlaps the cached turn → continuous.
    expect(hasHistoryGap([turn({ id: 't1', createdAt: T(1) }), ...page], true, cached)).toBe(false)
    // Page reaches back past the cached turn → continuous.
    expect(hasHistoryGap([turn({ id: 't0', createdAt: T(0) }), ...page], true, cached)).toBe(false)
    // Nothing server-known cached → nothing to be discontinuous with.
    expect(hasHistoryGap(page, true, [msg({ id: 'usr_x_1', content: 'hi' })])).toBe(false)
  })

  it('dropServerRowsOlderThan drops only server-known rows before the cut', () => {
    const rows = [
      msg({ id: 'u1', role: 'user', content: 'a', turnId: 't1', turnCreatedAt: T(1) }),
      msg({ id: 'usr_l_1', role: 'user', content: 'local' }),
      msg({ id: 't9', role: 'agent', content: 'b', turnId: 't9', turnCreatedAt: T(9) }),
    ]
    expect(dropServerRowsOlderThan(rows, T(5)).map((m) => m.id)).toEqual(['usr_l_1', 't9'])
    expect(dropServerRowsOlderThan(rows, T(0))).toBe(rows)
  })
})
