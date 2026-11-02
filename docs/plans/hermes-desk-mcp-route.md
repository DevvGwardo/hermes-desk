# Hermes Desk MCP browsing route

Verified **2026-10-06** against the installed, unmodified Hermes source at
`~/.hermes/hermes-agent` (`f42f579`, Hermes 0.21.5). Contracts W3-1 and W3-2 override
the older spec's native-controller-only design.

## Route and scope

```text
Hermes profile P
  -> stdio MCP, newline-delimited JSON-RPC 2.0
  -> hermes-desk-mcp.cjs --profile P --socket <app socket>
  -> Unix socket, newline-delimited app frames
  -> app MCP dispatch -> profile:P lane -> CDP executor -> redactor
```

The shim uses only Node built-ins. It runs under plain Node >=20 or the app's
Electron executable with `ELECTRON_RUN_AS_NODE=1`. `package.json` unpacks just
`electron/local/mcp/shim/hermes-desk-mcp.cjs`, in addition to the existing native-module
unpack pattern. No npm dependency or Hermes patch is needed for the shim.

MCP methods: `initialize`, `ping`, `tools/list`, `tools/call`, and
`notifications/initialized` / `notifications/cancelled`. Initialization echoes
supported versions `2025-06-18`, `2025-03-26`, and `2024-11-05`. Other offers receive
`2025-06-18`, letting the client accept or reject the negotiated version. Only the
tools capability is advertised. No resources, prompts, sampling, JavaScript
evaluation, CDP escape hatch, or model request is exposed.

The app socket is opened lazily. Each connection sends `hello` first, with
`{profile, token, shimVersion, pid}`, where `token` comes only from the configured
`HERMES_DESK_MCP_TOKEN` environment variable, and must receive `result.protocol: 1`. Connection and
hello have a two-second bound. Tool calls have a **90-second total deadline**, including
connection time. Cancellation and deadlines send app `cancel {callId}` when the action
was dispatched; cancellation before hello finishes never dispatches that action.
Call IDs include the shim PID and a per-process sequence.

Disconnected or failed calls are **not replayed**: replaying a click, submit, or type
could repeat a consequential action. A subsequent request can reconnect and send a
new hello. EOF or termination closes the shim's socket and cancels active calls.
Stdout contains protocol frames only; diagnostics go to stderr and do not log arguments.

When the app is absent, initialization still succeeds and `tools/list` still returns:

```text
browser_navigate, browser_snapshot, browser_click, browser_type, browser_press,
browser_scroll, browser_screenshot, browser_back, browser_tabs, browser_tab_activate
```

The shim reads `../tools.cjs` when available (an exported array, `TOOLS`, `tools`, or
`listTools()`), or uses the built-in ten-name catalog with permissive object schemas.
While connected it prefers the app's ten-tool catalog. Packaged standalone shims may
use the fallback while offline because the app catalog stays inside the asar.
The main-side catalog owns the detailed schemas, matching Hermes's browser arguments
(`url`, `ref`, `text`, `key`, `direction`, etc.). The shim forwards arguments unchanged.

Calls while offline return this MCP result, not a JSON-RPC error:

```json
{"content":[{"type":"text","text":"app_unavailable: Hermes Desk is not running"}],"isError":true}
```

App error codes and text/image results pass through. Malformed MCP frames and unknown
protocol methods use JSON-RPC errors. Unknown tool names and malformed tool arguments
use model-visible `bad_args`. A cancelled call additionally returns
`cancelled: Tool call was cancelled` as `isError:true`; late app replies are ignored.

## Exact profile config

For a packaged app, substitute the **actual absolute** executable, unpacked shim and
userData socket paths. Example for profile `spike-alpha`:

```yaml
mcp_servers:
  hermes-desk:
    command: "/Applications/Hermes Desk.app/Contents/MacOS/Hermes Desk"
    args: ["/Applications/Hermes Desk.app/Contents/Resources/app.asar.unpacked/electron/local/mcp/shim/hermes-desk-mcp.cjs", "--profile", "spike-alpha", "--socket", "/Users/example/Library/Application Support/Hermes Desk/mcp/hermes-desk.sock"]
    env: { ELECTRON_RUN_AS_NODE: "1", HERMES_DESK_MCP_TOKEN: "<generated 32-byte random hex credential>" }
    tools: {}
agent:
  disabled_toolsets:
    - browser # hermes-desk: added browser
```

In development, use `require('electron')` for the absolute Electron binary, the
absolute source shim path, and the app's actual socket path. Plain Node is supported
by using an absolute Node executable instead; do not use a shell wrapper or bare
`node` that might trigger Hermes's managed-runtime installer.

**Never use `tools: all`.** Hermes's registration and utility filtering call `.get()`
on that value and expect a mapping. `tools: {}` registers all tools without filters.
Hermes namespaces the names as `mcp__hermes_desk__browser_navigate`, etc.; the server
must not pre-prefix its own tool names.

The real per-profile browser-disable key is **`agent.disabled_toolsets: [browser]`**,
not `browser.enabled` or `browser.extension_control.enabled`.
Source evidence:

- `hermes_cli/profiles.py:220-230,352-364`: the default config lives at
  `<hermesHome>/config.yaml`; named configs live at
  `<hermesHome>/profiles/<P>/config.yaml`. No inheritance from the default config.
- `tui_gateway/server.py:2050-2069`: the desktop/TUI agent loader forwards
  `agent.disabled_toolsets`. The MCP tools belong to their own MCP toolset.
- `hermes_cli/config.py:1422-1449` calls
  `hermes_cli/mcp_security.py::validate_mcp_server_entry`. The absolute Electron/Node
  command and script arguments have neither shell-egress/persistence shapes nor
  known compromise indicators.
- `tools/mcp_tool_config.py` applies the same security filter at spawn, resolves
  absolute launchers without installing a managed Node, and builds the filtered
  child environment. `tools/mcp_tool_registration.py::_make_tool_filter` accepts
  the empty mapping.

## Config-writer API and consent

```js
const { planEnable, planDisable, apply } = require('./mcp/config-writer.cjs')
const plan = planEnable({
  hermesHome, profile, entry: mcp.configEntryFor(profile),
  disableBuiltinBrowser: true, // default; false leaves the existing selection alone
})
// plan = {path, before, after, diff, credential}; planning never writes.
// Main must show plan.diff in a native confirmation after an explicit user click.
// Only after confirmation:
const result = apply(plan, { backup: true })
// result = {path, backupPath, changed}
```

`apply` defaults to backup, preserves the existing config permissions, writes a
same-directory temporary file, fsyncs it, and renames atomically. Existing files
are backed up as `config.yaml.bak-hermesdesk-<timestamp>-<suffix>` with mode 0600.
New configs use mode 0600. Stale previews and symlinked configs/profile directories
are refused. The supplied Hermes root is canonicalized so macOS `/tmp` and `/var`
aliases work.

`configEntryFor(P)` proposes a fresh 32-byte random profile token. `planEnable`
preserves that proposal, or supplies a token for legacy entries that lack one;
reusing a currently installed token produces a fresh rotation instead. Planning
does not activate or revoke credentials. The diff replaces token values with
`[redacted]`; raw `before`, `after`, and `credential` stay main-only.

Only confirmed `apply` persists authority in the app socket directory,
`<userData>/mcp/profile-tokens.json` (0600, directory 0700). It stages and fsyncs
the credential change before replacing YAML, then atomically replaces the token
file. A failed/stale/cancelled preview does not rotate existing authority.
Re-enable rotates the profile's token; disable removes it from both the active
YAML entry and the app store. Private YAML backups intentionally retain the
previous config, but their old token is no longer authoritative. Other profiles'
tokens remain unchanged. Filesystem failures between the two renames are not a
cross-file atomic transaction: a newly written config may require a confirmed
re-enable to restore matching credentials. No auto-repair or automatic config
write occurs.

The writer does **not** present UI or infer user consent. The host/settings owner
must supply the native diff confirmation and must never call `apply` automatically.
Both enable and disable require that same flow.

Only `mcp_servers.hermes-desk` and the browser-disable setting are edited. Unrelated
lines, quoting, comments and newline style survive. Comments from a replaced MCP
entry are retained as comment lines. New browser list entries carry an ownership
comment; scalar/flow-list rewrites carry a comment recording the original line so
undo can restore it exactly. Pre-existing browser disables are never removed.
If the user changes a rewritten scalar/flow list before undo, the writer refuses
instead of overwriting the newer preference.

`yaml` is not installed; `js-yaml` is installed but cannot preserve comments.
Consequently the runtime writer uses a narrow dependency-free line editor.
It supports ordinary block mappings, quoted keys, empty parent mappings, scalar or
flow-list toolset selections, and indented/indentless block lists. It refuses
ambiguous target forms such as YAML merge keys, aliases, nonempty parent flow
mappings, duplicate target keys, tabs and document directives. Convert those target
parents to explicit block mappings before using the UI. It is not a general YAML
validator or reformatter.

## Default Tool Search (D1, wave 6)

The installed source's default is `tools.tool_search.enabled: auto`. It **defers
all MCP schemas**, including Hermes Desk, behind `tool_search`, `tool_describe`
and `tool_call`. This is working discovery, not a missing browser toolset.
`tools.tool_search.defer: []` does **not** pin MCP tools: MCP membership remains
deferrable independently of that list. No supported per-server allowlist,
`always_loaded`, or pin key exists in this revision. The writer therefore leaves
Tool Search and discovery timeouts alone, rather than disabling it globally or
writing an ignored setting.

With a new/restarted enabled profile session, the model can use:

```json
{"queries":["hermes desk browser"],"limit":25}
```

Then `tool_describe {"names":["mcp__hermes_desk__browser_navigate"]}` and
`tool_call {"calls":[{"name":"mcp__hermes_desk__browser_navigate","arguments":{"url":"https://example.invalid/"}}]}`.
Exact-name search works for all ten tools. The default bridge manifest also lists
them when its budget permits. Do not use the builtin unprefixed browser names
when that toolset was disabled by the enable flow.

Read-only source evidence: `tools/tool_search.py:41–85,150–178,351–388,446–574`
and `hermes_cli/config_defaults.py:531–541,1982–2021`. The opt-in regression uses
the real config loader, registry and Tool Search assembly/search/describe/call
resolver with the production ten-tool catalog and a writer-generated temp config:

```sh
HERMES_DESK_TOOL_SEARCH_PROBE=1 npx --no-install vitest run tests/redteam/tool-search.test.ts
```

It passed with default `auto`, all ten discoverable, and unchanged config.
This proves bridge discoverability and argument-resolution plumbing, not
model-selected browsing. The separate real-Hermes load probe still proves
stdio discovery and a handler call. The default 1.5-second first-build discovery
window can miss a cold server; upstream's between-turn refresh recovers it.
Neither a first-turn model choice nor a simultaneous multi-profile serve is
claimed here.

## Probe: real Hermes spawning and calling the shim

From the repository:

```sh
npx --no-install vitest run \
  electron/local/mcp/config-writer.test.mjs \
  electron/local/mcp/shim/hermes-desk-mcp.test.mjs \
  scripts/spikes/mcp-hermes-load.test.mjs
node scripts/spikes/mcp-hermes-load.mjs
node scripts/spikes/mcp-hermes-load.mjs --runtime node
HERMES_DESK_MCP_HERMES_LOAD=1 npx --no-install vitest run electron/local/mcp/hermes-load.test.mjs
```

Recorded result: **45 tests passed in 3 files**. Tests include standalone Electron
and Node processes, absent-app discovery, reconnect without replay, typed errors,
images, concurrent response routing, cancellation, the 90-second timeout,
comment-preserving config edits, reversible browser disabling, backups, permissions,
stale previews, symlink refusal and probe-environment isolation.

Both integration commands exited **0**. Electron was **37.10.3**; plain Node was
**22.22.2**. Each probe tested **default -> spike-alpha -> default**, using separate
Hermes processes against the same disposable root. Every run returned this actual
receipt shape (the profile/call result changes for the middle run):

```json
{
  "profile": "default",
  "config_accepted": true,
  "suspicious_warnings": [],
  "profile_paths_confirmed": true,
  "builtin_browser_disabled": true,
  "connected": true,
  "tool_count": 10,
  "registered_tools": [
    "mcp__hermes_desk__browser_back",
    "mcp__hermes_desk__browser_click",
    "mcp__hermes_desk__browser_navigate",
    "mcp__hermes_desk__browser_press",
    "mcp__hermes_desk__browser_screenshot",
    "mcp__hermes_desk__browser_scroll",
    "mcp__hermes_desk__browser_snapshot",
    "mcp__hermes_desk__browser_tab_activate",
    "mcp__hermes_desk__browser_tabs",
    "mcp__hermes_desk__browser_type"
  ],
  "call_result": {"result": "fake app: navigate round-trip (default)"},
  "socket_methods": ["hello", "tools/list", "tools/call"]
}
```

The outer receipt reported `shim_spawned:true`, `no_model_calls:true`, and
`tcp_ports_bound:[]`. The probe:

1. Creates a disposable `/tmp/hd-mcp-probe-*` home, token-bearing configs through the actual config
   writer, fake app Unix socket, and an allowlisted environment with no inherited
   credentials and `HERMES_DISABLE_LAZY_INSTALLS=1`.
2. Uses macOS `sandbox-exec` to forbid non-temp writes, reads of real Hermes state
   outside the source tree, all IP outbound traffic, and all binds in the child.
   The fake app listens only on its private Unix socket outside the child sandbox.
3. Calls Hermes's actual `_disable_suspicious_mcp_servers`, `_load_mcp_config`,
   `discover_mcp_tools`, `get_mcp_status`, and the registered
   `browser_navigate` handler. No MCP SDK is replaced, no identity is fabricated,
   and no Hermes module is monkeypatched.
4. Confirms a separate shim PID, hello before tools, all ten registered tool names,
   and exact profile/name/arguments/callId at the fake socket.
5. Shuts down Hermes's MCP servers and removes only its own temporary home/socket.

This proves **config acceptance, stdio spawn, handshake, discovery, and a
model-free registry call round-trip**. It does not prove model-selected browsing,
CDP execution, redaction, native dialogs, simultaneous sessions in a multi-profile
serve, or a packaged app launch. Those belong to the app-side/integration workers.
Neither port 8642 nor 9119 was bound or contacted, and no real profile was edited.

Wave-5 revalidation: the Electron and plain-Node spike commands still exit **0**
with token-bearing entries generated by `planEnable`. The adjacent opt-in
`hermes-load.test.mjs` reruns the unchanged spike and observes its disposable app
socket; all three hello tokens match the stored profile authority and the store
is 0600. It records only boolean receipts, not token material. The focused MCP
and spike-isolation suite passes 117 tests, with the real-Hermes test run separately.

## Concurrency and lane limits

MCP tool calls have **no Hermes session ID**. Server-verified profile-token admission
is the authority for lane selection, so every conversation, CLI task and background run
using this profile shares **one profile lane**, not a per-chat lane. A tool argument
must not be allowed to override that profile.

The shim correlates concurrent requests independently. The app owns FIFO
serialization per profile lane, takeover, enabled-profile gating and auditing;
different profile lanes may run in parallel. Installed Hermes additionally serializes
registered handler RPCs per server connection with its `_rpc_lock`.
Takeover steering must use the app's current `getSessionForProfile(P)` mapping;
MCP cannot identify which of several profile conversations originated a call.

The main-side worker must create `<userData>/mcp` with mode 0700 and the
`hermes-desk.sock` socket with mode 0600, enforce
`workspace.enabledProfiles`, and handle cancel by the unique callId.

### Profile authority and remaining same-UID risk (HD-06)

The socket refuses tools/list, tools/call and cancel until a successful hello.
It verifies the token against the app's stored credential for the claimed profile,
independently of client input, and checks the live enabled-profile gate. PID and
shimVersion are compatibility metadata, not authentication. A connection cannot
re-hello or change profiles. Every subsequent request, including cancel, must carry
the pinned profile; the stored token is rechecked so rotation/revocation invalidates
already-connected shims on their next request. Cancellation remains owner-bound.
Admission errors are fixed text and never echo token material.

**This does not isolate a hostile process running as the same macOS user.**
Same-UID processes can read profile configs, app credentials, or shim environments.
Tokens stop cross-profile confusion and casual unauthenticated misuse, not hostile
same-user code. Strong isolation would need a genuine OS/sandbox identity boundary.
The local user and their same-UID programs remain trusted; do not claim Unix modes
or these profile tokens establish stronger authority.
Pre-token installations must be re-enabled through the confirmed settings flow
and their Hermes sessions restarted. Old tokenless shims are refused; there is
no automatic migration that writes a real profile config.

### Aggregate admission budgets (HD-07)

Defaults are 32 admitted connections, 16 MiB of aggregate input allocation plus
pending output, 32 in-flight frames per connection, and 128 across all connections.
Incomplete frames expire after five seconds (not extended by trickling bytes);
idle connections expire after 60 seconds. Completed input releases its allocation,
and write callbacks/disconnects release output reservations. Over-budget peers
receive `resource_limit`; deadline failures use `timeout`.

Dispatch admits at most 128 unresolved calls globally and 32 per lane, including
the active call, with at most 64 KiB of serialized arguments per call. Arguments
are copied at admission. The 30-second execution deadline includes queue wait.
Cancelled/timed-out queued calls release capacity immediately; active calls retain
their lane lock and admission slot until their executor unwinds or the wave-6
watchdog tears down its tab. A stuck dependency cannot keep one lane locked forever.
Cancellation bypasses request/queue capacity limits while retaining authentication
and owner checks. Tool overload errors are `isError:true` content, not JSON-RPC
errors; connection-level errors close that peer, and the shim preserves their
typed code on a tool call. Offline tool discovery still works.

These are application admission/buffer budgets, not a claim to cap every transient
V8, kernel, CDP, or image allocation. Limit options can be reduced for bounded
regression fixtures.

### Bounded shim and lane recovery (J3/C9, wave 6)

The stdio shim now admits at most 32 concurrent requests, **including tools/list**.
It rejects frames over 64 KiB, over-budget input batches, invalid UTF-8 and
request IDs over 256 characters. An incomplete frame expires after five seconds,
without a sliding/trickle extension. Stdout pauses stdin on backpressure, accounts
for pending writes against a 16 MiB ceiling, and closes on excess rather than
buffering indefinitely. App-socket writes have a 1 MiB pending-write ceiling.
Cancellation notifications bypass request admission; they remain usable while
requests are at capacity, but cannot bypass a stalled parent stdout pipe.
Existing protocol-only stdout, fixed stderr diagnostics, offline discovery,
Node/Electron standalone operation, and no-replay semantics remain intact.

Dispatch still returns a typed `timeout` at the admission-to-completion 30-second
deadline. If the dependency ignores abort for another two seconds, it closes the
specific tab without waiting for beforeunload and retires that active queue item.
Initialization hangs retain the just-created tab as a teardown target. Tab
activation watches the target tab rather than the lane's previous active tab.
Late results cannot resolve the original call, release a newer lock or dispatch
later input through its aborted signal. Replacement work runs only after teardown
was requested and the target was removed from the lane. If teardown fails, that
lane is quarantined (`blocked_by_policy`) until app restart; other lanes keep
working. Disposal has the same bounded abort/unwind path.

Already-dispatched page side effects cannot be rolled back by closing a tab.
This watchdog does not turn arbitrary dependencies into killable processes or
repair a blocked main-process event loop. See the security-acceptance checklist.

## Undo

On an explicit Disable click, create and confirm:

```js
const plan = planDisable({ hermesHome, profile, restoreBuiltinBrowser: true })
// Show plan.diff in a native confirmation, then:
apply(plan, { backup: true })
```

This removes only the `hermes-desk` MCP entry and reverses browser disables added by
this writer. It preserves pre-existing disables and other MCP servers. Use
`restoreBuiltinBrowser:false` to intentionally keep the browser disabled.
Start a new Hermes session or explicitly reload/restart MCP after a config change;
an already-running shim/agent may still hold the old config. Do not assume an
existing conversation's tool schemas change automatically.

For manual recovery, compare the timestamped backup before restoring it, since a
whole-file restore also replaces unrelated changes made after the backup.
