# Local room shell and native acceptance

## Fixed

The room runtime was already implemented, but the actual app shell never mounted
`GroupEditor`, ignored the sidebar creation callback and treated a selected group
without a selected agent as an empty/disabled chat.

Four failing UI regressions reproduced those gaps. The sidebar now offers
**New shared room** in compact and expanded layouts. The command palette also
offers creation. The app mounts the existing editor, selects the created room
and forwards room status, handoffs, thread controls, mentions and speaker labels
to the enabled chat. The editor hides the native workspace like other modals.

Four more failing regressions reproduced stale creation results after Cancel,
reopening and a newer pending creation. Selection now belongs to the initiating
editor epoch. The runtime can create a conversation without selecting it, while
its default behavior stays unchanged. Cancel leaves any completed room in Chats
without switching the active chat; old errors cannot overwrite a new draft.
Pending focus frames are cancelled when the editor closes.

## Original Electron and Hermes acceptance (legacy runtime)

`tests/e2e/local-rooms.mjs` runs real Electron and real Hermes with temporary
profiles, a deterministic loopback fake model and the existing macOS isolation
harness. It is included in `test:e2e` and can also run on its own:

```sh
HERMES_E2E_SOURCE="/absolute/path/to/provisioned/trusted/hermes-checkout" npm run test:rooms
```

At this checkpoint, the checkout needed an executable `venv/bin/python`. The harness rejected
a missing interpreter before launching Electron or creating fixture services.
That behavior was reproduced with an empty temporary checkout and regression
tested. No installer runs.

All five room checks passed:

1. Create a room in the UI; Chief delegates to simultaneously active Alpha/Beta
   sessions and wraps once after both replies. Each profile owns a separate
   stored and runtime binding.
2. Alpha's DM uses another session. Room history and bindings survive a renderer
   reload without another submission.
3. A second room owns separate bindings for all three profiles.
4. Stop interrupts both actual specialists and durably cancels their turns.
5. No renderer or model errors; permitted network traffic stays on loopback.

Both room-model fixture cases were reproduced failing before implementation.
Room members identify themselves from the routed prompt; unknown members fail
closed. Cancellation uses delayed specialist answers rather than fabricated
renderer events.

The tested checkout was `/Volumes/T7 Shield/mac-offload/Projects/hermes-agent`,
commit `be70931f7f`, reporting Hermes `0.20.5`. The installed October 9 checkout
uses a managed runtime rather than the harness's legacy virtual environment,
so this is not evidence of running that newer installation.

Successful room evidence:
`tests/e2e/artifacts/local-rooms-1791641722047/report.json` and `room.png`.
Artifacts remain local and are not a committed deliverable.

## Original validation and remaining limit

- Full unit suite: **3,857 passed**, 18 skipped, one expected failure and one todo.
- Full Electron suite: **1,008 passed**, two skipped.
- Typecheck, **188** Node syntax checks, production build and `git diff --check`
  passed. Existing theme-script, mixed-import and large-chunk warnings remain.
- Final affected E2E suite: **seven passed**, covering room acceptance, interpreter
  preflight and all fake-model tests. The standalone `test:rooms` command passed
  too. Creation waits for the new room's selected checkpoint before submission.
- Earlier broader E2E suite: **seven passed, one failed**. Room acceptance, interpreter
  preflight and all fake-model tests passed. The existing browser golden-path
  check observed Beta's navigation in Alpha's lane on the older test runtime.
  Its isolation assertion was not weakened or skipped. It wrote the golden
  artifact directory, which is replaced by subsequent golden-path runs.

At that checkpoint the broader native suite was **not fully green**. Its browser-lane failure needed
an isolated reproduction against the installed managed Hermes runtime before
attributing or changing production code. The older checkout's MCP server lookup
is keyed by server name, consistent with the observed cross-profile reuse.
No Hermes checkout or real profile was modified to work around it.

No external provider was called, no user credentials were used and no normal
service was left running. Model quality, real-provider behavior and browser-tool
isolation inside rooms are not proved by this fixture acceptance.

## Follow-up: all five review improvements

1. **Conversation-owned approvals.** The selected conversation reads its own
   FIFO queue. Native requests are keyed by request ID, including several
   requests from the same member. Status updates, cancellation, failed sends,
   replay and late confirmations cannot clear or answer another request.
   Legacy notification cards retain their per-session replacement behavior.
   Sidebar waiting state observes all conversations, not a global last card.
2. **Room editing.** The app connects name, purpose and membership callbacks.
   The information panel disables edits during saves, preserves failed drafts,
   offers retry and ignores old-room errors. Renaming follows matching room
   conversation titles without overwriting custom chat titles. The app does not
   expose the old Chief setter: it changes a profile-wide role, not a room role.
3. **Automatic names.** Blank creation names use member names. Membership
   changes update automatic names; explicit names stay fixed. Clearing a custom
   name restores automatic naming.
4. **Accurate labels.** Empty rooms invite a message or mention, rather than
   profile selection. Their composers say “Shared room · On this Mac”.
   Both skins identify the member owning an approval.
5. **Installed-runtime acceptance.** The harness discovers the already selected
   managed environment and copies its dependencies and tool packages into the
   disposable fixture. Interpreter links, entry points and managed facts point
   to the copy. Source and live installation state remain read-only; there are
   no installs, real credentials or external providers.

The native room scenario now checks four simultaneous approval requests across
two rooms, switches between their cards and denies each exact request ID.
It also restarts the backend, then the entire Electron/backend pair using the
same temporary userData. History and stored IDs survive without resubmission.
Idle session bindings resume lazily when new work arrives, with new runtime IDs
and the new backend epoch. Network checks retain evidence across both app
instances. Model fixtures read the current room trigger, not older scripted
messages in shared context.

## Earlier validation, before the reliability follow-up

- Full unit suite: **3,872 passed**, 18 skipped, one expected failure and one todo.
- Full Electron suite: **1,008 passed**, two skipped.
- Full E2E/fixture suite: **13 passed**, including both actual native flows.
  All seven room checks and all fourteen golden-path checks pass.
- Typecheck, **190** Node syntax checks, production build and `git diff --check`
  pass. Existing theme-script, mixed-import and large-chunk warnings remain.

The installed source was commit **`46d7718a52`**, reporting Hermes **`0.21.6`**.
The previous Alpha/Beta browser-lane failure does not reproduce on this runtime;
its assertion remains intact. No production browser routing was changed to
work around the older fixture failure.

Managed-room evidence:
`tests/e2e/artifacts/local-rooms-1791646728933/report.json`.
Current browser evidence: `tests/e2e/artifacts/golden/result.json`.
Artifacts remain local.

The isolated managed snapshot reports `venv: out of sync with uv.lock`.
The harness neither repairs nor suppresses that warning; functional acceptance
passes with the provisioned dependencies. This does not establish live-install
health. At that checkpoint, real-provider quality, room-specific browser tools
and abrupt mid-turn process-crash recovery remained outside those scenarios.

## Reliability follow-up

The five authorized reliability gaps are implemented:

1. Required lint now uses `typecheck && check:node`. Subprocess regressions
   preserve both checks' nonzero exit codes. ESLint remains a separate advisory
   command, not a swallowed required failure.
2. The composer waits for explicit acceptance, retains rejected/uncertain drafts,
   files and quotes, fences duplicate pending sends and preserves newer edits.
   Notices belong to the originating conversation. An unclassified post-dispatch
   failure is uncertain, not proof that the backend rejected the request.
3. Native rooms use a fixed, revisioned `userData/local-rooms.json`, with private
   file mode, exclusive locking, compare-and-swap, payload fsync and atomic
   rename. Directory fsync is attempted. Corruption, symlinks, stale revisions and
   payloads over 32 MiB fail closed. Only the main app frame can call the
   synchronous journal interface. It stays registered while renderers close.
   Fault-injected postcommit handle cleanup cannot turn a committed intent into
   a rejected acknowledgment; exhausted revisions cannot write an invalid next
   document.
   The current legacy origin imports only if no native journal exists; an
   authoritative empty native document prevents deleted-room resurrection.
4. Actual SIGKILL acceptance covers a streaming reply and a pending approval.
   Ordinary Hermes cold resume independently auto-continued interrupted
   desktop turns. Room recovery now uses read-only lazy resume, preserving the
   stored source and upgrading only on a new explicit prompt. The resume request
   also crosses the actual main-process RPC allowlist in a regression test.
   Lazy-only recovery skips Hermes's normal approval bootstrap, so the owned
   backend launch enables Hermes's existing gateway prompt mode before any
   tool can run. No upstream source, live config or installer was changed.
5. Reported cumulative member-session counters become durable per-turn deltas.
   Replay duplicates do not double-charge, retries retain spend, and new
   epochs/runtime IDs reset the baseline even when their counters equal an old
   sample. A 64,000-token default limit per human request pauses queued turns.
   Raising the durable limit wakes them; a failed save rolls back without waking
   work. The UI shows per-member usage and incomplete accounting.

Native evidence, standalone and complete-suite runs:
`tests/e2e/artifacts/local-rooms-1791667438272/report.json` and
`tests/e2e/artifacts/local-rooms-1791667599992/report.json`.
All **11** checks passed on the isolated Hermes **0.21.6** snapshot. Both killed
backends leave no renderer resubmission, independent model continuation, stale
approval, automatic approval response or phantom answer. Fresh work succeeds.
A changed-origin full restart retains history and stored IDs. An actual
one-token budget pauses delegation; raising it resumes exactly the queued work,
with reported usage from all three members. No renderer/model errors occurred.

Final renderer validation: **3,901 passed**, 18 skipped, one expected failure
and one todo. Final Electron validation: **1,020 passed**, two skipped.
Required lint, **193** Node syntax checks, production build and
`git diff --check` pass. The complete E2E/fixture suite has **13 passed**,
including all eleven room checks and all fourteen browser golden-path checks,
with no skipped golden-path checks.

Limits: token limits are soft, not billing caps. Active calls may overshoot;
unreported/auxiliary usage stays unverifiable and no verified pricing is
available. Migration can only read the currently opened legacy origin. The
crash tests cover owned backend process death, not power loss or live-provider
quality. Existing build and managed-lock warnings remain; no runtime repair or
external-provider spending was performed.
