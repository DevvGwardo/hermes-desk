import { describe, expect, it } from 'vitest'
import * as m from '../stage'

const f = (m as Record<string, unknown>).screenToStage as
  | ((x: number, y: number, r: { left: number; top: number; width: number }) => { x: number; y: number })
  | undefined

describe('screenToStage', () => {
  if (!f) {
    it.fails('screenToStage pending in ../stage', () => { expect(f).toBeDefined() })
  } else {
    const s = f
    it('origin maps to 0,0', () => { expect(s(10, 20, { left: 10, top: 20, width: 270 })).toEqual({ x: 0, y: 0 }) })
    it('corner/midpoint scale to 540 grid', () => {
      expect(s(280, 290, { left: 10, top: 20, width: 270 })).toEqual({ x: 540, y: 540 })
      expect(s(145, 155, { left: 10, top: 20, width: 270 })).toEqual({ x: 270, y: 270 })
    })
    it('clamps out-of-bounds', () => {
      expect(s(-50, -50, { left: 10, top: 20, width: 270 })).toEqual({ x: 0, y: 0 })
      expect(s(9999, 9999, { left: 10, top: 20, width: 270 })).toEqual({ x: 540, y: 540 })
    })
    it('degenerate width centers', () => {
      expect(s(0, 0, { left: 0, top: 0, width: 0 })).toEqual({ x: 270, y: 270 })
      expect(s(0, 0, { left: 0, top: 0, width: -5 })).toEqual({ x: 270, y: 270 })
    })
    it('respects rect offset', () => { expect(s(110, 70, { left: 100, top: 50, width: 270 })).toEqual({ x: 20, y: 40 }) })
  }
})
