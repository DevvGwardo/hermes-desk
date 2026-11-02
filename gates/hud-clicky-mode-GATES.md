# Gates: HUD → Clicky-mode (small desktop-agent mascot, talk→see→point)

Reference model (reverse-engineered): Clicky (clicky.ai) / OpenClicky (jasonkneen)
/ Clacky (Raynan00). Core loop = talk → see → point → act; the small mascot IS
the interface; answers are compact speech bubbles anchored to the buddy;
[POINT:x,y:label] markers make the buddy fly to the real UI element (pixel-
accurate cursor overlay); no large chat panels.

Scope:
- S1 bubble mode: the expanded HUD is a compact speech bubble (last exchange +
  input) anchored above the nubcat, with a tail pointing at the cat — NOT a
  620×340 transcript strip. Cat sits in the expanded view (bottom, docks on click).
- S2 window: expanded bounds 360×300 anchored on the cat; mins lowered
  (280×180) so the bubble can exist; persisted state still upgrades/clamps.
- S3 [POINT:x,y(:label)?]: agent replies carrying the marker make the cat
  walk to that screen point (hud.moveTo + point-pulse) and the marker token is
  stripped from the displayed text.
- S4 click-through: transparent parts of the HUD never steal clicks —
  setIgnoreMouseEvents(forward) toggled by renderer hit-testing.
Out of scope (declared): voice/STT, [TYPE:] computer-use acting, multi-step
screen tours (the moveTo+pointer primitives are the ready seam for them).

- [x] G1: bubble mode replaces the transcript strip (component).
  CHECK: npx vitest run src/components/__tests__/hud-shell.test.tsx 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Tests 12 passed (12) — 'expanded mode renders the speech bubble…' asserts current-exchange-only (old Q/A dropped)

- [x] G2: window sizing — expanded = 360×300 anchored on the cat; mins 280×180.
  CHECK: npx vitest run electron/hud-guards.test.mjs electron/hud-state.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+2 passed/
  EVIDENCE: Tests 38 passed (38) — BUBBLE_WIDTH/HEIGHT=360/300 in setCollapsed; hud-state mins 280/180 (tests use exported constants)

- [x] G3: [POINT:x,y(:label)?] drives commanded movement + text cleanup.
  CHECK: npx vitest run src/components/__tests__/hud-shell.test.tsx electron/hud-guards.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+2 passed/
  EVIDENCE: component '[POINT:x,y] … flies the cat there + is stripped' (moveTo(300,400), once per marker); guards assert the protocol regex + moveTo wiring

- [x] G4: click-through IPC + renderer hit-testing wiring.
  CHECK: npx vitest run src/components/__tests__/hud-shell.test.tsx electron/hud-guards.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+2 passed/
  EVIDENCE: 'click-through: solid bubble = interactive, transparent root = click-through'; guards assert setIgnoreMouseEvents(ignore,{forward:true}) + preload bridge

- [x] G5: full suite green.
  CHECK: npx vitest run 2>&1 | tail -4
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Test Files 142 passed · Tests 1106 passed (1106)

- [x] G6: typecheck clean + E2E smoke still green.
  CHECK: npx tsc --noEmit && echo TSC_OK && NUB_SMOKE_HUD=1 npx electron . --user-data-dir=/tmp/nub-hud-smoke 2>&1 | grep -E '\[hud\] smoke'
  EXPECT: TSC_OK + /\[hud\] smoke ok/
  EVIDENCE: TSC_OK + [hud] smoke ok {"expanded":{…700×400},"orb":{"x":299,"y":300}} — after pinning smoke to about:blank (live vite made the real renderer collapse the window mid-smoke; race surfaced as 280×180 bounds)

- [x] G7: live relaunch — dev app boots clean, HUD opens, state file updated.
  CHECK: bash: relaunch + hotkey + cat state file orb coords present
  EXPECT: boot log clean + orb coords in state
  EVIDENCE: bash-14 boot clean (no errors); state file shows the 360×300 bubble opened live: {"expanded":{"x":275,"y":178,"width":360,"height":300},"orb":{"x":403,"y":486}}

- [x] G8: docs/HUD.md + STATE.md describe Clicky-mode.
  CHECK: grep -q 'POINT' docs/HUD.md && grep -q 'bubble' docs/HUD.md && grep -q 'clicky\|Clicky' STATE.md && echo G8_OK
  EXPECT: G8_OK
  EVIDENCE: G8_OK (docs/HUD.md § Clicky-mode; STATE.md 2026-08-28 HUD → Clicky-mode)
