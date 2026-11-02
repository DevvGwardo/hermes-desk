import type { FxSeg, Timeline } from './types'

/** Post-FX envelopes. Every fn is pure in (timelineMs) — preview applies
 *  them as CSS transforms on the stage wrapper, canvas export applies the
 *  same math via ctx transforms. Keep them in sync by construction: both
 *  call these helpers. Units are 540-stage px / unitless scale / 0..1 alpha.
 *
 *  Conventions from short-form research: shake ~25-30Hz jitter at 4-8px,
 *  zoom punches 1.08-1.15 settling in ~400ms on beat hits, flashes decay
 *  inside 150ms, ambient pulse ±3% on ~1.2s period. 120bpm beat grid. */

export const BEAT = 500 // 120bpm grid, ms

const active = (tl: Timeline, t: number): FxSeg[] =>
  tl.fx.filter((f) => t >= f.start && t < f.start + f.dur)

/** easeOutBack for punch-in overshoot. */
const back = (x: number): number => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2)

export interface FxFrame {
  dx: number
  dy: number
  scale: number
  flash: number // white overlay alpha 0..1
}

/** combined transform at timeline time t. Memoized on 1ms-quantized t per
 *  timeline identity — preview CSS and canvas export share it, so parity
 *  holds by construction and identical frames skip recompute. */
const atMemo = new WeakMap<Timeline, Map<number, FxFrame>>()
export function fxAt(tl: Timeline, t: number): FxFrame {
  const q = Math.round(t)
  let m = atMemo.get(tl)
  if (!m) { m = new Map(); atMemo.set(tl, m) }
  else {
    const hit = m.get(q)
    if (hit) return hit
  }
  if (m.size > 10000) m.clear()
  t = q
  let dx = 0, dy = 0, scale = 1, flash = 0
  for (const f of active(tl, t)) {
    const local = t - f.start
    const a = f.amount
    switch (f.kind) {
      case 'shake': {
        const w = 2 * Math.PI * 27
        const e = 7 * a
        dx += Math.sin((t / 1000) * w) * e + Math.sin((t / 1000) * w * 1.7 + 1.3) * e * 0.5
        dy += Math.cos((t / 1000) * w * 1.3 + 0.5) * e
        break
      }
      case 'zoom': {
        // punch to 1+0.12a in 120ms with overshoot, ease back by 450ms
        const peak = 120, settle = 450
        if (local < peak) scale *= 1 + 0.12 * a * back(local / peak)
        else if (local < settle) {
          const k = (local - peak) / (settle - peak)
          scale *= 1 + 0.12 * a * (1 - k) * (1 - k)
        }
        break
      }
      case 'flash': {
        const d = 150
        if (local < d) flash = Math.max(flash, 0.7 * a * (1 - local / d))
        break
      }
      case 'pulse': {
        scale *= 1 + 0.03 * a * Math.sin((2 * Math.PI * t) / 1200)
        break
      }
    }
  }
  const out = { dx, dy, scale, flash: Math.min(1, flash) }
  m.set(q, out)
  return out
}

/** css transform string for the preview orb wrapper. Memoized like fxAt so
 *  identical quantized instants return identical strings and React's style
 *  diff skips the DOM write. */
const cssMemo = new WeakMap<Timeline, Map<number, { transform: string; flash: number }>>()
export function fxCss(tl: Timeline, t: number): { transform: string; flash: number } {
  const q = Math.round(t)
  let m = cssMemo.get(tl)
  if (!m) { m = new Map(); cssMemo.set(tl, m) }
  else {
    const hit = m.get(q)
    if (hit) return hit
  }
  if (m.size > 10000) m.clear()
  const out = cssFrom(fxAt(tl, q))
  m.set(q, out)
  return out
}

function cssFrom(f: FxFrame): { transform: string; flash: number } {
  return {
    transform: `translate(${f.dx.toFixed(2)}px, ${f.dy.toFixed(2)}px) scale(${f.scale.toFixed(4)})`,
    flash: f.flash,
  }
}
