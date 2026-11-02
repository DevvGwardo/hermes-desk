import { describe, it, expect } from 'vitest'
import { paintFloorShadow, paintStageOverlays, paintVignette } from '../stage'
import { paintExportFrame } from '../LoopStudio'
import type { Timeline } from '../types'

/** Recording 2d context: every method call captured, gradient geometry kept.
 *  Lets the overlay split prove its numbers without a real canvas. */
const makeCtx = () => {
  const grads: number[][] = []
  const calls: { name: string; args: unknown[] }[] = []
  const sets: { name: string; value: unknown }[] = []
  const ctx = new Proxy({}, {
    get: (_t, p: string | symbol) => {
      if (p === 'createRadialGradient') {
        return (...a: number[]) => {
          grads.push(a)
          return { addColorStop() {} }
        }
      }
      return (...a: unknown[]) => { calls.push({ name: String(p), args: a }) }
    },
    set: (_t, p: string | symbol, v: unknown) => {
      sets.push({ name: String(p), value: v })
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, grads, calls, sets }
}

const EMPTY: Timeline = { orb: [], tricks: [], caps: [], fx: [], bg: '#ffffff' }

describe('stage overlays: split without drift', () => {
  it('floor shadow keeps the classic unit-circle mapping on square stages', () => {
    const { ctx, grads, calls } = makeCtx()
    paintFloorShadow(ctx, 480)
    expect(grads).toEqual([[0, 0, 0, 0, 0, 1]])
    const names = calls.map((c) => c.name)
    expect(names).toEqual(['save', 'translate', 'scale', 'beginPath', 'arc', 'fill', 'restore'])
  })

  it('vignette scales its radii with the rect, not the square', () => {
    const { ctx, grads } = makeCtx()
    paintVignette(ctx, 360, 640)
    expect(grads.length).toBe(1)
    const [x0, y0, r0, x1, y1, r1] = grads[0]
    expect(x0).toBe(180)
    expect(y0).toBe(320)
    expect(r0).toBeCloseTo(360 * 0.42, 9)
    expect(x1).toBe(180)
    expect(y1).toBe(320)
    expect(r1).toBeCloseTo(640 * 0.72, 9)
  })

  it('square vignette matches the legacy numbers exactly', () => {
    const { ctx, grads } = makeCtx()
    paintVignette(ctx, 480)
    const [x0, y0, r0, x1, y1, r1] = grads[0]
    expect([x0, y0, x1, y1]).toEqual([240, 240, 240, 240])
    expect(r0).toBeCloseTo(480 * 0.42, 9)
    expect(r1).toBeCloseTo(480 * 0.72, 9)
  })

  it('paintStageOverlays still paints shadow + vignette (LoopStudio path)', () => {
    const { ctx, grads } = makeCtx()
    paintStageOverlays(ctx, 480)
    expect(grads.length).toBe(2)
  })
})

describe('paintExportFrame: skipVignette', () => {
  it('paints shadow only when set (composer master path)', () => {
    const { ctx, grads } = makeCtx()
    paintExportFrame(ctx, EMPTY, 0, { bgImg: null, orbImg: null, showOrb: false, skipVignette: true })
    expect(grads).toEqual([[0, 0, 0, 0, 0, 1]])
  })

  it('paints shadow + vignette by default (LoopStudio path unchanged)', () => {
    const { ctx, grads } = makeCtx()
    paintExportFrame(ctx, EMPTY, 0, { bgImg: null, orbImg: null, showOrb: false })
    expect(grads.length).toBe(2)
  })

  it('fills per-scene bg changes at the right times', () => {
    const tl: Timeline = {
      ...EMPTY,
      bg: '#ffffff',
      bgChanges: [{ start: 1000, color: '#111111' }],
    }
    const before = makeCtx()
    paintExportFrame(before.ctx, tl, 500, { bgImg: null, orbImg: null, showOrb: false })
    expect(before.sets.map((s) => s.value)).toContain('#ffffff')
    const after = makeCtx()
    paintExportFrame(after.ctx, tl, 1500, { bgImg: null, orbImg: null, showOrb: false })
    expect(after.sets.map((s) => s.value)).toContain('#111111')
  })
})
