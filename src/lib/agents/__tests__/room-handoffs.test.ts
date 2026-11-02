import { describe, expect, it } from 'vitest'
import {
  learnRoomMemberNames,
  mergeRoomHandoffs,
  resetLearnedRoomNames,
  roomMemberName,
  parseRoomFeed,
  roomHandoffStrips,
  roomRowId,
  stableHandoffStrips,
  ROOM_HANDOFFS_KEEP,
  type RoomHandoffDTO,
  type RoomTurnDTO,
} from '../rooms'

const names: Record<string, string> = { chief: 'Chief of Staff', penny: 'Penny', bob: 'CoderBob', max: 'Max' }
const nameOf = (id: string) => names[id] ?? id

let clock = 0
function h(over: Partial<RoomHandoffDTO> & Pick<RoomHandoffDTO, 'id' | 'memberId' | 'triggerId'>): RoomHandoffDTO {
  clock += 1
  return {
    rootId: 'root',
    depth: 2,
    kind: 'reply',
    status: 'queued',
    messageId: null,
    createdAt: new Date(Date.UTC(2026, 8, 27, 12, 0, clock)).toISOString(),
    ...over,
  }
}

/** The Chief answered the human (m1) with a hand-off message (m2). */
function thread(over: { penny?: Partial<RoomHandoffDTO>; max?: Partial<RoomHandoffDTO>; wrap?: Partial<RoomHandoffDTO> | null } = {}) {
  const list = [
    h({ id: 't_chief', memberId: 'chief', triggerId: 'root', depth: 1, status: 'sent', messageId: 'm2' }),
    h({ id: 't_penny', memberId: 'penny', triggerId: 'm2', ...over.penny }),
    h({ id: 't_max', memberId: 'max', triggerId: 'm2', ...over.max }),
  ]
  if (over.wrap !== null && over.wrap !== undefined) {
    list.push(h({ id: 't_wrap', memberId: 'chief', triggerId: 'm3', depth: 1, kind: 'wrap', ...over.wrap }))
  }
  return list
}

describe('parseRoomFeed hand-offs', () => {
  it('keeps well-formed hand-offs and the chief id, drops junk, defaults for old servers', () => {
    const feed = parseRoomFeed({
      messages: [],
      handoffs: [h({ id: 'a', memberId: 'penny', triggerId: 'm2' }), { id: 'x' }, null, 'junk'],
      chiefId: 'chief',
      cursor: 0,
    })
    expect(feed.handoffs.map((x) => x.id)).toEqual(['a'])
    expect(feed.chiefId).toBe('chief')
    const old = parseRoomFeed({ messages: [], turns: [], recent: [], cursor: 0 })
    expect(old.handoffs).toEqual([])
    expect(old.chiefId).toBeNull()
    expect(old.members).toEqual([])
  })

  it("labels a tagged member this device doesn't know from the feed's members", () => {
    resetLearnedRoomNames()
    const feed = parseRoomFeed({ messages: [], members: [{ id: 'agent_x1', name: 'Penny' }, { id: 7 }], cursor: 0 })
    expect(roomMemberName('agent_x1', [])).toBe('agent_x1')
    learnRoomMemberNames(feed.members)
    expect(roomMemberName('agent_x1', [])).toBe('Penny')
    resetLearnedRoomNames()
  })
})

describe('mergeRoomHandoffs', () => {
  it('upserts by id, keeps threads the page did not carry, returns prev when unchanged', () => {
    const a = h({ id: 'a', memberId: 'penny', triggerId: 'm2' })
    const b = h({ id: 'b', memberId: 'max', triggerId: 'm9', rootId: 'other' })
    const prev = mergeRoomHandoffs([], [a, b])
    expect(mergeRoomHandoffs(prev, [{ ...a }])).toBe(prev)
    expect(mergeRoomHandoffs(prev, [])).toBe(prev)
    const next = mergeRoomHandoffs(prev, [{ ...a, status: 'sent', messageId: 'm3' }])
    expect(next.map((x) => [x.id, x.status])).toEqual([
      ['a', 'sent'],
      ['b', 'queued'],
    ])
  })

  it('keeps only the newest ROOM_HANDOFFS_KEEP rows', () => {
    const many = Array.from({ length: ROOM_HANDOFFS_KEEP + 5 }, (_, i) =>
      h({ id: `r${i}`, memberId: 'penny', triggerId: `m${i}` }),
    )
    const kept = mergeRoomHandoffs([], many)
    expect(kept).toHaveLength(ROOM_HANDOFFS_KEEP)
    expect(kept[0]!.id).toBe('r5')
  })
})

describe('roomHandoffStrips', () => {
  const view = (handoffs: RoomHandoffDTO[], turns: RoomTurnDTO[] = [], chiefId: string | null = 'chief') => ({
    handoffs,
    turns,
    chiefId,
  })

  it('hangs one strip under the hand-off message, not under the human message', () => {
    const strips = roomHandoffStrips(view(thread()), nameOf)
    expect([...strips.keys()]).toEqual([roomRowId('m2')])
    const s = strips.get(roomRowId('m2'))!
    expect(s.fromMemberId).toBe('chief')
    expect(s.pills.map((p) => [p.name, p.state, p.label])).toEqual([
      ['Penny', 'queued', 'queued'],
      ['Max', 'queued', 'queued'],
    ])
    expect(s.wrap).toMatchObject({ name: 'Chief of Staff', state: 'pending', label: 'will wrap up' })
    expect(s.done).toBe(false)
  })

  it('shows each live phase from the live turns, with the tool a working member uses', () => {
    const turns: RoomTurnDTO[] = [
      { id: 't_penny', memberId: 'penny', status: 'running', phase: 'typing' },
      { id: 't_max', memberId: 'max', status: 'running', phase: 'working', activity: { tool: 'web_search', label: 'web search' } },
    ]
    const s = roomHandoffStrips(
      view(thread({ penny: { status: 'running' }, max: { status: 'running' } }), turns),
      nameOf,
    ).get(roomRowId('m2'))!
    expect(s.pills.map((p) => [p.state, p.label])).toEqual([
      ['typing', 'typing'],
      ['working', 'using web search'],
    ])
  })

  it('settles to replied (linked to the reply), passed and failed, then the wrap links to its message', () => {
    const s = roomHandoffStrips(
      view(
        thread({
          penny: { status: 'sent', messageId: 'm3' },
          max: { status: 'pass' },
          wrap: { status: 'sent', messageId: 'm4' },
        }),
      ),
      nameOf,
    ).get(roomRowId('m2'))!
    expect(s.pills.map((p) => [p.name, p.state, p.replyRowId])).toEqual([
      ['Penny', 'replied', roomRowId('m3')],
      ['Max', 'passed', null],
    ])
    expect(s.wrap).toMatchObject({ state: 'replied', label: 'wrapped up', replyRowId: roomRowId('m4') })
    expect(s.done).toBe(true)

    const failed = roomHandoffStrips(view(thread({ penny: { status: 'error' }, max: { status: 'cancelled' } })), nameOf)
      .get(roomRowId('m2'))!
    expect(failed.pills.map((p) => p.label)).toEqual(["couldn't answer", 'stopped'])
    // Everything settled and no wrap turn exists: no "will wrap up" promise.
    expect(failed.wrap).toBeNull()
    expect(failed.done).toBe(true)
  })

  it('a live wrap shows its phase; a passed wrap reads "nothing to add"', () => {
    const live = roomHandoffStrips(
      view(thread({ penny: { status: 'sent', messageId: 'm3' }, max: { status: 'pass' }, wrap: { status: 'running' } }), [
        { id: 't_wrap', memberId: 'chief', status: 'running', phase: 'reading' },
      ]),
      nameOf,
    ).get(roomRowId('m2'))!
    expect(live.wrap).toMatchObject({ state: 'reading', label: 'reading' })
    expect(live.done).toBe(false)
    const passed = roomHandoffStrips(
      view(thread({ penny: { status: 'sent', messageId: 'm3' }, max: { status: 'pass' }, wrap: { status: 'pass' } })),
      nameOf,
    ).get(roomRowId('m2'))!
    expect(passed.wrap).toMatchObject({ state: 'passed', label: 'nothing to add' })
  })

  it("a wrap from an earlier batch doesn't count for a later one (staged hand-offs)", () => {
    // Chief → Penny (m2), follow-up wrap (m4) hands to Bob, second wrap pending.
    const list = [
      h({ id: 't_chief', memberId: 'chief', triggerId: 'root', depth: 1, status: 'sent', messageId: 'm2' }),
      h({ id: 't_penny', memberId: 'penny', triggerId: 'm2', status: 'sent', messageId: 'm3' }),
      h({ id: 't_w1', memberId: 'chief', triggerId: 'm3', depth: 1, kind: 'wrap', status: 'sent', messageId: 'm4' }),
      h({ id: 't_bob', memberId: 'bob', triggerId: 'm4', status: 'running' }),
    ]
    const strips = roomHandoffStrips(view(list), nameOf)
    expect(strips.get(roomRowId('m2'))!.wrap).toMatchObject({ turnId: 't_w1', label: 'wrapped up', replyRowId: roomRowId('m4') })
    const second = strips.get(roomRowId('m4'))!
    expect(second.fromMemberId).toBe('chief')
    expect(second.pills.map((p) => p.name)).toEqual(['CoderBob'])
    expect(second.wrap).toMatchObject({ state: 'pending' })
  })

  it('a second wrap for the same batch (after a retried member replies) is the one shown', () => {
    const list = [
      ...thread({ penny: { status: 'sent', messageId: 'm3' }, max: { status: 'sent', messageId: 'm5' } }),
      h({ id: 't_w1', memberId: 'chief', triggerId: 'm2', depth: 1, kind: 'wrap', status: 'sent', messageId: 'm4' }),
      h({ id: 't_w2', memberId: 'chief', triggerId: 'm2', depth: 1, kind: 'wrap', status: 'running' }),
    ]
    const s = roomHandoffStrips(view(list), nameOf).get(roomRowId('m2'))!
    expect(s.wrap).toMatchObject({ turnId: 't_w2', state: 'reading' })
    expect(s.done).toBe(false)
  })

  it('a budget-paused hand-off reads "paused", not queued', () => {
    const s = roomHandoffStrips(
      view(thread(), [{ id: 't_penny', memberId: 'penny', status: 'queued', phase: 'queued', paused: true }]),
      nameOf,
    ).get(roomRowId('m2'))!
    expect(s.pills.map((p) => [p.name, p.label])).toEqual([['Penny', 'paused'], ['Max', 'queued']])
  })

  it('a hand-off from a non-Chief member gets pills but no wrap', () => {
    const list = [
      h({ id: 't_bob', memberId: 'bob', triggerId: 'root', depth: 1, status: 'sent', messageId: 'm2' }),
      h({ id: 't_penny', memberId: 'penny', triggerId: 'm2', status: 'running' }),
    ]
    const s = roomHandoffStrips(view(list), nameOf).get(roomRowId('m2'))!
    expect(s.fromMemberId).toBe('bob')
    expect(s.wrap).toBeNull()
    // No chief known (older server): still pills, never a wrap.
    expect(roomHandoffStrips(view(thread(), [], null), nameOf).get(roomRowId('m2'))!.wrap).toBeNull()
  })

  it('reuses unchanged strip objects across polls', () => {
    const v1 = view(thread({ penny: { status: 'sent', messageId: 'm3' } }))
    const a = stableHandoffStrips(null, roomHandoffStrips(v1, nameOf))
    const b = stableHandoffStrips(a, roomHandoffStrips(v1, nameOf))
    expect(b.get(roomRowId('m2'))).toBe(a.get(roomRowId('m2')))
    const c = stableHandoffStrips(b, roomHandoffStrips(view(thread({ penny: { status: 'pass' } })), nameOf))
    expect(c.get(roomRowId('m2'))).not.toBe(b.get(roomRowId('m2')))
  })
})

describe('roomStatusOf with hand-offs', () => {
  it("doesn't repeat a hand-off's pass in the pass line, but keeps direct passes", async () => {
    const { roomStatusOf, emptyRoomView } = await import('../rooms')
    const view = {
      ...emptyRoomView(),
      enabled: true,
      latestRootId: 'root',
      handoffs: thread({ penny: { status: 'sent', messageId: 'm3' }, max: { status: 'pass' } }),
      recent: [
        { memberId: 'max', status: 'pass' as const, rootId: 'root' },
        { memberId: 'bob', status: 'pass' as const, rootId: 'root' },
      ],
    }
    expect(roomStatusOf(view, nameOf)?.passLine).toBe('CoderBob passed')
  })

  it('keeps a budget-paused room live but says it is paused, not reading', async () => {
    const { roomStatusOf, emptyRoomView, ROOM_BUDGET_PAUSED_TEXT } = await import('../rooms')
    const paused: RoomTurnDTO = { id: 't_penny', memberId: 'penny', status: 'queued', phase: 'queued', paused: true }
    const view = { ...emptyRoomView(), enabled: true, latestRootId: 'root', turns: [paused] }
    expect(roomStatusOf(view, nameOf)).toMatchObject({ live: true, presence: ROOM_BUDGET_PAUSED_TEXT })
    expect(ROOM_BUDGET_PAUSED_TEXT).toBe('Paused — token budget reached')
    // A member still finishing its running turn is reported normally.
    const mixed = { ...view, turns: [paused, { id: 't_max', memberId: 'max', status: 'running' as const, phase: 'typing' as const }] }
    expect(roomStatusOf(mixed, nameOf)?.presence).toBe('Max is typing')
  })
})
