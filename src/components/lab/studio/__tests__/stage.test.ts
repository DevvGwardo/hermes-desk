import { describe, expect, it } from 'vitest'
import * as m from '../stage'

describe('stage helpers', () => {
  it('formatTimecode pins m:ss.t + clamps evil', () => {
    expect(m.formatTimecode(0)).toBe('0:00.0')
    expect(m.formatTimecode(62500)).toBe('1:02.5')
    expect(m.formatTimecode(-5)).toBe('0:00.0')
    expect(m.formatTimecode(NaN)).toBe('0:00.0')
    expect(m.formatTimecode(3_600_000)).toBe('60:00.0')
  })
  it('beatPercent stays 0..100, dur<=0 -> 0', () => {
    expect(m.beatPercent(500, 1000)).toBe(50)
    expect([m.beatPercent(2000, 1000), m.beatPercent(-1, 1000)]).toEqual([100, 0])
    expect([m.beatPercent(500, 0), m.beatPercent(500, -3), m.beatPercent(NaN, 1000)]).toEqual([0, 0, 0])
  })
  it('quantizeHead rounds to 100ms grid', () => {
    expect([m.quantizeHead(149), m.quantizeHead(150), m.quantizeHead(-40)]).toEqual([100, 200, 0])
    expect(m.quantizeHead(1_000_050)).toBe(1_000_000)
  })
  it('ORBSHADOW/VIGNETTE const shapes', () => {
    expect(m.ORBSHADOW).toMatchObject({ rx: expect.any(Number), ry: expect.any(Number), alpha: expect.any(Number) })
    expect(m.VIGNETTE).toMatchObject({ alpha: expect.any(Number) })
  })
})
