import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

/**
 * Behavioral tests for the HUD mascot-widget state module (schema v2).
 * Deps (fs, screen) are injected, so no Electron is needed here.
 */
const require = createRequire(import.meta.url)
const hudState = require('./hud-state.cjs')

const WORK_AREA = { x: 0, y: 0, width: 1512, height: 944 }
const screenApi = { getDisplayMatching: () => ({ workArea: WORK_AREA }) }
const DEFAULTS = { width: 620, height: 340 }

describe('hud-state path + constants', () => {
  it('lives directly under userData with the canonical name', () => {
    expect(hudState.hudStatePath('/tmp/ud')).toBe('/tmp/ud/hud-window-state.json')
  })
  it('exports the widget constants main.cjs consumes', () => {
    expect(hudState.ORB_SIZE).toBe(104)
    expect(hudState.HUD_MIN_WIDTH).toBeGreaterThan(0)
    expect(hudState.HUD_MIN_HEIGHT).toBeGreaterThan(0)
  })
})

describe('parseHudState / loadHudState (v2 + v1 backcompat)', () => {
  it('parses a v2 file with both fields', () => {
    const s = hudState.parseHudState('{"version":2,"expanded":{"x":10,"y":20,"width":620,"height":340},"orb":{"x":500,"y":700}}')
    expect(s).toEqual({ expanded: { x: 10, y: 20, width: 620, height: 340 }, orb: { x: 500, y: 700 } })
  })
  it('upgrades a v1 flat file to { expanded } with no orb', () => {
    const s = hudState.parseHudState('{"x":10,"y":20,"width":620,"height":340}')
    expect(s).toEqual({ expanded: { x: 10, y: 20, width: 620, height: 340 }, orb: null })
  })
  it('accepts an orb-only file (cat position known, strip never opened)', () => {
    const s = hudState.parseHudState('{"version":2,"expanded":null,"orb":{"x":100,"y":100}}')
    expect(s).toEqual({ expanded: null, orb: { x: 100, y: 100 } })
  })
  it('parses the optional open flag (auto-restore at launch)', () => {
    // The flag rides on a valid envelope — the orb position is what gets restored.
    const orb = '{"x":100,"y":100}'
    expect(hudState.parseHudState('{"version":2,"expanded":null,"orb":' + orb + ',"open":true}').open).toBe(true)
    expect(hudState.parseHudState('{"version":2,"expanded":null,"orb":' + orb + ',"open":false}').open).toBe(false)
    // Absent in pre-2026-08-29 files → undefined → no auto-restore.
    expect(hudState.parseHudState('{"version":2,"expanded":null,"orb":' + orb + '}').open).toBeUndefined()
    // Non-boolean junk is treated as absent, never trusted.
    expect(hudState.parseHudState('{"version":2,"expanded":null,"orb":' + orb + ',"open":"yes"}').open).toBeUndefined()
  })

  it('honors the open flag even with no geometry (crash before first save)', () => {
    // createHudWindow persists { expanded:null, orb:null, open:true } the moment
    // the orb is summoned; a crash before any position save must still restore.
    expect(hudState.parseHudState('{"version":2,"expanded":null,"orb":null,"open":true}')).toEqual({ expanded: null, orb: null, open: true })
    expect(hudState.parseHudState('{"version":2,"expanded":null,"orb":null,"open":false}').open).toBe(false)
    // An empty envelope WITHOUT the flag still parses to null (v1-era noise).
    expect(hudState.parseHudState('{"version":2,"expanded":null,"orb":null}')).toBeNull()
  })
  it('returns null for missing file', () => {
    expect(hudState.loadHudState(() => { throw new Error('ENOENT') }, '/x.json')).toBeNull()
  })
  it('returns null for corrupt JSON', () => {
    expect(hudState.parseHudState('{not json')).toBeNull()
  })
  it('returns null when neither field parses', () => {
    expect(hudState.parseHudState('{}')).toBeNull()
    expect(hudState.parseHudState('{"expanded":{"x":1},"orb":"nope"}')).toBeNull()
  })
  it('returns null for non-object payloads', () => {
    expect(hudState.parseHudState('null')).toBeNull()
    expect(hudState.parseHudState('[]')).toBeNull()
  })
})

describe('clampHudBounds (expanded strip)', () => {
  it('keeps an on-screen save, flooring sizes at HUD minimums', () => {
    expect(hudState.clampHudBounds({ x: 100, y: 100, width: 100, height: 100 }, screenApi, DEFAULTS)).toEqual({
      x: 100, y: 100, width: hudState.HUD_MIN_WIDTH, height: hudState.HUD_MIN_HEIGHT,
    })
  })
  it('falls back to centered defaults when off-screen (monitor gone)', () => {
    const out = hudState.clampHudBounds({ x: 5000, y: 4000, width: 620, height: 340 }, screenApi, DEFAULTS)
    expect(out).toEqual(DEFAULTS)
    expect('x' in out).toBe(false)
  })
  it('caps an oversized save at the work area', () => {
    expect(hudState.clampHudBounds({ x: 0, y: 0, width: 4000, height: 3000 }, screenApi, DEFAULTS)).toEqual({ x: 0, y: 0, width: WORK_AREA.width, height: WORK_AREA.height })
  })
  it('survives a throwing screen API', () => {
    expect(hudState.clampHudBounds({ x: 1, y: 2, width: 500, height: 300 }, { getDisplayMatching: () => { throw new Error('no screen') } }, DEFAULTS)).toEqual(DEFAULTS)
  })
})

describe('clampOrbPosition (cat widget)', () => {
  it('passes through an on-screen position', () => {
    expect(hudState.clampOrbPosition({ x: 100, y: 100 }, screenApi)).toEqual({ x: 100, y: 100 })
  })
  it('pulls an off-right position back so the whole cat stays visible', () => {
    expect(hudState.clampOrbPosition({ x: WORK_AREA.width - 10, y: 100 }, screenApi)).toEqual({ x: WORK_AREA.width - hudState.ORB_SIZE, y: 100 })
  })
  it('pulls a far-off position to the work-area origin', () => {
    expect(hudState.clampOrbPosition({ x: -4000, y: -4000 }, screenApi)).toEqual({ x: WORK_AREA.x, y: WORK_AREA.y })
  })
  it('returns null for invalid input or a throwing screen API', () => {
    expect(hudState.clampOrbPosition(null, screenApi)).toBeNull()
    expect(hudState.clampOrbPosition({ x: 1.5, y: 2 }, screenApi)).toBeNull()
    expect(hudState.clampOrbPosition({ x: 1, y: 2 }, { getDisplayMatching: () => { throw new Error('no') } })).toBeNull()
  })
})

describe('persistHudState', () => {
  it('writes the v2 envelope with both fields', () => {
    const write = vi.fn()
    expect(hudState.persistHudState(write, '/tmp/f.json', { expanded: { x: 1, y: 2, width: 3, height: 4 }, orb: { x: 9, y: 8 } })).toBe(true)
    expect(write).toHaveBeenCalledWith('/tmp/f.json', '{"version":2,"expanded":{"x":1,"y":2,"width":3,"height":4},"orb":{"x":9,"y":8},"open":false}', 'utf8')
  })
  it('nulls absent fields instead of dropping them', () => {
    const write = vi.fn()
    expect(hudState.persistHudState(write, '/tmp/f.json', { expanded: null, orb: { x: 5, y: 6 } })).toBe(true)
    expect(write.mock.calls[0][1]).toContain('"expanded":null')
  })
  it('persists the open flag, defaulting to false when absent', () => {
    const write = vi.fn()
    expect(hudState.persistHudState(write, '/tmp/f.json', { expanded: null, orb: null, open: true })).toBe(true)
    expect(write.mock.calls[0][1]).toContain('"open":true')
    hudState.persistHudState(write, '/tmp/f.json', { expanded: null, orb: null })
    expect(write.mock.calls[1][1]).toContain('"open":false')
  })
  it('reports failure (never throws) when the write fails', () => {
    expect(hudState.persistHudState(() => { throw new Error('EROFS') }, '/tmp/f.json', { expanded: null, orb: null })).toBe(false)
  })
})
