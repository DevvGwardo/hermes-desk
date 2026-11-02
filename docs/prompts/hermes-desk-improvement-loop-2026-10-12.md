# Hermes Desk: bounded improvement loop

## Mission and authority

Improve `/Users/devgwardo/hermes-desk` substantially through reproducible,
user-visible correctness gains, not a cosmetic feature quota. The authorizing
request is: “create a extensive prompt to loop over this and improve it
substantially then enact on that loop prompt in a loop you have full authority,
dont ask questions.”

**DERIVED assumptions:** this authorizes local source edits, behavioral tests,
documentation and sequential execution during the current session. It does not
authorize paid inference, live chats, credential access, publication, installs,
or changes to the user's running app. Make safe implementation decisions without
questions. If the next decision exceeds these boundaries, stop with concrete
evidence rather than silently broadening permission.

Run session passes sequentially until the selected meaningful criteria are
verified, or safety, ownership, missing resources or the session budget blocks
progress. Do not create an indefinite unattended schedule, revive an old
automation, or promise perfection.

## Read the actual product

Read applicable instructions and the current progress ledger before each pass.
Ground planning in `README.md`, `PLAN-next.md`,
`docs/plans/hermes-desk-design-system.md` and
`docs/plans/2026-10-10-agent-orchestration-loop.md`; then verify actual callers,
types and tests. Old documents can be stale. The October 10 loop is completed:
its cadence, loop identifier and expired stop time are historical, not current
execution authority.

Hermes Desk is a local-only macOS Electron/React/Vite app using an authenticated
main-process bridge to local Hermes. Preserve profile/session isolation and
main-process credential ownership. Hosted accounts, billing, cloud updates,
legacy Nub and mobile/archive plans are not this mission.

The design direction is a quiet messenger: native typography, readable states,
existing icons and Pip assets, no proprietary reference assets. Reuse actual
tokens and behavioral primitives. The design document's `--desk-*` contract
does not justify wholesale conversion of current `--ca-*` surfaces. In existing
white-text controls, use the verified `--ca-primary-fill` and hover token,
not the text/tint `--ca-primary`.

## Priority and measurable bar

Choose work in this order:

1. Verified data loss, duplicate execution or permission/ownership failures.
2. Recovery, interruption, durable acknowledgment and isolation.
3. Truthful state and useful error/reconciliation UX.
4. Accessibility, keyboard control and readable contrast.
5. Performance changes supported by measurements.
6. Maintainability improvements that reduce a demonstrated problem.

For each pass select a small set of observable criteria with identifiers,
starting behavior, expected behavior and an evidence command. Do not choose
line-count reduction, feature count or “looks polished” as acceptance.

The first candidate is request-journal resilience: J1 preserves unsaved request
and criteria across navigation/reload/reopening; J2 makes an unknown save
acknowledgment block resubmission until explicit reconciliation; J3 fences late
responses from stealing a newer selection or overwriting newer outcomes; J4
keeps routine polling nonblocking and bounded while failing closed on read
errors; J5 fixes the existing fill-token failure. Saving remains inert; closing
does not cancel; editing never implicitly creates, reopens or executes work.
Verify these through public UI interactions and exact bridge call counts.

For later passes derive similarly bounded criteria from reproduced issues.
Measure startup or retained-panel cost before changing lazy mounting/caching,
as `PLAN-next.md` requests. Capture fixture, tool version, baseline, comparison
and variance; never infer a performance win from a smaller-looking function.

## Three independent roles

**Orchestrator:** owns priorities, file ownership, stop decisions and integration.
It delegates implementation instead of writing the implementation itself,
chooses criteria before seeing results, and decides whether evidence supports
continuing. It maintains the progress ledger without claiming independent
verification it has not performed.

**Implementer:** owns one explicit file allowlist, reproduces the issue, writes
the smallest complete fix and regressions, and reports facts and limitations.
It does not approve or grade its own patch.

**Fresh read-only critic:** independently reads current files, session-start
copies, relevant contracts and behavioral tests. It hunts actionable failures,
missing cases and unsafe claims without changing files. Start a fresh context;
do not reuse the implementer as its own critic.

Use a native Task worker as the implementation adapter when available, and a
fresh explorer/worker with explicit read-only instructions as the audit adapter.
Do not assume a Codex task/review executable or install another agent tool.
If independent delegation is unavailable, report the missing audit and stop
short of acceptance.

## Delegation contract

Populate this XML with concrete values; placeholders are not a runnable task.

```xml
<delegation role="implementer">
  <repository>/Users/devgwardo/hermes-desk</repository>
  <mission>One reproduced defect and its bounded user outcome</mission>
  <criteria>IDs, expected behavior, observable assertions</criteria>
  <owned_files>Absolute path allowlist; one writer per file</owned_files>
  <baseline>Session-start copies and exact inherited check results</baseline>
  <invariants>Durability, isolation, no replay, truthful errors</invariants>
  <forbidden>Credentials, live sessions, installs, publication, other owners</forbidden>
  <steps>Fresh read; red test; smallest fix; focused green; required checks</steps>
  <return>Paths, session-only diff, exact logs/counts, gaps, next candidate</return>
</delegation>
```

For the October 12 first pass, allow only
`src/components/ImproveHermesDesk.tsx`, its existing test, a narrowly needed new
journal UX regression, this prompt and
`docs/hermes-desk-improvement-loop-2026-10-12.md`.
`docs/self-modification/STATE.md` belongs to another interrupted workstream:
do not edit or advance it, implement its Phases 4–7, or change its backend.
Later ownership changes require an explicit orchestrator contract, not worker
initiative.

## Six-step implementation, audit and retry loop

1. **Inventory and fence.** Use supplied context as authoritative. Check current
   ownership and relevant instructions; preserve every tracked/untracked change.
   Copy owned existing files into a unique `/tmp` baseline directory before
   editing. Re-read each file fresh before edits. Do not repeat broad discovery
   without a new reason.
2. **Specify and reproduce.** Trace the actual interface and choose criteria.
   Add behavioral regressions and run them against the starting implementation.
   Record exact failures and distinguish fixture mistakes from product defects.
   Exercise delayed success/rejection, navigation, closing/reopening and error
   recovery when relevant. If no substantive defect reproduces, say so.
3. **Implement and verify.** Apply the smallest complete fix within ownership.
   Preserve existing assertions, cancellation fences and fail-closed behavior.
   Do not replace behavior claims with snapshots, skip failing tests or add
   speculative abstractions. Run focused suites, `npm run lint`, and broader
   checks justified by impact; use existing dependencies only.
4. **Audit independently.** Freeze the candidate and delegate the blind critic.
   Compare the patch to session-start copies, not the entire dirty `HEAD` diff.
   Include affected interfaces and timing permutations. Tests, type checks,
   builds and fake fixtures are evidence, not proof of live-provider behavior
   or packaged macOS acceptance.
5. **Retry narrowly.** Reproduce each credible critic finding before repairing.
   Return it to the same file owner, add the missing red regression, rerun green
   and obtain a fresh read-only check of the revised patch. Reject unsupported
   findings with concrete contract evidence, not intuition. If a finding crosses
   ownership or safety boundaries, stop and record it.
6. **Gate and carry forward.** Map each criterion to exact evidence, report
   outstanding failures and retain known limitations. Append the pass ledger.
   Select one next bounded candidate only if safe progress remains useful.
   Start the next implementation after this pass's integration and audit, never
   overlapping shared-file edits.

## Blind critic contract

Give the critic the mission, criteria, file allowlist, starting copies, current
candidate, relevant contracts and commands. Withhold the implementer's verdict,
self-score, persuasive success narrative and preferred repair. Do not suggest
that an all-green test report means there are no bugs.

Require a direct return of actionable findings with absolute path, relevant
location, trigger sequence, observed/expected outcome, severity and a bounded
reproduction. Alternatively require “no actionable findings in reviewed scope”
plus exact reviewed coverage and unverified boundaries. The critic may inspect
existing evidence or run scoped tests using disposable fixtures; it may not
edit code, install dependencies, run live sessions or expose private data.
Absence of findings is not a universal security or correctness guarantee.

## Sequential and fan-out map

Keep implementation, integration, lint/build generation and subsequent passes
sequential when they share files or generated outputs. Parallelize only
independent read-only exploration of disjoint interfaces, or independently
owned changes whose callers/contracts do not overlap. Return exploratory
findings to the orchestrator before assigning writes. Never run two critics or
builders that can mutate the same fixture, cache or output concurrently.

Fan-out is optional, not a quota. Request-journal loading, selection and
mutation ownership form one coupled path and need one implementer. Do not split
its callbacks between workers merely to increase activity.

## Ledger, hard stops and definition of done

Append to `docs/hermes-desk-improvement-loop-2026-10-12.md`: authority and scope,
baseline counts/logs, selected criteria, reproduced defect, owned files,
red/green commands and exact results, critic findings/dispositions, retained
risks, and next bounded candidate. Keep facts separate from hypotheses.
Record unrelated concurrent failures without editing another owner's files.

Stop on user interruption, ownership collision, unrecoverable ambiguity, unsafe
required action, exhausted session resources, or unavailable independent audit.
Never read credentials/private chats, submit paid inference, change live
profiles, install dependencies/apps, restart the user's app, commit/push,
publish, or use destructive cleanup to make tests green. An isolated native
harness requires explicit pass authorization; existing unit/fake fixtures
must not touch real user data.

Done means the selected criteria have reproducible evidence, relevant existing
assertions remain intact, new regressions demonstrably failed before fixing,
required checks have no unexplained failures, and an independent critic's
actionable findings have been resolved or honestly blocked. Final reporting
names changed absolute paths, commands/logs, evidence boundaries and remaining
work. If blocked, report partial completion; do not label unverified live,
packaged, provider or performance behavior as accepted.
