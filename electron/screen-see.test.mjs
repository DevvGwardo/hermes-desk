import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  normalizeRegion,
  fitSize,
  pickSource,
  grabDisplay,
  packCapture,
  screenAccess,
  MAX_EDGE,
  MAX_DATA_URL_CHARS,
} = require('./screen-see.cjs')
const { sanitizeActivity, sanitizeConversationId } = require('./hud-activity-relay.cjs')

/** Minimal NativeImage stand-in: tracks size through crop/resize. */
function fakeImage(width, height, { jpegBytes = 1000, empty = false } = {}) {
  return {
    ops: [],
    getSize() { return { width, height } },
    isEmpty() { return empty },
    crop(r) { const img = fakeImage(r.width, r.height, { jpegBytes }); img.ops = [...this.ops, ['crop', r]]; return img },
    resize(r) { const img = fakeImage(r.width, r.height, { jpegBytes }); img.ops = [...this.ops, ['resize', r]]; return img },
    toJPEG() { return Buffer.alloc(jpegBytes, 7) },
  }
}

const DISPLAY = {
  id: 42,
  scaleFactor: 2,
  bounds: { x: -1440, y: 0, width: 1440, height: 900 },
  size: { width: 1440, height: 900 },
}

function deps(over = {}) {
  const calls = []
  return {
    calls,
    platform: 'darwin',
    getMediaAccessStatus: vi.fn(() => 'granted'),
    getSources: vi.fn(async (opts) => {
      calls.push(['getSources', opts])
      return [{ display_id: '42', thumbnail: fakeImage(2880, 1800) }]
    }),
    setHudHidden: vi.fn(async (h) => { calls.push(['hidden', h]) }),
    ...over,
  }
}

describe('normalizeRegion', () => {
  const size = { width: 1440, height: 900 }
  it('accepts a normal drag', () => {
    expect(normalizeRegion({ x: 10, y: 20, width: 300, height: 200 }, size)).toEqual({ x: 10, y: 20, width: 300, height: 200 })
  })
  it('accepts drags in any direction', () => {
    expect(normalizeRegion({ x: 310, y: 220, width: -300, height: -200 }, size)).toEqual({ x: 10, y: 20, width: 300, height: 200 })
  })
  it('clamps to the display', () => {
    expect(normalizeRegion({ x: 1400, y: 880, width: 500, height: 500 }, size)).toEqual({ x: 1400, y: 880, width: 40, height: 20 })
  })
  it('treats a click (tiny drag) and junk as cancel', () => {
    expect(normalizeRegion({ x: 5, y: 5, width: 3, height: 3 }, size)).toBeNull()
    expect(normalizeRegion(null, size)).toBeNull()
    expect(normalizeRegion({ x: 'a', y: 0, width: 50, height: 50 }, size)).toBeNull()
    expect(normalizeRegion({ x: 0, y: 0, width: 50, height: 50 }, { width: 0, height: 0 })).toBeNull()
  })
})

describe('fitSize / pickSource', () => {
  it('caps the long edge, never upscales', () => {
    expect(fitSize(2880, 1800)).toEqual({ width: MAX_EDGE, height: 980 })
    expect(fitSize(400, 300)).toEqual({ width: 400, height: 300 })
  })
  it('matches the source by display id, falls back only when unambiguous', () => {
    const a = { display_id: '1' }
    const b = { display_id: '42' }
    expect(pickSource([a, b], DISPLAY)).toBe(b)
    expect(pickSource([a], DISPLAY)).toBe(a)
    expect(pickSource([a, { display_id: '2' }], DISPLAY)).toBeNull()
  })
})

describe('grabDisplay', () => {
  it('hides the cat for exactly the grab, at native resolution', async () => {
    const d = deps()
    const res = await grabDisplay(DISPLAY, d)
    expect(res.ok).toBe(true)
    expect(d.calls.map((c) => c[0] === 'hidden' ? `hidden:${c[1]}` : c[0])).toEqual(['hidden:true', 'getSources', 'hidden:false'])
    expect(d.getSources.mock.calls[0][0]).toEqual({ types: ['screen'], thumbnailSize: { width: 2880, height: 1800 } })
  })

  it('un-hides the cat even when capture throws', async () => {
    const d = deps({ getSources: vi.fn(async () => { throw new Error('boom') }) })
    const res = await grabDisplay(DISPLAY, d)
    expect(res).toMatchObject({ ok: false, error: 'capture-failed' })
    expect(d.setHudHidden).toHaveBeenLastCalledWith(false)
  })

  it('refuses without Screen Recording permission (no capture attempted)', async () => {
    const d = deps({ getMediaAccessStatus: () => 'denied' })
    const res = await grabDisplay(DISPLAY, d)
    expect(res).toMatchObject({ ok: false, error: 'screen-permission' })
    expect(d.getSources).not.toHaveBeenCalled()
  })

  it('first run: triggers the prompt, but does not send a wallpaper-only grab', async () => {
    const d = deps({ getMediaAccessStatus: () => 'not-determined' })
    const res = await grabDisplay(DISPLAY, d)
    expect(d.getSources).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({ ok: false, error: 'screen-permission' })
  })

  it('an empty thumbnail is an error, not a blank screenshot', async () => {
    const d = deps({ getSources: vi.fn(async () => [{ display_id: '42', thumbnail: fakeImage(0, 0, { empty: true }) }]) })
    expect(await grabDisplay(DISPLAY, d)).toMatchObject({ ok: false, error: 'capture-empty' })
  })

  it('other platforms have no permission gate', () => {
    expect(screenAccess({ platform: 'win32', getMediaAccessStatus: () => 'denied' })).toBe('granted')
  })
})

describe('packCapture geometry', () => {
  it('full screen: global points of the display + downscaled pixel size', () => {
    const out = packCapture({ ok: true, image: fakeImage(2880, 1800), display: DISPLAY }, null)
    expect(out.ok).toBe(true)
    expect(out.mode).toBe('screen')
    expect(out.geometry).toEqual({ x: -1440, y: 0, width: 1440, height: 900, imageWidth: MAX_EDGE, imageHeight: 980 })
    expect(out.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
  })

  it('region: crops in native pixels, geometry in global points', () => {
    const img = fakeImage(2880, 1800)
    const out = packCapture({ ok: true, image: img, display: DISPLAY }, { x: 100, y: 50, width: 300, height: 200 })
    expect(out.mode).toBe('region')
    expect(out.geometry).toEqual({ x: -1340, y: 50, width: 300, height: 200, imageWidth: 600, imageHeight: 400 })
  })

  it('refuses an image that stays over the size cap', () => {
    const big = fakeImage(2880, 1800, { jpegBytes: MAX_DATA_URL_CHARS })
    expect(packCapture({ ok: true, image: big, display: DISPLAY }, null)).toMatchObject({ ok: false, error: 'capture-too-large' })
  })
})

describe('hud-activity-relay sanitize', () => {
  it('keeps known keys, clips strings, drops junk rows', () => {
    const out = sanitizeActivity({
      v: 1,
      working: [{ id: 'conv_1', title: 'Hi', extra: 'x' }, { id: '../etc', title: 'bad' }],
      events: [
        { key: 'conv_1:m1', id: 'conv_1', title: 't', preview: 'p'.repeat(500), status: 'done', at: 5 },
        { key: 'k', id: 'conv_2', title: 't', preview: '', status: 'weird', at: 5 },
        { key: 'k2', id: 'conv_3', title: 't', preview: '', status: 'error', at: 0 },
      ],
      evil: true,
    })
    expect(out.working).toEqual([{ id: 'conv_1', title: 'Hi' }])
    expect(out.events).toHaveLength(1)
    expect(out.events[0].preview.length).toBeLessThanOrEqual(220)
    expect(out).not.toHaveProperty('evil')
  })
  it('rejects non-v1 payloads and bad ids', () => {
    expect(sanitizeActivity({ v: 2 })).toBeNull()
    expect(sanitizeActivity(null)).toBeNull()
    expect(sanitizeConversationId('cs_abc:1')).toBe('cs_abc:1')
    expect(sanitizeConversationId('a b')).toBeNull()
    expect(sanitizeConversationId('x'.repeat(200))).toBeNull()
  })
})
