import { describe, expect, it } from 'vitest'
import { capAt, orbAt, propAt, totalDur } from '../types'
import { fxAt } from '../fx'
import { PRESETS } from '../presets'
import { TEMPLATES } from '../templates'

/** Loop Studio forward-loop wrap-seam audit: wrap START (t=150ms, past the
 *  S=3 transient skip at 50ms steps) vs wrap END (t=totalDur-1) must agree on
 *  orb state, fx frame, active caption, and prop set. Behavioral calls only. */

const START = 150

function expectWrapsClean(label: string, build: () => import('../types').Timeline): void {
  const tl = build()
  const end = totalDur(tl) - 1
  // orb state
  expect(orbAt(tl, START), `${label} orb`).toBe(orbAt(tl, end))
  // fx frame
  const a = fxAt(tl, START)
  const b = fxAt(tl, end)
  expect(a.dx, `${label} fx.dx`).toBeCloseTo(b.dx, 6)
  expect(a.dy, `${label} fx.dy`).toBeCloseTo(b.dy, 6)
  expect(a.scale, `${label} fx.scale`).toBeCloseTo(b.scale, 6)
  expect(a.flash, `${label} fx.flash`).toBeCloseTo(b.flash, 6)
  // caption active id/text
  const ca = capAt(tl, START)
  const cb = capAt(tl, end)
  expect(ca?.id ?? null, `${label} cap.id`).toBe(cb?.id ?? null)
  expect(ca?.text ?? null, `${label} cap.text`).toBe(cb?.text ?? null)
  // prop set (ids)
  expect(propAt(tl, START).map((p) => p.id), `${label} props`).toEqual(
    propAt(tl, end).map((p) => p.id),
  )
}

describe('wrap seam: presets', () => {
  for (const p of PRESETS) {
    it(`preset: ${p.name} wraps clean`, () => {
      expectWrapsClean(`preset:${p.name}`, p.build)
    })
  }
})

describe('wrap seam: templates', () => {
  for (const t of TEMPLATES) {
    it(`template: ${t.name} wraps clean`, () => {
      expectWrapsClean(`template:${t.name}`, t.build)
    })
  }
})
