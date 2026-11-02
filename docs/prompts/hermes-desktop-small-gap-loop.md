# Hermes desktop small-gap improvement loop

Copy the prompt below into a coding-agent session. It is a bounded execution
brief, not an instruction to start a scheduled or infinite loop.

## Prompt

Improve Hermes Desk and its integration with Hermes Agent through a maximum of
five small, evidence-based passes. Work independently. Do not ask preference
questions. When permission or missing access is a real blocker, record it and
stop that action instead of guessing or bypassing safeguards.

### Scope and baseline

- Primary checkout: `/Users/devgwardo/hermes-desk`.
- Installed backend/reference checkout:
  `/Users/devgwardo/.hermes/hermes-agent`.
- Read the applicable `AGENTS.md` files, package scripts, and existing tests.
  Check Git status before editing. Existing tracked and untracked changes belong
  to the user or other agents; preserve them.
- Read `docs/hermes-desk-small-gap-loop-2026-10-07.md` so you do not repeat work.
- Fix one concrete user-facing gap per pass, preferably in Hermes Desk.
  A backend change needs a reproduced backend defect, its area instructions,
  and validation for all affected consumers. Do not expand the agent core or
  add tools, settings, dependencies, frameworks, or redesigns just for parity.
- Keep Electron authoritative for native capabilities, the renderer for
  presentation, and Hermes Agent for sessions, tools, model calls, and runtime
  liveness. Preserve profile isolation, stored/runtime session identity,
  backend-owned history, append-only message flow, and prompt caching.

### Fetch and use the upstream reference

The upstream is `https://github.com/NousResearch/hermes-agent`.
Reference fetched on 2026-10-08:
`4f9b741a3a0284ecce31dc7e4cffde49173ec764`.

At the beginning, fetch the current default branch once without checking it out,
merging it, changing the installed backend, or touching dirty files:

```sh
git -C /Users/devgwardo/.hermes/hermes-agent fetch --no-tags origin main
git -C /Users/devgwardo/.hermes/hermes-agent rev-parse FETCH_HEAD
```

Record the fetched SHA and the installed checkout SHA separately. Inspect the
pinned objects with `git show <sha>:<path>` rather than switching the worktree.
If fetching fails, use the already-fetched reference and report its age.
Recheck the remote's default branch if it is no longer `main`.

Read these reference paths only as needed:

1. `apps/desktop/AGENTS.md` and `apps/desktop/src/AGENTS.md`:
   native desktop architecture, ownership, scope, and compatibility.
2. `apps/desktop/src/lib/gateway-liveness-policy.ts`:
   busy-backend silence can produce false disconnects and interrupted turns.
3. `apps/desktop/src/app/gateway/gateway-event-dedupe.ts`:
   deduplication belongs at a renderer's cross-socket boundary; replay epochs,
   bounded caches, and legitimately restarted sequence numbers matter.
4. `apps/desktop/src/app/session/hooks/use-message-stream/interrupted-reply.ts`:
   preserve partial replies and prevent late cancellation frames from replacing
   newer or longer visible text.
5. `apps/shared/src/json-rpc-channel.ts`, `tui_gateway/contracts/`,
   `tui_gateway/session_transports.py`, and `tui_gateway/prompt_turn.py`:
   actual RPC contracts, fanout, replay, cancellation, and terminal transitions.

For a specific behavior, follow its implementation and nearby behavior tests.
Upstream is a reference, not a mandate to copy its UI, dependencies, or feature
set. Verify that a difference is a bug rather than intentional Desk behavior.

### Evidence already gathered

- Shared main/HUD sessions previously lost reply frames because main's global
  sequence watermark dropped the second renderer's copy. Main now processes
  an event once while every renderer receives its own copy. Keep this invariant.
- Desk's two-minute idle watchdog previously interrupted quiet turns even when
  `session.active_list` reported `working`, `starting`, or `waiting`. Those
  authoritative states now defer the watchdog. Preserve idle completion replay,
  stale-result guards, per-profile routing, and explicit Stop.
- Logs on 2026-10-08 showed a terminal interruption at 17:38. The exact reported
  “operation aborted” text was not retained, so the historical cause remains
  unconfirmed. Do not present a matching reproduction as proof of that incident.
- A separate startup log showed `hd:host:sidebarActivity` failing while serve
  was still offline. Investigate readiness and recovery before proposing a fix;
  do not just suppress every error or return a misleading empty success.

Possible next investigation areas, not confirmed bugs: failed liveness probes,
sequence resets after replay-ring eviction, late interrupted completions,
startup readiness, background-profile approvals, retry context, and stale
async work after navigation or unmount. Inspect only the highest-value relevant
area per pass.

### Each pass: evidence → red test → small fix → green checks

1. Inspect relevant recent logs and existing artifacts. Distinguish intentional
   Stop, timeout, disconnect, aborted fetch, and real backend failure. Keep chat
   text, tool inputs, secrets, tokens, and raw private identifiers out of reports.
2. Trace the failing path across renderer, Electron broker, and backend. State
   the expected contract, actual behavior, exact code location, and evidence.
   Prefer an observed failure to a speculative improvement.
3. Add a focused behavior regression and run it on the unfixed implementation.
   Require a meaningful failure. Do not read source text inside tests, freeze
   mutable catalog data, or weaken assertions to make the suite pass.
4. Apply the smallest complete fix. Cover sibling paths in the same bug class.
   Preserve newer user intent, drafts, partial replies, history, window and
   profile ownership, permissions, and explicit cancellation.
5. Run the focused suite, then the relevant integration probe, lint, and
   `git diff --check`. For transport or lifecycle changes, exercise real Hermes
   with a fake local model and disposable HOME/HERMES_HOME/userData. Keep
   production credentials out of the test environment and outbound network
   disabled. Never test by sending messages in the user's real conversations.
6. Review only your intended diff, record the result, and move to the next
   verified gap. Stop if the regression still fails or runtime evidence
   contradicts the diagnosis.

Relevant Desk commands, run from `/Users/devgwardo/hermes-desk`:

```sh
npm run test:unit -- src/lib/agents/hermes-local-transport.test.ts
npm run test:electron -- electron/local/serve-client.test.mjs
node tests/e2e/reply-timeout.mjs
node tests/e2e/reply-recovery.mjs
node tests/e2e/reply-fanout.mjs
npm run lint
git diff --check
```

Choose the narrowest checks that cover the change; do not run unrelated probes
just to increase the count. Run broader affected suites after the final pass.
For backend Python changes, use that checkout's `scripts/run_tests.sh`, never
bare pytest; profile-scope changes need two isolated homes and an A→B→A test.

### Safety and stopping rules

- Never kill an active turn because the renderer is quiet or a single probe
  times out. Never disable user Stop or the backend's own execution deadlines.
- Do not restart, install, update, or replace the user's app/backend as part of
  this loop. A live Vite server can reload on edits: use an isolated development
  worktree if editing would disturb active user work. Leave a restart handoff
  if a verified fix requires it.
- No commits, pushes, external posts, destructive cleanup, dependency upgrades,
  profile/config edits, or scheduled-loop creation. Stop only test processes
  you own and clean only disposable artifacts you created.
- Stop after five passes, two consecutive investigations with no reproducible
  small gap, a validation blocker, or any need for unauthorized consequential
  action. Never invent work to fill the pass budget.

### Deliverable

Maintain a local receipt at
`docs/hermes-desktop-small-gap-loop-receipt.md`. For each pass, record the symptom,
confidence, local paths, pinned upstream references, failing-before/passing-after
test, minimal change, checks and skipped/blocked checks, and artifact paths.
Do not overwrite an existing receipt; append a dated run section.

Finish with a short report: what was fixed, what remains unconfirmed, the exact
validation results, whether the running app has the fix, and whether a restart
is needed. Say “no verified gap found” when that is the result.
