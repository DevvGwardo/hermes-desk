'use strict'
/**
 * screen-see.cjs — the SEE half of the Clicky loop (talk→SEE→point→act).
 *
 * The cat could point and click, but it was blind: the marker note told the
 * model "never guess coordinates" because no screenshot ever reached it. This
 * module captures what the user is looking at — the whole display the cat is
 * on, or a region the user drags out — and returns it with the GEOMETRY that
 * maps screenshot pixels back to screen points. The model answers in
 * screenshot pixels (what it can actually see); the renderer maps them
 * (src/lib/hud-sight.ts), so the model never does display math.
 *
 * Consent: nothing here runs on its own. Every capture is one explicit tap
 * (the eye / snip buttons in the HUD); there is no timer, no background grab.
 *
 * Purity: never requires('electron'). desktopCapturer, screen, the media
 * access probe and the HUD window's content-protection toggle are injected,
 * so the whole flow is unit-testable in plain node.
 */

/** Long edge of the image sent to the model. Vision models downscale past
 *  ~1.5k anyway; a retina display at native size is 5–15MB of JPEG. */
const MAX_EDGE = 1568
/** Server cap (`validateContentParts`) is ~5MB decoded; stay well inside it. */
const MAX_DATA_URL_CHARS = 4_000_000
const JPEG_QUALITIES = [82, 70, 55, 40]
/** A drag smaller than this (screen points) is a click, not a selection. */
const MIN_REGION = 8

const SCREEN_PERMISSION_HINT =
  'Nub needs Screen Recording access to see your screen: System Settings → Privacy & Security → Screen Recording → enable Nub Agent, then reopen the app.'

/**
 * Screen Recording status on macOS. Other platforms have no such gate.
 * @returns {'granted'|'not-determined'|'denied'|'restricted'|'unknown'}
 */
function screenAccess({ platform, getMediaAccessStatus }) {
  if (platform !== 'darwin') return 'granted'
  try {
    const s = getMediaAccessStatus('screen')
    return typeof s === 'string' ? s : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Validate + clamp a region (display-relative screen points) to the display.
 * Null when it is degenerate (a click, NaN, off-display).
 */
function normalizeRegion(rect, displaySize) {
  if (!rect || typeof rect !== 'object') return null
  const nums = [rect.x, rect.y, rect.width, rect.height].map(Number)
  if (!nums.every(Number.isFinite)) return null
  let [x, y, w, h] = nums
  // Accept drags in any direction.
  if (w < 0) { x += w; w = -w }
  if (h < 0) { y += h; h = -h }
  const W = Number(displaySize && displaySize.width)
  const H = Number(displaySize && displaySize.height)
  if (!(W > 0) || !(H > 0)) return null
  const x0 = Math.max(0, Math.min(W, Math.round(x)))
  const y0 = Math.max(0, Math.min(H, Math.round(y)))
  const x1 = Math.max(0, Math.min(W, Math.round(x + w)))
  const y1 = Math.max(0, Math.min(H, Math.round(y + h)))
  if (x1 - x0 < MIN_REGION || y1 - y0 < MIN_REGION) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** Fit (w,h) inside MAX_EDGE on the long side, never upscaling. */
function fitSize(width, height, maxEdge = MAX_EDGE) {
  const long = Math.max(width, height)
  if (!(long > 0)) return { width: 0, height: 0 }
  const k = long > maxEdge ? maxEdge / long : 1
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/** Pick the capturer source for a display (display_id match, else the only one). */
function pickSource(sources, display) {
  const list = Array.isArray(sources) ? sources : []
  const id = String(display && display.id)
  return list.find((s) => s && String(s.display_id) === id) || (list.length === 1 ? list[0] : null)
}

/** NativeImage → JPEG data URL under the size cap (steps quality down). */
function encodeImage(image) {
  for (const q of JPEG_QUALITIES) {
    const buf = image.toJPEG(q)
    const url = `data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`
    if (url.length <= MAX_DATA_URL_CHARS) return url
  }
  return null
}

/**
 * Grab one display at native resolution with the cat excluded from the shot.
 * @returns {Promise<{ok:true, image, display} | {ok:false, error, hint?}>}
 */
async function grabDisplay(display, deps) {
  const access = screenAccess(deps)
  if (access === 'denied' || access === 'restricted') {
    return { ok: false, error: 'screen-permission', hint: SCREEN_PERMISSION_HINT }
  }
  const scale = Number(display.scaleFactor) > 0 ? Number(display.scaleFactor) : 1
  const size = {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
  }
  // The cat must not photograph itself: content protection excludes the HUD
  // window from capture (macOS sharingType none / Windows
  // WDA_EXCLUDEFROMCAPTURE) for exactly the duration of the grab, so it still
  // shows up in the user's own recordings and screen shares.
  await deps.setHudHidden(true)
  let sources
  try {
    sources = await deps.getSources({ types: ['screen'], thumbnailSize: size })
  } catch (err) {
    return { ok: false, error: 'capture-failed', hint: err instanceof Error ? err.message : String(err) }
  } finally {
    await deps.setHudHidden(false)
  }
  if (access === 'not-determined' || access === 'unknown') {
    // The first getSources call is what makes macOS show its prompt; until the
    // user answers, the thumbnail is just wallpaper. Re-check after the call.
    const now = screenAccess(deps)
    if (now !== 'granted') {
      return { ok: false, error: 'screen-permission', hint: SCREEN_PERMISSION_HINT }
    }
  }
  const source = pickSource(sources, display)
  const image = source && source.thumbnail
  if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) {
    return { ok: false, error: 'capture-empty', hint: SCREEN_PERMISSION_HINT }
  }
  return { ok: true, image, display }
}

/**
 * Turn a native grab (+ optional display-relative region) into what the
 * renderer sends: a JPEG data URL and the pixel→point geometry.
 *
 * geometry: { x, y, width, height } is the captured area in GLOBAL screen
 * points; { imageWidth, imageHeight } is the pixel size of the data URL.
 * screenX = x + px * width / imageWidth (and likewise for y).
 */
function packCapture(grab, region) {
  const { image, display } = grab
  const native = image.getSize()
  const b = display.bounds
  const area = region || { x: 0, y: 0, width: b.width, height: b.height }
  // Points → native pixels of the grab (the grab's own scale, not the
  // display's nominal one — thumbnails can come back a touch off-size).
  const kx = native.width / b.width
  const ky = native.height / b.height
  let img = image
  if (region) {
    const crop = {
      x: Math.round(area.x * kx),
      y: Math.round(area.y * ky),
      width: Math.max(1, Math.round(area.width * kx)),
      height: Math.max(1, Math.round(area.height * ky)),
    }
    img = image.crop(crop)
  }
  const cur = img.getSize()
  const fit = fitSize(cur.width, cur.height)
  if (fit.width !== cur.width || fit.height !== cur.height) {
    img = img.resize({ width: fit.width, height: fit.height, quality: 'good' })
  }
  const out = img.getSize()
  const dataUrl = encodeImage(img)
  if (!dataUrl) return { ok: false, error: 'capture-too-large' }
  return {
    ok: true,
    dataUrl,
    mode: region ? 'region' : 'screen',
    geometry: {
      x: b.x + area.x,
      y: b.y + area.y,
      width: area.width,
      height: area.height,
      imageWidth: out.width,
      imageHeight: out.height,
    },
    capturedAt: Date.now(),
  }
}

module.exports = {
  MAX_EDGE,
  MAX_DATA_URL_CHARS,
  MIN_REGION,
  SCREEN_PERMISSION_HINT,
  screenAccess,
  normalizeRegion,
  fitSize,
  pickSource,
  encodeImage,
  grabDisplay,
  packCapture,
}
