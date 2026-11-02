# Hermes Desk improvement plan: Fable 5 second opinion

**Date:** 2026-10-08. **Status:** plan only, not implementation or release approval.

## Second-opinion provenance

OpenRouter returned `anthropic/claude-fable-5`, provider `Anthropic`, with
`finish_reason: stop`. Reported usage: 2,079 input tokens, 3,571 output tokens,
**$0.19934**. The model received a manually written, sanitized architecture and
evidence summary, not source files, conversations, session logs or credentials
in its messages. The supplied key was used only for request authentication.

The initial request returned HTTP 404 with mandatory zero-data-retention routing.
The cause was not established. The user then explicitly authorized standard
routing for the sanitized brief; zero retention is not guaranteed for that
successful request. No different model or unrelated environment key was used.

[The original model response](2026-10-08-fable-5-second-opinion.md) is preserved
separately. It is an opinion about supplied evidence, **not a source-code review**.
This plan checks and adjusts its recommendations against the local repository.

## Baseline and unresolved problems

- The [session-error handoff](../overnight/2026-10-08-followup-session-errors.md)
  records passing lint/types, 180 Node syntax checks, build and **4,620 tests in
  449 files**, plus two fresh 32-check native acceptance runs. These were previous
  checks, not rerun for this planning request. Seven skipped files, 20 skipped
  tests, one expected failure and one todo remain.
- JSON-body profile ownership and the pre-accept exact-peer race are reproduced
  and repaired. Loading the main-process repair in the currently running app
  still requires a separately authorized normal restart.
- The reported React maximum-update-depth crash remains **unreproduced and
  unfixed**. The scroll date setter in its stack does not establish a root cause.
- Existing user work is heavily dirty. No broad cleanup, rollback, installation,
  real-profile operation or automatic release is part of this plan.

## Recommended sequence

Start the owner-decision track, crash investigation and validation inventory in
parallel. Complete the small documentation correction alongside them. Then
close evidenced contract gaps, expand typing incrementally, and improve only
measured complexity/performance problems.

### 1. Capture the React failure safely, then reproduce and repair

**Why first:** this is the outstanding user-visible crash. Existing synthetic
scroll, restoration, streaming, reload and profile-switch probes did not find it.

- First request the expanded first warning/component stack and the interaction
  sequence. Do not ask for transcript contents or a wholesale console dump.
- If insufficient, design opt-in, local-only diagnostic capture with an
  allowlist of counts, fixed event names, lifecycle sequence numbers, scroll
  geometry and ephemeral conversation aliases. Bound memory and duration.
  Exclude prompts, replies, tool payloads, tokens, raw identifiers and paths.
  Do not treat known-format scrubbing as universal secret detection.
- Establish capture/retention policy before persistent export or live capture.
  Test sentinel-secret exclusion and the memory/time bounds.
- Vary timing, uptime, foreground logic, message geometry and async completion
  in disposable sessions. No desktop focus or real clipboard/account activity.

**Acceptance:** a causal failing regression followed by a minimal repair, with
both skins, drafts, transcript anchors and foreground ownership preserved.
If it remains unreproduced, record negative evidence and a bounded next capture
step, not a claimed fix or indefinitely armed logging.

**Stop:** no speculative scroll-effect patch or transcript refactor.

### 2. Establish an honest validation/CI contract

**Evidence:** `package.json`, `scripts/README.md`, `tsconfig.electron.json`,
`vitest.config.ts` and `.github/workflows/ci.yml`.

- Document command, platform/prerequisites, project scope, exclusions and the
  behavior each gate actually proves.
- Align CI type/syntax checks with local `npm run lint`; current CI calls
  `tsc -b`, not the additional Electron check or Node syntax check.
- Verify the inherited skip flags in a clean environment. CI's
  `ELECTRON_SKIP_BINARY_DOWNLOAD` commentary differs from current Vitest:
  only `ELECTRON_SKIP` deliberately excludes the Electron project, and it
  requires explicit `--project unit`. Do not infer CI failure without a run.
- Assess the old web-mode build and a macOS disposable native lane. Decide runner
  trust, backend provisioning, cost and artifact privacy before adding a lane.
- Triage every skipped/expected-failure/todo case. Coverage floors are not
  enforced merely because configured: a provider and successful coverage run
  must be explicitly approved and demonstrated.

**Acceptance:** a gate truth table, explicit reduced-suite labels, evidenced CI
results and actionable exclusion ownership. No “desktop fully tested” claim
from an Ubuntu unit/build result.

### 3. Close missing REST/profile contracts and classify failures

**Depends on:** gate inventory for acceptance claims; retention policy for any
new persisted diagnostics. Fake-harness tests do **not** require a live restart.

- Enumerate applicable endpoint × profile × stored/runtime-ID × error cases.
  Reuse existing collision, named/default profile, rejection/retry, held-accept,
  foreign-owner and closed-peer tests; add only missing meaningful cases.
- Use the installed API contract, not query-string assumptions.
- Add bounded failure categories, such as local peer refusal, timeout, upstream
  non-success and invalid response, without bodies, URLs containing identifiers,
  auth material or tool payloads.
- Keep the live-app restart a separate authorized verification step. A restart
  is not proof that every historical 502 is resolved.

**Acceptance:** each applicable cell is covered or documented as an accepted
gap; profile and conversation ownership remain intact. Credentials are never
sent before exact-peer verification. Deadlines and fail-closed behavior remain.

### 4. Correct documentation without weakening security

**Evidence:** README claims authenticated external attachment; the current host
explicitly refuses `attach` because a bearer authenticates the client, not the
server. Document the supported auto/spawn flow and the restriction.

**Acceptance:** setup prose agrees with host behavior and refusal tests. No guard
change to make obsolete documentation true. Do not rewrite unrelated dirty prose.

### 5. Expand Node typing by risk, one small module at a time

Strict Electron `checkJs` currently covers only `fs-read.cjs` and
`vm-nav-guard.cjs`. Choose stable, frequently changed IPC/transport/host boundaries
by risk and tractability, not by file length. Add explicit contracts and types
without broad suppressions, dependency upgrades or runtime changes.

**Acceptance:** each slice passes lint and its behavioral tests; full acceptance
before integration. A discovered behavior problem becomes a separately
reproduced correctness task, not a concealed “types-only” change.

### 6. Measure performance, then extract only useful stable responsibilities

Measure startup/first paint, preview latency and retained-panel CPU/memory using
disposable data. Define repeatable workloads and budgets before changing caching,
lazy loading or eviction. Heavy preview libraries are already lazy.

Choose one extraction only when it has a concrete maintenance, testability or
measured performance benefit. Write its lifetime/ownership contract first.
Preserve focus, drafts, scroll anchors, deleted-chat tombstones and pending work.
Use the relevant native regression twice for lifecycle-sensitive changes.

**Acceptance:** smaller independently testable ownership boundaries and no
functional, latency or memory regression. No fixed transport-first extraction
order and no arbitrary whole-file rewrite. The unresolved crash blocks invasive
transcript work, not independent stable-module work or measurement.

## Owner/upstream decisions: start now, do not place last

Use the existing [security acceptance checklist](hermes-desk-security-acceptance.md),
not a competing decision register. Record owner, date, scope and rationale for
diagnostic retention, same-UID trust, launcher/interpreter/source provenance,
browser authority, private-network policy, signing/TCC/install assumptions and
upstream session-bound tool identity. Rights/licensing/privacy block public release.

Only relevant decisions gate a work package. Engineers cannot accept risks by
silence. Existing tests and bounded secret scrubbing do not settle these policies.

## Adjustments to Fable's advice

- **Adopt:** owner decisions in parallel; gate verification early; evidence before
  crash fixes; incremental typing; measurement before restructuring.
- **Narrow:** policy gates to affected work; a live restart is not a prerequisite
  for isolated contract tests; an unresolved crash is not a freeze on all refactors.
- **Reject as blanket rules:** diagnostics cannot promise universal absence of
  arbitrary secrets; typing need not precede every extraction; “revert on failure”
  must never erase existing user work. Back out only the precisely owned slice.
- Its one-day documentation estimate and fixed extraction order are not measured
  commitments. No delivery date is implied.

## Validation when implementation is separately authorized

Run from the repository root, starting with the narrow affected tests:

```sh
npm run lint
npm run build
npm run test:run
npm run test:runtime:dev
npm run test:e2e
node tests/e2e/transcript-scroll-lifetime.mjs
node tests/e2e/transcript-scroll-lifetime.mjs --foreground-logic
git diff --check
```

Native commands require macOS and a trusted backend checkout/venv; use temporary
homes and the loopback fake model. Select probes by changed behavior, not by
blindly running historical scripts. Preserve failures and explain skipped checks.
No code, dependencies, workflow, live app or release changes were made here.
