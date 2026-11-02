import owlPalettes from './characters/owl/palette.json'
import type { Palette } from './types'

/** Accept renderer agents, raw Hermes profiles, or a profile id. */
export interface MascotProfile {
  id?: string
  hermesProfile?: string
  name?: string
  ui_meta?: Record<string, unknown> | null
}
export type AgentPaletteProfile = MascotProfile | string | null | undefined

const palettes = Object.values(owlPalettes.agents).map(palette => Object.freeze({ ...palette }))
const defaultPalette = Object.freeze({ ...owlPalettes.default })

export function agentPaletteId(profile: AgentPaletteProfile, fallbackId = ''): string {
  const id = typeof profile === 'string'
    ? profile
    : profile?.id ?? profile?.hermesProfile ?? profile?.name ?? fallbackId
  // Raw profiles and their renderer ids must resolve to the same colour.
  return id.replace(/^profile:/, '')
}

/** FNV-1a, independent of roster order, browser state, and process lifetime. */
export function agentPaletteIndex(profile: AgentPaletteProfile, fallbackId = ''): number {
  const id = agentPaletteId(profile, fallbackId)
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0
  return hash % palettes.length
}

export function agentAccent(profile: AgentPaletteProfile): string | undefined {
  if (!profile || typeof profile === 'string') return undefined
  const meta = profile.ui_meta
  const value = meta?.accent_color ?? meta?.accentColor ?? meta?.accent ?? meta?.color
  if (typeof value !== 'string') return undefined
  const hex = value.trim()
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return undefined
  return (hex.length === 4 ? '#' + [...hex.slice(1)].map(char => char + char).join('') : hex).toLowerCase()
}

export function agentPalette(profile: AgentPaletteProfile, fallbackId = ''): Palette {
  const palette = agentPaletteId(profile, fallbackId)
    ? palettes[agentPaletteIndex(profile, fallbackId)]
    : defaultPalette
  const accent = agentAccent(profile)
  return accent
    ? Object.freeze({ ...palette, '--m-primary': accent, '--m-accent': accent })
    : palette
}

/** Use this for lanes, ghost cursors and unread badges, not the old cat colours. */
export function agentColor(profile: AgentPaletteProfile, fallbackId = ''): string {
  return agentPalette(profile, fallbackId)['--m-primary']!
}
