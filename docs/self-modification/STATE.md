# Self-modification implementation ledger

## Bounded continuation, authorized 2026-10-12

- Goal: implement the remaining product lifecycle through Phases 2–7, not an
  open-ended polishing loop. User requested continuation until finished.
- Mechanism: this Droid session's native recurring prompt, not an app scheduler
  or another cross-project task queue.
- Cadence: every 15 minutes, with one immediate first pass.
- Safety ceiling: 24 implementation passes or `2026-10-12T19:31:01Z`, whichever
  comes first. Never silently extend either limit or claim completion at a cap.
- Loop ID: `949fc147`.
- Status: stopped at the hard time bound; loop `949fc147` cancelled after UTC verification at `2026-10-12T19:31:08Z`; pass 7 interrupted/unverified; full Phase 4 remains open.
- Passes started: 7. Passes completed: 6. Active pass: none.
- Active pass started: none. Pass 7 started `2026-10-12T19:19:11Z`, interrupted `19:29:47Z`.
- Last pass: started `2026-10-12T18:33:53Z`, completed `2026-10-12T19:00:05Z`.
- Deliver one complete, runnable, tested vertical slice per pass. Record owned
  files, acceptance checks, failures, limitations and the next bounded slice.
  Advance only after the current slice's behavior and integration are verified.
- Cancel the loop on verified completion, explicit stop, exhausted bounds,
  unrecoverable/conflicting ownership, or a blocking decision/authorization.
  Do not keep waking to re-report the same blocker. Report what needs approval.
- The loop authorizes implementation and disposable validation only. It does
  not authorize commits, publication, dependency installation, paid app-agent
  inference, live profile changes, live installation/activation or restarting
  the user's app. Future UI approvals must bind the exact tested artifact.
- Current phase: Phases 1–3 complete for the bounded local-model proposal path.
  Phase 4 now has renderer-scoped checks and a disposable display, not full app
  qualification. Independent main/preload fixture contracts now run under kernel
  isolation, not native candidate Electron. A full source/renderer/dependency
  input seal is now recorded, still activation-ineligible and not a signed app.
  Fixed renderer checks/build now run against the copied graph and bind new
  output to the full inputs, graph and policy. The disposable display uses that
  bound output. Next target: disposable native candidate-main qualification
  (remaining Phase 4), not approval or activation.
  An actual candidate must use an explicit
  user baseline decision. Tests may make that choice in disposable fixtures;
  never silently select HEAD or incorporate dirty live work.

### Remaining advancement and completion gates

- **Phase 2, verified pass 1:** trusted repository selection, explicit dirty-vs-HEAD baseline,
  isolated workspace identity, real files/diffs, path confinement, ownership and
  stale-baseline tests. Preserve recoverable work on rejection.
- **Phase 3, verified pass 2:** bounded Hermes implementation in the candidate only; explicit
  criteria, attempt/cancellation fencing, resource limits and truthful progress.
  Credentials, live data, journal/approval and activation authority stay outside
  writable candidate scope. No claimed hard billing cap from partial usage.
- **Phase 4:** trusted checks outside candidate control, candidate-added tests
  only supplemental, bounded validation, artifact identity/digest, and preview
  using disposable HOME/userData and fake inference. Run even build scripts
  under the declared isolation policy. Distinguish checks passed, preview
  launched and behavior verified.
- **Phase 5:** exact-candidate review/approval invalidated by any mutation;
  external supervisor, one activation per target, extend staged installer,
  preserve pending work and known-good artifact. No live activation without
  separate explicit approval.
- **Phase 6:** artifact-bound versioned startup handshake, meaningful bridge/
  app health, independent recovery after crash/hang/interrupted activation.
  Back up affected data and prove downgrade compatibility, or refuse activation.
- **Phase 7:** extension isolation and a narrow permissioned API before generated
  extension activation; version/rollback; accepted/rejected/failed/rolled-back
  records. Add only real contribution areas and bounded, user-selected
  suggestions, never perpetual autonomous modification.
- Final acceptance: demonstrate request → isolated edits → validation → isolated
  preview → exact review → explicit approval → activation → health → retain/
  rollback with disposable native fixtures. Cover cancellation during edit,
  build, preview and activation; mutation after approval; competing activations;
  path/symlink replacement; journal/disk failure; failed swap/launch; missing/
  hung startup acknowledgment; incompatible migration; supervisor restart.
  Failed, cancelled, stale or unapproved artifacts must never replace a target.
  Report any unverified live behavior separately; passing types alone is not done.

## Session 1, 2026-10-12

Phase 1 complete and verified: durable requests and a review shell. No execution,
source preparation, validation runner, candidate preview, approval, activation,
or installation is authorized by creating a request. The first delivery stopped
here; subsequent implementation follows the bounded continuation controls above.
The feature is in source and the disposable test renderer, not either app bundle.

### What works now

- Sidebar Search or ⌘K → **Improve Hermes Desk** opens the request journal.
  Required request/acceptance fields are bounded to 8,000/4,000 characters.
- Saved requests can be selected and reviewed, explicitly cancelled, and
  reopened with a new attempt identity and retained cancellation history.
  Closing the modal does not cancel; drafts survive closing within the session.
  Unsaved drafts are not claimed durable across app restart.
- Main owns `<userData>/self-modification/changes.json`. Persistence is
  independent of the renderer origin. No browser-storage fallback exists.
- Details distinguish a recorded request from executing work and explicitly
  show that no baseline, files, artifact, validation, approval or activation
  exists. Only currently implemented operations are exposed.
- Revisions and attempt IDs fence stale callers; modal epochs fence late
  responses. Unknown or malformed schema blocks mutations without resetting
  bytes. Lost save acknowledgments block submission until explicit reload.

### Verified starting point and ownership

- Current source HEAD: `f78711aba214cedc9f4cd4756554b149d49409f3`.
  The checkout has extensive modified and untracked work, not a clean HEAD
  baseline. Existing changes belong to other workstreams and are preserved.
- Agent processes exist in this checkout and other projects; exact ownership
  of their edits is not independently established. Only the integration
  additions below are owned here, not whole pre-modified files.
- Project bundle: `release/mac-arm64/Hermes Desk.app`,
  app.asar SHA-256
  `cf9e0879a1da3ff68f63b5b6ff80d77c776187aec20bc2257b9f790f7c65ece8`.
- Installed bundle: `/Applications/Hermes Desk.app`,
  app.asar SHA-256
  `845a510b0c7d392b46485bf1c829ad60cb49341989041862081c3766feaff21f`.
  These differ. Neither digest identifies the dirty source, nor proves whole
  bundle parity. Neither bundle will be rebuilt, installed or restarted here.
- Actual room journal/controller adapters provide useful atomic-write and
  sender-check patterns, but room checkpoints are renderer-owned conversation
  data, not a change controller. Existing chat approvals do not bind artifacts.
- Runtime plugins are imported into the live renderer, with full app authority.
  Pane, palette and composer integration exists; declared areas are not a
  general isolated extension API. This workflow does not use plugins.
- `scripts/install-local.mjs` stages a copy and preserves the previous app.
  It does not implement startup-health rollback. No integrated change workflow
  was found in current `src/`, `electron/`, or `docs/`.

### Architecture and threat model

- A trusted main-process controller owns a fixed, versioned journal under
  Electron userData. Renderer IPC accepts only list/create/cancel/reopen with
  bounded strings, a journal revision and attempt identity, never paths,
  shell commands, code, arbitrary state transitions, or approval records.
- Version 1 implements only `requested` and `cancelled`. Cancelled attempts
  remain terminal; explicit reopening creates a distinct attempt and advances
  the cancellation epoch. Later phases require an explicit schema migration;
  unknown schema/lifecycle versions fail closed, never silently reset.
- Journal writes use private exclusive temporary files, fsync and atomic
  replacement. Revision comparisons fence stale screens. A writer lock
  serializes controllers; recovery may remove only a verified dead writer's
  unchanged lock. File/directory identity checks and no-follow reads refuse
  detected symlink/replacement hazards. Temporary/target/lock identity is
  checked before rename; cleanup checks ownership and retains unowned files.
  Failed writes authorize no effects. Ambiguous rename/IPC acknowledgments
  are explicitly reported as uncertain; reload reconciles actual journal data.
- IPC is restricted to the current primary app window and its main frame.
  A plugin or compromised renderer still has this window's authority to
  record/cancel requests. This is NOT proof of human intent, a sandbox, or
  permission to execute/approve/activate. Future consequential actions need
  independent, exact-candidate authorization outside candidate control.
- Inputs are inert React text. Journal corruption blocks mutations and reports
  an actionable error; existing bytes are retained. Lost acknowledgments are
  uncertain, requiring a reload/review, not automatic replay.
- Same-user malicious code, filesystem races beyond available Node primitives,
  hardware power-loss guarantees, and confidentiality from the user's own
  privileged processes are not solved by permissions or hashes.

### First slice acceptance

1. Command palette → **Improve Hermes Desk** → bounded request and acceptance
   criteria form. No unsupported later-phase buttons.
2. Successful save displays the durable record and truthful status: no source,
   candidate, checks, approval or activation exists.
3. Close/reopen and full process restart recover records independently of the
   Vite origin. Cancellation persists; reopening preserves cancelled history
   with a new attempt and cancellation epoch.
4. Stale revisions/attempts, malformed records, failed writes, wrong IPC
   callers and detected ownership changes reject without losing prior records.
5. No agent/model calls, plugin activation, shell execution, source edits,
   installation, live profile/session changes, or live app restart.

### Exact owned files

New:
- `electron/self-modification.cjs`
- `electron/self-modification.test.mjs`
- `src/lib/self-modification.ts`
- `src/components/ImproveHermesDesk.tsx`
- `src/components/ImproveHermesDesk.test.tsx`
- `tests/e2e/self-modification.mjs`
- `docs/self-modification/STATE.md`

Small additions only to existing shared files:
- `electron/main.cjs`: register fixed controller IPC.
- `electron/preload.cjs`: bounded bridge methods.
- `src/vite-env.d.ts`: optional typed bridge.
- `src/App.tsx`: lazy modal and command-palette entry.
  Its native workspace viewport is also hidden while this modal is open,
  preventing an Electron browser view from covering the review screen.

Existing shared files, global `STATE.md`, plans, package manifests, plugin
loader, room lifecycle and installer were not otherwise changed by this
workstream. No files were staged, committed, cleaned, installed or published.

### Validation and exact evidence

Final verification on 2026-10-12:

- **213 tests passed in 11 suites** with:
  ```sh
  npm run test:run -- \
    electron/self-modification.test.mjs electron/main.test.mjs \
    electron/preload.test.mjs electron/local/room-journal.test.mjs \
    electron/security-invariants.test.mjs \
    src/components/ImproveHermesDesk.test.tsx \
    src/components/__tests__/app-routines-integration.test.tsx \
    src/components/__tests__/app-modal.test.tsx \
    src/components/__tests__/command-palette.test.tsx \
    src/components/__tests__/command-palette-cross-session.test.tsx \
    src/components/__tests__/palette-plugin-commands.test.tsx
  ```
  New coverage: 49 controller/IPC/preload tests and 14 review-shell tests.
  Includes persistence, cancellation, new attempt fencing, stale revisions,
  late UI results, lost acknowledgments, disk-write/fsync/rename failures,
  uncertain commits, invalid/oversized records, record/attempt limits, dead/live/
  unknown locks, symlink and directory/temporary/target/lock replacement, inert
  markup and prohibited effects.
- **Forced TypeScript checks passed**:
  `./node_modules/.bin/tsc -b --force` and
  `./node_modules/.bin/tsc -p tsconfig.electron.json`.
- `node scripts/check-node-syntax.mjs`: **221 Node files passed** (syntax only).
- `git diff --check`: passed across the shared working tree.
- End-of-session read-only digest checks matched both starting app.asar hashes.
  The project app and installed copy remain distinct and unchanged.
- `node tests/e2e/self-modification.mjs`: **8 native acceptance groups passed**.
  Uses the existing real Electron/app/preload/Hermes harness, disposable
  HOME/userData and fake local inference. Exercises two complete process
  restarts with changed renderer origins; requested/cancelled/reopened data,
  exact corrupt-byte retention and UI rejection; confirms the chat remains
  available, zero fake-model requests, zero chat/approval submissions, unchanged
  source/installer digests, and no renderer errors.
  Final report:
  `tests/e2e/artifacts/self-modification-1791811581950/report.json`.
  Real UI screenshot:
  `tests/e2e/artifacts/self-modification-1791811581950/request-detail.png`.
  These fixture-only artifacts are ignored by Git; this ledger retains the
  command and results for reproducibility. The native harness builds its
  renderer into a temporary directory, not `dist/` or an installed app.

### Failed attempts and corrections

- One discovery read used nonexistent `rooms-journal.cjs`; actual module is
  `electron/local/room-journal.cjs`. No file changes resulted.
- Initial tests: the new UI tests omitted the repository's optional jest-dom
  matcher import, and the maximum-length fixture was one character too long.
  Corrected test setup and constructed an actual 8,000-character input without
  weakening assertions. All 62 initial focused checks then passed.
- Forced types caught a test-only unsupported `getByRole` option (`exact`).
  Removed that option; exact accessible-name matching is already the default.
- First native run selected no agent, so its strict “chat remains available”
  assertion failed. The fixture now opens Alpha's empty chat before the request.
- Second native run sent a keyboard shortcut before the restarted React shell
  was ready. The fixture now clicks the actual sidebar Search entry, whose
  locator waits for readiness. The original lifecycle assertions remain intact.
- Schema fault tests reproduced **two real failures**: regex UUID validation
  coerced one-element arrays into strings, accepting malformed record/attempt
  identities. Added explicit string checks; both regressions and all 213 final
  tests passed.

### Unresolved limitations and checks not claimed

- Full repository suite, packaged app, real-provider/model behavior, physical
  disk-full/power-loss and an abrupt native kill mid-write were not exercised.
  Disk/ownership faults and dead-writer recovery use disposable injected fixtures;
  native process recovery was exercised through complete graceful restarts.
- Directory fsync is best-effort after committed rename. Node lacks directory-fd
  relative operations and exclusive atomic replacement of a previously checked
  inode: hostile same-user swaps in the final check/use gap remain a limitation.
  Same-user malicious code is not sandboxed by this journal or by live plugins.
- Corrupt/unknown locks and records require manual investigation; nothing
  automatically deletes them. Known-dead, unchanged lock recovery does not
  clean orphan temporary files. Journal caps are 200 requests, 50 attempts per
  request and 4 MiB; no history-pruning policy was added.
- Future artifact approval cannot reuse renderer authority as human consent.
  No candidate/build runner, sandbox, activation supervisor, health handshake,
  data migration or rollback lifecycle exists in this slice.
- No decision blocks the delivered phase. Before preparing source in Phase 2,
  obtain a baseline decision: clean HEAD excludes the existing dirty work;
  do not infer permission to incorporate, commit, discard or relocate it.

### Next bounded slice

Phase 2: trusted repository/baseline selection and one isolated candidate
workspace, without agent execution or activation. Acceptance: distinguish
HEAD from dirty source, obtain an explicit baseline decision, record identities,
preserve dirty/untracked work, confine paths, verify workspace ownership, show
real files/diffs, and reject stale baselines without deleting recoverable work.

## Continuation pass 1: Phase 2, complete

### Verified capabilities

- In a saved request, **Choose source repository** uses a native folder picker.
  Main inspects the selected root and returns an expiring opaque selection.
  The user must explicitly check **Use committed HEAD only** before preparation.
  Dirty/untracked counts and exclusion are shown; no path-entry text field or
  default baseline authorization exists.
- Atomic v2 intent precedes workspace creation. The UI polls only while
  preparing, allows explicit cancellation, then shows prepared/failed states.
  Cancelled work is retained; reopening creates a new, empty attempt.
- A separate owned `source/` subtree contains committed regular files only.
  Protected `owner.json`, `manifest.json` and `baseline/` remain outside that
  subtree. Revision, operation, attempt and cancellation fences prevent a late
  Git result or failed final checkpoint from claiming completion.
- **Review candidate files and diffs** reads actual current candidate files,
  compares protected baseline bytes/modes, and reports added/modified/deleted/
  unchanged files, exact content digests and full-file text diffs. Binary and
  truncated displays are labelled; this is not validation or approval.
- Requests, ownership and real diff review survive a complete native restart.
  Interrupted preparation is recorded as failed/uncertain completion, without
  automatically resuming or deleting an unverified workspace.

### Bounded implementation decisions

- Native folder selection supplies a main-owned, short-lived repository token.
  Renderer paths never select sources or workspace destinations.
- This slice supports **explicit committed-HEAD snapshots only**. Dirty and
  untracked work is counted, reported as excluded, and never copied or changed.
  No working-copy snapshot option will pretend to work before it is implemented.
- Materialize regular tracked blobs into an isolated source copy, not a Git
  worktree that mutates the shared checkout's metadata. Git runs bounded,
  read-only plumbing with hooks/fsmonitor/pagers/external configuration disabled.
  Reject symlinks, submodules, unsafe paths and known sensitive filenames.
  Preparing source does not execute candidate scripts.
- Version 2 explicitly migrates v1 request records and adds preparing/prepared/
  failed states with recorded source/operation/workspace identity. Persist intent
  before creating a workspace; cancelled/stale callbacks cannot finalize it.
  Interrupted preparations are reported, never automatically resumed or deleted.
- Keep ownership metadata and baseline bytes outside the candidate-writable
  `source/` subtree. Review reads bounded files and produces real content/mode
  manifests and text diffs; it never runs candidate Git configuration.
- This is filesystem separation and bounded trusted plumbing, **not** an agent
  execution sandbox. Same-user hostile check/use races remain explicitly limited.

### Exact owned changes for this pass

- New `electron/self-modification-schema.cjs`,
  `electron/self-modification-workspace.cjs`,
  `electron/self-modification-workspace.test.mjs`,
  `src/components/SourcePreparation.tsx`,
  `src/components/SourcePreparation.test.tsx`.
- Extended `electron/self-modification.cjs`,
  `electron/self-modification.test.mjs`, `src/lib/self-modification.ts`,
  `src/components/ImproveHermesDesk.tsx`,
  `src/components/ImproveHermesDesk.test.tsx`, and
  `tests/e2e/self-modification.mjs`.
- Small new `electron/preload.cjs` bridge methods and a `dialog` dependency in
  the existing `electron/main.cjs` registration. No other shared-file edits.
- No candidate was created from the live checkout. No live index/history,
  dependency installation, model call, live app restart or installation occurred.
  Disposable Git fixtures create local source objects using the configured
  identity, not author overrides; they do not touch live repository history.

### Architecture and compatibility additions

- Schema/lifecycle v2 supports requested/preparing/prepared/failed/cancelled.
  `prepared` means source copied, not preview-ready or approved. Explicit
  read-only v1 migration preserves IDs, cancelled history, revisions and epochs;
  the next successful atomic write persists v2. Unknown/malformed data is retained
  and rejected. Older v1-only app code cannot consume v2; activation must later
  account for this downgrade constraint, not assume data-safe rollback.
- There is no Git metadata inside the candidate: this is an equivalent source
  copy, not a shared-repository worktree. Git executes read-only plumbing via
  `/usr/bin/git`, with minimal environment, global/system config, hooks,
  fsmonitor and pagers disabled, bounded output and a 20-second command timeout.
- Preparation permits at most two independent operations with distinct workspace
  ownership. Caps: 5,000 regular files, 2 MiB per file, 128 MiB total. Review also
  bounds path length/depth, directory entries and displayed diff bytes.
- Symlinks, submodules, `.git` paths and known sensitive filenames are rejected.
  The actual app's committed `.env.example` template is allowed; live `.env`
  and untracked data are not copied. Filename checks are not a general secret
  detector or an agent sandbox.
- Same-user filesystem check/use races, hostile modification of trusted main
  code and full-authority renderer plugins remain outside this protection.
  Candidate execution needs a real declared isolation policy in Phase 3.

### Checks and evidence

- **244 tests passed in 13 suites**: the prior 11 integration/security/modal/
  palette suites plus `electron/self-modification-workspace.test.mjs` (24 tests)
  and `src/components/SourcePreparation.test.tsx` (7 tests). Controller/review
  regression coverage remained 49/14 tests.
- `./node_modules/.bin/tsc -b --force`,
  `./node_modules/.bin/tsc -p tsconfig.electron.json`,
  `node scripts/check-node-syntax.mjs` (**224 files**, syntax only), and
  `git diff --check` passed.
- `node tests/e2e/self-modification.mjs`: **11 native acceptance groups passed**.
  Three complete restarts with changed origins; real main/preload/source-copy/
  diff integration; explicit non-default HEAD choice; dirty/untracked preservation;
  request/cancellation recovery; corruption rejection; zero fake-model calls,
  zero chat/approval submissions, unchanged implementation/installer digests and
  no renderer errors.
  Evidence: `tests/e2e/artifacts/self-modification-1791813467454/report.json`,
  `request-detail.png` and `source-review.png` in that directory.
  The native picker result was injected only in the disposable main process;
  a human operating the OS folder dialog was not tested.
- Fault fixtures cover failed intent/final writes, deliberately late callbacks,
  cancellation before/during copying, retained cancelled work, interrupted-intent
  recovery, two isolated concurrent preparations/third refusal, root/owner/
  manifest/baseline/symlink mutation, stale selection, inert candidate scripts and
  Git hooks/fsmonitor, and explicit v1 migration.
- Read-only live-HEAD feasibility inspection found 1,516 regular files totaling
  27,054,305 bytes, no oversized files/submodules/symlinks, and the `.env.example`
  compatibility issue described below. This was metadata inspection, not a
  full live-source snapshot or approval to create one.
- End-of-pass bundle digests match Session 1's separate project/installed hashes.
  Neither existing app bundle contains this source update yet.

### Failed attempts and remaining limits

- New mock bridge returns initially widened TypeScript discriminants; a second
  test-only issue used readonly fixture arrays for mutable API results.
  Added explicit result/function types instead of weakening runtime assertions.
  All forced checks passed.
- Real HEAD metadata exposed a genuine usability defect: the sensitive-path
  guard rejected the app's committed `.env.example`. A fixture reproduced the
  failure (`failed` instead of `prepared`), then a narrow template exception
  passed while the live `.env` exclusion stayed asserted.
- Full repository suite, packaged-app behavior, physical disk/power faults and
  abrupt native death during source copying were not tested. Native restart
  recovery is graceful; interrupted intent/failed final checkpoint use fault
  fixtures. No full live-source candidate was created or executed.
- Only committed HEAD is supported. Working-copy capture, linked Git worktrees,
  symlinks/submodules, agent edits, validation runners, previews, exact approval,
  activation and rollback remain unimplemented. Baseline template names do not
  prove their content contains no secrets. File review is a bounded observation,
  not an atomic candidate snapshot or approval.
- No decision blocks the delivered slice. Obtain a baseline decision before
  preparing actual live source, and separate authorization before real inference
  or live activation.

### One next bounded slice

Phase 3: user-initiated bounded implementation in an already prepared candidate,
using a trusted helper with a declared execution isolation policy, attempt/
cancellation fencing and truthful durable progress. Reuse Hermes only where it
can satisfy candidate-only writes without live credentials/data/approval access.
Default validation uses disposable HOME/userData, fake local inference and owned
candidate resources. Acceptance: explicit criteria reach the worker, only the
candidate changes, cancellation/late results cannot finalize newer attempts,
interrupted execution is recorded honestly, and no activation authority is given
to the candidate or model. Do not run the existing full-authority live Hermes
session merely because its bridge is available.

## Continuation pass 2: bounded Phase 3, complete

### Verified capabilities

- A prepared request offers **Request candidate implementation**, with no
  inferred model, endpoint or file consent. Select 1–12 existing candidate
  text files and supply a local, tool-free OpenAI-compatible model server port
  and model. A default-deny native confirmation binds that selection and input
  digest before any inference. Declining leaves the journal/candidate unchanged.
  This consent authorizes inference/candidate edits only, never activation.
- A fresh isolated Hermes **core**, not the live CLI/profile/chat gateway, receives
  the saved request, acceptance criteria and selected file bytes. Every runtime
  toolset is disabled and the actual tool list must be empty before generation.
  The existing one-shot CLI was rejected because it loads profile context and
  auto-bypasses tool approvals.
- Model text is an untrusted JSON proposal. Main validates the entire set of
  relative write/delete operations, limits, path collisions, regular-file
  ownership and selected existing-file digests before writing content.
  Main alone applies candidate edits. Generated scripts are inert, unselected
  existing work cannot be overwritten, and baseline/owner/journal state is not
  a proposal target.
- Durable running → applying → implemented/failed checkpoints, attempt/operation/
  cancellation fences, actual content-digest review and explicit partial-edit
  retention. A failed intent or inference/applying checkpoint denies the next
  effect. A failed final acknowledgment cannot claim completion; recovery records
  interruption without rerunning inference or deleting edits.
- The UI polls while implementing, exposes cancellation/history/errors and shows
  **Candidate edits recorded. Not tested, previewed, approved or activated.**
  Closing is not cancellation. Candidate diffs and completed attempt evidence
  survive a complete native restart without re-executing the worker.

### Declared isolation and resource policy

- macOS only, fail closed if the existing provisioned runtime or `sandbox-exec`
  is unavailable. No installer, PM bootstrap or unsandboxed fallback.
- Deny-default Seatbelt policy: read-only provisioned Hermes/Python/dependencies
  and bounded system-library roots; writable fresh per-attempt runtime HOME only;
  no candidate filesystem access, live profile/data/journal, Keychain/UI/MCP
  authority, child processes or undeclared outbound network. Main supplies
  selected candidate text over stdin. Known credential/Git/state filenames are
  additionally denied within permitted read roots.
- A private authenticated broker fixes the selected model and loopback endpoint.
  Before each physical inference request it requires a successful durable
  checkpoint. Maximum two physical requests, fixed 8,192 output tokens/request,
  30-second upstream timeout, 1 MiB encoded input/output/broker limits, bounded
  diagnostics and 16 concurrent broker connections. Unsupported catalog probes
  return no metadata and are never forwarded or billed. Provider tool/function
  calls and non-final responses are rejected before Hermes can process them.
- Independent Python deadline: 110 seconds after adapter input, plus a
  120-second parent watchdog; 45 CPU seconds, 128 descriptors, 8 MiB per runtime
  file and disabled core dumps. No hard memory, aggregate-disk or billing cap
  is claimed. Requests are recorded before dispatch, not proof of provider
  completion or cost.
- Context: UTF-8 only, 64 KiB/file and 256 KiB total, with an additional encoded
  budget. Proposal: at most 12 operations, 128 KiB/file and 512 KiB total.
  Existing-file changes require explicit context selection; new safe text paths
  are allowed. Writes are individually atomic, not an all-or-nothing multi-file
  transaction. Cancellation/failure may leave partial edits or owned temp files.
- The model server must itself be trusted and tool-free. Known agent/MCP ports
  8642/9119 are refused; response validation cannot prove what an operator's
  server does internally. This is not a reuse of the live Hermes gateway.

### Exact owned changes

- New `electron/self-modification-execution.cjs`,
  `electron/self-modification-execution.test.mjs`,
  `electron/self-modification-runner.cjs`,
  `electron/self-modification-hermes.py`,
  `src/components/CandidateImplementation.tsx`,
  `src/components/CandidateImplementation.test.tsx`,
  `tests/e2e/self-modification-worker.mjs`.
- Extended owned controller/schema/workspace modules and their three tests;
  `src/lib/self-modification.ts`; both ImproveHermesDesk/SourcePreparation
  components and their tests; `tests/e2e/self-modification.mjs`; this ledger.
- Shared-file additions only: one `implement` bridge method in
  `electron/preload.cjs`, and one main-owned `getHermesHome` dependency in the
  existing `electron/main.cjs` registration. No additional App/room/plugin/
  installer edits and no staging, commits or publication.
- No actual live-source candidate, real provider call, dependency installation,
  live profile change, installed-app activation or user-app restart. Disposable
  committed fixtures use the configured Git identity; live HEAD remains
  `f78711aba214cedc9f4cd4756554b149d49409f3`.

### Compatibility and observations

- Journal/lifecycle v3 adds nullable execution metadata and implementing/
  implemented states. Strict read-only v1/v2 migration retains identities,
  cancellations, preparations and bytes; the next atomic write persists v3.
  Contradictory execution states, excessive calls and incomplete prepared
  identities fail closed without rewriting corrupt bytes.
- Older v1/v2-only code cannot consume v3 journals. Future activation/rollback
  must account for this version boundary and affected data, not assume downgrade
  compatibility.
- The recorded output digest binds observed paths/content only, not executable
  modes, an immutable snapshot or a built artifact. It is not an approval.
  Validation/artifact identity must independently capture relevant metadata.

### Checks and exact evidence

- **286 tests passed in 15 suites**: the prior 13-suite command plus
  `electron/self-modification-execution.test.mjs` and
  `src/components/CandidateImplementation.test.tsx`. Controller/IPC tests: 50;
  preparation tests: 24; execution tests: 35; request/source/worker UI: 14/7/6.
  Existing main/preload/security/room/modal/palette integration checks passed.
- `./node_modules/.bin/tsc -b --force`,
  `./node_modules/.bin/tsc -p tsconfig.electron.json`,
  `node scripts/check-node-syntax.mjs` (**228 Node files**, syntax only),
  Python `ast.parse` of the trusted adapter without bytecode writes, and
  `git diff --check` passed.
- `node tests/e2e/self-modification-worker.mjs`: **eight native acceptance
  groups passed**. Real kernel read/write denials including Data-volume aliases;
  child-process/undeclared-network denials; real provisioned tool-free Hermes;
  provider tool-call refusal; failed-journal dispatch refusal; native cancellation;
  two-request broker cap; independent Python exit 124 before the parent watchdog.
  Five physical requests went only to the owned fake server; zero live inference.
  Evidence:
  `/private/var/folders/m_/lmx0wysj2p122001hkcqnw3r0000gn/T/hd-worker-native-b04NNH/report.json`.
- `node tests/e2e/self-modification.mjs`: **14 native acceptance groups passed**,
  four complete restarts with changed renderer origins, one explicit worker fake
  request, zero live-chat fixture model requests/approval submissions, unchanged
  source/installer digests and no renderer errors. Native dialog/runtime results
  were injected in the disposable main only, not through production bypass flags.
  Evidence: `tests/e2e/artifacts/self-modification-1791817744095/report.json`,
  `request-detail.png`, `source-review.png`, `candidate-implementation.png`.
- Fault tests additionally cover stale context/caller during consent, overlapping
  confirmations, invalid/bounded input, whole-proposal rejection, new/deleted
  files, selected-only overwrites, root/owner/parent/symlink replacement, cancel
  before and during application, late results/new attempts, final checkpoint
  failure with retained edits, interrupted recovery and malformed v3 bytes.
- Both project/installed app.asar digests still match Session 1's distinct
  `cf9e0879…c65ece8` / `845a510b…feaff21f` identities. Neither bundle contains
  this source update. At `15:10:30Z`, bounds were unexhausted; loop `949fc147`
  remained running, no conflicting owned-file changes or blocking decision found.

### Failed attempts and remaining limits

- Native policy initially used unsupported numeric-IP SBPL syntax, then Python
  aborted during dyld bootstrap. Owned-process kernel diagnostics identified a
  denied read of the filesystem root; literal-root read plus narrow library
  roots fixed bootstrap without allowing live-data access. Alias regression
  tests passed; no alias escape was reproduced.
- Darwin aliases RLIMIT_AS to RSS and rejected the attempted setting. Removed
  the false virtual-memory-cap claim rather than implying a hard memory limit.
- Hermes uses streaming completions and several catalog protocols. An initial
  broker refusal failed generation, and fail-fast treatment of catalog probes
  killed valid startup. Added bounded final-text SSE translation and empty
  unsupported-route responses, without forwarding metadata or exposing tools.
- Old version/API expectations and legacy fixture fields failed after v3.
  Corrected explicit migration fixtures and exact method/version assertions;
  unsupported-schema tests still reject unknown versions. Two mock promise/
  discriminant errors failed forced types; explicit bridge result types fixed them.
- Disposable main evaluation lacked global `require`; fixture injection now uses
  Node's builtin createRequire, with no production global or bypass.
- A real red test showed an ancestor/descendant proposal could leave its first
  file before failing. Whole-set prefix-collision preflight now rejects it before
  any content write; the unchanged assertion passed green.
- Full repository suite, packaged-source behavior, real providers, non-macOS
  execution, physical power/disk faults and abrupt native main death during
  application remain untested. Recovery/final-write faults use disposable injected
  state; complete native restarts are graceful. The independent worker deadline
  was observed, not a destructive live-parent crash test.
- This is bounded selected-text implementation, not general autonomous repo
  browsing, shell execution, dependency installation or multi-file transactions.
  Same-user hostile check/use races and compromised trusted code remain outside
  this protection. No builds, trusted validation runner, candidate preview,
  artifact approval, activation, health rollback or extension isolation exists yet.
- No blocker prevents further infrastructure work. Actual live baseline capture,
  real inference and live activation still require their own exact authorization.

### One next bounded slice

Phase 4: independently trusted validation plus one isolated disposable preview of
an implemented candidate. Pin actual source/build identities, keep check definitions
outside candidate control and treat candidate scripts/tests as untrusted code
(candidate-added tests are supplemental). Run even build scripts under a declared,
tested execution policy; no network/dependency installation or live credentials/
profiles/journal/activation authority. Bound work and fence cancellation, stale
results, journal failures and interruption. Distinguish checks passed, preview
launched and behavior verified; demonstrate malicious-script confinement and a
real native preview with disposable HOME/userData and fake inference. Do not add
approval/activation buttons or use observation digests as approval.

## Continuation pass 3: renderer-scoped Phase 4 slice, complete

**Full Phase 4 is not complete.** This slice verifies fixed renderer checks and
one sealed, offline renderer display. It does not test candidate main behavior,
evaluate the user's acceptance criteria, qualify an activation package, or provide
approval, activation, health rollback or extension isolation.

### What works now

- An implemented candidate offers **Run scoped renderer checks**. Main requires
  a fresh revision/current attempt and default-deny native confirmation. A
  declined confirmation changes neither the journal nor candidate. Check intent
  is durably acknowledged before tools start.
- Main captures all candidate file paths, bytes, sizes and POSIX modes into a
  bounded input identity, then makes a separate private build copy. Maximum
  5,000 files, 2 MiB/input file, 128 MiB/input tree and 32 path components.
  Source materialization/review ownership checks still apply. Symlinks,
  hardlinks, unsafe/sensitive paths and candidate node_modules fail closed.
- Mandatory checks use provisioned TypeScript with an independently generated
  renderer config, then Node syntax parsing of all candidate .js/.cjs/.mjs files.
  Candidate tsconfig cannot select or disable the mandatory TypeScript command.
  A second type check runs after the build; input bytes/modes must still match.
  Candidate-added tests are not run or counted as trusted critical tests.
- The build uses provisioned Vite/React/Tailwind with a main-generated config
  outside writable build scope. Candidate Vite, Babel, PostCSS configuration,
  npm scripts and install hooks are not executed. No dependency installation,
  network, model request, live HOME/profile or activation operation occurs.
  This deliberately replaced the initial proposal to execute candidate Vite
  configuration, rather than making unverified descendant-lifetime claims.
- Scoped stylesheets reject Tailwind JavaScript directives, escaped at-rules
  and import-inspection bypasses, including comment/invalid-UTF8 cases. Supported
  CSS imports are quoted inspected relative .css files or provisioned tailwindcss;
  local Tailwind shadowing is rejected. Prose/test mentions are not stylesheets.
  Other build configuration/import behavior is unsupported, not silently qualified.
- After successful fixed commands, unchanged source and bounded safe output,
  main copies renderer output outside worker-writable scope. Its manifest digest
  binds paths, bytes, sizes and modes. A separate owner marker and root inode
  bind the artifact to this check operation. Maximum 5,000 output files,
  16 MiB/output file and 128 MiB/output tree. Everything remains retained on
  interruption or unknown acknowledgment; nothing is replayed or cleaned.
- **Open isolated renderer preview** requires another explicit native confirmation,
  an unchanged current candidate and intact artifact/owner identity. Intent is
  journaled before a window exists. Main never loads candidate Electron code.
- The display is a separate sandboxed Chromium renderer in a fresh nonpersistent
  session, hosted by the trusted app main. It is **not a separate candidate main
  process or disposable full-app userData/HOME**. No preload, app bridge, Node,
  webview, permissions, external navigation, popup, download, worker, network
  connection or audio is granted. A restrictive response CSP and session request
  policy serve only digest-checked assets. The window expires after two minutes.
- One check or display slot is allowed at a time. Cancellation aborts an owned
  build/process group or destroys only the owned display. Attempt/epoch/revision/
  operation/preview IDs fence late callbacks. Lost start acknowledgment prevents
  launch; lost readiness acknowledgment closes the window.
- Renderer readiness is recorded separately from behavior. `behaviorVerified`
  and artifact `activationEligible` are fixed **false**. Neither passing checks
  nor displayed pixels is approval or health. UI shows exact source/renderer
  digests and scope limits; no approval/activation buttons exist.
- Restart fails interrupted checking without rerunning tools. An interrupted/
  unknown display is marked as such without reopening it. Checked evidence is
  retained. A live/unknown other owner is not presumed dead or duplicated.

### Declared isolation and resource boundaries

- Verified build platform: **macOS arm64 only**, no permissive fallback.
  A deny-default Seatbelt profile allows read-only provisioned code/dependencies,
  narrow system library roots and metadata-only ancestry needed for Node's
  realpath. Only fresh private scratch is writable; controls, original candidate,
  live profile, journal and artifacts are outside writable scope.
- Child executables are fixed verified Node/Python and the provisioned esbuild
  binaries used by the installed root/Vite versions. Environment is rebuilt,
  not inherited. Known credential filenames are read-denied. Networking and
  undeclared executables are denied by the kernel.
- A 240-second parent watchdog bounds the operation. Each Node command inherits
  an independent terminating alarm of at most 230 seconds, 90 CPU seconds,
  256 descriptors, 32 MiB/file, no core dump, and a UID-relative process ceiling
  set to the observed UID process count plus 32 (clamped to the existing hard
  limit). Combined stdout/stderr is capped at 1 MiB/command.
- No hard memory, aggregate-disk, aggregate-CPU or renderer-process resource cap
  is claimed. Renderer lifetime uses the trusted main's timer. Provisioned
  transitive dependencies remain trusted; the fingerprint covers policy/helper
  code, tool versions, Node, TypeScript/Vite entrypoints and esbuild binaries,
  **not an immutable complete dependency graph**. Arbitrary candidate build
  hooks/descendant containment are not qualified by these probes.
- Same-user hostile check/use races, compromised trusted code/dependencies,
  physical power/disk faults and exhaustive Chromium escape resistance are
  outside the demonstrated protection. Missing/changed files always block use;
  retained metadata does not prove an artifact survived a physical disk fault.

### Version and ownership

- Strict journal/lifecycle **v4** adds checking/checked states and nullable scoped
  validation, artifact and display records. Read-only v1/v2/v3 migration retains
  bytes/history; the next successful atomic write persists v4. Malformed scopes,
  invented activation eligibility or verified behavior are rejected, not reset.
- v3-only software cannot consume v4 journals. Activation/data backup/downgrade
  handling remains a required later gate, not an assumed rollback capability.
- New owned files:
  `electron/self-modification-artifact.cjs`,
  `electron/self-modification-build.cjs`,
  `electron/self-modification-build.py`,
  `electron/self-modification-validation.cjs`,
  `electron/self-modification-validation.test.mjs`,
  `electron/self-modification-preview.cjs`,
  `src/components/CandidateValidation.tsx`,
  `src/components/CandidateValidation.test.tsx`,
  `tests/e2e/self-modification-build.mjs`.
- Updated existing workstream controller/schema/workspace, typed contracts and
  request/source/implementation UI/tests for v4 and the bounded methods. Extended
  `tests/e2e/self-modification.mjs` with actual check/display/recovery/cancellation.
- Shared-file edits in this pass are only one hd-candidate scheme registration
  in `electron/main.cjs`, its exact expectation in `electron/main.test.mjs`, and
  two bounded bridge methods in `electron/preload.cjs`. Other dirty/untracked work,
  package manifests, installer, global STATE/plans and live profiles are preserved.
  No staging, commit, publication, installation or user-app restart occurred.

### Final checks and exact evidence

- **333 tests passed in 17 suites**, the prior 15 integration suites plus scoped
  validation and UI suites. Controller/IPC: 52, preparation: 24, execution: 35,
  scoped validation/faults: 39, scoped UI: 6. Shared main/preload/security/room/
  modal/palette integrations passed.
- Forced `tsc -b --force`, `tsc -p tsconfig.electron.json`, **234 Node files**
  syntax-only, Python AST syntax without bytecode writes, tracked diff whitespace
  and owned-untracked whitespace checks passed.
- `node tests/e2e/self-modification-build.mjs`: **six native acceptance groups**.
  Real fixed TypeScript/Vite success despite throwing candidate configuration/
  hooks; genuine type/syntax failures; real kernel protected-fixture read/write,
  control-forgery, executable and network denials; scratch-only writes;
  cancellation of the owned worker; independent alarm; abrupt death of an owned
  **Node orchestration fixture**, not the user's app, followed by worker expiry.
  Zero inference. Final report:
  `/private/var/folders/m_/lmx0wysj2p122001hkcqnw3r0000gn/T/hd-build-native-AbvvIG/report.json`.
- `node tests/e2e/self-modification.mjs`: **18 native acceptance groups**, five
  complete disposable Electron/backend restarts with changed renderer origins,
  one explicit owned fake worker request, zero live-chat fixture model requests/
  approval submissions, unchanged source/installer digests and no renderer errors.
  Actual sealed candidate JavaScript displayed pixels in a separate native
  sandboxed window; bridge/Node were absent; network/popup probes made zero
  requests; actual cancellation closed it. Lost close acknowledgment was injected
  only in disposable journal rename, then real restart recorded interruption
  without auto-reopening or rebuilding. Evidence:
  `tests/e2e/artifacts/self-modification-1791822823186/report.json`,
  `renderer-checks.png`, `isolated-renderer.png`, plus earlier lifecycle screenshots.
- Earlier failed probes exposed denied ancestor lstat during Node bootstrap,
  mismatched root/nested esbuild versions, stale version/API/protocol expectations,
  missing DOM matcher import, terminal cancellation timestamp fencing, fixture
  multi-diff selection and a creation listener replacing the preview session
  policy. Narrow fixes passed the unchanged behavioral assertions. Graceful close
  correctly recorded closed, not interrupted; the native interruption case now
  explicitly injects a lost close acknowledgment rather than misreporting a crash.
- At `16:35:10Z`, HEAD and both original distinct app.asar hashes were unchanged.
  Neither bundle contains this slice. The loop remained running, with limits
  unexhausted and no known owned-file conflict or blocking authorization decision.

### Remaining Phase 4 and one next bounded slice

Finish **Phase 4 qualification**, not Phase 5 activation: add independently owned
critical regression definitions outside candidate control, a policy-tested
disposable candidate-main harness with fake services and no live authority, and
one full artifact identity including main/preload/renderer and declared provisioned
dependency/build provenance. Keep candidate-added tests supplemental and all
results activation-ineligible until full validation/preview gates are satisfied.
Prove malicious candidate-main confinement, failed/absent/hung readiness,
mutation/cancellation/late callbacks, journal faults and interrupted recovery in
disposable fixtures. Obtain separate exact authorization before actual live
baseline/inference/install/restart actions. Do not reinterpret this renderer
display as a healthy app or enable approval using its observation identity.

## Continuation pass 4: independent authority fixture contracts, complete

This is one additional Phase 4 gate, **not full Phase 4 completion**. It executes
candidate main/preload with declared inert adapters under the real macOS kernel
sandbox. It does not launch a native candidate Electron main, qualify candidate
dependencies, or turn a renderer artifact into an activation package.

### Verified behavior and contracts

- A checked candidate offers **Run isolated authority contracts**, implemented
  through a bounded three-argument primary-main-frame IPC method. Main requires
  matching source/renderer identities, candidate electron/main.cjs and
  electron/preload.cjs, default-deny native confirmation and acknowledged intent
  before any candidate code executes. No command/path is accepted from renderer.
- Six fixed definitions live in trusted main and evaluate child observations:
  main window sandbox/context isolation/Node/preload preferences; foreign host
  sender rejection; change-controller main-window/main-frame fencing; navigation/
  redirect/popup denial; clipboard browser-permission denial; and the exact
  bounded preload change methods/channels/arguments, rejecting extra commands.
- Candidate main/preload execute from a separate source copy. Electron, host
  startup and plugin/media adapters are inert fixture doubles. Other required
  helpers come from the trusted provisioned fixture implementation, **not from
  candidate dependencies**. Their behavior is outside this qualification.
- Node VM is only an adapter mechanism, explicitly **not a security boundary**.
  The outer Seatbelt policy denies child processes, networking and source writes.
  It adds read-only trusted fixture-helper code; original candidate, parent
  journal, live profiles and activation authority remain outside writable scope.
  Only fresh private scratch/fake userData may be written.
- Parent evaluates observations, never a candidate-returned passed/qualified
  flag. Source bytes/modes, sealed renderer and definition fingerprints are
  checked again before recording completion. Candidate-added tests cannot change
  these definitions. Definition identity covers the adapter/evaluator files.
- Important remaining trust limit: observations are **untrusted test-double
  observations**. Candidate code could tailor or forge child traces. Passing
  these finite contracts is not proof against malicious intent, dependency
  behavior, native UI/IPC differences or a security escape. The journal and UI
  permanently mark nativeBehaviorVerified/fullAppQualified false and keep the
  renderer artifact activationEligible false. No approval depends on this gate.
- Work uses the existing single check/display slot. Source mutation, failed
  intent, lost final acknowledgment, overlapping operations, cancellation and
  late results cannot finalize or replay stale work. Unknown completion remains
  explicit. Interrupted running observations become failed without rerunning code.
  Passed observations survive complete disposable app restart.
- Default independent command deadline is 30 seconds; parent watchdog is
  40 seconds. VM startup has a separate 1.5-second interrupt. Inherited limits:
  90 CPU seconds, 256 descriptors, 32 MiB/file, no core dump and the previously
  declared UID-relative ceiling. Standard output observations are capped at
  128 KiB, overall stdout/stderr at 1 MiB. No hard memory/aggregate-disk cap.
- A cancelled attempt with an unacknowledged running intent is shown as cancelled/
  unknown, not falsely reported as a live worker. It does not poll forever or
  offer a retry that might duplicate uncertain execution.

### Compatibility and exact ownership

- Journal/lifecycle **v5** adds nullable authority observations within scoped
  validation. Strict read-only v1–v4 migration preserves bytes/history, then the
  next successful atomic write persists v5. Invented native/full-app verification
  flags are rejected. Older v4-only code cannot read v5; downgrade/data safety
  remains an explicit later activation/rollback gate.
- New owned files:
  `electron/self-modification-authority.cjs`,
  `electron/self-modification-authority-worker.cjs`,
  `tests/e2e/self-modification-authority.mjs`.
- Updated owned controller/schema/validation/build modules, typed contract and
  validation/request UI, plus their lifecycle/migration/bridge/mock regressions.
  The build runner's optional trusted authority mode denies fork/source writes
  and separates bounded stdout observations from diagnostics; renderer build
  policy remains unchanged by default.
- Extended owned native lifecycle fixture with explicit main/preload test input,
  separate refused/accepted contract consent, persisted scoped evidence and
  restart retention. This copy of current main/preload is explicit disposable
  **test input**, not a selected live-source candidate or user baseline decision.
- Only shared-file addition in this pass: one bounded authority method in
  `electron/preload.cjs`. No main.cjs/main.test changes in this pass. Existing
  dirty/untracked source, package manifests, installer, global plans/STATE and
  installed app remain preserved. No commit, install, publication, real inference,
  live profile change or user-app restart occurred.

### Checks and exact evidence

- **355 tests passed in 17 suites**. Controller/IPC: 53; scoped validation/
  authority/faults: 56; scoped UI: 10. Existing source/execution/main/preload/
  security/room/modal/palette integrations passed. Six bad-observation variants,
  extra preload commands, forged success fields, missing files, refusal, start/
  final acknowledgment failure, overlap, cancellation/late results, mutation,
  restart and v4/v5 compatibility were exercised.
- Forced TypeScript projects, **237 Node files** syntax-only, Python AST syntax
  without bytecode writes, tracked diff whitespace and owned-untracked whitespace
  passed. Full repository suite and packaged behavior were not run.
- `node tests/e2e/self-modification-authority.mjs`: **six native kernel acceptance
  groups**. Actual copied main/preload satisfy fixed fixture observations; a real
  weakened Node-integration preference is red; actual candidate code is denied
  protected-fixture read/write, source writes, fork and network; throwing/missing/
  initial infinite-loop boot fails; an asynchronous hung reply expires under the
  independent alarm; actual cancellation terminates the owned worker.
  Zero inference, explicitly no native candidate app. Final report:
  `/private/var/folders/m_/lmx0wysj2p122001hkcqnw3r0000gn/T/hd-authority-native-HZjF2E/report.json`.
- Existing native build acceptance: **six groups passed**, including abrupt
  owned Node-parent death and independent worker expiry. Final report:
  `/private/var/folders/m_/lmx0wysj2p122001hkcqnw3r0000gn/T/hd-build-native-uJXf6n/report.json`.
- Full disposable Electron lifecycle: **19 groups passed**, five complete app/
  backend restarts, separate fixture consent and real isolated contract execution,
  persisted exact evidence, no automatic rerun, actual offline display/cancellation
  and lost-close-ack recovery. One worker fake inference request in the passing
  run; zero live-chat fixture model/approval submissions; no renderer errors;
  source/installer digests unchanged.
  `tests/e2e/artifacts/self-modification-1791824735369/report.json`,
  `authority-contracts.png`, `renderer-checks.png`, `isolated-renderer.png`.
- An initial red-probe fixture changed the first Node-integration occurrence
  (HUD), not the main window. Changing both fixture preferences exercised the
  intended main regression and retained the red assertion. Tests were not weakened.
- At `17:07:20Z`, HEAD and both original app.asar hashes were unchanged. Loop
  `949fc147` remained running; bounds were unexhausted, no active earlier pass or
  known owned-file conflict was found. No genuine authorization blocker exists
  for further infrastructure/disposable-fixture work.

### One next bounded acceptance target

Remaining Phase 4: produce a **full sealed activation-ineligible app identity**,
binding candidate main/preload and renderer plus explicit provisioned dependency/
build provenance, rather than mutable source plus a renderer-only digest. Verify
mutation, ownership/path replacement, canceled sealing, journal faults and
restart reuse without rebuilding. Native candidate-main execution/preview under
a tested disposable no-live-authority policy is still required before Phase 4
can close; fixture adapters are not a substitute. Keep all approval/activation/
health functionality unavailable until those gates pass, and never choose a real
user baseline or infer live permission from fixture consent.

## Continuation pass 5: full-app-input seal, complete

This is one Phase 4 input-identity slice, **not Phase 4 completion**. It copies
checked candidate source, main/preload, renderer and the entire provisioned
node_modules graph into one content/mode/link-bound identity. It executes no
candidate or dependency code and neither packages nor installs a signed app.

### Verified capabilities and authorization

- After passed independent fixture contracts, **Seal full app inputs** requires
  separate default-deny native confirmation of exact source, renderer and
  provisioned dependency digests/size. A declined confirmation changes no journal
  bytes. Renderer sends only revision/request/attempt, never a command or path.
- Main revalidates source, renderer, current build-helper identity, definition
  identity and dependency graph before acknowledging seal intent. Only then
  does it write a private exclusive `seal-<operationId>` job. No new live-source
  baseline choice, inference permission or activation is inferred.
- Artifact layout: `artifact/app/` holds every candidate source file,
  `app/dist/` the exact already checked renderer output, `app/node_modules/`
  the entire provisioned graph, and `artifact/provenance.json` the fixed
  declaration. Candidate `dist` input is refused to prevent collisions; the
  package must declare the fixed `electron/main.cjs` entry.
- Identity includes file paths/content/size/modes, directory paths/modes and
  exact relative link targets. Candidate inputs remain link-free. Provisioned
  dependency links must resolve inside their own graph; absolute, dangling,
  escaping links, hardlinks, special files and sensitive filenames are refused.
  Controls/journal/owner markers remain outside candidate writable scope.
- Main streams physical bytes with no-follow/nonblocking descriptors. Under
  Electron it uses `original-fs`, not virtual ASAR contents. On macOS a
  `/dev/fd/<pinnedFd>` clone request binds the already opened source inode.
  Copied bytes are independently recaptured and compared. Output file modes
  are explicitly applied and fsynced; small buffers are reused.
- A separate owner token/id and artifact-root device/inode accompany the whole
  digest. Parent/root/owner/provenance/content/mode/link checks precede reuse.
  A renamed parent replaced by a symlink is refused, even if it resolves to
  the original bytes. Same-user final check/use races are still not solved.
- Cancellation, stale epochs/operations, journal faults and replaced ownership
  prevent a completed seal acknowledgment. Partial/unknown work is retained,
  never cleaned or automatically retried. Late completion cannot replace a
  reopened attempt. Interrupted acknowledged intent becomes failed on recovery;
  another live/unknown owner is not presumed dead.
- **Verify sealed app inputs** checks the actual retained tree after restart,
  without recopying, rebuilding, rerunning contracts or inference. Mutations
  also block the existing isolated renderer display. Cancelled sealing is shown
  as cancelled/unknown, not ongoing or successful.

### Bounds, provenance and remaining trust limits

- Dependency capture: **1 GiB**, at most 50,000 entries, **256 MiB/file**.
  Whole artifact: **2 GiB**, at most 60,000 non-root entries, 32 path components.
  Existing candidate/renderer input caps remain unchanged.
- Read-only preflight/verification has a 120-second cooperative deadline;
  sealing has a separate **180-second cooperative deadline**, unchanged after
  native expiry tests. Source/journal ownership is checked throughout; expensive
  journal reconciliation is sampled at most every 50ms and forced at intent/
  completion boundaries. Synchronous chunks cannot dispatch main IPC.
  Work yields by elapsed time to keep ordinary IPC/cancellation responsive.
- These are trusted-main cooperative deadlines, **not independent process
  alarms or hard I/O/CPU/memory limits**. A blocked filesystem syscall can
  prevent timely interruption. No aggregate retained-disk cap, pruning or
  guaranteed physical power-loss durability is claimed.
- The graph is captured **at seal time**. The renderer was built earlier using
  the prior fixed policy and partially fingerprinted provisioned toolchain.
  Its complete transitive build graph is **not** retroactively proven equal
  to this snapshot. Provenance explicitly records
  `dependencySnapshotStage:"seal"` and
  `rendererBuildDependencyGraphBound:false`. This is a required remaining gate,
  not complete build provenance or a validated activation package.
- The recorded platform/architecture/OS release and toolchain digest declare
  external system/build services; they do not freeze or qualify the OS, Hermes
  service, transitive behavior, signatures, xattrs, native Electron, acceptance
  criteria, startup health or downgrade compatibility.
- `fullAppQualified:false` and `activationEligible:false` are strict constants.
  No approval/activation action exists. Candidate/dependency scripts are stored
  as inert bytes, not executed during sealing. A copied fixture main may still
  lack required candidate helpers; native app readiness is not claimed.

### Exact ownership and compatibility

- New owned `electron/self-modification-seal.cjs` and
  `electron/self-modification-seal.test.mjs`.
- Updated owned validation manager/tests, controller/schema/tests, build-helper
  fingerprint, authority method definition, artifact mode materialization,
  typed bridge, request/validation UI/tests and bridge mocks in source/
  implementation tests. Workspace/execution tests now expect v6 atomic writes.
- Extended owned `tests/e2e/self-modification.mjs` with separate seal refusal/
  approval, complete graph copy, raw ASAR-byte comparison, persisted full identity,
  restart verification, truthful UI and failure diagnostics. This ledger only
  is updated for project state; no global STATE/plans/Organizer queue was edited.
- Shared-file addition in this pass: one bounded `seal` method in
  `electron/preload.cjs`. No main.cjs/main.test edits in this pass. Existing
  unrelated dirty/untracked work and installed bundles were preserved.
- Journal/lifecycle **v6** adds nullable seal intent/result. Strict read-only
  v1–v5 migration preserves raw bytes/history; a successful atomic write persists
  v6. Corrupt/unknown/invented qualification or eligibility is refused.
  v5-only software cannot read v6; data-safe activation/rollback must handle this
  explicitly. No automatic downgrade/repair/reset was introduced.

### Checks, failures and exact evidence

- **398 tests passed in 18 suites**. Controller/IPC: 54; scoped validation/
  authority/seal/faults: 79; seal primitives: 15; scoped UI: 14. Prior main/
  preload/security/room/source/execution/modal/palette integration gates passed.
  Faults include atomic ENOSPC, partial copy failure, declined/stale consent,
  missing contracts, mutations, root/owner/parent symlinks and mode changes,
  late cancellation/new attempt, uncertain final acknowledgment, interrupted/
  live-owner recovery and read-only v5 migration.
- Forced TypeScript projects, **239 Node files** syntax-only, tracked diff
  whitespace and all 33 owned-file whitespace checks passed. Python code was
  unchanged; no new Python execution/resource claims are made.
- Existing native build: **six groups passed**, including kernel denials,
  actual failure, cancellation and independent alarm after abrupt owned
  Node-parent death. Report:
  `/private/var/folders/m_/lmx0wysj2p122001hkcqnw3r0000gn/T/hd-build-native-al8i6P/report.json`.
- Native authority: **six groups passed** under the new exact bounded preload
  surface, including real red preference regression, read/write/source/fork/
  network denials, initial/asynchronous hangs and cancellation. Report:
  `/private/var/folders/m_/lmx0wysj2p122001hkcqnw3r0000gn/T/hd-authority-native-zc6e6y/report.json`.
- Disposable native Electron lifecycle: **21 groups passed**, five complete
  app/backend restarts, full copy and raw archive-byte identity, explicit fixture
  consent, exact restart reuse, retained display/cancellation/lost-close recovery,
  one owned worker fake request, zero live-chat fake requests/approval submissions,
  unchanged source/installer hashes and no renderer errors.
  Final seal: **34,828 entries / 814,627,527 bytes**. No live inference/install/
  activation/profile mutation/user-app restart occurred.
  Evidence: `tests/e2e/artifacts/self-modification-1791829002977/report.json`,
  `full-app-inputs.png`, `authority-contracts.png`, `isolated-renderer.png`.
- Red tests reproduced mode loss from process umask and acceptance of a
  symlink-replaced seal parent. Explicit chmod and parent pinning fixed both
  without weakening assertions. Five initial v6/API/migration regressions were
  stale test expectations/legacy fixture fields and were corrected explicitly.
- **Ten native attempts failed before the two final passing runs.** Early
  observations surfaced disabled-action waits, an inspector promise-GC error
  and preconfirmation timeouts; direct UI/trusted fixture diagnostics identified
  virtual-ASAR fstat identity mismatch, not a successful refusal. Physical
  `original-fs` fixed it. A preview variable shadow then failed sealed display;
  a positive seal→preview regression covers the fix.
- Three subsequent full graph copies expired with explicit unknown sealing,
  never a fabricated artifact. Reusing a 256 KiB synchronous buffer (rather than
  allocating more than 8 GiB of short-lived buffers per graph), pinned-FD clone
  copying and elapsed-time yielding passed the same unchanged deadline. Native
  confirmation/reply waits now observe actual fixture consent markers and UI
  completion, not an unchanged early status. Tests were not weakened.
- Full repository suite, packaged/signed candidate behavior, physical disk/
  power faults, abrupt native death during sealing and malicious same-user races
  remain untested. Native sealing expiry was observed; cancellation/final-journal/
  partial-disk faults use owned injected fixtures, not physical disk destruction.
- At `18:21:54Z`, HEAD and both original distinct app.asar hashes were unchanged.
  Loop `949fc147` remained running within bounds, no pass overlap, blocking
  authorization or known owned-file conflict. Tests never selected live HEAD.

### One next bounded acceptance target

Remaining Phase 4: rerun the independently generated renderer type/syntax/build
checks **against the copied dependency graph**, then record renderer output and
complete graph provenance as one exact identity. Prove original graph mutation
cannot affect that build, while copied graph/source/output mutation, cancellation
and unknown acknowledgment cannot qualify it. This closes the declared build-
provenance gap, **not native app health**. Disposable native candidate-main
execution/preview with real critical behavior under a verified no-live-authority
policy still must pass before Phase 4 closes. Phases 5–7 remain unimplemented.
Retain false qualification/eligibility and seek separate exact authorization
before live baseline capture, paid inference, install/activation or user restart.

## Continuation pass 6: copied-graph renderer build, complete slice

Started `2026-10-12T18:33:53Z`; verification completed `19:00:05Z`.
This closes the declared renderer/dependency build-provenance gap, **not Phase
4's native candidate-main qualification**. Phases 5–7 remain unimplemented.

### Verified capabilities and exact identity

- After a complete acknowledged app-input seal, **Build against sealed
  dependencies** offers a separate default-deny native confirmation. Refusal
  leaves the journal unchanged and starts no compiler. The bounded primary-
  frame bridge accepts only revision/change/attempt, never paths or commands.
- A fresh source/scratch/HOME and independently generated fixed TypeScript/
  Vite configuration run type checks, all candidate JS syntax checks, Vite
  build and repeated type checks. Candidate configuration, package scripts and
  install hooks remain ignored. The selected Node/Python runtimes are still
  external provisioned tools; compiler/plugin/esbuild resolution now points
  **only inside `seal-<operation>/artifact/app/node_modules`**. No installer,
  model call, network, live profile, journal or activation authority is granted.
- The exact copied dependency manifest is checked before and after execution,
  source scratch and current candidate digests must remain unchanged, and the
  full app-input seal is independently recaptured before final acknowledgment.
  Tool/policy fingerprints are repeated. Kernel policy grants graph reads but
  no graph writes and only exact copied native-tool execution. Original
  dependencies are not allowed read/exec roots for this build.
- A composite SHA-256 binds `scope:"sealed-graph-renderer"`, full input digest,
  source digest, complete dependency digest, policy/tool digest and newly sealed
  renderer output digest. `bound-<operation>/artifact/` stores the new output;
  trusted owner metadata remains outside the worker's writable scratch.
  Reuse checks owner, parent/root identity, bytes, modes, file count, full input
  seal and composite digest without consulting mutable original dependencies
  or rerunning compilers.
- The isolated display selects the new bound output, confirms its actual
  renderer digest, verifies the binding before launch and checks asset bytes/
  modes on reads. Passing types, pixels or this binding never set native health,
  full-app qualification or activation eligibility.
- Durable intent precedes execution. A single confirmation/worker/display slot,
  revision/attempt/operation/cancellation fences and explicit final checkpoints
  block stale, cancelled, failed or uncertain results. Late completion cannot
  overwrite a reopened attempt. Unknown work is retained, not replayed; a dead
  owner is recovered as interrupted, and a live external owner is not guessed
  dead. Cancelled UI status says completion unknown, not still running.

### Important provenance and resource limits

- This is a **composite input-plus-output identity**, not a newly assembled full
  app folder, signed package or deployment. The earlier full seal's `app/dist`
  still contains the earlier renderer; its historical
  `rendererBuildDependencyGraphBound:false` remains correct and is not rewritten.
  A future native runner/assembler must use the separately bound new renderer,
  verify the full referenced input seal and composite, and cannot substitute
  the earlier folder wholesale as a qualified new app.
- Full source bytes/modes used in the fresh scratch match the previously sealed
  source digest. Native candidate main/preload have not run as an Electron app;
  the six authority observations remain test-double contracts. Dependencies'
  behavior, external OS/runtime/build services, acceptance criteria and app
  health remain unqualified. `fullAppQualified:false` and
  `activationEligible:false` remain strict constants.
- Existing macOS-arm64 kernel boundary, 240-second operation watchdog,
  independent per-command alarm (230 seconds), CPU/file/descriptor/process/
  diagnostic caps and bounded renderer capture remain unchanged. Preflight
  inspection has a 120-second cooperative deadline; graph/tree hashing/copying
  and filesystem syscalls do not acquire independent hard deadlines or hard
  aggregate disk/memory guarantees. Active journal fences are sampled at most
  50 ms apart, with forced phase/final fences. Same-user malicious races and
  hardware faults remain outside the verified guarantees.

### Exact owned changes and compatibility

- New owned `electron/self-modification-bound-build.cjs`.
- Updated owned build/validation/controller/schema/authority definitions and
  validation/controller/execution/workspace tests; typed bridge; validation/
  request UI; source/implementation/request bridge mocks and UI tests.
- Extended native build and lifecycle harnesses. The authority harness itself
  is unchanged but rerun against the new exact preload definition.
- Shared-file addition: one `boundBuild` bridge method in
  `electron/preload.cjs`. No pass 6 main.cjs, installer, plugin, root STATE,
  Organizer, plan, staging, commit or publication changes. Other dirty/untracked
  work and installed/project bundles remain preserved.
- Journal/lifecycle **v7** adds nullable bound-build intent/result. Strict
  read-only v1–v6 migration preserves raw bytes/history and cannot invent bound
  output. The next successful atomic write persists v7; v6-only software cannot
  read it. Future rollback must handle this boundary, not assume downgrade
  compatibility. Incorrect source/input/dependency bindings and invented
  qualification/eligibility are refused.

### Checks, failures and exact evidence

- **422 tests passed in the same 18 governance/integration suites** as pass 5.
  Controller/IPC: 55; validation/authority/seal/bound/faults: 99; scoped UI: 17;
  seal primitives: 15. Existing main/preload/security/room/source/execution/
  modal/palette gates remain green. Forced renderer/Electron TypeScript passed,
  **240 Node files** syntax-only, Python AST, tracked diff whitespace and
  **34 owned text-file whitespace** checks passed.
- Bound-build fault coverage includes refusal/stale revision, failed intent
  acknowledgment and actual injected ENOSPC, missing seal, source/graph changes
  during confirmation, candidate/scratch/graph changes during command flow,
  real failed worker response, concurrent slots, late cancellation/new attempt,
  lost final acknowledgment/restart without replay, live external owner,
  output/mode/owner/parent-symlink/graph changes before reuse/display, strict v6
  migration and rejection of invented native health or activation.
- `node tests/e2e/self-modification-build.mjs`: **eight native groups passed**.
  Real fixed build succeeds after corrupting both TypeScript/Vite entrypoints
  in a separate disposable original graph. Every compiler/plugin/native-tool
  path resolves inside the sealed full copied graph. Actual kernel probes
  allow copied reads/exact native tool, deny copied writes, original graph
  reads and original native-tool execution. Prior real type/syntax red tests,
  scratch/control/live-fixture/network denials, cancellation, independent alarm
  and abrupt owned-parent death remain asserted.
  Evidence:
  `/private/var/folders/m_/lmx0wysj2p122001hkcqnw3r0000gn/T/hd-build-native-urWLKj/report.json`.
- `node tests/e2e/self-modification-authority.mjs`: **six native groups passed**
  with the exact new bounded preload surface, including actual red preferences,
  kernel read/write/source/fork/network denials, initial/asynchronous hangs and
  actual worker cancellation. No native app health is claimed.
  Evidence:
  `/private/var/folders/m_/lmx0wysj2p122001hkcqnw3r0000gn/T/hd-authority-native-0e5jII/report.json`.
- `node tests/e2e/self-modification.mjs`: **23 native groups passed**. Separate
  refused/accepted native fixture consent, real copied-graph build, full seal
  and physical ASAR identity, actual bound renderer display/no bridge/Node/
  network/popup, complete restart reuse without compiling, lost-close
  acknowledgment recovery and actual display cancellation all passed. Five
  disposable app/backend restarts, one fake worker request, zero live-chat/
  approval submissions, unchanged source/installer digests and no renderer
  errors. Full seal: **34,828 entries / 814,627,593 bytes**.
  Bound identity:
  `f919426db8ce2b9467a9b8d2f08c011aa147c9eef0331eb555d53e978e90d598`.
  Evidence: `tests/e2e/artifacts/self-modification-1791831282537/report.json`,
  `bound-renderer-build.png` (visually inspected), `full-app-inputs.png`,
  `isolated-renderer.png`.
- Initial focused verification exposed exact API/v7 expectation regressions;
  updated explicit method/count/version assertions without relaxing them.
  A native fixture omitted the copier's required check callback and failed
  before qualification. Its corrected first double durable provisioning copy
  exceeded the outer 240-second test command timeout. Fixture construction now
  uses fast APFS clones plus independent complete graph capture; the actual
  production durable copier is still exercised unchanged by UI acceptance.
- The first native UI attempt expired during the earlier full-input seal while
  concurrent graph-fixture/test traffic was running. It retained unknown seal
  intent/partial files, never claimed an artifact, and did not reach bound
  compilation. Evidence:
  `tests/e2e/artifacts/self-modification-1791830957767/report.json`.
  Rerun without concurrent full-copy traffic passed the same unchanged sealing
  deadline. Contention is an observation, not an isolated/proven cause.
- Full repository suite, packaged/signed candidate execution, real providers,
  physical power/disk faults, abrupt native death during the new composite
  final checkpoint and hostile same-user races remain untested. Faults use
  disposable injected state; independent worker-parent-death expiry is real.
- At `19:00:05Z`, HEAD remained
  `f78711aba214cedc9f4cd4756554b149d49409f3`, both original distinct app.asar
  hashes matched Session 1, and owned background validation processes had
  exited. Loop `949fc147` was running within bounds; no overlap, genuine
  authorization blocker or known owned-file conflict. No live baseline,
  installation, paid inference, profile change or user-app restart occurred.

### One next bounded acceptance target

Remaining Phase 4: a disposable **native candidate-main Electron qualification**
vertical slice using the exact verified full input seal plus bound new renderer,
under a tested no-live-authority policy. Independently observe real critical
window/preload/bridge behavior, not VM adapter traces or pixels. Refuse missing
helpers, graph/source/output mutation, missing/hung startup acknowledgment,
cancellation, unknown checkpoints and unsafe authority. Do not autoapprove,
install or activate. Native fixture launch authority must not become production
activation authority. Respect the unchanged `19:31:01Z`/24-pass ceilings; at a
cap cancel the loop and report remaining work, never label Phase 4 or the full
lifecycle complete.

## Continuation pass 7: native-input diagnostics, interrupted/unverified

Started `2026-10-12T19:19:11Z`; interrupted `19:29:47Z` to respect the unchanged
hard stop. **Not counted complete.** Only twelve minutes remained at inspection,
so the slice was narrowed to bound native-input diagnostics, not an unverified
native execution boundary. Native candidate-main qualification and Phases 5–7
are still missing. No new pass may start without renewed continuation authority.

### Implemented and unit-verified, not native-UI-qualified

- After an acknowledged bound renderer, **Inspect native inputs** sends only
  revision/change/attempt. Main independently verifies the full input seal and
  bound output before/after inspection, source identity and unchanged journal
  revision/state. Mutation, cancellation, replaced owner/root, stale caller or
  navigation blocks a returned report. Inspection writes no journal, launches
  nothing and executes no candidate scripts or model calls.
- Results bind input/source/bound digests, report missing `electron/main.cjs`,
  `electron/preload.cjs` and observed literal relative CommonJS paths, and expose
  missing/nonliteral/scan counts. UI uses a real explicit read action and drops
  late results after cancellation, attempt change or unmount.
- These are **lexical diagnostics**, not a parser or module-closure proof.
  Comments/strings may match; dynamic, aliased, ESM, package, directory-package
  and native imports are not qualified. Zero missing paths never means a runnable
  or safe app. `inspectionComplete`, `nativeExecuted`, `fullAppQualified` and
  `activationEligible` stay false. Reports are ephemeral UI observations, not
  a new durable qualification checkpoint. Journal remains v7.
- Final scan caps: 256 JS/CJS files, 2 MiB lexical bytes, 128 returned missing
  paths; over-1024-character literal paths get a bounded diagnostic. Skipped
  files are explicitly counted. Match iteration is streaming, not full arrays.
  Existing source capture is still bounded by the earlier tree limits. The
  120-second inspection deadline is cooperative, not an independent CPU/
  memory/syscall bound or verified native execution policy.

### Exact ownership, checks and failure

- New owned `electron/self-modification-native-inputs.cjs` and
  `electron/self-modification-native-inputs.test.mjs`.
- Updated owned validation manager/tests, bounded controller/authority
  definitions/controller tests, typed bridge, request/validation UI and tests,
  source/implementation bridge mocks and native lifecycle harness.
- Shared addition: one `nativeInputs` method in `electron/preload.cjs`.
  No main.cjs, installer, plugin, global STATE/plan/Organizer, staging, commit,
  publication, live baseline, real provider or user-app restart changes.
- Before the final scan-cap refinement: **432 tests passed in 19 suites**,
  including the prior governance/integration gates, missing/unsafe/unbound/
  mutated/cancelled inputs, read-only restart reuse, caller navigation, late UI
  replies and exact primary-frame/preload fencing. After the refinement:
  **126 tests passed in three affected suites** (scanner 5, validation 102,
  scoped UI 19). Forced renderer/Electron types, **242 Node syntax files** and
  tracked diff whitespace passed after final code changes. Python AST and
  **36 owned-file whitespace** checks passed before that final refinement.
- Native authority: **six groups passed** with the expanded exact preload
  definition, including real kernel denials/red preferences/hangs/cancellation.
  Report:
  `/private/var/folders/m_/lmx0wysj2p122001hkcqnw3r0000gn/T/hd-authority-native-1eBO28/report.json`.
- **Native lifecycle failed** at the existing full-input seal's 180-second wait,
  before reaching bound compilation or the new diagnostics UI. Fourteen earlier
  groups had passed; no new diagnostics native acceptance is claimed. Copied
  files and unknown sealing intent were retained, not acknowledged as a sealed
  artifact. Deadline/tests were not weakened and no retry could safely finish
  before the hard stop. Cause was not isolated.
  Report:
  `tests/e2e/artifacts/self-modification-1791832936819/report.json`.
- At `19:27:36Z`, HEAD and both original distinct app.asar hashes still matched
  Session 1. Owned native test processes exited normally; no known owned-file
  conflict or separately authorized live action was needed. No fake native
  success, approved artifact, installation or activation was introduced.

### Required next acceptance, only under renewed bounds

First verify ownership and current work, then finish the retained pass 7 native
UI diagnostics acceptance without overlapping full dependency-copy traffic.
Do not blindly clean/reset its unknown fixture. Thereafter complete Phase 4's
real native candidate-main execution/critical qualification using the exact
full inputs plus new bound renderer under a proven no-live-authority policy.
Phases 5–7 and the full request-to-retain-or-rollback acceptance still remain.

## Renewed authorization — 2026-10-13 frontend-only delivery contracts

This is newly authorized work, **not a continuation or re-arming of stopped
loop `949fc147`**. Existing history/ceilings remain intact. Source journal stays
v7; a separate strict v1 delivery journal records bounded frontend versions.
Native-complete Phases 4–7 and S1 are **not accepted or complete**.

### Implemented scope and preserved work

- Existing owned source files were backed up before edits at
  `/tmp/hd-selfedit-2026-10-13-baseline/`. No commits, pushes, install, live
  profile/credential access, paid inference, or user-app restart.
- Explicit HEAD versus content/identity/mode-bound allowlisted working snapshot,
  original dirty/index/HEAD preservation, independent native default-Cancel
  baseline review. No automatic HEAD choice or dirty inclusion.
- Main-enforced presentation-only proposals/context/qualification, with immutable
  native/preload/security, dependencies/build/persistence/transport and
  self-editing/GenUI authority/glue. Proposal fixtures were updated to permitted
  presentation paths, not made exceptions to the policy.
- Strict versioned delivery intent, exact diff/check/health/baseline/request
  review, separate immutable scrollable native review UI, independent default-deny
  expiring native approval, source identity/revision/epoch/mutation fences.
- External selected renderer-target staging, shared writer-lock linearization,
  nonce/artifact health binding, known-good/partial/rejected retention, independent
  health timeout, duplicate-version refusal and restart reconciliation. No
  generic command/path/JS IPC or arbitrary native extension authority.

### Evidence, limitations and next required acceptance

- **398 focused tests passed in 13 suites**, including 41 supervisor failure/
  restart contracts with real owned Node-process crashes. Their qualification
  and native-health evidence is explicitly **synthetic**, not native acceptance.
  `/tmp/hd-selfedit-2026-10-13-contracts-final.log`.
- Forced renderer types and `npm run lint` passed renderer/Electron types and
  **266 Node syntax files**. `npm run build` passed with existing bundle/import
  warnings. `/tmp/hd-selfedit-2026-10-13-build-final.log`.
- Actual standalone Electron independent-review UI passed real hardened window/
  OS-sandbox observation, no application bridge/Node, inert escaped malicious
  text, private foreign-frame refusal, cancel/continue and capability teardown.
  This is **UI-only**, with `nativeQualification:false` and `artifactApproved:false`:
  `/var/folders/m_/lmx0wysj2p122001hkcqnw3r0000gn/T/hd-self-edit-native-review-687GYA/report.json`.
- Copied trusted-host native qualification remains default-denied: denying
  LaunchServices aborts NSApplication; allowing it conflicts with Chromium
  nested sandbox initialization under the outer Seatbelt policy. The owned
  diagnostic `--no-sandbox` window is rejected as weaker, never adopted.
  Completed native evidence:
  `/private/tmp/hd-selfedit-2026-10-13-native-8gGzWz/report.json`.
  Latest frozen retry timed out during second graph copy at 240 seconds, retained
  `/private/tmp/hd-selfedit-2026-10-13-native-Xifcfi/`, with no child remaining and
  no qualification/reuse. Earlier fingerprints do not describe final source.
- No native approval or real application/rollback has occurred. The installed
  `.app` target path is refused. Physical-ASAR-bound running-host attestation,
  installed-host renderer consumption and trustworthy live lease/pending-work
  integration are unfinished. Metadata flags/`lsof` alone are not an idle proof.
- Final disposable native lifecycle **prefix: 24 checks passed**, one owned fake
  inference request, zero live-chat requests/approval submissions, no renderer
  errors, original source/installer hashes unchanged. Five owned app/backend
  restarts; explicit baseline, only permitted frontend proposal, real checks,
  full seal and copied-graph binding, lexical diagnostics and inert preview/
  cancellation/lost-close recovery. This is not native qualification or S1.
  `/Users/devgwardo/hermes-desk/tests/e2e/artifacts/self-modification-1791903703829/report.json`,
  `/tmp/hd-selfedit-2026-10-13-prefix-final-2.log`.
  Seal 34,829 entries / 814,629,854 bytes; bound renderer
  `09e61edc83691d61baef3339ef72aef9a688a2bdf4c65d83212a8ffad59ecdb3`,
  bound identity
  `789b0b7d86c2f5756d0f13d935b8744982071982716a0018b44fdf8c729e4d25`.
  Final 48-file owned source fingerprint (all hashes and whitespace rechecked):
  `871f0a0938eef96cb79927076d7cce35479f23dcf5ea9e47aabedea5288a5890`;
  `/tmp/hd-selfedit-2026-10-13-owned-manifest.json`.
- S1 is blocked; S2 contracts are partial/synthetic for native health; S3 actual
  review UI is proved, not complete activation UI; S4 protected contracts pass;
  S5 still needs full native retain/rollback acceptance and a fresh independent
  critic. Do not relabel VM adapters, inert pixels, UI screenshots or doubles.

See `/Users/devgwardo/hermes-desk/docs/self-editing-delivery-2026-10-13.md`
and `/Users/devgwardo/hermes-desk/docs/plans/2026-10-13-self-editing-genui-completion.md`
for the narrowed rules, exact logs, matrix and remaining gates.

### 2026-10-13 renewed audit repair continuation

Original work/inventory preserved at
`/tmp/hd-selfedit-20261013-repair-baseline-fa5MwH/`. Reproduced red suite:
`/tmp/hd-selfedit-20261013-audit-red.log` (10/18 failed).

Repaired copied-only runtime dispatch with copied framework/helper identity
fences, hash/PID observations and override refusal; filtered credential/data
names before working/committed bytes and review blob requests while retaining
genuine protected auth/security source; fixed real default lsof exit1/stdout
handling with exact owned fd/dev/inode/path lock allowance and unknown-evidence
refusal. No self-PID blanket exemption, consumer killing or weaker sandbox.

Integrated owned target consumer receipts, exclusive leases and trusted pending
work into external health, accepted-version foreground consumption and dead
native-health recovery. Bound actual protected-host code/version and physical
ASAR archive attestation; staged identical physical helpers for external Node.
Candidate code gets no work/lease authority or new generic bridge.

**434 tests / 16 suites**, renderer/Electron types, **273 Node syntax files**,
build and whitespace pass:
`/tmp/hd-selfedit-20261013-repair-contracts-stable.log`,
`/tmp/hd-selfedit-20261013-repair-lint-stable.log`,
`/tmp/hd-selfedit-20261013-repair-build-stable.log`.
Actual OS-sandboxed Electron fixed-trusted owned consumer/ASAR fixture passes:
`/private/tmp/hd-selfedit-owned-consumer-MXQDeU/report.json`.
This verifies consumption/lease/idle/pending-work and physical host/helper
integration, **not generated-candidate qualification or artifact approval**.

Repaired copied native dispatch still default-denies with SIGABRT, empty stderr,
no acknowledgment/grant:
`/private/tmp/hd-selfedit-2026-10-13-native-qTHMtD/report.json`,
`/private/tmp/hd-selfedit-2026-10-13-native-qTHMtD/native/launch.json`.
Both repaired retries aborted; no owned qualifier/helper remained. Copied
runtime `b901c246042d1eb71ab0d098ca0331726b41eec8339ccc3ba8a0a46f9040577b`,
PID `21342`, artifact
`1aa9f5539510c29b10cb220eb3198495b3b533246ff14414ded881e6510a3743`.
Parent's renderer-route-v4 investigative result is SIGSEGV (-11), not acceptance.
No safe OS boundary or minimal additional entitlement is established. A usable,
provisioned disposable macOS isolation environment (not just QEMU without an
image) or independently proven safe Seatbelt bootstrap is still needed for S1
and the real native failure matrix. No live original was overwritten/restarted,
no credentials/private chats/providers/install/publication, no critic runs or
old-loop restart.

Stable 54-file source inventory:
`/tmp/hd-selfedit-20261013-repair-owned-manifest.json`,
`ba883359f1772af8313202e580e5061fae282b82a1e4b4f54214cf2aa2f212d9`.
Parent must obtain fresh independent acceptance against that inventory.
Full repair/evidence details are in the existing delivery document above.

### 2026-10-13 Native Integration Phase1 — fixed trusted code only

Latest authority: parent released Phase1 only after conditional mechanism critic
`ea13d74a`; no generated candidate/plugin, new critic or self-approval. Production
native qualification is closed before source access. Loop `949fc147` stays stopped.

Genuine copied main/preload/controller now have distinct no-backend startup and
passive read-only registration without recovery, pre-import native alias guards,
document-start locked native surfaces, acknowledged chooser interception,
manifest-only broker, actual PID/window/creation binding and isolated observer
over a private CLOEXEC channel. Inert bootstrap and external live kernel proof
precede one-shot fixed negative HTML release. Exact Browser PID Mach rendezvous
replaces numeric wildcarding. RootDomain is a class grant, NOT method confinement:
immutable trusted Electron notification/fixed power acknowledgment only; no
power/sleep/wake experiment or candidate native delegate.

Fixed-only raw run:
`/private/tmp/hd-native-phase1-fixed-VuqdnZ/run/report.json`.
Failure null; Browser `62047`/Renderer `62048`, effective sandbox metrics and
kernel/creation/protected reads/full frozen graph mutation/rendezvous/private FD
denial proof; actual Renderer `--enable-sandbox --seatbelt-client=49`; in-main
network/GPU thread sample; consequential genuine negatives; unchanged interrupted
journal; three observations and clean exit0.
`nativeQualification:false`, `artifactApproved:false`, `fullAppQualified:false`.
External `/private/tmp/hd-native-phase1-fixed-VuqdnZ/run/cleanup.json` records
zero remaining owned helpers. Earlier failed fixed runs remain failed evidence.

63-file final manifest/delta:
`/tmp/hd-native-phase1-owned-manifest-20261013.json`,
`d539c34ed880ded123fd6d3a6b2df682134e882a9c19d192cbb8c6ad26475bff`;
frozen copy `/tmp/hd-native-phase1-owned-sources-LlvX8z/`.
Baseline `/tmp/hd-selfedit-phase1-baseline-AkBYhH/` remains preserved. Eight new
Phase1 files/four changed repaired entries plus shared main integration; main
was outside the old inventory, and only conditional native additions are owned.
464 tests/19 suites, types, 281 syntax files, build/whitespace pass:
`/tmp/hd-phase1-final-all-contracts.log`,
`/tmp/hd-phase1-final-lint.log`, `/tmp/hd-phase1-final-build.log`.

S1 and candidate-ready acceptance remain blocked. NEW independent integrated
source/authority critic and explicit parent Phase2 release are required before
generated execution, qualification/approval or native lifecycle e2e. No claim of
hard aggregate memory/disk caps, complete future adversarial alias coverage,
native plugin isolation, signing or live-data compatibility. Detailed guard,
delta, raw proof and missing gates are in the existing delivery document.

### 2026-10-13 focused Phase1 repairs after independent critic ffb1b47d

Phase2 remains CLOSED; S1/product completion remain blocked. Five independently
red defects repaired: permanently latched all-phase/shutdown failure with 45s/3s
deadlines and identity-only cleanup; strict nested kernel/query/asset/receipt/
metric/context consumers; shared public strict startup health; legacy v1
readable-but-nonactionable plus unconditional production authority gate; durable
one-attempt recovery/unknown slot (300s deadline, max200 admissions) and sealed
content-key worker reuse (max2 retained copies). Historical data stays unchanged.

Before/delta-after inventory and source copies:
`/tmp/hd-native-focused-repairs-JRMhwW/{before.json,before/,after.json,after/}`.
69 final owned files; main and A/preview-owner sources unchanged. Literal old
fixture remains default; current synthetic fixtures opt in, use genuine VM-loaded
implementations, and never provide a production enabling switch.

Valid old-source shutdown red and current late-phase synthetic green:
`valid-shutdown-baseline-red.json`, `valid-shutdown-final-green.json` under that
root. The unchanged legacy reproduction (output/TMPDIR only rewritten) retains
old policy/missing fields and now refuses review. Parent/critic raw data untouched.
524 tests/20 suites, types, 287 syntax files, build/whitespace pass in
`accepted-final-{all-contracts,lint,build,whitespace}.log`.

Fixed trusted report:
`/private/tmp/hd-native-phase1-fixed-otOlnf/run/report.json`.
Browser64759/Renderer64779, three observations, exit0/failure null, 15 before-OS
known-surface refusals including prototype counterfeit, all six authority/
execution flags false. 39 copied native files exactly match current owned
source; 34,655 graph paths/136 batches. External `run/cleanup.json`: no known or
scoped child remaining. Original default userData/source policy-only queries
deny without private contents access or private path names in query records.

Partial matrix only: no complete Range/adopt/insertion/cross-realm or native
prototype alias confinement, no RootDomain method confinement, no actual power
experiment/delegate/plugin, no aggregate RAM/disk cap, signing/live-data or
generated-native retain/rollback acceptance. No provider/download/live write,
grant, approval, activation, critic launch or loop restart. Required next:
parent rerun, NEW independent integrated critic against after.json, then explicit
parent Phase2 release. Detailed exact controls/evidence/limits are appended to
`docs/self-editing-delivery-2026-10-13.md`.

## Integrated critic repairs — 2026-10-13; Phase2 CLOSED

Evidence `/private/tmp/hd-native-integrated-repairs-iksZ7Z/`: separate exact
before/after sources/delta, final raw unchanged repros (evidence literal only).
Closed direct recovery/worker gates before filesystem authority; future VM-only
admission checks current transactionv2/proof/journal/target/nonce/artifact/
consumer bindings. Rollback checks previous bytes and original root/tree/file
identities before/after restoration and terminal/release; uncertain locks and
valuable/rejected bytes retained. Terminal version acknowledgment must match.
Genuine installed frame event cancellation now covers both supported forms and
bound canonical mainframe controls, with page navigation always denied.

Marked preload37.10.3 now seals controls/dialog/FSA/clipboard/media/wake/
credentials/WebAuthn/permissions/PiP/fullscreen and parser/namespace/template/
shadow/Range/insertion/adopt/import/frame routes using captured brands and
intrinsics. Fixed trusted matrix proves reflected guards/actual absence,
protected counters, ordinary DOM, installed permissions and 20 private genuine
detached-frame insertion refusals, without delegating originals. Normal preload
tail/main/dependency identities unchanged.

551 tests/21 suites, forced types, configured app/Electron types, 289 syntax,
build/whitespace pass. Final native:
`/private/tmp/hd-native-phase1-fixed-OQisuY/run/report.json`;
Browser15529/Renderer15532; three observations, exit0/failure null; inventory84
(79 guarded/five absent), 126 routes, four DOM/four permission controls; all six
authority/execution flags false. 40 exact copied owned sources, 34,656 graph
paths/136 batches, independent cleanup no children. Earlier Dsm9eu is nonfinal.

No generated acceptance/full lifecycle, RootDomain method confinement,
aggregate RAM/disk, signing/live-data or native power/auth/UI experiment claim.
No G polling/editing or global integration-stability claim; automation949fc147
still stopped. Parent fresh rerun and NEW independent integrated critic against
the 71-source after.json required; explicit parent Phase2 release remains later.

## Native-control default-action repair — 2026-10-13 (admission item 3)

Independent critic `e8e00e9f` (raw `/tmp/hd-readonly-admission-critic-Q91p/`)
refused admission item 3: the pointer/keyboard activation gate in
`electron/preload.cjs` could be bypassed three ways while leaving the native
default action uncancelled — a page `window` capture listener calling
`stopPropagation()`, a color control inside a `mode:'closed'` shadow root
(composedPath retargets to the host), and an `<input>` whose `type` is mutated to
`color` after the gate ran. Raw red: `control-event-result.json`.

Repair in `electron/preload.cjs` (guards only; normal preload tail/main/
dependency identities unchanged):
- Activation gate now registers first on `window` capture (precedes document
  capture and any later page capture listener), with document capture retained.
- `blockedControl` treats every `HTMLInputElement`/`HTMLSelectElement` as a
  potential control, because the native `type` can be mutated (type setter,
  `setAttribute`, parser) between an earlier check and the default action.
- The wrapped native `attachShadow` installs the same gate on every returned
  shadow root and records the host in a private `WeakMap`; the outermost pass
  denies activation retargeted to a tracked host whose private root still holds a
  control, so an ancestor capture listener can no longer starve the inner gate.
- Gate installation uses the captured `EventTarget.prototype.addEventListener`
  intrinsic, so a page replacing it before `attachShadow` cannot disable it.
- Parser `html()` now also refuses declarative `shadowrootmode` markup, whose
  closed root would otherwise be created without the wrapped `attachShadow`.

Regression `electron/self-modification-integrated-repairs.test.mjs` adds a
synthetic-JSDOM case covering all five denial routes plus two ordinary
non-control controls (light-DOM `div`, control-free open shadow `<p>`) that must
stay unprevented. `electron/self-modification-native-surface-probe.cjs` gained
five `actual-adversarial-*` routes (window-capture, closed-shadow,
closed-shadow-starved, replaced-addEventListener, type-mutation).

Fresh fixed-only native evidence:
`/private/tmp/hd-native-phase1-fixed-0QBVEh/run/report.json`; failure null,
exit0, three observations, inventory84 (79 guarded/five absent), 138 route
results incl. 10 `actual-adversarial-*` all `default-prevented-before-effect`,
four DOM/four permission controls; `preloadSha256
61a2059e43336965bcc078234bd35f0cf1bf51263a953335d8b5e10d1ddde08c` matches the
current `shasum -a 256 electron/preload.cjs`; all six authority/execution flags
false; no children remain. The critic's own repro
(`/tmp/hd-readonly-admission-critic-Q91p/control-event-repro.mjs`) now reports
`defaultPrevented:true, denials:1` for ordinary, intercepted, closed-shadow and
type-mutation routes.

Focused contracts 107 passed (`preload`, integrated, native-repairs,
native-phase1); full Electron project 1603 passed with the SAME six pre-existing
failures already present before this repair (`security-invariants` 4,
`hud-guards` 2 — all in `main.cjs` shape / `.cjs` `.debugger` scan, none reading
`preload.cjs`); unit 4269 passed; `npm run typecheck` and 289-file Node syntax
pass. No generated candidate, qualification, approval, activation, preview build
or live install was performed. Phase 2 remains CLOSED; a NEW independent
executable critic could not be run in this session (delegated subagents are
read-only and cannot execute commands), so the repair carries parent-verified
evidence only, not fresh independent acceptance.
