# Evidence-led implementation follow-up, October 8, 2026

This implements bounded next steps from the
[evaluated Fable 5 plan](2026-10-08-fable-5-improvement-plan.md).
It is not a rewrite, complete security review, or release approval. The user
separately approved a macOS full-suite CI job with a reduced Linux quick job.
No hosted workflow was dispatched or published.

## Delivered

### Opt-in renderer evidence, not a speculative crash fix

- Settings → Advanced → Diagnostics and audit log → Render troubleshooting,
  also discoverable by searching for “crash capture.”
- Off by default. Keeps the newest 128 events for up to five minutes; first
  renderer failure or unhandled rejection freezes capture. Stopped/frozen
  receipts expire and clear after five more minutes. Reload discards capture.
- Fixed event names, relative time/sequence, locally numbered thread transitions,
  message counts, booleans and bounded scroll geometry only. No message content,
  raw identities, dates, paths, error messages or stack URLs are retained.
  Failure classification and component names use finite allowlists.
- Recording never notifies React subscribers, so scroll/commit recording cannot
  feed a state-update loop. Subscribers receive only phase transitions.
- Inspect/stop/clear locally. No automatic persistence, clipboard write, upload,
  console interception, real-account interaction or extra model request.
- Error fallback can show an opted-in receipt. Optional diagnostic UI is lazy;
  its chunk-loading failure cannot remove the original recovery/Reload UI.

The reported maximum-update-depth crash remains **unreproduced and unfixed**.
Only a failing causal reproduction will justify changing scroll/effect logic.
This metadata excludes free-form strings by construction; it is not a general
claim that existing error displays, logs or arbitrary diagnostics contain no secrets.

### Failure categories without upstream payloads

The authenticated main-owned REST proxy retains its generic failure body and
adds `X-Hermes-Serve-Failure` with fixed categories: forbidden, busy,
peer-unverified, timeout, upstream-unavailable, upstream-http, invalid-response,
request-too-large and response-too-large.

The renderer accepts only those categories on non-success responses and exposes
them as optional `failureCategory` metadata in detailed GET/write results.
Upstream-provided failure headers are not forwarded. No exception text, upstream
response body or credentials are added to this diagnostic field.

Malformed JSON now preserves the received HTTP status and is labeled an invalid
response instead of disappearing into a status-zero transport failure. Renderer
timeout classification uses the owned abort signal, not a fragile error-class
check that missed the cross-realm `DOMException` regression.

Route/auth/connected-peer checks, the 2.5-second verification deadline,
30-second request deadline, 16-operation cap, 1 MiB request and 5 MiB response
limits remain. Tests cover refusal before backend credentials, hung/throwing
verifiers, malformed/non-JSON/non-success/oversized replies, oversized requests,
capacity refusal and success/204 controls.

This does not establish the cause of every historical/live 502. The new
main-process behavior needs a separately authorized normal app restart.

### Honest validation and documentation

- Linux quick CI explicitly selects renderer tests with `ELECTRON_SKIP=1` and
  `--project unit`; only it skips the Electron download.
- macOS full CI runs `npm run lint`, `npm run test:run` and `npm run build`,
  including the existing real socket/process-group regressions. It does not
  provision Hermes or run privileged/native-account operations.
- Both jobs use complete local types/syntax checks. Removed the inherited
  duplicate/unowned web-mode build. Base-ref interpolation passes through a
  quoted environment variable.
- Static contract tests, YAML parsing and Actionlint validate configuration
  locally, not the result of a future hosted run.
- README now documents auto/spawn and the actual external-attachment refusal.
  The checks/probes guide distinguishes reduced, full and native/backend scope.
- Incremental strict Electron checking now also includes the existing,
  behavior-unchanged `agent-env.cjs`; all seven environment-scrubbing controls pass.

No coverage provider was installed or enforcement claimed. Existing skipped,
expected-failure and todo cases remain explicit. The inherited Windows release
workflow was not changed or executed; it remains separate owner/release debt.

### Measured performance restraint

The new diagnostics initially grew the boot entry to **7,683 raw / 3,490 gzip
bytes**, failing the existing budget. Moving optional recovery UI off the boot
path through a tiny callback bridge reduced it to **5,397 / 2,459 bytes**.
All 15 existing bundle tests pass without changing ceilings or baselines.

No speculative cache/eviction, broad transcript extraction, visual redesign or
dependency upgrade was made. Startup/retained-panel CPU and memory optimization
still require representative measurements.

## Evidence and corrections

- Missing capture controls: one intended failing UI test before implementation.
- CI scope contract: four intended failing tests before configuration changes.
- Proxy/renderer categories: 12 intended failing tests and seven passing controls
  before the diagnostic repair.
- Added timeout control exposed an abort classification failure; using the owned
  signal repaired it without changing the deadline.
- A first optional-chunk test finished before its rejection and gave a false
  positive. A held loader awaited through React `act` exposed the real failure;
  the optional-load fallback then repaired it.
- A chat fixture initially used the backend role `assistant` instead of the
  renderer's `agent`/required `threadId`; type checking caught and corrected it.
- Native capture first passed 38 checks at
  `tests/e2e/artifacts/transcript-scroll-1791465638731/report.json`.
- A later acceptance attempt timed out opening Advanced after a reload, with no
  React warning or renderer exception:
  `tests/e2e/artifacts/transcript-scroll-1791467096627/report.json`.
  The probe now settles finite animations before opening/interacting with
  Settings and retains extra geometry/animation context on failure. This is not
  a claim to have repaired an application-level intermittent navigation bug.

## Validation

| Check | Result |
| --- | --- |
| Focused capture/recovery/REST/CI controls | 57 tests pass. |
| Wider REST/profile/environment/peer controls | 209 tests pass before additional limit/deadline controls; those controls also pass. |
| Lint/types/Node syntax | Pass, 182 Node files; three bounded Electron modules under strict checking. |
| Production build | Pass; existing Vite import/chunk warnings remain. |
| Full Vitest | **4,661 pass in 455 files**; seven files skipped, one expected failure, 20 skipped tests, one todo unchanged. |
| Production bundle guard | All 15 pass with unchanged budgets. |
| Actionlint/YAML/diff hygiene | Pass locally. |
| Development native runtime | Seven checks pass: 12 streamed replies, notifications/focus, stubbed clipboard retry, drafts, three reloads/24 switches. |
| Fake-model golden E2E | Four tests in two files pass. |
| Final capture-enabled/disabled native repetition | Fresh **38/32-check** runs pass, both skins/two sizes, nine streamed turns, reloads/switches, all profile PATCH replies 200; zero depth warnings or renderer exceptions. |
| Explicit reduced-project smoke check | 36 relevant renderer tests pass with both skip flags and `--project unit`; not a hosted Linux run. |

Full checkpoint log:
`/var/folders/m_/lmx0wysj2p122001hkcqnw3r0000gn/T/droid-bg-1791467096174.out`.
Runtime/golden log:
`/var/folders/m_/lmx0wysj2p122001hkcqnw3r0000gn/T/droid-bg-1791467173354.out`.
Final native reports:
`tests/e2e/artifacts/transcript-scroll-1791467342300/report.json` (capture enabled,
foreground logic) and
`tests/e2e/artifacts/transcript-scroll-1791467403341/report.json` (capture off,
native visibility).

## Preservation and remaining gates

The initial inventory hashes 1,930 tracked/unignored paths. The ownership audit
finds **25 owned changed paths and zero unexpected changes**. Nothing is staged,
committed, installed or pushed. Normal app/gateway processes were preserved;
only disposable validation instances were launched.
All five task-owned validation commands have exited. The normal launcher,
renderer, Electron and gateway retain their prior PIDs.

Next crash investigation needs the first expanded warning/component stack and
the interaction sequence, or this explicitly enabled bounded receipt. No real
transcripts are required. Owner security, provenance, retention, upstream
session identity and public-release rights/privacy decisions remain pending in
the existing [acceptance checklist](hermes-desk-security-acceptance.md).
