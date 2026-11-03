const nativeQualification = require('./self-modification-native-mode.cjs').current()
const { app, BrowserWindow, Menu, shell, ipcMain, dialog, screen, globalShortcut, systemPreferences, Tray, nativeImage, nativeTheme, desktopCapturer, session, clipboard } = require('electron')
const { Notification, WebContentsView, protocol } = require('electron')
const path = require('path')
const sttLocal = require('./stt-local.cjs')
const secretsOp = require('./secrets-op.cjs')
const fsAccess = require('./fs-access.cjs').createFsAccess({
  protectedRoots: [path.resolve(__dirname, '..'), app.getPath('userData')],
})
const validateFsPath = (value, label) => fsAccess.validate(value, label)
const defaultFsRoot = () => fsAccess.root()
const allowedFsRoots = () => fsAccess.roots()
const { cliPlan } = require('./cli-policy.cjs')
const { runBoundedCli } = require('./bounded-cli.cjs')
const confirmPrivileged = require('./security-consent.cjs').createConsent({
  dialog, getWindow: sender => [mainWindow, hudWindow].find(win =>
    win && !win.isDestroyed() && win.webContents === sender),
})
const consentHudAction = require('./hud-action-consent.cjs').createHudActionConsent({ confirm: confirmPrivileged })
const { readFileBounded } = require('./fs-read.cjs')
const mediaFiles = require('./media-protocol.cjs').createMediaProtocol()
const nativeFiles = require('./native-files.cjs').createNativeFiles({ dialog, getMainWindow: () => mainWindow })
const binGuard = require('./bin-guard.cjs')
const agentEnv = require('./agent-env.cjs')
const serveAuth = require('./serve-auth.cjs')
const hudState = require('./hud-state.cjs')
const hudActGate = require('./hud-act-gate.cjs')
const screenAct = require('./screen-act.cjs')
const screenSee = require('./screen-see.cjs')
const hudActivity = require('./hud-activity-relay.cjs')
const systemNotify = require('./system-notify.cjs')
const vmNavGuard = require('./vm-nav-guard.cjs')
const { installAppMenu: installAppMenuImpl, trayTemplate } = require('./app-menu.cjs')

if (!nativeQualification) protocol?.registerSchemesAsPrivileged([
  { scheme: 'hd-candidate', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'hd-avatar', privileges: { standard: true, secure: true } },
  { scheme: 'hd-media', privileges: { standard: true, secure: true, stream: true } },
])

// D-07 (red-team sweep 5): a packaged app must never honor MAIA_ELECTRON_DEV
// / VITE_DEV_SERVER_URL — local env (launchctl, ~/.zshenv, LSEnvironment) is
// attacker-influenceable and would substitute the renderer origin with full
// preload IPC. Dev-server loads require BOTH unpackaged AND the env flag,
// or an explicit --enable-packaged-dev argv escape hatch for local debugging
// of packaged builds.
const packagedDevAllowed = process.argv.includes('--enable-packaged-dev')
const isDev = !nativeQualification && (!app.isPackaged || (packagedDevAllowed && process.env.MAIA_ELECTRON_DEV === '1'))
const e2eBackground = !app.isPackaged && process.env.HERMES_DESK_E2E_BACKGROUND === '1'
if (e2eBackground) app.on('browser-window-created', (_event, win) => {
  // macOS may pull an off-screen parent back when laying out its child overlay.
  // Window opacity does not affect webContents captures, so nothing reaches the
  // user's desktop even when native window geometry is clamped.
  win.setOpacity(0)
  win.setFocusable(false)
})

function parseHttpUrl(url) {
  if (typeof url !== 'string') return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed
  } catch {
    return null
  }
}

/** Chat / window.open: https, plus http localhost in dev. No file:/javascript:/data:. */
function isBrowserSafeExternalUrl(url) {
  const parsed = parseHttpUrl(url)
  if (!parsed) return false
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol === 'http:') {
    return isDev && (host === 'localhost' || host === '127.0.0.1')
  }
  return parsed.protocol === 'https:'
}

// A closed stdout/stderr pipe (launcher shell exited, terminal gone, pipe
// reader died) makes any console write / process warning throw EPIPE, which
// Electron surfaces as an "Uncaught Exception" dialog. A broken pipe is not
// fatal — swallow it. Without a listener the 'error' event escapes and the
// whole app dies with a scary dialog on an unrelated refresh.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') return
    throw err
  })
}

// Belt and braces: never let a stray exception (e.g. a warning-write failure)
// kill the app with a crash dialog. Log loudly and keep running.
process.on('uncaughtException', (err) => {
  try {
    console.error('[main] uncaught exception:', err && err.stack ? err.stack : err)
  } catch {
    /* ignore — console itself may be broken */
  }
})

/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {BrowserWindow | null} */
let hudWindow = null
/** Orb-collapse state: anchor holds the last expanded SIZE for re-opening. */
let hudCollapse = { collapsed: false, anchor: null }
/** Mirror of the persisted state: expanded strip bounds + orb (cat) position. */
let hudSavedState = { expanded: null, orb: null }

/* ── Commanded movement — Clippy-accurate moveTo/gestureAt ──────────────
 * The cat NEVER moves on its own. It walks only when asked:
 *   maia:hud:moveTo {x,y} — programmatic (agent/computer-use ready)
 *   maia:hud:goToCursor   — Alt+click provocation ("come to my cursor")
 * While walking, the mascot carries a pointer aimed at the target
 * (maia:hud:pointer {phase:'walk'|'point'|'none', angle}); on arrival it
 * point-pulses (gestureAt) so you can see where it intends to act. */
let hudWalkTimer = null
let hudWalkTarget = null
let hudPointTimer = null
let hudSuppressOwnMoveUntil = 0
let hudUserDragging = false
let hudUserDragSettleTimer = null
/** Pending arrival callback ({ cb, cancel }) — [CLICK:] waits for the walk. */
let hudWalkArrive = null
const WALK_STEP_MS = 40
const WALK_EASE = 0.12
const POINT_HOLD_MS = 900
/** Clearance between the cat's rect and the pixel it is about to click: the
 *  cat must never sit ON its own target, or the injected click hits the HUD. */
const ACT_CLEARANCE = 14
/** Beat between the arrival point-pulse and the click, so the user sees the
 *  aim before the act. */
const CLICK_SETTLE_MS = 160

const HUD_WIDTH = 620
const HUD_HEIGHT = 340
// Clicky-mode: the expanded HUD is a compact speech bubble above the cat.
const BUBBLE_WIDTH = 360
const BUBBLE_HEIGHT = 300
// Single source for the minimums — hud-state.cjs clamps restored saves to these.
const { HUD_MIN_WIDTH, HUD_MIN_HEIGHT, ORB_SIZE } = hudState

/**
 * Global HUD hotkey — the ONLY owner of this combo, and the reason the Window
 * menu below advertises the shortcut in its LABEL instead of registering a
 * menu accelerator: globalShortcut does not swallow the app-level key event,
 * so a menu item bound to the same combo fires IN ADDITION to the global one
 * whenever Nub is frontmost. Two toggles per keypress meant ⌘⇧H could open
 * the orb but never close it (close → immediately re-open: see
 * toggleHudWindow, whose "not visible" branch calls createHudWindow → show).
 * The renderer used to own a duplicate ⌘⇧H handler for the same reason.
 */
const HUD_SHORTCUT = process.platform === 'darwin' ? 'Command+Shift+H' : 'Control+Shift+H'
/** Human-readable form for menus and tooltips. Never fed to an accelerator. */
const HUD_SHORTCUT_LABEL = process.platform === 'darwin' ? '⌘⇧H' : 'Ctrl+Shift+H'
/** Mirrors HUD visibility so the Window menu can say Show vs Hide. */
let hudMenuOpen = false
/** Menu-bar Tray (declared out of scope before 2026-08-29; now shipped). */
let hudTray = null
/** Set when the app is quitting so 'closed' teardown cannot clobber the
 * persisted open flag the orb needs to auto-restore (see setHudOpenState). */
let hudQuitting = false

function hudUrl() {
  // Smoke tests the main-process window lifecycle only — never load the real
  // renderer (a live dev server would mount HudShell and collapse the window
  // mid-test, racing the assertions).
  if (process.env.NUB_SMOKE_HUD === '1' || process.env.NUB_SMOKE) return 'about:blank'
  if (isDev) {
    const base = (process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '')
    return `${base}/?win=hud#/`
  }
  return `file://${path.join(__dirname, '..', 'dist', 'index.html')}?win=hud#/`
}

/**
 * One permission policy for the shared default session (sweep 3, F-3). Both
 * windows share it, so the handler decides per requesting webContents: the
 * HUD gets mic audio only (dictation via local whisper), everything else —
 * the main window included — is denied. The check handler mirrors it, so a
 * permission check can't report "granted" where a request would be refused.
 */
function hudMayUseMic(wc, permission, mediaTypes) {
  if (!hudWindow || hudWindow.isDestroyed() || wc !== hudWindow.webContents) return false
  if (permission !== 'media') return false
  const types = Array.isArray(mediaTypes) ? mediaTypes : []
  return types.includes('audio') && !types.includes('video')
}

const permissionPolicySessions = new WeakSet()
function installPermissionPolicy(ses) {
  if (!ses || permissionPolicySessions.has(ses)) return
  try {
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      callback(hudMayUseMic(wc, permission, details && details.mediaTypes))
    })
    ses.setPermissionCheckHandler((wc, permission, _origin, details) => {
      const mediaType = details && details.mediaType
      return hudMayUseMic(wc, permission, mediaType ? [mediaType] : [])
    })
    permissionPolicySessions.add(ses)
  } catch {}
}

function createHudWindow() {
  if (hudWindow && !hudWindow.isDestroyed()) {
    // Re-show without stealing focus (widget summon, not an app switch).
    hudWindow.showInactive()
    // Re-showing an existing window skips the loadURL path below, so the menu
    // label has to be corrected here or it keeps saying "Show" over an orb
    // that is already on screen.
    setHudOpenState(true)
    return hudWindow
  }
  // Mascot-widget restore: if the cat has a saved spot, the window IS the orb
  // from creation (zero strip flash); otherwise restore the strip bounds.
  const hudStateFile = hudState.hudStatePath(app.getPath('userData'))
  const savedState = hudState.loadHudState(fsSync.readFileSync, hudStateFile)
  const savedExpanded = savedState && savedState.expanded
    ? hudState.clampHudBounds(savedState.expanded, screen, { width: HUD_WIDTH, height: HUD_HEIGHT })
    : null
  const savedOrb = savedState && savedState.orb
    ? hudState.clampOrbPosition(savedState.orb, screen)
    : null
  hudSavedState = { expanded: savedExpanded, orb: savedOrb, open: savedState ? savedState.open : undefined }
  hudCollapse = savedOrb
    ? { collapsed: true, anchor: savedExpanded }
    : { collapsed: false, anchor: null }
  const hudBounds = savedOrb
    ? { x: savedOrb.x, y: savedOrb.y, width: ORB_SIZE, height: ORB_SIZE }
    : (savedExpanded ?? { width: HUD_WIDTH, height: HUD_HEIGHT })
  hudWindow = new BrowserWindow({
    ...hudBounds,
    minWidth: HUD_MIN_WIDTH,
    minHeight: HUD_MIN_HEIGHT,
    title: 'Nub — HUD',
    backgroundColor: '#00000000',
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    // No native vibrancy — free-float: the CHARACTER is the only visible thing.
    // The expanded strip carries its own CSS glass backdrop; the orb must be
    // fully transparent so nothing but the cat shows.
    webPreferences: {
      preload: path.join(__dirname, 'hud-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      // Same explicit lockdown as the main window (see createWindow).
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  })
  // The HUD never opens external content: deny every new window (main's
  // setWindowOpenHandler stays the sole path to external https).
  hudWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  hudWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
  installPermissionPolicy(hudWindow.webContents.session)
  // Click-through transparent-by-default: at creation the window is all
  // transparent padding around the cat; the renderer's mouseover hit-testing
  // re-enables mouse events over solid elements (bubble, orb, inputs).
  try {
    hudWindow.setIgnoreMouseEvents(true, { forward: true })
  } catch {}
  if (process.platform === 'darwin') {
    try {
      hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      hudWindow.setAlwaysOnTop(true, 'floating')
    } catch {}
  } else {
    try {
      hudWindow.setAlwaysOnTop(true, 'screen-saver')
    } catch {}
  }
  // Persist state: debounced on move/resize, immediate on close.
  // Collapsed saves the CAT position; expanded saves the full strip bounds.
  let hudSaveTimer = null
  const saveHudStateNow = () => {
    if (hudSaveTimer) {
      clearTimeout(hudSaveTimer)
      hudSaveTimer = null
    }
    if (!hudWindow || hudWindow.isDestroyed()) return
    try {
      const b = hudWindow.getBounds()
      if (hudCollapse.collapsed) {
        hudSavedState.orb = { x: b.x, y: b.y }
      } else {
        hudSavedState.expanded = b
      }
      hudState.persistHudState(fsSync.writeFileSync, hudStateFile, hudSavedState)
    } catch {}
  }
  const scheduleHudSave = () => {
    if (hudSaveTimer) clearTimeout(hudSaveTimer)
    hudSaveTimer = setTimeout(saveHudStateNow, 500)
  }
  hudWindow.on('resize', scheduleHudSave)
  hudWindow.on('move', () => {
    // Distinguish user drags from our own roam setPosition: our moves are
    // suppressed from triggering drag detection; everything else is a user drag.
    if (Date.now() > hudSuppressOwnMoveUntil) {
      hudUserDragging = true
      stopHudWalk()
    }
    scheduleHudSave()
  })
  hudWindow.on('move', () => {
    // settle: if no move event for 600ms, user released → resume roam
    clearTimeout(hudUserDragSettleTimer)
    hudUserDragSettleTimer = setTimeout(() => {
      hudUserDragging = false
    }, 600)
  })
  hudWindow.on('close', saveHudStateNow)
  // Widget summon: appear without stealing focus from the app behind it.
  hudWindow.once('ready-to-show', () => {
    if (hudWindow && !hudWindow.isDestroyed()) {
      hudWindow.showInactive()
    }
  })
  hudWindow.on('closed', () => {
    stopHudWalk()
    hudWindow = null
    setHudOpenState(false)
  })
  // D-04: VM content must never top-navigate the HUD window off the app.
  hudWindow.webContents.on('will-navigate', vmNavGuard.willNavigateGuard((url) => url === hudUrl()))
  hudWindow.webContents.on('will-redirect', vmNavGuard.willNavigateGuard((url) => url === hudUrl()))
  hudWindow.loadURL(hudUrl())
  setHudOpenState(true)
  return hudWindow
}

function hudBoundsClamped(x, y) {
  const wa = screen.getDisplayMatching({ x, y, width: ORB_SIZE, height: ORB_SIZE }).workArea
  return {
    x: Math.min(Math.max(x, wa.x), wa.x + wa.width - ORB_SIZE),
    y: Math.min(Math.max(y, wa.y), wa.y + wa.height - ORB_SIZE),
    wa,
  }
}

function hudSendPointer(phase, angle) {
  if (hudWindow && !hudWindow.isDestroyed()) {
    try { hudWindow.webContents.send('maia:hud:pointer', { phase, angle }) } catch {}
  }
}

/** Angle (atan2) from the window's center to the walk target. */
function hudWalkAngle(b) {
  if (!hudWalkTarget) return 0
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  return Math.atan2(hudWalkTarget.y + ORB_SIZE / 2 - cy, hudWalkTarget.x + ORB_SIZE / 2 - cx)
}

/** Command the cat to walk to a screen point (clamped). The ONLY mover.
 *  `onArrive` (optional) fires once on arrival — [CLICK:] uses it to act only
 *  after the cat is standing beside the target with its pointer out. */
function hudMoveTo(x, y, onArrive) {
  if (!hudWindow || hudWindow.isDestroyed()) return { ok: false }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false }
  // An explicit command overrides any transient drag flag (e.g. setBounds
  // churn right before the command). A real user drag mid-walk re-flags it.
  hudUserDragging = false
  if (hudUserDragSettleTimer) {
    clearTimeout(hudUserDragSettleTimer)
    hudUserDragSettleTimer = null
  }
  const clamped = hudBoundsClamped(Math.round(x), Math.round(y))
  stopHudWalk()
  hudWalkArrive = typeof onArrive === 'function' ? { cb: onArrive, cancel: null } : null
  hudWalkTarget = { x: clamped.x, y: clamped.y }
  hudSendPointer('walk', hudWalkAngle(hudWindow.getBounds()))
  stepHudWalk()
  return { ok: true, x: clamped.x, y: clamped.y }
}

/**
 * Where the cat should STAND to act on (x, y). It has to be off the target:
 * the orb is a solid (non-click-through) rect, so a cat parked on the pixel
 * would swallow its own injected click. Up-left of the target is the Clicky
 * look (cat beside the thing, pointer aimed down-right at it); if clamping
 * pushes it back onto the target — target near the screen's top-left corner —
 * flip to down-right instead.
 */
function hudParkBeside(x, y) {
  const candidates = [
    { x: x - ORB_SIZE - ACT_CLEARANCE, y: y - ORB_SIZE - ACT_CLEARANCE },
    { x: x + ACT_CLEARANCE, y: y + ACT_CLEARANCE },
  ]
  let first = null
  for (const c of candidates) {
    const p = hudBoundsClamped(c.x, c.y)
    if (!first) first = p
    const covers = x >= p.x && x <= p.x + ORB_SIZE && y >= p.y && y <= p.y + ORB_SIZE
    if (!covers) return p
  }
  // Tiny/degenerate display: every legal spot overlaps. Take the first anyway
  // rather than refusing to act.
  return first || { x, y }
}

/**
 * Whether this process may inject input at all. macOS DROPS posted CGEvents
 * from untrusted clients silently (osascript still exits 0), so without this
 * [CLICK:] and [TYPE:] would report success while doing nothing.
 */
function hudActTrusted() {
  if (process.platform !== 'darwin') return true
  try {
    return Boolean(systemPreferences.isTrustedAccessibilityClient(false))
  } catch {
    // API unavailable in this Electron build. Attempting is still the right
    // call, but claiming `true` would assert a permission we never checked —
    // and an unchecked `true` is indistinguishable from a landed event, since
    // an untrusted CGEvent is dropped while osascript still exits 0.
    return screenAct.UNKNOWN_TRUST
  }
}

/** Click a screen point: walk the cat beside it, point, then click it. */
function hudClickAt(x, y, authorize = async () => false) {
  const point = screenAct.normalizePoint(x, y)
  if (!point) return Promise.resolve({ ok: false, error: 'bad-coords' })
  if (!hudWindow || hudWindow.isDestroyed()) return Promise.resolve({ ok: false, error: 'hud-closed' })
  // D-03 (red team sweep 5, option c): never act while the cat is collapsed
  // to the orb — the user is not looking at it, so the act would land
  // unattended. Extracted gate so the refusal is behavior-tested, not
  // text-pinned.
  const visibility = hudActGate.hudActVisibilityGate(hudCollapse.collapsed)
  if (!visibility.allowed) {
    return Promise.resolve({ ok: false, error: visibility.error, hint: visibility.hint })
  }

  const status = screenAct.actStatus({ platform: process.platform, isTrusted: hudActTrusted })
  // Fail-closed: only an explicit `true` (the OS confirmed trust) may act.
  // 'unknown' (probe threw/unsupported) still attempts inside screen-act, but
  // a dropped CGEvent is indistinguishable from a landed one — main never
  // promises a click it cannot verify.
  if (status.trusted !== true) {
    return Promise.resolve({
      ok: false,
      error: 'accessibility-not-trusted',
      hint: screenAct.ACCESS_HINT,
      x: point.x,
      y: point.y,
    })
  }

  return new Promise((resolve) => {
    const finish = (res) => resolve(res)
    const park = hudParkBeside(point.x, point.y)
    const moved = hudMoveTo(park.x, park.y, () => {
      // Let the point-pulse land before the click so the aim is visible.
      setTimeout(async () => {
        if (!await authorize() || !hudActGate.hudActVisibilityGate(hudCollapse.collapsed).allowed) {
          resolve({ ok: false, error: 'action-no-longer-authorized' })
          return
        }
        const res = screenAct.clickAt(point.x, point.y, {
          platform: process.platform,
          isTrusted: hudActTrusted,
        })
        if (!res.ok) console.warn('[hud] clickAt failed:', res.error, res.errors || res.hint || '')
        finish(res)
      }, CLICK_SETTLE_MS)
    })
    if (!moved || !moved.ok) {
      finish({ ok: false, error: 'move-rejected', x: point.x, y: point.y })
      return
    }
    // Still walking: a drag/close/expand that cancels it cancels the click too.
    if (hudWalkArrive) {
      hudWalkArrive.cancel = () => finish({ ok: false, error: 'walk-cancelled', x: point.x, y: point.y })
    }
  })
}

function stepHudWalk() {
  if (!hudWindow || hudWindow.isDestroyed() || !hudWalkTarget) return
  if (hudUserDragging) { stopHudWalk(); return }
  const b = hudWindow.getBounds()
  const dx = hudWalkTarget.x - b.x
  const dy = hudWalkTarget.y - b.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist < 2) {
    const arrivedAngle = hudWalkAngle(b)
    hudWalkTarget = null
    persistOrbPos(b.x, b.y)
    // gestureAt: point-pulse at the destination, then fade the pointer out.
    hudSendPointer('point', arrivedAngle)
    if (hudPointTimer) clearTimeout(hudPointTimer)
    hudPointTimer = setTimeout(() => hudSendPointer('none', 0), POINT_HOLD_MS)
    // Arrival is the act trigger: [CLICK:] clicks only now, from beside the
    // target, with the pointer already out.
    if (hudWalkArrive) {
      const arrive = hudWalkArrive
      hudWalkArrive = null
      try { arrive.cb({ x: b.x, y: b.y }) } catch {}
    }
    return
  }
  // Minimum 1px step: rounding would otherwise stall the walk a few px
  // short of the target when dx*ease rounds to 0.
  let sx = Math.round(dx * WALK_EASE)
  let sy = Math.round(dy * WALK_EASE)
  if (sx === 0 && dx !== 0) sx = Math.sign(dx)
  if (sy === 0 && dy !== 0) sy = Math.sign(dy)
  const nx = b.x + sx
  const ny = b.y + sy
  hudSuppressOwnMoveUntil = Date.now() + 150
  try { hudWindow.setPosition(nx, ny, false) } catch {}
  persistOrbPos(nx, ny)
  hudSendPointer('walk', Math.atan2(dy, dx))
  hudWalkTimer = setTimeout(stepHudWalk, WALK_STEP_MS)
}

function stopHudWalk() {
  if (hudWalkTimer) { clearTimeout(hudWalkTimer); hudWalkTimer = null }
  if (hudPointTimer) { clearTimeout(hudPointTimer); hudPointTimer = null }
  // Cancelling the walk cancels anything waiting on arrival — a cat that
  // never got there must never click.
  if (hudWalkArrive) {
    const arrive = hudWalkArrive
    hudWalkArrive = null
    if (arrive.cancel) { try { arrive.cancel() } catch {} }
  }
  hudWalkTarget = null
  hudSendPointer('none', 0)
}

function persistOrbPos(x, y) {
  try {
    hudSavedState.orb = hudState.clampOrbPosition({ x, y }, screen) || { x, y }
    hudState.persistHudState(fsSync.writeFileSync, hudState.hudStatePath(app.getPath('userData')), hudSavedState)
  } catch {}
}

/** Last toggle timestamp: double-fire guard (globalShortcut + menu/button
 *  racing on one keypress re-created the window the first call just closed). */
let hudToggleAt = 0
const HUD_TOGGLE_GUARD_MS = 250

function toggleHudWindow() {
  // Single-flight: ignore a second toggle inside the guard window and report
  // the live intent state so every caller converges instead of flip-flopping.
  const now = Date.now()
  if (now - hudToggleAt < HUD_TOGGLE_GUARD_MS) {
    return { open: hudMenuOpen }
  }
  hudToggleAt = now
  if (hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible()) {
    hudWindow.close()
    return { open: false }
  }
  createHudWindow()
  return { open: true }
}

/**
 * Single broadcast point for HUD visibility. Two consumers, one truth:
 * the TopBar orb button (src/components/HudOrbButton.tsx) needs it to show
 * pressed/unpressed instead of being a blind toggle, and the Window menu
 * needs it to say Show vs Hide. Anything that opens or closes the HUD —
 * hotkey, menu, button, palette — funnels through toggleHudWindow, so
 * calling this from the window lifecycle is enough to keep both honest.
 */
function setHudOpenState(open) {
  hudMenuOpen = Boolean(open)
  // Persist the open flag so the orb can auto-restore on next launch — but NOT
  // while quitting: Electron fires hudWindow 'closed' BEFORE 'will-quit', and
  // that teardown setHudOpenState(false) used to clobber the open:true saved
  // when the orb was opened, making auto-restore crash-only (bug 2026-08-29,
  // caught by independent review; see scripts/hud-quit-restore-probe.cjs).
  if (!hudQuitting) {
    try {
      hudSavedState.open = hudMenuOpen
      hudState.persistHudState(fsSync.writeFileSync, hudState.hudStatePath(app.getPath('userData')), hudSavedState)
    } catch {}
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('maia:hud:changed', { open: hudMenuOpen }) } catch {}
  }
  if (!hudQuitting) {
    installAppMenu()
    installHudTray()
  }
}

/**
 * Application menu. Exists for one reason: the orb used to be reachable only
 * through an unlisted global hotkey, so most users never met the cat, and
 * closing the strip (× in HudShell) destroyed the window with no visible way
 * back. The Window menu is where a Mac user looks for "where did that window
 * go", and putting the hotkey in the label makes ⌘⇧H discoverable without
 * registering a conflicting accelerator (see HUD_SHORTCUT).
 *
 * The TEMPLATE lives in electron/app-menu.cjs (pure + injectable) so a probe
 * can build it and read Menu.getApplicationMenu() back; this wrapper supplies
 * the live app's state and handlers and keeps every call site untouched.
 */
function installAppMenu() {
  if (nativeQualification) return
  return installAppMenuImpl({
    Menu,
    hudMenuOpen,
    toggleHudWindow,
    HUD_SHORTCUT_LABEL,
    stopAll: () => void localBoot?.stopAll().catch(() => {
      console.warn('[hermes-desk] Some agent turns could not be interrupted')
    }),
  })
}

/**
 * Menu-bar Tray icon — a permanent, discoverable home for the orb next to the
 * Dock icon. The context menu mirrors the Window menu's single truth: the
 * label flips via setHudOpenState (same helper, so menu + tray + button can
 * never disagree) and Quit uses the standard role. Skipped under smoke/probe
 * envs so CI never creates a stray tray. On macOS the menu-bar icon is a
 * monochrome template silhouette (auto-adapts to light/dark menu bars);
 * other platforms keep the full-color orb. Either source is resized down
 * to menu-bar size via nativeImage (no runtime sips dependency).
 */
function installHudTray() {
  if (nativeQualification) return
  if (process.env.NUB_SMOKE_HUD === '1' || process.env.NUB_SMOKE) return
  try {
    if (!hudTray) {
      const templateIcon = process.platform === 'darwin'
      // Windows/Linux: the simplified colour mark — the app tile's margin and
      // shadow shrink the cat to a speck at 16px.
      const traySrc = templateIcon ? 'trayTemplate.png' : 'trayColor.png'
      const img = nativeImage.createFromPath(path.join(__dirname, traySrc))
      if (img.isEmpty()) {
        console.warn(`[hud] tray icon missing (electron/${traySrc}); tray skipped`)
        return
      }
      // 1x + 2x representations: a single 16px image is blurry on Retina.
      const trayIcon = nativeImage.createEmpty()
      trayIcon.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: img.resize({ width: 16, height: 16, quality: 'best' }).toPNG() })
      trayIcon.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: img.resize({ width: 32, height: 32, quality: 'best' }).toPNG() })
      if (templateIcon) trayIcon.setTemplateImage(true)
      hudTray = new Tray(trayIcon)
      hudTray.setToolTip('Hermes Desk')
    }
    const menu = Menu.buildFromTemplate([...trayTemplate({
      visible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
      computerOpen: localBoot?.isComputerOpen(), computerAvailable: Boolean(localBoot?.computer),
      serveState: localBoot?.hermesHost.status().serve.state,
      toggleWindow: () => {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow()
        else if (mainWindow.isVisible()) mainWindow.hide()
        else {
          if (mainWindow.isMinimized()) mainWindow.restore()
          showMainWindow(true)
        }
        installHudTray()
      },
      toggleComputer: () => void localBoot?.toggleComputer().catch(() => {
        console.warn('[hermes-desk] Computer preview unavailable')
      }),
      pauseBrowsing: () => void localBoot?.stopAll({ interrupt: false }),
    }), {
      id: 'hud-tray-orb',
      label: hudMenuOpen ? 'Hide Hermes Orb' : `Show Hermes Orb (${HUD_SHORTCUT_LABEL})`,
      click: () => toggleHudWindow(),
    }, { type: 'separator' }, { role: 'quit' }])
    hudTray.setContextMenu(menu)
  } catch (err) {
    console.warn('[hud] tray install failed:', err && err.message)
  }
}

/**
 * macOS chicken-and-egg: a fresh install does not appear in System Settings →
 * Privacy & Security → Accessibility until SOMETHING calls
 * isTrustedAccessibilityClient(true) — and before this that only happened
 * from the HUD's Enable button, i.e. AFTER an act had already been refused.
 * Ask once at startup so the entry exists BEFORE the first [CLICK:]/[TYPE:].
 * Never nags: the "asked" flag persists in userData, so this fires at most
 * once per install (delete the flag file to re-prompt). Already trusted →
 * immediate no-op, no dialog. A failure here must never block boot.
 */
function maybeRequestAccessibility() {
  if (process.platform !== 'darwin') return
  // A system dialog would hang the smoke/probe runs.
  if (process.env.NUB_SMOKE_HUD === '1' || process.env.NUB_SMOKE) return
  try {
    const flagFile = path.join(app.getPath('userData'), 'accessibility-prompt.json')
    if (systemPreferences.isTrustedAccessibilityClient(false)) return
    if (fsSync.existsSync(flagFile)) return
    // Write BEFORE prompting: a crash mid-prompt must not re-prompt next boot.
    fsSync.writeFileSync(flagFile, JSON.stringify({ asked: true, at: new Date().toISOString() }))
    const trusted = Boolean(systemPreferences.isTrustedAccessibilityClient(true))
    console.log(`[hud] accessibility prompt surfaced; trusted=${trusted}`)
  } catch (err) {
    console.warn('[hud] accessibility prompt skipped:', err && err.message)
  }
}

/**
 * Dev/CI smoke (NUB_SMOKE_HUD=1): open the HUD, move/resize it, close it,
 * then verify hud-window-state.json holds exactly the final bounds.
 * Prints '[hud] smoke ok {...}' + exit 0, or '[hud] smoke FAILED ...' + exit 1.
 */
function runHudSmoke() {
  const stateFile = hudState.hudStatePath(app.getPath('userData'))
  try { fsSync.rmSync(stateFile, { force: true }) } catch {}
  let win
  try {
    win = createHudWindow()
  } catch (err) {
    console.error('[hud] smoke FAILED: createHudWindow threw:', err && err.message)
    app.exit(1)
    return
  }
  setTimeout(() => {
    let cmd = null
    try {
      win.setPosition(140, 160)
      win.setSize(700, 400)
      // Commanded movement: walk the window to (300, 300) and wait for arrival.
      cmd = hudMoveTo(300, 300)
      if (!cmd || !cmd.ok) throw new Error('hudMoveTo rejected the command')
    } catch (err) {
      console.error('[hud] smoke FAILED during ops:', err && err.message)
      try { if (win && !win.isDestroyed()) win.close() } catch {}
      app.exit(1)
      return
    }
    const deadline = Date.now() + 4000
    const checkArrival = () => {
      let wb
      try { wb = win.getBounds() } catch { wb = null }
      if (wb && Math.abs(wb.x - cmd.x) <= 2 && Math.abs(wb.y - cmd.y) <= 2) {
        try { win.close() } catch {}
        setTimeout(() => {
          const saved = hudState.loadHudState(fsSync.readFileSync, stateFile)
          const arrived = Math.abs(wb.x - cmd.x) <= 2 && Math.abs(wb.y - cmd.y) <= 2
          const persistedOrb =
            saved && saved.orb &&
            Math.abs(saved.orb.x - cmd.x) <= 2 && Math.abs(saved.orb.y - cmd.y) <= 2
          if (!arrived || !persistedOrb) {
            console.error('[hud] smoke FAILED — commanded walk arrived:', JSON.stringify({ arrived, persistedOrb }), 'saved:', JSON.stringify(saved))
            app.exit(1)
            return
          }
          console.log('[hud] smoke ok', JSON.stringify(saved))
          app.exit(0)
        }, 250)
        return
      }
      if (Date.now() > deadline) {
        console.error('[hud] smoke FAILED — walk never arrived; bounds:', JSON.stringify(wb), 'target:', JSON.stringify(cmd))
        try { if (win && !win.isDestroyed()) win.close() } catch {}
        app.exit(1)
        return
      }
      setTimeout(checkArrival, 100)
    }
    setTimeout(checkArrival, 100)
  }, 100)
}

function assertMainSender(event) {
  const sender = event.sender
  if (mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents &&
      event.senderFrame && event.senderFrame === sender.mainFrame) return
  throw new Error('IPC sender rejected')
}

const HUD_CHANNELS = new Set([
  'maia:hud:open', 'maia:hud:close', 'maia:hud:toggle', 'maia:hud:isOpen',
  'maia:hud:setCollapsed', 'maia:hud:moveTo', 'maia:hud:goToCursor',
  'maia:hud:dragStart', 'maia:hud:dragMove', 'maia:hud:dragEnd', 'maia:hud:setClickThrough',
  'maia:hud:typeText', 'maia:hud:clickAt', 'maia:hud:actStatus', 'maia:hud:requestActPermission',
  'maia:hud:see', 'maia:hud:seeStatus', 'maia:hud:openScreenPermission',
  'maia:hud:getActivity', 'maia:hud:openConversation',
  'maia:serveConfig', 'maia:serveSocketOpen', 'maia:serveSocketSend', 'maia:serveSocketClose',
  'maia:sttStatus', 'maia:sttTranscribe', 'maia:openExternal', 'maia:openHttps',
])
function ipcHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!HUD_CHANNELS.has(channel) || !hudEventFromHud(event)) assertMainSender(event)
    return handler(event, ...args)
  })
}

const { registerPluginHostIpc } = require('./plugin-host.cjs')
registerPluginHostIpc({
  assertMainSender,
  getMainWindow: () => mainWindow,
  confirm: confirmPrivileged,
  getUserDataDir: () => app.getPath('userData'),
})

require('./self-modification.cjs').registerChangeController({
  ipcMain, assertMainSender, dialog, getMainWindow: () => mainWindow,
  getUserDataDir: () => app.getPath('userData'),
  getHermesHome: () => require('./local/hermes-host.cjs').resolveHermesHome({ app }),
  passiveReadOnly: nativeQualification?.passiveReadOnly === true,
})

/**
 * Plugin pin door (renderer side owned by the loader team — see
 * src/plugins/loader.ts, deliberately untouched here). `maia:plugins:get`
 * reads the pinned flag for one plugin name; `maia:plugins:setPin` sets it.
 * In-memory only: persistence/semantics belong to the loader.
 */

function showMainWindow(focus = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (e2eBackground) mainWindow.showInactive()
  else {
    mainWindow.show()
    if (focus) mainWindow.focus()
  }
}

function createWindow() {
  const displays = e2eBackground ? screen.getAllDisplays?.() || [] : []
  const offscreen = e2eBackground ? {
    x: Math.min(0, ...displays.map((display) => display.bounds.x)) - 2000,
    // Avoid vertical clamping. The opacity fallback handles native child layout.
    y: (displays[0]?.bounds.y || 0) + 100,
    focusable: false,
  } : {}
  mainWindow = new BrowserWindow({
    ...offscreen,
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'Hermes Desk',
    backgroundColor: resolveAppBackground(),
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      disableDialogs: nativeQualification?.active === true,
      disablePopups: nativeQualification?.active === true,
      additionalArguments: nativeQualification?.active === true ? ['--hd-native-readonly-preload-v1'] : [],
      // Throttled while hidden/occluded (battery: the mascot orb and the
      // streaming activity line otherwise animate at full rate behind other
      // windows). Lifted only while a turn is live — see
      // syncMainBackgroundThrottling below.
      backgroundThrottling: true,
      // Explicit lockdown (defaults documented, not assumed): no webviews,
      // no insecure content, no experimental features in either window.
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  })

  if (e2eBackground) mainWindow.webContents.setBackgroundThrottling(false)
  mainWindow.once('ready-to-show', () => {
    showMainWindow()
  })
  // If the renderer hangs before first paint, ready-to-show never fires and
  // the dock icon sits at "not responding" with a hidden window.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      showMainWindow()
    }
  }, 4000)

  mainWindow.webContents.on('unresponsive', () => {
    console.error('[main] renderer unresponsive')
  })
  mainWindow.webContents.on('responsive', () => {
    console.log('[main] renderer responsive again')
  })
  const mediaOwner = mainWindow.webContents.id
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    fsAccess.reset()
    mediaFiles.releaseOwner(mediaOwner)
    nativeFiles.releaseOwner(mediaOwner)
    console.error('[main] render-process-gone', details && details.reason, details && details.exitCode)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('[main] did-fail-load', code, desc, url)
  })
  mainWindow.webContents.once('destroyed', () => {
    fsAccess.reset()
    mediaFiles.releaseOwner(mediaOwner)
    nativeFiles.releaseOwner(mediaOwner)
  })
  mainWindow.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) {
      fsAccess.reset()
      mediaFiles.releaseOwner(mediaOwner)
      nativeFiles.releaseOwner(mediaOwner)
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isBrowserSafeExternalUrl(url)) {
      void openConfirmedHttps({ sender: mainWindow.webContents }, url).catch(() => {})
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-attach-webview', (event) => {
    // No webviews anywhere — the preview iframe is a plain <iframe>, and a
    // compromised renderer must not gain a privileged guest.
    event.preventDefault()
  })
  installPermissionPolicy(mainWindow.webContents.session)

  // Only the app's own shell may navigate this preload-bearing window.
  // The navigation guard also rejects non-app schemes and malformed URLs.
  const appOriginGuard = (url) => {
    if (isDev) {
      const appOrigin = (process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '')
      if (url === appOrigin || url.startsWith(appOrigin + '?') || url.startsWith(appOrigin + '#')) {
        return true
      }
      try {
        return new URL(url).origin === new URL(appOrigin).origin
      } catch {
        return false
      }
    }
    // Packaged: exact file-path match against dist/index.html (query/hash
    // tolerated). Percent-decoding first so %2e%2e spellings cannot dodge it.
    try {
      const expected = path.join(__dirname, '..', 'dist', 'index.html')
      const parsed = new URL(url)
      if (parsed.protocol !== 'file:') return false
      const navigated = decodeURIComponent(parsed.pathname)
      if (navigated === expected) return true
      // Windows drive-letter / slash variants: normalize both sides once.
      return path.normalize(navigated) === path.normalize(expected)
    } catch {
      return false
    }
  }
  mainWindow.webContents.on('will-navigate', vmNavGuard.willNavigateGuard(appOriginGuard))
  mainWindow.webContents.on('will-redirect', vmNavGuard.willNavigateGuard(appOriginGuard))

  if (nativeQualification) {
    void nativeQualification.loadWindow(mainWindow)
  } else if (isDev) {
    const url = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173'
    mainWindow.loadURL(url)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  for (const event of ['show', 'hide', 'minimize', 'restore']) mainWindow.on(event, installHudTray)
  mainWindow.on('closed', () => {
    mainWindow = null
    // The relay's source is gone: a stale "working" badge would lie forever.
    chatHudActivity = null
    // A recreated window starts throttled (its webPreferences default).
    mainThrottlingLifted = false
    updateHudActivity()
    installHudTray()
  })
}

/**
 * Native window chrome follows the app theme. The stored `maia:theme`
 * lives in renderer localStorage (unreadable here pre-load), so the main
 * process keys off the OS dark mode: light keeps the sky-blue launch
 * flash, dark gets true black. Re-evaluated live on OS theme switches
 * (darwin-safe: fully guarded, no-ops where nativeTheme is unavailable).
 */
function resolveAppBackground() {
  try {
    if (nativeTheme && nativeTheme.shouldUseDarkColors) return '#000000'
  } catch {}
  return '#9ecdff'
}

function syncWindowBackground() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.setBackgroundColor(resolveAppBackground())
  } catch {}
}

// HUD IPC — mirrored from hermes-agent desktop/electron/hud-url + hud-ipc
ipcHandle('maia:hud:open', async () => {
  createHudWindow()
  return { open: true }
})
ipcHandle('maia:hud:close', async (event) => {
  // Enforced sender check: only the HUD window itself may close the orb. The
  // shared assertMainSender gate admits the main window too, but a
  // compromised main renderer must not dismiss the orb out from under the
  // user — a main-window sender is ignored (no close, truthful state back).
  if (hudWindow && !hudWindow.isDestroyed() && event.sender === hudWindow.webContents) {
    hudWindow.close()
    return { open: false }
  }
  return { open: hudMenuOpen }
})
ipcHandle('maia:hud:toggle', async () => toggleHudWindow())
ipcHandle('maia:hud:isOpen', async () => hudMenuOpen)

// Orb collapse — shrink the window to the orb rectangle so the strip's
// transparent area stops catching clicks; expand restores the anchored bounds.
ipcHandle('maia:hud:setCollapsed', async (event, payload) => {
  if (!hudEventFromHud(event)) return { ok: false, error: 'IPC sender rejected' }
  const want = Boolean(payload && payload.collapsed)
  if (want === hudCollapse.collapsed) return { collapsed: want }
  if (!hudWindow || hudWindow.isDestroyed()) return { collapsed: false }
  try {
    if (want) {
      const b = hudWindow.getBounds()
      if (b.width > 160 || b.height > 160) {
        hudCollapse.anchor = { x: b.x, y: b.y, width: b.width, height: b.height }
        // Dock to the cat's saved spot when we have one; else center-shrink.
        const target =
          (hudSavedState.orb && hudState.clampOrbPosition(hudSavedState.orb, screen)) || {
            x: b.x + Math.round(b.width / 2) - Math.round(ORB_SIZE / 2),
            y: b.y + Math.round(b.height / 2) - Math.round(ORB_SIZE / 2),
          }
        hudWindow.setBounds({ x: target.x, y: target.y, width: ORB_SIZE, height: ORB_SIZE })
      }
    } else {
      // Clicky-mode: open the compact speech bubble anchored on the cat —
      // fixed-size bubble centered over it, above when there is room, else
      // below; clamped to the work area.
      const b = hudWindow.getBounds()
      const wa = screen.getDisplayMatching(b).workArea
      const w = Math.min(BUBBLE_WIDTH, wa.width)
      const h = Math.min(BUBBLE_HEIGHT, wa.height)
      let x = b.x + Math.round(b.width / 2) - Math.round(w / 2)
      x = Math.min(Math.max(x, wa.x), wa.x + wa.width - w)
      let y = b.y - h - 8
      if (y < wa.y) y = b.y + b.height + 8
      y = Math.min(Math.max(y, wa.y), wa.y + wa.height - h)
      hudWindow.setBounds({ x, y, width: w, height: h })
      hudCollapse.anchor = null
    }
    hudCollapse.collapsed = want
    if (!want) stopHudWalk()
  } catch {}
  return { collapsed: hudCollapse.collapsed }
})

/** Commanded movement — the ONLY ways the cat moves by itself. */
ipcHandle('maia:hud:moveTo', async (event, payload) => {
  if (!hudEventFromHud(event)) return { ok: false, error: 'IPC sender rejected' }
  return hudMoveTo(Number(payload && payload.x), Number(payload && payload.y))
})
ipcHandle('maia:hud:goToCursor', async (event) => {
  if (!hudEventFromHud(event)) return { ok: false }
  const p = screen.getCursorScreenPoint()
  return hudMoveTo(p.x - Math.round(ORB_SIZE / 2), p.y - Math.round(ORB_SIZE / 2))
})

// User drag of the cat. The orb is a button (no-drag region, so it stays
// clickable), so the renderer reports pointer down/move/up and main moves the
// window by the CURSOR's screen delta — no renderer DPI/coordinate math. Only
// the HUD window may drag itself; a main-window sender is ignored.
let hudDrag = null
const isHudSender = (event) => hudEventFromHud(event)
ipcHandle('maia:hud:dragStart', async (event) => {
  if (!isHudSender(event)) return { ok: false }
  stopHudWalk()
  hudDrag = { bounds: hudWindow.getBounds(), cursor: screen.getCursorScreenPoint() }
  return { ok: true }
})
ipcHandle('maia:hud:dragMove', async (event) => {
  if (!hudDrag || !isHudSender(event)) return { ok: false }
  const p = screen.getCursorScreenPoint()
  const { bounds, cursor } = hudDrag
  const x = bounds.x + p.x - cursor.x
  const y = bounds.y + p.y - cursor.y
  const wa = screen.getDisplayNearestPoint(p).workArea
  // Docked, the window (held at HUD_MIN_WIDTH x HUD_MIN_HEIGHT) is bigger
  // than the centered cat: clamp the CAT to the work area, not the window,
  // so the cat can sit flush against a screen edge. Open, keep the whole
  // bubble on screen.
  const mx = hudCollapse.collapsed ? Math.max(0, Math.round((bounds.width - ORB_SIZE) / 2)) : 0
  const my = hudCollapse.collapsed ? Math.max(0, Math.round((bounds.height - ORB_SIZE) / 2)) : 0
  const cx = Math.min(Math.max(x, wa.x - mx), wa.x + wa.width - bounds.width + mx)
  const cy = Math.min(Math.max(y, wa.y - my), wa.y + wa.height - bounds.height + my)
  // A 'move' outside the own-move suppression window reads as a user drag:
  // it stops any walk and schedules the position save.
  try { hudWindow.setPosition(Math.round(cx), Math.round(cy)) } catch {}
  return { ok: true }
})
ipcHandle('maia:hud:dragEnd', async (event) => {
  if (!isHudSender(event)) return { ok: false }
  hudDrag = null
  return { ok: true }
})

/** Click-through: transparent HUD areas must never steal clicks from the apps
 *  behind them (Clicky-class pets are felt, not framed). Renderer hit-testing
 *  toggles this via mouseover; forward:true keeps mousemove flowing so the
 *  renderer can switch back over solid elements. */
ipcHandle('maia:hud:setClickThrough', async (event, payload) => {
  if (!hudEventFromHud(event)) return { ok: false }
  if (!hudWindow || hudWindow.isDestroyed()) return { ok: false }
  const ignore = Boolean(payload && payload.ignore)
  try { hudWindow.setIgnoreMouseEvents(ignore, { forward: true }) } catch {}
  return { ok: true, ignore }
})

/** [CLICK:x,y] act primitive — the last mile of talk→see→point→ACT. The cat
 *  walks to a spot BESIDE the point (never onto it — the orb is solid and
 *  would swallow its own click), point-pulses, then clicks that exact pixel.
 *  Resolves when the click has been dispatched, so the caller can tell a real
 *  click from a refused one. */
ipcHandle('maia:hud:clickAt', async (event, payload) => {
  if (!hudEventFromHud(event)) return { ok: false, error: 'IPC sender rejected' }
  const point = screenAct.normalizePoint(payload?.x, payload?.y)
  if (!point || !hudActGate.hudActVisibilityGate(hudCollapse.collapsed).allowed ||
      screenAct.actStatus({ platform: process.platform, isTrusted: hudActTrusted }).trusted !== true) return { ok: false, error: 'action-not-authorized' }
  const grant = await consentHudAction(event, `Click at screen position ${point.x}, ${point.y}.`)
  if (!grant) return { ok: false, error: 'cancelled' }
  try {
    return await hudClickAt(point.x, point.y, async () => hudEventFromHud(event) && await grant.revalidate())
  } finally { grant.dispose() }
})

/** Can this app inject input at all? A dropped CGEvent is indistinguishable
 *  from a landed one, so the HUD asks before it promises anything. */
ipcHandle('maia:hud:actStatus', async () => {
  return screenAct.actStatus({ platform: process.platform, isTrusted: hudActTrusted })
})

/** Open the OS pane that grants it. `prompt: true` is what makes macOS show
 *  the Accessibility entry for this app; the user still has to tick it. */
ipcHandle('maia:hud:requestActPermission', async () => {
  if (process.platform !== 'darwin') return { ok: true, trusted: true }
  try {
    const trusted = Boolean(systemPreferences.isTrustedAccessibilityClient(true))
    return { ok: true, trusted }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

/* ── SEE: screen capture for the cat (talk→SEE→point→act) ──────────────────
 * The HUD asks for one capture per explicit tap (eye = the display the cat is
 * on, snip = a region the user drags out). Only the HUD window may ask — a
 * compromised main renderer must not be able to photograph the screen. */

let seeInFlight = false
/** Fixed OS pane — the only openExternal target here, never renderer data. */
const SCREEN_RECORDING_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

function hudEventFromHud(event) {
  return Boolean(hudWindow && !hudWindow.isDestroyed() && event.sender === hudWindow.webContents &&
    event.senderFrame === hudWindow.webContents.mainFrame)
}

/** The display the cat is on (where the user is looking), else the cursor's. */
function hudDisplay() {
  try {
    if (hudWindow && !hudWindow.isDestroyed()) return screen.getDisplayMatching(hudWindow.getBounds())
  } catch {}
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function seeDeps() {
  return {
    platform: process.platform,
    getMediaAccessStatus: (t) => systemPreferences.getMediaAccessStatus(t),
    getSources: (opts) => desktopCapturer.getSources(opts),
    // Content protection keeps the cat out of its own screenshot. The window
    // server applies it asynchronously, so give it a frame before grabbing.
    setHudHidden: async (hidden) => {
      if (!hudWindow || hudWindow.isDestroyed()) return
      try { hudWindow.setContentProtection(Boolean(hidden)) } catch {}
      if (hidden) await wait(80)
    },
  }
}

/** Full-screen drag-to-select overlay on `display`. Resolves the rect in
 *  display-relative points, or null (Esc, blur, right-click, timeout). */
function pickRegion(display) {
  return new Promise((resolve) => {
    const b = display.bounds
    const win = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      acceptFirstMouse: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'region-picker-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    })
    let settled = false
    const timer = setTimeout(() => finish(null), 60_000)
    const onDone = (event, rect) => {
      if (event.sender !== win.webContents) return
      finish(rect)
    }
    function finish(rect) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ipcMain.removeListener('maia:region:done', onDone)
      if (!win.isDestroyed()) win.destroy()
      resolve(screenSee.normalizeRegion(rect, b))
    }
    ipcMain.on('maia:region:done', onDone)
    win.on('closed', () => finish(null))
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    try {
      win.setAlwaysOnTop(true, 'screen-saver')
      if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    } catch {}
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return
      win.show()
      try { if (!e2eBackground && process.platform === 'darwin') app.focus({ steal: true }) } catch {}
      if (!e2eBackground) win.focus()
    })
    win.loadFile(path.join(__dirname, 'region-picker.html')).catch(() => finish(null))
  })
}

async function hudSee(mode) {
  const display = hudDisplay()
  let region = null
  if (mode === 'region') {
    region = await pickRegion(display)
    if (!region) return { ok: false, error: 'cancelled' }
    // Let the overlay leave the screen before grabbing what was under it.
    await wait(120)
  }
  const grab = await screenSee.grabDisplay(display, seeDeps())
  if (!grab.ok) return grab
  return screenSee.packCapture(grab, region)
}

ipcHandle('maia:hud:see', async (event, payload) => {
  if (!hudEventFromHud(event)) return { ok: false, error: 'sender-rejected' }
  const mode = payload && payload.mode === 'region' ? 'region' : 'screen'
  if (seeInFlight) return { ok: false, error: 'busy' }
  seeInFlight = true
  try {
    const res = await hudSee(mode)
    // The picker took focus; hand it back so the user can type their question.
    if (mode === 'region' && hudWindow && !hudWindow.isDestroyed()) {
      try { if (!e2eBackground) hudWindow.focus() } catch {}
    }
    return res
  } catch (err) {
    return { ok: false, error: 'capture-failed', hint: err instanceof Error ? err.message : String(err) }
  } finally {
    seeInFlight = false
  }
})

ipcHandle('maia:hud:seeStatus', async () => {
  return { access: screenSee.screenAccess(seeDeps()) }
})

ipcHandle('maia:hud:openScreenPermission', async (event) => {
  if (!hudEventFromHud(event)) return { ok: false }
  if (process.platform !== 'darwin') return { ok: true }
  try {
    await shell.openExternal(SCREEN_RECORDING_PANE)
    return { ok: true }
  } catch {
    return { ok: false }
  }
})

/* ── Activity relay: main window → cat badge ────────────────────────────────
 * The main window already tracks which conversations are live on ANY device
 * (conversation sync `live`) and which just finished. It publishes a small
 * summary here and main forwards it to the HUD, so the badge costs zero extra
 * server polling. Only the main window may publish; only the HUD reads. */

let lastHudActivity = null
let chatHudActivity = null
let workspaceHudActivity = null

function sendHudActivity() {
  if (!hudWindow || hudWindow.isDestroyed()) return
  try { hudWindow.webContents.send('maia:hud:activity', lastHudActivity) } catch {}
}

/**
 * The main window is background-throttled except while a turn is live: the
 * stream's settle → "reply ready" notification and the live→idle transition
 * this relay reports must not wait on a throttled timer while the user is in
 * another app. The `working` list is the same live set the cat's badge shows
 * (streaming bubbles here + live turns on any device).
 */
let mainThrottlingLifted = false
function syncMainBackgroundThrottling(activity) {
  if (e2eBackground) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  const live = Boolean(activity && activity.working.length > 0)
  if (live === mainThrottlingLifted) return
  mainThrottlingLifted = live
  try { mainWindow.webContents.setBackgroundThrottling(!live) } catch {}
}

function updateHudActivity() {
  const clean = hudActivity.mergeActivity(chatHudActivity, workspaceHudActivity)
  lastHudActivity = clean
  syncMainBackgroundThrottling(clean)
  sendHudActivity()
}

ipcHandle('maia:hud:publishActivity', async (event, payload) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { ok: false }
  const clean = hudActivity.sanitizeActivity(payload)
  if (!clean) return { ok: false }
  chatHudActivity = clean
  updateHudActivity()
  return { ok: true }
})

ipcHandle('maia:hud:getActivity', async () => lastHudActivity)

/** Explicit chat Copy: write-only, main-window top frame, no browser permission grant. */
ipcHandle('hd:clipboard:writeText', (event, text) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('IPC sender rejected')
  if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Invalid clipboard text')
  try { clipboard.writeText(text) } catch { throw new Error('Clipboard unavailable') }
})

for (const method of ['open', 'release']) ipcHandle(`hd:media:${method}`, (event, value) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('IPC sender rejected')
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid media request')
  return mediaFiles[method](value, event.sender.id)
})
for (const method of ['pickMedia', 'saveAs', 'releaseImport']) ipcHandle(`hd:files:${method}`, (event, ...args) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('IPC sender rejected')
  if (method === 'pickMedia') {
    if (args.length) throw new Error('Invalid file request')
    return nativeFiles.pickMedia(event.sender.id)
  }
  if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length > 4096) throw new Error('Invalid file request')
  return nativeFiles[method](args[0], event.sender.id)
})

/**
 * System notification from the main window (see electron/system-notify.cjs).
 * Skipped while the window is in front (the reader is already looking);
 * a click brings the window up and hands the target back to the page.
 */
const liveNotifications = new Set()
ipcHandle('maia:notify', async (event, payload) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { ok: false }
  const n = systemNotify.sanitizeNotification(payload)
  if (!n || !Notification.isSupported()) return { ok: false }
  if (e2eBackground) return { ok: true, skipped: 'background-e2e' }
  if (!n.force && mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused()) {
    return { ok: true, skipped: 'focused' }
  }
  const note = (() => {
    // Ad-hoc (unsigned) builds may lack the UNNotification identity; a
    // notification must degrade to a no-op, never crash the main window.
    try {
      const created = new Notification({ title: n.title, body: n.body || undefined })
      created.on('failed', (event, error) => console.warn('[notify] notification failed:', error && error.message))
      return created
    } catch (error) {
      console.warn('[notify] notification unavailable:', error && error.message)
      return null
    }
  })()
  if (!note) return { ok: false, skipped: 'unavailable' }
  // Held until clicked or closed: a collected Notification loses its click.
  liveNotifications.add(note)
  const release = () => liveNotifications.delete(note)
  note.on('close', release)
  note.on('click', () => {
    release()
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    showMainWindow(true)
    try { mainWindow.webContents.send('maia:notify:click', { target: n.target }) } catch {}
  })
  try {
    note.show()
  } catch (error) {
    console.warn('[notify] notification unavailable:', error && error.message)
    liveNotifications.delete(note)
    return { ok: false, skipped: 'unavailable' }
  }
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.bounce('informational') } catch {}
  }
  return { ok: true }
})

/** Badge click-through: bring the main window up on that conversation. */
ipcHandle('maia:hud:openConversation', async (event, payload) => {
  if (!hudEventFromHud(event)) return { ok: false }
  const id = hudActivity.sanitizeConversationId(payload && payload.conversationId)
  if (!id) return { ok: false }
  const deliver = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    showMainWindow(true)
    try { mainWindow.webContents.send('maia:hud:openConversation', { conversationId: id }) } catch {}
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    mainWindow.webContents.once('did-finish-load', () => setTimeout(deliver, 400))
  } else {
    deliver()
  }
  return { ok: true }
})

/** [TYPE:text] act primitive (Clicky talk→see→point→ACT): the agent emits the
 *  marker in a reply and the mascot types the text into the frontmost app via
 *  a System Events keystroke. No native dep — osascript ships with macOS and
 *  accessibility is already enabled. argv passing keeps the text shell-safe. */
ipcHandle('maia:hud:typeText', async (event, payload) => {
  if (!hudEventFromHud(event)) return { ok: false, error: 'IPC sender rejected' }
  const text = typeof (payload && payload.text) === 'string' ? payload.text : ''
  if (!text) return { ok: false }
  if (text.length > 4096) return { ok: false, error: 'text-too-large' }
  // D-03 (red team sweep 5, option c): same visibility floor as clickAt —
  // keystrokes into the frontmost app while the cat is collapsed to the orb
  // are exactly the unattended-act shape this gate exists to refuse.
  const visibility = hudActGate.hudActVisibilityGate(hudCollapse.collapsed)
  if (!visibility.allowed) {
    return { ok: false, error: visibility.error, hint: visibility.hint }
  }
  // D-02 (red team sweep 5): same Accessibility gate as the click path. A
  // missing check here made typing reachable where clicking was refused —
  // and on darwin an untrusted osascript keystroke still LANDS (unlike
  // CGEvent clicks, which are silently dropped), so the asymmetry was
  // exploitable, not just inconsistent.
  const status = screenAct.actStatus({ platform: process.platform, isTrusted: hudActTrusted })
  // Same fail-closed floor as the click path (see hudClickAt): only `true`
  // acts — 'unknown' is refused here even though screen-act would attempt it.
  if (status.trusted !== true) {
    return { ok: false, error: 'accessibility-not-trusted', hint: screenAct.ACCESS_HINT }
  }
  // D-06 (red team sweep 5): never exec a bare PATH name. osascript is
  // pinned to its fixed macOS system path, same as the click backends.
  const osascript = screenAct.defaultResolveActFile('osascript')
  if (!osascript) return { ok: false, error: 'osascript unavailable' }
  if (text.length > 1500) return { ok: false, error: 'text-too-large-to-review' }
  const grant = await consentHudAction(event, `Type this exact text (escaped): ${JSON.stringify(text)}`)
  if (!grant) return { ok: false, error: 'cancelled' }
  try {
  if (!hudEventFromHud(event) || !hudActGate.hudActVisibilityGate(hudCollapse.collapsed).allowed ||
      screenAct.actStatus({ platform: process.platform, isTrusted: hudActTrusted }).trusted !== true ||
      !await grant.revalidate()) {
    return { ok: false, error: 'action-no-longer-authorized' }
  }
  // Async: a System Events keystroke takes 100-500ms (longer for long text),
  // and a sync spawn here froze every window's input and IPC for that long.
  return await new Promise((resolve) => {
    try {
      require('child_process').execFile(osascript, [
        '-e', 'on run argv',
        '-e', 'tell application "System Events" to keystroke (item 1 of argv)',
        '-e', 'end run',
        text,
      ], { env: agentEnv.helperEnv(), timeout: 5000, maxBuffer: 65536, shell: false }, (err, _stdout, stderr) => {
        if (!err) return resolve({ ok: true })
        // Non-zero exit: report osascript's own stderr, as before. Spawn
        // failures (ENOENT, …) have no stderr and carry the error message.
        const msg = String(stderr || '').trim()
        if (typeof err.code === 'number') return resolve({ ok: false, error: msg || 'osascript keystroke failed' })
        resolve({ ok: false, error: msg || err.message })
      })
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
  } finally { grant.dispose() }
})

ipcHandle('maia:openExternal', openConfirmedHttps)
ipcHandle('maia:openHttps', openConfirmedHttps)

/**
 * H4 (red team): this used to open ANY https URL renderer-scripted — a
 * compromised renderer could drive the user's default browser to phishing
 * pages with zero friction. IPC can't prove a human clicked, so require an
 * explicit native confirmation that shows the full target URL. Hermes Desk
 * has no platform/Telegram allowlist that bypasses this prompt.
 */
async function openConfirmedHttps(event, url) {
  const parsed = parseHttpUrl(url)
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Invalid URL')
  }
  const target = parsed.toString()
  const owner =
    BrowserWindow.fromWebContents(event.sender) ||
    (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)
  const { response } = await dialog.showMessageBox(owner, {
    type: 'question',
    buttons: ['Open in browser', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Open this external link in your browser?',
    detail: target,
    noLink: true,
  })
  if (response !== 0) {
    return { ok: false, error: 'cancelled' }
  }
  await shell.openExternal(target)
  return { ok: true }
}

/**
 * Shared helper: run `hermes <subcommand> <args…>` in the main process
 * (parent context — kanban refuses delegated/child contexts) and collect
 * stdout/stderr. For read-only verbs that the CLI supports with --json,
 * inject --json and parse the output. Args are validated by the caller
 * (strings, < 500 chars, allowlisted verb).
 *
 * @param {string[]} args      full argv after the subcommand
 * @param {string[]} readOnlyVerbs verbs to auto-append --json to
 * @param {{ injectJson?: boolean, prefix?: string[] }} [opts]
 *   injectJson: default true — auto-append `--json` for read-only verbs.
 *   prefix:     default ['kanban'] — the subcommand that precedes the verb.
 */
async function runHermes(args, readOnlyVerbs, opts = {}) {
  const { injectJson = true, prefix = ['kanban'] } = opts
    // Pass-3: hermes is resolved + trust-checked (bin-guard), never a bare
    // PATH spawn — same discipline as op / task / whisper-cli.
    const hb = binGuard.resolveTrustedBin('hermes')
    if (!hb.ok) {
      return { ok: false, code: -1, data: null, error: `hermes CLI unavailable: ${hb.error}` }
    }
    const full = [...args]
    const verb = args[0]
    if (injectJson && readOnlyVerbs.includes(verb) && !full.includes('--json')) {
      full.push('--json')
    }
    // #160: hermes may run agent workers — never hand them the shell's
    // GitHub tokens or the app-held serve token (agent-env.cjs).
    const result = await runBoundedCli(hb.bin, [...prefix, ...full], agentEnv.scrubAgentEnv())
    if (injectJson && readOnlyVerbs.includes(verb) && result.ok && typeof result.data === 'string') {
        try {
          result.data = JSON.parse(result.data)
        } catch {
          /* keep text if not JSON */
        }
    }
    return result
}

/**
 * Validate IPC args: must be an array of strings, each < 500 chars.
 * @param {unknown} rawArgs
 * @returns {string[]}
 */
function sanitizeArgs(rawArgs, label) {
  const args = Array.isArray(rawArgs) ? rawArgs : []
  if (!args.every((a) => typeof a === 'string' && a.length < 500)) {
    throw new Error(`Invalid ${label} arguments`)
  }
  return args
}

const KANBAN_VERBS = new Set([
  'init', 'boards', 'create', 'swarm', 'list', 'ls', 'show', 'assign',
  'set-model', 'reclaim', 'reassign', 'diagnostics', 'diag', 'link',
  'unlink', 'claim', 'comment', 'attach', 'attachments', 'attach-rm',
  'complete', 'edit', 'block', 'schedule', 'unblock', 'request-review',
  'request-changes', 'reopen-review', 'promote', 'archive', 'tail',
  'dispatch', 'daemon', 'watch', 'stats', 'notify-subscribe',
  'notify-list', 'notify-unsubscribe', 'log', 'runs', 'heartbeat',
  'assignees', 'context', 'specify', 'decompose', 'gc', 'repair',
])

const KANBAN_READ_ONLY = ['boards', 'list', 'ls', 'show', 'stats', 'log', 'runs', 'context', 'assignees']

ipcHandle('maia:kanban', async (_event, rawArgs) => {
  const plan = cliPlan('kanban', rawArgs)
  if (plan.confirm && !await confirmPrivileged(_event, plan)) return { ok: false, error: 'cancelled' }
  const args = plan.args
  if (args.length === 0) throw new Error('maia:kanban requires a verb')
  const verb = args[0]
  if (!KANBAN_VERBS.has(verb)) throw new Error(`Unknown kanban verb: ${verb}`)
  return runHermes(args, KANBAN_READ_ONLY, { prefix: ['kanban'] })
})

/**
 * Generalized Hermes bridge. Kinds:
 *   - kanban  → same as maia:kanban (reuses runHermes)
 *   - mcp     → hermes mcp <verb> …; read-only for list/ls, raw text output
 *   - status  → hermes status (no args allowed), raw text
 *   - secrets → status-only secret-manager inspection (raw text)
 *
 * Returns { ok, code, data, error }. Same validation discipline as
 * maia:kanban: strings < 500 chars, verb must be in the allowlist.
 */
const MCP_VERBS = new Set([
  'serve', 'add', 'remove', 'rm', 'list', 'ls', 'test', 'configure',
  'config', 'login', 'reauth', 'picker', 'catalog', 'install',
])
const MCP_READ_ONLY = ['list', 'ls']

const SECRET_VERBS = new Set(['bitwarden', 'bw', 'onepassword', 'op', '1password'])

const SESSIONS_VERBS = new Set(['list', 'stats', 'export'])

const CRON_VERBS = new Set([
  'list', 'create', 'add', 'edit', 'pause', 'resume', 'run',
  'remove', 'rm', 'delete', 'status',
])

function sanitizeCronArgs(rawArgs) {
  const args = Array.isArray(rawArgs) ? rawArgs : []
  if (!args.every((a) => typeof a === 'string' && a.length < 8000)) {
    throw new Error('Invalid hermes cron arguments')
  }
  return args
}

function listCronJobsFromDisk() {
  const file = path.join(os.homedir(), '.hermes', 'cron', 'jobs.json')
  try {
    const raw = fsSync.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    const jobs = Array.isArray(parsed) ? parsed : parsed?.jobs || parsed?.items || []
    return { ok: true, code: 0, data: Array.isArray(jobs) ? jobs : [] }
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, code: 0, data: [] }
    return { ok: false, code: -1, data: null, error: String(err.message || err) }
  }
}

/**
 * Local/remote filesystem bridge for the file tree + preview panels.
 *
 * Phase 1 = LOCAL host filesystem via hardened Node fs in the main process
 * (mirrors hermes desktop's `hermes:fs:*` IPC). Phase 2 = linked Nub VM via
 * dashboard `/api/fs/*` (same shape as official Hermes desktop). File
 * ops never fall back to chat — that filled the VM 10-run cap.
 *
 * Verbs: list | read-text | read-data-url | write-text | stat | git-status |
 *        git-diff | root
 * Paths are validated (absolute, no NUL, must stay under $HOME).
 */
const os = require('os')
const fsSync = require('fs')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { isInsideRoot } = require('./fs-guard.cjs')

/**
 * M1 (red team): validateFsPath runs at check time, but the actual
 * read/write happens later — a symlink swapped in between is a classic
 * TOCTOU escape. These helpers re-resolve symlinks IMMEDIATELY before each
 * operation and re-check home containment on the resolved path. Reads then
 * target the realpath; writes open with O_NOFOLLOW so a leaf symlink fails
 * closed (POSIX only — Windows has no O_NOFOLLOW).
 */
function assertRealInsideRoot(candidate, label) {
  let real
  try {
    real = fsSync.realpathSync(candidate)
  } catch (err) {
    throw new Error(`Invalid ${label}: ${err && err.message ? err.message : 'unresolvable'}`)
  }
  const roots = allowedFsRoots()
  if (!roots.some((root) => isInsideRoot(root, real))) {
    throw new Error(`Invalid ${label}: outside home`)
  }
  return real
}

async function hardenedReadFile(rawValidatedPath, encoding) {
  const real = assertRealInsideRoot(rawValidatedPath, 'file')
  return readFileBounded(real, encoding)
}

async function hardenedWriteTextFile(rawValidatedPath, content) {
  await fs.mkdir(path.dirname(rawValidatedPath), { recursive: true })
  // Re-check AFTER mkdir: directory creation itself may have traversed a
  // freshly planted symlink in the parent chain.
  const parentReal = assertRealInsideRoot(path.dirname(rawValidatedPath), 'dir')
  const finalPath = path.join(parentReal, path.basename(rawValidatedPath))
  if (process.platform !== 'win32') {
    // O_NOFOLLOW: a symlink planted at the leaf after our checks fails the
    // open with ELOOP instead of writing through it.
    const noFollow = fsSync.constants.O_NOFOLLOW || 0
    await fs.writeFile(
      finalPath,
      content,
      {
        encoding: 'utf8',
        flag:
          fsSync.constants.O_WRONLY |
          fsSync.constants.O_CREAT |
          fsSync.constants.O_TRUNC |
          noFollow,
      },
    )
  } else {
    await fs.writeFile(finalPath, content, 'utf8')
  }
  return finalPath
}

const FS_VERBS = new Set([
  'list', 'read-text', 'read-data-url', 'write-text', 'stat',
  'git-status', 'git-diff', 'root',
  'defaultRoot',
])

/**
 * L2 (red team): git in a hostile repo can execute code via core.fsmonitor
 * or core.hooksPath (CVE-2024-32002 class). Both are disabled for every
 * invocation we make — we only ever want read-only plumbing output.
 * Pass-3: git itself is resolved through bin-guard, not bare PATH.
 */
const GIT_SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']

function runGit(repoRoot, args) {
  return new Promise((resolve) => {
    const gb = binGuard.resolveTrustedBin('git')
    if (!gb.ok) {
      resolve({ ok: false, code: -1, data: '', error: `git unavailable: ${gb.error}` })
      return
    }
    execFile(gb.bin, [...GIT_SAFE_CONFIG, ...args], { cwd: repoRoot, env: agentEnv.gitEnv(), maxBuffer: 8 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? -1) : 0, data: stdout.trim(), error: err ? (stderr.trim() || err.message) : undefined })
    })
  })
}

async function fsGitRoot(startPath) {
  // git must run from a DIRECTORY (cwd), not a file path
  let cwd = startPath
  try {
    const st = await fs.stat(startPath)
    if (!st.isDirectory()) cwd = path.dirname(startPath)
  } catch { /* keep as-is */ }
  const git = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!git.ok) return null
  try {
    return validateFsPath(git.data, 'git root')
  } catch {
    return null
  }
}

async function fsGitStatusForPath(filePath) {
  const root = await fsGitRoot(filePath)
  if (!root) return { ok: true, data: null }
  const res = await runGit(root, ['status', '--porcelain', '--', path.relative(root, filePath)])
  if (!res.ok) return { ok: true, data: null }
  const line = res.data.split('\n')[0]
  if (!line) return { ok: true, data: null }
  const code = line.slice(0, 2).trim()
  const kind = code === '??' ? 'added' : code.includes('U') ? 'conflicted' : 'modified'
  return { ok: true, data: { kind, branch: null } }
}

async function fsHandle(kind, args) {
  const verb = args[0]
  if (!FS_VERBS.has(verb)) throw new Error(`Unknown fs verb: ${verb}`)

  try {
  switch (verb) {
    case 'defaultRoot': {
      if (args.length !== 1) throw new Error('defaultRoot takes no arguments')
      return { ok: true, data: await fsAccess.ensure() }
    }
    case 'list': {
      const dir = assertRealInsideRoot(validateFsPath(args[1], 'dir'), 'dir')
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const out = []
      for (const ent of entries) {
        const full = path.join(dir, ent.name)
        if (!fsAccess.canAccess(full)) continue
        let isDirectory = ent.isDirectory()
        if (!isDirectory && !ent.isSymbolicLink()) {
          try { isDirectory = (await fs.stat(full)).isDirectory() } catch { /* ignore */ }
        }
        out.push({ name: ent.name, path: full, isDirectory })
      }
      out.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
      return { ok: true, data: { path: dir, entries: out } }
    }
    case 'read-text': {
      const file = validateFsPath(args[1], 'file')
      const content = await hardenedReadFile(file, 'utf8')
      return { ok: true, data: { path: file, content } }
    }
    case 'read-data-url': {
      const file = validateFsPath(args[1], 'file')
      const buf = await hardenedReadFile(file)
      const ext = path.extname(file).toLowerCase().slice(1)
      const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'svg' ? 'image/svg+xml' : 'application/octet-stream'
      return { ok: true, data: `data:${mime};base64,${buf.toString('base64')}` }
    }
    case 'write-text': {
      const file = validateFsPath(args[1], 'file')
      const content = args[2] ?? ''
      await hardenedWriteTextFile(file, content)
      return { ok: true, data: { path: file } }
    }
    case 'stat': {
      const file = validateFsPath(args[1], 'path')
      const real = assertRealInsideRoot(file, 'path')
      const st = await fs.stat(real)
      const status = await fsGitStatusForPath(real)
      return { ok: true, data: { path: file, isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs, gitStatus: status.ok ? status.data : null } }
    }
    case 'git-status': {
      const root = await fsGitRoot(args[1] ? validateFsPath(args[1], 'path') : defaultFsRoot())
      if (!root) return { ok: true, data: { root: null, files: [] } }
      const res = await runGit(root, ['status', '--porcelain'])
      if (!res.ok) return { ok: true, data: { root, files: [] } }
      const files = res.data.split('\n').filter(Boolean).map((line) => {
        const code = line.slice(0, 2).trim()
        const filePath = path.join(root, line.slice(3))
        return { path: filePath, kind: code === '??' ? 'added' : code.includes('U') ? 'conflicted' : 'modified' }
      })
      return { ok: true, data: { root, files } }
    }
    case 'git-diff': {
      const file = validateFsPath(args[1], 'file')
      const root = await fsGitRoot(file)
      if (!root) return { ok: false, data: null, error: 'not a git repo' }
      const res = await runGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--', path.relative(root, file)])
      return { ok: res.ok, data: res.data, error: res.error }
    }
    case 'root': {
      const start = args[1] ? validateFsPath(args[1], 'path') : defaultFsRoot()
      const gitRoot = await fsGitRoot(start)
      let defaultCwd = defaultFsRoot()
      if (process.env.HERMES_CWD) {
        try {
          defaultCwd = validateFsPath(process.env.HERMES_CWD, 'cwd')
        } catch {
          /* keep jailed default */
        }
      }
      return { ok: true, data: { cwd: start, gitRoot, defaultCwd } }
    }
    default:
      throw new Error(`Unknown fs verb: ${verb}`)
  }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

ipcHandle('maia:hermes', async (_event, kind, rawArgs) => {
  if (typeof kind !== 'string') throw new Error('maia:hermes requires a kind')
  if (kind === 'fs') {
    if (!Array.isArray(rawArgs) || rawArgs.length < 1 || rawArgs.length > 3 ||
        !rawArgs.every(v => typeof v === 'string' && !v.includes('\0')) ||
        rawArgs.some(v => v.length > 1024 * 1024)) throw new Error('Invalid filesystem arguments')
    const args = [...rawArgs]
    const counts = { defaultRoot: [1], list: [2], 'read-text': [2], 'read-data-url': [2],
      'write-text': [3], stat: [2], 'git-status': [1, 2], 'git-diff': [2], root: [1, 2] }
    if (!counts[args[0]]?.includes(args.length)) throw new Error('Invalid filesystem operation')
    if (args[0] === 'write-text') {
      const file = validateFsPath(args[1], 'file')
      const generation = fsAccess.generation
      if (!await confirmPrivileged(_event, { message: 'Write this workspace file?',
        detail: `${file}\n${Buffer.byteLength(args[2], 'utf8')} bytes. Existing contents will be replaced.` }) ||
          generation !== fsAccess.generation) return { ok: false, error: 'cancelled' }
      validateFsPath(file, 'file')
    }
    return fsHandle(kind, args)
  }
  const plan = cliPlan(kind, rawArgs)
  if (plan.confirm && !await confirmPrivileged(_event, plan)) return { ok: false, error: 'cancelled' }
  rawArgs = plan.args
  if (kind === 'cron') {
    const cronArgs = sanitizeCronArgs(rawArgs)
    const cronVerb = cronArgs[0]
    if (!cronVerb) throw new Error('maia:hermes cron requires a verb')
    if (!CRON_VERBS.has(cronVerb)) throw new Error(`Unknown cron verb: ${cronVerb}`)
    if (cronVerb === 'list') return listCronJobsFromDisk()
    return runHermes(cronArgs, ['list', 'status'], { injectJson: false, prefix: ['cron'] })
  }
  const args = sanitizeArgs(rawArgs, 'hermes')
  const verb = args[0]

  switch (kind) {
    case 'kanban': {
      if (args.length === 0) throw new Error('maia:hermes kanban requires a verb')
      if (!KANBAN_VERBS.has(verb)) throw new Error(`Unknown kanban verb: ${verb}`)
      return runHermes(args, KANBAN_READ_ONLY, { prefix: ['kanban'] })
    }
    case 'mcp': {
      if (args.length === 0) throw new Error('maia:hermes mcp requires a verb')
      if (!MCP_VERBS.has(verb)) throw new Error(`Unknown mcp verb: ${verb}`)
      // mcp list may not support --json — keep raw text output. No --json injection.
      return runHermes(args, MCP_READ_ONLY, { injectJson: false, prefix: ['mcp'] })
    }
    case 'status': {
      if (args.length !== 0) throw new Error('maia:hermes status takes no arguments')
      return runHermes([], [], { injectJson: false, prefix: ['status'] })
    }
    case 'secrets': {
      if (args.length === 0) throw new Error('maia:hermes secrets requires a verb')
      if (!SECRET_VERBS.has(verb)) throw new Error(`Unknown secrets verb: ${verb}`)
      // status-only usage; raw text output
      return runHermes(args, [], { injectJson: false, prefix: ['secrets'] })
    }
    case 'sessions': {
      if (args.length === 0) throw new Error('maia:hermes sessions requires a verb')
      if (!SESSIONS_VERBS.has(verb)) throw new Error(`Unknown sessions verb: ${verb}`)
      // `hermes sessions list` has no --json — parse the table in the renderer.
      return runHermes(args, [], { injectJson: false, prefix: ['sessions'] })
    }
    case 'fs': {
      if (args.length === 0) throw new Error('maia:hermes fs requires a verb')
      return fsHandle(kind, args)
    }
    default:
      throw new Error(`Unknown hermes kind: ${kind}`)
  }
})

let choosingFsRoot = false
ipcHandle('maia:fs:chooseRoot', async (event) => {
  if (choosingFsRoot) return { ok: false, error: 'cancelled' }
  choosingFsRoot = true
  try {
  const owner = event.sender
  const frame = event.senderFrame
  const generation = fsAccess.generation
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a workspace for Hermes Desk',
    message: 'Only this folder will be available in Files. Hidden credential storage and app files remain blocked.',
    properties: ['openDirectory'],
  })
  if (result.canceled || !result.filePaths?.[0] || generation !== fsAccess.generation ||
      owner.isDestroyed() || owner !== mainWindow?.webContents || frame !== owner.mainFrame) return { ok: false, error: 'cancelled' }
  return { ok: true, data: fsAccess.select(result.filePaths[0]) }
  } finally { choosingFsRoot = false }
})

/**
 * Local agent task-queue CLI path. The ~/.agent-tasks queue is the same one
 * the `task-queue` skill / `task_queue_*` MCP tools talk to; here we drive it
 * straight from the desktop app so subagent kinds can be spawned onto a real
 * local worker instead of being display-only.
 *
 * M4 (red team): resolved from os.homedir() (never empty) rather than
 * process.env.HOME — an unset/empty HOME used to yield a cwd-relative path.
 */
const TASK_CLI = path.join(os.homedir(), '.agent-tasks', 'bin', 'task')

/** Subcommands we allow through `maia:task`. Mirrors the queue's own verbs. */
const TASK_VERBS = new Set(['add', 'list', 'show', 'reply', 'cancel'])

/**
 * Run the task-queue CLI in the main process and collect stdout/stderr.
 * The CLI has no --json anywhere (verified via `task add/list --help`), so
 * data is always the trimmed combined text. Resolves { ok, code, data, error }.
 *
 * @param {string[]} args full argv including the verb (args[0]).
 */
function runTask(args) {
  // M4: same discipline as secrets-op — verify the binary before exec. A
  // missing or group/world-writable task CLI is refused, not spawned.
  const trust = binGuard.inspectBinTrust(TASK_CLI)
  if (!trust.ok) {
    return Promise.resolve({ ok: false, code: -1, data: null, error: `task queue unavailable: ${trust.error}` })
  }
  return runBoundedCli(TASK_CLI, args, agentEnv.scrubAgentEnv())
}

ipcHandle('maia:task', async (_event, rawArgs) => {
  const plan = cliPlan('task', rawArgs)
  if (plan.confirm && !await confirmPrivileged(_event, plan)) return { ok: false, error: 'cancelled' }
  const args = plan.args
  if (args.length === 0) throw new Error('maia:task requires a verb')
  const verb = args[0]
  if (!TASK_VERBS.has(verb)) throw new Error(`Unknown task verb: ${verb}`)
  return runTask(args)
})

/**
 * Local STT status — a usable whisper model + whisper-cli on PATH.
 * The renderer hides the mic when this is not ok.
 */
ipcHandle('maia:sttStatus', async () => {
  const model = sttLocal.resolveWhisperModel()
  if (!model) return { ok: false, error: 'no local whisper model' }
  const bin = sttLocal.resolveBin('whisper-cli')
  if (!bin) return { ok: false, error: 'whisper-cli not found on PATH' }
  return { ok: true, model }
})

/**
 * Local STT transcription: renderer sends recorded mic bytes (+ mimeType);
 * main converts with ffmpeg and transcribes with whisper.cpp. Fully on-device.
 *
 * L3 (red team): whisper.cpp is CPU-bound — a compromised renderer could
 * previously spawn unbounded concurrent transcriptions. Cap at one; extra
 * requests get an immediate busy signal instead of queueing.
 */
const MAX_STT_INFLIGHT = 1
let sttInflight = 0

ipcHandle('maia:sttTranscribe', async (_event, payload) => {
  const audio = payload && payload.audio
  const arrayLike = audio instanceof Uint8Array || audio instanceof ArrayBuffer
  if (!arrayLike || audio.byteLength < 1) {
    throw new Error('sttTranscribe requires non-empty audio bytes')
  }
  if (audio.byteLength > sttLocal.MAX_AUDIO_BYTES) {
    throw new Error('audio clip too large')
  }
  const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType : ''
  if (sttInflight >= MAX_STT_INFLIGHT) {
    return { ok: false, error: 'a transcription is already running — try again when it finishes' }
  }
  sttInflight += 1
  try {
    return await sttLocal.transcribeAudioBuffer({ audio, mimeType })
  } finally {
    sttInflight -= 1
  }
})

/**
 * B4 secrets keyring (Grok sand-op-launcher parity): verified-`op` access.
 * List is metadata-only presence. Copy resolves AND writes the clipboard
 * here in main (#161) — the value never enters renderer JS, is never
 * logged, and is wiped from the clipboard after secretsOp.CLIPBOARD_CLEAR_MS
 * unless the user copied something else since.
 */
ipcHandle('maia:secretsList', async () => secretsOp.listSecrets())
ipcHandle('maia:secretsCopy', async (_event, reference) => {
  if (!await confirmPrivileged(_event, { message: 'Copy a 1Password secret?',
    detail: 'The requested secret will be placed on the system clipboard for 45 seconds. Other applications may read it.' })) return { ok: false, error: 'cancelled' }
  return secretsOp.copySecretToClipboard(reference, clipboard)
})
// Write path: create + update-value only (no delete by design). Payloads are
// shape-checked here AND in secrets-op; values travel IPC in memory and are
// never logged — main.cjs must never console.log these arguments.
ipcHandle('maia:secretsCreate', async (_event, payload) => {
  const input = { title: payload?.title, value: payload?.value, vault: payload?.vault }
  if (!await confirmPrivileged(_event, { message: 'Create a 1Password secret?',
    detail: 'Create a new login item. The secret value is never shown in this permission dialog.' })) return { ok: false, error: 'cancelled' }
  return secretsOp.createSecret({
    title: input.title, value: input.value, vault: input.vault,
  })
})
ipcHandle('maia:secretsUpdateValue', async (_event, payload) => {
  const input = { id: payload?.id, value: payload?.value }
  if (!await confirmPrivileged(_event, { message: 'Replace a 1Password secret?',
    detail: 'The existing password value will be replaced. Only approve a change you requested.' })) return { ok: false, error: 'cancelled' }
  return secretsOp.updateSecretValue(input)
})

/**
 * Serve transport config for the renderer (Hermes-native transport).
 * #161: presence only — { present, baseUrl, tokenSource, hermesHome, error? }.
 * The dashboard session token never crosses IPC: REST requests get the
 * header from installServeAuth (webRequest, app windows' top frames only) and
 * WebSockets are opened by main (maia:serveSocket*). See serve-auth.cjs for
 * token precedence and base URL rules.
 */
let localBoot = null
let serveEndpoint = { baseUrl: serveAuth.DEFAULT_SERVE_URL, auth: { token: '', source: 'none' } }
const getServeToken = async () => serveEndpoint.auth
let serveSockets = null
let serveRest = null
let serveEndpointGeneration = 0

/** REST header injection for the serve origin; must run before any window loads. */
function installServeAuthForAppWindows() {
  serveAuth.installServeAuth(session.defaultSession, {
    baseUrl: serveRest?.baseUrl || serveEndpoint.baseUrl,
    getToken: async () => serveRest?.auth || { token: '', source: 'none' },
    getTrustedWebContents: () =>
      [mainWindow, hudWindow].filter((w) => w && !w.isDestroyed()).map((w) => w.webContents),
  })
}

function clearServeEndpoint() {
  serveEndpointGeneration++
  void serveRest?.close()
  serveRest = null
  for (const win of [mainWindow, hudWindow]) {
    if (win && !win.isDestroyed()) serveSockets?.closeAllFor(win.webContents)
  }
  serveSockets = null
  serveEndpoint = { ...serveEndpoint, auth: { token: '', source: 'none' } }
}

const localServeAuth = {
  async setEndpoint({ baseUrl, auth, client, verifyPeer }) {
    clearServeEndpoint()
    const generation = serveEndpointGeneration
    const rest = await serveAuth.createServeRestProxy({ baseUrl, auth, verifyPeer,
      confirmMutation: ({ senderId, method, path: route, body }) => {
        const win = [mainWindow, hudWindow].find(w => w && !w.isDestroyed() && w.webContents.id === senderId)
        if (!win) return false
        const sender = win.webContents
        return confirmPrivileged({ sender, senderFrame: sender.mainFrame }, {
          message: 'Allow this agent configuration or task change once?',
          detail: `${method} ${route}\n${body}`,
        })
      },
    })
    if (generation !== serveEndpointGeneration) { await rest.close(); return }
    serveRest = rest
    serveEndpoint = { baseUrl, auth, verifyPeer }
    const broker = serveAuth.createServeSocketBroker({ baseUrl, getToken: getServeToken,
      WebSocketImpl: serveAuth.verifiedWebSocket(verifyPeer) })
    serveSockets = client.bindRendererBroker(broker)
    installServeAuthForAppWindows()
  },
  clearEndpoint: clearServeEndpoint,
  setProfileTimezone(profile, timezone) {
    const generation = serveEndpointGeneration
    const endpoint = { ...serveEndpoint }
    return require('./local/profile-timezone.cjs').setProfileTimezone(profile, timezone, endpoint,
      () => generation === serveEndpointGeneration && Boolean(endpoint.auth?.token))
  },
  computerRequest(requestPath) {
    return require('./local/computer-pip.cjs').computerRequest(requestPath, serveEndpoint)
  },
}

ipcHandle('maia:serveConfig', async () => {
  await localBoot?.ready
  return serveAuth.serveConfigForRenderer(await getServeToken(), {
    HERMES_SERVE_URL: serveRest?.baseUrl || serveEndpoint.baseUrl,
    HERMES_HOME: path.join(require('os').homedir(), '.hermes'),
  })
})
ipcHandle('maia:serveSocketOpen', async (event, payload) => {
  await localBoot?.ready
  return serveSockets ? serveSockets.open(event.sender, payload) : { ok: false, error: 'Hermes serve offline' }
})
ipcHandle('maia:serveSocketSend', (event, payload) =>
  serveSockets ? serveSockets.send(event.sender, payload) : { ok: false, error: 'Hermes serve offline' })
ipcHandle('maia:serveSocketClose', (event, payload) =>
  serveSockets ? serveSockets.close(event.sender, payload) : { ok: true })

const gotLock = nativeQualification ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    showMainWindow(true)
  })
}

app.whenReady().then(async () => {
  if (!gotLock) return
  if (nativeQualification) {
    // Distinct from NUB_SMOKE: no backend, transport/auth, workspace/plugin
    // bootstrap, menus/tray/shortcuts/accessibility or profile recovery.
    createWindow()
    return
  }
  protocol?.handle('hd-media', request => mediaFiles.response(request))
  // Only a profile identifier crosses the renderer boundary, never a file path.
  protocol?.handle('hd-avatar', async (request) => {
    try {
      const home = require('./local/hermes-host.cjs').resolveHermesHome({ app }, process.env)
      return require('./local/host-config.cjs').avatarResponse(home, request.url)
    } catch { return new Response(null, { status: 404 }) }
  })
  if (process.platform === 'darwin' && app.dock) {
    if (e2eBackground) app.dock.hide()
    else app.dock.setIcon(path.join(__dirname, 'icon.png'))
  }
  // Discoverable entry points for the orb: the Window menu (installed here)
  // and the TopBar button, which reads maia:hud:changed. The menu must be
  // installed before createWindow so the first window inherits it.
  installAppMenu()
  installHudTray()
  maybeRequestAccessibility()
  try {
    if (nativeTheme && typeof nativeTheme.on === 'function') {
      nativeTheme.on('updated', syncWindowBackground)
    }
  } catch {}
  installServeAuthForAppWindows()
  createWindow()
  localBoot = require('./local/boot.cjs')({
    app, ipcMain, ipcHandle, assertMainSender, getMainWindow: () => mainWindow,
    BrowserWindow, WebContentsView, session, dialog, shell, clipboard,
    userDataDir: app.getPath('userData'), isPackaged: app.isPackaged, e2eBackground,
    serveAuth: localServeAuth, secretsOp,
    approveRendererAction: (sender, request) => confirmPrivileged({ sender, senderFrame: sender.mainFrame }, {
      message: 'Allow this pending agent command once?',
      detail: `Session: ${request.sessionId || 'server request'}\n${request.detail}`,
    }),
    approveModelDefault: (sender, request) => confirmPrivileged({ sender, senderFrame: sender.mainFrame }, {
      message: `Make ${request.model} the default model for ${request.profile}?`,
      detail: `Provider: ${request.provider}\nNew chats with this profile will use it. Other profiles stay unchanged.`,
    }),
    onTrayChanged: installHudTray,
    onWorkspaceActivity: (activity) => {
      workspaceHudActivity = activity
      updateHudActivity()
    },
    notify: (payload) => {
      const n = systemNotify.sanitizeNotification(payload)
      if (e2eBackground || !n || !Notification.isSupported()) return
      // Ad-hoc (unsigned) builds may lack the UNNotification identity; never
      // let a notification take down the HUD host.
      try {
        const note = new Notification({ title: n.title, body: n.body })
        note.on('failed', (event, error) => console.warn('[hud] notification failed:', error && error.message))
        note.show()
      } catch (error) {
        console.warn('[hud] notification unavailable:', error && error.message)
      }
    },
  })
  installHudTray()
  // Global HUD shortcut — mirrors hermes-agent's floating HUD toggle.
  // Cmd+Shift+H (mac) / Ctrl+Shift+H (other) — alwaysOnTop orb over whatever
  // app you are in. Sole owner of the combo; see HUD_SHORTCUT.
  try {
    const registered = globalShortcut.register(HUD_SHORTCUT, () => {
      try { toggleHudWindow() } catch {}
    })
    if (!registered) console.warn('[hud] global shortcut already taken:', HUD_SHORTCUT)
  } catch (err) {
    console.warn('[hud] global shortcut registration failed:', err && err.message)
  }
  // Auto-restore the orb at launch: if it was open when the app quit, bring
  // the cat back (showInactive — no focus steal). Skipped under smoke/probe
  // envs, which drive the HUD themselves.
  if (process.env.NUB_SMOKE_HUD !== '1' && !process.env.NUB_SMOKE) {
    try {
      const bootState = hudState.loadHudState(fsSync.readFileSync, hudState.hudStatePath(app.getPath('userData')))
      if (bootState && bootState.open === true) createHudWindow()
    } catch (err) {
      console.warn('[hud] orb auto-restore skipped:', err && err.message)
    }
  }
  if (process.env.NUB_SMOKE_HUD === '1') {
    setTimeout(() => {
      try {
        runHudSmoke()
      } catch (err) {
        console.error('[hud] smoke FAILED:', err && err.message)
        app.exit(1)
      }
    }, 50)
  }
  app.on('activate', () => {
    if (e2eBackground) return
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  if (nativeQualification) return
  mediaFiles.clear()
  nativeFiles.clear()
  // See setHudOpenState: window 'closed' handlers must not persist open:false
  // while quitting — the flag that was true when the user quit must survive.
  hudQuitting = true
  stopHudWalk()
  // Persist the intent state now: 'closed' teardown during quit skips its own
  // persist (hudQuitting), so without this the orb's auto-restore flag would
  // be whatever the last debounced move/resize save happened to hold.
  try {
    hudState.persistHudState(fsSync.writeFileSync, hudState.hudStatePath(app.getPath('userData')), { ...hudSavedState, open: hudMenuOpen })
  } catch {}
})

app.on('will-quit', () => {
  if (nativeQualification) return
  stopHudWalk()
  try { globalShortcut.unregisterAll() } catch {}
  if (hudTray) {
    try { hudTray.destroy() } catch {}
    hudTray = null
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
