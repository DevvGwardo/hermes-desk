import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { mainFunction, normalStartup } from './main-source.test.support.mjs'
import {
  CLICK_ONCE_RE,
  CLICK_RE,
  POINT_ONCE_RE,
  POINT_RE,
  TYPE_ONCE_RE,
  TYPE_RE,
} from '../src/lib/hud-protocol'

/**
 * Structural tripwires for the HUD mascot-widget (Clippy-style) mode.
 * If a refactor silently reverts the hotkey fix, the v2 state wiring, the
 * orb-position docking, or the no-focus-steal open, these fail loudly.
 */
const require = createRequire(import.meta.url)
const main = readFileSync(require.resolve('./main.cjs'), 'utf8')
const hudStateSrc = readFileSync(require.resolve('./hud-state.cjs'), 'utf8')
const preload = readFileSync(require.resolve('./preload.cjs'), 'utf8')
const appMenuSrc = readFileSync(require.resolve('./app-menu.cjs'), 'utf8')

describe('HUD global hotkey (G3 of the extension pass)', () => {
  it('destructures Menu, globalShortcut and screen from electron — the pre-fix code referenced globalShortcut without requiring it', () => {
    expect(main).toMatch(/const \{ app, BrowserWindow, Menu, shell, ipcMain, dialog, screen, globalShortcut, systemPreferences, Tray, nativeImage, nativeTheme, desktopCapturer, session, clipboard \} = require\('electron'\)/)
  })

  it('registers the platform-correct shortcut and it toggles the HUD', () => {
    const i = main.indexOf('Global HUD shortcut')
    expect(i).toBeGreaterThan(-1)
    const block = main.slice(i, i + 700)
    expect(block).toMatch(/globalShortcut\.register\(HUD_SHORTCUT/)
    expect(block).toMatch(/toggleHudWindow\(\)/)
  })

  it('declares the combo once, in HUD_SHORTCUT, with a separate human-readable label', () => {
    expect(main).toMatch(/const HUD_SHORTCUT = process\.platform === 'darwin' \? 'Command\+Shift\+H' : 'Control\+Shift\+H'/)
    expect(main).toMatch(/const HUD_SHORTCUT_LABEL = process\.platform === 'darwin' \? '⌘⇧H' : 'Ctrl\+Shift\+H'/)
  })

  it('detects and logs failed registration', () => {
    const i = main.indexOf('Global HUD shortcut')
    const block = main.slice(i, i + 900)
    expect(block).toMatch(/const registered = globalShortcut\.register/)
    expect(block).toMatch(/if \(!registered\) console\.warn/)
  })

  it('unregisters every shortcut on will-quit', () => {
    const block = main.slice(main.indexOf("app.on('will-quit'"), main.indexOf("app.on('will-quit'") + 300)
    expect(block).toMatch(/globalShortcut\.unregisterAll\(\)/)
  })
})

/**
 * Discoverability: the orb used to be reachable ONLY by an unlisted ⌘⇧H, and
 * closing the strip destroyed the window with no visible way back. These pin
 * the two affordances that replaced that — and the invariant that makes them
 * safe: exactly one owner per toggle.
 */
describe('HUD entry points (Window menu + TopBar button)', () => {
  const appSrc = readFileSync(require.resolve('../src/App.tsx'), 'utf8')
  const topBarSrc = readFileSync(require.resolve('../src/components/TopBar.tsx'), 'utf8')

  // The TEMPLATE lives in electron/app-menu.cjs (extracted so a probe can
  // read Menu.getApplicationMenu() back — see scripts/hud-menu-probe.cjs).
  // These tripwires pin the extracted module; the wrapper in main.cjs is
  // asserted separately below. The window is generous on purpose: these
  // assertions sit at the END of a function that grows (the install log was
  // added after the first version of this tripwire, which silently stopped
  // covering the last two lines). An assertion that falls off the end of the
  // slice is a green no-op.
  const installBlock = () => {
    const i = appMenuSrc.indexOf('function installAppMenu')
    const end = appMenuSrc.indexOf('\n}\n', i)
    expect(i).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(i)
    return appMenuSrc.slice(i, end)
  }

  it('installs an application menu carrying a Window → orb item that toggles the HUD', () => {
    const block = installBlock()
    expect(block).toMatch(/const menu = Menu\.buildFromTemplate\(template\)/)
    expect(block).toMatch(/Menu\.setApplicationMenu\(menu\)/)
    expect(block).toMatch(/id: 'hud-orb'/)
    expect(block).toMatch(/label: hudMenuOpen \? 'Hide Hermes Orb' : `Show Hermes Orb \(\$\{HUD_SHORTCUT_LABEL\}\)`/)
    expect(block).toMatch(/click: \(\) => toggleHudWindow\(\)/)
  })

  it('main.cjs delegates to the extracted module — one source of truth for the template', () => {
    expect(main).toMatch(/require\('\.\/app-menu\.cjs'\)/)
    const wrap = main.slice(main.indexOf('function installAppMenu'), main.indexOf('function installHudTray'))
    expect(wrap).toMatch(/installAppMenuImpl\(\{/)
    expect(wrap).toMatch(/toggleHudWindow,/)
    expect(wrap).toMatch(/HUD_SHORTCUT_LABEL,/)
    // The template itself must NOT live in main.cjs any more.
    expect(wrap).not.toMatch(/buildFromTemplate/)
  })

  it('the extracted module exports installAppMenu for the probe', () => {
    expect(appMenuSrc).toMatch(/module\.exports = \{ installAppMenu \}/)
  })

  it('logs the installed menu so a thrown buildFromTemplate cannot pass silently', () => {
    const block = installBlock()
    // The module logs through injectable log/warn (defaulted to console) so a
    // probe can observe without polluting its own output.
    expect(block).toMatch(/log\(\s*`\[hud\] app menu installed/)
    expect(block).toMatch(/warn\('\[hud\] app menu install failed:'/)
    expect(block).toMatch(/log = console\.log/)
    expect(block).toMatch(/warn = console\.warn/)
  })

  it('keeps the standard Edit/View/File roles — a hand-rolled menu would silently drop ⌘C/⌘V', () => {
    const block = installBlock()
    expect(block).toMatch(/role: 'editMenu'/)
    expect(block).toMatch(/role: 'viewMenu'/)
    expect(block).toMatch(/role: 'fileMenu'/)
  })

  it('advertises the hotkey in the LABEL, never as a menu accelerator — an accelerator on the same combo double-fires with globalShortcut', () => {
    const block = installBlock()
    expect(block).not.toMatch(/accelerator/)
  })

  it('installs the menu and requests accessibility at startup, before createWindow', () => {
    const block = normalStartup(main)
    expect(block.indexOf('installAppMenu()')).toBeGreaterThan(-1)
    expect(block.indexOf('maybeRequestAccessibility()')).toBeGreaterThan(-1)
    expect(block.indexOf('installAppMenu()')).toBeLessThan(block.indexOf('createWindow()'))
    expect(block.indexOf('maybeRequestAccessibility()')).toBeLessThan(block.indexOf('createWindow()'))
  })

  it('broadcasts visibility from ONE helper so the menu and the button cannot disagree', () => {
    const block = main.slice(main.indexOf('function setHudOpenState'), main.indexOf('function setHudOpenState') + 900)
    expect(block).toMatch(/maia:hud:changed/)
    expect(block).toMatch(/installAppMenu\(\)/)
    // Every open/close path calls it — including re-showing an existing window.
    const create = main.slice(main.indexOf('function createHudWindow'), main.indexOf('function toggleHudWindow'))
    expect(create).toMatch(/setHudOpenState\(true\)/)
    expect(create).toMatch(/setHudOpenState\(false\)/)
    // And no path sends the IPC directly any more (that is how they drifted).
    expect(create).not.toMatch(/webContents\.send\('maia:hud:changed'/)
  })

  it('the renderer owns NO ⌘⇧H handler — two owners made the orb openable but never closable', () => {
    expect(appSrc).not.toMatch(/shiftKey && key === 'h'/)
  })

  it('mounts the orb button in the TopBar', () => {
    expect(topBarSrc).toMatch(/import \{ HudOrbButton \} from '\.\/HudOrbButton'/)
    expect(topBarSrc).toMatch(/<HudOrbButton \/>/)
  })
})

describe('accessibility request-at-startup (macOS chicken-and-egg)', () => {
  const accBlock = () => {
    const i = main.indexOf('function maybeRequestAccessibility')
    const end = main.indexOf('\n}\n', i)
    expect(i).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(i)
    return main.slice(i, end)
  }

  it('requests the Accessibility trust once at startup, macOS only', () => {
    const block = accBlock()
    expect(block).toMatch(/process\.platform !== 'darwin'/)
    expect(block).toMatch(/isTrustedAccessibilityClient\(true\)/)
  })

  it('is a no-op when already trusted — no dialog, no flag file', () => {
    const block = accBlock()
    const trusted = block.indexOf('isTrustedAccessibilityClient(false)')
    const write = block.indexOf('writeFileSync(flagFile')
    expect(trusted).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(trusted)
  })

  it('asks at most once per install — the "asked" flag persists in userData, written BEFORE the prompt', () => {
    const block = accBlock()
    expect(block).toMatch(/accessibility-prompt\.json/)
    expect(block).toMatch(/app\.getPath\('userData'\)/)
    // Pin the EXACT guard: skip when the flag EXISTS. A negated version
    // (!existsSync → return) prompts only on RE-INSTALLS and never on a fresh
    // install — the whole feature silently dead. Mutation M4 caught this.
    expect(block).toMatch(/if \(fsSync\.existsSync\(flagFile\)\) return/)
    expect(block).not.toMatch(/if \(!fsSync\.existsSync\(flagFile\)\) return/)
    const write = block.indexOf('writeFileSync(flagFile')
    const prompt = block.indexOf('isTrustedAccessibilityClient(true)')
    expect(write).toBeGreaterThan(-1)
    expect(prompt).toBeGreaterThan(write)
  })

  it('never hangs smoke/probe runs — a system dialog would block boot', () => {
    const block = accBlock()
    expect(block).toMatch(/NUB_SMOKE_HUD/)
    expect(block).toMatch(/NUB_SMOKE/)
  })

  it('a failure never blocks boot', () => {
    const block = accBlock()
    expect(block).toMatch(/catch \(err\)/)
    expect(block).toMatch(/console\.warn\('\[hud\] accessibility prompt skipped:/)
  })
})

describe('menu-bar Tray icon + orb auto-restore at launch', () => {
  const trayBlock = () => {
    const i = main.indexOf('function installHudTray')
    const end = main.indexOf('\n}\n', i)
    expect(i).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(i)
    return main.slice(i, end)
  }

  it('creates a menu-bar Tray with a Show/Hide orb item and Quit', () => {
    const block = trayBlock()
    expect(block).toMatch(/new Tray\(/)
    expect(block).toMatch(/setContextMenu\(/)
    expect(block).toMatch(/setToolTip/)
    expect(block).toMatch(/id: 'hud-tray-orb'/)
    expect(block).toMatch(/role: 'quit'/)
  })

  it('never creates the Tray in smoke/probe runs', () => {
    const block = trayBlock()
    expect(block).toMatch(/NUB_SMOKE_HUD/)
    expect(block).toMatch(/NUB_SMOKE/)
  })

  it('installs the tray at startup and refreshes its label from the ONE open-state helper', () => {
    const boot = main.slice(main.indexOf('app.whenReady()'), main.indexOf('app.whenReady()') + 1400)
    expect(boot.indexOf('installHudTray()')).toBeGreaterThan(-1)
    const open = main.slice(main.indexOf('function setHudOpenState'), main.indexOf('function setHudOpenState') + 900)
    expect(open).toMatch(/installHudTray\(\)/)
    expect(open).toMatch(/hudSavedState\.open = hudMenuOpen/)
    expect(open).toMatch(/persistHudState\(/)
  })

  it('destroys the tray on will-quit', () => {
    const block = main.slice(main.indexOf("app.on('will-quit'"), main.indexOf("app.on('will-quit'") + 400)
    expect(block).toMatch(/hudTray/)
    expect(block).toMatch(/destroy\(\)/)
  })

  it('auto-restores the orb at launch when it was open on quit, never under smoke', () => {
    const i = main.indexOf('// Auto-restore the orb at launch')
    expect(i).toBeGreaterThan(-1)
    const auto = main.slice(i, i + 700)
    expect(auto).toMatch(/bootState\.open === true/)
    expect(auto).toMatch(/createHudWindow\(\)/)
    expect(auto).toMatch(/NUB_SMOKE_HUD/)
    // Auto-restore runs AFTER the main window and the shortcut are up.
    expect(i).toBeGreaterThan(main.indexOf('createWindow()'))
  })
})

describe('quit-safe open flag (auto-restore must survive a NORMAL quit)', () => {
  const traySrc = () => {
    const i = main.indexOf('function installHudTray')
    return main.slice(i, main.indexOf('\n}\n', i))
  }

  it('marks quitting in before-quit so closed-teardown cannot clobber the flag', () => {
    const q = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('before-quit'") + 300)
    expect(q).toMatch(/hudQuitting = true/)
  })

  it('skips persisting the open flag while quitting — the persist call sits INSIDE the guard', () => {
    const open = main.slice(main.indexOf('function setHudOpenState'), main.indexOf('function installAppMenu'))
    expect(open).toMatch(/if \(!hudQuitting\)/)
    const guarded = open.slice(open.indexOf('if (!hudQuitting)'), open.indexOf('if (mainWindow'))
    expect(guarded).toMatch(/persistHudState\(/)
    // A persist outside the guard would reintroduce the crash-only restore.
    expect(guarded).toMatch(/hudSavedState\.open = hudMenuOpen/)
  })

  it('keeps the smoke-env check strict and consistent across every guard', () => {
    expect(main).toMatch(/if \(process\.env\.NUB_SMOKE_HUD === '1' \|\| process\.env\.NUB_SMOKE\) return 'about:blank'/)
  })

  it('uses a 1x+2x tray icon and warns loudly when the icon is missing', () => {
    const block = traySrc()
    expect(block).toMatch(/addRepresentation\(\{ scaleFactor: 2/)
    expect(block).toMatch(/tray icon missing/)
  })

  it('preserves the open flag when rebuilding hudSavedState at boot', () => {
    expect(main).toMatch(/hudSavedState = \{ expanded: savedExpanded, orb: savedOrb, open: savedState \? savedState\.open : undefined \}/)
  })
})

describe('mascot-widget state wiring (v2)', () => {
  it('main.cjs requires the hud-state module and takes ORB_SIZE from it', () => {
    expect(main).toMatch(/require\('\.\/hud-state\.cjs'\)/)
    expect(main).toMatch(/const \{ HUD_MIN_WIDTH, HUD_MIN_HEIGHT, ORB_SIZE \} = hudState/)
  })

  it('createHudWindow loads v2 state and OPENS AS THE ORB when the cat has a saved spot', () => {
    const block = main.slice(main.indexOf('function createHudWindow'), main.indexOf('function toggleHudWindow'))
    expect(block).toMatch(/loadHudState\(/)
    expect(block).toMatch(/clampHudBounds\(/)
    expect(block).toMatch(/clampOrbPosition\(/)
    expect(block).toMatch(/width: ORB_SIZE, height: ORB_SIZE \}/)
    expect(block).toMatch(/hudCollapse = savedOrb/) // collapsed from creation — zero strip flash
  })

  it('opens WITHOUT stealing focus (showInactive, not show/focus)', () => {
    const block = main.slice(main.indexOf('function createHudWindow'), main.indexOf('function toggleHudWindow'))
    expect(block).toMatch(/showInactive\(\)/)
    expect(block).not.toMatch(/ready-to-show[^]*&& hudWindow\.show\(\)/)
  })

  it('persists the CAT position while collapsed and full bounds while expanded', () => {
    const block = main.slice(main.indexOf('function createHudWindow'), main.indexOf('function toggleHudWindow'))
    expect(block).toMatch(/on\('resize', scheduleHudSave\)/)
    expect(block).toMatch(/on\('move', \(\) => \{/)
    expect(block).toMatch(/on\('close', saveHudStateNow\)/)
    expect(block).toMatch(/setTimeout\(saveHudStateNow, 500\)/)
    expect(block).toMatch(/hudSavedState\.orb = \{ x: b\.x, y: b\.y \}/)
    expect(block).toMatch(/hudSavedState\.expanded = b/)
    expect(block).toMatch(/persistHudState\(/)
  })

  it('setCollapsed docks to the SAVED orb spot and expands as a panel anchored on the cat', () => {
    const block = main.slice(main.indexOf("ipcHandle('maia:hud:setCollapsed'"), main.indexOf("ipcHandle('maia:hud:setCollapsed'") + 2000)
    expect(block).toMatch(/clampOrbPosition\(hudSavedState\.orb, screen\)/)
    expect(block).toMatch(/width: ORB_SIZE, height: ORB_SIZE \}/)
    expect(block).toMatch(/b\.y - h - 8/) // speech-panel-above-the-cat placement
    expect(block).toMatch(/hudCollapse\.collapsed = want/)
  })

  it('state file lives under userData; smoke asserts v2 expanded bounds', () => {
    expect(main).toMatch(/hudStatePath\(app\.getPath\('userData'\)\)/)
    expect(main).toMatch(/loadHudState\(fsSync\.readFileSync, stateFile\)/)
    expect(main).toMatch(/\[hud\] smoke ok/)
  })

  it('preload exposes setCollapsed to the renderer', () => {
    expect(preload).toMatch(/setCollapsed: \(collapsed\) => ipcRenderer\.invoke\('maia:hud:setCollapsed', \{ collapsed \}\)/)
  })
})

describe('free-float + commanded movement (Clippy-accurate moveTo/gestureAt)', () => {
  it('window is created WITHOUT native vibrancy/glass — character-only transparency', () => {
    const block = main.slice(main.indexOf('function createHudWindow'), main.indexOf('hudBoundsClamped'))
    expect(block).toContain('hasShadow: false')
    expect(block).not.toMatch(/vibrancy:/)
  })
  it('CSS is fully transparent for BOTH modes — no glass anywhere', () => {
    const css = readFileSync(require.resolve('../src/index.css'), 'utf8')
    expect(css).toMatch(/\.hud-root\s*\{[^}]*background:\s*transparent/)
    expect(css).not.toMatch(/\.hud-root[^{]*\{[^}]*rgba\(18,\s*24,\s*33/)
    expect(css).toMatch(/\.hud-orb\[data-walking\]/)
    expect(css).toMatch(/\.hud-pointer-arrow/)
    expect(css).toMatch(/prefers-reduced-motion/)
  })
  it('NO autonomy — the cat moves only when commanded', () => {
    expect(main).not.toMatch(/scheduleRoam|startRoamTimer|pickRoamTarget|ROAM_GAP/)
    // No timer-driven self-movement hookup on open or collapse:
    const openBlock = main.slice(main.indexOf('ready-to-show'), main.indexOf("hudWindow.on('closed'"))
    expect(openBlock).not.toMatch(/startRoam|scheduleRoam|hudMoveTo/)
    const collapsedBlock = main.slice(main.indexOf("ipcHandle('maia:hud:setCollapsed'"), main.indexOf("ipcHandle('maia:hud:setCollapsed'") + 2400)
    expect(collapsedBlock).toMatch(/if \(!want\) stopHudWalk\(\)/)
    expect(collapsedBlock).not.toMatch(/if \(want\).*startRoam/)
  })
  it('commanded movement — moveTo/goToCursor IPC with clamped eased walk + pointer events', () => {
    const block = main.slice(main.indexOf('Commanded movement'), main.indexOf('function toggleHudWindow'))
    expect(block).toMatch(/function hudMoveTo\(/)
    expect(block).toMatch(/hudUserDragging = false/)
    expect(block).toMatch(/Math\.sign\(dx\)/)
    expect(block).toMatch(/WALK_EASE/)
    expect(block).toMatch(/hudBoundsClamped\(/)
    expect(block).toMatch(/hudSuppressOwnMoveUntil/)
    expect(block).toMatch(/hudUserDragging/)
    expect(block).toMatch(/hudSendPointer\('walk',/)
    expect(block).toMatch(/hudSendPointer\('point',/)
    expect(block).toMatch(/'maia:hud:pointer', \{ phase, angle \}/)
    expect(main).toMatch(/ipcHandle\('maia:hud:moveTo'/)
    expect(main).toMatch(/ipcHandle\('maia:hud:goToCursor'/)
    expect(main).toMatch(/getCursorScreenPoint/)
  })
  it('walk stops on drag/close/quit and expanding cancels it', () => {
    expect(main).toMatch(/on\('closed', \(\) => \{[\s\S]*?stopHudWalk\(\)/)
    expect(main).toMatch(/will-quit[\s\S]*?stopHudWalk/)
  })
  it('pointer reaches the renderer via preload onPointer + moveTo/goToCursor bridge', () => {
    expect(preload).toMatch(/moveTo:\s*\(x, y\) => ipcRenderer\.invoke\('maia:hud:moveTo'/)
    expect(preload).toMatch(/goToCursor:\s*\(\) => ipcRenderer\.invoke\('maia:hud:goToCursor'/)
    expect(preload).toMatch(/onPointer:[\s\S]*?maia:hud:pointer/)
    expect(preload).not.toMatch(/onWandering/)
  })
})
describe('Clicky-mode (small mascot + bubble + point + click-through)', () => {
  it('expanded window is the compact bubble, not the 620×340 strip', () => {
    expect(main).toMatch(/const BUBBLE_WIDTH = 360/)
    expect(main).toMatch(/const BUBBLE_HEIGHT = 300/)
    const block = main.slice(main.indexOf("ipcHandle('maia:hud:setCollapsed'"), main.indexOf("ipcHandle('maia:hud:setCollapsed'") + 2400)
    expect(block).toMatch(/Math\.min\(BUBBLE_WIDTH, wa\.width\)/)
    expect(block).not.toMatch(/hudCollapse\.anchor\.width/)
  })
  it('click-through IPC uses forward:true so hit-testing can hand control back', () => {
    expect(main).toMatch(/ipcHandle\('maia:hud:setClickThrough'/)
    expect(main).toMatch(/setIgnoreMouseEvents\(ignore, \{ forward: true \}\)/)
    expect(preload).toMatch(/setClickThrough:\s*\(ignore\) => ipcRenderer\.invoke\('maia:hud:setClickThrough'/)
  })
  it('smoke never races the live renderer (about:blank under NUB_SMOKE_HUD)', () => {
    const block = main.slice(main.indexOf('function hudUrl'), main.indexOf('function createHudWindow'))
    expect(block).toMatch(/NUB_SMOKE_HUD.*about:blank/)
  })
  it('[TYPE:text] act primitive — osascript keystroke IPC + preload + renderer parse', () => {
    expect(main).toMatch(/ipcHandle\('maia:hud:typeText'/)
    // D-06: the spawn resolves through screen-act's trusted path, never a
    // bare PATH name.
    expect(main).toMatch(/screenAct\.defaultResolveActFile\('osascript'\)/)
    expect(main).not.toMatch(/spawnSync\('osascript'/)
    expect(main).toMatch(/tell application "System Events" to keystroke/)
    expect(preload).toMatch(/typeText:\s*\(text\) => ipcRenderer\.invoke\('maia:hud:typeText'/)
    const shell = readFileSync(require.resolve('../src/components/HudShell.tsx'), 'utf8')
    expect(shell).toMatch(/TYPE_ONCE_RE/)
    expect(shell).toMatch(/hud\?\.typeText\?\.\(m\[1\]\)/)
  })

  it('typeText keystroke is async — a sync spawn blocks the whole main process', () => {
    const start = main.indexOf("ipcHandle('maia:hud:typeText'")
    const block = main.slice(start, main.indexOf("ipcHandle('maia:openExternal'"))
    expect(block).toMatch(/execFile\(osascript,/)
    expect(main).not.toMatch(/spawnSync/)
  })

  it('main window is background-throttled except while a turn is live', () => {
    const create = mainFunction(main, 'createWindow')
    expect(create).toMatch(/backgroundThrottling: true/)
    const relay = main.slice(main.indexOf('function syncMainBackgroundThrottling'), main.indexOf("ipcHandle('maia:hud:getActivity'"))
    expect(relay).toMatch(/setBackgroundThrottling\(!live\)/)
    expect(relay).toMatch(/syncMainBackgroundThrottling\(clean\)/)
  })

  it('renderer implements the [POINT:x,y(:label)?] protocol via moveTo', () => {
    const shell = readFileSync(require.resolve('../src/components/HudShell.tsx'), 'utf8')
    // The grammar is DEFINED once in src/lib/hud-protocol.ts (behaviourally
    // tested below) and CONSUMED by the shell. Assert the consumption here:
    // a regex defined but never imported is a protocol that silently does
    // nothing, and that is the regression this tripwire exists to catch.
    expect(shell).toMatch(/from '\.\.\/lib\/hud-protocol'/)
    expect(shell).toMatch(/POINT_ONCE_RE/)
    // Marker coordinates go through toScreen (screenshot pixels → screen
    // points when a capture rode the turn; identity otherwise) — never raw.
    expect(shell).toMatch(/const pt = toScreen\(Number\(m\[1\]\), Number\(m\[2\]\)\)/)
    expect(shell).toMatch(/hud\?\.moveTo\?\.\(pt\.x, pt\.y\)/)
    expect(shell).toMatch(/stripMarkers/)
    expect(shell).toMatch(/hud-bubble/)
  })
})

describe('[CLICK:x,y] act primitive (last mile of talk→see→point→ACT)', () => {
  const actBlock = () => main.slice(main.indexOf('function hudMoveTo'), main.indexOf('function stepHudWalk'))

  it('main.cjs consumes the dependency-free screen-act module', () => {
    expect(main).toMatch(/require\('\.\/screen-act\.cjs'\)/)
    expect(main).toMatch(/screenAct\.clickAt\(/)
    expect(main).toMatch(/screenAct\.actStatus\(/)
  })

  it('the cat parks BESIDE the target, never on it — a cat on the pixel would swallow its own click', () => {
    const block = actBlock()
    expect(block).toMatch(/function hudParkBeside\(/)
    expect(block).toMatch(/ORB_SIZE - ACT_CLEARANCE|x - ORB_SIZE - ACT_CLEARANCE/)
    expect(block).toMatch(/covers =/)
    // clamped back onto the target -> flip to the other side instead
    expect(block).toMatch(/x \+ ACT_CLEARANCE, y \+ ACT_CLEARANCE|\{ x: x \+ ACT_CLEARANCE/)
  })

  it('the click waits for ARRIVAL, then a beat so the point-pulse is visible', () => {
    const block = actBlock()
    expect(block).toMatch(/function hudClickAt\(/)
    expect(block).toMatch(/hudMoveTo\(park\.x, park\.y, \(\) =>/)
    expect(block).toMatch(/CLICK_SETTLE_MS/)
    const walk = main.slice(main.indexOf('function stepHudWalk'), main.indexOf('function stopHudWalk'))
    expect(walk).toMatch(/arrive\.cb\(/)
  })

  it('a cancelled walk cancels the pending click — a cat that never arrived must never click', () => {
    const stop = main.slice(main.indexOf('function stopHudWalk'), main.indexOf('function persistOrbPos'))
    expect(stop).toMatch(/arrive\.cancel\(\)/)
    expect(actBlock()).toMatch(/error: 'walk-cancelled'/)
  })

  it('refuses to lie when Accessibility is not granted', () => {
    expect(actBlock()).toMatch(/error: 'accessibility-not-trusted'/)
    expect(main).toMatch(/function hudActTrusted\(\)/)
    expect(main).toMatch(/systemPreferences\.isTrustedAccessibilityClient\(false\)/)
    expect(main).toMatch(/ipcHandle\('maia:hud:actStatus'/)
    expect(main).toMatch(/ipcHandle\('maia:hud:requestActPermission'/)
    expect(main).toMatch(/systemPreferences\.isTrustedAccessibilityClient\(true\)/)
  })

  it('an UNCHECKED trust state is never reported as trusted — the silent-drop lie', () => {
    // Measured on a real Mac: an untrusted client's CGEvent is dropped while
    // osascript still exits 0, so `ok:true` alone claims a click that never
    // landed. If the trust probe throws we must say 'unknown', never `true` —
    // a bare `return true` here would reintroduce the lie this guards.
    expect(main).toMatch(/return screenAct\.UNKNOWN_TRUST/)
    // ...and screen-act must actually export that sentinel.
    expect(actBlock()).toMatch(/trusted: 'unknown'|UNKNOWN_TRUST/)
    expect(require('./screen-act.cjs').UNKNOWN_TRUST).toBe('unknown')
  })

  it('exposes clickAt over IPC + preload', () => {
    expect(main).toMatch(/ipcHandle\('maia:hud:clickAt'/)
    expect(preload).toMatch(/clickAt: \(x, y\) => ipcRenderer\.invoke\('maia:hud:clickAt'/)
    expect(preload).toMatch(/actStatus: \(\) => ipcRenderer\.invoke\('maia:hud:actStatus'\)/)
    expect(preload).toMatch(/requestActPermission: \(\) => ipcRenderer\.invoke\('maia:hud:requestActPermission'\)/)
  })

  it('renderer parses [CLICK:x,y], fires it once, and strips it from the bubble', () => {
    const shell = readFileSync(require.resolve('../src/components/HudShell.tsx'), 'utf8')
    expect(shell).toMatch(/CLICK_ONCE_RE/)
    // A point outside the capture (or on a stale one) is refused, not clamped.
    expect(shell).toMatch(/mapSightPoint\(sight, x, y\)/)
    expect(shell).toMatch(/if \(!pt\) \{\s*setActRefused\(/)
    expect(shell).toMatch(/hud\?\.clickAt\?\.\(pt\.x, pt\.y\)/)
    expect(shell).toMatch(/lastClickKey/)
    expect(shell).toMatch(/\.replace\(CLICK_RE, ''\)/)
  })

  it('renderer surfaces a fix-it hint instead of silently no-opping', () => {
    const shell = readFileSync(require.resolve('../src/components/HudShell.tsx'), 'utf8')
    expect(shell).toMatch(/hud-act-hint/)
    expect(shell).toMatch(/hud-act-fix/)
    expect(shell).toMatch(/requestActPermission/)
  })
})

/**
 * The grammar itself, exercised rather than eyeballed. These are the ONCE
 * (non-global) variants on purpose: a /g regex carries lastIndex between
 * .test() calls, so reusing one across assertions makes them order-dependent
 * and silently wrong. The /g twins are asserted by flag, not by matching.
 */
describe('the Clicky marker grammar (src/lib/hud-protocol.ts)', () => {
  it('[POINT:x,y(:label)?] captures coordinates and an optional label', () => {
    const m = POINT_ONCE_RE.exec('look here [POINT:842,510:Save button] now')
    expect(m).not.toBeNull()
    expect([m[1], m[2], m[3]]).toEqual(['842', '510', 'Save button'])
    const bare = POINT_ONCE_RE.exec('[POINT:12,34]')
    expect(bare).not.toBeNull()
    expect([bare[1], bare[2]]).toEqual(['12', '34'])
    expect(bare[3]).toBeUndefined()
  })

  it('tolerates whitespace inside a marker', () => {
    const m = POINT_ONCE_RE.exec('[POINT: 100 , 200 : Roomy ]')
    expect(m).not.toBeNull()
    expect([m[1], m[2], m[3]]).toEqual(['100', '200', 'Roomy '])
  })

  it('accepts NEGATIVE coordinates — a display left of or above the primary', () => {
    const p = POINT_ONCE_RE.exec('[POINT:-1200,-40:left monitor]')
    expect(p).not.toBeNull()
    expect([p[1], p[2]]).toEqual(['-1200', '-40'])
    const c = CLICK_ONCE_RE.exec('[CLICK:-80,900]')
    expect(c).not.toBeNull()
    expect([c[1], c[2]]).toEqual(['-80', '900'])
  })

  it('[CLICK:x,y] captures coordinates', () => {
    const m = CLICK_ONCE_RE.exec('sending it now [CLICK:640,480]')
    expect(m).not.toBeNull()
    expect([m[1], m[2]]).toEqual(['640', '480'])
  })

  it('[TYPE:text] captures text with spaces, commas and punctuation', () => {
    const m = TYPE_ONCE_RE.exec('[TYPE:hello, world! 2+2=4]')
    expect(m).not.toBeNull()
    expect(m[1]).toBe('hello, world! 2+2=4')
  })

  it('rejects half-formed markers so prose is never mistaken for an act', () => {
    expect(CLICK_ONCE_RE.test('[CLICK:12]')).toBe(false)
    expect(CLICK_ONCE_RE.test('[CLICK:abc,def]')).toBe(false)
    expect(CLICK_ONCE_RE.test('[CLICK:]')).toBe(false)
    expect(POINT_ONCE_RE.test('[POINT:12,34:unterminated')).toBe(false)
    expect(TYPE_ONCE_RE.test('[TYPE:]')).toBe(false)
    // plain prose must never trip a marker
    expect(CLICK_ONCE_RE.test('click the button')).toBe(false)
  })

  it('the /g variants strip every occurrence and the ONCE twins do not carry /g', () => {
    expect('a [CLICK:1,2] b [CLICK:3,4]'.replace(CLICK_RE, '')).toBe('a  b ')
    expect('x [POINT:1,2] y'.replace(POINT_RE, '')).toBe('x  y')
    expect('t [TYPE:hi] u'.replace(TYPE_RE, '')).toBe('t  u')
    for (const g of [POINT_RE, TYPE_RE, CLICK_RE]) expect(g.flags).toContain('g')
    for (const o of [POINT_ONCE_RE, TYPE_ONCE_RE, CLICK_ONCE_RE]) {
      expect(o.flags).not.toContain('g')
    }
  })
})

describe('hud-state contract (cross-file)', () => {
  it('exports everything main.cjs consumes', () => {
    for (const name of ['hudStatePath', 'loadHudState', 'clampHudBounds', 'clampOrbPosition', 'persistHudState', 'ORB_SIZE']) {
      expect(hudStateSrc).toContain(name)
    }
  })
})
