'use strict'

/**
 * hud-menu-probe.cjs — does the app's Window menu really carry the orb entry
 * point at RUNTIME?
 *
 * Closes the "Known gap" in gates/hud-entry-points-GATES.md: source tripwires
 * pin the template (G3/G4) and the boot log proves installation (G5), but
 * NOTHING read `Menu.getApplicationMenu()` back. This probe installs the menu
 * through the SAME module the app uses (electron/app-menu.cjs), reads it back
 * through Electron's own API, and verifies the Window → Show Nub Orb item is
 * really there, carries the expected label, and toggles on click — including
 * the label flip when the HUD is open vs closed.
 *
 * It also checks the INSTALLED app (default /Applications/Nub Agent.app,
 * override with NUB_APP_BUNDLE): extracts electron/app-menu.cjs from the
 * shipped asar and verifies the same structural markers, so a stale package
 * cannot hide behind a green repo probe.
 *
 * Run (must be launched BY electron — see the guard below):
 *   env -u ELECTRON_RUN_AS_NODE npx electron \
 *        scripts/hud-menu-probe.cjs --no-sandbox
 *
 * One line: `HUD_MENU summary ok repo=true packaged=true` — or FAIL. Exit 0/1.
 */
const electron = require('electron')
const { app, Menu } = electron

if (!app || typeof app.whenReady !== 'function') {
  const why = typeof electron === 'string'
    ? "require('electron') returned the binary path string — launch with `npx electron scripts/hud-menu-probe.cjs`"
    : 'not running as an Electron main process'
  console.log('HUD_MENU done FAIL {"probe":"FAIL: ' + why + '"}')
  console.log('HUD_MENU summary FAIL repo=false packaged=false')
  process.exit(1)
}

const fs = require('fs')
const path = require('path')
const asar = require('@electron/asar')

const { installAppMenu } = require('../electron/app-menu.cjs')

const APP_BUNDLE = path.resolve(process.env.NUB_APP_BUNDLE || '/Applications/Nub Agent.app')
const ASAR_PATH = path.join(APP_BUNDLE, 'Contents/Resources/app.asar')

/** Walk a live Electron menu for the Window → hud-orb item, or null. */
function findOrbItem(menu) {
  const windowMenu = (menu.items || []).find((i) => i.label === 'Window')
  if (!windowMenu || !windowMenu.submenu) return null
  return (windowMenu.submenu.items || []).find((i) => i.id === 'hud-orb') || null
}

async function probeRepoMenu() {
  const clicks = []
  // Install CLOSED first: the label must advertise the shortcut.
  const menu1 = installAppMenu({
    Menu,
    hudMenuOpen: false,
    toggleHudWindow: () => clicks.push('toggled'),
    HUD_SHORTCUT_LABEL: '⌘⇧H',
  })
  if (!menu1) return { ok: false, why: 'installAppMenu returned null (buildFromTemplate threw)' }

  // The whole point: read the LIVE application menu back, not the template.
  const live = Menu.getApplicationMenu()
  if (!live) return { ok: false, why: 'Menu.getApplicationMenu() returned null' }

  const item = findOrbItem(live)
  if (!item) return { ok: false, why: 'no Window → hud-orb item in the live menu' }
  if (item.label !== 'Show Nub Orb (⌘⇧H)') {
    return { ok: false, why: 'closed label was "' + item.label + '", expected "Show Nub Orb (⌘⇧H)"' }
  }
  if (typeof item.click !== 'function') return { ok: false, why: 'hud-orb item has no click handler' }

  // Clicking the live item must reach the injected toggle — exactly once.
  item.click()
  if (clicks.length !== 1) return { ok: false, why: 'click fired ' + clicks.length + ' toggles, expected 1' }

  // Re-install OPEN: the label must flip to Hide, and the live menu must too.
  const menu2 = installAppMenu({
    Menu,
    hudMenuOpen: true,
    toggleHudWindow: () => clicks.push('toggled'),
    HUD_SHORTCUT_LABEL: '⌘⇧H',
  })
  if (!menu2) return { ok: false, why: 'second install (open) returned null' }
  const item2 = findOrbItem(Menu.getApplicationMenu())
  if (!item2) return { ok: false, why: 'no Window → hud-orb item after open install' }
  if (item2.label !== 'Hide Nub Orb') {
    return { ok: false, why: 'open label was "' + item2.label + '", expected "Hide Nub Orb"' }
  }
  return { ok: true, topLevels: live.items.length, closedLabel: item.label, openLabel: item2.label }
}

/**
 * Read electron/app-menu.cjs OUT of the installed app's asar and check the
 * same markers the repo tripwires pin — a packaged build that predates the
 * extraction (or a stray older copy) must not pass.
 */
function probePackagedMenu() {
  if (!fs.existsSync(ASAR_PATH)) return { ok: 'skip', why: 'no app at ' + APP_BUNDLE }
  let src
  try {
    // A pre-extraction build has the menu inline in main.cjs and no
    // app-menu.cjs at all — extractFile throws; report it as a stale package
    // instead of taking the whole probe down with it.
    src = asar.extractFile(ASAR_PATH, 'electron/app-menu.cjs').toString('utf8')
  } catch (err) {
    return { ok: false, why: 'installed asar has no electron/app-menu.cjs (' + String((err && err.message) || err) + ')' }
  }
  const markers = [
    ["id: 'hud-orb'", src.includes("id: 'hud-orb'")],
    ['Show Nub Orb label template', /Show Nub Orb \(\$\{HUD_SHORTCUT_LABEL\}\)/.test(src)],
    ['click: () => toggleHudWindow()', src.includes('click: () => toggleHudWindow()')],
    ["role: 'editMenu'", src.includes("role: 'editMenu'")],
    ["role: 'viewMenu'", src.includes("role: 'viewMenu'")],
    ['module.exports = { installAppMenu }', src.includes('module.exports = { installAppMenu }')],
  ]
  const missing = markers.filter(([, ok]) => !ok).map(([name]) => name)
  return missing.length
    ? { ok: false, why: 'installed asar app-menu.cjs missing: ' + missing.join(', ') }
    : { ok: true, why: 'markers ok in ' + ASAR_PATH }
}

async function main() {
  const repo = await probeRepoMenu()
  const pkg = probePackagedMenu()
  const fields = { repo: repo.ok === true, packaged: pkg.ok === true }
  const failed = Object.values(fields).some((v) => v !== true)
  console.log('  [repo] ' + JSON.stringify(repo))
  console.log('  [packaged] ' + JSON.stringify(pkg))
  console.log('HUD_MENU done ' + (failed ? 'FAIL' : 'ok') + ' ' + JSON.stringify(fields))
  console.log(
    'HUD_MENU summary ' +
      (failed ? 'FAIL' : 'ok') +
      ' repo=' +
      fields.repo +
      ' packaged=' +
      fields.packaged,
  )
  return failed ? 1 : 0
}

// The probe has no windows; without this Electron would quit mid-run with
// exit 0 and no output — exactly the "passes on failure" shape to kill.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  let code = 1
  try {
    code = await main()
  } catch (err) {
    console.log(
      'HUD_MENU done FAIL {"probe":"FAIL: threw ' +
        String((err && err.message) || err).replace(/"/g, "'") +
        '"}',
    )
    console.log('HUD_MENU summary FAIL repo=false packaged=false')
    code = 1
  }
  // app.exit() tears the process down before stdout is flushed when the
  // output is a pipe, which silently swallows every line above. Yield first.
  setTimeout(() => app.exit(code), 200)
})
