# Hermes Desk improvement loop — October 12, 2026

## Controls

- Status: **complete for the selected source-only acceptance bar**. Both
  scopes received fresh independent PASS verdicts after audit-driven retries.
  No recurring automation was created and no further pass is scheduled.
- User authorized creating and executing a substantial looping improvement
  prompt without questions. Execution is bounded to sequential session passes;
  no unattended automation or claim of perfection.
- Repository: `/Users/devgwardo/hermes-desk`.
- Prompt: `/Users/devgwardo/hermes-desk/docs/prompts/hermes-desk-improvement-loop-2026-10-12.md`
  (1,489 words).
- Orchestrator: parent agent; implementation adapter: native worker Task;
  acceptance audit: fresh read-only explorer/worker, not the implementer.
- Existing extensive dirty/untracked work is preserved. Review this pass
  against its session-start copies, not the repository-wide `HEAD` diff.
- First-pass ownership: the prompt, this ledger,
  `/Users/devgwardo/hermes-desk/src/components/ImproveHermesDesk.tsx` and
  `/Users/devgwardo/hermes-desk/src/components/ImproveHermesDesk.test.tsx`.
  No additional regression file was needed.
- `/Users/devgwardo/hermes-desk/docs/self-modification/STATE.md` is another
  workstream's ledger and remains untouched. Its Phases 4–7 and backend are
  outside this loop.
- No commits/pushes, app installs or user-app restarts, dependency installs,
  live sessions, paid inference, credential/private-chat access or unrelated
  edits. Native checks below start/restart only disposable fixture instances.

## Initial baseline — inherited evidence

The parent supplied these results; the implementer did not repeat the full run:

- `npm run lint`: passed, including syntax checks for 242 Node files.
- `npm run test:run`: 5,473 passing, one failing, 20 skipped, one todo and one
  expected failure.
- Full baseline log:
  `/tmp/hermes-desk-improvement-baseline-2026-10-12.log`.
- Sole failure:
  `/Users/devgwardo/hermes-desk/src/lib/__tests__/fill-token-usage.test.ts`
  identified white text on `--ca-primary` at
  `/Users/devgwardo/hermes-desk/src/components/ImproveHermesDesk.tsx:224`.
  Existing `--ca-primary-fill` is the supported solid fill.

Session-start copies of both owned existing files:

- `/tmp/hermes-desk-loop-pass1-baseline/ImproveHermesDesk.tsx`
- `/tmp/hermes-desk-loop-pass1-baseline/ImproveHermesDesk.test.tsx`

## Pass 1 — request-journal UX resilience

**Status:** initial fresh critic verdict **FAIL on J4**. Retry 1 reproduced and
repaired the finding. A different fresh read-only critic independently
reproduced the failures and returned **PASS** on J1–J5. See the acceptance
record below. Overall completion still depends on the room-recovery retry.

### Reproduced behavior

1. A manual read treated `selectedId === null` (New request) as a missing saved
   record and switched to the latest record. A pending initial read likewise
   replaced a draft. Text remained in component state, but its active editing
   view disappeared despite the user's explicit intent.
2. After a rejected/uncertain save, reopening cleared the error and replay
   block. A reopen read resolving after the pending save's rejection also
   enabled submission. Editing the retained draft must not bypass reconciliation.
3. A create acknowledgment arriving after navigation unconditionally selected
   the created record, stealing the currently selected saved record.
4. Routine polling raised loading/reload-required state and disabled Cancel
   while a read was pending. Two ticks before a React render could start
   overlapping reads, each fencing the previous reply.

### Implementation

- Distinguish initial restore selection (`undefined`) from an explicitly chosen
  draft (`null`). Selecting New or editing either draft field expresses that
  intent; manual reads, background reads and reopening retain it.
- Track selection ownership separately from async response ownership. A
  successful create still updates the journal and clears its acknowledged
  submitted draft, but does not override newer user navigation.
- Retain a mutation-reconciliation latch across reopening and background
  refresh. Uncertain/stale/storage failures and lost or stale acknowledgment
  block mutations until a successful explicit Reload requests action.
- Explicit reconciliation of an uncertain create shows the latest saved record
  for review when the draft is still selected and no newer selection occurred.
  Retained draft text is not cleared by reconciliation.
- Separate open/manual reads from background polling. Background reads do not
  advertise saving/loading or disable actions merely because they are in
  flight. The initial newest-read fence suppressed repeated ticks only without
  a superseding manual/open read; the independent critic exposed overlapping
  outstanding polls after supersession. Retry 1 separately tracks the actual
  outstanding poll until its promise settles. Mutations still invalidate older
  read responses. Poll failures retain records and disable journal actions
  until a successful reload.
- Apply `--ca-primary-fill` and `--ca-primary-fill-hover` to Save request.
  Expose New request's selected state using native `aria-current`.
- Retain every prior behavioral assertion. Restore timer spies after each
  regression test so one test cannot exercise a previous test's poll callback.

### Red/green evidence

All commands ran from `/Users/devgwardo/hermes-desk`, using existing local
dependencies and inert fake bridges:

```sh
npm run test:unit -- src/components/ImproveHermesDesk.test.tsx src/lib/__tests__/fill-token-usage.test.ts
```

- First red: 10 failed, 16 passed; one failure came from a timer-spy fixture
  leaking between tests. Log: `/tmp/hermes-desk-loop-pass1-red.log`.
- Corrected-fixture red against unchanged component: **nine failed, 17 passed**
  across two files. Eight new behavioral cases failed for their intended
  reasons; the existing fill-token failure remained. A new poll-error
  fail-closed guard already passed before the fix.
  Log: `/tmp/hermes-desk-loop-pass1-red-confirmed.log`.

Strengthening the initial-read regression to type directly into the visible
draft, without clicking New first, exposed a remaining race after the initial
fix:

```sh
npm run test:unit -- src/components/ImproveHermesDesk.test.tsx -t 'does not replace a new draft'
```

- **One failed, 22 filtered/skipped**, because the late read hid the edited
  form. Log: `/tmp/hermes-desk-loop-pass1-draft-edit-red.log`.
- Marking edits as explicit draft selection resolved this race.

Final focused command:

```sh
npm run test:unit -- src/components/ImproveHermesDesk.test.tsx src/components/SourcePreparation.test.tsx src/components/CandidateImplementation.test.tsx src/components/CandidateValidation.test.tsx src/lib/__tests__/fill-token-usage.test.ts
```

- **58 passed, five files passed**: journal 23, source preparation seven,
  candidate implementation six, candidate validation 19, fill-token scan three.
- Initial focused green:
  `/tmp/hermes-desk-loop-pass1-green.log`.
- Final focused green after direct-typing repair:
  `/tmp/hermes-desk-loop-pass1-green-final.log`.

Required checks:

- `npm run lint` returned **exit 2**, with unrelated errors in
  `/Users/devgwardo/hermes-desk/src/lib/agents/local-room-runner.test.ts`:
  TS2322 at lines 198, 221 and 269, plus TS6133 at line 269.
  Log: `/tmp/hermes-desk-loop-pass1-lint.log`.
- A repeat still returned **exit 2** and additionally reported TS2322 at
  lines 293 and 331 of that same unowned file. No errors in this pass's owned
  files were reported. The implementer did not modify the unowned test.
  Log: `/tmp/hermes-desk-loop-pass1-lint-final.log`.
- `npm run check:node` independently passed: **242 Node JavaScript files**,
  syntax only. Log: `/tmp/hermes-desk-loop-pass1-node.log`.
- Session-only added-line whitespace/final-newline verification passed for all
  four owned files, comparing existing files to their `/tmp` copies.
  Log: `/tmp/hermes-desk-loop-pass1-whitespace-final.log`.
- Full suites, renderer build, native/packaged acceptance and performance
  measurement were not rerun by this worker. Parent should reconcile the
  concurrent typecheck blocker before broader validation.

### Criteria-to-evidence map — observations, not independent approval

| Criterion | Behavioral evidence |
| --- | --- |
| J1: preserve draft and acceptance criteria | New → two saved records → New; deferred manual reload; close/reopen with existing records; direct typing before the initial reply |
| J2: block uncertain replay; explicit reload reconciles | Rejected and structured-uncertain saves remain blocked after reopening; edited drafts plus direct form submission do not create again; late reopen read cannot clear a rejection; explicit reload shows saved outcome without clearing retained draft |
| J3: isolate late responses from newer view/outcome | Create reply after record navigation retains the selected record; existing close/reopen stale-load and stale-save fences remain green; deferred poll after Cancel cannot restore pre-cancel state |
| J4: truthful, bounded background refresh | Initial audit failed supersession coverage. Retry 1 adds manual-reload and close/reopen cases, each with stale success/rejection: repeated supersession cannot admit another poll until the original settles; polling then resumes without stale UI writes. Prior nonblocking/error-recovery cases remain green. Fresh retry audit passed. |
| J5: supported fill-token contrast | Existing three-test source scan passes after switching the Save control to the verified solid-fill and hover tokens |
| Preserve existing safety boundaries | All 14 original journal cases remain green; bridge create/cancel/reopen counts verify no implicit work; 32 related source/candidate behavior cases remain green |

### Remaining risks and follow-up

- Initial independent review failed J4; it reported no actionable findings for
  J1/J2/J3/J5. A different fresh critic subsequently passed the retry, as
  recorded below. The implementer did not accept its own repair.
- Earlier external lint errors above are historical. Parent reported integrated
  lint/full tests/build now passing; this worker independently reran lint
  successfully after the retry without editing the unowned room files.
- Evidence is React/jsdom and fake bridge behavior, not native IPC durability,
  packaged focus/accessibility, live-provider execution or production
  performance. The fill scan is a static token guard, not a new screenshot
  contrast measurement.
- Unknown acknowledgments remain intentionally conservative. Explicit reload
  reconciles only after the pending mutation settles; no automatic replay is
  introduced. Draft retention here is component-lifetime retention, not
  persistence across complete app/process teardown.
- The outstanding-poll supersession candidate produced the J4 audit finding
  addressed below. No further implementation candidate is started in this
  retry; independent retry audit comes next. Backend qualification and the
  interrupted self-modification phases remain outside scope.

## Pass 1 — failed audit and retry 1

### Independent finding and reproduced failure

- Critic verdict supplied by the parent: **FAIL on J4**. A poll stayed pending
  while a manual reload or close/reopen superseded its response. The newer
  read overwrote/cleared `readOwner`, so a later tick admitted another poll
  before the first promise settled. Response fencing did not bound actual
  outstanding background calls.
- The initial overlap claim above was too broad and is corrected. J1/J2/J3/J5
  had no actionable critic findings; this retry changes only J4 accounting.
- New retry-start copies preserve the earlier baseline unchanged:
  `/tmp/hermes-desk-loop-pass1-retry1-baseline/ImproveHermesDesk.tsx`,
  `/tmp/hermes-desk-loop-pass1-retry1-baseline/ImproveHermesDesk.test.tsx` and
  `/tmp/hermes-desk-loop-pass1-retry1-baseline/hermes-desk-improvement-loop-2026-10-12.md`.

### Narrow repair and evidence

- Add `pollOutstanding`, distinct from newest-read/response ownership. Set it
  before a background read and clear it only in that poll's `finally`, whether
  its result is current, stale, resolved or rejected. Superseding manual/open
  reads and closing do not clear it. Manual/open reads remain permitted;
  additional background polls remain blocked until actual settlement.
- Add four behavioral regressions: manual reload and close/reopen, each with
  stale poll success and rejection. They repeat supersession before settlement,
  verify no new poll, then settle the stale promise and verify polling resumes.
  Stale responses do not replace newer records or display stale errors;
  Cancel remains usable, and no journal mutation is issued.
- Red command:
  `npm run test:unit -- src/components/ImproveHermesDesk.test.tsx src/lib/__tests__/fill-token-usage.test.ts`.
  **Four failed, 26 passed**. Every new case failed with expected three list
  calls but observed four after the superseding read.
  Log: `/tmp/hermes-desk-loop-pass1-retry1-red.log`.
- Green command: the same five-suite focused command shown above.
  **62 passed, five files passed**: journal 27, source preparation seven,
  candidate implementation six, candidate validation 19 and fill-token three.
  Log: `/tmp/hermes-desk-loop-pass1-retry1-green.log`.
- `npm run lint`: **passed**, including required TypeScript checks and syntax
  checks for **242 Node files**.
  Log: `/tmp/hermes-desk-loop-pass1-retry1-lint.log`.
- Direct comparison confirms all 14 original journal test bodies/assertions
  and all 23 pre-retry journal cases remain unchanged; four cases were appended.
- No full-suite/build/native/live acceptance was rerun by this worker in this
  retry. Fresh independent retry audit remains required.

## Pass 1 — independent retry acceptance

- Fresh read-only audit: **PASS on J1–J5**, with no actionable deficiencies
  in the session-owned journal patch.
- Independently ran the five focused suites: **62 passed**.
- Independently substituted the original component in memory: **eight
  behavioral failures, 15 passed**, with the four retry cases filtered.
  Substituting the retry baseline produced **four failures, 23 passed**,
  each observing four list calls instead of three before the original poll
  settled. No repository source was changed by the reviewer.
- Four additional in-memory permutations passed: stale poll success/rejection
  after a lost save acknowledgment, reopen after stale creation completion,
  and editing during explicit reconciliation.
- Direct comparison confirmed all 14 original and 23 pre-retry test
  bodies/assertions remain unchanged.
- Actual App mounting retains this component after its first opening, which
  supports the component-lifetime draft and reconciliation latch. This does
  not make either durable across renderer/process teardown.
- Integration smoothing found no cross-scope conflict with the room changes
  or the reusable prompt. It did not replace the separate per-room audit.

## Pass 2 — durable room dispatch

**Status:** initial independent audit **FAIL** on two reentrant-recovery races.
Retry 1 reproduced and repaired both. Focused, full integrated and native room
checks passed, and a different fresh critic independently confirmed both
recovery corrections. Retry 2 repaired a pre-existing publication-time
membership/deletion gap. Its fresh audit confirmed those boundaries but
returned **FAIL** on overlapping membership/Stop interruption. Retry 3 has
repaired that finding; a different fresh critic returned **PASS** on the
integrated owned room delta.

### Scope and first implementation evidence

- Owned files: `src/lib/agents/local-room-runner.ts`,
  `src/lib/agents/local-room-runner.test.ts`, and
  `src/lib/agents/hermes-local-transport.test.ts`.
- Session-start copies: `/tmp/hermes-desk-loop-pass2-baseline/`.
  `local-room-repository.ts` was not changed.
- First implementation checkpoints running claims before session creation
  or resume, retains refused binding/submission claims as queued work, checks
  actual room journals at completion/Stop/membership changes, and conservatively
  pauses dispatch until explicit durable recovery.
- Red against the preserved session-start runner: **16 intended failures,
  252 passed**, comprising 13 runner and three real transport/storage failures.
  Log: `/tmp/hermes-desk-loop-pass2-red-session-start-final.log`.
- Six relevant suites: **324 passed**.
  Log: `/tmp/hermes-desk-loop-pass2-green-final.log`.
- Full unit suite: **4,171 passed**, one expected failure, 18 skipped, one todo.
  Log: `/tmp/hermes-desk-loop-pass2-unit-full.log`.
- Required lint and whitespace checks passed:
  `/tmp/hermes-desk-loop-pass2-lint-final.log`,
  `/tmp/hermes-desk-loop-pass2-whitespace.log`.

### Failed independent audit and retry criteria

The reviewer reproduced both issues using the actual repository/store/native
persistence adapter with an in-memory bridge, without writing files:

1. **Duplicate dispatch after a reclaimed claim.** Refuse only the first
   Alpha-binding checkpoint. A synchronous subscriber starts forced recovery
   when claim release publishes the queued turn. Hold the new resume, fire the
   liveness callback, then resolve it. The old start's cleanup deletes the
   replacement marker because both use the same retry-attempt count. Two
   `prompt.submit` calls execute for one recorded human message and turn.
   The retry must give dispatch instances separate ownership and fence obsolete
   callbacks from clearing or submitting replacement work.
2. **Lost recovery wake.** Refuse that same binding checkpoint and schedule
   forced recovery from the binding-publication subscriber in a microtask.
   Recovery wakes before the rejected bind releases its running claim. The
   subsequent release queues work but does not wake it; ordinary recovery then
   exits through the recovered cache. The retry must retain a successful
   recovery wake until eligible work can dispatch exactly once.

Neither all-green suites nor the native checks below override this failed
audit. The correction must retain durability, no uncertain-intent replay,
cancellation, token-budget, membership, profile/session and disposal fences.

### Retry 1 — dispatch ownership and retained recovery wake

- Changed only the runner and its runner test. The repository and transport
  test remained unchanged during this retry. Original session-start copies
  remain intact; retry copies are in
  `/tmp/hermes-desk-loop-pass2-retry1-baseline/`.
- Dispatch instances now have distinct runtime ownership, registered before
  synchronous publication. Binding/start callbacks and cleanup respect that
  ownership independently of the persisted retry-attempt count.
- Cleanup preserves the recovery wake when a refused claim becomes queued.
  The durability pause still blocks automatic retries. Runtime ownership is
  not a replacement for durable submission intent or crash reconciliation.
- Both new regressions use the actual repository, synchronous store
  subscriptions and native-persistence adapter with an in-memory bridge.
  Red: **two failed, 36 passed**. The first produced two submissions for one
  turn; the second produced zero submissions and stranded queued work.
  Log: `/tmp/hermes-desk-loop-pass2-retry1-red.log`.
- Runner green: **38 passed**. Both reproductions now submit exactly once.
  Log: `/tmp/hermes-desk-loop-pass2-retry1-green-runner.log`.
- Six room suites: **326 passed**.
  Log: `/tmp/hermes-desk-loop-pass2-retry1-green-rooms.log`.
- Required lint and whitespace checks passed:
  `/tmp/hermes-desk-loop-pass2-retry1-lint.log`,
  `/tmp/hermes-desk-loop-pass2-retry1-whitespace.log`.
- All previous regression assertions remain intact. Independent acceptance
  remains a separate gate, not the implementer's verdict.

### Retry 1 audit — recovery passed; membership gap remains

- Fresh reviewer independently ran eight narrow suites: **360 tests passed**.
- Both required recovery races independently produced exactly one submission,
  one human message and one recorded turn, with unchanged retry history.
  The held replacement retained its start/binding ownership through liveness;
  the microtask recovery no longer stranded queued work.
- Additional claim/submission checkpoint permutations passed. No cross-feature
  journal conflict or automatic room execution was found.
- Overall verdict remained **FAIL on criterion 4**: a synchronous store
  subscriber removes Alpha via the public `setGroupMembers` during claim or
  binding publication. The `publishing` guard drops the membership notification
  without reconciling afterward. The persisted roster is empty, but the engine
  remains Alpha/running and submits a prompt to the removed member.
- This reproduced against current source and both prior baselines. It is a
  pre-existing acceptance gap, not a regression caused by this loop.
- Retry 2 must cancel removed-member work and prevent prompt submission at
  both timings; removal during claim publication must also prevent session
  creation. Preserve all verified ownership, recovery and durability fences.
  Check coherent room deletion and nested-publication behavior where affected.

### Retry 2 — publication-time membership and deletion

- Changed only the runner and its runner test. Original and retry 1 copies
  remain untouched; retry 2 copies are in
  `/tmp/hermes-desk-loop-pass2-retry2-baseline/`.
- Retain suppressed membership notifications and drain them after the outermost
  publication, before dispatch continues. Guard nested reconciliation against
  self-notification loops and suppress captured output for deleted rooms or
  cancelled streaming turns.
- Actual repository/store/native-adapter regressions use public
  `setGroupMembers` and `deleteConversation`.
- Red against the retry 2 baseline: **seven failed, 38 passed**. Removal during
  claim/binding publication still dispatched Alpha work; deletion left orphan
  queued work or emitted output for a deleted room.
  Log: `/tmp/hermes-desk-loop-pass2-retry2-red-final.log`.
- Six relevant suites: **333 passed**.
  Log: `/tmp/hermes-desk-loop-pass2-retry2-green-rooms.log`.
- Claim removal now creates no session; binding removal submits no prompt,
  quarantines the binding and interrupts once. Accepted human/root/turn
  history and attempt counts remain intact.
- Nested cancellation followed by deletion settles without resurrection or
  duplicate interruption. Both recovery-race regressions remain green.
- Required lint and whitespace checks passed:
  `/tmp/hermes-desk-loop-pass2-retry2-lint.log`,
  `/tmp/hermes-desk-loop-pass2-retry2-whitespace.log`.
- Trade-off: publication synchronously reads cached room rosters to close the
  dispatch window. No startup or performance improvement is claimed.
- A different fresh reviewer is checking this corrected candidate. These
  implementation observations are not an independent acceptance verdict.

### Retry 2 audit — membership passed; nested Stop overlap remains

- Fresh audit confirmed removal during claim creates zero sessions, removal
  during binding submits zero prompts, deletion suppresses captured output,
  and nested membership/deletion settles with one interruption.
- Criteria 1–3 and the recorded red/green evidence remained supported.
  No additional journal/room integration defect was found.
- Overall verdict: **FAIL on criterion 4**. An active Alpha turn publishes a
  partial; a synchronous subscriber removes Alpha. During cancellation
  publication another subscriber calls `runner.stop()`. The quarantined turn
  is selected twice, issuing two `session.interrupt` calls before either
  acknowledgment settles.
- Retry 3 must coalesce in-flight interruption ownership across publication
  reentrancy. This must not suppress a supported later explicit retry after
  the prior interruption was refused or rejected.
- The reviewer clarified that
  `/tmp/hermes-desk-loop-pass2-retry2-green-runner.log` is an intermediate
  43/44 run with a subsequently corrected new fixture expectation.
  The final six-suite 333-pass result, current tests and final3 integrated
  checks are the green evidence, not that intermediate artifact.

### Retry 3 — execution-scoped interruption coalescing

- Changed only the runner and its test. Retry 3 copies are in
  `/tmp/hermes-desk-loop-pass2-retry3-baseline/`; earlier copies remain intact.
- Reserve interruption ownership before synchronous I/O. Nested/concurrent
  Stop calls for the same execution share the actual pending acknowledgment.
  Remove ownership on settlement so refusal/rejection permits a later
  explicit retry. Keep different executions on a reused session distinct.
- Initial red: **four failed, 46 passed**, reproducing two interrupts in the
  membership/nested-Stop chain and three with another concurrent Stop.
  Log: `/tmp/hermes-desk-loop-pass2-retry3-red.log`.
- An additional regression caught over-coalescing across different executions:
  **one failed, 50 passed**. The repair scopes ownership to execution, not
  merely the reusable session.
  Log: `/tmp/hermes-desk-loop-pass2-retry3-red-execution-ownership.log`.
- Final six-suite green: **339 passed**.
  Log: `/tmp/hermes-desk-loop-pass2-retry3-green-rooms-final.log`.
- Native-adapter tests exercise pending accepted/refused/rejected outcomes,
  fresh RPC after settled refusal/rejection, disposal without stale
  publication, and preserved history/quarantine/recovery.
- Required lint and whitespace checks passed:
  `/tmp/hermes-desk-loop-pass2-retry3-lint-final.log`,
  `/tmp/hermes-desk-loop-pass2-retry3-whitespace-final.log`.
- Intermediate artifacts without a final suffix are retained as history,
  not substitutes for this final evidence.
- No protocol/schema change; quarantine is not cleared merely because
  callers share an in-flight request.

### Final independent room acceptance

- Verdict: **PASS**, with no actionable acceptance findings in the owned room
  delta. The reviewer traced the integrated engine/repository/store/persistence,
  transport and public UI callers, not unrelated dirty `HEAD` work.
- Independent memory-only reproduction against retry 3 baseline issued three
  interrupts for nested membership cancellation plus concurrent Stop.
  Current source issued one, with callers pending until acknowledgment.
- Accepted/refused/rejected outcomes returned `[true, true]`, `[false, false]`
  and `[false, false]` respectively. Liveness did not duplicate the request;
  an explicit Stop after refusal/rejection issued a fresh second request.
- Different executions on one reused session issued two distinct interrupts
  and correctly returned mixed acknowledgments `[false, true]`.
- The reviewer verified original assertion preservation, insert-only
  transport-test changes, 339 focused passes and the completed final4
  type/syntax, full-suite, build and E2E logs.
- No further scoped source fix was requested. Final integration tracing found
  no journal/room authority or lifecycle conflict.

## Parent validation chronology

These are direct parent-run checks. They do not establish signed-packaged or
live-provider acceptance, and earlier results cannot certify later source.

| Candidate / check | Result and evidence |
| --- | --- |
| Early isolated E2E, while implementation was progressing | **17 passed**, nine files; `/tmp/hermes-desk-loop-native-e2e-2026-10-12.log`. Interim evidence only. |
| Shared modal keyboard regression | Both skins at 960×640 and 1440×900 passed; zero page errors or render-loop warnings; `/tmp/hermes-desk-loop-modal-acceptance-2026-10-12.log`. |
| Development renderer stress | Twelve replies, three reloads and 24 chat switches passed with zero render-loop warnings; `/tmp/hermes-desk-loop-runtime-dev-2026-10-12.log`. |
| Native journal before J4 retry | **Seven checks passed**, zero page errors and zero model dispatches; `tests/e2e/artifacts/improvement-loop-journal-1791840437334/report.json`. |
| First native journal fixture attempt | Search locator expected textbox instead of the actual combobox; timeout before any journal checks. `tests/e2e/artifacts/improvement-loop-journal-1791840339967/report.json`. Corrected the fixture, not app source. |
| Both first implementations, before J4 retry | Required lint, **5,501 tests**, build and whitespace checks passed; `/tmp/hermes-desk-loop-final-{lint,tests,build}-2026-10-12.log`. |
| First room implementation, before room retry | **11 native room checks passed**, including delegation, Stop, approvals, changed-origin persistence, backend crashes and budgets; `tests/e2e/artifacts/local-rooms-1791840665734/report.json`. |
| J4 retry plus first room implementation, before room retry | Required lint, **5,505 tests**, build and whitespace checks passed; `/tmp/hermes-desk-loop-accepted-{lint,tests,build}-2026-10-12.log`. The filename is not an acceptance verdict; the room audit still failed. |
| Recovery retry, before membership/deletion correction | Required lint, **5,507 tests**, production build and whitespace checks passed; `/tmp/hermes-desk-loop-final2-{lint,tests,build}-2026-10-12.log`. |
| Recovery retry, before membership/deletion correction | **11 native room checks passed**, zero model/renderer errors; `tests/e2e/artifacts/local-rooms-1791841690268/report.json`; `/tmp/hermes-desk-loop-final2-rooms-2026-10-12.log`. |
| Membership/deletion correction, pending fresh acceptance | Required lint, **5,514 tests**, production build and whitespace checks passed; `/tmp/hermes-desk-loop-final3-{lint,tests,build}-2026-10-12.log`. |
| Membership/deletion correction, pending fresh acceptance | **11 native room checks passed**, zero model/renderer errors; `tests/e2e/artifacts/local-rooms-1791842800896/report.json`; `/tmp/hermes-desk-loop-final3-rooms-2026-10-12.log`. |
| Final source, subsequently accepted by fresh critic | Required lint, **5,520 tests**, production build and owned-patch whitespace checks passed; `/tmp/hermes-desk-loop-final4-{lint,tests,build}-2026-10-12.log`. |
| Final source, subsequently accepted by fresh critic | **17 E2E tests passed**, including 11 native room checks, golden path and temporary-profile model follow; `/tmp/hermes-desk-loop-final4-e2e-2026-10-12.log`; native report `tests/e2e/artifacts/local-rooms-1791843921370/report.json`. |

The full integrated runs each have seven skipped files, 20 skipped tests,
one expected failure and one todo. Required lint checks TypeScript and 242 Node
JavaScript files for syntax. Existing theme-script, mixed-import and large-chunk
build warnings remain. No performance improvement is claimed.

Native fixtures use isolated HOME/userData and loopback fake inference.
The journal fixture verified inert creation, draft preservation across explicit
reload and close/reopen, distinct cancellation/reopen history, and persistence
through renderer reload. Its report does not verify the later polling retry's
native active-operation path.

## Final outcome and retained limitations

- Created the reusable 1,489-word prompt and executed two independently owned
  improvement scopes, with one journal retry and three room retries driven
  by fresh critics. Four failed audit verdicts were repaired rather than
  overridden by passing tests.
- Fixed draft/view preservation, uncertain-save replay blocking, late-response
  ownership, nonblocking bounded polling and the failing contrast guard.
- Enforced durable room dispatch; fixed replacement-dispatch/lost-wake races,
  publication-time member removal/deletion, stale captured output and
  execution-scoped concurrent interruption acknowledgments.
- Added **46 test cases** relative to the captured initial suite, preserved
  existing assertions, and repaired its one inherited contrast failure.
  Final full suite: **5,520 passed**, 503 passed files, with the unchanged
  skipped/expected-failure/todo boundaries above.
- Full E2E: **17 passed**, nine files. Required lint/types, 242 Node syntax
  checks, production renderer build and all seven session-owned whitespace
  diffs passed. No validation failure remains in the selected bar.
- Five existing code/test files have session-owned deltas; two new documents
  are the prompt and this ledger. Existing tracked/untracked work was retained,
  with exact starting copies for ownership review.
- Durability failure conservatively pauses a room until supported explicit
  recovery/new-send. A crash before a new binding is durable can leave an
  unused backend session, without a submitted prompt. Completion recovery
  after total storage failure still depends on retained backend replay.
- Unsaved drafts and unknown-acknowledgment latches are component-lifetime
  state, not durable across renderer/process teardown. The latest active
  polling permutations were independently tested with disposable adapters;
  no new signed-packaged active-poll qualification is claimed.
- No live-provider, signed-package, startup/performance, coverage-floor or
  public-release approval is implied. Existing build warnings, skipped tests,
  expected failure and todo remain. Licensing/privacy release gates and the
  other workstream's self-modification phases remain outside scope.
- No commit, publication, app installation, user-app restart, dependency
  installation, paid inference or live-profile change occurred. Further such
  actions are not automatic follow-through.

### Validated source fingerprints

SHA-256 after final4 validation and before the read-only acceptance verdict:

```text
2be0b96cb6ebb6a35dc45440e224ccea5d2d0bed71f2c306f7ec2a256620708f  src/components/ImproveHermesDesk.tsx
174ded364379a6da005ff02688092c46fe0c3d3dae1d6cf26b9128935eda332e  src/components/ImproveHermesDesk.test.tsx
31c9938cdf56a78dd036f8644ef3444a8bb71831bdc7ccb2daf2b0ff9bce3a77  src/lib/agents/local-room-runner.ts
e46c113ca5b01cbe61d241177fa8fbf44071e10f42a66324b6de178998fae64d  src/lib/agents/local-room-runner.test.ts
9b4482bc5022103c3e9c09b386aa0ea14d170bba909c61b7710144d4aa5ecc4d  src/lib/agents/hermes-local-transport.test.ts
```
