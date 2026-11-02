import { describe, expect, it } from 'vitest'
import {
  isPendingRoomTurn,
  pendingRoomTurns,
  predictRoomResponders,
  roomPresenceText,
  roomStatusOf,
  emptyRoomView,
  withPendingTurns,
  type RoomTurnDTO,
} from '../rooms'

const members = [
  { id: 'nub', name: 'Nub' },
  { id: 'alien', name: 'AlienNub' },
  { id: 'xg', name: 'X Growth Analyst' },
]
const names: Record<string, string> = { nub: 'Nub', alien: 'AlienNub', xg: 'X Growth Analyst' }

describe('predictRoomResponders (mirrors server respondersForHuman)', () => {
  it('@mentions win over reply target and Chief', () => {
    expect(
      predictRoomResponders({ text: '@AlienNub tag chief', members, chiefId: 'nub', replyToMemberId: 'xg' }),
    ).toEqual(['alien'])
  })

  it('a reply addresses the member replied to', () => {
    expect(predictRoomResponders({ text: 'more?', members, chiefId: 'nub', replyToMemberId: 'xg' })).toEqual(['xg'])
  })

  it('otherwise the Chief leads', () => {
    expect(predictRoomResponders({ text: 'hi', members, chiefId: 'nub', replyToMemberId: null })).toEqual(['nub'])
  })

  it('no Chief: everyone', () => {
    expect(predictRoomResponders({ text: 'hi', members, chiefId: null, replyToMemberId: null })).toEqual([
      'nub',
      'alien',
      'xg',
    ])
  })

  it('ignores a reply target or Chief that is not seated', () => {
    expect(predictRoomResponders({ text: 'hi', members, chiefId: 'gone', replyToMemberId: 'left' })).toHaveLength(3)
  })
})

describe('pending turns', () => {
  it('render as "reading" on the presence line and in room status', () => {
    const turns = pendingRoomTurns('rn_1', ['alien'])
    expect(turns.every(isPendingRoomTurn)).toBe(true)
    expect(roomPresenceText(turns, (id) => names[id]!)).toBe('AlienNub is reading')
    const status = roomStatusOf({ ...emptyRoomView(), enabled: true, turns }, (id) => names[id]!)
    expect(status?.live).toBe(true)
    expect(status?.leadMemberId).toBe('alien')
  })

  it('a member with a real live turn drops its placeholder', () => {
    const real: RoomTurnDTO = { id: 'cm123', memberId: 'alien', status: 'running', phase: 'working' }
    const merged = withPendingTurns([real], pendingRoomTurns('rn_1', ['alien', 'nub']))
    expect(merged.map((t) => t.id)).toEqual(['cm123', 'pending:rn_1:nub'])
  })

  it('an empty pending list strips stale placeholders', () => {
    const stale = pendingRoomTurns('rn_1', ['alien'])
    expect(withPendingTurns(stale, [])).toEqual([])
  })

  it('dedupes member ids', () => {
    expect(pendingRoomTurns('k', ['a', 'a'])).toHaveLength(1)
  })
})
