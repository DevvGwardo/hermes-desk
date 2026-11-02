# Hermes Desk Phase 0 findings

**Date:** 2026-10-06. **Worker:** spike. **Scope:** investigation, disposable probes, fixtures only.

Hermes source: `~/.hermes/hermes-agent`, commit
`f42f579cf8bac4918ac9599bece71618afadd846` (0.21.5). Source references below are relative
to that directory, not this desktop repository. The cross-worker contracts override the original spec.

## Reproduction and evidence boundaries

Run from this worktree:

```sh
node scripts/spikes/hermes-desk-phase0.mjs baseline
node scripts/spikes/hermes-desk-phase0.mjs harness
npx vitest run scripts/spikes/hermes-desk-phase0.test.mjs
```

The script uses `mkdtemp`, equivalent to `mktemp -d`, seeds **default, spike-alpha,
spike-beta**, and launches:

```sh
<Hermes source>/venv/bin/python -B <Hermes source>/hermes \
  serve --isolated --host 127.0.0.1 --port 9180 --no-open
```

It chooses a free port in **9180–9199**, creates its own random
`HERMES_DASHBOARD_SESSION_TOKEN`, uses a strict environment allowlist and temporary
`HOME`, `HERMES_HOME`, runtime and XDG directories, and stops its own child in `finally`.
macOS `sandbox-exec` denies writes to the real Hermes tree, reads of real Hermes state
outside the source tree, external outbound connections and binds other than the probe port.
No real config, profile, credential, gateway, CUA session or browser was used.
Both final runs selected 9180, sequentially, and their children and temporary homes were removed.

`HERMES_DISABLE_LAZY_INSTALLS=1` prevents the launcher's automatic dependency repair
(`hermes_cli/venv_sync.py:336-341`). An initial prerequisite attempt without that setting
tried to download a Python runtime; the sandbox blocked it. Nothing was downloaded.
An initial readiness check expected the wrong sentinel; the actual one is
`HERMES_BACKEND_READY port=9180`. Both issues are corrected in the reproducible script.

Fixtures in `tests/fixtures/serve-ws/`:

| File | Provenance |
| --- | --- |
| `phase0-baseline.jsonl` | Actual client/server WS frames from **unmodified** serve, local token authentication |
| `phase0-harness.jsonl` | Actual WS frames from an **instrumented disposable** serve, not proof the unmodified local controller works |
| `phase0-computer-status.jsonl` | Actual HTTP status response, explicitly separate from WS frames |

Each WS line wraps the unchanged parsed wire frame as
`{connection, provenance, direction, frame}`. Temporary path strings become `<TEMP>`;
transport credentials are never recorded. Session/command IDs and sequence numbers are
retained for correlation. All content is fake or bundled metadata.

The harness changes only process memory: it injects a fictional non-internal transport
identity, disables agent-build scheduling, supplies the missing session `profile` field,
uses the runtime ID when directly invoking the registered browser handler, and shortens
the broker timeout from 30 seconds to 3. It also directly calls the real server-request
engine for a synthetic approval. **These are diagnostic interventions, not proposed
production auth bypasses.** Installed Hermes files were not edited.

## 1. One serve process and multiple profiles

**Answer: yes for session creation, storage, listing and concurrent warm resume.
Use one serve, not one serve per profile. Concurrent model inference was not tested.**

The baseline issued three creates before their responses arrived, over two sockets.
Each returned a different runtime ID, stored ID, matching `info.profile_name`, and
its own seeded user message. Each `session.list {profile}` contained only that profile's
stored session. Three outstanding resumes returned the corresponding runtime IDs and
transcripts. A session created on socket b could be resumed on a as an additional viewer.

Exact minimal call shapes:

```json
{"method":"session.create","params":{"profile":"spike-alpha","source":"desktop"}}
{"method":"session.list","params":{"profile":"spike-alpha","limit":50}}
{"method":"session.resume","params":{"profile":"spike-alpha","session_id":"<stored_session_id>","lazy":true}}
{"method":"prompt.submit","params":{"profile":"spike-alpha","session_id":"<runtime_session_id>","text":"Hello"}}
```

All are JSON-RPC 2.0 requests with a client-generated `id`. Create returns
`{session_id, stored_session_id, message_count, messages, info}`. Resume uses the **stored**
ID, then returns the **runtime** ID for turn RPCs. Keep those identities distinct.
Empty drafts have no database row until the first prompt; the probe used seeded messages
to make listing/persistence testable without a successful model turn.

**Source evidence:**
- `apps/shared/src/gateway-contract.generated.ts:2932-2964` declares create params/results;
  `tui_gateway/contracts/sessions.py:174-194` declares stored-ID resume and its flags.
  OpenRPC method entries are `apps/shared/src/gateway-contract.openrpc.json:3196-3213,3430-3447`;
  the create profile/source schema is at `:29514-29552`, and stored-ID/profile/lazy resume
  schema at `:30998-31045`. These declare optional `profile`/`source`, required resume
  `session_id`, and reject extra parameter keys.
- `tui_gateway/methods_session.py:349-464` resolves `profile_home`, records the calling
  transport, persists seeded sessions and returns the two IDs.
- `tui_gateway/server.py:547-568` resolves a named home, refuses a missing profile rather
  than defaulting, and activates multi-profile hosting before serving another home.
- `tui_gateway/launch_profile_policy.py:33-51,71-109` freezes launch environment once and
  activates fail-closed secret reads. Eager activation explicitly ignores a stale
  `gateway.multiplex_profiles: false`.
- `tui_gateway/server.py:576-603` binds home, secret and terminal scopes for scoped RPCs;
  `launch_profile_policy.py:129-181` reconstructs the launch tenant's own scope.
- `hermes_cli/profiles.py:220-230` resolves profiles under the default Hermes root,
  including custom `HERMES_HOME` deployments.

The harness's direct scope receipts confirmed `<TEMP>/.hermes` and each sibling profile
home resolved their own `obviously-fake-<profile>` marker, with `multiplex_active: true`,
despite the deliberately false gateway flag. These are direct-method observations,
not WS payloads.

**CONTRACT:** Keep §4.3's single serve architecture and route by explicit profile.
The lazy LRU per-profile-process fallback is **not needed** for this version. Messaging
gateway credential sharing does not block serve's session hosting. Do not infer that
this spike proves simultaneous model calls, lease contention, or cold restart recovery.

## 2. Browser controller protocol and blocking gaps

**Answer: controller authority belongs to an authenticated, session-attached WS
transport, not to `session_id` alone. Unmodified local-token serve cannot register it
at this revision, even when extension control is enabled.**

### What actually failed

1. Baseline `browser.controller.register`, with the flag enabled in all three temporary
   configs, returned **4403**, `browser.controller.register requires an authenticated
   non-internal identity`. Local `?token=` authentication leaves `auth_identity` unset.
   Sending a fabricated `principal_id` does not supply a verified identity.
2. After injecting a fake verified identity in the harness, registration still returned
   **4403**, `controller_id, browser_profile_id, and server session profile are required`.
   Create stores `profile_home`, but the controller handler reads `session["profile"]`.
   The harness had to supply that field explicitly.
3. After supplying the profile, registration succeeded. However, the real
   `_set_session_context(stored_id, ui_session_id=runtime_id)` stamped
   `HERMES_SESSION_ID=<stored_id>` while the registered broker scope used the runtime ID.
   Calling the real router under that context returned the probe's inert
   `legacy-fallback-sentinel-no-browser-executed`, not a controller command.
   Direct registry invocation with corrected runtime context produced the captured command.

**Source evidence for these three blockers:**
- `hermes_cli/web_server_chat.py:247-285,366-371` stamps identity only on gated
  ticket/provider auth, not the legacy loopback token path.
- `tui_gateway/ws.py:97-105` carries that upgrade identity; `hermes_cli/web_routers/chat_ws.py:606-613`
  forwards it. `hermes_cli/dashboard_auth/routes.py:458-466` requires a verified
  dashboard session to mint a WS ticket. A local process token is not such a login.
- `tui_gateway/methods_browser_control.py:38-47,94-126,153-174` requires non-internal
  identity, session transport membership, and a nonempty session `profile`.
- `tui_gateway/methods_session.py:397-417` stores `profile_home`, not `profile`.
- `tui_gateway/server.py:1306-1333` sets the durable agent/session-key identity.
  `tools/browser_extension_router.py:29-37,78-98` looks up the broker with
  `HERMES_SESSION_ID`; `gateway/browser_control_broker.py:456-475` matches that value
  against registered `scope.session_id`.

Also, the controller methods do **not** have the profile-scoped decorator. Their flag
precheck reads ambient config (`methods_browser_control.py:134-145`), not necessarily
the requested session's profile config. All probe profiles had the flag enabled, so
mixed enabled/disabled profiles were not live-tested.

### Exact frames and direction

`R` below is the **runtime** session ID; `C` is the broker-generated command ID.
Requests also carry `jsonrpc:"2.0"` and a unique client request `id`.

| Direction | Method and params / response |
| --- | --- |
| Client → serve | `browser.controller.register {session_id:R, protocol_version:1, controller_id:"hermesdesk:<install>", browser_profile_id:"ws-agent-spike-alpha", capabilities:["browser_navigate", ...]}` |
| Serve → client reply | `{scope:{principal_id,profile_id,session_id,controller_id,browser_profile_id,transport_family,capabilities}}` |
| Client → serve | `browser.controller.heartbeat {session_id:R}` → `{ok:true}` |
| Serve → controller | `event {type:"browser.controller.command",session_id:R,payload:{command_id:C,action:"browser_navigate",arguments:{url:"https://example.invalid/spike"},controller_id,browser_profile_id,tool_call_id}}` |
| Controller → serve | `browser.controller.result {session_id:R,command_id:C,ok:true,result:{...}}` → `{accepted:true}` |
| Controller → serve | `browser.controller.result {session_id:R,command_id:C,ok:false,error:{code:"user_took_control",message:"..."}}` → `{accepted:true}`; waiting tool raises `ControllerRejected` |
| Serve → controller | `event {type:"browser.controller.cancel",session_id:R,payload:{command_id:C,tool_call_id}}` |
| Controller → serve, after cancel | Same result call → `{accepted:false}` |
| Client → serve | `browser.controller.detach {session_id:R}` → `{detached:true}` |

**The WS notification's method is `event`, not `browser.controller.command` or
`browser.controller.cancel` at the top level.** These controller events bypass the
normal sequenced replay emitter; the captured frames have no `seq`.

The advertised capabilities are the **full `browser_*` names**, not `navigate`, `click`,
etc. With developer mode false, `["navigate","snapshot","browser_evaluate"]` yielded
`no permitted controller capabilities requested`. The register reply returns a scope,
not a protocol-version or heartbeat-interval field. There is no negotiated controller
heartbeat cadence here; heartbeat is an ownership acknowledgment, not a broker TTL renewal.
Default command deadline is 30 seconds; the harness used 3 seconds to record a timeout cancel.

There is **no client→server `browser.controller.cancel` method** in the generated method
catalog. Cancel is a server notification and a broker-internal operation. Client takeover
should reject pending commands using `browser.controller.result` with `ok:false`.
Explicit WS detach hard-cancels pending work with `notify_controller=False`;
it does not itself emit a cancel notification. Socket disconnect marks controllers
offline, allowing same-identity reconnect, rather than behaving like hard detach.

**Source evidence:**
- `apps/shared/src/gateway-contract.generated.ts:1764-1799` gives every controller RPC
  shape, notably the **required `session_id` on result**.
  OpenRPC maps the four methods at `apps/shared/src/gateway-contract.openrpc.json:244-315`
  and marks both result `session_id` and `command_id` required at `:7318-7365`.
- `tui_gateway/contracts/events.py:627-646` declares command/cancel payloads.
- `tui_gateway/methods_browser_control.py:56-77,185-212` wraps broker events and implements
  result, heartbeat and detach.
- `gateway/browser_control_broker.py:21-42,74-81,240-301,302-418` gives deadlines,
  capabilities, exact owner checks, replacement/reconnect, result and cancel behavior.
- `tools/browser_tool.py:1328-1364` registers the actual routed browser handlers.

### Ownership and direct invocation evidence

The harness resumed socket a's session on socket b, proving b was a session member.
Nevertheless b's heartbeat, result and detach all returned **4403**,
`controller is not owned by this transport`. The corresponding calls on a succeeded.
Commands/cancels arrived only on a, not on all session viewers.

A separate main-process socket **may** be a controller if it first attaches to the
same live session and then registers itself; it need not be the only chat viewer.
Merely knowing a session ID is insufficient. Result/heartbeat/detach must use the exact
registering socket. Prefer tapping the chat broker socket to avoid additional attachment,
fanout and identity handling. There is another source-level fanout concern:
`_set_session_context` reads `session["transport"].auth_identity`, but `FanoutTransport`
has no such field (`tui_gateway/transport.py:143-177`); attached-viewer tool identity needs
verification/fixing, not an assumption that extra sockets are free.

No model-free public tool invocation RPC was found. The baseline tried `tool.invoke`:
**-32601**, unknown method. In the harness, importing `tools.browser_tool` and calling
`registry.get_entry("browser_navigate").handler(args)` under the corrected session/secret
scope and tool-call context caused a real broker command over WS. The fake controller
returned a result, and the registry returned its JSON string. No model or real browser ran.

**CONTRACT:**
- Foundation should implement `serveClient` on the actual attached broker transport,
  unwrap `event.params.type/payload/session_id`, and preserve the session ID for bridge dispatch.
- ws-agent must send full capability names, include session ID in every result/heartbeat/
  detach, listen to both command **and cancel**, and not invent a cancel RPC.
- The browser feature is **blocked upstream** by local identity admission, missing profile
  metadata, runtime/durable routing mismatch and potentially fanout identity. Broker tapping
  alone fixes none of those. Report mismatch/off honestly; do not forge identity in app code.
- Registration is per session and scope includes profile, but the broker does not enforce a
  global cross-profile lock for a reused `browser_profile_id`. Electron lane scoping/FIFO
  remains the bridge's responsibility.

## 3. Computer-use screenshot/frame source

**Answer: `/api/tools/computer-use/status` contains readiness and permissions, no frame,
image, stream URL or latest screenshot reference. The proposed 2-fps status poll cannot
drive the Mac PiP. CUA capture is synchronous, on demand, not a published frame stream.**

The actual HTTP 200 fixture contains:

```json
{"platform":"darwin","platform_supported":true,"installed":false,"version":null,"ready":null,"can_grant":true,"checks":[],"source":null,"error":null,"accessibility":null,"screen_recording":null,"screen_recording_capturable":null}
```

`installed:false` describes the intentionally isolated probe environment/PATH, **not**
a claim that this Mac lacks a driver. The spike did not open or capture any real CUA session.

**Available data paths, from source:**
- `hermes_cli/web_routers/tools.py:683-702` has only readiness status and a permission-grant
  action. `tools/computer_use/permissions.py:85-107` builds exactly that readiness payload.
- `tools/computer_use/cua_backend_capture.py:230-267,269-317` calls driver MCP
  `screenshot {window_id,format:"jpeg",quality:85,session:<CUA session>}` for vision, with
  `get_window_state {pid,window_id,session,max_elements}` as fallback. AX/SOM capture
  uses `get_window_state`. Returned `CaptureResult` includes `png_b64`, MIME, width,
  height, app, window title and elements (`tools/computer_use/backend.py:62-85`).
  Despite its name, `png_b64` may contain JPEG.
- MCP results carry image parts `{type:"image",data:<base64>,mimeType:<type>}`; the
  flattened result has `images` and `image_mime_types`. Newer structured results may
  carry `structuredContent.screenshot_png_b64` / `png_b64` and MIME fields
  (`tools/computer_use/cua_backend_parse.py:170-202`).
- Full-screen `app="screen"` capture calls `get_desktop_state {session}` and temporarily
  changes driver capture scope, then restores it (`cua_backend_capture.py:319-354`).
  Polling that independently risks changing the active session's state.
- Tool capture results can carry
  `{_multimodal:true,content:[{type:"text",text:...},{type:"image_url",image_url:{url:"data:image/...;base64,..."}}],text_summary,meta:{mode,width,height,...,screenshot_path}}`.
  Non-vision/unchanged-image branches may omit the image and return a JSON text result.
  See `tools/computer_use/tool.py:616-718`; dedup means tool events are not a 2-fps feed.
- Hermes itself persists a shareable image to the owning home's
  `cache/images/computer_use_<uuid>.png` or `.jpg`
  (`tools/computer_use/tool.py:743-772`). Existing capture paths can be fetched through
  authenticated `GET /api/media?path=<absolute image path>`, returning `{data_url}`
  with media-root and size checks (`hermes_cli/web_routers/files.py:307-350`).
  This is **reading a completed capture**, not making a new one or selecting the latest
  frame. Do not indiscriminately tail a profile-wide directory or show another session's image.

There *is* a different native stream: `display.observe` → a single-use ticket and
`/api/display/ws?display_ticket=...`, carrying raw binary **RFB** for Bot Desktop
(`tui_gateway/methods_display.py:149-168`, `hermes_cli/web_routers/display.py:1-18,74-89`).
That runtime is **Linux/Xvnc**, not the Mac CUA background window
(`tools/bot_desktop/runtime.py:79-80`). Baseline `display.status` said `supported:false`,
`running:false`; `display.thumbnail` returned `{data_url:null}`. It is not a substitute
for a local macOS CUA frame service.

**CONTRACT:** Phase 0 computer source is answered with a **missing live Mac feed**.
Wave 2 can show redacted, session-associated capture images from tool results, or
obtain approval for an upstream, session-scoped, read-only capture/frame endpoint.
Do not label status polling "live". A native capture helper must scope to the exact CUA
session/window and apply redaction before UI/storage. No app-side frame API was added.

## 4. `node:sqlite` in Electron 37

**Answer: available and working in the installed Electron, no `sqlite3` CLI fallback
needed for capability reasons.**

Commands run:

```sh
node -p "require('./node_modules/electron/package.json').version"
ELECTRON_RUN_AS_NODE=1 npx --no-install electron -e \
  "console.log(JSON.stringify(process.versions)); const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); console.log(JSON.stringify(db.prepare('select 1 AS works').get())); db.close();"
```

Result: Electron **37.10.3**, embedded Node **22.21.1**, SQLite **3.50.4**;
the in-memory query returned `{"works":1}`, exit 0. Node printed its expected
`ExperimentalWarning` for SQLite. The package range `^37.2.6` is not the installed version.

**CONTRACT:** No native SQLite dependency is necessary on this tested runtime.
This capability result does **not** override the spec's persistence authority: Hermes
owns its databases; prefer serve APIs, do not add app writes to real `state.db`.
Recheck the capability after an Electron upgrade or on a different installed patch.

## 5. Chat-shaped events without a hosted model

**Answer: a real create → prompt → start → terminal-error sequence was captured.
Successful token streaming and model-selected tool/approval turns were not fabricated.**

The unmodified serve used a custom provider pointed at its own loopback
`/no-model` path. No API key was copied and no hosted model request could leave the sandbox.
After `prompt.submit`, the provider received HTTP 405. Captured sequence:

```text
session.create → seeded transcript + runtime/stored IDs
session.resume {stored ID, profile, lazy:true} → runtime ID
prompt.submit {runtime ID, profile, text} → {status:"streaming",user_row_id:2}
event session.info
event message.start (no payload)
event thinking.delta
event status.update {kind:"lifecycle",text:...}
event message.complete {text,usage,status:"error",error,recoverable:true,error_surface}
approval.pending → {approvals:[]}
```

These turn events have increasing per-session `seq`. `status:"streaming"` acknowledges
submission, **not successful inference**. There were no `message.delta` or `tool.*` frames
in that baseline turn.

Separately, the harness called the actual server-request engine with a synthetic approval:
serve sent `{"jsonrpc":"2.0","id":"srq-...","method":"approval","params":{session_id,request_id,command,description,choices,tool_name}}`;
client replied `{"jsonrpc":"2.0","id":"srq-...","result":{"choice":"once"}}`.
The engine returned `{"choice":"once"}`. **No command executed**, and this is not proof of
dangerous-tool policy or a model-issued approval.

Remaining contract-based shapes:
- `message.delta` payload `{text, rendered?}` and `message.complete` terminal state:
  `tui_gateway/contracts/events.py:108-124,184-203`.
- `tool.generating {name}`, `tool.start {tool_id,name,context?,args?,...}`,
  `tool.complete {tool_id,name,result,duration_s?,summary?,result_text?,...}`:
  `tui_gateway/contracts/events.py:259-301`.
- Server requests are peer-to-peer requests, not events. Advertise
  `client.capabilities {server_requests:true}` once per socket. Reply using the original
  server request ID; do not confuse it with approval `request_id`.
  See `tui_gateway/server_requests.py:9-34,70-80,149-175` and
  `tui_gateway/contracts/server_requests.py:57-90`.

**CONTRACT:** Transport tests can consume the error turn and the labeled approval harness
today. A full success/tool/approval integration test still needs either a deterministic
loopback provider stub implementing the completion protocol, or an explicitly approved
model/provider credential in a temporary profile. Browser end-to-end inference additionally
needs the controller blockers in §2 fixed. No real credential or model approval was requested
or used for this spike.

## Completion and chosen fallbacks

- All five task questions and Phase 0 items are answered here. The spec itself was not
  edited because it is outside this worker's owned files.
- **Serve:** single process, explicit per-session profile routing.
- **Browser:** actual attached transport required, but feature remains unavailable until
  upstream identity/profile/routing fixes; no unsafe auth workaround.
- **Computer:** readiness indicator plus completed-capture preview if safely attributable;
  no claimed live Mac PiP until a frame source exists.
- **SQLite:** built-in module available on the tested Electron runtime.
- **Validation:** reproducible baseline/harness probes, probe/fixture vitest suite and
  JavaScript syntax check, all passed (5 vitest tests). No renderer/app code changed, so renderer typecheck/full app
  suite is outside this spike's validation scope.
