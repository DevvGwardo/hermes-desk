# Gates: HUD free-float + self-roaming (accurate desktop-pet port)

Scope: make the cat widget genuinely free-floating (no glass rectangle — the
character is the only visible thing, per the clippy/shimeji/snowcat genre) and
make it ROAM on its own: while collapsed+idle the window eases toward random
workArea points every 8-20s (roam gaps per reference implementations), pausing
on focus/expand/user-drag, with throttled position persistence. Renderer gets
a walking state (bob) via maia:hud:wandering IPC.
Out of scope (declared): cursor-follow, floor-walking sprite states, tray menu.

- [x] G1: free-float — HUD window is created WITHOUT native vibrancy and with
    hasShadow:false; CSS glass removed on the collapsed root (.hud-collapsed is
    fully transparent); expanded strip keeps its CSS backdrop glass.
  CHECK: npx vitest run electron/hud-guards.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Tests 17 passed (17) — incl. hasShadow:false, no vibrancy:, .hud-collapsed transparent

- [x] G2: roam engine — wander loop starts when collapsed, eases (cubic-out,
    40ms steps) toward clamped random targets, pauses on focus/expand, does not
    fight user drags (own-move suppression), persists orb position throttled.
  CHECK: npx vitest run electron/hud-guards.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: same suite — pickRoamTarget + ROAM_EASE + hudBoundsClamped + hudSuppressOwnMoveUntil + will-quit stopRoam

- [x] G3: walking state reaches the renderer — maia:hud:wandering IPC → preload
    onWandering → orb carries data-walking + bob CSS (reduced-motion safe).
  CHECK: npx vitest run src/components/__tests__/hud-shell.test.tsx 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Tests 8 passed (8) — 'reflects the roaming walking state on the orb'

- [x] G4: full suite green.
  CHECK: npx vitest run 2>&1 | tail -4
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Test Files 142 passed · Tests 1098 passed (1098)

- [x] G5: typecheck clean.
  CHECK: npx tsc --noEmit && echo TSC_OK
  EXPECT: TSC_OK
  EVIDENCE: TSC_OK

- [x] G6: E2E smoke unaffected.
  CHECK: NUB_SMOKE_HUD=1 npx electron . --user-data-dir=/tmp/nub-hud-smoke 2>&1 | grep -E '\[hud\] smoke'
  EXPECT: /\[hud\] smoke ok/
  EVIDENCE: [hud] smoke ok {"expanded":{...700×400},"orb":null}

- [x] G7: LIVE movement proof — fresh dev app, HUD open, after collapse+wander
    two screenshots seconds apart show the cat's navy-chip centroid has MOVED.
  CHECK: python3 /tmp/hud-roam-proof.py
  EXPECT: /ROAM_CONFIRMED/
  EVIDENCE: orb moved 531px unattended (state 1020,499→697,77) + visual navy-cell relocation ~1105pt

- [x] G8: docs/HUD.md + STATE.md describe free-float + roaming.
  CHECK: grep -q 'roam' docs/HUD.md && grep -q 'free-float\|free float' docs/HUD.md && grep -q 'roam' STATE.md && echo G8_OK
  EXPECT: G8_OK
  EVIDENCE: G8_OK
