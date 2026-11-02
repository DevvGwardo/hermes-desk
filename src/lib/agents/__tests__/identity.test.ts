import { afterEach, describe, expect, it } from 'vitest'
import { agentLook, memberCatColors, roomLooks } from '../identity'
import { learnRoomMemberNames, resetLearnedRoomNames } from '../rooms'
import type { Agent } from '../types'

const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  status: 'running',
  region: 'remote',
  createdAt: '2026-09-27T00:00:00Z',
  summary: '',
  ...over,
})

afterEach(() => resetLearnedRoomNames())

describe('agentLook', () => {
  it("uses the agent's pick, then the room feed's, then a stable default", () => {
    const picked = agentLook('a', [agent('a', { avatarColor: '#ffd7e6', avatarEyeColor: '#14532d' })])
    expect(picked).toEqual({ body: '#ffd7e6', eye: '#14532d', picked: true })
    learnRoomMemberNames([{ id: 'remote1', name: 'Penny', avatarColor: '#dfc5ff', avatarEyeColor: '#4a2c6b' }])
    expect(agentLook('remote1', [])).toEqual({ body: '#dfc5ff', eye: '#4a2c6b', picked: true })
    const d1 = agentLook('zed', [])
    expect(d1.picked).toBe(false)
    expect(agentLook('zed', [])).toEqual(d1)
  })
})

describe('agentLook color validation (red-team D-1)', () => {
  it('ignores non-hex colors from the room feed and the roster', () => {
    learnRoomMemberNames([{ id: 'r2', name: 'Mallory', avatarColor: 'red;background:url(x)', avatarEyeColor: 'url(x)' }])
    const look = agentLook('r2', [])
    expect(look.picked).toBe(false)
    expect(look.body).toMatch(/^#[0-9a-f]{6}$/i)
    expect(look.eye).toMatch(/^#[0-9a-f]{6}$/i)
    const fromRoster = agentLook('r3', [agent('r3', { avatarColor: 'red;background:url(x)' })])
    expect(fromRoster.picked).toBe(false)
    expect(fromRoster.body).not.toMatch(/url/)
  })
})

describe('roomLooks', () => {
  it('gives every member a different body while there are bodies to spare', () => {
    const ids = ['m1', 'm2', 'm3', 'm4']
    const looks = roomLooks(ids, [])
    expect(new Set(ids.map((id) => looks.get(id)!.body)).size).toBe(4)
  })

  it('never recolors a picked look, and moves a default that collides with it', () => {
    const agents = [agent('p', { avatarColor: '#b7d9ff', avatarEyeColor: '#1a3d6b' })]
    // Find a default whose look matches the picked body.
    const clash = Array.from({ length: 200 }, (_, i) => `x${i}`).find((id) => agentLook(id, []).body === '#b7d9ff')!
    const looks = roomLooks([clash, 'p'], agents)
    expect(looks.get('p')).toEqual({ body: '#b7d9ff', eye: '#1a3d6b', picked: true })
    expect(looks.get(clash)!.body).not.toBe('#b7d9ff')
  })

  it('past four members, pairs stay unique', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `agent_${i}`)
    const looks = roomLooks(ids, [])
    expect(new Set(ids.map((id) => `${looks.get(id)!.body}|${looks.get(id)!.eye}`)).size).toBe(10)
  })
})

describe('memberCatColors', () => {
  it('gives two members whose ids share a color different cats, as in the chat', () => {
    // Both demo ids hash to the same body; a group stack used to show two
    // identical cats while the chat chips told them apart.
    const members = [agent('inst_alpha'), agent('inst_ops')]
    expect(agentLook('inst_alpha', members).body).toBe(agentLook('inst_ops', members).body)
    const colors = memberCatColors(members)
    expect(colors.get('inst_alpha')).not.toBe(colors.get('inst_ops'))
    const chat = roomLooks(['inst_alpha', 'inst_ops'], members)
    expect(colors.get('inst_ops')).toBe(chat.get('inst_ops')!.body)
  })

  it('keeps a picked color', () => {
    const colors = memberCatColors([agent('inst_alpha', { avatarColor: '#dfc5ff' }), agent('inst_ops')])
    expect(colors.get('inst_alpha')).toBe('#dfc5ff')
  })
})
