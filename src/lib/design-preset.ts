/**
 * Renderer-side design presets (Settings → Appearance → Design).
 *
 * SAFETY CONTRACT — this module is the whole renderer surface of "live design":
 *  - The only things it can change on the document are the CSS custom
 *    properties named in `DESIGN_TOKEN_NAMES` plus the fixed `data-design`
 *    marker attribute. There is no style element, no selector string, no CSS
 *    text, no URL and no HTML anywhere in the pipeline.
 *  - Every value is derived from a validated `#rrggbb` colour, a small
 *    integer, or a closed enum. A preset therefore cannot carry arbitrary CSS.
 *  - Import is strict: unknown fields, missing fields, wrong types and
 *    out-of-range numbers reject the WHOLE preset with field-level errors, so
 *    a bad file can never half-apply.
 *
 * This is deliberately NOT the self-modification pipeline: it never touches
 * source files, the phase-2 gate, or packaged-app delivery.
 */
import { useSyncExternalStore } from 'react'
import { isHexColor } from './color'
import { applyTheme, loadTheme, saveTheme, type ThemeId } from './theme'

export const DESIGN_ENVELOPE_KIND = 'hermes-desk.design-preset'
export const DESIGN_SCHEMA_VERSION = 1
export const DESIGN_KEY = 'hermes-desk:design-preset:v1'

export const DENSITIES = ['compact', 'comfortable', 'roomy'] as const
export type Density = (typeof DENSITIES)[number]

export const MOTION_LEVELS = ['full', 'calm', 'none'] as const
export type MotionLevel = (typeof MOTION_LEVELS)[number]

export const FONT_IDS = ['poppins', 'system', 'serif', 'mono'] as const
export type FontId = (typeof FONT_IDS)[number]

/** Safe font allowlist. Plain stacks only — a preset can never name a remote face. */
export const FONT_STACKS: Record<FontId, string> = {
  poppins: '"Poppins", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
}

export const FONT_LABELS: Record<FontId, string> = {
  poppins: 'Poppins',
  system: 'System sans',
  serif: 'Serif',
  mono: 'Monospace',
}

export const DENSITY_LABELS: Record<Density, string> = {
  compact: 'Compact',
  comfortable: 'Comfortable',
  roomy: 'Roomy',
}

export const MOTION_LABELS: Record<MotionLevel, string> = {
  full: 'Full',
  calm: 'Calm',
  none: 'None',
}

export const RADIUS_MIN = 0
export const RADIUS_MAX = 24
export const NAME_MAX = 40

export interface DesignPreset {
  name: string
  theme: ThemeId
  accent: string
  canvas: string
  surface: string
  ink: string
  radius: number
  density: Density
  font: FontId
  motion: MotionLevel
}

const PRESET_FIELDS = [
  'name', 'theme', 'accent', 'canvas', 'surface', 'ink', 'radius', 'density', 'font', 'motion',
] as const

const NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,40}$/

/* ── colour maths ────────────────────────────────────────────────────── */

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.trim().slice(1)
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ]
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`
}

/** sRGB component mix. `t` = amount of `b`. */
function mix(a: string, b: string, t: number): string {
  const left = hexToRgb(a)
  const right = hexToRgb(b)
  const clamped = Math.max(0, Math.min(1, t))
  return rgbToHex([
    left[0] + (right[0] - left[0]) * clamped,
    left[1] + (right[1] - left[1]) * clamped,
    left[2] + (right[2] - left[2]) * clamped,
  ])
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const srgb = channel / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

/* ── derived palette ─────────────────────────────────────────────────── */

/** Step a colour toward `toward` until it clears `min` against `background`. */
function stepUntilReadable(from: string, toward: string, background: string, min: number): string {
  if (contrastRatio(from, background) >= min) return from
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(from, toward, step / 20)
    if (contrastRatio(candidate, background) >= min) return candidate
  }
  return toward
}

export interface DerivedPalette {
  canvasDeep: string
  inkSoft: string
  inkMuted: string
  primaryText: string
  primaryHover: string
  primarySoft: string
  primaryFill: string
  primaryFillHover: string
  brandTint: string
  sidebar: string
  border: string
  borderStrong: string
  fieldBorder: string
  placeholder: string
  hover: string
  cardGlass: string
  shadow: string
  shadowSoft: string
}

export function derivePalette(preset: DesignPreset): DerivedPalette {
  const { accent, canvas, surface, ink, theme } = preset
  // Secondary ink steps are measured against CARDS, where they are actually
  // read. A canvas mix would drift below AA on near-white surfaces.
  const inkSoft = mix(ink, surface, 0.22)
  const inkMuted = stepUntilReadable(mix(ink, surface, 0.42), ink, surface, 4.5)
  // Accent is a fill/tint colour; as TEXT it must clear AA on cards. Presets
  // may ship a bright accent, so the text step is derived, never trusted.
  const primaryText = stepUntilReadable(accent, ink, surface, 4.5)
  // Filled buttons carry white labels, so the fill is stepped toward black
  // until white clears AA behind it.
  const primaryFill = ensureWhite(accent)
  const primarySoft = mix(accent, canvas, 0.88)
  const placeholder = inkMuted
  return {
    canvasDeep: mix(canvas, ink, 0.08),
    inkSoft,
    inkMuted,
    primaryText,
    primaryHover: mix(accent, ink, 0.16),
    primarySoft,
    primaryFill,
    primaryFillHover: mix(primaryFill, relativeLuminance(primaryFill) > 0.35 ? '#000000' : '#ffffff', 0.18),
    brandTint: mix(accent, canvas, 0.8),
    sidebar: primarySoft,
    border: withAlpha(ink, 0.14),
    borderStrong: withAlpha(ink, 0.26),
    fieldBorder: withAlpha(ink, 0.55),
    placeholder,
    hover: theme === 'light' ? 'rgba(255, 255, 255, 0.7)' : 'rgba(255, 255, 255, 0.08)',
    cardGlass: withAlpha(surface, 0.72),
    shadow: theme === 'light'
      ? `0 8px 28px ${withAlpha(ink, 0.12)}`
      : '0 8px 28px rgba(0, 0, 0, 0.6)',
    shadowSoft: theme === 'light'
      ? `0 2px 10px ${withAlpha(ink, 0.08)}`
      : '0 2px 10px rgba(0, 0, 0, 0.5)',
  }
}

/** White label legibility against a fill: darken the fill until white clears AA. */
function ensureWhite(fill: string): string {
  if (contrastRatio('#ffffff', fill) >= 4.5) return fill
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(fill, '#000000', step / 20)
    if (contrastRatio('#ffffff', candidate) >= 4.5) return candidate
  }
  return '#000000'
}

/* ── tokens ──────────────────────────────────────────────────────────── */

const DENSITY_TOKENS: Record<Density, { pad: number; gap: number }> = {
  compact: { pad: 10, gap: 8 },
  comfortable: { pad: 18, gap: 12 },
  roomy: { pad: 28, gap: 18 },
}

const MOTION_TOKENS: Record<MotionLevel, { dur1: number; dur2: number; dur3: number; stagger: number }> = {
  full: { dur1: 140, dur2: 220, dur3: 360, stagger: 60 },
  calm: { dur1: 190, dur2: 300, dur3: 460, stagger: 80 },
  none: { dur1: 0, dur2: 0, dur3: 0, stagger: 0 },
}

/** The complete set of properties a preset may write. Nothing else is touched. */
export const DESIGN_TOKEN_NAMES = [
  '--ca-canvas',
  '--ca-canvas-deep',
  '--ca-card',
  '--ca-card-glass',
  '--ca-hover',
  '--ca-ink',
  '--ca-ink-soft',
  '--ca-ink-muted',
  '--ca-primary',
  '--ca-primary-hover',
  '--ca-primary-soft',
  '--ca-primary-text',
  '--ca-primary-fill',
  '--ca-primary-fill-hover',
  '--ca-bubble-user',
  '--ca-brand-tint',
  '--ca-sidebar',
  '--ca-border',
  '--ca-border-strong',
  '--ca-field-border',
  '--ca-placeholder',
  '--ca-shadow',
  '--ca-shadow-soft',
  '--ca-focus-ring',
  '--ca-radius',
  '--ca-radius-sm',
  '--ca-font',
  '--ca-ease',
  '--ca-dur-1',
  '--ca-dur-2',
  '--ca-dur-3',
  '--ca-stagger',
  '--ca-density-pad',
  '--ca-density-gap',
] as const

export type DesignTokenName = (typeof DESIGN_TOKEN_NAMES)[number]

export function designTokens(preset: DesignPreset): Record<DesignTokenName, string> {
  const palette = derivePalette(preset)
  const density = DENSITY_TOKENS[preset.density]
  const motion = MOTION_TOKENS[preset.motion]
  const radius = Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, Math.round(preset.radius)))
  return {
    '--ca-canvas': preset.canvas,
    '--ca-canvas-deep': palette.canvasDeep,
    '--ca-card': preset.surface,
    '--ca-card-glass': palette.cardGlass,
    '--ca-hover': palette.hover,
    '--ca-ink': preset.ink,
    '--ca-ink-soft': palette.inkSoft,
    '--ca-ink-muted': palette.inkMuted,
    '--ca-primary': preset.accent,
    '--ca-primary-hover': palette.primaryHover,
    '--ca-primary-soft': palette.primarySoft,
    '--ca-primary-text': palette.primaryText,
    '--ca-primary-fill': palette.primaryFill,
    '--ca-primary-fill-hover': palette.primaryFillHover,
    '--ca-bubble-user': palette.primaryFill,
    '--ca-brand-tint': palette.brandTint,
    '--ca-sidebar': palette.sidebar,
    '--ca-border': palette.border,
    '--ca-border-strong': palette.borderStrong,
    '--ca-field-border': palette.fieldBorder,
    '--ca-placeholder': palette.placeholder,
    '--ca-shadow': palette.shadow,
    '--ca-shadow-soft': palette.shadowSoft,
    '--ca-focus-ring': palette.primaryText,
    '--ca-radius': `${radius}px`,
    '--ca-radius-sm': `${Math.max(4, radius - 6)}px`,
    '--ca-font': FONT_STACKS[preset.font],
    '--ca-ease': 'cubic-bezier(0.22, 1, 0.36, 1)',
    '--ca-dur-1': `${motion.dur1}ms`,
    '--ca-dur-2': `${motion.dur2}ms`,
    '--ca-dur-3': `${motion.dur3}ms`,
    '--ca-stagger': `${motion.stagger}ms`,
    '--ca-density-pad': `${density.pad}px`,
    '--ca-density-gap': `${density.gap}px`,
  }
}

/* ── contrast report ─────────────────────────────────────────────────── */

export interface ContrastCheck {
  id: string
  label: string
  foreground: string
  background: string
  ratio: number
  min: number
  pass: boolean
}

/** AA pairs the design must hold. `primary` and `fill` steps are derived, so
 *  these describe what the app will actually paint. */
export function contrastChecks(preset: DesignPreset): ContrastCheck[] {
  const palette = derivePalette(preset)
  const pairs: Array<[string, string, string, string, number]> = [
    ['ink-canvas', 'Body text on the canvas', preset.ink, preset.canvas, 4.5],
    ['ink-surface', 'Body text on cards', preset.ink, preset.surface, 4.5],
    ['muted-surface', 'Muted text on cards', palette.inkMuted, preset.surface, 4.5],
    ['primary-surface', 'Links and primary text on cards', palette.primaryText, preset.surface, 4.5],
    ['accent-surface', 'Icons, borders, focus ring on cards', preset.accent, preset.surface, 3],
    ['white-fill', 'Button label on primary fills', '#ffffff', palette.primaryFill, 4.5],
  ]
  return pairs.map(([id, label, foreground, background, min]) => {
    const ratio = Math.round(contrastRatio(foreground, background) * 100) / 100
    return { id, label, foreground, background, ratio, min, pass: ratio >= min }
  })
}

export function failingChecks(preset: DesignPreset): ContrastCheck[] {
  return contrastChecks(preset).filter((check) => !check.pass)
}

/* ── presets ─────────────────────────────────────────────────────────── */

export interface BuiltinPreset {
  id: string
  preset: DesignPreset
}

const preset = (value: DesignPreset): DesignPreset => value

export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [
  {
    id: 'desk',
    preset: preset({
      name: 'Hermes Desk', theme: 'light', accent: '#2f7ed8', canvas: '#9ecdff',
      surface: '#ffffff', ink: '#1a3d6b', radius: 16, density: 'comfortable', font: 'poppins', motion: 'full',
    }),
  },
  {
    id: 'ink',
    preset: preset({
      name: 'Ink', theme: 'dark', accent: '#5aa2ef', canvas: '#000000',
      surface: '#111111', ink: '#f5f5f5', radius: 16, density: 'comfortable', font: 'system', motion: 'full',
    }),
  },
  {
    id: 'paper',
    preset: preset({
      name: 'Paper', theme: 'light', accent: '#8a5a2b', canvas: '#f2ede2',
      surface: '#fffdf7', ink: '#241f18', radius: 8, density: 'roomy', font: 'serif', motion: 'calm',
    }),
  },
  {
    id: 'moss',
    preset: preset({
      name: 'Moss', theme: 'light', accent: '#2f6b3f', canvas: '#e4ecdf',
      surface: '#fbfdf8', ink: '#1f2c1c', radius: 12, density: 'comfortable', font: 'system', motion: 'calm',
    }),
  },
  {
    id: 'dusk',
    preset: preset({
      name: 'Dusk', theme: 'dark', accent: '#b49cf0', canvas: '#13111a',
      surface: '#1e1b26', ink: '#f2eef7', radius: 20, density: 'comfortable', font: 'system', motion: 'full',
    }),
  },
  {
    id: 'ember',
    preset: preset({
      name: 'Ember', theme: 'dark', accent: '#e8823f', canvas: '#15100c',
      surface: '#211913', ink: '#f8eee4', radius: 10, density: 'compact', font: 'system', motion: 'calm',
    }),
  },
]

/** Stable identity for "is this the same design?" comparisons. */
export function presetKey(value: DesignPreset | null): string {
  if (!value) return ''
  return PRESET_FIELDS.map((field) => String(value[field])).join('|')
}

export function samePreset(a: DesignPreset | null, b: DesignPreset | null): boolean {
  return presetKey(a) === presetKey(b)
}

/* ── strict parsing ──────────────────────────────────────────────────── */

export type ParseResult =
  | { ok: true; preset: DesignPreset }
  | { ok: false; errors: string[] }

const fail = (errors: string[]): ParseResult => ({ ok: false, errors })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Field-level validation. Rejects unknown and missing fields outright. */
export function parsePreset(raw: unknown): ParseResult {
  if (!isRecord(raw)) return fail(['preset: expected an object'])
  const errors: string[] = []
  for (const key of Object.keys(raw)) {
    if (!(PRESET_FIELDS as readonly string[]).includes(key)) errors.push(`preset.${key}: unknown field`)
  }
  const missing = PRESET_FIELDS.filter((field) => !(field in raw))
  for (const field of missing) errors.push(`preset.${field}: missing`)

  const text = (field: string, value: unknown): string => {
    if (typeof value !== 'string') { errors.push(`preset.${field}: expected a string`); return '' }
    return value
  }
  const colour = (field: string, value: unknown): string => {
    if (!isHexColor(value)) { errors.push(`preset.${field}: expected a #rrggbb colour`); return '#000000' }
    return value.trim().toLowerCase()
  }

  const name = missing.includes('name') ? '' : text('name', raw.name).trim()
  if (!missing.includes('name') && !NAME_PATTERN.test(name)) {
    errors.push('preset.name: 1–40 characters, no control characters')
  }

  const theme = raw.theme
  if (!missing.includes('theme') && theme !== 'light' && theme !== 'dark') {
    errors.push("preset.theme: expected 'light' or 'dark'")
  }
  const density = raw.density
  if (!missing.includes('density') && !(DENSITIES as readonly unknown[]).includes(density)) {
    errors.push(`preset.density: expected one of ${DENSITIES.join(', ')}`)
  }
  const font = raw.font
  if (!missing.includes('font') && !(FONT_IDS as readonly unknown[]).includes(font)) {
    errors.push(`preset.font: expected one of ${FONT_IDS.join(', ')}`)
  }
  const motion = raw.motion
  if (!missing.includes('motion') && !(MOTION_LEVELS as readonly unknown[]).includes(motion)) {
    errors.push(`preset.motion: expected one of ${MOTION_LEVELS.join(', ')}`)
  }
  const radius = raw.radius
  if (!missing.includes('radius')) {
    if (typeof radius !== 'number' || !Number.isInteger(radius) || radius < RADIUS_MIN || radius > RADIUS_MAX) {
      errors.push(`preset.radius: expected a whole number between ${RADIUS_MIN} and ${RADIUS_MAX}`)
    }
  }

  const accent = missing.includes('accent') ? '#000000' : colour('accent', raw.accent)
  const canvas = missing.includes('canvas') ? '#000000' : colour('canvas', raw.canvas)
  const surface = missing.includes('surface') ? '#000000' : colour('surface', raw.surface)
  const ink = missing.includes('ink') ? '#000000' : colour('ink', raw.ink)

  if (errors.length > 0) return fail(errors)
  return {
    ok: true,
    preset: {
      name,
      theme: theme as ThemeId,
      accent,
      canvas,
      surface,
      ink,
      radius: radius as number,
      density: density as Density,
      font: font as FontId,
      motion: motion as MotionLevel,
    },
  }
}

export function serializePreset(value: DesignPreset): string {
  return JSON.stringify({
    kind: DESIGN_ENVELOPE_KIND,
    schemaVersion: DESIGN_SCHEMA_VERSION,
    preset: value,
  }, null, 2)
}

const ENVELOPE_FIELDS = ['kind', 'schemaVersion', 'preset'] as const

/** Strict import. Anything unrecognised rejects; nothing is applied on error. */
export function parsePresetFile(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail(['file: not valid JSON'])
  }
  if (!isRecord(raw)) return fail(['file: expected a JSON object'])
  const errors: string[] = []
  for (const key of Object.keys(raw)) {
    if (!(ENVELOPE_FIELDS as readonly string[]).includes(key)) errors.push(`${key}: unknown field`)
  }
  if (raw.kind !== DESIGN_ENVELOPE_KIND) errors.push(`kind: expected ${DESIGN_ENVELOPE_KIND}`)
  if (raw.schemaVersion !== DESIGN_SCHEMA_VERSION) {
    errors.push(`schemaVersion: expected ${DESIGN_SCHEMA_VERSION}`)
  }
  const inner = parsePreset(raw.preset)
  if (!inner.ok) errors.push(...inner.errors)
  if (errors.length > 0 || !inner.ok) return fail(errors)
  return inner
}

/* ── persistence ─────────────────────────────────────────────────────── */

export type DesignScope = 'global' | 'profile'

export interface DesignStore {
  global: DesignPreset | null
  profiles: Record<string, DesignPreset>
}

const emptyStore = (): DesignStore => ({ global: null, profiles: {} })

/** Any stored preset that no longer validates is dropped, never half-read. */
export function normalizeStore(value: unknown): DesignStore {
  if (!isRecord(value)) return emptyStore()
  const global = parsePreset(value.global)
  const profiles: Record<string, DesignPreset> = {}
  if (isRecord(value.profiles)) {
    for (const [profile, entry] of Object.entries(value.profiles)) {
      if (!profile.trim()) continue
      const parsed = parsePreset(entry)
      if (parsed.ok) profiles[profile] = parsed.preset
    }
  }
  return { global: global.ok ? global.preset : null, profiles }
}

function readStore(): DesignStore {
  try {
    if (typeof window === 'undefined') return emptyStore()
    const raw = window.localStorage.getItem(DESIGN_KEY)
    if (!raw) return emptyStore()
    const envelope: unknown = JSON.parse(raw)
    if (!isRecord(envelope)) return emptyStore()
    if (envelope.slice !== 'hermes-desk.design-preset' || envelope.schemaVersion !== DESIGN_SCHEMA_VERSION) {
      return emptyStore()
    }
    return normalizeStore(envelope.value)
  } catch {
    return emptyStore()
  }
}

function writeStore(value: DesignStore): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(DESIGN_KEY, JSON.stringify({
      slice: 'hermes-desk.design-preset',
      schemaVersion: DESIGN_SCHEMA_VERSION,
      scope: 'client-persisted',
      savedAt: new Date().toISOString(),
      value,
    }))
  } catch {
    /* private mode / quota — the in-memory design still applies */
  }
}

/* ── live state ──────────────────────────────────────────────────────── */

export interface DesignState {
  /** Saved preset that is in force for the active profile (profile → global). */
  saved: DesignPreset | null
  /** Unsaved preview, or null. */
  preview: DesignPreset | null
  /** What the document is currently painted with. */
  shown: DesignPreset | null
  dirty: boolean
  scope: DesignScope
  profile: string
  globalPreset: DesignPreset | null
  profilePreset: DesignPreset | null
}

let store: DesignStore = emptyStore()
let preview: DesignPreset | null = null
let scope: DesignScope = 'global'
let activeProfileName = 'default'
let loaded = false
let snapshot: DesignState | null = null
const listeners = new Set<() => void>()

function effective(): DesignPreset | null {
  return store.profiles[activeProfileName] ?? store.global ?? null
}

function emit(): void {
  snapshot = null
  for (const listener of listeners) listener()
}

function paint(value: DesignPreset | null): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (!value) {
    for (const name of DESIGN_TOKEN_NAMES) root.style.removeProperty(name)
    root.removeAttribute('data-design')
    applyTheme(loadTheme())
    return
  }
  const tokens = designTokens(value)
  for (const name of DESIGN_TOKEN_NAMES) root.style.setProperty(name, tokens[name])
  root.setAttribute('data-design', '')
  applyTheme(value.theme)
}

export function getDesignState(): DesignState {
  if (!loaded) load()
  if (snapshot) return snapshot
  const shown = preview ?? effective()
  snapshot = {
    saved: effective(),
    preview,
    shown,
    dirty: preview !== null && !samePreset(preview, effective()),
    scope,
    profile: activeProfileName,
    globalPreset: store.global,
    profilePreset: store.profiles[activeProfileName] ?? null,
  }
  return snapshot
}

function load(): void {
  if (loaded) return
  loaded = true
  store = readStore()
}

export function subscribeDesign(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== DESIGN_KEY && event.key !== null) return
    store = readStore()
    paint(preview ?? effective())
    emit()
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

export function useDesign(): DesignState {
  return useSyncExternalStore(subscribeDesign, getDesignState, getDesignState)
}

/**
 * Boot hook: load the saved presets and paint the one in force.
 *
 * Deliberately takes the profile as a plain string instead of importing the
 * plugin host atom: App.tsx already owns `$activeProfile` and calls
 * `setDesignProfile` when it changes, which keeps the whole plugin graph out
 * of the boot entry chunk.
 */
export function initDesign(profile = 'default'): void {
  load()
  activeProfileName = profile.trim() || 'default'
  preview = null
  paint(effective())
  emit()
}

/** Switching Hermes profile swaps in that profile's preset (or global). Any
 *  unsaved preview is dropped: it belonged to the previous profile. */
export function setDesignProfile(profile: string): void {
  const next = profile.trim() || 'default'
  if (next === activeProfileName) return
  load()
  activeProfileName = next
  preview = null
  paint(effective())
  emit()
}

/** Live preview. Nothing is written to storage until commitDesignPreview(). */
export function previewDesign(value: DesignPreset | null): void {
  load()
  preview = value
  paint(value ?? effective())
  emit()
}

export function revertDesign(): void {
  preview = null
  paint(effective())
  emit()
}

export function setDesignScope(next: DesignScope): void {
  if (next === scope) return
  scope = next
  emit()
}

/** Persist the preview into the active scope. Returns what was saved. */
export function commitDesignPreview(): DesignPreset | null {
  if (!preview) return null
  load()
  // Storage only ever holds presets that pass the same strict check an import
  // does — otherwise a blank name typed in the pane would be written and then
  // silently dropped on the next reload.
  const checked = parsePreset({
    ...preview,
    name: preview.name.trim().slice(0, NAME_MAX) || 'Custom design',
  })
  if (!checked.ok) return null
  const saved = checked.preset
  store = scope === 'profile'
    ? { ...store, profiles: { ...store.profiles, [activeProfileName]: saved } }
    : { ...store, global: saved }
  writeStore(store)
  preview = null
  // Theme follows the preset so the picker above and a reload agree.
  saveTheme(saved.theme)
  paint(effective())
  emit()
  return saved
}

/** Remove the saved preset for the active scope and fall back (profile → global → default). */
export function resetDesign(): void {
  load()
  preview = null
  if (scope === 'profile') {
    const profiles = { ...store.profiles }
    delete profiles[activeProfileName]
    store = { ...store, profiles }
  } else {
    store = { ...store, global: null }
  }
  writeStore(store)
  paint(effective())
  emit()
}

/** Test helper: forget the in-memory state so the next read reloads. */
export function resetDesignStoreForTests(): void {
  store = emptyStore()
  preview = null
  scope = 'global'
  activeProfileName = 'default'
  loaded = false
  snapshot = null
}