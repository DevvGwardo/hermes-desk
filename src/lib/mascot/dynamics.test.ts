import { describe, expect, it } from 'vitest'
import { BlinkScheduler, IdleFidgets, oscillate, seededRandom } from './behaviors'
import { spring, stepSpring } from './spring'

describe('spring solver', () => {
  it.each([undefined, 8, 26.0768, 45])('converges at 20fps with damping %s', damping => {
    const s = spring(0)
    s.target = 15
    for (let i = 0; i < 200; i++) stepSpring(s, 0.05, { stiffness: 170, damping })
    expect(s.value).toBeCloseTo(15, 4)
    expect(s.velocity).toBeCloseTo(0, 4)
  })
  it('is independent of integration step size and critical by default', () => {
    const a = spring(0)
    const b = spring(0)
    a.target = b.target = 1
    stepSpring(a, 0.5)
    for (let i = 0; i < 30; i++) stepSpring(b, 1 / 60)
    expect(a.value).toBeCloseTo(b.value, 10)
    expect(a.value).toBeLessThan(1)
    expect(a.value).toBeGreaterThan(0.98)
  })
})

describe('procedural schedules', () => {
  it('blinks at the same scheduled time regardless of sampling rate', () => {
    const a = new BlinkScheduler(seededRandom('same'))
    const b = new BlinkScheduler(seededRandom('same'))
    for (let i = 0; i < 1000; i++) a.sample(i / 60)
    b.sample(999 / 60)
    expect(a.next).toBe(b.next)
    expect(a.sample(a.next + 0.065)).toBeCloseTo(1)
    expect(a.sample(a.next + 0.18)).toBe(0)
  })
  it('RNG streams are seeded and fidgets only occur every 8–20 seconds', () => {
    const a = seededRandom(9)
    const b = seededRandom(9)
    expect(Array.from({ length: 20 }, a)).toEqual(Array.from({ length: 20 }, b))
    const fidget = new IdleFidgets(seededRandom(9))
    for (let t = 0; t < 8; t += 0.1) expect(fidget.sample(t)).toBe(0)
    expect(Array.from({ length: 130 }, (_, i) => fidget.sample(8 + i / 10)).some(n => Math.abs(n) > 0.1)).toBe(true)
  })
  it('oscillators use Hz and radians with stable absolute phase', () => {
    expect(oscillate({ part: 'head', prop: 'rotate', amp: 10, freq: 1 }, 0.25)).toBe(10)
    expect(oscillate({ part: 'head', prop: 'rotate', amp: 10, freq: 0, phase: Math.PI / 2 }, 500)).toBe(10)
  })
})
