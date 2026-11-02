import { describe, expect, it } from 'vitest'
import { ORB_STAGE_PX, STAGE_PX, STEP_MS, sizeSvg } from '../stage'

describe('export geometry', () => {
  it('STEP_MS is 50 and stage/orb constants match preview', () => {
    expect(STEP_MS).toBe(50)
    expect(STAGE_PX).toBe(540)
    expect(ORB_STAGE_PX).toBe(421)
    expect((ORB_STAGE_PX / STAGE_PX) * 480).toBeCloseTo(374.2, 0)
  })
  it('sizeSvg injects width/height and preserves viewBox', () => {
    const out = sizeSvg('<svg viewBox="0 0 100 100"><circle/></svg>', 480, 480)
    expect(out).toContain('width="480"')
    expect(out).toContain('height="480"')
    expect(out).toContain('viewBox="0 0 100 100"')
  })
  it('sizeSvg never duplicates width attr', () => {
    const once = sizeSvg('<svg viewBox="0 0 1 1"></svg>', 480, 480)
    const twice = sizeSvg(once, 480, 480)
    expect(twice.match(/width="/g)?.length).toBe(1)
  })
  it('sizeSvg stays linear on a whitespace-padded svg tag', () => {
    const started = performance.now()
    const out = sizeSvg(`<svg${' '.repeat(50_000)}viewBox="0 0 1 1" width="9"></svg>`, 480, 480)
    expect(performance.now() - started).toBeLessThan(500)
    expect(out.match(/width="/g)?.length).toBe(1)
  })
})
