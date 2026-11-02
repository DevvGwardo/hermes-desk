# Gates — local STT dictate (Grok-parity, whisper.cpp, no cloud)

Replace the Web-Speech-API dictate in maiavm-desktop with a local whisper.cpp
pipeline, mirroring the Grok Bot recorder flow that was reverse-engineered from
`docs/grok-asar-extract` (getUserMedia → MediaRecorder → mime picker → states
idle/requesting/recording/processing → commit transcript). Transcription runs in
the Electron main process against `whisper-cli`; the renderer never touches the
network or webkitSpeechRecognition.

- [x] **G1** Renderer dictate captures audio locally and sends bytes over IPC only
  CHECK: grep -rnE "\.webkitSpeechRecognition|new SpeechRecognition\b|speech-api|speechapi|recognizemedia|speech.googleapis" src/ electron/ --include="*.ts" --include="*.tsx" --include="*.cjs" | grep -v node_modules | wc -l | tr -d ' '
  EXPECT: 0
  EVIDENCE: 0 — only a doc comment in src/lib/dictate.ts states the old API's absence.

- [x] **G2** Main-process transcription runs whisper-cli on local audio and returns text
  CHECK: node scripts/stt-local-probe.mjs 2>&1 | tail -3
  EXPECT: /ok: true/
  EVIDENCE: probe ok: true — webm/opus → ffmpeg → whisper-cli (ggml-large-v3-turbo) end-to-end, no network.

- [x] **G3** Typecheck clean
  CHECK: cd ~/maiavm-desktop && npx tsc --noEmit 2>&1 | wc -l | tr -d ' '
  EXPECT: 0
  EVIDENCE: 0 errors from npx tsc --noEmit.

- [x] **G4** Unit suite green (rewritten dictate.test + new engine/stt tests)
  CHECK: cd ~/maiavm-desktop && NODE_ENV=development npx vitest run 2>&1 | sed -E 's/\x1B\[[0-9;]*m//g' | grep -E "Tests .*[0-9]+ passed" | head -1
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Tests  631 passed (631) across 90 test files.

- [x] **G5** Production build succeeds
  CHECK: cd ~/maiavm-desktop && NODE_ENV=development npx vite build 2>&1 | tail -2
  EXPECT: /built in/
  EVIDENCE: ✓ built in 1.67s.

- [x] **G6** Denied copy on permission refusal; sub-500ms tap discards silently;
  bridge/model missing → mic hidden (unavailable), app still launches clean
  CHECK: cd ~/maiavm-desktop && NODE_ENV=development npx vitest run src/lib/__tests__/dictate-engine.test.ts src/components/__tests__/chat-dictate.test.tsx 2>&1 | sed -E 's/\x1B\[[0-9;]*m//g' | grep -E "Tests .*[0-9]+ passed" | head -1
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Tests  24 passed — covers denied copy (NotAllowedError), sub-500ms silent discard, bridge/model-missing → mic hidden, unimount cancel, ceiling auto-stop, availability handoff (initialDictateStatus).

- [x] **G7** Voice-chip bars are a REAL EQ: 8 FFT frequency bands (peak per band), not keyframes or a shared volume number; meter emits, settles, cleans up.
  CHECK: cd ~/maiavm-desktop && NODE_ENV=development npx vitest run src/lib/__tests__/voice-meter.test.ts 2>&1 | sed -E 's/\x1B\[[0-9;]*m//g' | grep -E "Tests .*[0-9]+ passed" | head -1
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Tests  6 passed — VOICE_BAND_COUNT frames, band separation proven (1.2kHz lights 1000–2000 band, 8.8kHz lights 8–12k band, both leave bass quiet), silence keeps all bands low, null without Web Audio, interval stops. Gain re-tuned 2026-08-17: pow(0.6) perceptual curve + 1.1 cap + idle floor 4 → normal speech sits mid-range, only loud input tops out (no pegging).