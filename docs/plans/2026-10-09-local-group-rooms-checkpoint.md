# Local group rooms feature checkpoint

## Slice A, 2026-10-09

- Added a serve-independent room journal/rules engine: explicit mention order,
  reply routing, Chief routing, serial human responders, parallel peer handoffs,
  single-flight member claims, deduplicated settlement, bounded cascades and
  Chief follow-ups, cancellation fencing, count/character-bounded shared context.
- Groups survive online/offline conversation refresh and local-only startup.
  The conversation journal persists shared messages, outcomes, cursors and real
  stored/runtime binding IDs without restoring hosted chats or DM transcripts.
- Reference: current `hermes-deploy/src/lib/rooms/{core,runner,store}.ts`,
  not the draft's serial-handoff / token-anywhere-pass / invented-instructions rules.
- Red proof: missing engine and group refresh test failed before implementation.
- Green: 154 tests in four focused files; `npm run typecheck`; `git diff --check`.
  Updated the old mention-order expectation to the current explicit-order contract.
- Next gap: execute this engine through the real local transport adapter, with
  isolated serve-issued member sessions and session-scoped room UI events.
  No live room execution claimed.

## Slice B, 2026-10-09

- Real `HermesLocalTransport` now sends groups through the room engine and
  creates/resumes separate serve-issued sessions for each room/member/profile.
  Member sessions stay out of the sidebar; room execution does not depend on
  selection or the view watcher.
- Populates `mergeRoomFeed()` and `setRoomView()` directly, not generic `Turn`
  events. Speaker names, streaming bubbles, handoff pills, transcript row links
  and Chief wrap outcomes use the existing UI contract. Explicit batch linkage
  handles follow-ups created in the same millisecond as their handoffs.
- Verified actual local serve source/contracts: context is appended to `text`,
  `profile/session_id/text/surface` are the only submission fields. Broker
  allowlists and profile personas are unchanged.
- Red: three new adapter behavior tests failed on missing rooms capability and
  the existing group rejection. Green: 172 focused tests, typecheck, diff check.
- Deterministic three-member adapter fixture proves overlapping Writer/Coder
  runs, interleaved speaker-correct streams, selection independence, substantive
  `[pass]` output, deduplicated completion, and wrap only after both settle.
  This is fixture proof, not live serve proof.
- Next gap: stop/removal/deletion fencing, reconnect/restart reconciliation,
  failed submissions/retry, and concurrent member approval/question ownership.

## Slice C, 2026-10-09

- Stop cancels queued work and fences running turns before interrupt RPCs.
  Every running session is interrupted; refused/unconfirmed interrupts return
  false and quarantine the session until a terminal event or idle proof arrives.
- Membership changes and deletion cancel owned work, clear member-owned prompts,
  retire deleted session events and prevent late completions/cascades. Creation
  completing after deletion is tombstoned rather than submitted.
- Parallel approvals retain separate session owners and reveal the remaining
  approval after an answer. A member completion clears only its own questions.
- Restart retains settled messages/bindings and explicitly marks an idle
  unfinished turn as interrupted/lost-completion, without resubmitting it.
- Red: seven lifecycle checks failed before the slice. Green: 155 focused tests
  across engine, persistence and adapter; typecheck. Concurrent stable-echo sends,
  replayed completed roots and sends during the completion wake stay deduplicated.
- Next gap: reconnect epoch/replay races, missing completion recovery, failed
  submission retry and long-running tool safeguards through the room adapter.

## Slice D, 2026-10-09

- Session replay applies missing deltas before buffered live frames. A lower
  missed completion can settle its guarded turn even after usage advanced the
  live watermark. Serve epoch changes reset room replay cursors.
- Definite failed submissions/bindings have explicit, journaled retry attempts;
  completed work cannot be retried accidentally. Native room attachments use
  a real member session and retain image/file chips and shared prompt paths.
- The room liveness poll starts for newly created rooms too. An authoritative
  working tool remains live through a 12-minute silent fixture run, without
  applying the DM silent-stream cutoff.
- Red: six new adapter checks failed. Green: 162 focused tests, typecheck.
- Next: final lifecycle guard cases (late requests, uncertain acknowledgements,
  durable-write refusal, lost contact), then full suites/build and live prerequisite
  reporting. Port checks currently find no serve listener on 9119 or 9120.

## Final lifecycle slice and validation, 2026-10-09

- Late approval/question requests cannot revive stopped work. Replay reconciles
  expired member requests independently. Member identity is retained in approval
  and question cards, not inferred from the selected chat or the room Chief.
- Ambiguous submission acknowledgements retain the original running turn for
  reconciliation; its actual completion is preserved, never submitted again.
  Unknown idle/lost-completion outcomes require a new explicit request, not a
  retry that might duplicate work already completed on serve.
- Execution refuses failed durable journal writes before submitting. Lost
  contact settles explicitly after eight minutes without proof of life;
  authoritatively working turns keep running until the three-hour hung-turn
  backstop. Session closure settles immediately. Acknowledgements with peer
  mentions cannot start another delegation loop.
- Red proof: five durability/lifecycle cases, three closure/request/routing
  cases, three ownership/uncertain-retry cases, and the member question UI case
  failed before their fixes. Green: 295 focused tests in ten files; typecheck
  and diff check.

### Final evidence

- `npm run test:unit`: **392 files passed; 3,727 tests passed**.
  Existing test dispositions: five skipped files, 18 skipped tests, one expected
  failure and one todo. No unexpected failures.
- `npm run test:electron`: **66 files passed; 1,008 tests passed**.
  Two files/two tests skipped. Broker, security, DM, approval, attachment and
  streaming regression coverage remains green.
- `npm run typecheck`: passed.
- `npm run build`: passed. Vite reports theme-script, mixed-import and
  large-chunk warnings; no unrelated build cleanup was attempted.
- `git diff --check`: passed.
- Logs: `/tmp/hermes-room-final-{unit,electron,build}.log`.

### Acceptance coverage and remaining proof

The pure engine, persistence boot test and real-adapter controlled serve fixture
demonstrate group retention, Chief/account-Chief routing, explicit mentions and
reply routing, Chief-less everyone, overlapping specialist handoffs, correctly
interleaved streams, settlement-gated Chief wrap, substantive pass output,
shutdown wakes, echo/completion/retry deduplication, cancellation/removal/deletion,
replay/reconnect/restart reconciliation and isolated bindings.

**Live proof is not claimed.** Read-only listener checks found no serve on 9119
or 9120 and no Desk serve listener in the active TCP listener inventory. The
Hermes gateway on 8642 is not a substitute for `hermes serve`. No profile or
configuration was edited, service started/restarted, release installed, commit
created, or push/deploy performed. Both reference repositories remained read-only.

Next proof step: when local serve and three suitable existing profiles are
available, run harmless three-profile work through the Desk adapter and confirm
real persona responses, overlap and final wrap. The deterministic fixture is
contract/scheduler evidence, not evidence of live model behavior or UI interaction
inside an installed Electron release.

## Overnight improvement loop, 2026-10-09/10

- User requested small, tested improvement iterations until **6 a.m. EDT on
  October 10**, equivalent to **2026-10-10T10:00:00Z**.
- Session work loop: `9d6841d2`, every ten minutes. Deadline loop: `15b6abac`.
  Preserve user work and the earlier no-profile/config/service/publication
  boundaries. Do not invent changes when an inspected area has no concrete gap.

### Iteration 1, 22:25 EDT: background room unread badges

- Gap: room completions bypassed the DM/store streaming-settlement path, so
  useful replies arriving while another chat was selected never badged the room.
  `markRead()` also returned without clearing local group metadata.
- Red: two new real-adapter regression tests failed on missing unread count and
  ineffective room read acknowledgement (`/tmp/hermes-room-overnight-01-red.log`).
- Fix: only an actual newly settled agent message changes the room unread count.
  Streams, passes, errors, duplicate completions and history hydration do not.
  Reading a room clears its local badge without a backend PATCH or changes to
  another profile/session. Selected-room completion stays read.
- Green: **233 tests in five files**, typecheck and diff check. Expanded the
  reopen test to rebuild the room transcript from its journal while another chat
  is selected and verify that old replies are not falsely badged.
- The full-suite/build results above predate this overnight change. Repeat full
  completion validation near the deadline after subsequent edits are settled.
- Next inspection candidates: triggering-ask truncation within the accepted
  16,000-character send limit; context cursor handling on definite failed retry;
  stale asynchronous membership/session-binding lifecycle results.

### Iteration 2, 22:28 EDT: preserve accepted long triggering asks

- Gap: the room accepted up to 16,000 characters, but the explicit triggering
  ask was truncated at 4,500. Backlog rows also capped at 4,000, silently losing
  later user requirements and the trailing attachment note.
- Red: a crowded-roster/backlog test lost the final requirement in a full-size
  user ask (`/tmp/hermes-room-overnight-02-red.log`).
- Fix: reserve the ask and its file note within the total prompt budget before
  trimming older context. The regression checks the full ask, both paths, the
  omission notice and the unchanged 24,000-character overall cap.
- Green: 174 engine/adapter tests and typecheck/diff check.

### Iteration 3, 22:30 EDT: failed retries keep unconsumed context

- Gap: an errored submission advanced the member context cursor even when the
  backend rejected it before execution. Retrying a delegated task then omitted
  the original human brief, retaining only the Chief's short delegation.
- Red: the specialist retry lost the warranty constraint from the human brief
  (`/tmp/hermes-room-overnight-03-red.log`).
- Fix: only a successful answer or pass advances the context cursor. Failed,
  interrupted and timed-out turns cannot falsely mark context consumed.
- Green: **235 focused tests in five files**, typecheck and diff check. The
  retry retains its attempt history and advances the cursor after success.

### Current full regression baseline, 22:30 EDT

- Unit: **392 files / 3,731 tests passed**; same five skipped files, 18 skipped
  tests, one expected failure and one todo. No unexpected failures.
- Electron: **66 files / 1,008 tests passed**, two skipped files/tests.
- Typecheck, production build and diff check: passed. Same Vite warnings as the
  earlier baseline.
- Logs: `/tmp/hermes-room-overnight-03-{unit,electron,build}.log`.
- Next unexamined area: stale asynchronous membership/session-binding results.
  No live serve/UI proof was added. The scheduled work and deadline loops
  remain active; this is a settled iteration boundary, not the overnight end.

### Iteration 4, 22:35 EDT: closed member sessions remint cleanly

- Verified read-only against the installed serve source: cold `session.resume`
  can issue a new runtime ID for the same stored conversation; event sequences
  belong to runtime IDs, not stored IDs.
- Gap: idle session closure left the old runtime attached, and stopped-session
  closure left its quarantine uncleared. A successfully resumed new runtime also
  inherited the old runtime's high event cursor, hiding its first deltas and
  completion.
- Red: three adapter regressions failed for running, idle and stopped members
  (`/tmp/hermes-room-overnight-04-red.log`).
- Fix: closure/reclamation invalidates attachment even without an active turn
  and releases settled quarantine. A different runtime resets its event cursor
  and active turn's replay start cursor; the stored conversation binding stays
  unchanged. The next explicit task resumes, never creates a duplicate session.
- Green: **208 tests in four files**, typecheck and diff check. Each lifecycle
  regression accepts new-runtime events starting at sequence 1, settles the
  next task once and preserves the original stored ID.
- The 22:30 full-suite/build snapshot predates this change. No repeated full
  run is needed for this narrow adapter fix now; final validation remains due
  after the overnight edits.
- Next inspection candidate: late events/requests while a closed runtime's
  asynchronous rebind is still pending. Membership-removal binding races remain
  candidates, not claimed failures. No live proof or service/config changes.

### Iteration 5, 22:46 EDT: fence closed-runtime callbacks during rebind

- Gap: the next task was already claimed while `session.resume` awaited its
  reply. Its binding still referenced the closed runtime, allowing old deltas
  or completions to become output for the new task. Late approval/question
  requests also saw the new task as a valid owner.
- Red: four adapter regressions reproduced stale delta, completion, approval
  and question attribution (`/tmp/hermes-room-overnight-05-red.log`).
- Fix: persist a closed marker in the existing member binding. Closed-runtime
  output and requests stay fenced while resume is pending. Only an authoritative
  resume clears the marker. Idle closure flushes that proof immediately too.
- Green: **240 tests in five files**, typecheck and diff check. The regressions
  reload persisted metadata to verify the marker is saved before rebind and
  cleared after it, reject stale requests, submit the new task once, and accept
  only its own new-runtime answer.
- Full validation remains at the 22:30 snapshot and must be refreshed after
  subsequent edits before the deadline. No live/backend/config changes.
- Next inspection candidate: membership removal while an attachment/member
  binding is pending; whether an attachment session can return a removed owner.

### Iteration 6, 22:54 EDT: attachment bindings revalidate membership

- Gap: a member could be removed while its attachment session create/resume was
  pending, yet the returned binding still supplied that removed profile as the
  upload owner.
- Red: two adapter regressions reproduced the race during `session.create` and
  `session.resume` (`/tmp/hermes-room-overnight-06-red.log`).
- Fix: after binding settles, re-read the current room membership and profile
  before returning the attachment owner. A removed/changed owner produces an
  explicit retryable preparation error, not a silent upload to the old profile.
- Green: **242 tests in five files**, typecheck and diff check. A fresh explicit
  preparation chooses the remaining member. Neither preparation submits a turn.
  The internal binding stays journaled rather than exposing or deleting a
  backend session.
- Full validation still refers to 22:30 and remains due before completion.
  No actual uploads, live serve proof or profile/config/service changes.
- Next inspection candidate: closure arriving while a resume snapshot is
  already pending, rather than before the resume begins.

### Iteration 7, 23:06 EDT: pending resumes cannot erase newer lifecycle proof

- Gap: binding publication spread the metadata captured before awaiting
  `session.resume`. A stop during that wait lost its newer quarantine, allowing
  new work before the old run settled. An idle closure during the wait could
  also be erased by the old same-runtime response.
- Red: quarantine and superseding-closure adapter cases failed
  (`/tmp/hermes-room-overnight-07-red.log`). A third watermark case already
  passed because reconnect buffering protects its live frames; no cursor bug
  is claimed for that case.
- Fix: publish against the latest binding metadata, not the RPC-start snapshot.
  Reject an old same-runtime result superseded by a newer closure. New runtime
  resumes remain allowed and retain the earlier cursor-reset behavior.
- Green: **245 tests in five files**, typecheck and diff check. New queued work
  remains fenced until the old backend completion, closure remains persisted,
  an explicit fresh attachment preparation resumes its replacement, and
  buffered reconnect text is not duplicated.
- Full validation still refers to 22:30 and must be refreshed before completion.
  No live proof or external/config/service changes.
- Next inspection candidate: attachment-only room sends through the composer,
  including whether the adapter accepts an empty caption with real file chips.

### Iteration 8, 23:16 EDT: caption-free room attachments work

- Verified composer behavior: ChatPanel forwards an empty caption when a ready
  uploaded file/image is present. The local room adapter rejected this before
  creating its room root.
- Red: file-only and image-only adapter sends failed; empty/overlength rejection
  guards already passed (`/tmp/hermes-room-overnight-08-red.log`).
- Fix: accept an empty caption only when an attachment supplies a nonblank
  string path. Empty sends, blank-path metadata and captions over 16,000
  characters are still rejected before session creation or submission.
- Green: **252 tests in seven files**, including room composer, paste/upload
  and composer middleware regressions; typecheck and diff check. The adapter
  retains empty-caption chips, puts the path in the member prompt, submits once,
  and settles the answer normally.
- No real upload or live UI/model proof is claimed. Full-suite/build baseline
  remains 22:30 and must be refreshed before completion.
- Next inspection candidate: whether the group mention picker includes the
  account Chief when the room engine automatically seats that profile.

### Iteration 9, 23:23 EDT: account Chief mention roster, no change

- Traced `getMessages`/`watchRoom` publication to the runtime's room-view
  subscription and mention roster. The roster already adds the feed's Chief
  when absent from the group's explicit member IDs, resolves its display name,
  and recomputes on room-view changes. No missing Chief picker behavior found.
- Production code and tests were left unchanged; no manufactured fix.
- Green: **239 existing tests in six files** covering adapter seating, room
  helpers/presence, composer mentions, group editor and group info; diff check.
  Typecheck was not repeated because no code changed since its 23:14 pass.
- No live UI proof added. Full-suite/build baseline remains 22:30.
- Next inspection candidate: retaining the replied-to anchor when a queued
  triggering ask falls outside the bounded shared-context window.

### Iteration 10, 23:37 EDT: retained asks keep their quote anchor

- Gap: a queued reply's short quote was only rendered in its shared-context
  row. If backlog truncation omitted that row, the separately retained ask
  lost who/what it was replying to, despite preserving its own text.
- Red: the quoted reply anchor disappeared behind 60 later room messages
  (`/tmp/hermes-room-overnight-10-red.log`).
- Fix: reuse the same bounded quote in the retained triggering ask. Preserve
  the speaker, request text, attachment note and existing 24,000-character cap;
  avoid scanning the room log for messages that have no reply target.
- Green: **221 focused tests**, typecheck and diff check.

### Refreshed full regression baseline, 23:37 EDT

- Initial full unit run: one unexpected failure in the unrelated profile
  settings test that waits for `Memory · default`. Room tests passed. The same
  settings file passed in isolation (**18 tests**), then the unchanged full
  suite passed. No settings code/test was modified; timing is suspected, not
  proven as the cause. Keep this transient result visible in final reporting.
- Full unit rerun: **392 files / 3,747 tests passed**, five skipped files,
  18 skipped tests, one expected failure and one todo.
- Electron: **66 files / 1,008 tests passed**, two skipped files/tests.
- Typecheck, build and diff check: passed; same Vite warnings.
- Logs: `/tmp/hermes-room-overnight-10-unit.log`,
  `/tmp/hermes-room-overnight-10-unit-retry.log`,
  `/tmp/hermes-room-overnight-10-settings-recheck.log`,
  `/tmp/hermes-room-overnight-10-{electron,build}.log`.
- No live proof or service/config/publication actions.
- Next inspection candidate: Chief wrap eligibility when one specialist asks
  the Chief for attention before a parallel sibling finishes.

### Iteration 11, 23:46 EDT: intermediate Chief answers do not swallow the wrap

- Gap: wrap eligibility checked the latest Chief message, even if it was an
  ordinary answer to a specialist's mid-batch question. That nondelegating
  answer hid the earlier delegated batch, leaving no final wrap when its
  parallel sibling eventually finished.
- Red: both engine and real-adapter fixtures missed the wrap
  (`/tmp/hermes-room-overnight-11-red.log`).
- Fix: locate the latest Chief message that actually started peer work. Keep
  the existing all-members-settled, duplicate-trigger, turn/depth and follow-up
  bounds unchanged.
- Green: **238 tests in six files**, including handoff rendering, typecheck and
  diff check. The ordinary Chief answer can happen while another member works;
  exactly one original-batch wrap follows final settlement. Duplicate member
  completion does not create another turn.
- The full baseline at 23:37 predates this narrow scheduler fix. No repeated
  full suite is needed immediately; refresh completion checks after later edits.
  No live proof or profile/config/service/publication changes.
- Next inspection candidate: trailing partial pass-marker fragments in a
  streaming answer that already contains substantive text.

### Iteration 12, 23:56 EDT: trailing streamed pass fragments stay hidden

- Gap: partial pass-marker suppression only recognized a stream made entirely
  of the marker prefix. Substantive text followed by `[`, `[pa` or `[pass`
  exposed protocol fragments until the remaining characters arrived.
- Red: pure display and adapter stream cases failed
  (`/tmp/hermes-room-overnight-12-red.log`).
- Fix: remove complete pass tokens, then suppress only a trailing candidate
  that still matches the pass marker. Nonmarker brackets such as `[Paragraph`
  and `[passion]` are preserved as soon as distinguishable.
- Green: **247 tests in five files**, including messenger rendering, typecheck
  and diff check. Raw partial text stays intact in the journal; completed
  substantive output is retained with its nonmarker bracketed content.
- Full baseline remains 23:37, before iterations 11/12. No immediate broad
  rerun is needed; final checks remain due after later changes.
  No live/model/UI proof or external/config/service actions.
- Next inspection candidate: retries after a cached member runtime is silently
  retired and prompt submission returns a definite session-not-found error.

### Iteration 13, 00:10 EDT: explicit retry reattaches a silently retired runtime

- Verified installed serve contract read-only: `prompt.submit` rejects a
  missing runtime with code 4001 before accepting work, and directs the client
  to resume the stored conversation. The renderer preserves this typed code.
- Gap: a definite rejection left the dead runtime attached, so every explicit
  retry sent to the same stale ID rather than resuming its stored identity.
- Red: code-4001 retry used the stale runtime; the provider-error control case
  already passed (`/tmp/hermes-room-overnight-13-red.log`).
- Fix: invalidate/fence the cached binding only for typed 4001 submission
  rejection. Persist definite failed outcomes promptly. An explicit retry then
  resumes the existing stored conversation; no automatic resubmission added.
- Green: **255 tests in five files**, typecheck and diff check. The missing
  runtime case reattaches once, creates no extra session or human echo, accepts
  the new runtime's answer starting at sequence 1, and keeps the completed
  prior answer. Unrelated provider refusal retains its original binding.
- Full baseline remains 23:37 and predates iterations 11–13. No live proof,
  profile/config edits, service operations or publication.
- Next inspection candidate: uncertain acceptance classification for the
  serve client's actual socket-close and timeout exception messages.

### Iteration 14, 00:19 EDT: native acknowledgement loss is not retryable failure

- Gap: uncertain-acceptance matching recognized `timeout` and `disconnect`,
  but the real client emits `WebSocket closed` and `request timed out`.
  Accepted work was incorrectly settled as a retryable submission failure.
- Red: withheld backend acknowledgements, then exercised actual relay socket
  closure and the native 120-second request timer. Both cases lost their live
  room turn (`/tmp/hermes-room-overnight-14-red.log`). An initial literal `%s`
  test filter selected no cases; corrected before collecting red evidence.
- Fix: match the actual client close/timeout messages. Accepted turns remain
  blocked for reconciliation instead of permitting duplicate submission.
- Green: both native loss cases reject explicit retry while backend work is
  active, settle the original answer once, ignore the late acknowledgement,
  and keep one human echo and one submission. **257 focused tests**,
  typecheck and diff check pass. Fixed a missing test helper reference exposed
  after the behavioral assertion turned green.
- Refreshed full validation for iterations 11–14:
  - `npm run test:unit`: **3,755 passed**, existing 1 expected-fail,
    18 skipped and 1 todo.
  - `npm run test:electron`: **1,008 passed**, 2 skipped.
  - `npm run typecheck`, `npm run build`, `git diff --check`: pass.
  - Logs: `/tmp/hermes-room-overnight-14-{unit,electron,build}.log`.
    Existing build warnings remain; no unrelated cleanup.
- Controlled adapter/client evidence only, not live model or installed UI
  proof. No service/profile/config/reference changes or publication.
- Next inspection candidate: late submission replies after an explicit retry
  reuses a failed turn ID, ensuring callbacks belong to the same attempt.

### Iteration 15, 00:28 EDT: asynchronous callbacks retain attempt ownership

- Gap: explicit retry preserves a turn ID, but submission callbacks only
  checked that ID and running status. An old rejection or ambiguous reply
  could fail the new attempt. An old successful reply could remove the new
  attempt's starting marker, exposing it to premature idle reconciliation.
- Red: three adapter cases hold the original acknowledgement, fail/close its
  runtime, then retry with resume pending. Late rejection and nonstreaming
  acknowledgement fail the retry; late success causes a repeated retry to
  enter its pending bind instead of promptly refusing
  (`/tmp/hermes-room-overnight-15-red.log`).
- Fix: use the existing attempt-history count to identify submission
  callbacks and starting-marker cleanup. No new persisted field or turn ID
  changes.
- Green: **260 tests in five files**, typecheck and diff check. All three late
  replies leave the retry alive; a repeated retry refuses while binding;
  the new runtime's answer settles once with one human echo and two intended
  submissions. Original failed attempt remains in the journal history.
- Latest full validation remains 00:19 and predates this fix. No extra broad
  rerun immediately after that baseline. Controlled fixture evidence only;
  no live/service/profile/config/reference/publication actions.
- Next inspection candidate: attachment-only draft member bindings after a
  native backend restart, before any prompt was ever submitted.

### Iteration 16, 00:34 EDT: unused attachment draft recovery, no change

- Inspected empty member drafts before first submission. Native
  `session.create` intentionally defers its DB row, but installed
  `_resume_materialize_minted` explicitly handles a well-formed minted key
  after process loss. It preserves that identity and creates its empty row
  under the requested profile before normal resume.
- Desk already stores the server-issued key, supplies the owning profile
  and `omit_messages`, and does not set `lazy` (which would skip this native
  materialization path). No verified adapter bug; implementation and tests
  left unchanged. No create fallback added that could discard identity or
  duplicate uncertain work.
- Existing related attachment, reopen, closed-idle and attachment-owner
  tests: **7 pass**; typecheck and diff check pass.
- Native materialization is source-contract evidence, not a live cold-process
  restart test. Older backends without that native fix are not verified.
  Latest full baseline remains 00:19, before iteration 15.
- Next inspection candidate: stale event/request ownership after a closed
  runtime's replacement has fully attached (rather than while resume waits).

### Iteration 17, 00:46 EDT: obsolete runtime ownership, no change

- Traced modern approval/clarify requests and streamed delta/completion
  events after replacement attachment. The binding no longer maps the old
  runtime; requests receive “Session is not open,” and stream handlers return
  when no conversation matches. Native DM lookup is by session identity,
  not a profile-only fallback, so seating the same profile elsewhere does
  not give the obsolete runtime another conversation.
- No verified gap in these modern paths; implementation/tests unchanged.
- Existing remint, closure-window, room/DM isolation and concurrent profile
  regressions: **9 pass**; typecheck and diff check pass.
- Fully attached obsolete-runtime handling is source-trace evidence here;
  the selected fixtures cover adjacent remint/closure/isolation behavior.
  No new live/model/UI proof or service/config/profile/publication actions.
  Latest full baseline remains 00:19, before iteration 15.
- Next inspection candidate: legacy notification-based group questions and
  approvals obey the same active-member and closure gates as modern requests.

### Iteration 18, 00:59 EDT: legacy room request lifecycle gates and cleanup

- Gaps: notification-based legacy questions/approvals bypassed the modern
  active-member gate. Stopped, closed and removed members could open cards.
  A legacy approval already displayed while active also survived room stop,
  unlike its clarify counterpart.
- Red: all six late notification cases failed
  (`/tmp/hermes-room-overnight-18-red.log`). Active legacy approval cleanup
  failed; active clarify cleanup already passed
  (`/tmp/hermes-room-overnight-18-cleanup-red.log`).
- Fix: apply the existing group request-acceptance gate before legacy
  notification handling, and clear a displayed permission when its exact
  room/session terminates. Preserve an available modern sibling permission.
  Legacy DM handling and secure-prompt refusal remain unchanged.
- Green: **268 tests in five files**, typecheck and diff check. Active legacy
  cards still appear; room stop clears them and a subsequent response sends
  no stale answer. Late inactive notifications neither render nor trigger
  legacy response RPCs. Existing modern sibling/request ownership and DM
  legacy reconnect tests remain green.
- Controlled fixture evidence, not live old-backend/model/UI proof.
  Latest full baseline is 00:19 and predates iterations 15/18.
- Next inspection candidate: active legacy group clarify prompts include the
  same member attribution as modern peer requests.

### Iteration 19, 01:05 EDT: legacy group question member attribution

- Gap: active legacy clarify cards carried the session ID but omitted the
  member metadata consumed by the existing “Writer asks” heading.
- Red: parallel Writer/Coder notification questions lacked both owners'
  member fields (`/tmp/hermes-room-overnight-19-red.log`).
- Fix: attach the trusted member identity/name resolved from the bound
  runtime, matching modern question metadata. Answer RPCs remain unchanged.
- Green: **284 tests in six files**, including question-card rendering,
  typecheck and diff check. Parallel owners remain distinct; answering Writer
  sends only its original request ID, and Writer completion leaves Coder's
  labelled pending question intact. Native DM legacy behavior remains green.
- Controlled adapter/UI fixtures only. No live/model/old-backend proof or
  service/profile/config/reference/publication changes. Latest full baseline
  remains 00:19 and predates iterations 15/18/19.
- Next inspection candidate: historical room message speaker labels after
  membership or profile-roster changes and journal restoration.

### Iteration 20, 01:20 EDT: restored historical speaker names reach the shell

- Gaps: the journal retained a departed speaker's name, but local publication
  never fed messages into the existing learned-name helper. The shell's chat
  callback also used roster-only lookup, bypassing that fallback.
- Red: restoring history without the profile returned `profile:default`
  rather than `Writer`; the actual shell callback returned the raw departed
  ID even when its name was learned
  (`/tmp/hermes-room-overnight-20-{red,ui-red}.log`).
- Fix: learn journal speaker names before current member names on publication,
  and use the existing roster-first name resolver in the shell callback.
  No new state fields or duplicate name registry.
- Green: **328 focused tests in seven files**, typecheck and diff check.
  Restored history keeps the departed identity without another submission;
  shell lookup uses the historical name, prefers the current roster when
  present, and preserves unknown-ID fallback.
- Full refresh after iterations 15/18/19/20:
  - `npm run test:unit`: **3,769 pass**, existing 1 expected-fail,
    18 skipped and 1 todo.
  - `npm run test:electron`: **1,008 pass**, 2 skipped.
  - `npm run typecheck`, `npm run build`, `git diff --check`: pass.
  - Logs: `/tmp/hermes-room-overnight-20-{unit,electron,build}.log`;
    existing theme/import/chunk build warnings remain.
- Controlled adapter and actual shell-prop fixtures, not installed UI or
  live model/service proof. Preserved pre-existing App edits.
- Next inspection candidate: quoted attachment-only messages retain useful
  file context when their original row falls outside the shared backlog.

### Iteration 21, 01:41 EDT: quoted attachment-only originals retain file paths

- Gap: reply anchors only included a bounded text snippet. A caption-free
  attachment original outside the shared backlog became an empty quote,
  giving a fresh responder none of the files it was asked to inspect.
- Red: pure engine and real-adapter prompt cases omitted the original paths
  after 60 backlog messages (`/tmp/hermes-room-overnight-21-red.log`).
- Fix: append the existing attachment-note format to the reply anchor,
  separate from its 120-character text preview. Keep full paths and internal
  spacing; retain the existing total prompt bound.
- Green: **294 tests in six files**, typecheck and diff check. Both paths,
  including a long valid filename and a double-space filename, reach the
  fresh member while the caption-free original remains outside backlog.
  Existing quoted text, full accepted ask and attachment behavior remain
  green; tested payloads remain within 24,000 characters.
- Controlled prompt fixtures only, not live file reads/model proof. Latest
  full baseline remains 01:20, before this formatter change.
- Next inspection candidate: metadata-heavy shared-context budgeting retains
  the newest unseen updates rather than cutting them from the final payload.

### Iteration 22, 02:03 EDT: rendered metadata budgeting preserves newest context

- Gap: shared-context selection charged text plus a fixed 200-character
  estimate, ignoring real attachment/quote metadata. Final prefix clipping
  then silently dropped the newest updates instead of older rows.
- Red: a latest “inspect only, make no writes” shared update disappeared in
  engine short/full-length ask cases and the adapter's fresh-member payload
  (`/tmp/hermes-room-overnight-22-red.log`).
- Fix: reserve the triggering ask and omission marker first, avoid copying
  that already-reserved ask into shared context, then budget complete rendered
  rows newest-first. Preserve chronological order for selected rows and do
  not clip their joined payload from the newest end.
- Green: **297 tests in six files**, typecheck and diff check. Latest safety
  context survives normal and 16,000-character asks; recent attachment
  updates remain in the short case, full asks remain intact, omissions are
  disclosed, and payloads stay within 24,000 characters.
- Controlled engine/adapter evidence only. No live execution/model proof,
  profile/config/service/reference changes or publication.
  Latest full baseline remains 01:20, before iterations 21/22.
- Next inspection candidate: text-budget truncation does not split UTF-16
  surrogate pairs in shared snippets, quote anchors or member labels.

### Iteration 23, 02:21 EDT: Unicode-safe room prompt clipping

- Gap: UTF-16 string slicing could leave half an emoji in shared previews,
  quote anchors, purpose text and member descriptions. UTF-8 encoding then
  changed the submitted text to a replacement character.
- Red: three engine clipping cases and one fresh-member adapter case failed
  exact UTF-8 round-trip checks on valid Unicode input
  (`/tmp/hermes-room-overnight-23-red.log`).
- Fix: private room-text clipping helper drops a trailing high surrogate at
  a character-budget boundary. Use it for prompt string limits, including
  combined peer/outcome lists and reserved asks. Keep existing budgets and
  full journal text; this is not a general malformed-input sanitizer.
- Green: **301 focused tests**, typecheck and diff check. Controlled UTF-8
  payload round-trips now preserve clipped strings exactly; existing accepted
  asks, attachments, quotes, metadata budgets and room behavior stay green.
- Accumulated full refresh for iterations 21–23: **3,778 unit tests pass**
  (one expected failure, 18 skipped, one todo); **1,008 Electron tests pass**
  (two skipped); typecheck, build and diff check pass. Existing theme script,
  mixed-import and large-chunk build warnings remain. Logs:
  `/tmp/hermes-room-overnight-23-{unit,electron,build}.log`.
- No live model/installed-UI or native provider-encoding proof. No service,
  profile/config, reference changes, commits or publication.
- Next candidate: attachment-only reply preview in the room UI, distinct
  from the backend quoted-file context already fixed in iteration 21.

### Iteration 24, 02:36 EDT: whitespace-only attachment reply previews

- Inspection: empty captions already used the attached filename in the
  room reply preview. Whitespace-only captions were truthy before snippet
  trimming, so the same attachment instead appeared as “(empty)”.
  Local-room sends accept whitespace captions with usable uploaded paths.
- Red: helper and actual room-composer whitespace cases failed, while two
  empty-caption controls passed (`/tmp/hermes-room-overnight-24-red.log`).
- Fix: trim the caption before deciding whether to use the existing
  first-attachment filename fallback. No new preview format or RPC fields.
- Green: **276 tests in six files**, typecheck and diff check. Room reply
  composer shows the filename and submits the correct original message ID
  and snippet for both caption forms; existing plain-text replies remain green.
- Initial typecheck caught missing IDs on new attachment fixtures; supplied
  the required IDs and reran all affected checks successfully. The associated
  React list-key warning disappeared on the corrected rerun.
- Controlled rendered UI/helper evidence only, not installed UI/model proof.
  Latest full baseline is 02:21 and predates this one-line fallback change.
- Next inspection candidate: room reply-target lifetime when switching rooms.

### Iteration 25, 02:43 EDT: room-switch reply-target isolation, no code change

- Source trace: runtime thread keys are the selected conversation ID; the
  chat panel clears reply targets on key changes. Send completion, explicit
  cancellation and Escape also clear them. No verified target carry-over gap.
- Left implementation and tests unchanged. Existing adjacent room-composer,
  message-action and messenger coverage: **47 tests pass**; typecheck and
  diff check pass. This is source evidence for the exact switch reset, not
  a newly added switch regression or installed-UI proof.
- Latest full baseline remains 02:21; iteration 24's one-line filename
  fallback is the only implementation change since that full run.
- Next candidate: failed room-member turn retry affordance attribution.

### Iteration 26, 02:56 EDT: retry attribution, no code change

- Source trace: generic chat retry means the latest human request, not the
  member behind a clicked row. Local room retry also selects that latest
  root; the engine selects eligible failed turns and excludes uncertain or
  blocked bindings. Failed room turns show via member-labelled quiet status
  and handoff pills, not ordinary error bubbles.
- No verified wrong-member submission path. Left implementation and tests
  unchanged. **286 adjacent tests** pass; typecheck and diff check pass.
  Existing fixtures cover failure attribution and guarded retry behavior;
  exact UI-to-live-model attribution remains unproven.
- Possible UX limitation, not fixed or claimed as a verified regression:
  retry discoverability after the first room submission fails before any
  agent reply exists. Inspect that rendered state separately before changing
  controls; do not introduce per-member semantics or bypass uncertain-outcome
  fences under the existing latest-request callback.
- Latest full baseline stays 02:21; only iteration 24's filename fallback
  changed implementation afterward. No live/service/profile/reference or
  publication actions.

### Iteration 27, 03:13 EDT: discoverable safe latest-request room retry

- Gap verified from iteration 26's UX candidate: after the first request
  fails before an agent reply, no ordinary error bubble exists, so there
  was no discoverable retry control despite eligible runner work.
- Red: engine eligibility propagation, status availability and rendered
  first-failure control tests failed (four failures, nine passing controls/
  adjacent cases; `/tmp/hermes-room-overnight-27-red.log`).
- Fix: local recent-turn DTOs expose conservative eligibility, matching
  retryable outcome/current membership/unblocked-binding requirements.
  Status permits retry only for explicitly eligible failed/timeout turns
  of the latest root, after room work settles. Missing legacy flags do not
  grant permission. A “Try failed members again” control reuses the existing
  latest-request callback and pending/error handling, not per-member semantics.
- Guard fixtures cover uncertain, blocked, removed, missing-flag, live,
  old-root and read-only states. New control remains available even without
  agent rows; no automatic submission or new native RPC fields.
- Green: **317 focused tests**, typecheck/diff. Full initial run hit the
  recurring settings “Memory · default” lookup failure; isolated settings
  file passed **18 tests**, then the unchanged full rerun passed **3,796 unit
  tests** (one expected failure, 18 skipped, one todo). **1,008 Electron
  tests**, typecheck, build and diff pass. No settings edits.
  Existing theme script/mixed-import/large-chunk warnings remain.
  Logs: `/tmp/hermes-room-overnight-27-{unit,unit-rerun,settings,electron,build}.log`.
- Controlled engine/status/rendered UI evidence and existing adapter guards,
  not live UI-to-model resubmission proof. Native acceptance fences remain
  authoritative if state changes after rendering.
- Next candidate: restored failed-room journals expose safe retry availability
  after boot without auto-submitting.

### Iteration 28, 03:24 EDT: restored retry availability, no code change

- Source trace: saved terminal outcome/retryability flags remain intact in
  the restored engine. Recovery handles running/quarantined sessions, then
  republishes fresh eligibility from the journal. Terminal failures are not
  changed to queued work; only explicit retry performs that transition.
- No verified restoration gap. Implementation and tests unchanged.
  **274 adjacent persistence/engine/adapter/status/composer tests** pass;
  typecheck and diff check pass. Existing restart fixtures prove no duplicate
  submissions for their cases. The exact restored failure-to-new-button
  path is source evidence, not a new fixture or live model/UI proof.
- Latest full baseline remains 03:13 and covers all current implementation.
  Recurring settings full-run lookup flakiness remains documented, not fixed.
- Next candidate: Unicode clipping in UI reply previews (distinct from the
  backend room prompt clipping fixed in iteration 23).

### Iteration 29, 03:35 EDT: Unicode-safe UI reply previews

- Gap: the UI preview helper could split an emoji before appending its
  ellipsis. Room reply pills and outgoing quote metadata then held malformed
  strings, separate from the backend room prompt formatter.
- Red: five helper/rendered-room cases failed exact UTF-8 round-trip checks
  at the 72/96/120-character boundaries
  (`/tmp/hermes-room-overnight-29-red.log`).
- Fix: drop a dangling high surrogate from the clipped preview prefix,
  retaining the existing ellipsis format, whitespace trimming and caps.
  Whole emoji below the boundary remain unchanged; full message text is not
  modified. Not a general malformed-input sanitizer.
- Green: **289 tests in six files**, typecheck/diff. Both room pill and
  submitted reply metadata stay UTF-8-safe, preserve the source ID, and
  existing filename/plain-text previews remain green.
- Controlled helper/rendered UI evidence only. Latest full baseline is
  03:13, before this two-line preview change; no live provider/UI proof or
  service/profile/reference/publication actions.
- Next candidate: mention routing with similarly prefixed/spaced member names.

### Iteration 30, 03:48 EDT: exact display names beat colliding shorthand

- Existing longest-prefix and shared-first-word cases were already covered.
  New gap: with “Data Ops” seated before “DataOps”, `@DataOps` matched the
  former's no-space alias. The explicit display name selected the wrong
  profile, and highlighting agreed with that wrong selection.
- Red: parser, span, engine and real-adapter cases failed; the adapter
  submitted to `default` instead of `backend-eng`
  (`/tmp/hermes-room-overnight-30-red.log`).
- Fix: build exact-name handles before aliases. Stable longest-handle sorts
  retain that priority only at equal-length ties. Keep textual order,
  longest-prefix matching and ambiguous shared-first-word suppression.
- Green: **315 affected tests**, typecheck/diff. Exact-name adapter payload
  reaches the intended isolated profile; spaced full name still routes to
  its own member. No profile/config or native RPC changes.
- Full refresh covers iterations 29/30: **3,805 unit tests** pass (one expected
  failure, 18 skipped, one todo); **1,008 Electron tests** pass (two skipped);
  typecheck/build/diff pass. Settings lookup failure did not recur on this run.
  Existing theme script, mixed-import and large-chunk warnings remain.
  Logs: `/tmp/hermes-room-overnight-30-{unit,electron,build}.log`.
- Controlled fixtures only; live model/UI proof remains unavailable.
- Next candidate: case folding that changes UTF-16 length does not shift
  original-text mention highlight offsets.

### Iteration 31, 03:57 EDT: original mention offsets after Unicode folding

- Gap: lowercasing `İ` expands its UTF-16 length. Folded mention offsets
  sliced the wrong original characters, shifting highlight labels and
  stripping substantive short handoff text as if it were only an ack.
- Red: three span cases, a rendered message-body case and a Chief handoff
  case failed (`/tmp/hermes-room-overnight-31-red.log`).
- Fix: when lowercase changes length, map folded boundaries to original
  UTF-16 boundaries before exposing spans. Keep matching rules, IDs and
  normal-length fast path unchanged.
- Green: **317 tests in six files**, typecheck/diff. Original-text labels,
  expanded-character member names and `@everyone` offsets are correct.
  The substantive short handoff is no longer suppressed and queues its
  intended profile. Existing alias/routing/body/composer cases remain green.
- Controlled span/rendered UI/engine evidence only, not live model proof.
  Latest full baseline is 03:48, before this offset-mapping change.
- Next candidate: word boundaries beside supplementary-plane letters/digits
  are checked as full code points rather than isolated surrogate halves.

### Iteration 32, 04:07 EDT: full-code-point mention word boundaries

- Gap: boundary tests received isolated surrogate halves instead of full
  supplementary-plane letters/digits. Address-like tokens falsely selected
  peers, and `@all` followed by a supplementary digit falsely broadcast.
- Red: four boundary cases, engine routing and adapter profile submission
  failed; an emoji-separator control passed
  (`/tmp/hermes-room-overnight-32-red.log`).
- Fix: Unicode-aware before/after boundary checks inspect bounded two-unit
  windows. Keep existing letter/digit/underscore categories; emoji remain
  non-word separators. No profile/native contract changes.
- Green: **324 affected tests**, typecheck/diff. False peer/broadcast routing
  and spans disappear; the address-like adapter case uses the intended Chief
  fallback rather than the named specialist profile.
- Full refresh covers iterations 31/32: **3,817 unit tests** pass (one expected
  failure, 18 skipped, one todo); **1,008 Electron tests** pass (two skipped);
  typecheck/build/diff pass. Existing build warnings remain; settings lookup
  flakiness did not recur. Logs:
  `/tmp/hermes-room-overnight-32-{unit,electron,build}.log`.
- Controlled fixtures only; live model/installed UI evidence unavailable.
- Next candidate: pending and failed-callback feedback on the new room retry
  control, distinct from its already-verified availability guards.

### Iteration 33, 04:15 EDT: room-root-owned control feedback

- Gap: the stop/retry request fence reset only on conversation changes.
  A newer human root in the same room inherited an older retry's busy state;
  its late false result could display a stale failure notice.
- Red: two rendered-room cases failed, blocking a newer retry and leaking
  the older error (`/tmp/hermes-room-overnight-33-red.log`).
- Fix: reset control ownership on the latest room root ID as well as the
  conversation ID. Reuse the existing request-token fence, not a new retry
  path; same-root deduplication and non-room behavior remain unchanged.
- Green: **317 tests in six files**, typecheck/diff. A newer root can start
  its own request; an older callback cannot clear its busy state or add a
  stale error. Existing stop/retry failures, duplicate-click and conversation
  round-trip fences remain green.
- Controlled rendered UI evidence only. Latest full baseline is 04:07 and
  predates this one-line effect-dependency change.
- Next candidate: authoritative session bind responses cannot silently
  select a different Hermes profile than the requested room member.

### Iteration 34, 04:24 EDT: bind-response profile checks, no code change

- Source trace: shared create/resume binding already rejects a missing
  runtime ID or an explicit `info.profile_name` mismatch before saving a
  binding, publishing requests or submitting a prompt. Attachment binding
  reuses that path and separately revalidates current member/profile.
- No verified gap; implementation and tests unchanged. **231 adjacent
  adapter/engine/persistence tests** pass, plus typecheck/diff.
  The exact mismatch rejection is source evidence, not a new negative
  room fixture or live service proof.
- Missing profile-info metadata remains intentional compatibility behavior,
  not positive profile identity evidence. Native session scoping remains
  authoritative; no stricter unsupported response contract was invented.
- Latest full baseline stays 04:07; only iteration 33's effect dependency
  changed implementation afterward.
- Next candidate: room sends when no current local members can be resolved.

### Iteration 35, 04:34 EDT: unresolved room members, no code change

- Source trace: members must resolve to local profile IDs with valid profile
  slugs. Account Chief seating can supply a responder when available.
  After recovery, sends reject an empty current roster before appending the
  human row or starting new room work. Membership subscription updates that
  roster during asynchronous recovery.
- No verified gap; implementation and tests unchanged. **265 adjacent
  adapter/engine/room tests** pass; typecheck/diff pass. The exact empty-roster
  rejection is source evidence, not a new negative fixture or live proof.
- Latest full baseline stays 04:07; iteration 33's control dependency is the
  only implementation change afterward.
- Next candidate: known long member names in leading speaker-label brackets
  do not leak duplicate labels into local room replies.

### Iteration 36, 04:45 EDT: normalize known long speaker brackets

- Gap: bracket-label candidates were capped at 24 characters even though
  valid member display names can be longer. Known labels leaked into final
  transcript text, and a known long label plus `[pass]` became a fake answer.
- Red: two parser cases and the real-adapter final transcript case failed;
  an unknown long bracketed-content control passed
  (`/tmp/hermes-room-overnight-36-red.log`).
- Fix: remove the arbitrary candidate-length cap. Still strip only known
  names or the existing short speaker-code format; do not strip arbitrary
  long bracket content. Keep profile-native replies otherwise unchanged.
- Green: **309 tests in six files**, typecheck/diff. Final adapter row holds
  only the answer under its owning member ID; labelled pass normalizes to
  pass and unknown bracketed content stays intact.
- Controlled parser/adapter evidence only. Latest full baseline is 04:07,
  before iterations 33/36; no live model/UI or native contract changes.
- Next candidate: live versus final known speaker-label normalization.

### Iteration 37, 04:55 EDT: consistent displayed stream labels

- Gap: known bracket/bold-colon speaker labels disappeared from final replies
  but remained in live reply text, including labelled pass-only output.
- Red: three engine/feed cases plus the real-adapter streaming transcript
  case failed (`/tmp/hermes-room-overnight-37-red.log`).
- Fix: share the existing leading-label cleanup with displayed partials,
  using current room names. Preserve trailing spaces and raw journal deltas;
  unknown bracketed content and incomplete pass-fragment handling stay intact.
- Green: **313 tests in six files**, typecheck/diff. Initial green run exposed
  a new assertion assuming final rows contain `streaming: false`; the DTO
  omits that optional field. Corrected the fixture assertion to require an
  actual nonstreaming agent row, then reran all affected checks successfully.
- Full integration baseline refreshed for iterations 33/36/37: **3,827 unit
  tests** (one expected failure, 18 skipped, one todo), **1,008 Electron**
  (two skipped), typecheck/build/diff pass. Logs:
  `/tmp/hermes-room-overnight-37-{unit,electron,build}.log`.
  Existing theme script/mixed imports/large chunk build warnings remain;
  no recurring settings Memory failure on this run.
- Controlled fixture evidence only; no installed/live model UI claims.
- Next candidate: roster display-name changes while a member turn is active.

### Iteration 38, 05:05 EDT: retain the active turn's label identity

- Gap: after a roster rename, the old label emitted by an already-submitted
  member reply became unknown. It leaked into displayed/final text and
  converted labelled passes into fake answers, including restored turns.
- Red: four engine live/restored answer/pass cases and two real-adapter
  active/pending-bind rename cases failed
  (`/tmp/hermes-room-overnight-38-red.log`).
- Fix: optional per-turn `memberName` snapshots at claim and actual
  submission. Use that owned name alongside current roster names only for
  label cleanup; keep actual sender identity and current UI names unchanged.
  A bind-time rename is captured immediately before prompt creation.
- Green: **342 tests in seven files**, typecheck/diff. New retry control
  proves the next attempt replaces the snapshot and does not indiscriminately
  remove an old name bracket from real content.
- New snapshots survive journal restore without a schema migration.
  Legacy journals without the optional name keep current-name fallback;
  they cannot reconstruct an unknown past label retroactively.
- Controlled fixture evidence only. Latest full baseline is 04:55,
  before this optional journal-field and normalization change.
- Next candidate: replying to a departed member's historical row uses a
  current responder without reopening the departed member's session.

### Iteration 39, 05:13 EDT: historical departed-member reply, no code change

- Source trace: reply routing uses a historical agent only if that member
  remains seated. Otherwise it uses current Chief/ranked members; explicit
  current mentions still take precedence. The historical quote and speaker
  label remain context, not a request to reopen that speaker's binding.
- Recovery visits running turns/quarantined bindings, not settled retired
  bindings. A quarantined removed member may still be reconciled for cleanup;
  that is not a new prompt or revived room participation.
- No verified gap; implementation/tests unchanged. **280 adjacent tests**
  plus typecheck/diff pass. Exact departed-reply fallback is source evidence,
  with existing adjacent removal/reply/restore fixtures, not a new negative
  fixture or live model evidence.
- Latest full baseline is 04:55 and predates iteration 38. Final validation
  remains due if no further integration baseline refresh occurs.
- Next candidate: hiding a room versus deleting it during active work.

### Iteration 40, 05:23 EDT: hide versus delete, no code change

- Source trace: hiding retains the conversation, room journal, messages and
  bindings; only sidebar metadata/selection change. The room runner tests
  actual conversation/group existence, not sidebar visibility, so hide does
  not cancel active work. Delete removes the conversation and activates the
  existing cancellation/tombstone/event fences.
- Local active transport does not install a hosted conversation sync sink.
  No unexpected outside write path was found for this metadata action.
- No verified gap; implementation/tests unchanged. **278 adjacent
  store/active-transport/adapter/engine tests**, typecheck/diff pass. Exact
  active-room hide continuation is source evidence; existing generic store,
  pending DM hide and room deletion fixtures are adjacent, not new live proof.
- Latest full baseline is 04:55 and still predates iteration 38. Final full
  validation remains due after that optional name snapshot change.
- Next candidate: copying/exporting local room transcripts preserves distinct
  speaker labels without exporting internal routing prompts.

### Iteration 41, 05:33 EDT: per-message copy content, no code change

- Source trace: ChatPanel offers per-message plain-text copy, not a whole-room
  transcript exporter. It intentionally copies the displayed body without
  adding sender labels. Room sender identity remains in the transcript row.
  Copy reads ChatMessage content, not private turn `submittedText` or bindings.
- No verified output/privacy gap; no new export feature or changed clipboard
  format invented. Implementation/tests unchanged. **296 adjacent clipboard,
  adapter/feed/engine tests**, typecheck/diff pass.
- Exact room-copy-to-private-journal separation is source evidence with
  adjacent controlled clipboard/feed tests, not a new room-copy fixture,
  OS clipboard interaction or live model/UI proof.
- Latest full baseline remains 04:55, predating iteration 38. Final validation
  is still needed after that optional label snapshot change.
- Next candidate: local-room handoff detail inspection from the rendered strip.

### Iteration 42, 05:44 EDT: handoff detail inspection, no code change

- Source trace: strip clicks carry owning row/turn IDs into the existing
  client-built transcript modal. Local feed handoffs use matching trigger,
  root and message fields; no invented native per-turn log RPC is needed.
  Modal replies use the existing reply callback; the combined disabled/
  read-only guard removes the reply form.
- No verified gap; implementation/tests unchanged. **237 adjacent modal,
  strip/transcript/adapter tests** pass. Exact local strip-to-modal chain is
  source evidence with existing adjacent UI/data fixtures, not new live proof.
- Full validation refreshed after iteration 38: **3,834 unit tests**
  (one expected failure, 18 skipped, one todo), **1,008 Electron**
  (two skipped), typecheck/build/diff pass. All four required npm commands
  completed successfully. Logs:
  `/tmp/hermes-room-overnight-42-{unit,electron,build}.log`.
  Existing theme-script/mixed-import/large-chunk warnings remain. No settings
  Memory failure or unresolved test failure on this final full run.

### Closing readiness, 05:44 EDT

- Implementation ended with iteration 38; iterations 39–42 changed only this
  checkpoint. The current full baseline covers every implementation change.
  From 05:45 onward, validation/checkpoint only, no new code edits.
- Evidence remains controlled fixtures/source inspection, not live model or
  installed UI proof. Missing profile-info compatibility and legacy turn
  journals without past label snapshots retain their documented limits.
- User work preserved. No installs, profiles/config changes, service starts,
  reference edits, outside-platform writes, commits, pushes or deployments.
- Leave both session loops active for the deadline closing report. At/after
  06:00 EDT, identify/cancel only work loop `9d6841d2` and deadline loop
  `15b6abac`.

### Final window, 05:52 EDT / 09:52 UTC

- No new code edits. No source, Electron, script or root build/test-input
  files newer than the final validation completion were found. Diff check
  remains green; only this checkpoint changed afterward in this session.
- The 05:44 full baseline is still current: **3,834 unit**, **1,008 Electron**,
  typecheck/build pass, with the previously documented expected/skipped tests
  and build warnings. No redundant full rerun or further implementation.
- Deadline loop remains responsible for the 06:00 EDT closing report and
  cancellation of only this session's two local-room loops.
