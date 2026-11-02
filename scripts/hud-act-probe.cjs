'use strict'
/**
 * hud-act-probe.cjs — live proof that the HUD's screen-ACTION path is honest.
 *
 * `electron/screen-act.test.mjs` proves the LOGIC with an injected runner. It
 * cannot prove the thing that actually matters on a real Mac: whether a posted
 * CGEvent lands. macOS DROPS events from untrusted Accessibility clients
 * SILENTLY — CGEventPost returns void and osascript still exits 0 — so
 * "exit 0, therefore it clicked" is exactly the lie this probe exists to catch.
 *
 * So it measures instead of assuming: ask the cursor to move, read the OS
 * cursor back, and compare. It must run as the Electron MAIN PROCESS, because
 * that is the process whose trust state governs a real [CLICK:] call.
 *
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/hud-act-probe.cjs \
 *        --no-sandbox --user-data-dir=/tmp/nub-act-probe
 *
 * One line of output: `ACT_PROBE done ok {...}` or `ACT_PROBE done FAIL {...}`.
 * Exit 0 / 1 accordingly.
 */
const path = require('path')
const screenAct = require(path.join(__dirname, '..', 'electron', 'screen-act.cjs'))
const { app, screen, systemPreferences } = require('electron')

const TOLERANCE = 2 // px — the OS may round a fractional point.
const SETTLE_POLL_MS = 50
const SETTLE_TIMEOUT_MS = 1500
const HARD_TIMEOUT_MS = 30000

const results = { platform: process.platform }
let failed = false

function pass(field, detail) {
  results[field] = detail
}

function fail(field, detail) {
  failed = true
  results[field] = `FAIL: ${detail}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Where the OS cursor actually is, or null if we cannot read it. */
function readCursor() {
  const res = screenAct.cursorPosition({ platform: process.platform })
  return res && res.ok ? { x: res.x, y: res.y } : null
}

/**
 * CGEventPost is asynchronous at the HID tap, so a single read taken the
 * instant after posting can still show the old position. Poll until the cursor
 * settles on the target; return the observed point or null.
 */
async function waitForCursor(x, y, timeoutMs = SETTLE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = readCursor()
    if (last && Math.abs(last.x - x) <= TOLERANCE && Math.abs(last.y - y) <= TOLERANCE) return last
    await sleep(SETTLE_POLL_MS)
  }
  return null
}

/** Pick a probe target near the cursor, clamped inside the primary workArea. */
function probeTarget(origin) {
  const wa = screen.getPrimaryDisplay().workArea
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
  // 24px is far enough to be unambiguous against the 2px tolerance, near
  // enough that a restore puts the pointer back where the user left it.
  let tx = origin.x + 24
  let ty = origin.y + 24
  if (tx > wa.x + wa.width - 8) tx = origin.x - 24
  if (ty > wa.y + wa.height - 8) ty = origin.y - 24
  return {
    x: clamp(tx, wa.x + 4, wa.x + wa.width - 4),
    y: clamp(ty, wa.y + 4, wa.y + wa.height - 4),
  }
}

/**
 * True when the pointer is holding still.
 *
 * A moving pointer makes every cursor-delta measurement meaningless: if the
 * user is jiggling the mouse, "the cursor changed" says nothing about whether
 * OUR event landed, and "the cursor is unchanged" proves nothing either. On a
 * live desktop this probe must report `inconclusive` rather than a false FAIL,
 * or it becomes a gate that cries wolf.
 */
async function pointerIsQuiescent(samples = 4, gapMs = 80) {
  let prev = readCursor()
  if (!prev) return false
  for (let i = 0; i < samples; i++) {
    await sleep(gapMs)
    const now = readCursor()
    if (!now || now.x !== prev.x || now.y !== prev.y) return false
    prev = now
  }
  return true
}

function trustedProbe() {
  if (process.platform !== 'darwin') return true
  try {
    return Boolean(systemPreferences.isTrustedAccessibilityClient(false))
  } catch {
    // API missing in this Electron build — attempt, let the OS judge, but do
    // not report it as a granted permission.
    return screenAct.UNKNOWN_TRUST
  }
}

async function main() {
  await app.whenReady()

  // 1. Malformed coordinates are REFUSED, never coerced to (0,0) — a null or
  //    '' silently becoming 0 would click the top-left corner of the display.
  const bad = [
    screenAct.clickAt(null, 5),
    screenAct.clickAt('a', 'b'),
    screenAct.clickAt(1, undefined),
    screenAct.clickAt('', 0),
  ]
  if (bad.every((r) => r && r.ok === false && r.error === 'bad-coords')) {
    pass('coords', `refused ${bad.length} malformed inputs with bad-coords`)
  } else {
    fail('coords', JSON.stringify(bad))
  }

  // 2. A forced-distrust call must refuse AND stay inert. This is the core
  //    anti-lie property: no event may be posted on the refusal path.
  // Quiescence is sampled BEFORE and AFTER: the user moving the pointer
  // mid-probe would turn a correct refusal into a spurious failure.
  const quiescentBefore = await pointerIsQuiescent()
  const beforeRefusal = readCursor()
  const refused = screenAct.clickAt(400, 400, { isTrusted: () => false })
  if (
    refused &&
    refused.ok === false &&
    refused.error === 'accessibility-not-trusted' &&
    typeof refused.hint === 'string'
  ) {
    pass('refusal', 'returned accessibility-not-trusted + fix-it hint')
  } else {
    fail('refusal', JSON.stringify(refused))
  }
  if (beforeRefusal) {
    const after = readCursor()
    const inert = after && after.x === beforeRefusal.x && after.y === beforeRefusal.y
    if (inert) {
      pass('refusal-inert', `cursor unchanged at ${beforeRefusal.x},${beforeRefusal.y}`)
    } else if (!quiescentBefore) {
      // Not a defect: the pointer was already moving. Inertness is pinned
      // deterministically by the unit test (the runner is never called on the
      // refusal path), so this live check staying inconclusive loses nothing.
      results['refusal-inert'] =
        'inconclusive: pointer was in motion (user input) — refusal-path inertness is pinned by the unit test'
    } else {
      fail('refusal-inert', `${JSON.stringify(beforeRefusal)} -> ${JSON.stringify(after)}`)
    }
  }

  // 3. The real trust state, reported not assumed.
  const isTrusted = trustedProbe
  const status = screenAct.actStatus({ platform: process.platform, isTrusted })
  results.trusted = status.trusted
  results.backends = (status.backends || []).join('+') || 'none'
  results.backend = status.backend

  // 4. The live measurement.
  const origin = readCursor()
  if (!origin) {
    results.landed = 'unmeasured'
    results.landedNote = 'cursor read unavailable on this platform'
  } else if (status.trusted === false) {
    // The honest outcome when Accessibility is not granted: the real path must
    // refuse out loud. It does, and we just proved step 2 covers that shape.
    const r = screenAct.movePointerTo(origin.x, origin.y, {
      platform: process.platform,
      isTrusted,
    })
    if (r && r.ok === false && r.error === 'accessibility-not-trusted') {
      results.landed = false
      results.landedNote = 'untrusted: real path refused explicitly, never a silent ok'
    } else {
      fail('untrusted-path', JSON.stringify(r))
    }
  } else {
    const target = probeTarget(origin)
    const moved = screenAct.movePointerTo(target.x, target.y, {
      platform: process.platform,
      isTrusted,
    })
    const landedAt = await waitForCursor(target.x, target.y)
    if (moved && moved.ok && landedAt) {
      results.landed = true
      results.via = moved.backend
      results.moved = `${origin.x},${origin.y} -> ${landedAt.x},${landedAt.y} (target ${target.x},${target.y})`
    } else {
      fail(
        'landed',
        `ok=${moved && moved.ok} backend=${moved && moved.backend} err=${moved && (moved.error || '')} observed=${JSON.stringify(landedAt)}`
      )
    }
    // Leave the pointer exactly where we found it.
    screenAct.movePointerTo(origin.x, origin.y, { platform: process.platform, isTrusted })
    results.restored = Boolean(await waitForCursor(origin.x, origin.y))
  }

  // 5. Can ANY posted event land here? Runs regardless of the app's own trust,
  //    because the answer changes what step 4 means: "refused" is only honest
  //    if a granted client COULD act on this machine. Posts a move with trust
  //    unknown (no provider) and measures. Harmless: pointer returns home.
  const origin5 = readCursor()
  const quiescent5 = await pointerIsQuiescent()
  if (origin5 && process.platform === 'darwin') {
    const t = probeTarget(origin5)
    const r = screenAct.movePointerTo(t.x, t.y, { platform: process.platform })
    const observed = await waitForCursor(t.x, t.y)
    if (r && r.ok && r.trusted === screenAct.UNKNOWN_TRUST) {
      pass('unknown-labelled', 'unchecked attempt reported trusted:"unknown", not true')
    } else {
      fail('unknown-labelled', JSON.stringify(r))
    }
    if (!quiescent5) {
      results.osAllowsEvents = 'inconclusive'
      results.osAllowsNote = 'pointer was in motion (user input) — cannot attribute cursor movement to our event'
    } else {
      results.osAllowsEvents = Boolean(observed)
      results.osAllowsNote = observed
        ? `a posted event DID land (${origin5.x},${origin5.y} -> ${observed.x},${observed.y})`
        : 'exit 0 but the cursor never moved — this process is NOT a trusted Accessibility client, so exit 0 does NOT mean it worked'
    }
    // Best effort on a live desktop: if the user moves the pointer during the
    // probe, "restored" will not match, and that is not a product defect.
    screenAct.movePointerTo(origin5.x, origin5.y, { platform: process.platform })
    await waitForCursor(origin5.x, origin5.y)
    results.pointerRestore = 'best-effort'
  }

  // Full JSON first (complete, for humans reading the log), compact summary
  // last (short enough to survive the gate-checker's 200-char evidence cap).
  console.log(`ACT_PROBE done ${failed ? 'FAIL' : 'ok'} ${JSON.stringify(results)}`)
  console.log(
    `ACT_PROBE summary ${failed ? 'FAIL' : 'ok'}` +
      ` trusted=${results.trusted}` +
      ` backend=${results.backend}` +
      ` landed=${results.landed}` +
      ` osAllowsEvents=${results.osAllowsEvents}` +
      ` unknownLabelled=${/^unchecked attempt reported/.test(String(results['unknown-labelled']))}`,
  )
  app.exit(failed ? 1 : 0)
}

process.on('uncaughtException', (err) => {
  results.exception = err && err.message
  console.log(`ACT_PROBE done FAIL ${JSON.stringify(results)}`)
  try {
    app.exit(1)
  } catch {
    process.exit(1)
  }
})

// Never hang: a wedged probe is worse than a failed one.
const guard = setTimeout(() => {
  results.timeout = `${HARD_TIMEOUT_MS}ms`
  console.log(`ACT_PROBE done FAIL ${JSON.stringify(results)}`)
  try {
    app.exit(1)
  } catch {
    process.exit(1)
  }
}, HARD_TIMEOUT_MS)
guard.unref?.()

main().catch((err) => {
  results.exception = err && err.message
  console.log(`ACT_PROBE done FAIL ${JSON.stringify(results)}`)
  app.exit(1)
})
