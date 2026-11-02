import { describe, expect, it } from 'vitest'
import * as m from '../stage'
const f: any = (m as any).bgFitRect
if (!f) describe('bgFitRect (pending)', () => { it.fails('bgFitRect not yet implemented', () => { expect(f).toBeDefined() }) })
else {
describe('bgFitRect', () => {
it('cover on wide crops x, full-bleed 540', () => { const r = f(800,400,540,540,'cover'); expect(r.sx).toBeGreaterThan(0); expect(r.sw).toBeLessThan(800); expect([r.dx,r.dy,r.dw,r.dh]).toEqual([0,0,540,540]) })
it('contain on wide letterboxes', () => { const r = f(800,400,540,540,'contain'); expect(r.sw).toBe(800); expect(r.dy).toBeGreaterThan(0); expect(r.dh).toBeLessThan(540); expect(r.dw).toBe(540) })
it('stretch maps full to full', () => { const r = f(800,400,540,540,'stretch'); expect([r.sx,r.dx,r.dw]).toEqual([0,0,540]); expect(r.dh).toBe(540) })
it('square-on-square identity-ish', () => { const r = f(500,500,540,540,'cover'); expect([r.sx,r.dx]).toEqual([0,0]) })
it('degenerate imgW=0 falls back full dst', () => { const r = f(0,400,540,540,'cover'); expect([r.dw,r.dh]).toEqual([540,540]) })
})
}
