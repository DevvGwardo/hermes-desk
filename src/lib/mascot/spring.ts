import type { SpringSpec } from './types'

export interface Spring { value: number; velocity: number; target: number }
export const DEFAULT_SPRING: SpringSpec = { stiffness: 170, damping: 2 * Math.sqrt(170) }
export const spring = (value: number): Spring => ({ value, target: value, velocity: 0 })

/** Exact unit-mass solution, stable at low fps and for under/over-damped parts. */
export function stepSpring(s: Spring, dt: number, spec = DEFAULT_SPRING): number {
  if (dt <= 0) return s.value
  const k = Math.max(0.01, spec.stiffness)
  const c = Math.max(0, spec.damping ?? 2 * Math.sqrt(k))
  const w = Math.sqrt(k)
  const z = c / (2 * w)
  const x = s.value - s.target
  const v = s.velocity
  let next: number
  let velocity: number
  if (Math.abs(z - 1) < 0.0001) {
    const b = v + w * x
    const e = Math.exp(-w * dt)
    next = (x + b * dt) * e
    velocity = (v - w * b * dt) * e
  } else if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z)
    const a = z * w
    const b = (v + a * x) / wd
    const e = Math.exp(-a * dt)
    const cos = Math.cos(wd * dt)
    const sin = Math.sin(wd * dt)
    next = e * (x * cos + b * sin)
    velocity = e * ((b * wd - a * x) * cos - (x * wd + a * b) * sin)
  } else {
    const d = Math.sqrt(c * c - 4 * k)
    const r1 = (-c + d) / 2
    const r2 = (-c - d) / 2
    const a = (v - r2 * x) / (r1 - r2)
    const b = x - a
    next = a * Math.exp(r1 * dt) + b * Math.exp(r2 * dt)
    velocity = a * r1 * Math.exp(r1 * dt) + b * r2 * Math.exp(r2 * dt)
  }
  s.value = s.target + next
  s.velocity = velocity
  if (Math.abs(next) < 0.00001 && Math.abs(velocity) < 0.00001) {
    s.value = s.target
    s.velocity = 0
  }
  return s.value
}
