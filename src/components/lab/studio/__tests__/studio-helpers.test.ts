import { describe, expect, it } from 'vitest'
import { bgAt, capAt, hslToHex, isTimeline, orbAt, totalDur, type Timeline } from '../types'
import * as typesMod from '../types'
import { BEAT, fxAt } from '../fx'
import { PRESETS } from '../presets'

/** Minimal timeline builder so tests pin behavior, not fixtures. */
const blank = (over: Partial<Timeline> = {}): Timeline => ({
  orb: [],
  tricks: [],
  caps: [],
  fx: [],
  bg: '#ffffff',
  ...over,
})

describe('types: orbAt', () => {
  it('last segment wins on overlap', () => {
    const tl = blank({
      orb: [
        { id: 'a', start: 0, dur: 1000, state: 'idle' },
        { id: 'b', start: 500, dur: 1000, state: 'happy' },
      ],
    })
    expect(orbAt(tl, 250)).toBe('idle')
    expect(orbAt(tl, 750)).toBe('happy')
    expect(orbAt(tl, 1250)).toBe('happy')
  })

  it('defaults to idle on an empty timeline', () => {
    expect(orbAt(blank(), 0)).toBe('idle')
    expect(orbAt(blank(), 9999)).toBe('idle')
  })

  it('past the end holds the FIRST state (settle tail lands on opening pose)', () => {
    const tl = blank({
      orb: [
        { id: 'a', start: 0, dur: 500, state: 'thinking' },
        { id: 'b', start: 500, dur: 500, state: 'happy' },
      ],
    })
    expect(orbAt(tl, 1000)).toBe('thinking')
    expect(orbAt(tl, 60_000)).toBe('thinking')
  })

  it('evil input: negative t falls back to the first state', () => {
    const tl = blank({ orb: [{ id: 'a', start: 0, dur: 500, state: 'sleeping' }] })
    expect(orbAt(tl, -1)).toBe('sleeping')
    expect(orbAt(tl, -60_000)).toBe('sleeping')
  })

  it('segments are half-open [start, start+dur)', () => {
    const tl = blank({
      orb: [
        { id: 'a', start: 0, dur: 500, state: 'idle' },
        { id: 'b', start: 500, dur: 500, state: 'excited' },
      ],
    })
    expect(orbAt(tl, 499)).toBe('idle')
    expect(orbAt(tl, 500)).toBe('excited')
  })

  it('zero-duration segments never match', () => {
    const tl = blank({
      orb: [
        { id: 'a', start: 0, dur: 1000, state: 'idle' },
        { id: 'z', start: 500, dur: 0, state: 'angry' },
      ],
    })
    expect(orbAt(tl, 500)).toBe('idle')
  })
})

describe('types: capAt', () => {
  it('last caption wins on overlap, null when empty', () => {
    expect(capAt(blank(), 100)).toBeNull()
    const tl = blank({
      caps: [
        { id: 'a', start: 0, dur: 1000, text: 'first', sub: '', mode: 'bubble' },
        { id: 'b', start: 500, dur: 1000, text: 'second', sub: '', mode: 'pop' },
      ],
    })
    expect(capAt(tl, 250)?.text).toBe('first')
    expect(capAt(tl, 750)?.text).toBe('second')
    expect(capAt(tl, 5000)).toBeNull()
  })
})

describe('types: hslToHex', () => {
  it('returns valid six-digit hex colors for native color inputs', () => {
    expect(hslToHex(0, 1, 0.5)).toBe('#ff0000')
    expect(hslToHex(120, 1, 0.5)).toBe('#00ff00')
    expect(hslToHex(480, 1, 0.5)).toBe('#00ff00')
  })
})

describe('types: isTimeline', () => {
  it('accepts a valid minimal timeline', () => {
    expect(isTimeline(blank())).toBe(true)
  })

  it('rejects malformed imported data before render', () => {
    expect(isTimeline({ orb: [], caps: [], fx: [], tricks: [] })).toBe(false)
    expect(isTimeline({ ...blank(), orb: [{ id: 'x', start: '0', dur: 1, state: 'idle' }] })).toBe(false)
    expect(isTimeline({ ...blank(), orb: [{ id: 'x', start: 0, dur: 0, state: 'idle' }] })).toBe(false)
    expect(isTimeline({ ...blank(), caps: [{ id: 'x', start: 0, dur: 1, text: 'ok', sub: '', mode: 'bad' }] })).toBe(false)
  })
})

describe('types: totalDur', () => {
  it('is 0 for an empty timeline', () => {
    expect(totalDur(blank())).toBe(0)
  })

  it('takes the max end across orb / tricks / caps / fx', () => {
    const tl = blank({
      orb: [{ id: 'a', start: 0, dur: 1000, state: 'idle' }],
      tricks: [{ id: 't', t: 200, trick: 'spin' }],
      caps: [{ id: 'c', start: 0, dur: 800, text: 'x', sub: '', mode: 'bar' }],
      fx: [{ id: 'f', start: 100, dur: 1400, kind: 'pulse', amount: 0.5 }],
    })
    expect(totalDur(tl)).toBe(1500)
  })
})

describe('fx: fxAt envelopes', () => {
  it('shake adds nonzero dx/dy with intensity, zero when amount is 0', () => {
    const tl = blank({ fx: [{ id: 'f', start: 0, dur: 2000, kind: 'shake', amount: 1 }] })
    let moved = 0
    for (let t = 0; t < 500; t += 17) {
      const f = fxAt(tl, t)
      if (Math.abs(f.dx) + Math.abs(f.dy) > 0.5) moved++
    }
    expect(moved).toBeGreaterThan(20)
    const flat = blank({ fx: [{ id: 'f', start: 0, dur: 2000, kind: 'shake', amount: 0 }] })
    expect(fxAt(flat, 100)).toMatchObject({ dx: 0, dy: 0 })
  })

  it('zoom peaks near 1.12 then settles to 1 by 450ms', () => {
    const tl = blank({ fx: [{ id: 'f', start: 1000, dur: 600, kind: 'zoom', amount: 1 }] })
    let peak = 1
    for (let t = 1000; t < 1450; t += 5) peak = Math.max(peak, fxAt(tl, t).scale)
    expect(peak).toBeGreaterThan(1.1)
    expect(peak).toBeLessThan(1.15)
    expect(fxAt(tl, 1000 + 450).scale).toBeCloseTo(1, 5)
    expect(fxAt(tl, 1000 + 500).scale).toBeCloseTo(1, 5)
  })

  it('flash decays to 0 by 150ms', () => {
    const tl = blank({ fx: [{ id: 'f', start: 0, dur: 400, kind: 'flash', amount: 1 }] })
    const at0 = fxAt(tl, 0).flash
    expect(at0).toBeGreaterThan(0.5)
    expect(fxAt(tl, 75).flash).toBeLessThan(at0)
    expect(fxAt(tl, 150).flash).toBe(0)
    expect(fxAt(tl, 300).flash).toBe(0)
  })

  it('pulse oscillates within ±3% on a ~1.2s period', () => {
    const tl = blank({ fx: [{ id: 'f', start: 0, dur: 2400, kind: 'pulse', amount: 1 }] })
    let lo = Infinity
    let hi = -Infinity
    for (let t = 0; t < 1200; t += 10) {
      const s = fxAt(tl, t).scale
      lo = Math.min(lo, s)
      hi = Math.max(hi, s)
    }
    expect(hi).toBeGreaterThan(1)
    expect(lo).toBeLessThan(1)
    expect(hi).toBeCloseTo(1.03, 2)
    expect(lo).toBeCloseTo(0.97, 2)
  })

  it('empty fx track is the identity frame', () => {
    expect(fxAt(blank(), 123)).toEqual({ dx: 0, dy: 0, scale: 1, flash: 0 })
  })
})

describe('presets: loop + beat grid', () => {
  it('BEAT grid is 500ms (120bpm)', () => {
    expect(BEAT).toBe(500)
  })

  it('every preset builds a non-empty timeline with positive duration', () => {
    for (const p of PRESETS) {
      const tl = p.build()
      expect(tl.orb.length, p.name).toBeGreaterThan(0)
      expect(totalDur(tl), p.name).toBeGreaterThan(0)
    }
  })

  it.each(['low-effort loop', 'brainrot burst'])('%s loops clean: orbAt(totalDur-1) == opening pose', (name) => {
    const tl = PRESETS.find((p) => p.name === name)!.build()
    expect(orbAt(tl, totalDur(tl) - 1)).toBe(tl.orb[0].state)
  })

  // Fixed: tail settle segs land all presets back on the opening pose.
  it.each(['velocity pop', 'smooth cinematic', 'hormozi hook'])(
    '%s loops clean: orbAt(totalDur-1) == opening pose',
    (name) => {
      const tl = PRESETS.find((p) => p.name === name)!.build()
      expect(orbAt(tl, totalDur(tl) - 1)).toBe(tl.orb[0].state)
    },
  )

  it('all presets except brainrot start fx on the 500ms beat grid', () => {
    for (const p of PRESETS) {
      if (p.name === 'brainrot burst') continue
      for (const f of p.build().fx) expect(f.start % BEAT, `${p.name}@${f.start}`).toBe(0)
    }
  })

  // Fixed: brainrot burst fx snapped to the 500ms grid.
  it('brainrot burst starts fx on the 500ms beat grid', () => {
    const tl = PRESETS.find((p) => p.name === 'brainrot burst')!.build()
    for (const f of tl.fx) expect(f.start % BEAT).toBe(0)
  })
})

describe('gap: no move/nudge/snap helper yet (RED proof)', () => {
  it('honestly has no move/nudge/snap helper on the types module', () => {
    const m = typesMod as unknown as Record<string, unknown>
    expect(m.moveOrbSeg).toBeUndefined()
    expect(m.nudgeSeg).toBeUndefined()
    expect(m.snapToBeat).toBeUndefined()
  })

  // RED proof: the day a beat-snap helper lands, this test flips green and
  // forces the author to convert it to a real passing test. Evil inputs:
  // negative t clamps to 0, mid-beat rounds, huge t stays grid-aligned.
  it.fails('snapToBeat quantizes evil inputs onto the 500ms grid', () => {
    const snap = (typesMod as unknown as { snapToBeat: (t: number) => number }).snapToBeat
    expect(snap(-1)).toBe(0)
    expect(snap(749)).toBe(500)
    expect(snap(750)).toBe(1000)
    expect(snap(1_000_000)).toBe(1_000_000)
  })
})

describe('types: bgAt', () => {
  it('returns the flat bg with no changes (legacy timelines)', () => {
    expect(bgAt(blank(), 0)).toBe('#ffffff')
    expect(bgAt(blank(), 99999)).toBe('#ffffff')
  })

  it('last change at or before t wins', () => {
    const tl = blank({ bgChanges: [{ start: 1000, color: '#111111' }, { start: 3000, color: '#222222' }] })
    expect(bgAt(tl, 0)).toBe('#ffffff')
    expect(bgAt(tl, 999)).toBe('#ffffff')
    expect(bgAt(tl, 1000)).toBe('#111111')
    expect(bgAt(tl, 2999)).toBe('#111111')
    expect(bgAt(tl, 3000)).toBe('#222222')
    expect(bgAt(tl, 99999)).toBe('#222222')
  })

  it('isTimeline stays load-safe with bgChanges present', () => {
    expect(isTimeline(blank({ bgChanges: [{ start: 0, color: '#000000' }] }))).toBe(true)
  })
})
