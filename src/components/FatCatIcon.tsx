import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { AgentMascot, type AgentMascotPresence } from './AgentMascot'
import type { AvatarSpec } from '../lib/avatar-spec'

/**
 * CatExpression is the full legacy 40-state mark expression set. Every
 * historic caller string keeps type-checking; each name maps to one of
 * Pip's 10 presences via CAT_TO_PRESENCE (unknown strings → 'idle').
 */
export type CatExpression =
  | 'sleeping'
  | 'waking'
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'searching'
  | 'working'
  | 'excited'
  | 'surprised'
  | 'suspicious'
  | 'angry'
  | 'drowsy'
  | 'happy'
  | 'curious'
  | 'confused'
  | 'bored'
  | 'proud'
  | 'shy'
  | 'sad'
  | 'laughing'
  | 'scared'
  | 'playful'
  | 'celebrate'
  | 'orbit'
  | 'radar'
  | 'progress'
  | 'spawning'
  | 'humming'
  | 'loading'
  | 'dictating'
  | 'writing'
  | 'sending'
  | 'receiving'
  | 'uploading'
  | 'notifying'
  | 'alerting'
  | 'dragging'
  | 'bouncing'
  | 'powering-down'
  | 'error'
export type { FxState, PresenceState } from '../lib/blob-fx'
export type { AgentMascotPresence }

/** Imperative handle: spin / bounce / burst. Pip has no matching motion
 *  clips, so every method is a safe no-op (never fakes motion). */
export interface GrokMarkHandle {
  spin: (n?: number) => void
  bounce: () => void
  burst: () => void
}

/**
 * Legacy head-silhouette names. The product mark is always Pip (owl);
 * every value is accepted and ignored. Kept so stored/transport data
 * and old call sites keep type-checking.
 *
 * @deprecated Pip is the only silhouette; do not set this.
 */
export type GrokOrbShape =
  | 'blob'
  | 'pebble'
  | 'bean'
  | 'egg'
  | 'squircle'
  | 'tablet'
  | 'capsule'
  | 'cylinder'
  | 'hex'
  | 'gem'
  | 'crystal'
  | 'wedge'
  | 'shield'
  | 'dome'
  | 'arch'
  | 'cloud'
  | 'teardrop'
  | 'leaf'
  | 'cat'

/**
 * Retired engine controls. Accepted so saved timelines and old call
 * sites keep type-checking; ignored at render (Pip has no equivalent).
 *
 * @deprecated No effect; do not set.
 */
export interface GrokOrbPose {
  turn?: number
  tilt?: number
  roll?: number
  scale?: number
}

/** @deprecated No effect; do not set. */
export interface GrokOrbFaceTune {
  gap?: number
  height?: number
  size?: number
}

/** @deprecated No effect; do not set. */
export interface GrokOrbInkGradient {
  from: string
  to: string
  angle?: number
  fromPos?: number
  toPos?: number
}

const MAIA_BLUE = '#9ecdff'
const MAIA_NAVY = '#1a3d6b'
/** Maia brand theme: light-blue body accent, navy eyes (eyes unused by Pip). */
const GROK_BODY = '#b7d9ff'
const GROK_EYE = '#1a3d6b'
/** Inner SVG scale when `framed` — ~9% inset each side. */
export const FAT_CAT_FRAME_INNER = 0.82

/**
 * Legacy 40-state → Pip presence map. Cognitive states → thinking,
 * tool/work states → tool, search states → browsing, attention-seeking
 * states → waiting-approval, celebratory states → happy, rest states →
 * sleep; unmatched affect → idle; error → error. Unknown strings → idle.
 */
export const CAT_TO_PRESENCE: Record<CatExpression, AgentMascotPresence> = {
  idle: 'idle',
  waking: 'idle',
  humming: 'idle',
  bored: 'idle',
  shy: 'idle',
  sad: 'idle',
  scared: 'idle',
  angry: 'idle',
  surprised: 'idle',
  thinking: 'thinking',
  listening: 'thinking',
  curious: 'thinking',
  confused: 'thinking',
  suspicious: 'thinking',
  loading: 'thinking',
  searching: 'browsing',
  radar: 'browsing',
  working: 'tool',
  writing: 'tool',
  progress: 'tool',
  spawning: 'tool',
  sending: 'tool',
  receiving: 'tool',
  uploading: 'tool',
  dragging: 'tool',
  dictating: 'talking',
  happy: 'happy',
  excited: 'happy',
  celebrate: 'happy',
  playful: 'happy',
  laughing: 'happy',
  proud: 'happy',
  bouncing: 'happy',
  notifying: 'waiting-approval',
  alerting: 'waiting-approval',
  orbit: 'waiting-approval',
  sleeping: 'sleep',
  drowsy: 'sleep',
  'powering-down': 'sleep',
  error: 'error',
}

const OWL_PRESENCES: readonly AgentMascotPresence[] = [
  'idle', 'thinking', 'tool', 'browsing', 'waiting-approval',
  'talking', 'happy', 'error', 'sleep', 'offline',
]

/** Resolve any legacy expression / presence / blob-fx string to a Pip presence. */
export function catToPresence(value: string | null | undefined): AgentMascotPresence {
  if (!value) return 'idle'
  if ((OWL_PRESENCES as readonly string[]).includes(value)) return value as AgentMascotPresence
  return CAT_TO_PRESENCE[value as CatExpression] ?? 'idle'
}

export interface FatCatIconProps {
  expression?: CatExpression | string
  /**
   * Head silhouette. Product mascots are always Pip (owl) — accepted
   * and ignored.
   *
   * @deprecated No effect; do not set.
   */
  shape?: GrokOrbShape
  size?: number
  className?: string
  title?: string
  /** Disable idle blink / gaze drift / antics. */
  still?: boolean
  /**
   * Modular avatar wiring: bgColor is the EYE fill. Pip has no separate
   * eye color — accepted and ignored. fgColor / avatar.bodyColor drive
   * the accent.
   *
   * @deprecated Eye color is unused; set fgColor / avatar instead.
   */
  bgColor?: string
  /**
   * Accent/body fill (Pip primary). Default matches the legacy nubcat blue.
   */
  fgColor?: string
  /** Modular spec shortcut — explicit fgColor wins for the accent. */
  avatar?: AvatarSpec
  /**
   * Navy rounded chip behind the mark so Pip pops on
   * light glass UIs. Outer chip is `size`; inner is `size*0.82`.
   */
  framed?: boolean
  /**
   * Blob orbit FX — the old engine derived patterns from its state.
   * Pip has no equivalent; accepted and ignored.
   *
   * @deprecated No effect; do not set.
   */
  fx?: 'auto' | null | string
  /** Presence mapping (kept for API compat). */
  presence?: string | null
  /** Pause animation. */
  fxPaused?: boolean
  /** Imperative handle: ref.current.spin() / bounce() / burst() (all no-ops). */
  apiRef?: React.MutableRefObject<GrokMarkHandle | null>
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const read = () => {
      try { return matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return mq.matches }
    }
    const onChange = () => setReduced(read())
    onChange()
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

const NOOP_API: GrokMarkHandle = {
  spin: () => {},
  bounce: () => {},
  burst: () => {},
}

/**
 * Nub Agent mascot — Pip the owl.
 * Legacy 40-state expression API preserved; every state maps to one of
 * Pip's 10 presences (see CAT_TO_PRESENCE).
 */
export const FatCatIcon = memo(function FatCatIcon({
  expression = 'idle',
  shape: _shape = 'cat',
  size = 32,
  className,
  title,
  still = false,
  bgColor: _bgColor,
  fgColor,
  avatar,
  framed = false,
  fx = 'auto',
  presence = null,
  fxPaused = false,
  apiRef,
}: FatCatIconProps) {
  // Eye color (bgColor) has no Pip equivalent and is intentionally dropped.
  const accent = avatar?.bodyColor ?? fgColor ?? GROK_BODY
  const svgSize = framed ? size * FAT_CAT_FRAME_INNER : size

  // Presence wins when the expression is idle, same precedence as before.
  const resolved: AgentMascotPresence =
    expression === 'idle' && presence && presence !== 'idle'
      ? catToPresence(presence)
      : catToPresence(expression)

  const profile = useMemo(
    () => ({ ui_meta: { accent_color: accent } }),
    [accent],
  )

  const mediaReduced = usePrefersReducedMotion()

  useEffect(() => {
    if (apiRef) apiRef.current = NOOP_API
    return () => {
      if (apiRef) apiRef.current = null
    }
  }, [apiRef])

  const cssVars = {
    ['--bg' as string]: GROK_EYE,
    ['--fg' as string]: accent,
  } as CSSProperties

  const mark = (
    <AgentMascot
      agentId="fatcat"
      profile={profile}
      presence={resolved}
      size={svgSize}
      className={framed ? undefined : className}
      title={title}
      reducedMotion={fxPaused || still || mediaReduced}
    />
  )

  if (framed) {
    const radius = Math.max(8, Math.round(size * 0.22))
    const pad = Math.max(0, (size - svgSize) / 2)
    return (
      <span
        className={['inline-flex items-center justify-center', className]
          .filter(Boolean)
          .join(' ')}
        data-framed="true"
        data-expression={expression}
        data-fx={fx ?? 'none'}
        style={{
          width: size,
          height: size,
          padding: pad,
          background: MAIA_NAVY,
          borderRadius: radius,
          boxSizing: 'border-box',
          overflow: 'visible',
          flexShrink: 0,
          lineHeight: 0,
          ...cssVars,
        }}
      >
        {mark}
      </span>
    )
  }

  return mark
})

export type AgentStatusLike = 'running' | 'stopped' | 'provisioning' | 'error' | string

export function statusToExpression(status: AgentStatusLike, opts?: { busy?: boolean }): CatExpression {
  switch (status) {
    case 'running':
      return opts?.busy ? 'working' : 'happy'
    case 'stopped':
      return 'sleeping'
    case 'provisioning':
      return 'curious'
    case 'error':
      return 'error'
    default:
      return 'idle'
  }
}

export { MAIA_BLUE as FAT_CAT_MAIA, MAIA_NAVY as FAT_CAT_NAVY }
