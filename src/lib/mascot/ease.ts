import type { EaseName } from './types'

export type Ease = (u: number) => number
const c1 = 1.70158
const c2 = c1 * 1.525
const c3 = c1 + 1

function bounce(u: number): number {
  const n = 7.5625
  const d = 2.75
  if (u < 1 / d) return n * u * u
  if (u < 2 / d) return n * (u -= 1.5 / d) * u + 0.75
  if (u < 2.5 / d) return n * (u -= 2.25 / d) * u + 0.9375
  return n * (u -= 2.625 / d) * u + 0.984375
}

const named: Record<string, Ease> = {
  linear: u => u,
  step: u => (u < 1 ? 0 : 1),
  inSine: u => 1 - Math.cos(u * Math.PI / 2),
  outSine: u => Math.sin(u * Math.PI / 2),
  inOutSine: u => -(Math.cos(Math.PI * u) - 1) / 2,
  inQuad: u => u * u,
  outQuad: u => 1 - (1 - u) * (1 - u),
  inOutQuad: u => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2),
  inCubic: u => u ** 3,
  outCubic: u => 1 - (1 - u) ** 3,
  inOutCubic: u => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2),
  inBack: u => c3 * u ** 3 - c1 * u * u,
  outBack: u => 1 + c3 * (u - 1) ** 3 + c1 * (u - 1) ** 2,
  inOutBack: u => (u < 0.5
    ? ((2 * u) ** 2 * ((c2 + 1) * 2 * u - c2)) / 2
    : ((2 * u - 2) ** 2 * ((c2 + 1) * (u * 2 - 2) + c2) + 2) / 2),
  outElastic: u => (u <= 0 ? 0 : u >= 1 ? 1 : 2 ** (-10 * u) * Math.sin((u * 10 - 0.75) * (2 * Math.PI) / 3) + 1),
  outBounce: bounce,
}

/** Unit step response of a damped spring, squeezed into [0, 1] so it always lands exactly. */
function springEase(k: number, d: number): Ease {
  const w = Math.sqrt(Math.max(1, k))
  const z = Math.max(0.05, d / (2 * w))
  // Normalise time so the envelope has decayed to ~1% by u = 1.
  const span = Math.min(12, 4.6 / (z * w)) * w
  return u => {
    if (u <= 0) return 0
    if (u >= 1) return 1
    const t = u * span / w
    let x: number
    if (z < 1) {
      const wd = w * Math.sqrt(1 - z * z)
      x = 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t))
    } else x = 1 - Math.exp(-w * t) * (1 + w * t)
    // Blend the residual away over the last 10% so the segment ends on its key.
    return u > 0.9 ? x + (1 - x) * ((u - 0.9) / 0.1) : x
  }
}

const cache = new Map<string, Ease>()
export function ease(name: EaseName | undefined): Ease {
  if (!name) return named.inOutSine
  const hit = named[name] ?? cache.get(name)
  if (hit) return hit
  const match = /^spring\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(name)
  const fn = match ? springEase(Number(match[1]), Number(match[2])) : named.inOutSine
  cache.set(name, fn)
  return fn
}
export const EASE_NAMES = Object.keys(named)
