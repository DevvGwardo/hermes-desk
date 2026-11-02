# Hermes Desk gap remediation, 2026-10-07

Scope: the high-value batch in [the gap analysis](hermes-desk-gap-analysis-2026-10-07.md),
checked against the current private snapshot and local runtime fixes. This is not a
whole-repository security audit or public-release approval. The original analysis is unchanged.

## Addressed

| Gap | Change and boundary |
| --- | --- |
| Main renderer can invoke HUD OS input | `clickAt`, `typeText`, and `moveTo` now require the HUD's top frame. Existing visibility/accessibility checks remain. Tests never inject real OS input. |
| App-window redirects unchecked | Main and HUD use their existing origin guards on `will-redirect` as well as `will-navigate`. |
| Unbounded file reads | Text/data-URL reads use a 10 MiB cap, opened-handle stat, and bounded chunks. Reading stops at the limit plus one byte even if a file grows. Handles close on failure. Non-regular files are refused. |
| Unbounded typing | HUD typing refuses more than 4,096 characters before probing Accessibility or spawning. |
| Relative filesystem paths | Filesystem validation requires an absolute path; home/symlink containment remains enforced. |
| Dead notification work | Bell is local/event-driven, including cross-window storage events. No bus probes, mark-read requests, or heartbeat. Existing cached developer items/filters remain readable. |
| Dead browser-job hook | Compatibility hook returns false without React state/effects or legacy probes; native workspace control is unchanged. |
| Roster refresh on pin order | Only hidden profiles, scratch visibility, and session-source changes trigger preference-driven refresh. Theme/width are not fields of this preference store. |
| Running-routine polling while hidden | Reads use the existing adaptive poller; hidden clocks stop. Visibility resume refreshes immediately, even after a short absence. Local routine scheduling is not disabled. |
| Undiscoverable validation/E2E | Added explicit type/syntax/E2E/runtime scripts and `scripts/README.md`. `lint` is honestly documented as type+syntax checks, not ESLint. |
| Stale project history/docs | Added current Hermes Desk state, separated historical Nub version notes, preserved superseded plans unchanged under `docs/archive/nub-era/`, replaced root slots with current pointers, removed the stale README wave-status claim. |
| Mislabeled script | Historical Python assembler moved from `.mjs` to `.py`, without running it or modifying generated mascot code. |

## Runtime fixes preceding this batch

- Notification adapters no longer request an absent `/api/notifications` route.
- Chat Copy awaits completion and contains failures. Electron uses a main-window-top-frame,
  write-only clipboard bridge; browser/workspace clipboard permissions remain denied.
  Browser fallback and manual-copy feedback remain for non-desktop/failed writes.
- Message hover reproduced a **36-pixel transcript jump**: conditionally mounted actions
  were in normal flow. Messenger actions now float without resizing rows, fit the chat pane,
  and move below a message when the transcript edge would clip them. Hover exit and keyboard
  focus also preserve bubble geometry and scroll position.
- The opening/switching `Maximum update depth exceeded` warning is **not fixed or reproduced**.
  Development-renderer checks streamed twelve replies, restored chats across three reloads,
  and switched saved chats twenty-four times without a warning. The expanded React component
  stack is still needed; repeated transcript-load messages alone do not prove a render loop.

## Corrections and deliberate deferrals

- Developer notification filters were already conditional on cached developer items, not
  always shown. Deleting them would discard useful access to an existing cache.
- `use-browser-jobs` performed one effect/probe per instance change, not a periodic poll.
- `inviteCode` is deliberately null in the local product. Reviving hosted invitations is not
  a bug fix. Legacy MCP route handling still needs a separate compatibility decision.
- `0.1.13–0.1.18` in the inherited state file are Nub Agent releases. Hermes Desk remains
  `0.1.0`; no fabricated version bump or mobile release is needed.
- No remote image allowance or CSP relaxation was added. HTTPS helper/CSP alignment and
  avatar loading need a privacy-conscious asset policy, not blanket `img-src https:`.
  `frame-ancestors` cannot be enforced from an HTML meta CSP.
- Bearer-gated loopback CORS, approval/pin cache lifetimes, and other minor hardening remain
  separate from these verified boundary fixes. A wildcard alone is not proof of an auth bypass.
- Startup splitting, per-message activity indexing, retained-panel eviction, and other
  timestamp/polling optimizations need measurements and lifecycle regressions first.
- Incremental Electron `checkJs` covers the bounded-read and navigation modules only.
  The rest of Node code has syntax checks and behavioral tests, **not** full JS type checking.
  No ESLint/coverage provider was installed. Coverage floors are not claimed enforced.
- Legacy gates/reference media were not bulk deleted, historical content was not rewritten,
  and unrelated overnight/system-stats drafts were not modified.

## Validation before the subsequent improvement pass

| Check | Result |
| --- | --- |
| Full unit suite | 3,428 passed; 1 expected failure, 18 skipped, 1 todo. |
| Full Electron suite | 967 passed; 2 skipped. |
| Focused security/frontend regressions | 145 / 74 passed. |
| `npm run lint` | Passed: TypeScript plus syntax checks for 171 Node files. |
| `npm run build` | Passed. Existing theme-script, mixed-import and large-chunk warnings remain. |
| `npm run test:runtime:dev` | All six checks passed on the combined tree: twelve replies, clipboard denial/retry, local bell, three reloads and twenty-four saved-chat switches. Zero notification-route requests or render-loop warnings. |
| `npm run test:hover` | All six user/agent cases passed at 1440, 960 and 390 pixels. Hover, exit and focus preserve rows/bubbles and scroll geometry; Copy remains hit-testable. The narrow case changes only the disposable test window's minimum size. |
| Layout alignment harness | Passed after updating the action placement contract to floating controls. |
| Authorized live-profile warning capture | No React depth warning recorded during 70 seconds. No automatic chat switching or message-content collection. Diagnostic app/server closed afterward. |
| Archive integrity | Both old plans and the renamed Python assembler match the published originals byte-for-byte. Python was parsed, not executed. |
| Secret checks | Gitleaks and the supplemental password/environment-fallback scanner found no leaks in the patch and intended new files. Unrelated drafts were excluded. |
| Last `npm run test:e2e` (before hover fix) | Three fake-model tests passed; the golden test failed only on the inherited interrupt timeout. Not rerun after the hover fix; that timeout is not claimed resolved. |

Golden E2E was **not green at this stage**. Both original failures reproduced against the published
`f78711a` snapshot in a disposable export. The ghost-cursor check expected the profile
key `alpha` rather than its painted display name `Alpha`; its expectation now matches
the fixture while retaining the visibility/opacity assertions.

Command-period still times out. Isolated evidence shows the actual Period key with Meta
is consumed, lanes become paused, and the native backend returns `status: interrupted`,
but an active turn remains/reappears. A temporary genuinely streaming stop fixture did
not resolve it and was restored unchanged. One diagnostic run also timed out waiting
for the redaction reply; other runs passed that check. These results do not establish a
backend root cause or prove stop/interrupt fixed. No upstream Hermes source was changed.

Evidence lives in the ignored `tests/e2e/artifacts/` directory:
`runtime-console-1791395030911/report.json` (latest combined development renderer),
`message-hover-1791395010136/report.json` (six hover cases),
`layout-alignment-1791395061562/` (current geometry),
`live-react-warning-1791394050739/report.json` (authorized warning-only capture),
`gap-baseline-1791392321/result.json` (published-snapshot failures), and
`golden/result.json` (latest golden diagnostics). E2E runs use disposable profiles,
do not focus the user's desktop, and do not write the system clipboard.

Public release remains blocked on rights/license/privacy cleanup and a sanitized history.
All changes in this ledger remain local unless explicitly committed/published later.

## Subsequent improvement pass

[The follow-up review](hermes-desk-improvements-2026-10-07.md) fixes actual pointer
traversal to floating actions, stale resume snapshots, and unsent active prompts.
RPC diagnostics then identified the Stop restart: a synthetic takeover event queued
new steering behind the interrupted turn. Stop now cancels MCP lane work directly;
physical takeover retains its normal notification. Golden E2E passes with stronger
interruption/no-steering assertions. The follow-up records current validation and
one intermittent saved-transcript timeout that passed on a fresh runtime retry.
