import { describe, expect, it } from 'vitest'
import { mapSightPoint, seeErrorCopy, sightInfo, SIGHT_MAX_AGE_MS, type HudCapture } from '../hud-sight'
import { hudSightNote, withHudMarkerNote, HUD_MARKER_NOTE } from '../hud-protocol'

const NOW = 1_000_000

function cap(over: Partial<HudCapture['geometry']> = {}, capturedAt = NOW): HudCapture {
  return {
    dataUrl: 'data:image/jpeg;base64,AAAA',
    mode: 'screen',
    capturedAt,
    geometry: { x: -1440, y: 0, width: 1440, height: 900, imageWidth: 1568, imageHeight: 980, ...over },
  }
}

describe('mapSightPoint — screenshot pixels → screen points', () => {
  it('scales and offsets into global points (secondary display on the left)', () => {
    expect(mapSightPoint(cap(), 0, 0, NOW)).toEqual({ x: -1440, y: 0 })
    expect(mapSightPoint(cap(), 784, 490, NOW)).toEqual({ x: -720, y: 450 })
    expect(mapSightPoint(cap(), 1568, 980, NOW)).toEqual({ x: 0, y: 900 })
  })

  it('a region maps inside the region only', () => {
    const region = cap({ x: 200, y: 100, width: 300, height: 200, imageWidth: 600, imageHeight: 400 })
    expect(mapSightPoint(region, 300, 200, NOW)).toEqual({ x: 350, y: 200 })
  })

  it('refuses points outside the image instead of clamping them', () => {
    expect(mapSightPoint(cap(), -1, 10, NOW)).toBeNull()
    expect(mapSightPoint(cap(), 10, 981, NOW)).toBeNull()
    expect(mapSightPoint(cap(), 1569, 10, NOW)).toBeNull()
  })

  it('refuses a stale capture — the screen has moved on', () => {
    expect(mapSightPoint(cap({}, NOW - SIGHT_MAX_AGE_MS - 1), 10, 10, NOW)).toBeNull()
    expect(mapSightPoint(cap({}, NOW - SIGHT_MAX_AGE_MS), 10, 10, NOW)).not.toBeNull()
  })

  it('refuses malformed input', () => {
    expect(mapSightPoint(null, 1, 1, NOW)).toBeNull()
    expect(mapSightPoint(cap({ imageWidth: 0 }), 1, 1, NOW)).toBeNull()
    expect(mapSightPoint(cap(), Number.NaN, 1, NOW)).toBeNull()
  })
})

describe('the sight note tells the model which pixel space to answer in', () => {
  it('states the exact image size and bounds', () => {
    const note = hudSightNote(sightInfo(cap()))
    expect(note).toContain('1568×980')
    expect(note).toContain('0–1567')
    expect(note).toContain('0–979')
  })

  it('rides after the marker note only when a screenshot is attached', () => {
    const withSight = withHudMarkerNote('click save', true, { imageWidth: 800, imageHeight: 600, mode: 'region' })
    expect(withSight.startsWith(HUD_MARKER_NOTE)).toBe(true)
    expect(withSight).toContain('[screen attached]')
    expect(withSight).toContain('an area of their screen')
    expect(withSight.endsWith('click save')).toBe(true)
    expect(withHudMarkerNote('click save', true)).not.toContain('The image attached to this message')
  })
})

describe('seeErrorCopy', () => {
  it('stays silent on cancel, explains permission', () => {
    expect(seeErrorCopy('cancelled')).toBeNull()
    expect(seeErrorCopy('screen-permission')).toMatch(/Screen Recording/)
  })
})
