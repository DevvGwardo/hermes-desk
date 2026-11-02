# Gates: HUD voice + act (complete talk→see→point→act)

Closes the Clicky loop end to end. Reuses the repo's existing local-STT stack
(src/lib/dictate.ts DictateEngine, src/lib/stt.ts transcribeAudio, maia:stt*
IPC) — voice is wiring, not greenfield.

Scope:
- S1 hold-to-talk mic in the bubble (DictateEngine reuse): press-hold records,
  release transcribes locally (whisper.cpp), transcript appends to the input.
  Hidden when sttStatus is unavailable.
- S2 POINT label caption: the parsed ":label" (currently discarded) shows as a
  chip by the pointer while the cat is pointing — "what is it pointing at".
- S3 [TYPE:text] act primitive: agent reply carrying the marker types the text
  into the frontmost app via osascript keystroke (no native dep; accessibility
  already on); marker stripped from display. The "act" half of the loop.
Out of scope (declared handoffs): [CLICK:x,y] (no cliclick/Quartz/pyobjc locally
— needs a screen-action tool install); surfacing the [POINT:]/[TYPE:]
protocol to the model (hud_surface_note lives server-side at maiavm.com).

- [x] G1: hold-to-talk mic in the bubble (DictateEngine reuse + stt gating).
  CHECK: npx vitest run src/components/__tests__/hud-shell.test.tsx 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Tests 15 passed (15) — 'hold-to-talk mic button shows when stt is available, hidden when not'

- [x] G2: POINT label caption shows while pointing.
  CHECK: npx vitest run src/components/__tests__/hud-shell.test.tsx 2>&1 | tail -5
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: Tests 15 passed (15) — '[POINT:x,y:label] shows the label chip while the cat is pointing'

- [x] G3: [TYPE:text] act primitive — osascript keystroke IPC + renderer parse/strip.
  CHECK: npx vitest run src/components/__tests__/hud-shell.test.tsx electron/hud-guards.test.mjs 2>&1 | tail -5
  EXPECT: /Test Files\s+2 passed/
  EVIDENCE: component '[TYPE:text] … types into the frontmost app + is stripped'; guards assert spawnSync('osascript') + keystroke + preload typeText + renderer TYPE_ONCE_RE

- [x] G4: full suite green.
  CHECK: npx vitest run 2>&1 | tail -4
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Test Files 142 passed · Tests 1111 passed (1111)

- [x] G5: typecheck clean.
  CHECK: npx tsc --noEmit && echo TSC_OK
  EXPECT: TSC_OK
  EVIDENCE: TSC_OK

- [x] G6: E2E smoke unaffected (about:blank, no renderer race).
  CHECK: NUB_SMOKE_HUD=1 npx electron . --user-data-dir=/tmp/nub-hud-smoke 2>&1 | grep -E '\[hud\] smoke'
  EXPECT: /\[hud\] smoke ok/
  EVIDENCE: [hud] smoke ok {"expanded":{…700×400},"orb":{"x":298,"y":299}} — per-step orb persist fixed the arrival race (was orb:null)

- [x] G7: live — whisper backend transcribes a real wav; dev app boots clean.
  CHECK: bash: generate tone wav -> whisper-cli -> non-error; relaunch dev clean
  EXPECT: whisper ok + boot clean
  EVIDENCE: 1s 440Hz tone → whisper-cli (ggml-small.en.bin) → "(beep)" in 480ms; dev bash-15 boots clean

- [x] G8: docs/HUD.md + STATE.md describe voice + act.
  CHECK: grep -q 'hold-to-talk\|push-to-talk\|dictate' docs/HUD.md && grep -q 'TYPE' docs/HUD.md && grep -q 'voice\|act' STATE.md && echo G8_OK
  EXPECT: G8_OK
  EVIDENCE: G8_OK (docs/HUD.md § Voice + act; STATE.md 2026-08-28 HUD voice + act)
