import { describe, expect, it } from 'vitest'
import type { Agent, ChatMessage } from '../types'
import {
  groupAutoName,
  joinNames,
  memberProfilesFor,
  accountChief,
  chiefProfileFor,
  roomChief,
  learnRoomSpeakerNames,
  resetLearnedRoomNames,
  roomMemberName,
  mergeRoomFeed,
  parseRoomFeed,
  roomPassLine,
  roomPresenceText,
  roomRowId,
  roomStatusOf,
  emptyRoomView,
  roomTurnRowId,
  type RoomMessageDTO,
  type RoomTurnDTO,
  activityLabel,
  ACTIVITY_LABEL_MAX,
} from '../rooms'

function agent(id: string, name: string, extra?: Partial<Agent>): Agent {
  return {
    id,
    name,
    status: 'running',
    region: 'remote',
    createdAt: '2026-09-25T00:00:00Z',
    summary: '',
    ...extra,
  }
}

const NAMES: Record<string, string> = { nub: 'Nub', bob: 'CoderBob', allen: 'AllenNub', d: 'Dee', e: 'Eve' }
const nameOf = (id: string) => NAMES[id] ?? id

function msg(seq: number, partial: Partial<RoomMessageDTO>): RoomMessageDTO {
  return {
    id: `m${seq}`,
    seq,
    speakerKind: 'agent',
    speakerId: 'nub',
    speakerName: 'Nub',
    text: `text ${seq}`,
    createdAt: `2026-09-25T10:00:0${seq}.000Z`,
    ...partial,
  }
}

function turn(id: string, memberId: string, phase: RoomTurnDTO['phase'], extra?: Partial<RoomTurnDTO>): RoomTurnDTO {
  return { id, memberId, status: phase === 'queued' ? 'queued' : 'running', phase, ...extra }
}

describe('names', () => {
  it.each([
    { retryable: true, rootId: 'latest', live: false, status: 'error', expected: true },
    { retryable: false, rootId: 'latest', live: false, status: 'error', expected: false },
    { retryable: undefined, rootId: 'latest', live: false, status: 'error', expected: false },
    { retryable: true, rootId: 'old', live: false, status: 'error', expected: false },
    { retryable: true, rootId: 'latest', live: true, status: 'error', expected: false },
    { retryable: true, rootId: 'latest', live: false, status: 'pass', expected: false },
  ] as const)('exposes only an explicitly safe settled latest-root retry: %j', sample => {
    const status = roomStatusOf({
      ...emptyRoomView(), enabled: true, latestRootId: 'latest',
      recent: [{ memberId: 'nub', rootId: sample.rootId, status: sample.status, retryable: sample.retryable }],
      turns: sample.live ? [turn('active', 'bob', 'typing', { rootId: 'latest' })] : [],
    }, nameOf)
    expect(status?.canRetry === true).toBe(sample.expected)
  })

  it('joins 1 / 2 / 3 / many names', () => {
    expect(joinNames(['A'])).toBe('A')
    expect(joinNames(['A', 'B'])).toBe('A and B')
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C')
    expect(joinNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and 3 others')
  })

  it('auto-names a room from its members', () => {
    expect(groupAutoName(['Nub', 'CoderBob', 'AllenNub'])).toBe('Nub, CoderBob and AllenNub')
    expect(groupAutoName([])).toBe('Group')
  })
})

describe('memberProfilesFor', () => {
  it('sends name, title, description and role; the VM agent reads "Nub"', () => {
    const agents = [
      agent('cos', 'Chief', { persona: { title: 'Chief of Staff', description: 'Leads.' }, role: 'orchestrator' }),
      agent('bob', 'CoderBob', { persona: { title: 'Engineer', description: 'Writes code.' }, role: 'specialist' }),
    ]
    const profiles = memberProfilesFor({ memberAgentIds: ['inst_1', 'cos', 'bob'] }, agents, 'inst_1')
    expect(profiles).toEqual([
      { id: 'inst_1', name: 'Nub', role: 'specialist' },
      { id: 'cos', name: 'Chief', title: 'Chief of Staff', description: 'Leads.', role: 'orchestrator' },
      { id: 'bob', name: 'CoderBob', title: 'Engineer', description: 'Writes code.', role: 'specialist' },
    ])
  })

  it('applies the server limits (12 members, 60-char name, 600-char description)', () => {
    const agents = Array.from({ length: 14 }, (_, i) =>
      agent(`a${i}`, 'N'.repeat(80), { persona: { description: 'd'.repeat(900) } }),
    )
    const profiles = memberProfilesFor({ memberAgentIds: agents.map((a) => a.id) }, agents)
    expect(profiles).toHaveLength(12)
    expect(profiles[0]!.name).toHaveLength(60)
    expect(profiles[0]!.description).toHaveLength(600)
  })
})

describe('account Chief of Staff', () => {
  const ava = agent('ava', 'Ava', {
    persona: { title: 'Chief of Staff', description: 'Runs the team.' },
    role: 'orchestrator',
  })
  const bob = agent('bob', 'CoderBob', { role: 'specialist' })
  const max = agent('max', 'Max', { role: 'orchestrator' })

  it('leads a group it is not a member of; a member Chief wins', () => {
    expect(accountChief([bob, ava])?.id).toBe('ava')
    expect(roomChief(['bob'], [bob, ava])?.id).toBe('ava')
    expect(roomChief(['bob', 'max'], [bob, ava, max])?.id).toBe('max')
    expect(roomChief(['bob'], [bob])).toBeNull()
    expect(roomChief([], [bob, ava])).toBeNull()
  })

  it('builds the chiefProfile a group PUT carries (null without a Chief)', () => {
    expect(chiefProfileFor([bob, ava])).toEqual({
      id: 'ava',
      name: 'Ava',
      title: 'Chief of Staff',
      description: 'Runs the team.',
      role: 'orchestrator',
    })
    expect(chiefProfileFor([bob])).toBeNull()
  })

  it('never makes a Chief from a name/title alone (red-team D-3)', () => {
    const impostor = agent('imp', 'Chief of Staff', { persona: { title: 'Chief of Staff · Orchestrator' } })
    expect(accountChief([bob, impostor])).toBeNull()
    expect(roomChief(['bob', 'imp'], [bob, impostor])).toBeNull()
    expect(chiefProfileFor([bob, impostor])).toBeNull()
    // The profile a group PUT carries says so explicitly, so the server's
    // name-match fallback can't promote it either.
    expect(memberProfilesFor({ memberAgentIds: ['imp'] }, [impostor])[0]!.role).toBe('specialist')
  })
})

describe('parseRoomFeed member colors (red-team D-1)', () => {
  it('drops non-hex avatar colors and unknown roles', () => {
    const feed = parseRoomFeed({
      members: [
        { id: 'a', name: 'A', avatarColor: 'red;background:url(x)', avatarEyeColor: '#14532d', role: 'admin' },
        { id: 'b', name: 'B', avatarColor: '#DFC5FF', avatarEyeColor: 'var(--x)', role: 'orchestrator' },
      ],
    })
    expect(feed.members[0]).toEqual({ id: 'a', name: 'A', avatarEyeColor: '#14532d' })
    expect(feed.members[1]).toEqual({ id: 'b', name: 'B', avatarColor: '#DFC5FF', role: 'orchestrator' })
  })
})

describe('mergeRoomFeed', () => {
  const conversationId = 'conv_room'

  it('maps human / agent / system messages to user / agent / system rows', () => {
    const feed = parseRoomFeed({
      messages: [
        msg(2, { speakerKind: 'agent', speakerId: 'bob', speakerName: 'CoderBob', text: 'on it' }),
        msg(1, { speakerKind: 'human', speakerId: null, speakerName: 'Torrey', text: 'ship it' }),
        msg(3, { speakerKind: 'system', speakerId: null, speakerName: 'system', text: 'Out of credits' }),
      ],
      turns: [],
      recent: [],
      cursor: 3,
    })
    const { messages, changed, added } = mergeRoomFeed([], feed, { conversationId })
    expect(changed).toBe(true)
    expect(added).toHaveLength(3)
    expect(messages.map((m) => [m.id, m.role, m.content, m.fromAgentId])).toEqual([
      [roomRowId('m1'), 'user', 'ship it', undefined],
      [roomRowId('m2'), 'agent', 'on it', 'bob'],
      [roomRowId('m3'), 'system', 'Out of credits', undefined],
    ])
  })

  it('binds the local echo instead of adding a second user bubble', () => {
    const echo: ChatMessage = {
      id: 'usr_abc_12345',
      threadId: conversationId,
      role: 'user',
      content: 'ship it',
      createdAt: '2026-09-25T10:00:00Z',
    }
    const feed = { messages: [msg(1, { speakerKind: 'human', speakerId: null, text: 'ship it' })], turns: [] }
    const byText = mergeRoomFeed([echo], feed, { conversationId })
    expect(byText.messages).toHaveLength(1)
    expect(byText.messages[0]!.id).toBe(roomRowId('m1'))
    expect(byText.added).toHaveLength(0)

    // By the POST's message id even when the text differs (trimmed server-side).
    const byId = mergeRoomFeed(
      [{ ...echo, content: 'ship it   ' }],
      { messages: [msg(1, { speakerKind: 'human', text: 'ship it (edited)' })], turns: [] },
      { conversationId, echoByMessageId: new Map([['m1', echo.id]]) },
    )
    expect(byId.messages).toHaveLength(1)
    expect(byId.messages[0]!.id).toBe(roomRowId('m1'))
  })

  it('streams a live turn as a bubble, then swaps it for the final message', () => {
    const live = mergeRoomFeed(
      [],
      { messages: [], turns: [turn('t1', 'bob', 'typing', { partialText: 'Look' })] },
      { conversationId },
    )
    expect(live.messages).toEqual([
      expect.objectContaining({ id: roomTurnRowId('t1'), role: 'agent', fromAgentId: 'bob', content: 'Look', streaming: true }),
    ])

    const grown = mergeRoomFeed(
      live.messages,
      { messages: [], turns: [turn('t1', 'bob', 'typing', { partialText: 'Looks good' })] },
      { conversationId },
    )
    expect(grown.messages[0]!.content).toBe('Looks good')

    const done = mergeRoomFeed(
      grown.messages,
      { messages: [msg(4, { speakerId: 'bob', text: 'Looks good to me.', roomTurnId: 't1' })], turns: [] },
      { conversationId },
    )
    expect(done.messages.map((m) => m.id)).toEqual([roomRowId('m4')])
    expect(done.messages[0]!.streaming).toBeFalsy()
  })

  it('drops the bubble of a turn that passed (no message written)', () => {
    const live = mergeRoomFeed(
      [],
      { messages: [], turns: [turn('t1', 'allen', 'typing', { partialText: 'Hmm' })] },
      { conversationId },
    )
    const settled = mergeRoomFeed(live.messages, { messages: [], turns: [] }, { conversationId })
    expect(settled.messages).toEqual([])
  })

  it('keeps live bubbles below new messages, and leaves them alone for older pages', () => {
    const live = mergeRoomFeed(
      [],
      { messages: [], turns: [turn('t2', 'nub', 'typing', { partialText: 'draft' })] },
      { conversationId },
    )
    const next = mergeRoomFeed(
      live.messages,
      { messages: [msg(5, { speakerId: 'bob' })], turns: [turn('t2', 'nub', 'typing', { partialText: 'draft' })] },
      { conversationId },
    )
    expect(next.messages.map((m) => m.id)).toEqual([roomRowId('m5'), roomTurnRowId('t2')])

    const older = mergeRoomFeed(next.messages, { messages: [msg(1, {})], turns: [] }, { conversationId, applyTurns: false })
    expect(older.messages.map((m) => m.id)).toEqual([roomRowId('m1'), roomRowId('m5'), roomTurnRowId('t2')])
  })

  it('orders legacy member history above the room by server time', () => {
    const legacy: ChatMessage = {
      id: 'turn_legacy',
      threadId: conversationId,
      role: 'agent',
      content: 'old fan-out reply',
      createdAt: '2026-09-20T00:00:00Z',
      turnId: 'turn_legacy',
      turnCreatedAt: '2026-09-20T00:00:00Z',
    }
    const out = mergeRoomFeed([legacy], { messages: [msg(1, {})], turns: [] }, { conversationId })
    expect(out.messages.map((m) => m.id)).toEqual(['turn_legacy', roomRowId('m1')])
  })

  it('is a no-op (same array) when nothing changed', () => {
    const feed = { messages: [msg(1, {})], turns: [] }
    const first = mergeRoomFeed([], feed, { conversationId })
    const again = mergeRoomFeed(first.messages, feed, { conversationId })
    expect(again.changed).toBe(false)
    expect(again.messages).toBe(first.messages)
  })

  it('merges a large page in one pass: binds echoes, resolves replies and swaps settled bubbles', () => {
    const at = (i: number) => new Date(Date.UTC(2026, 8, 25, 10, 0, 0, i)).toISOString()
    const n = 4000
    const dto = (i: number, partial: Partial<RoomMessageDTO> = {}): RoomMessageDTO =>
      ({ ...msg(i, partial), createdAt: at(i) })
    const page: RoomMessageDTO[] = []
    for (let i = 1; i <= n; i++) page.push(dto(i, i % 2 ? {} : { replyToId: `m${i - 1}` }))
    const first = mergeRoomFeed([], { messages: page, turns: [] }, { conversationId })
    expect(first.messages).toHaveLength(n)
    expect(first.messages[1]!.replyTo).toMatchObject({ id: roomRowId('m1'), snippet: 'text 1' })
    const echo: ChatMessage = { id: 'usr_echo', threadId: conversationId, role: 'user', content: 'next ask', createdAt: at(n + 1) }
    const live = mergeRoomFeed([...first.messages, echo], {
      messages: [], turns: [turn('t_live', 'bob', 'typing', { partialText: 'draft' })],
    }, { conversationId })
    const t0 = performance.now()
    const done = mergeRoomFeed(live.messages, {
      messages: [
        ...page,
        dto(n + 1, { speakerKind: 'human', speakerId: null, text: 'next ask' }),
        dto(n + 2, { speakerId: 'bob', text: 'final', roomTurnId: 't_live', replyToId: `m${n + 1}` }),
      ],
      turns: [],
    }, { conversationId })
    // Guards against a per-row scan (quadratic: seconds at this size).
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(done.messages).toHaveLength(n + 2)
    expect(done.messages.some((m) => m.id === 'usr_echo' || m.id === roomTurnRowId('t_live'))).toBe(false)
    expect(done.messages.at(-2)).toMatchObject({ id: roomRowId(`m${n + 1}`), role: 'user' })
    expect(done.messages.at(-1)).toMatchObject({ id: roomRowId(`m${n + 2}`), replyTo: { snippet: 'next ask', role: 'user' } })
    expect(done.added.map((m) => m.id)).toEqual([roomRowId(`m${n + 2}`)])
    // The input arrays are never mutated.
    expect(live.messages).toHaveLength(n + 2)
  })
})

describe('roomPresenceText', () => {
  it('names one member per phase', () => {
    expect(roomPresenceText([turn('1', 'bob', 'typing')], nameOf)).toBe('CoderBob is typing')
    expect(roomPresenceText([turn('1', 'allen', 'reading')], nameOf)).toBe('AllenNub is reading')
    expect(roomPresenceText([turn('1', 'allen', 'queued')], nameOf)).toBe('AllenNub is reading')
  })

  it('groups members that share a phase', () => {
    expect(roomPresenceText([turn('1', 'bob', 'working'), turn('2', 'nub', 'working')], nameOf)).toBe(
      'CoderBob and Nub are working',
    )
    expect(roomPresenceText([turn('1', 'bob', 'typing'), turn('2', 'nub', 'working')], nameOf)).toBe(
      'CoderBob is typing · Nub is working',
    )
  })

  it('collapses more than three names', () => {
    const turns = ['nub', 'bob', 'allen', 'd', 'e'].map((id, i) => turn(String(i), id, 'working'))
    expect(roomPresenceText(turns, nameOf)).toBe('Nub, CoderBob and 3 others are working')
  })

  it('shows the tool when exactly one member is working', () => {
    expect(roomPresenceText([turn('1', 'nub', 'working', { activity: { tool: 'shell' } })], nameOf)).toBe(
      'Nub is using shell',
    )
    expect(roomPresenceText([turn('1', 'nub', 'working', { activity: 'web search' })], nameOf)).toBe(
      'Nub is using web search',
    )
    // Two members: no single tool to name.
    expect(
      roomPresenceText(
        [turn('1', 'nub', 'working', { activity: { tool: 'shell' } }), turn('2', 'bob', 'working')],
        nameOf,
      ),
    ).toBe('Nub and CoderBob are working')
  })

  it('uses a member’s most advanced turn and is null when idle', () => {
    expect(roomPresenceText([turn('1', 'bob', 'queued'), turn('2', 'bob', 'typing')], nameOf)).toBe(
      'CoderBob is typing',
    )
    expect(roomPresenceText([], nameOf)).toBeNull()
  })
})

describe('roomPassLine', () => {
  it('names members that passed on the latest root', () => {
    const recent = [
      { memberId: 'allen', status: 'pass' as const, rootId: 'r2' },
      { memberId: 'nub', status: 'pass' as const, rootId: 'r2' },
      { memberId: 'bob', status: 'pass' as const, rootId: 'r1' },
    ]
    expect(roomPassLine(recent, nameOf, { rootId: 'r2' })).toBe('AllenNub and Nub passed')
  })

  it("says who couldn't answer, stays quiet on cancels, skips live members", () => {
    const recent = [
      { memberId: 'bob', status: 'timeout' as const },
      { memberId: 'nub', status: 'cancelled' as const },
      { memberId: 'allen', status: 'pass' as const },
    ]
    expect(roomPassLine(recent, nameOf)).toBe("AllenNub passed · CoderBob couldn't answer")
    expect(roomPassLine(recent, nameOf, { liveMemberIds: new Set(['allen']) })).toBe(
      "CoderBob couldn't answer",
    )
    expect(roomPassLine([], nameOf)).toBeNull()
  })

  it('roomStatusOf is null for a room the server does not run', () => {
    expect(roomStatusOf(undefined, nameOf)).toBeNull()
  })
})

describe('names for members this device does not know', () => {
  it('never sends a profile for an unknown agent (the server keeps the stored one)', () => {
    const profiles = memberProfilesFor({ memberAgentIds: ['inst_1', 'ghost'] }, [], 'inst_1')
    expect(profiles.map((p) => p.id)).toEqual(['inst_1'])
  })

  it('learns names from the room feed', () => {
    resetLearnedRoomNames()
    expect(roomMemberName('a_x', [])).toBe('a_x')
    learnRoomSpeakerNames([
      { id: 'm1', seq: 1, speakerKind: 'agent', speakerId: 'a_x', speakerName: 'Chief', text: 'hi', createdAt: '2026-09-25T00:00:00Z' },
      { id: 'm2', seq: 2, speakerKind: 'agent', speakerId: 'a_y', speakerName: 'a_y', text: 'hi', createdAt: '2026-09-25T00:00:01Z' },
      { id: 'm3', seq: 3, speakerKind: 'human', speakerId: null, speakerName: 'Torrey', text: 'hi', createdAt: '2026-09-25T00:00:02Z' },
    ])
    expect(roomMemberName('a_x', [])).toBe('Chief')
    expect(roomMemberName('a_y', [])).toBe('a_y')
    resetLearnedRoomNames()
  })
})

describe('activityLabel never shows raw tool arguments', () => {
  it('keeps a short human label', () => {
    expect(activityLabel({ tool: 'web_search', label: 'web search' })).toBe('web search')
    expect(activityLabel('shell')).toBe('shell')
  })
  it('falls back to the tool name for code / commands (seen live with a bearer token)', () => {
    const code = 'from hermes_tools import terminal cmd = """ BEARER="AAAA..." curl -sL --max-time 15 -X POST "https://api.x.com/1.1/guest/activate.json"'
    expect(activityLabel({ tool: 'execute_code', label: code })).toBe('execute code')
    expect(activityLabel({ tool: 'terminal', label: 'curl -sL https://x.com | jq .' })).toBe('terminal')
    expect(activityLabel({ tool: 'WebSearch', label: 'q="leon nubs" site:x.com' })).toBe('web search')
  })
  it('says "a tool" when the only text is code', () => {
    expect(activityLabel({ label: 'print(json.dumps(d)[:500])' } as never)).toBe('a tool')
  })
  it('caps length', () => {
    const out = activityLabel({ tool: 'a_really_long_tool_name_that_keeps_going_forever' })!
    expect(out.length).toBeLessThanOrEqual(ACTIVITY_LABEL_MAX)
  })
})
