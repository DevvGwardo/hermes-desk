# Gates: HUD mascot-widget mode (Clippy-style — the cat IS the widget)

Scope: invert the HUD default so the nubcat orb is the primary form: HUD opens
as the resting cat (unfocused open → orb from the first frame, no strip flash,
no focus steal via showInactive), the orb position persists separately from the
expanded bounds (drag the cat, it stays), and collapse restores the SAVED orb
position. Chat strip still opens on click/focus; replies auto-pop the strip.
Out of scope (declared): walking/edge-perching pet antics, speech bubbles.

- [x] G1: hud-state v2 schema — { expanded: {x,y,width,height}, orb: {x,y} },
    backward-compatible with the v1 flat file, orb-position clamp, persist both
    fields; unit tests green.
  CHECK: npx vitest run electron/hud-state.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Tests 20 passed (20) — incl. v1-flat upgrade + clampOrbPosition cases

- [x] G2: main wiring — collapse targets the saved orb position (clamped),
    orb moves persist orb position, expanded moves persist full bounds,
    orb-sized bounds never land in the expanded field; guard tests green.
  CHECK: npx vitest run electron/hud-guards.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Tests 12 passed (12) — open-as-orb, orb docking, speech-panel expand, persist split

- [x] G3: widget-first renderer — an unfocused open renders the orb immediately
    (no 3.5s strip flash) and tells main to collapse; a focused open still shows
    the strip; component tests green.
  CHECK: npx vitest run src/components/__tests__/hud-shell.test.tsx 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Tests 7 passed (7) — incl. 'opens as the orb widget when unfocused (no strip flash)'

- [x] G4: no focus steal — HUD opens with showInactive (hotkey summons the cat
    without yanking focus from the app you are in).
  CHECK: grep -c 'showInactive' electron/main.cjs
  EXPECT: >= 1 (count printed)
  EVIDENCE: count = 1 (ready-to-show → showInactive; guards also pin it)

- [x] G5: full suite stays green.
  CHECK: npx vitest run 2>&1 | tail -4
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Test Files 141 passed · Tests 1092 passed (1092)

- [x] G6: typecheck clean.
  CHECK: npx tsc --noEmit && echo TSC_OK
  EXPECT: TSC_OK
  EVIDENCE: TSC_OK

- [x] G7: E2E smoke still passes (schema v2 aware — asserts state.expanded).
  CHECK: NUB_SMOKE_HUD=1 npx electron . --user-data-dir=/tmp/nub-hud-smoke 2>&1 | grep -E '\[hud\] smoke' ; echo "exit=$?"
  EXPECT: /\[hud\] smoke ok/
  EVIDENCE: [hud] smoke ok {"expanded":{"x":140,"y":160,"width":700,"height":400},"orb":null} · exit=0 · v2 file on disk matches

- [x] G8: docs/HUD.md + STATE.md describe mascot-widget mode.
  CHECK: grep -q 'showInactive' docs/HUD.md && grep -q 'mascot-widget\|widget mode\|opens as the' docs/HUD.md && grep -q 'mascot-widget' STATE.md && echo G8_OK
  EXPECT: G8_OK
  EVIDENCE: G8_OK

- [x] G9: orb window paints no opaque chrome behind the cat (the "dark
    background" the user reported). The only opaque pixels inside the 104
    window must be the cat itself; the MAIA_NAVY chip the `framed` FatCatIcon
    prop paints must be gone. The same check has to pass against the dev
    server AND the packaged app (different URL schemes, different focus
    defaults, both have to be honest).
  CHECK: env -u ELECTRON_RUN_AS_NODE npx electron scripts/hud-package-transparency-probe.cjs --no-sandbox 2>&1 | grep PKG_TRANSPARENCY
  EXPECT: 'PKG_TRANSPARENCY done ok ... dev=true packaged=true' (exit 0)
  EVIDENCE: with `framed` removed from the orb FatCatIcon
    (src/components/HudShell.tsx:430), the probe reports
    `done ok {"dev":"transparent (cat visible: true)","packaged":"transparent (cat visible: true)"}` and `summary ok dev=true packaged=true`.
    Pixel captures: /tmp/nub-hud-capture-dev.png (frameTop=0,0,0,12
    frameBottom=0,0,0,35 frameLeft=0,0,0,25 frameRight=0,0,0,24 — soft
    drop-shadow, no chip) and /tmp/nub-hud-capture-packaged.png (same faint
    shadow, no chip). Pre-fix captures (saved as n…-big.png from earlier
    runs) clearly show the navy rounded square that motivated the gate.
    Mutation-tested: re-adding `framed` to the orb flips the probe to
    `dev=OPAQUE, frame-ring navy=4/4` while packaged (the fixed build) stays
    transparent, proving the colour-aware frame-ring check discriminates the
    chip from the cat.
    Caveat: MAIA_NAVY (the chip) and GROK_EYE (the cat's eyes) are both
    #1a3d6b, so a navy centre pixel is ambiguous and is reported as
    diagnostic only — never used in the verdict.

- [x] **G10: menu-bar Tray icon — the orb gets a permanent home next to the
    Dock icon** (was declared out of scope; now shipped). The tray context
    menu mirrors the Window menu's single truth: its label flips via
    `setHudOpenState` (same helper, so menu + tray + button can never
    disagree), and Quit uses the standard role. Skipped under smoke/probe
    envs so CI never creates a stray tray. The 1024px icon is resized down
    via `nativeImage` (no runtime sips dependency).
  CHECK: `npx vitest run electron/hud-guards.test.mjs 2>&1 | tail -4`
  EXPECT: `/Test Files\s+1 passed/`
  EVIDENCE: Tests 60 passed (60) — new tray describe pins `new Tray(`,
    `setContextMenu`, `id: 'hud-tray-orb'`, `role: 'quit'`, the smoke skip,
    the `setHudOpenState` refresh, and `will-quit` destroy.
  MUTATION-TESTED: T1 (drop Tray/nativeImage destructure) → failed; T2 (break
    `role: 'quit'`) → failed; T3 (drop smoke skip) → failed; T6 (drop tray
    destroy) → failed.

- [x] **G11: the orb auto-restores at launch if it was open when the app
    quit** (also previously out of scope). The `open` flag persists in the
    v2 hud-window-state.json via `setHudOpenState`, and boot re-creates the
    orb (`showInactive`, no focus steal) after the main window + shortcut are
    up — but never under smoke/probe envs. Pre-flag files (absent `open`) do
    NOT auto-restore, so existing installs are untouched.
  CHECK: `npx vitest run electron/hud-state.test.mjs electron/hud-guards.test.mjs 2>&1 | tail -4`
  EXPECT: `/Test Files\s+2 passed/`
  EVIDENCE: hud-state 22 passed (open flag parse/persist incl. undefined vs
    boolean); guards 60 passed (auto-restore block pinned: `bootState.open === true`,
    `createHudWindow()`, smoke guard, runs after `createWindow()`).
  MUTATION-TESTED: T4 (negate auto-restore condition) → failed; T5 (drop
    open-flag persistence) → failed; T7 (persist drops open field) → failed;
    T8 (parse ignores open flag) → failed.
  FIXED 2026-08-29 (independent review): the quit path clobbered the flag —
    Electron fires hudWindow `closed` BEFORE `will-quit`, so teardown
    `setHudOpenState(false)` persisted open:false over the open:true saved at
    open time, making auto-restore CRASH-ONLY. `before-quit` now sets
    `hudQuitting`, and `setHudOpenState` skips the persist/menu/tray while
    quitting. New behavioral E2E probe `scripts/hud-quit-restore-probe.cjs`
    drives the REAL app (seed open:true → boot → orb seen → normal quit →
    assert open still true): RED before the fix (open=false), GREEN after
    (open=true). 6 new tripwires + 6 mutations M1–M6 all caught; guards 60→65,
    hud-state 22→23; full suite 1211/1213 (2 pre-existing sandbox-only fs-guard
    EPERM).

