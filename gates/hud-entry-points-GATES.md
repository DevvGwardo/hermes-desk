# Gates: HUD orb entry points (discoverability)

Scope: make the floating orb reachable by a human. Before this pass the orb
could be summoned ONLY by an unlisted global hotkey (⌘⇧H) or by typing "HUD"
into the command palette — and closing the strip (the × in HudShell) destroyed
the window, leaving no visible way back. Two affordances were added:

- **TopBar orb button** (`src/components/HudOrbButton.tsx`) — desktop-only,
  shows real open/closed state read from main, never a local counter.
- **Window menu → "Show Nub Orb (⌘⇧H)"** — where a Mac user looks for a
  missing window. The hotkey is advertised in the LABEL, never registered as
  an accelerator.

Plus the invariant that makes both safe: **exactly one owner per toggle.**
`globalShortcut` does not swallow the app-level key event, so a menu
accelerator or a renderer `keydown` handler bound to the same combo fires IN
ADDITION to the global one. Two toggles per keypress meant the orb could open
but never close — `toggleHudWindow` closed it, then the second call saw "not
visible" and re-created it. The renderer's ⌘⇧H branch was deleted
(`src/App.tsx`); main's `globalShortcut` is the sole owner.

Out of scope (declared): a menu-bar Tray icon and auto-restoring the orb on
launch — BOTH SHIPPED 2026-08-29 (see gates/hud-mascot-widget-GATES.md
G10+G11: tray via installHudTray, auto-restore via the v2 `open` flag).

---

- [x] **G1: a visible, desktop-only affordance exists.** The orb button mounts
    in the TopBar and renders **nothing** without the desktop bridge, so the
    hosted web build can never show a dead control.
  CHECK: `npx vitest run src/components/__tests__/hud-orb-button.test.tsx 2>&1 | tail -4`
  EXPECT: `/Test Files\s+1 passed/`
  EVIDENCE: Tests 7 passed (7) — incl. 'renders NOTHING without the desktop
    bridge' and 'never flips its own state on click'.
  MUTATION-TESTED: deleting `if (!bridge) return null` → 1 failed (the button
    renders on web).

- [x] **G2: the button reports main's state, not its own guess.** Seeded from
    `hud.isOpen()` on mount (the orb may have been hotkeyed from another app
    long before the TopBar mounted) and updated only by the
    `maia:hud:changed` broadcast; unsubscribes on unmount.
  CHECK: `npx vitest run src/components/__tests__/hud-orb-button.test.tsx 2>&1 | tail -4`
  EXPECT: `/Test Files\s+1 passed/`
  EVIDENCE: Tests 7 passed (7). 'seeds its state from main' asserts
    `aria-pressed=true` after `isOpen()` resolves true; 'never flips its own
    state on click' clicks and requires the button to stay unpressed until a
    broadcast actually arrives — a self-flipping button would claim an orb
    that a rejected toggle never opened.
  MUTATION-TESTED: adding `setOpen((v) => !v)` to `onClick` → 1 failed.

- [x] **G3: one click = one toggle.** The renderer owns no ⌘⇧H handler and the
    menu owns no accelerator, so no path can double-fire.
  CHECK: `npx vitest run electron/hud-guards.test.mjs 2>&1 | tail -4`
  EXPECT: `/Test Files\s+1 passed/`
  EVIDENCE: Tests 48 passed (48). Tripwires: `appSrc` must NOT match
    `shiftKey && key === 'h'`; the `installAppMenu` block must NOT match
    `accelerator`; one click calls `bridge.toggle` exactly once.
  MUTATION-TESTED: re-adding a renderer ⌘⇧H branch → 1 failed; adding
    `accelerator: HUD_SHORTCUT` to the menu item → 1 failed; duplicating
    `bridge.toggle?.()` in `onClick` → 1 failed.

- [x] **G4: menu and button cannot disagree.** Every open/close path calls one
    helper (`setHudOpenState`) that broadcasts `maia:hud:changed` to the main
    window AND refreshes the menu label; nothing sends the IPC directly.
    Standard Edit/View/File roles are preserved — a hand-rolled menu would
    silently drop ⌘C/⌘V from the composer.
  CHECK: `npx vitest run electron/hud-guards.test.mjs 2>&1 | tail -4`
  EXPECT: `/Test Files\s+1 passed/`
  EVIDENCE: the `createHudWindow` block matches `setHudOpenState(true)` and
    `setHudOpenState(false)` and must NOT match
    `webContents.send('maia:hud:changed'`; the menu template matches
    `role: 'editMenu' | 'viewMenu' | 'fileMenu'`.
  MUTATION-TESTED: replacing the helper call with a direct
    `webContents.send` → 1 failed.

- [x] **G5: the menu really installs in a live Electron and its label tracks
    state.** Source tripwires cannot prove `Menu.buildFromTemplate` accepts
    the template — a bad role throws, and a bare `catch` would hide it — so
    `installAppMenu` logs what it installed.
  CHECK: `env -u ELECTRON_RUN_AS_NODE NUB_SMOKE_HUD=1 npx electron . --no-sandbox --user-data-dir=/tmp/nub-hud-smoke3 2>&1 | grep -E '\[hud\] app menu installed|\[hud\] smoke'`
  EXPECT: a `Show Nub Orb (⌘⇧H)` line at startup, a `Hide Nub Orb` line once
    the HUD opens, and `[hud] smoke ok`.
  EVIDENCE:
    ```
    [hud] app menu installed — Window → Show Nub Orb (⌘⇧H), 6 top-level menus
    [hud] app menu installed — Window → Hide Nub Orb, 6 top-level menus
    [hud] app menu installed — Window → Show Nub Orb (⌘⇧H), 6 top-level menus
    [hud] smoke ok {"expanded":{"x":298,"y":299,"width":700,"height":400},"orb":{"x":299,"y":300}}
    ```
    Six top-level menus = app + File + Edit + View + Window + Help, i.e. the
    standard roles built without throwing. The middle line proves the label
    flips when the HUD opens and flips back when it closes.

- [x] **G6: full suite stays green.**
  CHECK: `npx vitest run 2>&1 | tail -4`
  EXPECT: `/Test Files\s+\d+ passed/` and `/Tests\s+\d+ passed/` with no failed line
  EVIDENCE: Test Files 145 passed · Tests 1193 passed (1193). Re-measure, do
    not copy this number: it drops by one file for every scratch test left in
    the tree (the first run of this pass reported 147/1194 only because two
    throwaway debug files were still lying around).

- [x] **G7: typecheck clean on both leaf projects.**
  CHECK: `npx tsc --noEmit -p tsconfig.app.json && npx tsc --noEmit -p tsconfig.node.json`
  EXPECT: exit 0
  EVIDENCE: APP_TSC_OK / NODE_TSC_OK. (Bare `npx tsc --noEmit` reads the
    solution `tsconfig.json`, which has `"files": []` and checks nothing.)

- [x] **G8: the menu's RUNTIME shape is verified — `Menu.getApplicationMenu()` is
    read back, not assumed.** The template now lives in a pure, injectable
    module (`electron/app-menu.cjs`) and `scripts/hud-menu-probe.cjs` (launched
    BY electron) installs it, reads the live menu back, and verifies: a
    Window → `Show Nub Orb (⌘⇧H)` item exists, its click reaches the toggle
    exactly once, and re-installing OPEN flips the live label to `Hide Nub
    Orb`. It also extracts `electron/app-menu.cjs` from the INSTALLED app's
    asar (default `/Applications/Nub Agent.app`, override `NUB_APP_BUNDLE`) and
    checks the same structural markers — a stale package can no longer hide
    behind a green repo probe. A pre-extraction asar reports
    `packaged=false` with a clear reason instead of throwing.
  CHECK: `env -u ELECTRON_RUN_AS_NODE npx electron scripts/hud-menu-probe.cjs --no-sandbox`
  EXPECT: `HUD_MENU summary ok repo=true packaged=true`, exit 0
  EVIDENCE: repo=true packaged=true — live label "Show Nub Orb (⌘⇧H)" → click →
    "Hide Nub Orb", 6 top-level menus. Run 2026-08-29 after installing the
    rebuilt asar; before that it honestly reported `packaged=false` (stale
    pre-extraction build).
  MUTATION-TESTED: dropping `role: 'editMenu'` → guards fail; renaming
    `id: 'hud-orb'` → guards fail (see the new file's ledger).

---

## Mutation ledger

`/tmp/hud-entry-mutations.py` applies each defect, runs only the affected test
file, restores the original, and reports a boolean per mutation (a mutation
that fails to apply is reported as such — a no-op mutation proves nothing).

| Mutation | Caught |
|---|---|
| A: drop the no-bridge guard | yes |
| B: second owner of the toggle (double `toggle()`) | yes |
| C: renderer re-owns ⌘⇧H | yes |
| D: menu accelerator on the global combo | yes |
| E: bypass the single broadcast helper | yes |
| F: button presses itself on click | yes |

Baseline (clean tree) 55 passed · restored (clean tree) 55 passed · failures=0.

## Known gap — CLOSED 2026-08-29

The "no live probe reads the menu back" gap is closed by G8: the template
moved to `electron/app-menu.cjs` (pure + injectable) and
`scripts/hud-menu-probe.cjs` installs it, reads `Menu.getApplicationMenu()`
back, and checks the installed asar. The single-instance-lock caveat still
applies to booting the FULL app, which is why the probe drives the module
directly instead.
