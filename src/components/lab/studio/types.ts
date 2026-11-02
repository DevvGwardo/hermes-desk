import type { CatExpression, GrokOrbFaceTune, GrokOrbInkGradient, GrokOrbPose, GrokOrbShape } from '../../FatCatIcon'

/** One state held on the orb for [start, start+dur) ms. */
export interface OrbSeg {
  id: string
  start: number
  dur: number
  state: CatExpression
}

/** Instant trick fired at time t.
 *  @deprecated Pip has no trick clips; kept so saved projects still load. */
export interface TrickMark {
  id: string
  t: number
  trick: 'spin' | 'bounce' | 'burst'
}

/** Caption card shown for [start, start+dur). mode pop = word-by-word,
 *  speech = bubble card + triangular tail pointing `tail` (default bottom). */
export type CapTail = 'top' | 'bottom' | 'left' | 'right'
export interface CapSeg {
  id: string
  start: number
  dur: number
  text: string
  sub: string
  mode: 'bubble' | 'bar' | 'pop' | 'speech'
  tail?: CapTail
}

/** Post effect active for [start, start+dur). All deterministic fns of
 *  timeline time so preview CSS and canvas export match exactly. */
export interface FxSeg {
  id: string
  start: number
  dur: number
  kind: 'shake' | 'zoom' | 'flash' | 'pulse'
  amount: number // 0..1 intensity multiplier
}

/** Optional photo backdrop. Additive: older timelines without it render
 *  exactly as today on the flat `bg` fill. */
export interface BgImage {
  dataUrl: string
  fit: 'cover' | 'contain' | 'stretch'
}

/** Stage background change at time `start` (per-scene colors). Optional so
 *  older saved timelines + LoopStudio presets stay valid (flat `bg`). */
export interface BgChange {
  start: number
  color: string
}

export interface Timeline {
  orb: OrbSeg[]
  tricks: TrickMark[]
  caps: CapSeg[]
  fx: FxSeg[]
  bg: string
  /** photo backdrop. optional so older saved timelines + existing
   *  presets/templates builds stay valid (flat `bg` only). */
  bgImage?: BgImage
  /** per-scene stage colors, chronological. absent/empty = flat `bg`. */
  bgChanges?: BgChange[]
  /** emoji stickers. optional so older saved timelines + existing
   *  presets/templates builds stay valid. */
  props?: PropMark[]
  /** mascot direction: accent palette. pose/shape/face fields are legacy
   *  leftovers from the retired engine (ignored at render) so older saved
   *  timelines + presets still load; only `fg` drives Pip's accent. */
  mascot?: Mascot
}

/** Mascot direction: accent color. Shape/pose/face fields are legacy
 *  (retired engine) — accepted so old timelines load, ignored at render. */
export interface Mascot {
  shape: GrokOrbShape
  fg: string
  bg: string
  pose?: GrokOrbPose
  faceTune?: GrokOrbFaceTune
  inkGradient?: GrokOrbInkGradient
  eyeScale?: number
  uniformEyes?: boolean
  eyeTopology?: boolean
  emphasis?: boolean
}

/** Emoji sticker shown for [start, start+dur). x/y are 0..540 stage
 *  coords, scale 0.5..2. pinned=true renders inside the fx-transformed
 *  orb wrapper (inherits shake/zoom/pulse), false is screen-fixed. */
export interface PropMark {
  id: string
  start: number
  dur: number
  art: string
  x: number
  y: number
  scale: number
  pinned: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Runtime boundary for localStorage/imported projects. Avoids treating
 * malformed JSON as a Timeline and crashing the editor during render. */
export const isTimeline = (value: unknown): value is Timeline => {
  if (!isRecord(value) || typeof value.bg !== 'string') return false
  if (!Array.isArray(value.orb) || !Array.isArray(value.tricks) || !Array.isArray(value.caps) || !Array.isArray(value.fx)) return false
  return value.orb.every((item) => isRecord(item) && typeof item.id === 'string' && typeof item.start === 'number' && Number.isFinite(item.start) && item.start >= 0 && typeof item.dur === 'number' && Number.isFinite(item.dur) && item.dur > 0 && typeof item.state === 'string')
    && value.tricks.every((item) => isRecord(item) && typeof item.id === 'string' && typeof item.t === 'number' && Number.isFinite(item.t) && item.t >= 0 && ['spin', 'bounce', 'burst'].includes(String(item.trick)))
    && value.caps.every((item) => isRecord(item) && typeof item.id === 'string' && typeof item.start === 'number' && Number.isFinite(item.start) && item.start >= 0 && typeof item.dur === 'number' && Number.isFinite(item.dur) && item.dur > 0 && typeof item.text === 'string' && typeof item.sub === 'string' && ['bubble', 'bar', 'pop', 'speech'].includes(String(item.mode)))
    && value.fx.every((item) => isRecord(item) && typeof item.id === 'string' && typeof item.start === 'number' && Number.isFinite(item.start) && item.start >= 0 && typeof item.dur === 'number' && Number.isFinite(item.dur) && item.dur > 0 && ['shake', 'zoom', 'flash', 'pulse'].includes(String(item.kind)) && typeof item.amount === 'number' && Number.isFinite(item.amount))
}

export const totalDur = (tl: Timeline): number =>
  Math.max(
    0,
    ...tl.orb.map((s) => s.start + s.dur),
    ...tl.tricks.map((t) => t.t + 1),
    ...tl.caps.map((c) => c.start + c.dur),
    ...tl.fx.map((f) => f.start + f.dur),
    ...(tl.props ?? []).map((p) => p.start + p.dur),
  )

export const uid = (): string =>
  Math.random().toString(36).slice(2, 9)

/** Stable hex output for native <input type="color"> controls. */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360 / 360
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number): number => {
    const x = ((t % 1) + 1) % 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  const hex = (value: number) => Math.round(channel(value) * 255).toString(16).padStart(2, '0')
  return `#${hex(hue + 1 / 3)}${hex(hue)}${hex(hue - 1 / 3)}`
}

/** state active at time t (last segment wins on overlap). past the end,
 *  holds the FIRST segment's state so exports can append a settle tail
 *  that lands back on the opening pose. */
export const orbAt = (tl: Timeline, t: number): CatExpression => {
  let cur: CatExpression | null = null
  for (const s of tl.orb) if (t >= s.start && t < s.start + s.dur) cur = s.state
  if (cur) return cur
  return tl.orb.length ? tl.orb[0].state : 'idle'
}

/** caption active at time t (last wins). */
export const capAt = (tl: Timeline, t: number): CapSeg | null => {
  let cur: CapSeg | null = null
  for (const c of tl.caps) if (t >= c.start && t < c.start + c.dur) cur = c
  return cur
}

/** stage bg active at time t (last change wins, else flat bg). Drives both
 *  the preview stage and the export fills so per-scene colors match. */
export const bgAt = (tl: Timeline, t: number): string => {
  let cur = tl.bg
  for (const b of tl.bgChanges ?? []) if (t >= b.start) cur = b.color
  return cur
}/** props active at time t (all that overlap, in track order). */
export const propAt = (tl: Timeline, t: number): PropMark[] =>
  (tl.props ?? []).filter((p) => t >= p.start && t < p.start + p.dur)
