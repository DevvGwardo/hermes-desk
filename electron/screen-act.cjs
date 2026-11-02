'use strict'
/**
 * screen-act.cjs — screen ACTION primitives for the HUD mascot ([CLICK:x,y]).
 *
 * The last mile of the Clicky loop (talk→see→point→ACT). Deliberately
 * dependency-free: no cliclick install, no pyobjc, no robotjs, no native
 * build. Backends are *resolved at call time*, best first:
 *
 *   1. cliclick   — if the user has it on PATH (`brew install cliclick`).
 *   2. jxa        — `osascript -l JavaScript` + CoreGraphics CGEventPost.
 *                   Ships with every macOS; this is exactly what cliclick
 *                   does internally, done by hand.
 *   3. systevents — `osascript` + System Events `click at {x,y}` — the last
 *                   resort, and the same permission path [TYPE:] already uses.
 *
 * PERMISSION (the whole reason this module reports instead of guessing):
 * macOS silently DROPS posted CGEvents when the posting process is not a
 * trusted Accessibility client. CGEventPost returns void and osascript exits
 * 0 either way, so a blocked click is indistinguishable from a landed one.
 * Callers inside Electron MUST pass `isTrusted` (Electron's
 * systemPreferences.isTrustedAccessibilityClient) so this module can refuse
 * with `accessibility-not-trusted` instead of lying.
 *
 * Purity: this module never requires('electron'). Everything
 * environment-dependent (spawn, PATH lookup, trust) is injected, so it is
 * unit-testable in plain node.
 */

const { spawnSync } = require('child_process')
const binGuard = require('./bin-guard.cjs')
const { helperEnv } = require('./agent-env.cjs')

const CLICLICK = 'cliclick'
const JXA = 'jxa'
const SYSEVENTS = 'systevents'

/**
 * D-06 (red team sweep 5): HUD act backends must never exec a bare PATH
 * name — a user-writable early PATH entry (shell profile, `launchctl setenv`,
 * a planted directory) could shadow `cliclick`/`osascript` and receive every
 * click coordinate and typed string. osascript is pinned to its fixed macOS
 * system path; cliclick (optional, Homebrew) resolves through bin-guard's
 * trust check (regular file, not group/world-writable) and the backend is
 * dropped when the guard refuses. Injectable for tests.
 */
const OSA_PATH = '/usr/bin/osascript'

function defaultResolveActFile(name) {
  if (name === 'osascript') return OSA_PATH
  if (name === 'cliclick') {
    try {
      const verdict = binGuard.resolveTrustedBin(name)
      return verdict.ok ? verdict.bin : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Trust is TRI-STATE, and the third state is the one that matters:
 *   true     — the OS told us this process is a trusted Accessibility client.
 *   false    — the OS told us it is not; events WILL be dropped.
 *   'unknown'— nobody asked. Reported as a string precisely so it can never be
 *              mistaken for a granted permission.
 *
 * Why 'unknown' is not `true`: measured on a real Mac, an untrusted client
 * posting a CGEvent gets osascript exit 0 and a cursor that does not move.
 * Collapsing "unchecked" into `true` therefore renders as `{ok:true, it
 * worked}` for an event that never landed — the exact lie this module exists
 * to prevent.
 */
const UNKNOWN_TRUST = 'unknown'

const ACCESS_HINT =
  'Grant Accessibility to Nub Agent (System Settings → Privacy & Security → Accessibility), then reopen the HUD.'

/**
 * JXA click/move via CoreGraphics. Coordinates travel as ARGV — never
 * interpolated into the script — so no value can ever be reinterpreted as
 * code. `osascript -l JavaScript -e <src> <x> <y> <mode>` invokes run(argv).
 */
const JXA_SRC = [
  'ObjC.import("CoreGraphics")',
  'function post(type, x, y) {',
  '  var pt = $.CGPointMake(x, y)',
  '  var ev = $.CGEventCreateMouseEvent(null, type, pt, 0)',
  '  $.CGEventPost($.kCGHIDEventTap, ev)',
  '}',
  'function run(argv) {',
  '  var x = parseFloat(argv[0]), y = parseFloat(argv[1]), mode = argv[2] || "click"',
  '  if (!isFinite(x) || !isFinite(y)) throw new Error("bad coords")',
  '  post($.kCGEventMouseMoved, x, y)',
  '  if (mode === "move") return "moved"',
  '  post($.kCGEventLeftMouseDown, x, y)',
  '  post($.kCGEventLeftMouseUp, x, y)',
  '  return "clicked"',
  '}',
].join('\n')

const BACKENDS = [
  {
    name: CLICLICK,
    available: (ctx) => ctx.hasBin('cliclick') && Boolean(ctx.resolveActFile('cliclick')),
    argv: (ctx, x, y, mode) => ({
      file: ctx.resolveActFile('cliclick'),
      args: [`${mode === 'move' ? 'm' : 'c'}:${x},${y}`],
    }),
  },
  {
    name: JXA,
    available: (ctx) => ctx.platform === 'darwin',
    argv: (ctx, x, y, mode) => ({
      file: ctx.resolveActFile('osascript'),
      args: ['-l', 'JavaScript', '-e', JXA_SRC, String(x), String(y), mode],
    }),
  },
  {
    name: SYSEVENTS,
    // No move primitive — click only.
    available: (ctx, mode) => ctx.platform === 'darwin' && mode === 'click',
    argv: (ctx, x, y) => ({
      file: ctx.resolveActFile('osascript'),
      args: ['-e', `tell application "System Events" to click at {${x}, ${y}}`],
    }),
  },
]

function defaultHasBin(name) {
  try {
    const res = spawnSync('/usr/bin/which', [name], { encoding: 'utf8', env: helperEnv(), timeout: 3000, maxBuffer: 4096 })
    return res.status === 0 && Boolean(String(res.stdout || '').trim())
  } catch {
    return false
  }
}

function toFinite(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  // null / undefined / boolean / '' are NOT 0 — treating them as 0 would
  // click the top-left corner of the primary display.
  return null
}

/** Screen points: finite numbers only. Negative coords are legal — a display
 *  arranged left of the primary has a negative x — so never clamp to >= 0. */
function normalizePoint(x, y) {
  const nx = toFinite(x)
  const ny = toFinite(y)
  if (nx === null || ny === null) return null
  return { x: Math.round(nx), y: Math.round(ny) }
}

/**
 * What acting on this machine would involve, without doing it.
 *
 * `trusted:false` is the only refusal signal. An absent `isTrusted` provider
 * yields `trusted:'unknown'`, which still attempts (the OS is the real
 * arbiter and we would rather try than refuse on a machine we misread) but is
 * reported as unknown so no caller can mistake exit 0 for a landed event.
 */
function actStatus(opts = {}) {
  const platform = opts.platform || process.platform
  const isTrusted = typeof opts.isTrusted === 'function' ? opts.isTrusted : null
  // Only darwin gates input injection behind Accessibility. Tri-state is
  // preserved EXACTLY — no Boolean() wrap: Boolean('unknown') is true, which
  // would collapse "never checked" into "granted" (the silent-drop lie).
  let trusted = true
  if (platform === 'darwin') {
    if (!isTrusted) {
      trusted = UNKNOWN_TRUST
    } else {
      const verdict = isTrusted()
      trusted = verdict === true ? true : verdict === false ? false : UNKNOWN_TRUST
    }
  }
  const ctx = {
    platform,
    hasBin: opts.hasBin || defaultHasBin,
    resolveActFile: opts.resolveActFile || defaultResolveActFile,
  }
  const backends = BACKENDS.filter((b) => b.available(ctx, 'click')).map((b) => b.name)
  const backend = backends[0] || null
  return {
    platform,
    trusted,
    backend,
    backends,
    available: trusted !== false && Boolean(backend),
  }
}

/**
 * Run one action ('click' | 'move'), trying each available backend in order.
 * Returns the first that exits 0; otherwise every backend's error is reported
 * so a failure is diagnosable instead of a bare false.
 */
function act(mode, x, y, opts = {}) {
  const p = normalizePoint(x, y)
  if (!p) return { ok: false, error: 'bad-coords' }
  // Argv invariant: coordinates cross the process boundary as discrete argv
  // entries (never interpolated into script text). They must be integers —
  // normalizePoint rounds, but this asserts the contract at the spawn edge so
  // a future caller passing raw floats cannot smuggle '1e3'/locale spellings.
  if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) {
    return { ok: false, error: 'bad-coords' }
  }

  const status = actStatus(opts)
  if (status.trusted === false) {
    return {
      ok: false,
      error: 'accessibility-not-trusted',
      hint: ACCESS_HINT,
      x: p.x,
      y: p.y,
      status,
    }
  }

  const runner = opts.runner || spawnSync
  const ctx = {
    platform: status.platform,
    hasBin: opts.hasBin || defaultHasBin,
    resolveActFile: opts.resolveActFile || defaultResolveActFile,
  }
  const errors = []

  for (const backend of BACKENDS) {
    if (!backend.available(ctx, mode)) continue
    const { file, args } = backend.argv(ctx, p.x, p.y, mode)
    if (!file) {
      errors.push({ backend: backend.name, error: 'trusted binary unavailable' })
      continue
    }
    let res
    try {
      res = runner(file, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
        env: helperEnv(), timeout: 3000, maxBuffer: 65536 })
    } catch (err) {
      errors.push({ backend: backend.name, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (res && res.error) {
      errors.push({ backend: backend.name, error: String(res.error.message || res.error) })
      continue
    }
    if (res && res.status === 0) {
      return { ok: true, backend: backend.name, mode, x: p.x, y: p.y, trusted: status.trusted }
    }
    errors.push({
      backend: backend.name,
      error: String((res && res.stderr) || '').trim() || `exit ${res && res.status}`,
    })
  }

  return {
    ok: false,
    error: errors.length ? 'act-failed' : 'no-backend',
    errors,
    mode,
    x: p.x,
    y: p.y,
    trusted: status.trusted,
  }
}

/**
 * Read the OS cursor back. JXA, no arguments, nothing to inject.
 *
 * This exists because `act()` CANNOT tell a landed event from a dropped one:
 * CGEventPost returns void and osascript exits 0 either way. Comparing where
 * we asked the cursor to go against where it actually is turns "exit 0, so
 * presumably it worked" into a measurement. See scripts/hud-act-probe.cjs.
 */
const CURSOR_POS_SRC = [
  'ObjC.import("CoreGraphics")',
  'function run() {',
  '  var pt = $.CGEventGetLocation($.CGEventCreate(null))',
  '  return "" + pt.x + " " + pt.y',
  '}',
].join('\n')

function cursorPosition(opts = {}) {
  const platform = opts.platform || process.platform
  if (platform !== 'darwin') return { ok: false, error: 'unsupported-platform', platform }

  const runner = opts.runner || spawnSync
  const osascript = (opts.resolveActFile || defaultResolveActFile)('osascript') || OSA_PATH
  let res
  try {
    res = runner(osascript, ['-l', 'JavaScript', '-e', CURSOR_POS_SRC], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: helperEnv(), timeout: 3000, maxBuffer: 4096,
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), platform }
  }
  if (res && res.error) {
    return { ok: false, error: String(res.error.message || res.error), platform }
  }
  if (!res || res.status !== 0) {
    return {
      ok: false,
      error: String((res && res.stderr) || '').trim() || `exit ${res && res.status}`,
      platform,
    }
  }
  const m = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/.exec(String(res.stdout || ''))
  if (!m) {
    return { ok: false, error: 'unparsable', raw: String(res.stdout || '').trim(), platform }
  }
  return { ok: true, x: Math.round(Number(m[1])), y: Math.round(Number(m[2])), platform }
}

function clickAt(x, y, opts = {}) {
  return act('click', x, y, opts)
}

/** Park the OS cursor on a point. Same permission path as a click, zero
 *  destructive potential — this is what the live probe verifies. */
function movePointerTo(x, y, opts = {}) {
  return act('move', x, y, opts)
}

module.exports = {
  ACCESS_HINT,
  BACKEND_NAMES: [CLICLICK, JXA, SYSEVENTS],
  CURSOR_POS_SRC,
  JXA_SRC,
  OSA_PATH,
  UNKNOWN_TRUST,
  actStatus,
  clickAt,
  cursorPosition,
  defaultResolveActFile,
  movePointerTo,
  normalizePoint,
}
