import type { EyeSpec, Oscillator } from './types'

export function seededRandom(seed: number | string = 1): () => number {
  let state = typeof seed === 'number' ? seed >>> 0 : 2166136261
  if (typeof seed === 'string') {
    for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let n = state
    n = Math.imul(n ^ (n >>> 15), n | 1)
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296
  }
}
export const between = (rng: () => number, a: number, b: number) => a + rng() * (b - a)
export const oscillate = (osc: Oscillator, seconds: number) =>
  osc.amp * Math.sin(2 * Math.PI * osc.freq * seconds + (osc.phase ?? 0))

export class BlinkScheduler {
  next: number
  private range: [number, number]
  private rng: () => number
  constructor(rng: () => number, range: [number, number] = [2.5, 6], now = 0) {
    this.rng = rng
    this.range = range
    this.next = now + this.interval()
  }
  private interval() {
    const lo = Math.max(0.3, this.range[0])
    return between(this.rng, lo, Math.max(lo, this.range[1]))
  }
  setRange(range: [number, number], now: number) {
    this.range = range
    this.next = now + this.interval()
  }
  /** Closure 0..1. Catch up by scheduled times, never by frame cadence. */
  sample(now: number): number {
    while (now >= this.next + 0.18) this.next += 0.18 + this.interval()
    const t = now - this.next
    if (t < 0) return 0
    return t < 0.065 ? t / 0.065 : Math.max(0, 1 - (t - 0.065) / 0.115)
  }
}

export class GazeScheduler {
  private next = 0
  private wander: [number, number] = [0, 0]
  private micro: [number, number] = [0, 0]
  private rng: () => number
  constructor(rng: () => number) { this.rng = rng }
  sample(time: number, eyes?: EyeSpec): [number, number] {
    while (time >= this.next) {
      this.wander = [between(this.rng, -10, 10), between(this.rng, -6, 6)]
      this.micro = [between(this.rng, -0.9, 0.9), between(this.rng, -0.6, 0.6)]
      this.next += between(this.rng, 0.8, 2.8)
    }
    const directions: Record<string, [number, number]> = {
      center: [0, 0], cursor: [0, 0], down: [0, 8], up: [0, -8],
      'up-left': [-9, -7], 'up-right': [9, -7], left: [-10, 0], right: [10, 0],
    }
    const target = eyes?.look === 'wander' ? this.wander : directions[eyes?.look ?? 'center'] ?? [0, 0]
    return [target[0] + this.micro[0], target[1] + this.micro[1]]
  }
}

export class IdleFidgets {
  private next: number
  private start = -Infinity
  private tilt = 0
  private rng: () => number
  constructor(rng: () => number) { this.rng = rng; this.next = between(rng, 8, 20) }
  sample(time: number): number {
    while (time >= this.next) {
      this.start = this.next
      this.tilt = between(this.rng, -4, 4)
      this.next += between(this.rng, 8, 20)
    }
    const progress = (time - this.start) / 1.2
    return progress >= 0 && progress < 1 ? this.tilt * Math.sin(progress * Math.PI) ** 2 : 0
  }
}

/** Default autonomous idle acts (motion v2 §4). Characters override via motion.json `behaviors`. */
export const DEFAULT_BEHAVIORS: Record<string, number> = {
  'head-swivel': 3, preen: 2, stretch: 1.4, 'shake-off': 1.2, hop: 2.2, walk: 1.6,
  peek: 1, 'blink-double': 3, hoot: 1.4, look: 3,
}
const DROWSY_BIAS: Record<string, number> = { stretch: 3.5, 'blink-double': 2, hop: 0.25, walk: 0.3, hoot: 0.4, 'shake-off': 0.5 }
export const isDrowsy = (date: Date) => date.getHours() >= 23 || date.getHours() < 5

/** Weighted, seeded idle-act scheduler. The engine decides when acting is allowed. */
export class AutonomousBehaviors {
  next: number
  private rng: () => number
  private rate: number
  private weights: Record<string, number>
  constructor(rng: () => number, weights: Record<string, number> = DEFAULT_BEHAVIORS, rate = 1, now = 0) {
    this.rng = rng
    this.weights = weights
    this.rate = Math.max(0.05, rate)
    // Stagger the first act so a roster of mascots never moves in unison.
    this.next = now + between(rng, 2.5, 9) / this.rate
  }
  private interval() { return between(this.rng, 6, 16) / this.rate }
  /** Returns the act to perform when one is due, else null. `available` filters to playable acts. */
  sample(time: number, available: (name: string) => boolean, drowsy = false): string | null {
    if (time < this.next) return null
    this.next = time + this.interval() * (drowsy ? 1.6 : 1)
    const options = Object.entries(this.weights)
      .filter(([name, weight]) => weight > 0 && available(name))
      .map(([name, weight]) => [name, weight * (drowsy ? DROWSY_BIAS[name] ?? 1 : 1)] as const)
    const total = options.reduce((sum, [, weight]) => sum + weight, 0)
    if (!total) return null
    let pick = this.rng() * total
    for (const [name, weight] of options) if ((pick -= weight) <= 0) return name
    return options.at(-1)![0]
  }
  /** Postpone the next act, e.g. after a reaction or state change. */
  defer(time: number, seconds = 4) { this.next = Math.max(this.next, time + seconds) }
}
