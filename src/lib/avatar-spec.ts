/**
 * avatar-spec — shared modular avatar contract (nubcat only).
 *
 * AvatarSpec { shape: 'cat', bodyColor, eyeColor } with closed 4-color
 * palettes per slot. FatCatIcon wiring: bgColor = eyeColor (engine --bg,
 * eye whites), fgColor = bodyColor (engine --fg, orb body/head).
 * Silhouette never changes — always the nubcat.
 */

export interface AvatarSpec {
  shape: 'cat'
  bodyColor: string
  eyeColor: string
}

/** Nubcat body fills — same four palettes as NUBCAT_COLORS. */
export const AVATAR_BODY_COLORS = ['#b7d9ff', '#ffd7e6', '#dfc5ff', '#c0ef82'] as const

/** Canonical nubcat eye fills — single source (agents/types re-exports it). */
export const NUBCAT_EYE_COLORS = ['#1a3d6b', '#4a2c6b', '#14532d', '#57331f'] as const

/** Nubcat eye fills — dark tones that pop against the light body. */
export const AVATAR_EYE_COLORS = NUBCAT_EYE_COLORS

export const DEFAULT_BODY_COLOR: string = AVATAR_BODY_COLORS[0]
export const DEFAULT_EYE_COLOR: string = AVATAR_EYE_COLORS[0]

/** Closed-shape default — the only mascot. */
export const DEFAULT_AVATAR_SPEC: AvatarSpec = {
  shape: 'cat',
  bodyColor: DEFAULT_BODY_COLOR,
  eyeColor: DEFAULT_EYE_COLOR,
}

/** Human-readable names for every palette hex (lowercase keys). */
export const COLOR_NAME_MAP: Record<string, string> = {
  '#b7d9ff': 'Sky',
  '#ffd7e6': 'Blossom',
  '#dfc5ff': 'Lilac',
  '#c0ef82': 'Leaf',
  '#1a3d6b': 'Navy',
  '#4a2c6b': 'Plum',
  '#14532d': 'Forest',
  '#57331f': 'Espresso',
}

export function colorName(hex: string): string {
  return COLOR_NAME_MAP[hex.toLowerCase()] ?? hex
}

/** Closed color-name → palette hex (body + eye); unknown names → undefined. */
export function nameToHex(name: string): string | undefined {
  const k = name.trim().toLowerCase()
  const alias: Record<string, string> = { blue: 'sky', pink: 'blossom', purple: 'lilac', green: 'leaf' }
  const want = alias[k] ?? k
  for (const [hex, label] of Object.entries(COLOR_NAME_MAP)) {
    if (label.toLowerCase() === want) return hex
  }
  return undefined
}

function pickColor(raw: unknown, palette: readonly string[], fallback: string): string {
  const v = typeof raw === 'string' ? raw.toLowerCase() : ''
  const hit = palette.find((c) => c.toLowerCase() === v)
  return hit ?? fallback
}

/**
 * Coerce unknown input into a valid AvatarSpec. Shape is always 'cat';
 * off-palette colors fall back to defaults (never throw — safe for
 * stored / transport data).
 */
export function validateAvatar(value: unknown): AvatarSpec {
  if (!value || typeof value !== 'object') return { ...DEFAULT_AVATAR_SPEC }
  const v = value as Record<string, unknown>
  return {
    shape: 'cat',
    bodyColor: pickColor(v.bodyColor ?? v.avatarColor, AVATAR_BODY_COLORS, DEFAULT_BODY_COLOR),
    eyeColor: pickColor(v.eyeColor ?? v.avatarEyeColor, AVATAR_EYE_COLORS, DEFAULT_EYE_COLOR),
  }
}

/** Resolve an agent-like row to its AvatarSpec (eye key is forward-compat). */
export function resolveAvatarSpec(
  agent: { avatarColor?: string | null; avatarEyeColor?: string | null } | null | undefined,
): AvatarSpec {
  return validateAvatar(agent ? { bodyColor: agent.avatarColor, eyeColor: agent.avatarEyeColor } : null)
}
