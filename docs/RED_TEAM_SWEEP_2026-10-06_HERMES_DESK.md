# Hermes Desk Red Team Sweep — 2026-10-06

**Audited baseline:** `ede6018`, branch `tmux-orch/w4-red-team`.
**Revalidated baseline:** wave-5 merge `b8d0eac`, with wave-6 security hardening
on `tmux-orch/w6-security`. The finding narratives below preserve the original
evidence; the status table and wave-6 checks describe the current code.
**Scope:** the local Electron host, serve broker, workspace browser, MCP route,
preload/main IPC, PiP, renderer handling of untrusted content, CSP, and local installer.
The wave-1/2/3 contracts override the original desktop spec.

**Method:** defensive code review, two disjoint read-only audit lanes, focused
existing tests, and bounded local fixtures. All credential values were obviously
fake. No hosted calls, registry lookups, real profile changes, installation,
reserved-port listeners, uploads, pushes, or Hermes authentication workarounds.
This document contains weaknesses, impact, fixes, and regression-test ideas,
not operational attack instructions.

**Original headline:** 11 weaknesses (8 High, 3 Medium), no Critical finding.
**Current status:** wave 5 landed fixes/mitigations for every HD finding. All
post-fix probes pass without expected failures. HD-06 is **not closed against
hostile same-UID code**, and bounded DOM screenshot/transaction heuristics are
not universal guarantees. New J3 review gaps and residual release decisions are
listed in [security acceptance](plans/hermes-desk-security-acceptance.md).
**No owner risk acceptance is recorded by this worker.**

**Original-baseline reachability qualification:** `ede6018` passes asynchronous
`hostConfig.getConfig()` into the synchronous MCP enabled-profile gate
(`boot.cjs:28`, `mcp/dispatch.cjs:43–47`), so normal MCP browser calls fail closed.
Boot also omits the settings factory's `getEntry` dependency, blocking enablement.
Native controller browsing remains blocked by the independently documented
upstream Hermes identity/profile/session-routing issues. **HD-01–04 and HD-06
are demonstrated lower-level weaknesses, integration-blocked on this baseline;
they must be fixed before the working MCP route is enabled.** Neither integration
failure is credited as a durable security control.
Wave 5 repaired both boot seams; those integration blockers no longer qualify
the current status table.

## Ranked findings

Severity below is the original finding severity, not a claim of current exposure.

| ID | Weakness | Severity | Fix status and regression evidence |
| --- | --- | --- | --- |
| HD-08 | Renderer broker exposes secret-bearing configuration | High / P1 | **Fixed, wave 5:** RPC/REST allowlists, config projection, unsolicited-result filtering. `serve-client.test.mjs`, `serve-auth.test.mjs`, `serve-peer.test.mjs`. |
| HD-09 | Window-open bypasses native external-link consent | High / P1 | **Fixed, wave 5:** default-deny native external-link consent. `electron/main.test.mjs` HD-09. |
| HD-10 | Loopback serve peer is not authenticated before token use | High / P1 | **Fixed for owned spawns, wave 5:** exact-connection UID/process-group checks before token use; unauthenticatable external attach refuses. `hermes-host.test.mjs`, `serve-peer.test.mjs`. Binary-install trust is a separate J3 gap. |
| HD-01 | Approved fill values reappear in later text and metadata | High / P1 | **Fixed for approved values, wave 5:** bounded main-only registry, encoded/text/metadata echoes, metadata-free fill replies. `cdp-exec.test.mjs`, post-fix HD-01 probes. Unapproved arbitrary user-password echoes remain residual. |
| HD-02 | Snapshot adapter omits form and sensitive-ancestor context | High / P1 | **Fixed, wave 5:** complete DOM ancestry/form map, inherited editable/sensitive hints, both output paths; frame contexts refuse. `cdp-exec.test.mjs`, post-fix HD-02 probes and native corpus. |
| HD-03 | Screenshot masks use stale geometry across layout changes | High / P1 | **Bounded mitigation, wave 5:** recompute after paint, pre/post signatures, observable mutation/animation refusal, main bitmap authority. Post-fix HD-03 probes and wave-6 native moved-field/mutation tests pass. Atomic adversarial-frame guarantee remains unproven. |
| HD-04 | Transaction consent covers only some click paths | High / P1 | **Fixed tested paths, wave 5:** fresh semantics, form checks, click/Enter/Space consent, post-consent rechecks. `cdp-exec.test.mjs` and post-fix HD-04 probes. Consequential-action classification remains heuristic. |
| HD-06 | MCP profile identity is supplied by the client | High / P1 | **Mitigated, wave 5:** mandatory per-profile token hello, live revocation/pinning/owner-bound cancellation. W5-MCP regressions in `socket-server`, `profile-tokens`, `config-writer`, `index`, `shim`, `hermes-load`. **Hostile same-UID boundary not fixed or accepted.** |
| HD-05 | Unspecified IPv4 address bypasses control-plane URL checks | Medium / P2 | **Fixed literal aliases, wave 5:** IPv4 unspecified/numeric and IPv6 aliases. URL-policy suite, post-fix HD-05 probes, native isolated Electron deny receipt. DNS/rebinding remains residual. |
| HD-07 | MCP limits are per client, not aggregate | Medium / P2 | **Fixed admission/buffer budgets, wave 5:** global connections/buffers/requests, frame/idle deadlines, queued/argument caps. W5-MCP `socket-server.test.mjs` and `dispatch.test.mjs` HD-07 cases, plus shim typed-overload regression. Wave 6 adds shim backpressure and C9 teardown watchdog. |
| HD-11 | Concurrent serve socket admission exceeds its limit | Medium / P2 | **Fixed, wave 5:** synchronous reservation and release on failed/destroyed admissions. `serve-auth.test.mjs` HD-11. |

The HD-06/07 source-of-record probes are the adjacent W5-MCP regressions above,
not newly invented tokenless socket demonstrations. All execute in the full suite;
the real-Hermes load case has its own opt-in flag.

## Wave-6 follow-up and checks

- **J1:** the twelve fixture probes now assert repaired behavior with ordinary
  `it`, not `it.fails`. The native HD-05 probe reports policy denied, no fixture
  request and no navigation; it uses an ephemeral port and hidden nonfocusable
  window.
- **J3:** shim input/output and all-request admission are bounded; installer
  refuses dangling/ancestor links, stages privately, rechecks identities,
  preserves previous apps and never deletes unexpected destinations. Review
  receipts expose remaining host stderr/debug-bundle and executable-ancestry/
  launcher-identity gaps outside this worker's owned files. They are not fixed.
- **J4/J6:** native offscreen production screenshot path covers ten fake pages
  and 31 exact-black pre-JPEG regions; JPEG interiors tolerate levels 0–3 because
  encoding is lossy. It preserves the benign page, masks a field moved during the
  paint wait and refuses capture-time value mutation. Adjacent split tokens and
  conservative short-Paste heuristics are covered. Native AX password bullets
  require explicitly seeded approved fixture values, as documented in the test.
  No screenshot or transcript is written to disk; temporary HTML is fake.
- **C9:** admission timeout plus two-second abort grace forces tab teardown.
  Unwind or teardown releases the lock; failed teardown quarantines that lane.
  Late results, initial tab loading, activation targets and disposal have tests.
- **D1:** real default Hermes Tool Search exposes all ten browser tools through
  search/describe/call resolution. No supported MCP pin key exists, so the writer
  does not disable Tool Search or add speculative keys.

Reproduction (installed dependencies only):

```sh
HERMES_DESK_REDTEAM_PROBES=1 HERMES_DESK_REDTEAM_ELECTRON=1 \
HERMES_DESK_REDACTION_PIXELS=1 HERMES_DESK_TOOL_SEARCH_PROBE=1 \
HERMES_DESK_REVIEW_BOUNDARIES=1 npx --no-install vitest run \
  electron/local/mcp electron/local/workspace/redactor.test.mjs \
  electron/local/workspace/redactor-adjacent.test.mjs \
  electron/security-invariants.test.mjs scripts/install-local.test.mjs tests/redteam
HERMES_DESK_MCP_HERMES_LOAD=1 npx --no-install vitest run electron/local/mcp/hermes-load.test.mjs
npx --no-install vitest run
npx --no-install tsc -b
npm run build
```

The opt-in review-boundary cases deliberately demonstrate residual exposure,
not passing secrecy/authenticity invariants. The full default suite skips the
opt-in probes; all ordinary HD-06/07/08/09/10/11 regressions still execute.

| Wave-6 check | Result |
| --- | --- |
| Assigned modules + all security opt-ins above | **386 passed, 1 skipped**, 16 passing files; skipped real-Hermes case run separately |
| Real Hermes shim loading, default → named → default | 1 passed; temp homes, no model/network calls |
| Full Vitest | **3715 passed, 1 expected fail, 20 skipped, 1 todo**; 394 passing files, 7 skipped |
| `npx tsc -b`, `npm run build` | Passed; existing Vite import/chunk warnings remain |
| Native pixel receipt | 10 pages, 31 masked regions, hidden, moved field masked, mutation refused |

## Original finding evidence (historical `ede6018`)

## HD-08 — Restrict renderer RPC authority and secret-bearing results

**Weakness:** `electron/local/serve-client.cjs:437–452,223–229`;
`electron/serve-auth.cjs:126–138,155–166`.
Renderer-originated RPC is not restricted by a method/parameter allowlist, and
responses are forwarded without a secret-safe result projection.

**Why it matters:** a compromised main renderer can receive full effective profile
configuration, including inline credentials and environment-expanded credential
references. Broad serve-origin REST authentication also admits secret-reveal
routes; renderer readability of that REST response was established only for the
supported loopback development/CORS configuration, not packaged `file://`.

**Recommended fix:** enforce RPC method/parameter and REST method/route allowlists
in main. Keep full configuration and credential operations main-only, exposing
selected nonsecret metadata instead.

**Regression-test idea:** reject renderer full-configuration and credential-reveal
requests; retain explicitly permitted metadata calls and main-only secure handlers.

**Evidence:** an in-memory production broker forwarded an obviously fake
credential result unchanged. Source-only review of installed Hermes confirmed
effective-config expansion at `tui_gateway/methods_config.py:262,287–295`,
`tui_gateway/server.py:1276–1283`, and
`hermes_cli/config_effective.py:33–36`; no real configuration was read.

## HD-09 — Apply native consent to window-open handling

**Weakness:** `electron/main.cjs:838–842` sends an HTTPS window-open target to
`shell.openExternal()` without the consent used by the explicit external-link IPC.

**Why it matters:** compromised renderer code has an external navigation channel
despite the loopback-only `connect-src` policy. Returning `action: 'deny'` prevents
an Electron child window but does not undo the already-requested external action.

**Recommended fix:** deny programmatic popups, or route all external navigation
through the same default-deny native confirmation policy.

**Regression-test idea:** window-open requests must not invoke the shell before
affirmative native consent, including when the URL is otherwise valid HTTPS.

**Evidence:** the production window factory was evaluated with mocked Electron
and shell dependencies; an external action was requested without consent.
No real external browser was opened.

## HD-10 — Authenticate the loopback serve peer before token use

**Weakness:** `electron/local/hermes-host.cjs:40–49,134–143` sends a reusable
credential to a loopback listener and treats successful JSON as sufficient peer
identity. Lines `28–35,154–164` also release a selected port before the child binds
and publish the endpoint before independently verified readiness.

**Why it matters:** another local UID can own an unprivileged loopback listener
when the expected serve process is absent. Loopback placement and client bearer
authentication do not authenticate the server to the desktop.

**Recommended fix:** establish server identity before transmitting reusable
credentials. Prefer a protected Unix transport or inherited listener; otherwise
verify process ownership and spawned-child readiness without a port-handoff race.

**Regression-test idea:** a disposable non-Hermes peer and a simulated child-bind
race must neither receive a credential nor become the active endpoint.

**Evidence:** production `probeServe()` accepted an inert ephemeral HTTP fixture
that received a fake token. No reserved port or real credential was used.

## HD-01 — Retain approved-value redaction across subsequent results

**Weakness:** `electron/local/workspace/snapshot.cjs:89–93` clears marked field
values before redaction can learn their text. `redactor.cjs:207–220` derives echo
masks only from values still present, while `cdp-exec.cjs:105–109,137–139,199–202`
uses context-free scrubbing for tab metadata.

**Why it matters:** an approved arbitrary credential stays hidden in its original
field but can reappear in another accessible text node or later title/URL result.
The safe immediate `typed [secret]` response does not protect subsequent results.

**Recommended fix:** retain a bounded, main-only, document/session-scoped registry
of approved values for result scrubbing and screenshot text detection. Never
persist it, and clear it on document disposal and relevant revocation.

**Regression-test idea:** fill a fake arbitrary passphrase and expose the same
marker in a sibling text node and metadata; every later agent-visible result must
omit the marker while the source field remains sensitive.

**Evidence:** opt-in `tests/redteam/hermes-desk.test.ts`, HD-01. The real executor
and redactor returned the fake marker in later snapshot and tab-title results.
**Current reachability:** integration-blocked as described above.

## HD-02 — Carry DOM form and inherited sensitivity into snapshots

**Weakness:** `electron/local/workspace/snapshot.cjs:58–69,74–87` gathers only
each node's own attributes and local AX sibling context. It does not propagate
editable/sensitive ancestry or supply the `formGroups` used by
`redactor.cjs:160–162,176–194`; `cdp-exec.cjs:199–202,313–318` calls redaction
without those groups.

**Why it matters:** a same-form password represented by a plain textbox can remain
visible, and descendants of sensitive editable containers can lose their sensitivity.
Passing the pure redactor corpus does not validate this production adapter.

**Recommended fix:** construct a DOM ancestry/form map, propagate inherited
editable and sensitive context, and supply validated form groups on every
snapshot/screenshot path. Refuse output when necessary document/frame context
cannot be collected safely.

**Regression-test idea:** exercise the actual adapter with an email/password form
using a text input and an OTP-editable container with nested text descendants.
Assert both text omission and screenshot-mask coverage.

**Evidence:** opt-in HD-02 tests reproduce both missing-context cases; supplying
the omitted group to the same redactor removes the fake form marker.
**Current reachability:** integration-blocked.

## HD-03 — Make screenshot redaction robust to layout changes

**Weakness:** `electron/local/workspace/cdp-exec.cjs:321–348` collects rectangles,
waits for overlay painting, then captures with the old rectangles.
`snapshot.cjs:27–39` tracks navigation, not DOM/layout changes.

**Why it matters:** a sensitive field can move or new sensitive pixels can appear
without a navigation, leaving returned pixels outside the old masks. Successful
overlay painting and black-fill compositing do not establish that geometry still
matches the captured frame.

**Recommended fix:** tie sensitive-region detection to the captured rendering
state. Fail closed on unstable geometry/content, use conservative mask expansion,
and refuse capture when the required stability cannot be established.

**Regression-test idea:** move a fake sensitive field between geometry collection
and capture; require either correct masking at its captured position or a typed
policy refusal. Add native Electron pixel/OCR coverage before release.

**Evidence:** opt-in HD-03 deterministic compositor tests retain a marked fake
sensitive pixel at the moved position. This is not an OCR or real-page race test.
**Current reachability:** integration-blocked.

## HD-04 — Enforce consent at the effective transaction action

**Weakness:** `electron/local/workspace/cdp-exec.cjs:204–211` gates only named
clicks on financial-looking URLs. Lines `275–296` dispatch keyboard submission
without that check, and `143–153` retains the previous AX name when refreshing a ref.

**Why it matters:** equivalent form submissions do not receive equivalent consent,
and a renamed button can be checked under its stale label. Thus the desktop
confirmation described in spec §15.1 is not a reliable transaction boundary.

**Recommended fix:** refresh action semantics immediately before execution and
apply policy to submission/activation regardless of input mechanism. Default-deny
ambiguous sensitive actions; do not describe a URL/name heuristic as comprehensive.

**Regression-test idea:** a denied transaction must remain denied for keyboard
activation, renamed buttons, and equivalent submission controls.

**Evidence:** opt-in HD-04 tests verify native-denied clicks but accepted keyboard
dispatch, plus a changed label that does not invoke confirmation. No transaction
or live site was used. **Current reachability:** integration-blocked.

## HD-06 — Bind MCP profile authority independently of client input

**Weakness:** `electron/local/mcp/socket-server.cjs:105–120` accepts
self-reported profile/version/PID identity and permits calls without `hello`.
`mcp/dispatch.cjs:43–47,153–175` treats that profile's enablement as authority
to select its lane.

**Why it matters:** socket modes distinguish ordinary UIDs, not profiles or
processes sharing the desktop UID. Per-connection profile pinning prevents a
connection from switching profiles but does not authenticate its initial identity.

**Recommended fix:** require authenticated admission and derive profile authority
from server-verified identity. Strong isolation from arbitrary same-UID code
requires a genuine OS/sandbox boundary; same-UID-readable profile tokens alone
are insufficient. Alternatively, explicitly accept and document a fully trusted
same-UID threat model.

**Regression-test idea:** authority for one profile must not authorize another,
including on a new connection; unauthenticated calls must be refused.

**Evidence:** a disposable socket/dispatch fixture showed that claimed identities
were accepted and a separate enabled lane could be selected without a handshake.
No real browser lane was accessed. **Current reachability:** the correctly wired
dispatch fixture, not the integration-blocked app boot.

## HD-05 — Block unspecified-address aliases of local control-plane ports

**Weakness:** `electron/local/workspace/url-policy.cjs:21–26,47–50` recognizes
specific loopback spellings but not the unspecified IPv4 address.
`workspace/index.cjs:67–78` reuses that predicate for network requests.

**Why it matters:** the audited macOS/Electron runtime resolves this address to
the local listener, so the agent partition's control-plane exclusion is incomplete.
This finding does **not** establish a Hermes bearer-authentication bypass.

**Recommended fix:** reject unspecified addresses and all local-address aliases
for protected ports/app origins. Cover destination resolution and DNS rebinding
with a connection-time policy or a controlled network intermediary.

**Regression-test idea:** table-test address classes and use an isolated browser
against an ephemeral local fixture; no protected destination may be reached under
the agent policy.

**Evidence:** the opt-in isolated Electron test confirmed both policy acceptance
and fixture reachability. The listener used an OS-assigned ephemeral port, not
8642 or 9119; userData/sessionData were disposable.

## HD-07 — Bound aggregate MCP connections, buffers, and queued work

**Weakness:** `electron/local/mcp/socket-server.cjs:44–61,141–163` limits
individual clients but not total connections, input capacity, or partial-frame
lifetime. `mcp/dispatch.cjs:129–149,172–182` has no aggregate/per-lane admission
cap, and execution deadlines start after queue admission.

**Why it matters:** independent clients multiply the advertised per-client limits,
consuming main-process resources and delaying legitimate work. Connection buffering
needs no successful profile admission; dispatch queue effects require working
enabled-profile integration.

**Recommended fix:** add global connection/buffer budgets, partial-frame and idle
deadlines, per-lane/global queue caps, argument-size checks before queuing, and
admission-to-completion deadlines. Keep cancellation available under pressure.

**Regression-test idea:** with small injected limits, enforce budgets across
multiple clients, expire incomplete frames/queued work, and reserve legitimate
capacity without early lane-lock release.

**Evidence:** bounded fixtures admitted 96 outstanding fake calls across three
clients and retained four small incomplete-frame connections. No exhaustion,
large allocation, or crash was attempted.

## HD-11 — Reserve serve socket capacity before asynchronous admission

**Weakness:** `electron/serve-auth.cjs:230–240,268` checks capacity before
awaiting token acquisition and adds the socket afterward without reservation.

**Why it matters:** concurrent renderer requests can all observe the same available
capacity. The configured eight-socket limit is therefore not enforced under concurrency.

**Recommended fix:** reserve IDs and per-sender capacity synchronously before any
await, releasing reservations on failure, disconnect, and sender destruction.

**Regression-test idea:** concurrent distinct-ID opens must never exceed the
configured ceiling, including when token acquisition is deliberately delayed.

**Evidence:** production broker with fake WebSockets admitted 32 concurrent opens
against an eight-socket limit. No real serve connections were created.

## Original verified-safe observations (wave 4 boundaries)

- **Window isolation:** tab views are sandboxed, context-isolated, have no preload
  or Node integration, deny webviews, and contain popups in the same lane.
- **Debugger scope:** executor membership checks reject substituted/user/non-lane
  contents. No arbitrary evaluate/CDP MCP tool or app-level remote debugging server
  was introduced. Exactly ten browser capabilities are exposed.
- **Lane controls:** partitions are distinct; activation/listing is lane-scoped.
  Eight agent tabs and twenty live views are enforced with serialized admission.
  User takeover, cancellation, and same-lane FIFO are covered by focused tests.
- **URL checks:** explicit disallowed schemes, URL credentials, normalized
  loopback spellings, protected ports, and per-agent deny/allow rules are rejected
  by the policy tests. HD-05 qualifies the address coverage; configured-rules
  propagation through boot was not established.
- **Permissions/downloads:** partition request/check/device permissions default
  deny. Agent downloads reject the specified executable extensions and unsafe
  filenames, check immediate directory symlinks, and enforce a 200 MiB size cap.
  These are not race-free guarantees against hostile same-UID directory replacement.
- **Immediate secret use:** literal sensitive-field fills are refused. Top-level
  origin/document navigation during approval aborts fill, type responses omit
  metadata, raw CDP/CLI errors are replaced, and values do not enter fill IPC/audit.
  Cross-frame/focus-race safety was not dynamically verified; HD-01–03 qualify
  subsequent-output guarantees.
- **Pure redactor:** 186 corpus/error tests pass. Known secret shapes, marked
  controls, fixed errors, and JSON-quoted snapshot strings are covered. This is
  not proof of complete real-browser screenshot redaction.
- **Audit/persistence:** audit entries whitelist metadata and retain origins only,
  with private no-follow final-file opens and rotation. Workspace URL persistence
  drops queries/fragments. Page titles and URL paths remain persisted, so arbitrary
  page-controlled credential echoes are not covered by a general no-secret promise.
- **MCP socket:** private directory/socket modes are `0700`/`0600`; ordinary
  other-UID pathname access is restricted. Strict UTF-8/framing, bounded per-client
  requests/output, duplicate-ID checks, owner-bound cancellation, live-socket
  preservation, and inode-checked stale-socket cleanup are covered. A different-UID
  dynamic connection test was not performed.
- **MCP configuration:** profile validation and YAML quoting withstand tested
  punctuation/traversal inputs. Preview is read-only; apply rechecks stale content,
  uses private exclusive backups/temp files, fsync, and atomic rename.
- **Shim:** protocol-only NDJSON stdout, stderr diagnostics, offline handshake/tool
  listing, bounded deadlines, cancellation, and reconnect-without-replay pass.
  Unbounded parent-controlled stdin/backpressure remains a hardening gap, not a
  demonstrated lower-trust ingress.
- **Secure serve requests:** secret/sudo/vault requests and replayed open requests
  are intercepted in main. Unknown requests decline; disconnect/cancel prevents
  late submission. This does not repair the broad RPC result authority in HD-08.
- **PiP:** narrow top-frame/local-page IPC, text labels, bounded raster-only image
  URLs, permission/download/navigation denial, session-associated completed captures,
  no new live capture or image persistence, and native-confirmed clipboard paste.
- **Untrusted renderer content:** workspace titles/URLs/labels use React text/attribute
  rendering. Remote favicons are discarded; only raster inline sources are accepted.
  Chat uses ReactMarkdown without raw HTML, safe URL transforms, and bounded raster
  images. Rich math/diagram output passes DOMPurify; Mermaid uses strict mode.
- **CSP/install:** CSP keeps loopback-only connections and disallows unsafe app
  script loading; HD-09 qualifies external navigation. Installer uses fixed absolute
  tools/destination and refuses an existing nondangling destination symlink.
  Installer execution and hostile dangling/ancestor/racing paths were not tested.

## Original checks run (wave 4)

All Vitest commands used the already-installed dependencies; no package download.

| Check | Result |
| --- | --- |
| `npx --no-install vitest run electron/local/workspace` | **334 passed**, 9 files |
| Focused MCP tools/dispatch/socket/index/config-writer/shim suite | **90 passed**, 6 files |
| Focused host/boot/gateway/serve/config/PiP/preload/secrets/main suite | **116 passed**, 11 files |
| Safe-image, reply-media, sheet sanitization, message-body, workspace-store tests | **89 passed**, 5 files |
| `npx --no-install vitest run src/components/workspace/WorkspacePane.test.tsx` | **30 passed** |
| Workspace red-team fixture suite, opt-in evidence run | **7 passed, 5 expected failures**, 12 tests |
| `HERMES_DESK_REDTEAM_ELECTRON=1 npx --no-install vitest run tests/redteam/hermes-desk-electron.test.ts` | **1 passed**, isolated Electron |
| `npx --no-install vitest run tests/redteam` after default-skip change | **13 skipped**, no failures |
| Final combined scoped suite, including the default-skipped red-team tests | **659 passed, 13 skipped**; 32 passing files, 2 skipped |
| `node --check tests/redteam/fixtures/loopback-electron.cjs` and `git diff --check` | **Passed** |

The initial combined renderer/fixture run had 95 ordinary passes and four expected
failures; the later 12-test fixture run adds the fifth expected failure. Counts
above separate renderer tests from the latest fixture evidence to avoid double counting.
The fixture suite is now opt-in with `HERMES_DESK_REDTEAM_PROBES=1`; its five open
invariant checks retain `it.fails`. The native Electron probe has a separate opt-in
flag. **Default CI executes neither bug-demonstration suite.**

## Original coverage and remaining release gates (wave 4)

Reviewed all production files under `electron/local/workspace/**` and
`electron/local/mcp/**`, the local host/config/serve/PiP modules, preload/serve-auth/
secrets modules, relevant main-process windows/IPC, all workspace renderer modules,
`MessageBody`, image/markdown sanitizers, `index.html`, and `install-local.mjs`.
This is a scoped security sweep, not a full-repository dependency audit.

No renderer implementation changed, so renderer typecheck/build/full-suite validation
was not repeated. The brief's pre-existing three type errors and sixteen full-suite
failures are not claimed fixed. Native pixel/OCR redaction, cross-origin-frame/focus
binding, actual other-UID socket access, same-UID filesystem races, live Hermes
browser/credential flows, and actual installation remain unverified.

**Needs from owners:** enforce the host/renderer boundaries (HD-08–11), close the
workspace redaction/consent gaps (HD-01–05), resolve the same-UID profile trust model
and aggregate MCP budgets (HD-06–07), then validate the repaired integration seam
and native browser security before declaring v1's red-team gate complete.

The paragraph above records the original handoff, not today's open-finding list.
Use the wave-6 status table and security-acceptance checklist for current decisions.
