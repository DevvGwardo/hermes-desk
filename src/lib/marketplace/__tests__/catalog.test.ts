import { describe, expect, it } from 'vitest'
import { AVATAR_BODY_COLORS, AVATAR_EYE_COLORS } from '../../avatar-spec'
import { MARKETPLACE_LISTINGS, SHELVES, addedAgentId, profileForListing } from '../catalog'

// Skills every VM has (hermes-deploy src/lib/bundled-skills.ts).
const BUNDLED = ['view-attached-images', 'tinyfish-web', 'x-search', 'hn-search', 'nub-site']

describe('marketplace catalog', () => {
  it('has unique slugs and names, and every shelf is used', () => {
    expect(new Set(MARKETPLACE_LISTINGS.map((l) => l.slug)).size).toBe(MARKETPLACE_LISTINGS.length)
    expect(new Set(MARKETPLACE_LISTINGS.map((l) => l.name.toLowerCase())).size).toBe(MARKETPLACE_LISTINGS.length)
    for (const s of SHELVES) expect(MARKETPLACE_LISTINGS.some((l) => l.shelf === s.id)).toBe(true)
  })

  it('draws every agent from the nubcat palette, with a distinct look', () => {
    for (const l of MARKETPLACE_LISTINGS) {
      expect(AVATAR_BODY_COLORS).toContain(l.body)
      expect(AVATAR_EYE_COLORS).toContain(l.eye)
    }
    expect(new Set(MARKETPLACE_LISTINGS.map((l) => `${l.body}/${l.eye}`)).size).toBe(MARKETPLACE_LISTINGS.length)
  })

  it('only names skills that ship on every VM', () => {
    for (const l of MARKETPLACE_LISTINGS) {
      for (const skill of l.personality.match(/[a-z]+(?:-[a-z]+)+(?= skill)/g) ?? []) expect(BUNDLED).toContain(skill)
    }
  })

  it('keeps row copy to one short line', () => {
    for (const l of MARKETPLACE_LISTINGS) expect(l.tagline.length).toBeLessThanOrEqual(64)
  })

  it('builds the profile Add creates; only the Chief is an orchestrator', () => {
    const chief = MARKETPLACE_LISTINGS.find((l) => l.slug === 'chief-of-staff')!
    expect(profileForListing(chief)).toMatchObject({ name: 'Chief of Staff', role: 'orchestrator', avatarShape: 'cat' })
    const writer = MARKETPLACE_LISTINGS.find((l) => l.slug === 'writer')!
    expect(profileForListing(writer)).toMatchObject({
      name: 'Writer',
      role: 'specialist',
      avatarColor: writer.body,
      avatarEyeColor: writer.eye,
      personality: writer.personality,
    })
    expect(MARKETPLACE_LISTINGS.filter((l) => l.role === 'orchestrator')).toHaveLength(1)
  })

  it('knows a listing is added by the agent name (case and spacing ignored)', () => {
    const writer = MARKETPLACE_LISTINGS.find((l) => l.slug === 'writer')!
    expect(addedAgentId(writer, [{ id: 'a1', name: '  writer ' }])).toBe('a1')
    expect(addedAgentId(writer, [{ id: 'a1', name: 'Writer Bot' }])).toBeNull()
  })
})
