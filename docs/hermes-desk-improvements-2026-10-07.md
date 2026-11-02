# Hermes Desk improvement follow-up, 2026-10-07

This pass builds on the existing local changes recorded in
[the remediation ledger](hermes-desk-gap-remediation-2026-10-07.md).
It is a targeted correctness and usability review, not a complete security audit.
Existing user work was preserved. Nothing was committed, published, or installed.

## Fixed and reproduced

### Floating message actions were unreachable by a slow pointer

The messenger toolbar floats four pixels away from its message. Crossing that
empty gap fired `onPointerLeave`, unmounting Copy, Reply, and More before the
pointer reached them. Checking the button with `elementFromPoint` alone did
not test this interaction.

A transparent hit-testable bridge now spans the gap for both above and below
placements. It does not change bubble dimensions, transcript height, or scrolling.
The rendered hover harness now pauses inside the gap and then moves to Copy.
Nine cases pass at 1440, 960, and 390 pixels, including both placements and
keyboard focus. The new traversal check failed before the CSS fix.

### Late session snapshots could create phantom active turns

A `session.resume` response reporting an earlier `running` or `inflight` state
could arrive after the live `message.complete` event and revive a finished turn.
It could also replace a newer prompt's tracking object, preventing that prompt's
own rejection from clearing it.

Pending session-binding calls now remember completions and their sequence
watermarks. Live completion wins over the stale snapshot, including when a resume
returns a reminted runtime ID and an older start is replayed. Binding preserves
newer turn identity and fills missing profile metadata.

The regressions exercise both main-owned and renderer-owned calls. Both failed
before the fix. No active turn is cleared merely because an interrupt was acknowledged.

### A failed main-process send could leave an unsent prompt active

`callOn` recorded an active prompt before sending its frame, but did not undo
that record when sending failed. This affects main-owned submissions such as
notifying an agent after sharing a workspace tab.

Send failure now removes only the turn created by that submission. An already
running turn remains active. The regression failed before the fix.

### Stop incorrectly queued more work after interruption

The original golden failure reproduced with a single slow turn, without preceding
parallel work. Stop paused lanes and interrupted the turn, but `stopAll` also
emitted the physical `user-input` takeover event. The MCP takeover listener
responded with `session.steer`, queuing a workspace instruction that could start
another turn after the interrupted completion.

The diagnostics now retain event sequence numbers, completion status, and
interrupt request/response timestamps. Outgoing RPC diagnostics retain method,
socket, request ID, session ID, and profile only, never prompt or secret values.
Those diagnostics identified the unwanted steering call; the earlier evidence
alone could not locate the source of the newer `message.start`.

`registerMcp` now exposes its existing lane cancellation operation, and Stop calls
it directly instead of simulating physical takeover. Both hard Stop and the tray's
pause-only path cancel queued/active browser work without steering. Actual
physical takeover still cancels work and notifies the agent.

The boot and real MCP socket regressions failed before the fix. Golden E2E now
passes, including assertions that Stop sends an interrupt but no takeover steer,
reaches an `interrupted` completion, pauses every lane, and stays settled through
subsequent computer-preview UI activity. The parallel scenario also waits for
completion before the separate Stop scenario begins. No upstream Hermes files
were changed.

### Follow-up: connecting/connected cycles ejected the composer caret

The user's text remained intact, but a connection transition disabled the
textarea and removed keyboard focus. Drafting now depends on having a usable
conversation, not the connection state. Send, server-backed controls, and
pasted attachment uploads remain unavailable offline. Real reconnects preserve
the draft and caret without forcibly stealing focus back from other controls.

The repeated transitions had a second cause: `serveConfig` exposes the app-owned
REST proxy, whose port differs from Hermes's actual port. The renderer compared
those ports on healthy host-status updates and closed its own relay. That
comparison is removed. Actual outages still close the relay; main still closes
the broker when the real endpoint changes.

Both regressions failed before their fixes. The isolated typing check passed
five cases: ordinary multiline typing, healthy status updates, a real disposable
host restart with continued keyboard input, typing during replies, and separate
drafts across conversation switches. Evidence:
`tests/e2e/artifacts/composer-typing-1791404002470/report.json` (lost-focus failure),
`tests/e2e/artifacts/composer-typing-1791404456115/report.json` (five passing checks).
No real chats, drafts, or profiles were used by the test.

Follow-up validation: 3,434 unit tests passed (1 expected failure, 18 skipped,
1 todo), 37 main/serve-auth tests passed, all five isolated typing checks passed,
and `npm run lint` plus `git diff --check` passed. The full Electron suite and
older runtime/hover/golden workflows were not rerun for this follow-up.

## Other gaps, in practical order

1. **Public-release rights and privacy:** the existing ledger blocks release on
   licensing, inherited assets, and history cleanup. Keep the app private until
   those are resolved; do not equate passing local tests with release approval.
2. **Measure startup and preview cost before restructuring:** the production
   build still warns about mixed static/dynamic imports and large Mermaid/Excel
   chunks. Measure first-paint requests, preview-open latency, and retained-panel
   memory before choosing lazy imports or panel eviction. Chunk size alone does
   not prove a startup download.
3. **Expand validation deliberately:** Electron `checkJs` currently covers only
   the filesystem-read and navigation modules. The serve client has behavioral
   and syntax tests, not JS type coverage. Coverage thresholds exist in Vitest,
   but the coverage provider is not installed or exercised. These are separate
   follow-ups, not silently satisfied by `lint`.
4. **Capture intermittent restoration and the historical React depth warning:** the development runtime
   passed twelve replies, three reloads, and twenty-four saved-chat switches
   without the warning. One final pass timed out on saved transcript restoration;
   a fresh retry passed all six checks. Failure diagnostics now retain reply counts,
   loading state, active turns, and RPC metadata. This intermittency is not claimed
   fixed. Capture a failing state/component stack before changing effects
   speculatively; the harness still exits unsuccessfully on failure.
5. **Choose a remote-image policy:** existing helper/CSP disagreements should be
   resolved through an explicit privacy-conscious asset policy, not a blanket
   allowance for all HTTPS image origins.

## Validation of the initial improvement pass

| Check | Result |
| --- | --- |
| Full unit suite | 3,428 passed; 1 expected failure, 18 skipped, 1 todo. |
| Full Electron suite | 971 passed; 2 skipped, including Stop and final replay-watermark changes. |
| Hover harness | Nine actual pointer-traversal/geometry cases passed. |
| Production runtime | All six checks passed; no notification-route requests or renderer errors. |
| Development runtime | All six checks passed on fresh retry; one prior saved-transcript timeout is recorded above. No render-loop warnings or notification-route requests. |
| `npm run lint` | Passed: TypeScript and syntax checks for 171 Node files. |
| `npm run build` | Passed; existing theme-script, mixed-import, and large-chunk warnings remain. |
| Final `npm run test:e2e` | Four tests passed, including golden with stronger Stop assertions. |
| `git diff --check` | Passed. |

Ignored evidence: `tests/e2e/artifacts/message-hover-1791398826643/report.json`
(red pointer traversal),
`tests/e2e/artifacts/message-hover-1791400181898/report.json` (nine passing cases),
`tests/e2e/artifacts/diagnose-stop-only.json` (pre-fix single-turn RPC evidence),
`tests/e2e/artifacts/runtime-console-1791400205649/report.json` (restoration timeout),
`tests/e2e/artifacts/runtime-console-1791400332762/report.json` (passing fresh retry),
`tests/e2e/artifacts/runtime-console-1791400521036/report.json` (production runtime),
and `tests/e2e/artifacts/golden/result.json` (latest passing Stop diagnostics).
Runtime checks use fresh sandboxed profiles and fake local models. They do not
focus the user's desktop or write the system clipboard.
