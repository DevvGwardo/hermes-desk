'use strict'

/**
 * hud-package-transparency-probe.cjs — is the PACKAGED HUD window transparent?
 *
 * Why this exists, and why the widget probe is not enough:
 *
 *   scripts/hud-widget-probe.cjs loads the HUD renderer from the Vite DEV
 *   server. It has always gone green. A user then reported the shipped app
 *   shows the cat on a DARK background — and the dev probe could never have
 *   caught that, because dev and packaged load the renderer through different
 *   URL schemes:
 *
 *     dev      -> http://127.0.0.1:5173/?win=hud#/
 *     packaged -> file://…/app.asar/dist/index.html?win=hud#/
 *
 *   Different scheme, different `window.location`, and `isHudWindow()` is
 *   literally `new URLSearchParams(location.search).get('win') === 'hud'`.
 *   Everything downstream — the <html data-hud> attribute, and with it the
 *   `html[data-hud] body { background: transparent !important }` rule that is
 *   the ONLY thing keeping `body { background: var(--ca-canvas) }` from
 *   painting an opaque rectangle — hangs off that one string comparison.
 *
 * So this probe loads BOTH urls in identically-configured windows and reports
 * the whole background chain side by side, plus the pixel truth via a real
 * compositor capture.
 *
 * Run (must be launched BY electron — see the guard below):
 *   env -u ELECTRON_RUN_AS_NODE npx electron \
 *        scripts/hud-package-transparency-probe.cjs --no-sandbox
 *
 * One line: `PKG_TRANSPARENCY summary ok …` / `… FAIL …`. Exit 0 / 1.
 */
const electron = require('electron')
const { app, BrowserWindow } = electron

if (!app || typeof app.whenReady !== 'function') {
  const why = typeof electron === 'string'
    ? "require('electron') returned the binary path string — launch with `npx electron scripts/hud-package-transparency-probe.cjs`"
    : 'not running as an Electron main process'
  console.log('PKG_TRANSPARENCY done FAIL {"probe":"FAIL: ' + why + '"}')
  console.log('PKG_TRANSPARENCY summary FAIL dev=false packaged=false')
  process.exit(1)
}

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// Resolve to an absolute path: a relative NUB_APP_BUNDLE would build
// `file://release/...` (no leading slash) and load as ERR_FAILED, which reads
// like a broken app rather than a bad argv. Resolve, don't assume.
const APP_BUNDLE = path.resolve(process.env.NUB_APP_BUNDLE || '/Applications/Nub Agent.app')
const DEV_URL =
  (process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '') + '/?win=hud#/'
const PKG_URL = 'file://' + path.join(APP_BUNDLE, 'Contents/Resources/app.asar/dist/index.html') + '?win=hud#/'

const SETTLE_MS = 2500
// Blur + RECENT_HOLD_MS (3.5s in HudShell) + slack for the re-render.
const COLLAPSE_WAIT_MS = 8000
// After showInactive() forces the compositor to actually draw, give it a beat.
const CAPTURE_SETTLE_MS = 600
const LOAD_TIMEOUT_MS = 20000

/** Same flags electron/main.cjs uses for the real HUD window. */
function hudWindowOptions(preload) {
  return {
    width: 104,
    height: 104,
    x: 40,
    y: 40,
    title: 'probe',
    backgroundColor: '#00000000',
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: false,
    show: false,
    webPreferences: {
      ...(preload ? { preload } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  }
}

/** Everything that decides whether the window paints a rectangle. */
const INSPECT = `(() => {
  const bg = (el) => (el ? getComputedStyle(el).backgroundColor : 'MISSING')
  const root = document.getElementById('root')
  const hudRoot = document.querySelector('.hud-root')
  const shell = document.querySelector('[data-hud-shell]')
  return {
    href: String(location.href).slice(0, 120),
    search: location.search,
    winParam: new URLSearchParams(location.search).get('win'),
    dataHud: document.documentElement.hasAttribute('data-hud'),
    isHudTruthy: new URLSearchParams(location.search).get('win') === 'hud',
    shellMounted: !!shell,
    bgHtml: bg(document.documentElement),
    bgBody: bg(document.body),
    bgRoot: bg(root),
    bgHudRoot: bg(hudRoot),
    bodyClass: document.body ? document.body.className : 'MISSING',
  }
})()`

/**
 * What the page is ACTUALLY rendering at this instant. Re-read right before
 * capture, because the page can flip between INSPECT and capturePage (a hidden
 * BrowserWindow in dev bounces document.hasFocus() back to true after a JS
 * blur, re-rendering the strip while [data-hud-collapsed] still reads true
 * from the previous frame — a verdict built on the stale INSPECT value would
 * happily report "opaque" on the strip's pixels and label the cause "framed
 * bug", which is wrong and a trap for the next person).
 */
const RENDER_STATE_JS = `(() => {
  const shell = document.querySelector('[data-hud-shell]')
  const orb = document.querySelector('[data-testid="hud-orb"]')
  const thread = document.querySelector('.hud-thread')
  const threadOpacity = thread ? Number(getComputedStyle(thread).opacity) : 0
  return {
    collapsedAttr: shell ? shell.hasAttribute('data-hud-collapsed') : false,
    hasOrb: !!orb,
    hasThread: !!thread,
    threadOpacity,
    documentHasFocus: typeof document !== 'undefined' ? document.hasFocus() : null,
  }
})()`

async function inspectUrl(label, url, preload) {
  const win = new BrowserWindow(hudWindowOptions(preload))
  const out = { label, url: url.slice(0, 120) }
  try {
    await win.loadURL(url)
  } catch (err) {
    out.loadError = String(err && err.message ? err.message : err)
  }
  await new Promise((r) => setTimeout(r, SETTLE_MS))

  // Capture the state the user is actually looking at: the cat docked as the
  // orb. HudShell only docks once unfocused AND idle for RECENT_HOLD_MS, and a
  // hidden window reports document.hasFocus() true and then never receives a
  // real blur — so drive the blur listener, then poll for the dock.
  // Screenshotting frame one measures the expanded bubble, whose dark glass is
  // intentional, which would look like the bug and isn't.
  try {
    await win.webContents.executeJavaScript(
      `(() => { window.dispatchEvent(new Event('blur')); return true })()`,
      true
    )
  } catch (err) {
    out.blurError = String(err && err.message ? err.message : err)
  }
  // Ask the window to give up focus (BrowserWindow#blur, not webContents --
  // webContents has no blur()). Keeps the renderer's focus state honest
  // without stealing focus from whatever app the user is in.
  try {
    if (typeof win.blur === 'function') win.blur()
    else out.blurNativeError = 'win.blur not available'
  } catch (err) {
    out.blurNativeError = String(err && err.message ? err.message : err)
  }
  out.collapsed = await waitForCollapsed(win)

  // THE COMPOSITOR TRAP (cost a whole debugging cycle): this window is created
  // with show:false. A hidden window mounts EXPANDED, because
  // document.hasFocus() is true for a window that was never shown, so
  // HudShell renders the strip. It then collapses in React, the DOM updates,
  // and the probe's polls happily read [data-hud-collapsed] -- but the
  // compositor never draws another frame for a hidden window, so
  // capturePage() returns the STALE pre-collapse strip. Measured pixels then
  // describe a state the user can never see.
  //
  // Fix: show it the way the real app does -- showInactive() (no focus steal)
  // -- which forces a real frame, then settle before capturing.
  try {
    win.showInactive()
  } catch (err) {
    out.showError = String(err && err.message ? err.message : err)
  }
  // Give the compositor a moment to actually paint the collapsed frame.
  await new Promise((r) => setTimeout(r, CAPTURE_SETTLE_MS))

  try {
    Object.assign(out, await win.webContents.executeJavaScript(INSPECT, true))
  } catch (err) {
    out.inspectError = String(err && err.message ? err.message : err)
  }
  // Re-read the actual rendered state RIGHT before the capture, because the
  // page can flip between the earlier INSPECT and the capture (see RENDER_STATE_JS).
  try {
    out.renderedState = await win.webContents.executeJavaScript(RENDER_STATE_JS, true)
  } catch (err) {
    out.renderedStateError = String(err && err.message ? err.message : err)
  }
  // Pixel truth: only a real capture can prove what the compositor painted.
  try {
    const png = (await win.webContents.capturePage()).toPNG()
    const sampled = sampleAlpha(decodePng(png))
    out.pixels = typeof sampled === 'string' ? sampled : sampled.text
    if (typeof sampled === 'string') {
      out.outerOpaque = 'unknown'
      out.frameOpaque = 'unknown'
      out.frameNavy = 'unknown'
      out.catVisible = 'unknown'
    } else {
      out.outerOpaque = sampled.outerOpaque
      out.frameOpaque = sampled.frameOpaque
      out.frameNavy = sampled.frameNavy
      out.centerIsNavy = sampled.centerIsNavy
      out.catVisible = sampled.catVisible
    }
    out.pngBytes = png.length
    if (png.length) fs.writeFileSync('/tmp/nub-hud-capture-' + label + '.png', png)
  } catch (err) {
    out.captureError = String(err && err.message ? err.message : err)
  }
  win.destroy()
  return out
}

/** Poll until the shell reports collapsed (orb) state, or give up with a note. */
async function waitForCollapsed(win) {
  const deadline = Date.now() + COLLAPSE_WAIT_MS
  while (Date.now() < deadline) {
    try {
      const c = await win.webContents.executeJavaScript(
        `(() => { const s = document.querySelector('[data-hud-shell]'); return s ? s.hasAttribute('data-hud-collapsed') : null })()`,
        true
      )
      if (c === true) return true
      if (c === null) return 'no-shell'
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return 'never-collapsed'
}

/**
 * Minimal PNG reader -> RGBA pixels, so we can sample what the COMPOSITOR
 * actually painted.
 *
 * Computed style is NOT evidence. `getComputedStyle(body).backgroundColor`
 * reads `rgba(0, 0, 0, 0)` in both dev and packaged while the user is looking
 * at a dark rectangle, so the whole background chain can be "transparent" and
 * the window can still paint. Only a capture settles it. That discrepancy is
 * the reason this probe exists.
 *
 * Handles 8-bit RGBA (colour type 6); rejects RGB (type 2, never has alpha).
 * No native dep — zlib is built in. The first version only understood filter
 * type 0 and silently returned "unhandled-filter-1" for real captures, i.e. it
 * reported a measurement it never actually took.
 */
function decodePng(buf) {
  if (!buf || buf.length < 33) return { error: 'short-buffer' }
  const colorType = buf[25]
  const bitDepth = buf[24]
  if (bitDepth !== 8) return { error: 'bitDepth-' + bitDepth }
  if (colorType === 2) return { error: 'opaque-format-rgb' }
  if (colorType !== 6) return { error: 'unhandled-colorType-' + colorType }

  let off = 8
  const idat = []
  let width = 0
  let height = 0
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
    }
    if (type === 'IDAT') idat.push(data)
    if (type === 'IEND') break
    off += 12 + len
  }
  if (!idat.length) return { error: 'no-idat' }
  const raw = zlib.inflateSync(Buffer.concat(idat))

  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride) // scanline above; zeros for row 0

  for (let y = 0; y < height; y++) {
    const src = y * (stride + 1)
    if (src + 1 + stride > raw.length) return { error: 'truncated-at-row-' + y }
    const filter = raw[src]
    const cur = raw.subarray(src + 1, src + 1 + stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0 // left
      const b = prev[x] // above
      const c = x >= bpp ? prev[x - bpp] : 0 // upper-left
      let v = cur[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) v += paeth(a, b, c)
      else if (filter !== 0) return { error: 'unhandled-filter-' + filter }
      out[y * stride + x] = v & 0xff
    }
    prev = out.subarray(y * stride, (y + 1) * stride)
  }
  return { width, height, stride, data: out }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Sample pixels that MUST be transparent if the window has no chrome around
 * the cat. The cat itself is opaque and is allowed to be.
 *
 * History of this function: the first version only sampled the four window
 * edges. Those pass even when the orb paints a solid 84x84 navy frame around
 * the cat, because the frame is the same size as the cat and the edges sit
 * in the 10px ring between the frame and the window. The second version added
 * samples at the inner 84x84 box corners; those landed on the cat's own body
 * and reported "opaque" whether the frame existed or not -- i.e. they measured
 * the cat, not the chrome. Neither version could actually answer
 * "is the window chrome-free".
 *
 * What we want is: "are pixels that are not the cat, still inside the window,
 * transparent?" Two rings:
 *   - outerRing  : the 10px band between the 104 window and the 84 cat box.
 *                  Must be transparent. Catches a glass rectangle larger than
 *                  the cat. (Always passed -- but cheap insurance.)
 *   - frameRing  : the 1px band just inside the 84 cat box, at the box
 *                  corners. The `framed` FatCatIcon prop paints MAIA_NAVY
 *                  here; the cat SVG itself does not reach these corners, so
 *                  without `framed` they are transparent. THIS is what catches
 *                  the exact bug the user reported.
 *   - center     : the cat body. Expected opaque -- not used in the verdict,
 *                  reported for the human reader so a "transparent" verdict
 *                  with catVisible=false (a blank window) is still surfaced.
 */
function sampleAlpha(png) {
  if (png.error) return png.error
  const { width, height, stride, data } = png
  const at = (x, y) => {
    const i = y * stride + x * 4
    return [data[i], data[i + 1], data[i + 2], data[i + 3]]
  }
  // Match the real HUD geometry: 104px window, 84px cat centred inside.
  // The capture may be 2x (Retina); scale CSS coords to image pixels.
  const sx = width / 104
  const sy = height / 104
  const px = (x) => Math.max(0, Math.min(width - 1, Math.round(x * sx)))
  const py = (y) => Math.max(0, Math.min(height - 1, Math.round(y * sy)))
  const box = 84
  const cx = px(52)
  const cy = py(52)
  // The `framed` FatCatIcon paints an 84x84 rounded square of MAIA_NAVY with
  // border-radius 18, behind a 76px cat SVG inset by ~4px (the frame ring).
  // Sample that ring at the FLAT midpoint of each edge, not the corners: the
  // corners are cut by the 18px radius and are transparent whether the frame
  // is there or not, so a corner sample silently misses the bug.
  const ringInset = 3 // CSS px inside the 84 box, inside the 18px radius, in the frame ring
  const pts = {
    outerTL: at(px(5), py(5)),
    outerTR: at(px(99), py(5)),
    outerBL: at(px(5), py(99)),
    outerBR: at(px(99), py(99)),
    frameTop: at(cx, py(10 + ringInset)),
    frameBottom: at(cx, py(94 - ringInset)),
    frameLeft: at(px(10 + ringInset), cy),
    frameRight: at(px(94 - ringInset), cy),
    center: at(cx, cy),
  }
  const parts = Object.entries(pts).map(([k, p]) => k + '=' + p.join(','))
  const outerOpaque = ['outerTL', 'outerTR', 'outerBL', 'outerBR']
    .map((k) => pts[k])
    .filter((p) => p[3] === 255).length
  const frameOpaque = ['frameTop', 'frameBottom', 'frameLeft', 'frameRight']
    .map((k) => pts[k])
    .filter((p) => p[3] === 255).length
  // Classify the frame ring by colour, not just opacity. The cat SVG itself
  // fills the 84 box and is opaque in the ring; only the *chip* is navy.
  // MAIA_NAVY is #1a3d6b (26,61,107); the captured chip reads as ~ (35,60,104)
  // after the display profile. Treat any opaque, distinctly-blue, low-red
  // pixel as the chip.
  const isNavy = (p) =>
    p[3] === 255 && p[2] >= 80 && p[2] <= 160 && p[2] > p[0] + 20 && p[0] < 90 && p[1] < 120
  const frameNavy = ['frameTop', 'frameBottom', 'frameLeft', 'frameRight']
    .map((k) => pts[k])
    .filter(isNavy).length
  const centerIsNavy = isNavy(pts.center)
  return {
    text: parts.join(' ') + ' outerOpaque=' + outerOpaque + ' frameOpaque=' + frameOpaque + ' frameNavy=' + frameNavy,
    outerOpaque,
    frameOpaque,
    frameNavy,
    centerIsNavy,
    catVisible: pts.center[3] === 255,
  }
}

async function main() {
  const appExists = fs.existsSync(APP_BUNDLE)
  const preload = path.join(APP_BUNDLE, 'Contents/Resources/app.asar/electron/preload.cjs')
  const results = []

  results.push(await inspectUrl('dev', DEV_URL, null))
  if (appExists) {
    results.push(await inspectUrl('packaged', PKG_URL, fs.existsSync(preload) ? preload : null))
  } else {
    results.push({ label: 'packaged', missingBundle: APP_BUNDLE })
  }

  // A background is only "transparent" if every layer in the chain says so.
  const clear = (v) => typeof v === 'string' && (/^rgba\(0, 0, 0, 0\)$/.test(v) || /^transparent$/i.test(v))
  const chainClear = (r) =>
    r &&
    r.dataHud === true &&
    r.shellMounted === true &&
    clear(r.bgHtml) &&
    clear(r.bgBody) &&
    clear(r.bgRoot) &&
    clear(r.bgHudRoot)

  // Computed style alone is NOT sufficient: every layer can read
  // rgba(0,0,0,0) while the compositor still paints an opaque rectangle. The
  // capture is the authority; the CSS chain is diagnostic detail for when it
  // is opaque. A probe that would pass on CSS alone is the bug this one is for.
  //
  // "Transparent" here means: the WINDOW has no opaque chrome around the cat.
  // The cat itself is allowed to be opaque. So pixelOk is satisfied when the
  // outer ring and the frame ring are both fully transparent, regardless of
  // what the cat body does. catVisible is reported alongside so a blank
  // window is still surfaced.
  //
  // "In the orb" is decided by the CAPTURE-TIME render read, not the older
  // `waitForCollapsed` poll: a hidden dev window can bounce focus back to the
  // strip between the poll and the capture, leaving a stale `collapsed=true`
  // that would then be applied to strip pixels and mis-diagnosed as the framed
  // bug. The capture-time read is the truth at the moment of capture.
  const verdict = {}
  const verdictPass = {}
  for (const r of results) {
    const cssOk = chainClear(r)
    const outerUnknown = typeof r.outerOpaque !== 'number'
    const frameUnknown = typeof r.frameNavy !== 'number'
    const rs = r.renderedState || {}
    // The page is in the orb state if the shell has the collapsed attribute
    // AND the orb testid is present AND the thread bubble is hidden.
    const inOrb =
      rs.collapsedAttr === true &&
      rs.hasOrb === true &&
      (rs.threadOpacity === 0 || rs.hasThread === false)
    // "Transparent" = no navy chip. frameOpaque may legitimately be 4 (the
    // cat itself fills the 84 box and is opaque, and that is fine); what we
    // are hunting is the navy MAIA_NAVY chip behind it. frameNavy counts only
    // opaque AND navy samples, so a clean cat (cat-body opaque, no chip)
    // passes and a `framed` chip (navy everywhere in the ring) fails.
    const pixelOk =
      !outerUnknown &&
      !frameUnknown &&
      r.outerOpaque === 0 &&
      r.frameNavy === 0 &&
      inOrb
    const detail = [
      r.missingBundle ? 'bundle missing at ' + r.missingBundle : '',
      r.loadError ? 'loadError=' + r.loadError : '',
      r.inspectError ? 'inspectError=' + r.inspectError : '',
      r.renderedStateError ? 'renderedStateError=' + r.renderedStateError : '',
      r.captureError ? 'captureError=' + r.captureError : '',
      r.blurNativeError ? 'nativeBlurError=' + r.blurNativeError : '',
      outerUnknown
        ? 'outer-ring pixel evidence MISSING (' + (r.pixels || 'no capture') + ')'
        : 'outer-ring opaque=' + r.outerOpaque + '/4',
      frameUnknown
        ? 'frame-ring pixel evidence MISSING'
        : 'frame-ring navy=' + r.frameNavy + '/4 (chip would show here); opaque-any=' + r.frameOpaque + '/4 (the cat counts)',
      !inOrb
        ? 'NOT in orb at capture time: ' +
          JSON.stringify(rs) +
          ' (stale poll said: ' +
          r.collapsed +
          ')'
        : '',
      r.dataHud === false ? 'data-hud NOT set (win=' + r.winParam + ')' : '',
      r.shellMounted === false ? 'HudShell did not mount' : '',
      r.bgHtml && !clear(r.bgHtml) ? 'html=' + r.bgHtml : '',
      r.bgBody && !clear(r.bgBody) ? 'body=' + r.bgBody : '',
      r.bgRoot && !clear(r.bgRoot) ? '#root=' + r.bgRoot : '',
      r.bgHudRoot && !clear(r.bgHudRoot) ? '.hud-root=' + r.bgHudRoot : '',
      r.catVisible === false ? 'cat body not visible at center -- blank window' : '',
      // NOT proof of the chip: MAIA_NAVY (the chip) and GROK_EYE (the cat's
      // eyes) are both #1a3d6b, so a navy centre can be an eye on a perfectly
      // transparent window. Diagnostic only -- never used in the verdict.
      r.centerIsNavy === true
        ? 'center is navy (ambiguous: chip AND cat eye are both #1a3d6b)'
        : '',
    ].filter(Boolean)
    const ok = cssOk && pixelOk
    verdictPass[r.label] = ok
    verdict[r.label] = ok
      ? 'transparent (cat visible: ' + r.catVisible + ')'
      : 'OPAQUE: ' + (detail.join('; ') || 'css chain not clear')
  }

  // Track pass/fail with a boolean. The earlier version compared the verdict
  // STRING to the literal 'transparent' and reported FAIL on
  // 'transparent (cat visible: true)' -- i.e. it failed on success.
  const failed = Object.values(verdictPass).some((v) => v !== true)
  for (const r of results) {
    console.log('  [' + r.label + '] ' + JSON.stringify(r))
  }
  console.log('PKG_TRANSPARENCY done ' + (failed ? 'FAIL' : 'ok') + ' ' + JSON.stringify(verdict))
  console.log(
    'PKG_TRANSPARENCY summary ' +
      (failed ? 'FAIL' : 'ok') +
      ' dev=' +
      (verdictPass.dev === true) +
      ' packaged=' +
      (verdictPass.packaged === true)
  )
  return failed ? 1 : 0
}

// Hard ceiling so a hung renderer reports FAIL instead of hanging the run.
// Two windows: each (load + settle + show + capture) must complete.
const HARD_TIMEOUT_MS = (LOAD_TIMEOUT_MS + SETTLE_MS + COLLAPSE_WAIT_MS + CAPTURE_SETTLE_MS) * 2 + 5000

// Electron quits implicitly once the last window is closed, unless something
// subscribes to this event. The probe destroys each probe window as it goes,
// so without this the process dies mid-run with exit 0 and no output at all --
// which is precisely the "passes on failure" shape this repo exists to kill.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const hardTimer = setTimeout(() => {
    console.log('PKG_TRANSPARENCY done FAIL {"probe":"FAIL: hard timeout"}')
    console.log('PKG_TRANSPARENCY summary FAIL dev=false packaged=false')
    setTimeout(() => app.exit(1), 200)
  }, HARD_TIMEOUT_MS)
  let code = 1
  try {
    code = await main()
  } catch (err) {
    // Never let a thrown error look like a clean exit.
    console.log(
      'PKG_TRANSPARENCY done FAIL {"probe":"FAIL: threw ' +
        String((err && err.message) || err).replace(/"/g, "'") +
        '"}'
    )
    console.log('PKG_TRANSPARENCY summary FAIL dev=false packaged=false')
    code = 1
  }
  clearTimeout(hardTimer)
  // app.exit() tears the process down before stdout is flushed when the output
  // is a pipe, which silently swallows every line above. Yield first.
  setTimeout(() => app.exit(code), 200)
})
