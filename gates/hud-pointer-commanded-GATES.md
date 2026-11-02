# Gates: HUD commanded movement + pointer (Clippy-accurate: moveTo/gestureAt)

Scope: (S1) transparent background for the EXPANDED strip too — no dark glass,
only the composer pill and message bubbles are visible; (S2) a pointer on the
mascot — directional arrow during a commanded walk, point-pulse on arrival —
so you can see where the cat intends to act; (S3) movement ONLY when provoked
or asked: autonomous roaming REMOVED, replaced by maia:hud:moveTo {x,y}
(clamped, eased) + maia:hud:goToCursor (Alt+click provocation).
Out of scope (declared): agent-driven computer-use triggers (IPC is ready for it).

- [x] G1: strip transparency — .hud-root paints no background; glass lives only
    on the composer pill / bubbles; collapsed stays fully transparent.
  CHECK: npx vitest run electron/hud-guards.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: guards 18/18 — .hud-root { background: transparent }, no rgba(18,24,33) anywhere, hasShadow:false, no vibrancy:

- [x] G2: autonomy removed — no auto-start of movement anywhere (no roam timer
    hookup on open/collapse); movement runs ONLY via moveTo/goToCursor IPC;
    drag still interrupts; position persists on arrival.
  CHECK: npx vitest run electron/hud-guards.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: guards assert NOT /scheduleRoam|startRoamTimer|pickRoamTarget|ROAM_GAP/; ready-to-show + setCollapsed blocks start nothing; expanding calls stopHudWalk()

- [x] G3: pointer — main emits maia:hud:pointer {phase: walk|point|none, angle}
    during commanded walks; renderer shows a rotated arrow badge (data-testid
    hud-pointer) and Alt+click on the orb calls goToCursor instead of expanding.
  CHECK: npx vitest run src/components/__tests__/hud-shell.test.tsx 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: component 9/9 — 'pointer state: walk → bob + aimed arrow…' + 'Alt-click on the orb calls goToCursor…'

- [x] G4: full suite green.
  CHECK: npx vitest run 2>&1 | tail -4
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Tests 1100 passed (1100), 142 files

- [x] G5: typecheck clean.
  CHECK: npx tsc --noEmit && echo TSC_OK
  EXPECT: TSC_OK
  EVIDENCE: TSC_OK

- [x] G6: E2E smoke proves COMMANDED movement — smoke opens the HUD, commands a
    moveTo, asserts the window ends at the clamped target, then persists.
  CHECK: NUB_SMOKE_HUD=1 npx electron . --user-data-dir=/tmp/nub-hud-smoke 2>&1 | grep -E '\[hud\] smoke'
  EXPECT: /\[hud\] smoke ok/
  EVIDENCE: [hud] smoke ok {"expanded":{…700×400},"orb":{"x":299,"y":300}} — walked from (140,160) to commanded (300,300), arrived (299,300) within 2px threshold, orb persisted. Two real bugs found & fixed en route: drag-flag override in hudMoveTo, 1px step floor for rounding stall.

- [x] G7: docs/HUD.md + STATE.md updated (commanded movement, pointer, no autonomy).
  CHECK: grep -q 'moveTo' docs/HUD.md && grep -q 'Alt+click\|Alt-click\|alt-click' docs/HUD.md && grep -q 'commanded' STATE.md && echo G7_OK
  EXPECT: G7_OK
  EVIDENCE: G7_OK
