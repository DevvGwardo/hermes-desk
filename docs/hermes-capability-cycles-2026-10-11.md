# Hermes capability improvement ledger

## Boundaries and discovered runtime

Work preserves the existing dirty tree. No real profile/session/memory/schedule,
installed runtime, installed app, credentials or external service is changed.
Acceptance uses the existing sandboxed Electron harness and loopback fake model.

CLI: `~/.local/bin/hermes` wraps
`~/.hermes/hermes-agent/.hermes/bin/hermes`. Managed Python is 3.14.7.
Source HEAD: `46d7718a52ff33accb15dc0501736fbdb6833cab`
(`rc.9-v0.21.7-20-g46d7718a52`). The install stamp reports
`0.21.5+4905.gf42f579.dirty`; stamp and source version are different evidence.

## Discovery baseline inventory (source verified, cycle deltas below)

Runtime paths below are relative to the discovered checkout.

| Capability | Hermes / transport | Current Desk / gap | Evidence |
| --- | --- | --- | --- |
| Profile model, instructions, tools, context | Profile-isolated config/SOUL, `session.create/resume` opt-in profile following; context manifest via `session.context_breakdown` | Reported model and scoped CLI recovery, personality with confirmed backup, profile inventory already exist. Effective tools/context manifest missing. | `tui_gateway/contracts/sessions.py`; Desk `ChatSessionContext.tsx`, `AgentPersonaPanel.tsx`, `local-profiles.ts` |
| Skills | REST `/api/skills?profile=…`, content, toggle, hub; RPC `skills.manage`, `command.dispatch` | Scoped profile list only. Global tools modal still uses hosted Linux filtering and unscoped requests. Discovery/content/use are disconnected. Installed does not mean ready. | `hermes_cli/web_routers/skills.py`; `tools/skills_tool.py`; Desk `ProfileTools`, `HermesSurfacesPanel.tsx` |
| Memory | Profile-scoped `/api/memory` status; native `learning.frames/detail/edit/delete` use bounded locked stores and stale fingerprints | Profile list shows sizes, not content. Old global viewer uses launch home. **Named-profile learning RPC editing unsupported:** contracts lack profile/session and handlers lack scope. Do not invent scope. | `hermes_cli/web_routers/ops.py`, `agent/learning_mutations.py`, `tui_gateway/methods_tools.py`; Desk `memory.ts` |
| Routines | REST cron CRUD, trigger, runs, delivery targets; atomic claim rejects duplicate runs; output ledger persists | Editor/results/run-now exist. Creation and CLI fallback can conceal failed native writes; execution/delivery state needs further real evidence. CRUD availability does not prove ticker ownership. | `hermes_cli/web_routers/cron.py`, `web_models.py`, `cron/AGENTS.md`; Desk `routines.ts`, `routine-cron.ts`, `RoutineHistory.tsx` |
| MCP/browser | Scoped MCP lifecycle and browser controller; browser status alone is not health proof | Native owned workspace and MCP shim have isolated backend acceptance. Broader MCP tools/settings are guarded, not renderer secret/config access. | `web_routers/mcp.py`; Desk `electron/local/mcp`, `workspace`, `harness.mjs` |
| Delegation | Agent-tool delegation; owned `subagent.list/tail/steer/interrupt`, live-only tails and generation authority | Local helper spawn and rooms exist; inherited `delegation.status`/unscoped control must be rechecked against current backend. Rooms are Desk coordination, not native durable delegation. | `tui_gateway/AGENTS.md`; Desk `hermes-local-transport.ts`, `local-room-runner.ts` |
| Resume/branch/recovery | Persisted sessions, event replay, pending requests; native `session.branch` text-row count, lease-safe `session.branch_stored` | Resume and replay implemented. **Verified bridge bug:** count rejected; stored branch omitted from allowlist. Tool-row cutoff differs from native projection. | `contracts/sessions.py`, `methods_session_branch.py`; Desk `serve-client.cjs`, `hermes-local-transport.ts` |
| Visibility/control | Tool events, server requests, interrupt/steer; advertise request capability | Tool chips, approvals, Stop, replay exist and have isolated tests. No automatic mutation retry is appropriate after uncertain acknowledgments. | `tui_gateway/AGENTS.md`; Desk `InlineApproval.tsx`, `useTurnControls.ts`, `serve-client.cjs` |
| Usage/budgets | `session.usage/context_breakdown`, optional profile iteration/time budgets; no per-session create budget field | Session reported usage and durable room token pause exist. These are not hard billing caps; no paid-model quality claim. | `contracts/billing_delegation_pets.py`, `config_defaults.py`; Desk `RoomUsage.tsx`, `room-usage.ts` |

## Ranked verified opportunities

Scores are relative (high/medium/low), not numerical certainty.

1. **Repair branching**: high user value, native persisted context reuse, high reliability benefit, low/medium effort and risk. Complete existing broken path first.
2. **Scoped skill discovery → inspect → draft for chat**: high value/capability, high reliability benefit (no wrong profile or hosted filtering), medium effort, low risk without installs.
3. **Effective session tools/context inspection**: high context ownership value, medium reliability benefit, medium effort, low risk for projected read-only RPC.
4. **Routine reliable creation/result recovery**: high value, high reliability benefit, medium/high effort and risk; must establish native scheduler ownership and no fallback duplicate.
5. **Owned delegated task visibility/control**: high capability, high reliability benefit, high effort/risk because installed ownership contracts differ from inherited adapter.

## Cycle 1: persisted branching

Today branching is blocked by the real renderer guard. After this slice a user
can branch an individual settled chat at a chosen reply or copy a leased parent.
Acceptance: native guard/parameters, text-only cutoffs, unchanged parent,
persisted child/restart, rapid-click coalescing, no blind mutation retry,
no late selection after navigating to another chat.

Files: `electron/local/serve-client.cjs`, `src/lib/agents/hermes-local-transport.ts`,
`src/App.tsx`, `src/components/MessageActions.tsx`, associated regression tests,
`tests/e2e/harness.mjs`, `tests/e2e/session-branch.mjs`.

Unit/bridge: native allowlist, child ownership, text-row cutoff, rapid branch
coalescing and uncertain acknowledgment fencing. Existing tests exercise leased
parent selection and continued child prompt routing.
Real backend + fake model: chosen prefix, unchanged parent, slow completion
after profile navigation, full changed-origin app/backend restart and child
continuation. Screenshots inspected at normal and actual minimum window.
Initial mouse acceptance exposed composer interception of the floating menu;
the menu now portals outside transcript paint containment and the same test passes.

Evidence: `tests/e2e/artifacts/session-branch-1791748680472/report.json`
(5 lifecycle assertions, no model or renderer errors), including actual
lease-safe stored-parent branching. Screenshots inspected from
`session-branch-1791748411208` and the final run;
282 narrow regressions and TypeScript passed at this checkpoint.
No live-model quality claim or real user-state mutation.

Critique: this unlocks native persisted context reuse, not just UI.
Limitations: whole stored branching is the only supported leased-parent cutoff;
branching waits for a settled individual chat. Lost-response protection is
transport-lifetime fencing, not a cross-restart exactly-once guarantee; native
idempotency is process-local. No automatic branch retry on reconnect/restart.

## Cycle 2: profile skills, inspection and draft handoff

Before: scoped profile skills are read-only labels; App's global skills modal
uses hosted-agent Linux assumptions and launch-home requests.
After: composer menu → Profile skills, or agent details → Tools, gives a
profile-explicit installed list, local search, enabled status, complete native
instructions and supported declared prerequisites. “Prepare in chat” appends
a deduplicated request to the owning draft, restores keyboard focus and waits
for explicit Send. No package install, toggle, credential edit or auto-execution.

Files: `ProfileSkills.tsx`, `ProfileToolsPanel.tsx`, `profile-skills.css`,
`AgentPersonaPanel.tsx`, `AgentInfo.tsx`, `ChatPanel.tsx`, `MessengerComposer.tsx`,
`App.tsx`, `skill-draft.ts`, fake-model script and associated tests.

Evidence: `tests/e2e/artifacts/profile-skills-1791749229835/report.json`
(9 lifecycle assertions; no renderer/model errors).
Native REST returns the disposable Mac skill for Alpha/Beta separately; Send
causes the deterministic model to invoke the **real** Hermes `skill_view` and
receive the profile's actual result. No model request occurs during preparation.
Result survives renderer reload and full changed-origin app/backend restart.
Delayed obsolete read, close/reopen/profile switching, failed reads with explicit
retry, backend restart, keyboard preparation/focus and prerequisites are checked.
59 selected UI/draft regressions, fake-model contract and typecheck passed.

Critique/screenshot fix: move Prepare above lengthy prerequisites/instructions
so the main action is visible at the real minimum-window clamp. Add selected-tab
treatment. Both actual Alpha/Beta screenshots were inspected.
The modal now unmounts its request owner immediately on close, rather than
keeping obsolete fetches alive through the shared exit animation.

Limitations: a catalog entry does not prove readiness. Metadata declarations
and Hermes's load-time secret checks are different from a command-availability
test. Disabled skills remain inspectable, but Prepare is disabled.
`_find_all_skills(skip_disabled=True)` **skips filtering disabled entries** for
configuration UI; REST separately supplies each entry's `enabled` flag.
Memory tab is profile status, not a newly invented content editor.
The old surface remains in source for compatibility tests but is no longer
the app's local tools path. No live-model quality or live iMessage-service claim.

## Cycle 3: native active-chat context inspection

Before: model/profile disclosure does not expose native context attribution
or explain which instruction-file candidates Hermes considered.
After: that same disclosure offers an explicit read-only inspection of the
owned profile session, estimated categories (including memory/tools when
reported), usage provenance, and the native per-file instruction manifest.
Refresh does not send a prompt, compress, edit memory, reload files into the
conversation or change its cached prefix.

Files: `serve-client.cjs`, `hermes-local-transport.ts`, `session-context.ts`,
`SessionContextInspection.tsx`, `ChatSessionContext.tsx`, existing context CSS,
`ChatPanel.tsx`, `App.tsx`, associated tests and harness-only delay control.

Security: one added native method, only `profile` and `session_id` parameters.
Main requires this renderer's live session and matching known profile.
Response is bounded scalar-only totals/categories/file metadata; no prompt
bodies, memory contents, config, env or credential values. Unit tests cover
foreign/missing profile/session, unknown parameters and private-body removal.
Transport reattaches through the native lease, not a replacement or forced resume.

Evidence: `tests/e2e/artifacts/session-context-1791749724326/report.json`
(5 lifecycle assertions, no renderer/model errors).
Actual native context, Alpha/Beta scope, memory category, absence of memory body,
no added model call, keyboard focus restoration, delayed read across navigation,
fixture backend restart and full app/backend restart passed.
260 bridge/transport/parser/context regressions and typecheck passed.
Normal/minimum-window screenshots were inspected. Critique fix keeps Close,
Refresh and the provenance-labelled total visible while scrolling the manifest.

Important native limitation: `context_file_sources_for_agent` **re-derives**
candidate status from current files. Its `loaded` status is not proof of the
exact cached prompt after an on-disk edit; the UI explicitly says so.
Categories are estimates, not billing or a spending limit. Before a resumed
agent builds, an empty category/manifest response is a last usage snapshot,
not a claim that memory is empty. No editing or compression control is added.

## Deferred at the first delivery (follow-up below)

1. **Native routine lifecycle**: remove ambiguous creation/fallback outcomes,
   reconcile idempotent run/results after lost acknowledgments and prove which
   service owns ticking before claiming reliable scheduled execution.
2. **Owned delegation**: adopt current native `subagent.list/tail/steer/interrupt`
   contracts with exact session/transport/generation authority and live-only
   tails; inherited unscoped controls are not an acceptable shortcut.
3. **Scoped memory content/editing**: needs a verified backend profile/session
   authority contract for `learning.*` first. Current named-profile writes are
   blocked by missing backend support; do not fake them with renderer files.

The first delivery stopped after three completed slices rather than speculatively
adding routine execution or memory/delegation mutations without ownership evidence.
No Hermes installation/update, paid model request, live service action or app
installation was performed.

## First-delivery validation and build

- `npm run test:run -- --maxWorkers=4`: **482 files passed, 5,076 tests passed**,
  20 existing skips, one expected failure and one todo; no unexpected failures.
  Includes auth, secure prompts, redaction, bridge policy, workspace ownership,
  routing, persistence, composer/modals, native adapters and bundle-budget checks.
- First full pass found a stale structural routing test expecting a no-argument
  callback. Updated only its signature lookup, retaining all fail-closed roster
  and resolver-order assertions. Production routing behavior is unchanged.
- `npm run typecheck`: passed renderer and Electron types.
- `npm run check:node`: **204 Node JavaScript files** passed syntax checks.
- Fake-model `skill-model.test.mjs`: one contract test passed under the isolated
  E2E Vitest configuration.
- `git diff --check`: passed.
- Three isolated real-Hermes/fake-model acceptance reports: **19 lifecycle
  assertions total**, no renderer or model errors. No paid/live-provider calls.
  These establish native protocol, profile scope and persistence, not general
  model quality or live third-party service health.
- `npm run electron:build`: executed **once**, passed. Output:
  `release/mac-arm64/Hermes Desk.app`. The normal script verifies the ad-hoc
  signature, hardened runtime and launch entitlements. This is a local build,
  not a notarized release. **Not installed or launched against real user data.**
  Non-blocking large-chunk and duplicate-dependency packaging warnings remain.
- Existing dirty/untracked user work was preserved; no commit, reset, clean,
  install, runtime upgrade or external publication.

Reproduce isolated lifecycle checks:

```sh
node tests/e2e/session-branch.mjs
node tests/e2e/profile-skills.mjs
node tests/e2e/session-context.mjs
```

## Follow-up: native routines

User requested completion of the remaining opportunities. Native scheduled
execution is owned by Hermes's desktop ticker, which yields to the messaging
gateway's ticker. This was verified with an actual due occurrence, not a test
scheduler or a claim inferred from CRUD availability.

New creates now use native REST only, with an explicit profile, atomic initial
`paused` and `repeat` settings, and no CLI/local fallback after a native failure.
The editor has one creation intent per opening. Successful receipts are reused;
changed payloads cannot reuse an already saved receipt. Lost acknowledgments
are fenced against blind retry. Failure-delivery-only follow-up settings are
staged while paused, then resumed only after success.

Options, templates, Run now, actions and result history carry the owning
profile. Owner and scheduler heartbeat are visible. Stored profile identifiers,
not the currently selected agent, route updates and results. Legacy local/CLI
jobs remain readable/editable; they are not a fallback for new creates.

Limit: renderer receipts and uncertain-outcome fences last for the renderer
lifetime. A `client_request_id` alone does not establish native durable
idempotency. A partial staged save is reported as such; a new opening must
inspect the existing native job rather than assume a retry is exactly-once.

Evidence: `tests/e2e/artifacts/native-routines-1791757933829/report.json`,
five checks, no renderer/model errors. Native Alpha creation, isolation from
Beta, real executor/model/result, renderer reload, actual one-shot ticker
execution and full app/backend restart passed. The result screenshot was
inspected. Earlier slice checkpoint: 240 targeted tests and types passed.

Full regression exposed a same-profile editor replacement bug: the form
cleared metadata but did not reload it when the opening changed. Fixed the
effect's opening dependencies and initial profile capture. The existing
autofocus/lifetime tests plus a new first-read profile regression verify it.
A successful template commit refreshes jobs even after the issuing editor
closes, without closing a newer opening. Profile query construction now uses
a shared pure helper, preserving scope and the existing route allowlist scan.
152 focused routine/editor/route regressions and types then passed, followed
by the fresh native acceptance report above.

## Follow-up: session-owned native delegation

Model-called `delegate_task` is distinct from Desk's separately created helper
sessions and shared rooms. The existing model/profile disclosure now offers an
explicit native child roster, selected-child live transcript, steering and
stop request. Reads do not spawn work or call a model. Transcript reads are
live-only, bounded to the backend's last 16 KiB; they can contain private task
content and are not a persisted completion history.

Main removes renderer access to global `delegation.status`. Native
`subagent.list/tail/steer/interrupt` require this renderer's owned runtime
session and matching explicit profile. Child controls remain authorized by
the backend's exact session/transport/generation contract. Main projects
bounded scalar roster metadata, excluding runtime objects, paths and ownership
internals. Invalid child handles are excluded.

The local adapter overrides inherited global polling and unscoped controls.
Inspection generations are fenced across reattachment/backend replacement,
even if a runtime id repeats. A visible lineage child may be read-only.
Steering acknowledgment means queued, not delivered; interrupt acknowledgment
means requested, not completed. Rejected steering preserves its draft;
uncertain controls require a fresh inspection and are never automatically
retried. A missing roster handle is not inferred successful. Existing native
completion events remain the authority for saved result pills.

Desk-created helpers use their own runtime/profile binding, never native
delegate control or a guessed post-restart profile. Saved helper rows alone
do not grant control authority. Live backend delegation is process-local;
durable work belongs in native routines.

Evidence: `tests/e2e/artifacts/native-delegation-1791757504764/report.json`,
seven checks, no renderer/model errors. Actual native delegation creates a
child against the isolated deterministic model; owner list/tail/steer/stop,
foreign Beta tail/steer/interrupt denial while Alpha's child stays alive,
normal native completion, live-child backend restart with retired-generation
stop blocked before dispatch, and persisted parent result after full restart
passed. Screenshot inspected; acceptance feedback was moved into the sticky
header so it remains visible while scrolling the detail.

Bridge tests cover foreign/missing sessions/profiles, unknown parameters,
global-status denial, bounded tails and projection. Adapter/UI tests cover
rejection, draft preservation, late reads, offline controls, no optimistic
cancellation, no revival of completed native children and repeated runtime ids.
These verify native protocol/lifecycle, not general paid-model quality.

## Follow-up: safe profile memory, backend editing limitation retained

`learning.frames/detail/edit/delete` params do not accept a profile or session.
They cannot safely provide named-profile content editing in this installed
build. `/api/memory?profile=…` supplies provider status and built-in file sizes,
not a general scoped content API. Desk does not invent a content endpoint,
read renderer filesystem paths, issue unscoped learning calls, reset stores,
or mutate the installed Hermes runtime to bypass this limitation.

The profile Memory tab now has explicit refresh/retry, scope and cache
explanations, a duplicate-safe review draft handoff, and copyable native
`hermes -p <profile> memory status` / `hermes -p <profile>` recovery.
Preparation preserves existing text, restores composer focus, and waits for
explicit Send. It requests read-only review and proposals, not automatic
memory writes. Actual model compliance with that review prompt is not claimed.
CLI guidance explains `/memory pending` and that `/memory approval on`
changes the selected profile's future-write approval setting. It is not
executed automatically. Existing chat caches and external providers are
explicitly distinguished from current built-in saved files.

Evidence: `tests/e2e/artifacts/profile-memory-1791757579530/report.json`,
six checks, no renderer/model errors. Real native Alpha/Beta disk status,
profile-specific CLI copy (fixture-only clipboard capture), successful
sandboxed native status command, preserved/deduplicated draft and focus,
minimum-window UI, failed-read retry, no automatic model call and byte-identical
disposable memory files passed. Normal/minimum screenshots inspected.
Five component regressions cover scope, copy, failure/retry, late results
and invalid-profile denial.

Remaining backend prerequisite: add profile/session ownership to the native
learning/content contract and its handlers before enabling direct memory
inspection/edit/delete. Current UI honestly exposes this limitation; it does
not label the unsupported editor complete.

Reproduce the follow-up acceptance:

```sh
node tests/e2e/native-routines.mjs
node tests/e2e/native-delegation.mjs
node tests/e2e/profile-memory.mjs
```

## Follow-up final validation and build

- Full regression: **488 files passed, 5,111 tests passed**, seven existing
  skipped files, 20 skipped tests, one expected failure and one todo. No
  unexpected failures remain. Log:
  `tests/e2e/artifacts/capability-followup-regressions-final.log`.
- Renderer/Electron typecheck passed. Node syntax check passed for **208**
  JavaScript files. Three isolated fake-model contract tests passed.
- Three follow-up native acceptance reports contain **18 lifecycle checks**,
  no renderer/model errors. These use the real installed runtime with disposable
  profiles and a loopback deterministic model, not paid-provider calls.
- `git diff --check` passed. Existing dirty/untracked work was retained.
- `npm run electron:build` passed once for this follow-up. The script verifies
  ad-hoc signing, hardened runtime and launch entitlements. Updated bundle:
  `release/mac-arm64/Hermes Desk.app`; build log:
  `tests/e2e/artifacts/capability-followup-build.log`.
  Existing large-chunk/duplicate-dependency warnings are non-blocking.
- No app installation, real-profile launch, runtime upgrade, real schedule or
  memory mutation, credentials change, commit, reset, clean or publication.

Outcome: native routines and session-owned delegation are implemented and
verified. Safe memory status/review/CLI recovery is complete; direct
named-profile content editing remains correctly blocked by the installed
backend's missing ownership contract.
