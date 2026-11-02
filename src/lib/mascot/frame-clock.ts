import type { FrameClock } from './types'

export interface ClockDriver {
  now(): number
  request(callback: (now: number) => void): number
  cancel(id: number): void
}
export interface FrameStats {
  frames: number
  subscribers: number
  fps: number
  meanMs: number
  p95Ms: number
  maxMs: number
}

/** One page-wide rAF, stopped completely when no visible instances remain. */
export class SharedFrameClock implements FrameClock {
  private listeners = new Set<(time: number) => void>()
  private raf: number | null = null
  private samples: number[] = []
  private frames = 0
  private first: number | null = null
  private last = 0
  private driver: ClockDriver
  constructor(driver: ClockDriver) { this.driver = driver }
  now = () => this.driver.now()
  subscribe(callback: (time: number) => void): () => void {
    this.listeners.add(callback)
    if (this.raf === null) this.raf = this.driver.request(this.tick)
    return () => {
      this.listeners.delete(callback)
      if (!this.listeners.size && this.raf !== null) {
        this.driver.cancel(this.raf)
        this.raf = null
      }
    }
  }
  private tick = (now: number) => {
    this.raf = null
    const start = this.driver.now()
    for (const callback of this.listeners) callback(now)
    this.samples.push(Math.max(0, this.driver.now() - start))
    if (this.samples.length > 600) this.samples.shift()
    this.frames++
    this.first ??= now
    this.last = now
    if (this.listeners.size && this.raf === null) this.raf = this.driver.request(this.tick)
  }
  resetStats() { this.samples = []; this.frames = 0; this.first = null; this.last = 0 }
  stats(): FrameStats {
    const sorted = [...this.samples].sort((a, b) => a - b)
    return {
      frames: this.frames, subscribers: this.listeners.size,
      fps: this.first !== null && this.last > this.first ? (this.frames - 1) * 1000 / (this.last - this.first) : 0,
      meanMs: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
      p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
      maxMs: sorted.at(-1) ?? 0,
    }
  }
}

export const mascotFrameClock = new SharedFrameClock({
  now: () => performance.now(),
  request: callback => requestAnimationFrame(callback),
  cancel: id => cancelAnimationFrame(id),
})

/** Test/screenshot clock, advance explicitly. No timers, no visible browser. */
export class ManualFrameClock implements FrameClock {
  private time = 0
  private callbacks = new Set<(time: number) => void>()
  now = () => this.time
  subscribe(callback: (time: number) => void) {
    this.callbacks.add(callback)
    return () => { this.callbacks.delete(callback) }
  }
  advance(ms: number, stepMs = 1000 / 60) {
    if (ms < 0 || stepMs <= 0) throw new Error('Clock must advance with a positive step')
    const end = this.time + ms
    while (this.time < end) {
      this.time = Math.min(end, this.time + stepMs)
      for (const callback of this.callbacks) callback(this.time)
    }
  }
  get subscribers() { return this.callbacks.size }
}
