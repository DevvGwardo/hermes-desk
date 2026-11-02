'use strict'

/** @param {() => unknown} stopAll */
function stopAllItem(stopAll) {
  return { id: 'stop-all', label: 'Stop all agents', accelerator: 'CmdOrCtrl+.', click: () => stopAll() }
}

/**
 * electron/app-menu.cjs — the application menu, as a pure, injectable module.
 *
 * Extracted from main.cjs so the menu STRUCTURE is directly probe-able:
 * scripts/hud-menu-probe.cjs builds this same template through Electron's own
 * Menu.buildFromTemplate, installs it, and reads Menu.getApplicationMenu()
 * back — the one thing nothing could verify before (see the "Known gap" in
 * gates/hud-entry-points-GATES.md). Source tripwires pin the code; this module
 * + the probe pin the live object.
 *
 * Why it exists at all: the orb used to be reachable only through an unlisted
 * global hotkey, so most users never met the cat, and closing the strip (× in
 * HudShell) destroyed the window with no visible way back. The Window menu is
 * where a Mac user looks for "where did that window go", and putting the
 * hotkey in the label makes ⌘⇧H discoverable without registering a conflicting
 * accelerator (see HUD_SHORTCUT in main.cjs). Standard roles are kept verbatim
 * (Edit/View/File) — replacing the default menu with a hand-rolled one would
 * silently drop ⌘C/⌘V from the composer.
 *
 * Everything is injected so a probe can drive it without booting the app:
 *   Menu             — the electron Menu module
 *   hudMenuOpen      — bool; flips the orb item between Show/Hide
 *   toggleHudWindow  — fn; the item's click handler
 *   HUD_SHORTCUT_LABEL — e.g. '⌘⇧H', shown in the label, never an accelerator
 *   log / warn       — optional; defaults to console, injectable for tests
 *
 * Returns the built Menu (or null if buildFromTemplate threw — a bad role
 * would otherwise pass silently, and the boot log depends on this return).
 * @param {{ Menu: Pick<typeof import('electron').Menu, 'buildFromTemplate' | 'setApplicationMenu'>,
 *   hudMenuOpen: boolean, toggleHudWindow: () => unknown, HUD_SHORTCUT_LABEL: string,
 *   stopAll?: () => unknown, log?: typeof console.log, warn?: typeof console.warn }} options
 */
function installAppMenu({
  Menu,
  hudMenuOpen,
  toggleHudWindow,
  HUD_SHORTCUT_LABEL,
  stopAll = () => {},
  log = console.log,
  warn = console.warn,
}) {
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [
    ...(process.platform === 'darwin' ? [{ role: /** @type {const} */ ('appMenu') }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        stopAllItem(stopAll),
        { type: 'separator' },
        {
          id: 'hud-orb',
          label: hudMenuOpen ? 'Hide Hermes Orb' : `Show Hermes Orb (${HUD_SHORTCUT_LABEL})`,
          click: () => toggleHudWindow(),
        },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    { role: 'help' },
  ]
  try {
    const menu = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(menu)
    // Measured, not asserted: the gate that covers this reads this line. A
    // bad role makes buildFromTemplate throw, and swallowing it silently
    // would leave the user with no HUD entry point and no clue why.
    log(
      `[hud] app menu installed — Window → ${hudMenuOpen ? 'Hide Hermes Orb' : `Show Hermes Orb (${HUD_SHORTCUT_LABEL})`}, ${menu.items.length} top-level menus`,
    )
    return menu
  } catch (err) {
    warn('[hud] app menu install failed:', err instanceof Error ? err.message : 'unknown error')
    return null
  }
}

/**
 * @param {{ visible: boolean, computerOpen: boolean, computerAvailable: boolean, serveState: string,
 *   toggleWindow: () => void, toggleComputer: () => void, pauseBrowsing: () => void }} options
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
function trayTemplate({ visible, computerOpen, computerAvailable, serveState, toggleWindow,
  toggleComputer, pauseBrowsing }) {
  return [
    { id: 'desk-window', label: visible ? 'Hide Hermes Desk' : 'Show Hermes Desk', click: toggleWindow },
    { id: 'computer-pip', label: computerOpen ? 'Hide Computer preview' : 'Show Computer preview',
      enabled: Boolean(computerAvailable), click: toggleComputer },
    { id: 'pause-browsing', label: "Pause all agents' browsing", click: pauseBrowsing },
    { id: 'serve-status', label: `Hermes serve: ${['up', 'down', 'starting', 'unknown'].includes(serveState) ? serveState : 'unknown'}`,
      enabled: false },
    { type: 'separator' },
  ]
}

module.exports = { installAppMenu }
module.exports.trayTemplate = trayTemplate
