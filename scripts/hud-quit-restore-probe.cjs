/**
 * Behavioral probe: the orb's 'open' flag must SURVIVE a normal quit.
 *
 * Bug it exists to catch (2026-08-29, caught by independent review): Electron
 * fires hudWindow 'closed' BEFORE 'will-quit' on a normal quit, and the
 * 'closed' handler calls setHudOpenState(false), which persisted open:false —
 * clobbering the open:true saved when the orb was opened. Result: auto-restore
 * only worked after a crash/SIGKILL, never after Cmd+Q / Dock Quit / tray Quit.
 *
 * This probe drives the REAL app (electron/main.cjs): seeds a state file with
 * open:true + a saved orb, boots, waits for the auto-restored orb window, quits
 * normally, then reads the state file back. PASS requires the orb window to
 * have appeared AND open to still be true after the full quit lifecycle.
 *
 * Launch: env -u ELECTRON_RUN_AS_NODE npx electron scripts/hud-quit-restore-probe.cjs --no-sandbox
 * Output: HUD_QUIT_RESTORE done ok|FAILED hudSeen=... open=... (exit 0/1)
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

// Fresh, isolated userData — never touch the developer's real state.
const dir = path.join(os.tmpdir(), 'nub-quit-restore-probe')
app.setPath('userData', dir)
fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir, { recursive: true })

// Seed: the orb was OPEN with a saved spot when the app quit.
fs.writeFileSync(
  path.join(dir, 'hud-window-state.json'),
  JSON.stringify({
    version: 2,
    expanded: { x: 200, y: 200, width: 700, height: 400 },
    orb: { x: 200, y: 200 },
    open: true,
  }),
)
// Suppress the Accessibility system dialog (would hang the probe).
fs.writeFileSync(path.join(dir, 'accessibility-prompt.json'), JSON.stringify({ asked: true, at: new Date().toISOString() }))

let hudSeen = false
app.whenReady().then(() => {
  // Give the boot sequence (createWindow + auto-restore) time to run.
  setTimeout(() => {
    const wins = BrowserWindow.getAllWindows()
    // Main window + auto-restored orb window = 2. If auto-restore is broken,
    // only the main window exists and this probe must fail loudly.
    hudSeen = wins.length >= 2
    app.quit()
  }, 5000)
})

// Runs AFTER the quit lifecycle closed the windows (closed → setHudOpenState(false)).
app.on('will-quit', () => {
  let open = null
  try {
    open = JSON.parse(fs.readFileSync(path.join(dir, 'hud-window-state.json'), 'utf8')).open
  } catch {}
  const ok = hudSeen && open === true
  console.log(`HUD_QUIT_RESTORE done ${ok ? 'ok' : 'FAILED'} hudSeen=${hudSeen} open=${JSON.stringify(open)} userData=${dir}`)
  process.exitCode = ok ? 0 : 1
})

// Boot the real app — registers whenReady/before-quit/will-quit and auto-restores.
require('../electron/main.cjs')
