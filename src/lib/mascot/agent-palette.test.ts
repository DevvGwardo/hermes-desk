import { describe, expect, it } from 'vitest'
import palettes from './characters/owl/palette.json'
import { agentColor, agentPalette, agentPaletteId, agentPaletteIndex } from './agent-palette'

describe('agent palettes', () => {
  it('hashes ids stably into all eight owl palettes, independent of roster order', () => {
    const ids = Array.from({ length: 64 }, (_, i) => `agent-${i}`)
    const indices = ids.map(id => agentPaletteIndex({ id }))
    expect(new Set(indices).size).toBe(8)
    for (const id of ids.reverse()) {
      expect(agentPaletteIndex(id)).toBe(indices[Number(id.slice(6))])
      expect(Object.values(palettes.agents)).toContainEqual(agentPalette(id))
    }
    expect(agentPaletteIndex('profile:default')).toBe(6)
    expect(agentPaletteIndex('旅行')).toBe(agentPaletteIndex('旅行'))
  })

  it('matches raw profiles, renderer ids and fallback ids, ignoring display names', () => {
    const profile = { id: 'profile:runner', name: 'Display name', hermesProfile: 'runner' }
    expect(agentColor(profile)).toBe(agentColor({ name: 'runner' }))
    expect(agentColor(profile)).toBe(agentColor(null, 'profile:runner'))
    expect(agentPaletteId(profile)).toBe('runner')
    expect(agentColor({ ...profile, name: 'Renamed' })).toBe(agentColor(profile))
    expect(agentPalette({})).toEqual(palettes.default)
    expect(agentColor(undefined)).toBe(palettes.default['--m-primary'])
  })

  it('overrides the primary and accent from validated ui_meta without mutating the package', () => {
    const base = agentPalette('runner')
    for (const key of ['accent_color', 'accentColor', 'accent', 'color']) {
      const profile = { id: 'runner', ui_meta: { [key]: ' #AbC ' } }
      expect(agentColor(profile)).toBe('#aabbcc')
      expect(agentPalette(profile)).toEqual({ ...base, '--m-primary': '#aabbcc', '--m-accent': '#aabbcc' })
    }
    expect(agentPalette('runner')).toBe(base)
    expect(Object.isFrozen(base)).toBe(true)
    expect(agentColor({ id: 'runner', ui_meta: { accent_color: '#123456' } })).toBe('#123456')
  })

  it('ignores malformed, transparent, external and CSS-dependent overrides', () => {
    for (const accent_color of [null, 42, '', '#12', '#12345678', 'transparent', 'var(--secret)', 'url(https://example.com)', 'red']) {
      expect(agentColor({ id: 'runner', ui_meta: { accent_color } })).toBe(agentColor('runner'))
    }
  })
})
