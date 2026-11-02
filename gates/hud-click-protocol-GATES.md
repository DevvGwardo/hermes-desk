# Gates: HUD [CLICK:] act primitive + marker protocol surfaced to the model

Scope: closes the two declared handoffs left open by
gates/hud-voice-act-GATES.md.

- S1 [CLICK:x,y] — the last mile of talk→see→point→ACT. A click primitive that
  needs no install: `electron/screen-act.cjs` resolves a backend at runtime
  (cliclick if present → osascript JXA/CoreGraphics CGEventPost, which ships
  with macOS → AppleScript System Events `click at`), exposed as
  `maia:hud:clickAt`. The cat WALKS to a spot beside the target first (it must
  never sit on the pixel it is about to click), points, then clicks.
- S2 act-permission honesty. Every macOS click/keystroke primitive is gated on
  Accessibility trust, and a silently-dropped CGEventPost looks exactly like a
  successful one. `maia:hud:actStatus` reports trust, `clickAt` refuses to lie
  (returns `accessibility-not-trusted`), and the bubble shows a fix-it hint.
- S3 the [POINT:]/[TYPE:]/[CLICK:] grammar reaches the MODEL. `hud_surface_note`
  lives server-side, so until it ships the client primes the HUD turn itself:
  `src/lib/hud-protocol.ts` holds the canonical note, hermes-transport prepends
  it on `surface:"hud"` turns only (same channel the peer roster already uses —
  the model sees it, the rendered bubble does not), and
  docs/hud-surface-note.md is the copy-paste proposal for the server.

Out of scope (declared handoffs, not regressions): screen capture (the model
still cannot see the screen, so the note tells it never to guess coordinates),
cursor-follow, walking sprite frames, multi-step tours.

- [x] G1: screen-act resolves a backend and clicks — pure, unit-tested.
  CHECK: NO_COLOR=1 npx vitest run electron/screen-act.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Start at  18:25:09 | Duration  825ms (transform 18ms, setup 0ms, import 28ms, tests 5ms, environment 683ms)

- [x] G2: [CLICK:x,y] in an agent reply clicks + is stripped + fires once.
  CHECK: NO_COLOR=1 npx vitest run src/components/__tests__/hud-shell.test.tsx 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Start at  18:25:11 | Duration  1.49s (transform 186ms, setup 0ms, import 420ms, tests 234ms, environment 726ms)

- [x] G3: main-process clickAt IPC + preload bridge + park-beside-the-target.
  CHECK: NO_COLOR=1 npx vitest run electron/hud-guards.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Start at  18:25:13 | Duration  937ms (transform 32ms, setup 0ms, import 42ms, tests 9ms, environment 768ms)

- [x] G4: act permission is reported, never faked (trust probe + fix-it path).
  CHECK: grep -q "maia:hud:actStatus" electron/main.cjs && grep -q "isTrustedAccessibilityClient" electron/main.cjs && grep -q "actStatus" electron/preload.cjs && grep -q "hud-act-hint" src/components/HudShell.tsx && grep -q "accessibility-not-trusted" electron/screen-act.cjs && echo G4_OK
  EXPECT: G4_OK
  EVIDENCE: G4_OK

- [x] G5: the marker grammar reaches the model on HUD turns only (note text,
      injection, kill switch, and docs/constant drift check).
  CHECK: NO_COLOR=1 npx vitest run src/lib/__tests__/hud-protocol.test.ts 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Start at  18:25:15 | Duration  1.05s (transform 34ms, setup 0ms, import 44ms, tests 7ms, environment 844ms)

- [x] G6: docs/HUD.md documents [CLICK:], the protocol, and HOW TO GRANT the
      permission (a hint that says "grant Accessibility" without the path is
      not actionable, and [CLICK:] is dead until it is granted).
  CHECK: grep -q "CLICK" docs/HUD.md && grep -q "POINT" docs/HUD.md && grep -q "Accessibility" docs/HUD.md && grep -q "hud-surface-note" docs/HUD.md && grep -q "Privacy & Security" docs/HUD.md && echo G6_OK
  EXPECT: G6_OK
  EVIDENCE: G6_OK

- [x] G7: full suite green.
  The old check (`| tail -4` + EXPECT `/Tests\s+\d+ passed/`) was VACUOUS: it
  matches `Tests 1170 passed | 3 failed`, and its evidence was a timing line.
  Now it requires exit 0 AND the absence of any failed/error line, and prints
  the real counts so the evidence says how many tests actually ran.
  CHECK: NO_COLOR=1 npx vitest run > /tmp/nub-vitest.log 2>&1; ec=$?; if [ "$ec" -eq 0 ] && ! grep -qE "[0-9]+ failed|[0-9]+ error" /tmp/nub-vitest.log; then grep -E "Test Files|Tests " /tmp/nub-vitest.log | tr -s ' '; echo SUITE_GREEN; else echo SUITE_RED; grep -E "[0-9]+ failed|[0-9]+ error" /tmp/nub-vitest.log | head -5; fi
  EXPECT: /SUITE_GREEN/
  EVIDENCE: Tests 1177 passed (1177) | SUITE_GREEN

- [x] G8: typecheck clean.
  CHECK: npx tsc --noEmit -p tsconfig.app.json && npx tsc --noEmit -p tsconfig.node.json && echo TSC_OK
  EXPECT: TSC_OK
  (Bare `tsc --noEmit` uses tsconfig.json, which is a solution file with
   "files": [] — it type-checks NOTHING and always exits 0. Both leaf projects
   must be checked explicitly; this gate was passing vacuously and hid a real
   TS2304 on `hudPrimedText`.)
  EVIDENCE: TSC_OK

- [x] G9: E2E smoke unaffected (about:blank, no renderer race).
  CHECK: env -u ELECTRON_RUN_AS_NODE NUB_SMOKE_HUD=1 npx electron . --no-sandbox --user-data-dir=/tmp/nub-hud-smoke 2>&1 | grep -E '\[hud\] smoke'
  EXPECT: /\[hud\] smoke ok/
  EVIDENCE: [hud] smoke ok {"expanded":{"x":299,"y":300,"width":700,"height":400},"orb":{"x":299,"y":300}}

- [x] G10: live act probe — the real main-process path runs and reports the OS
       truth, and the probe itself cannot cry wolf.
  The old EXPECT `/ACT_PROBE done/` was VACUOUS — it also matched
  `ACT_PROBE done FAIL`. It now matches the summary token only.
  Two properties proved live on this machine: (a) untrusted -> an explicit
  `accessibility-not-trusted` refusal, never a silent ok; (b) an unchecked
  process is labelled `trusted:"unknown"`, never `true` — because a dropped
  CGEvent still gets osascript exit 0, so `ok:true` alone is a lie.
  Cursor-delta checks report `inconclusive` (not FAIL) when the user's pointer
  is in motion — the user jiggling the mouse is not our event landing.
  CHECK: env -u ELECTRON_RUN_AS_NODE npx electron scripts/hud-act-probe.cjs --no-sandbox --user-data-dir=/tmp/nub-act-probe 2>&1 | grep -E 'ACT_PROBE'
  EXPECT: /ACT_PROBE summary ok/
  EVIDENCE (2026-08-28, AFTER Accessibility was granted — trusted path now
  VERIFIED, previously declared UNVERIFIED):
    ACT_PROBE done ok {"platform":"darwin","coords":"refused 4 malformed inputs
    with bad-coords","refusal":"returned accessibility-not-trusted + fix-it
    hint","refusal-inert":"cursor unchanged at 4,155","trusted":true,
    "backends":"jxa+systevents","backend":"jxa","landed":true,"via":"jxa",
    "moved":"4,155 -> 28,179 (target 28,179)","restored":true,
    "unknown-labelled":"unchecked attempt reported trusted:\"unknown\", not true",
    "osAllowsEvents":true,"osAllowsNote":"a posted event DID land (4,155 ->
    28,179)","pointerRestore":"best-effort"}
  The trusted happy path is proven by readback, not by exit code: the OS cursor
  moved to EXACTLY the requested point and was then restored. Before the grant
  the same probe read `trusted=false landed=false` — both states are honest
  readings of the machine, not two different assertions.

- [x] G11: the mascot widget actually PAINTS (mount, cat, no glass rectangle,
       expand-on-click) — measured in a real compositor, not jsdom.
  jsdom has no compositor, so the two properties that decide whether the widget
  LOOKS right are invisible to vitest: whether the nubcat SVG rasterises, and
  whether `.hud-root` paints an opaque box behind it. A regression painting a
  black rectangle over the 104x104 orb passes every existing test and looks
  broken on screen. `scripts/hud-widget-probe.cjs` loads the live HUD renderer
  and reads computed style back.
  The cat is the RESTING state, not the opening one: HudShell docks only once
  unfocused AND idle for 3.5s (`RECENT_HOLD_MS`), and a hidden window reports
  hasFocus() true while never receiving a real blur — so the probe drives the
  blur listener and then waits for the dock instead of assuming frame one.
  EXPECT matches the summary token only. Mutation-tested twice: breaking the
  orb selector yields `mascot=false`, breaking the `.hud-root` selector yields
  `transparent=false`. Per-field flags report false when a field was never
  measured, so an unrun check cannot read as green.
  CHECK: npx vite --host 127.0.0.1 --port 5173 --strictPort & env -u ELECTRON_RUN_AS_NODE npx electron scripts/hud-widget-probe.cjs --no-sandbox --user-data-dir=/tmp/nub-widget-probe 2>&1 | grep -E 'WIDGET_PROBE'
  EXPECT: /WIDGET_PROBE summary ok/
  EVIDENCE: WIDGET_PROBE done ok {"mounted":"HudShell mounted (collapsed on
    first paint: false)","mascot":"orb drew 1 mascot SVG(s) at 84x84",
    "transparent":"hud-root paints no background","expand":"cat click opened
    the speech bubble + composer"}

- [x] G12: the probe fails LOUDLY when launched wrong, and its failure output
       is still real JSON.
  Found by mis-invoking it, not by design. `node scripts/hud-widget-probe.cjs`
  is a main-process script, so launching it under node left `app` undefined and
  it died three frames later with
  `TypeError: Cannot read properties of undefined (reading 'whenReady')` — a
  message naming the symptom, not the cause. With ELECTRON_RUN_AS_NODE set,
  `require('electron')` is not even an object: it is the path string, so the
  destructure yields two undefineds with no error at all. Guard added at the
  top of the script; it prints a FAIL record naming the actual cause plus the
  working command, and exits 1. Second defect found inside the fix: the first
  guard wrote `require("electron")` in prose inside a JSON-shaped line, making
  the record unparseable — prose now uses single quotes only.
  EXPECT matches the summary token, so a MISSING summary also fails (no
  vacuous pass when the script never gets far enough to print one).
  Mutation-tested three ways:
    A `env ELECTRON_RUN_AS_NODE=1 npx electron scripts/…`
      -> FAIL: ELECTRON_RUN_AS_NODE is set, so require('electron') returned the
         binary path, not the API
    B `env -u ELECTRON_RUN_AS_NODE node scripts/…`
      -> FAIL: require('electron') returned the binary path string, not the API
    C correct invocation -> summary ok, 4/4 fields green
  A and B print DIFFERENT causes on purpose: an early version blamed
  ELECTRON_RUN_AS_NODE in case B too, where the runner had just unset it,
  sending the next person after a cause that was not there. JSON from branch A
  verified parseable with python3 json.load.
  CHECK: env ELECTRON_RUN_AS_NODE=1 npx electron scripts/hud-widget-probe.cjs 2>&1 | grep -c 'WIDGET_PROBE summary ok' || true
  EXPECT: /^0$/
  (`|| true` because `grep -c` exits 1 on zero matches, which is the PASSING
  case here; without it the CHECK fails on a red exit code while printing the
  green number it is supposed to assert on.)
