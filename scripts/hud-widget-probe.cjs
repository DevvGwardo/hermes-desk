'use strict'
/**
 * hud-widget-probe.cjs — live proof that the mascot widget actually PAINTS.
 *
 * The act probe (hud-act-probe.cjs) proves the screen-ACTION path is honest.
 * This one proves the thing the user actually looks at: that the HUD window
 * mounts HudShell, draws the nubcat, paints no glass rectangle behind it, and
 * expands into the speech bubble when the cat is clicked.
 *
 * Those properties are exactly the ones a unit test CANNOT prove. jsdom has no
 * compositor, so `background: transparent` and "did the SVG mascot really
 * rasterise" are invisible to vitest — a regression that paints an opaque
 * black box over the whole 104x104 orb would pass every existing test in the
 * repo and look completely broken on screen.
 *
 * Needs the Vite dev server (the HUD renderer comes from it):
 *   npx vite --host 127.0.0.1 --port 5173 --strictPort
 *
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/hud-widget-probe.cjs \
 *        --no-sandbox --user-data-dir=/tmp/nub-widget-probe
 *
 * One line of output: `WIDGET_PROBE done ok {...}` / `... FAIL {...}`.
 * Exit 0 / 1 accordingly.
 */
const electron = require('electron')
const { app, BrowserWindow } = electron

// This script is a MAIN PROCESS, so it must be launched BY electron
// (`npx electron scripts/hud-widget-probe.cjs`), never by node. Run under
// node it used to die three frames later with
//   TypeError: Cannot read properties of undefined (reading 'whenReady')
// which names the symptom and not the cause. Worse, if ELECTRON_RUN_AS_NODE
// is set, `require('electron')` is not even an object — it is the path string
// to the binary — so the destructure above silently yields two undefineds.
// Fail loudly here instead, so the one line of output says what to do.
if (!app || typeof app.whenReady !== 'function') {
  // NB: single quotes only in this prose. The line is shaped as JSON and an
  // unescaped double quote inside it makes the whole record unparseable --
  // which is how the first version of this guard shipped.
  const why = typeof electron === 'string'
    ? (process.env.ELECTRON_RUN_AS_NODE
        ? "ELECTRON_RUN_AS_NODE is set, so require('electron') returned the binary path, not the API"
        // Reachable too: bare `node <script>` outside Electron gets the same
        // path string with NO env var set, and blaming a variable the runner
        // just unset sends them chasing a cause that is not there.
        : "require('electron') returned the binary path string, not the API")
    : 'this script is not running as an Electron main process'
  console.log(
    'WIDGET_PROBE done FAIL {"probe":"FAIL: ' + why +
      ' — run it as: env -u ELECTRON_RUN_AS_NODE npx electron scripts/hud-widget-probe.cjs --no-sandbox --user-data-dir=/tmp/nub-widget-probe"}'
  )
  console.log('WIDGET_PROBE summary FAIL mounted=false mascot=false transparent=false expand=false')
  process.exit(1)
}

const DEV_SERVER = (process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '')
const ORB_SIZE = 104
const LOAD_TIMEOUT_MS = 20000
const SETTLE_MS = 600
// Blur + RECENT_HOLD_MS (3.5s) + slack for the re-render.
const COLLAPSE_WAIT_MS = 7000
const HARD_TIMEOUT_MS = 45000

const results = {}
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

/**
 * Read the four properties that decide whether the widget LOOKS right.
 * Runs in the renderer, so it sees real computed style from the compositor.
 */
const INSPECT = `(() => {
  const shell = document.querySelector('[data-hud-shell]')
  if (!shell) return { mounted: false }
  const root = document.querySelector('.hud-root')
  const orb = document.querySelector('[data-testid="hud-orb"]')
  const bg = root ? getComputedStyle(root).backgroundColor : 'no-root'
  return {
    mounted: true,
    collapsed: shell.hasAttribute('data-hud-collapsed'),
    orb: !!orb,
    mascotSvgs: orb ? orb.querySelectorAll('svg').length : 0,
    orbBox: orb ? { w: Math.round(orb.getBoundingClientRect().width),
                    h: Math.round(orb.getBoundingClientRect().height) } : null,
    rootBackground: bg,
    bubble: !!document.querySelector('[data-testid="hud-bubble"]'),
    input: !!document.querySelector('.hud-input'),
  }
})()`

const CLICK_ORB = `(() => {
  const orb = document.querySelector('[data-testid="hud-orb"]')
  if (!orb) return false
  orb.click()
  return true
})()`

/**
 * The cat is the RESTING state, not the opening one: a window that has focus
 * opens as the strip, and HudShell only docks once it is unfocused AND idle
 * for RECENT_HOLD_MS (3.5s). A hidden window may report hasFocus() true and
 * then never receive a real blur, so drive the actual blur listener instead
 * of waiting for a focus change that will not come.
 */
const BLUR = `(() => { window.dispatchEvent(new Event('blur')); return true })()`

/** Poll until the cat has docked, or give up. */
async function waitForOrb(win) {
  const deadline = Date.now() + COLLAPSE_WAIT_MS
  let last = null
  while (Date.now() < deadline) {
    last = await win.webContents.executeJavaScript(INSPECT)
    if (last.orb) return last
    await sleep(250)
  }
  return last
}

async function main() {
  await app.whenReady()

  const win = new BrowserWindow({
    width: ORB_SIZE,
    height: ORB_SIZE,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    webPreferences: { offscreen: false },
  })

  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('load timed out')), LOAD_TIMEOUT_MS)
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  const url = `${DEV_SERVER}/?win=hud#/`
  await win.loadURL(url)
  await loaded
  // React mounts after did-finish-load; give it a beat to paint.
  await sleep(SETTLE_MS)

  const first = await win.webContents.executeJavaScript(INSPECT)

  if (!first.mounted) {
    fail('mounted', 'no [data-hud-shell] in the HUD renderer')
    win.destroy()
    return
  }
  pass('mounted', `HudShell mounted (collapsed on first paint: ${first.collapsed})`)

  // Dock to the cat through the real collapse path, then measure it.
  await win.webContents.executeJavaScript(BLUR)
  const orbState = first.orb ? first : await waitForOrb(win)

  if (!orbState || !orbState.orb) {
    fail('orb', 'the mascot orb never rendered')
  } else if (orbState.mascotSvgs < 1) {
    fail('mascot', 'orb rendered but contains no mascot SVG')
  } else {
    pass('mascot', `orb drew ${orbState.mascotSvgs} mascot SVG(s) at ${orbState.orbBox.w}x${orbState.orbBox.h}`)
  }

  // The whole point of the transparent-window work: no glass rectangle.
  const bg = String(first.rootBackground || '')
  const opaque = bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'
  if (opaque) {
    fail('transparent', `hud-root paints an opaque background: ${bg}`)
  } else {
    pass('transparent', 'hud-root paints no background')
  }

  // Clicking the cat must open the anchored speech bubble.
  const clicked = await win.webContents.executeJavaScript(CLICK_ORB)
  if (!clicked) {
    fail('expand', 'no orb to click')
  } else {
    await sleep(SETTLE_MS)
    const after = await win.webContents.executeJavaScript(INSPECT)
    if (!after.bubble) {
      fail('expand', 'clicking the cat did not open the speech bubble')
    } else if (!after.input) {
      fail('expand', 'bubble opened but has no composer input')
    } else {
      pass(
        'expand',
        'cat click opened the speech bubble + composer'
      )
    }
  }

  win.destroy()
}

const hardStop = setTimeout(() => {
  fail('timeout', `probe exceeded ${HARD_TIMEOUT_MS}ms`)
  console.log(`WIDGET_PROBE done FAIL ${JSON.stringify(results)}`)
  app.exit(1)
}, HARD_TIMEOUT_MS)

main()
  .catch((err) => {
    fail('probe', err && err.message ? err.message : String(err))
  })
  .finally(() => {
    clearTimeout(hardStop)
    console.log(`WIDGET_PROBE done ${failed ? 'FAIL' : 'ok'} ${JSON.stringify(results)}`)
    // A field that was never measured must not read as green: `!undefined`
    // would otherwise report mascot=true on a run where the orb never
    // rendered, which is the exact "passes on failure" shape this repo keeps
    // having to stamp out.
    const isOk = (field) =>
      Object.prototype.hasOwnProperty.call(results, field) &&
      !String(results[field]).startsWith('FAIL')
    console.log(
      `WIDGET_PROBE summary ${failed ? 'FAIL' : 'ok'} mounted=${isOk('mounted')} ` +
        `mascot=${isOk('mascot')} transparent=${isOk('transparent')} expand=${isOk('expand')}`
    )
    setTimeout(() => app.exit(failed ? 1 : 0), 200)
  })
