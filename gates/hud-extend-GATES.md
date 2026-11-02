# Gates: HUD desktop-widget extension (bounds persistence + orb idle + hotkey pins)

Scope: extend the existing `?win=hud` floating strip (electron/main.cjs + HudShell.tsx,
commit 36db9b8) with (S1) saved window bounds restored+clamped on reopen,
(S2) a collapsed nubcat-orb resting state in the renderer, (S3) guard tests pinning
the ALREADY-EXISTING global hotkey (Cmd/Ctrl+Shift+H — no new hotkey work), plus
docs + STATE. Out of scope (declared): tray/menubar presence.

CHECK corrections during the run (disclosed): G8 CHECK rewritten to a decisive
single-token echo (same three greps, unambiguous output); G7 CHECK gained the
isolated --user-data-dir=/tmp/nub-hud-smoke (the form actually executed — prevents
collision with the real app's single-instance lock and keeps real userData clean).

- [x] G1: hud-state module persists bounds — load tolerant of missing/corrupt
    file, clamp restores off-screen/half-screen saves into a real display's
    work area, sizes clamped to HUD minimums, defaults preserved when no save.
  CHECK: npx vitest run electron/hud-state.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Test Files 1 passed (1) · Tests 16 passed (16)

- [x] G2: main.cjs wiring — createHudWindow restores clamped persisted bounds,
    saves on move+resize (debounced) and on close, state file under userData.
  CHECK: npx vitest run electron/hud-guards.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Test Files 1 passed (1) · Tests 15 passed (15) — incl. persistence-wiring + orb-collapse blocks

- [x] G3: global hotkey pinned — guard test asserts main.cjs registers
    Cmd+Shift+H (darwin) / Ctrl+Shift+H (other) via globalShortcut calling
    toggleHudWindow, unregisters on will-quit, and logs when registration fails.
  CHECK: npx vitest run electron/hud-guards.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: hotkey describe 4/4 green — incl. the destructure tripwire (pre-fix code referenced globalShortcut without requiring it: ReferenceError every boot)

- [x] G4: HudShell orb idle state — collapses to the nubcat orb (agent mascot
    color) when unfocused+idle, never collapses while focused or during
    activity, orb click/focus expands back to the strip; component tests green.
  CHECK: npx vitest run src/components/__tests__/hud-shell.test.tsx 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Test Files 1 passed (1) · Tests 5 passed (5)

- [x] G5: full suite stays green (no regressions from the new code).
  CHECK: npx vitest run 2>&1 | tail -4
  EXPECT: /failed\s+0/ or /Tests\s+\d+ passed/
  EVIDENCE: Test Files 141 passed (141) · Tests 1084 passed (1084)

- [x] G6: typecheck clean.
  CHECK: npx tsc --noEmit && echo TSC_OK
  EXPECT: TSC_OK
  EVIDENCE: TSC_OK

- [x] G7: end-to-end smoke — real Electron boot with NUB_SMOKE_HUD=1 opens the
    HUD, moves it, closes it, verifies hud-window-state.json was written with
    the moved bounds, logs success, exits 0.
  CHECK: NUB_SMOKE_HUD=1 npx electron . --user-data-dir=/tmp/nub-hud-smoke 2>&1 | grep -E '\[hud\] smoke' ; echo "exit=$?"
  EXPECT: /\[hud\] smoke ok/
  EVIDENCE: [hud] smoke ok {"x":140,"y":160,"width":700,"height":400} · exit=0 · file on disk matches byte-for-byte (ls 16:01)

- [x] G8: docs + state — docs/HUD.md documents hotkey/persistence/orb; STATE.md
    gains a dated verified-facts entry for this slice.
  CHECK: grep -q 'Shift+H' docs/HUD.md && grep -q 'hud-window-state' docs/HUD.md && grep -q '2026-08-28.*HUD' STATE.md && echo G8_OK
  EXPECT: G8_OK
  EVIDENCE: G8_OK (all three greps hit; counts 1/1/1)
