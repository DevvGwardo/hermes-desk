/**
 * HUD window-state persistence — v2 schema for mascot-widget mode.
 *
 * File: <userData>/hud-window-state.json
 *   { version: 2, expanded: {x,y,width,height}, orb: {x,y} }
 *
 * The CAT position (orb) and the STRIP bounds (expanded) are independent:
 * drag the cat, it stays; the strip remembers its own size. v1 flat files
 * ({x,y,width,height}) are read as expanded-only. Pure logic with injectable
 * deps (fs + a screen-like API) so it is fully unit-testable without Electron.
 */
const path = require('node:path')

const HUD_STATE_FILE = 'hud-window-state.json'
// Clicky-mode: the expanded HUD is a compact speech bubble, not a strip.
const HUD_MIN_WIDTH = 280
const HUD_MIN_HEIGHT = 180
/** The collapsed mascot widget window is a square of this side. */
const ORB_SIZE = 104
/** Minimum visible intersection (px) for an expanded save to be on-screen. */
const MIN_VISIBLE_W = 80
const MIN_VISIBLE_H = 40

function hudStatePath(userDataPath) {
  return path.join(userDataPath, HUD_STATE_FILE)
}

function isFiniteInt(n) {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n)
}

function parseBounds(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const { x, y, width, height } = data
  if (![x, y, width, height].every(isFiniteInt)) return null
  return { x, y, width, height }
}

function parseOrb(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const { x, y } = data
  if (!isFiniteInt(x) || !isFiniteInt(y)) return null
  return { x, y }
}

/**
 * Parse stored state; null for missing/corrupt payloads.
 * v1 flat bounds files are upgraded to { expanded } with no orb position.
 */
function parseHudState(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const expanded = parseBounds(data.expanded)
  const orb = parseOrb(data.orb)
  // Optional add-on: was the orb OPEN when the app quit? Absent in files
  // written before this field (v2 backcompat) → undefined → no auto-restore.
  const open = data.open === true || data.open === false ? data.open : undefined
  if (!expanded && !orb) {
    // v1 backcompat: a flat {x,y,width,height} file is treated as expanded-only.
    const flat = parseBounds(data)
    if (flat) return { expanded: flat, orb: null, open: undefined }
    // No geometry yet (crash before the first position save): still honor the
    // open flag so the orb can come back at the default position.
    return open === undefined ? null : { expanded: null, orb: null, open }
  }
  return { expanded, orb, open }
}

/** Read + parse; null when the file is absent (first run) or unreadable. */
function loadHudState(readFileSync, filePath) {
  let raw = null
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  return parseHudState(raw)
}

/**
 * Clamp restored EXPANDED bounds into the real display world.
 * A save that no longer meaningfully intersects any work area (monitor
 * unplugged) falls back to centered defaults (no x/y).
 */
function clampHudBounds(bounds, screenApi, defaults) {
  if (!bounds || typeof bounds !== 'object') return { ...defaults }
  const want = {
    x: bounds.x,
    y: bounds.y,
    width: Math.max(HUD_MIN_WIDTH, bounds.width),
    height: Math.max(HUD_MIN_HEIGHT, bounds.height),
  }
  let workArea = null
  try {
    const display = screenApi.getDisplayMatching(want)
    workArea = display && display.workArea ? display.workArea : null
  } catch {
    workArea = null
  }
  if (!workArea) return { ...defaults }
  const wa = workArea
  const ix =
    Math.max(0, Math.min(want.x + want.width, wa.x + wa.width) - Math.max(want.x, wa.x))
  const iy =
    Math.max(0, Math.min(want.y + want.height, wa.y + wa.height) - Math.max(want.y, wa.y))
  if (ix < MIN_VISIBLE_W || iy < MIN_VISIBLE_H) return { ...defaults }
  const width = Math.min(want.width, wa.width)
  const height = Math.min(want.height, wa.height)
  return {
    width,
    height,
    x: Math.min(Math.max(want.x, wa.x), wa.x + wa.width - width),
    y: Math.min(Math.max(want.y, wa.y), wa.y + wa.height - height),
  }
}

/**
 * Clamp an ORB (cat) position so the whole mascot stays on a display.
 * Returns null when the input or the screen API is unusable.
 */
function clampOrbPosition(pos, screenApi) {
  if (!pos || typeof pos !== 'object' || !isFiniteInt(pos.x) || !isFiniteInt(pos.y)) return null
  let wa = null
  try {
    const display = screenApi.getDisplayMatching({ x: pos.x, y: pos.y, width: ORB_SIZE, height: ORB_SIZE })
    wa = display && display.workArea ? display.workArea : null
  } catch {
    return null
  }
  if (!wa) return null
  return {
    x: Math.min(Math.max(pos.x, wa.x), wa.x + wa.width - ORB_SIZE),
    y: Math.min(Math.max(pos.y, wa.y), wa.y + wa.height - ORB_SIZE),
  }
}

/** Write the full state; never throws. */
function persistHudState(writeFileSync, filePath, state) {
  try {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 2,
        expanded: state && state.expanded ? state.expanded : null,
        orb: state && state.orb ? state.orb : null,
        open: state && typeof state.open === 'boolean' ? state.open : false,
      }),
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

module.exports = {
  HUD_STATE_FILE,
  HUD_MIN_WIDTH,
  HUD_MIN_HEIGHT,
  ORB_SIZE,
  hudStatePath,
  parseHudState,
  loadHudState,
  clampHudBounds,
  clampOrbPosition,
  persistHudState,
}
