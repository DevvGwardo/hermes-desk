# Hermes Desk: cross-module contracts (wave 1)

The spec is `docs/plans/2026-10-06-hermes-local-desktop-spec.md`. This file fixes the interfaces
*between* modules so that parallel workers can build them without touching each other's files.
If you need something a contract doesn't give you, code against the closest shape, leave a
`// CONTRACT:` comment, and note it in your report. **Don't edit files you don't own.**

## 0. Separate project (overrides spec D1, D10 and §4.1)

Hermes Desk is now **its own repo** (`~/hermes-desk`), cloned from maiavm-desktop @ `b710c06`.
- There is **no flavor switch**. No `APP_FLAVOR`, no `src/lib/flavor.ts`, no `isLocalFlavor()`,
  no `electron/flavor.json`, no `--mode local`, no `index.local.html`, no dual-bundle guard tests.
  The app is *always* the local Hermes app. Where the spec says "in the local flavor", read "always".
- Platform code (nub-link, VM, updater, billing, invites, marketplace purchase, mobile/Capacitor,
  PostHog) gets **removed**, not gated. Wave 1 removes the Electron side (the `foundation`
  worker). Wave 2 prunes the renderer side.
- appId `com.devgwardo.hermesdesk`, productName `Hermes Desk`, package name `hermes-desk`.
- The global bridge name stays `window.nubAgent` so shared renderer code keeps working.
- The `upstream` remote is maiavm-desktop (push disabled). Cherry-pick shared fixes from it.

## 1. Electron main: boot seam (owner: foundation)

`electron/main.cjs` calls, once the app is ready and the main window exists:

```js
require('./local/boot.cjs')(ctx)
// ctx = { app, ipcMain, ipcHandle, assertMainSender, getMainWindow, BrowserWindow,
//         WebContentsView, session, dialog, shell, userDataDir, isPackaged, serveAuth, secretsOp, notify }
```

`boot.cjs` builds, in order:
1. `hermesHost = require('./hermes-host.cjs').createHermesHost(ctx)`, which returns
   `{ start(), stop(), status(), restartServe(), onStatus(cb) -> unsub, getServeClient() }`.
2. `serveClient = hermesHost.getServeClient()`: a **main-process JSON-RPC client** over serve's
   `/api/ws` (`electron/local/serve-client.cjs`, also owned by foundation):
   ```js
   { connected: boolean,
     call(method, params) -> Promise<result>,          // rejects {code, message}
     onEvent(cb(eventName, params)) -> unsub,           // server notifications
     onRequest(method, async handler(params) -> result) -> unsub,  // server->client requests
     notify(method, params),                            // client->server notification (no id)
     onConnection(cb(connected)) -> unsub }
   ```
   If the spike finds the controller must be registered *on the same socket as the renderer's
   session*, foundation adds `serveAuth`-broker tapping behind this same interface. Callers don't change.
3. `const ws = require('./workspace/index.cjs').registerWorkspace({ ...ctx, serveClient, hermesHost })`,
   which returns `{ lanes, views, dispose }` (owner: ws-main). ws-main constructs the bridge (§3)
   inside `registerWorkspace` by requiring `./controller-bridge.cjs`.
4. Host IPC (`hd:host:*`, owner: foundation). The computer PiP (`hd:computer:*`) comes in wave 2.
5. `app.on('before-quit')` → `ws.dispose()`, `hermesHost.stop()`.

## 2. IPC channels (preload owner: foundation; handlers: as listed)

All handlers use `ctx.ipcHandle` (invoke/handle). Events are `webContents.send` to the main window.

| Bridge method (`window.nubAgent.*`) | Channel | Handler owner |
|---|---|---|
| `host.status()` | `hd:host:status` | foundation |
| `host.restartServe()` | `hd:host:restartServe` | foundation |
| `host.enableBrowserControl(profiles)` | `hd:host:enableBrowserControl` | foundation (stub OK in wave 1) |
| `host.onStatus(cb)` | event `hd:host:status-changed` | foundation |
| `workspace.setBounds(rect)` | `hd:ws:setBounds` | ws-main |
| `workspace.list()` | `hd:ws:list` | ws-main |
| `workspace.openTab(laneId, url?)` | `hd:ws:openTab` | ws-main |
| `workspace.closeTab(tabId)` | `hd:ws:closeTab` | ws-main |
| `workspace.activate(tabId)` | `hd:ws:activate` | ws-main |
| `workspace.focusLane(laneId)` | `hd:ws:focusLane` | ws-main |
| `workspace.navigate(tabId, urlOrQuery)` | `hd:ws:navigate` | ws-main |
| `workspace.back/forward/reload(tabId)` | `hd:ws:back` / `hd:ws:forward` / `hd:ws:reload` | ws-main |
| `workspace.setVisible(visible)` | `hd:ws:setVisible` | ws-main |
| `workspace.giveToAgent(tabId, profile, instruction?)` | `hd:ws:giveToAgent` | ws-main |
| `workspace.returnToUser(tabId)` | `hd:ws:returnToUser` | ws-main |
| `workspace.resumeAgent(laneId)` | `hd:ws:resumeAgent` | ws-main |
| `workspace.copySignIn(origin, fromLane, toLane)` | `hd:ws:copySignIn` | ws-main (stub OK in wave 1) |
| `workspace.onState(cb)` | event `hd:ws:state` (payload `WorkspaceState`) | ws-main |
| `computer.*` | `hd:computer:*` | wave 2 |

Types for every payload are in `src/lib/desktop-bridge.ts` (renderer). Main-side code produces
exactly those shapes. ID formats: `laneId` = `you` | `profile:<name>`, where name matches
`^[a-z0-9][a-z0-9_-]{0,63}$`; `tabId` = `t_<base36>`.

## 3. Workspace internals (ws-main ⇄ ws-agent ⇄ redactor)

**`lanes` (ws-main, `electron/local/workspace/lanes.cjs`)**
```js
lanes.ensureLane(laneId) -> Lane          // Lane {id, kind:'user'|'agent', profile?, partition, paused}
lanes.listTabs(laneId) -> Tab[]
lanes.getTab(tabId) -> Tab | null
lanes.getActiveTab(laneId) -> Tab | null
lanes.openTab(laneId, url?, {createdBy:'user'|'agent'}) -> Promise<Tab>
lanes.activateTab(tabId, {steal:false})    // steal=false: don't change what the user sees
lanes.closeTab(tabId)
lanes.setTabState(tabId, 'idle'|'loading'|'agent-acting'|'user-paused')
lanes.isPaused(laneId) -> boolean
lanes.on('user-input', ({laneId, tabId}) => …)   // emitted by takeover.cjs
lanes.on('changed', () => …)
// Tab {id, laneId, partition, url, title, favicon, state, controller:'user'|'agent',
//      createdBy, sharedLogin, discarded,
//      ensureLive() -> Promise<WebContents>, webContents|null}
```
**`overlay` (ws-main, views.cjs + overlay.html):** `overlay.send(msg)` where msg is
`{type:'cursor', x, y, phase:'move'|'press'|'release', color, label}` |
`{type:'masks', rects:[{x,y,width,height}]}` | `{type:'clear'}`. Coordinates are CSS px of the active tab view.
`overlay.waitFrame() -> Promise<void>` resolves after the overlay has painted (used before screenshots).

**`urlPolicy` (ws-main, url-policy.cjs):** `check(url, {laneKind, servePorts:number[]}) -> {ok:true, url} | {ok:false, reason}`.
**`audit` (ws-main, audit.cjs):** `audit.log({agent, lane, tab, action, origin, result, durationMs, byUser})`, which writes `userData/audit.jsonl` (5MB × 3 rotation).

**`redactor` (redactor worker, redactor.cjs). Pure, no Electron imports, fail-closed:**
```js
// SnapNode {ref, role, name, value?, backendNodeId, attrs:{tag, type, autocomplete, name, id,
//           ariaLabel, inputmode, maxlength, contenteditable}, nearbyText?}
redactNodes(nodes, {formGroups?}) -> nodes   // sets node.sensitive=true and node.value=undefined; scrubs name/value text
isSensitiveNode(node) -> boolean
scrubText(str) -> str                        // cards → [card ••••1234], OTP-near-keyword → [code], tokens → [secret]
looksLikeSecret(str) -> boolean              // for Paste and secret detection
renderSnapshot(nodes) -> string              // `[ref=e12] button "Sign in"`; sensitive: `textbox "Password" [ref=e7] (sensitive, value hidden)`
// Any internal error must THROW a RedactionError (exported). Callers map it to blocked_by_policy.
```

**`cdp-exec` (ws-agent):** `createCdpExecutor({redactor, overlay, urlPolicy, securePrompt, lanes, audit})`
→ `{ run(tab, action, args, {signal, agent:{profile,name,color}}) -> Promise<result> }`, implementing spec §9.5.
Errors are typed `{code:'user_took_control'|'blocked_by_policy'|'timeout'|'no_such_ref'|'tab_closed'|'bad_args'}`.

**`controller-bridge` (ws-agent):** `createControllerBridge({serveClient, lanes, overlay, urlPolicy, redactor, securePrompt, audit, installId, servePorts})`
→ `{ registerForSession(sessionId, profile), detach(sessionId), cancelLane(laneId, code), status() -> 'off'|'connecting'|'ready'|'error'|'mismatch', onStatus(cb), dispose() }`.
It listens to `serveClient.onEvent('browser.controller.command')`, runs the command through a per-lane FIFO,
and replies with `serveClient.call('browser.controller.result', …)`. Use the exact frame names from Hermes's
`apps/shared/src/gateway-contract.generated.ts` (under `~/.hermes/hermes-agent`) if they differ from the spec.
ws-main calls `bridge.cancelLane(laneId, 'user_took_control')` when takeover fires.

**`secure-prompt` (ws-agent):** `createSecurePrompt({dialog, secretsOp, getMainWindow})` → `{ requestFill({agentName, fieldLabel, origin}) -> Promise<{ok:true, value} | {ok:false}> }`.
The value never leaves main. `secrets-op.cjs` gains `resolveForFill(ref)` (ws-agent).

## 4. Renderer

- `src/lib/desktop-bridge.ts` (shared, read-only for workers; ask in your report if it needs to change).
- The renderer never touches tab webContents and never holds a Hermes token.
- New styles go in their own CSS files (`src/styles/skin-messenger.css`, owner skin-chat;
  `src/styles/skin-messenger-sidebar.css`, owner sidebar; `src/styles/workspace.css`, owner ws-ui).
  Each component imports its own CSS. `App.tsx` integration is wave 2: don't edit `App.tsx`.

## 5. Ground rules for every worker
- Work only in your owned files (plus new test files next to them). Commit on your branch, never push.
- Verify: `npx vitest run <your test files>`; renderer workers also run `npx tsc -b --noEmit` or `npx tsc -p tsconfig.app.json --noEmit`
  and report any errors in files you own. Don't "fix" other files' errors.
- Never modify `~/.hermes` or any real profile config. Never start anything on ports 8642 or 9119.
- No network calls to hosted services. No secrets in fixtures (use obviously fake values).

---

# Wave 2 additions (2026-10-06, after wave 1 merged)

Wave-1 facts that override the spec (details: `docs/plans/hermes-desk-phase0-findings.md`, worker notes in code):
- One `hermes serve` hosts every profile. No per-profile serve fallback.
- `session.resume` takes the **stored** session id. `prompt.submit` and controller RPCs take the **runtime** id. Replay is
  `session.events.since {session_id, last_seen}`. `session.history` has no paging, so it's paged locally.
- Controller RPCs must go over the **renderer session's own socket**: `serveClient.bindRendererBroker()` (foundation).
  **Native browser control does not work end-to-end against the installed Hermes** (upstream auth identity / profile lookup /
  runtime-vs-stored id blockers). Keep all controller code, but the UI must show this honestly (`controller: 'error'` with detail),
  and nothing may patch Hermes or forge identity. The owner decides the fix.
- Computer use has **no live Mac frame source**. The PiP shows the latest *completed* capture preview, labelled as such.

## W2-1. Single prefs store
`src/lib/local-prefs.ts` (sidebar, wave 1) is THE prefs store. `HermesLocalTransport` gets `getPrefs/setPrefs` adapters over it
(fields `pinnedOrder`, `hidden`, `showScratch`, `sources`). Owner: integrate.

## W2-2. New IPC (handlers are in main; preload, `vite-env.d.ts` and `desktop-bridge.ts` are owned by electron-int)
| Bridge | Channel | Implemented in |
|---|---|---|
| `workspace.registerSession({profile, storedId, runtimeId})` | `hd:ws:registerSession` | electron-int → `ws.lanes.registerForSession` / bridge |
| `workspace.stopAll()` (⌘.) | `hd:ws:stopAll` | electron-int: `session.interrupt` for active turns + pause every lane |
| `host.auditTail(n)` | `hd:host:auditTail` | `electron/local/host-config.cjs` (settings) → wired by electron-int |
| `host.enableBrowserControl(profiles)` | `hd:host:enableBrowserControl` | `host-config.cjs` (settings) → wired by electron-int |
| `host.getConfig()` / `host.setConfig(patch)` | `hd:host:getConfig` / `hd:host:setConfig` | `host-config.cjs` (settings): app settings in `userData/settings.json` (serve mode/port, workspace limits, search engine, allow/deny lists, downloads dir, PiP prefs) |
| `computer.*` | `hd:computer:*` | `electron/local/computer-pip.cjs` (pip) exports `registerComputerPip(ctx)` and registers its own handlers through `ctx.ipcHandle`; boot (electron-int) calls it in a try. |

`host-config.cjs` exports: `createHostConfig({userDataDir, hermesHome, serveClient, dialog, getMainWindow})` →
`{ getConfig(), setConfig(patch), enableBrowserControl(profiles) -> ConfigDiff, auditTail(n) -> AuditEntry[] }`.
`enableBrowserControl` shows a diff in a native confirm, backs up `config.yaml.bak-hermesdesk-<ts>`, and only then writes. It runs
only on an explicit user click and is never auto-run. Tests use a temp HERMES_HOME.

## W2-3. Secure server requests
`secret` / `sudo` / `vault.*` server requests on the renderer's relayed socket are intercepted in main (serve-client broker tap)
and answered through `secure-prompt.cjs`. The renderer never sees them. Owner: electron-int.

## W2-4. App shell
`App.tsx` + `src/main.tsx` + `SidePanel.tsx` (owner: integrate) compose: the new Sidebar, the messenger ChatPanel, the
WorkspacePane in the right dock (▣ toggle), ComputerPip launcher, the offline banner, keyboard map (⌘1–9 agents, ⌘T user tab,
⌘⇧T agent tab, ⌘. stopAll). Platform components are removed from App by integrate; the cleanup worker deletes their files.

---

# Wave 3: agent browsing over a Hermes Desk MCP server (owner chose the "best route" 2026-10-06)

Native `browser.controller.*` is blocked upstream (phase-0 findings), so agents reach their workspace lane through an
**app-provided MCP server**. Hermes stays unpatched. The controller-bridge code stays as a secondary path for when upstream is fixed.

```
Hermes (profile P) ──stdio MCP──► shim (hermes-desk-mcp.cjs, spawned by Hermes) ──unix socket NDJSON──► Hermes Desk main
                                                                                          └► mcp/dispatch → lanes(profile:P) → cdp-exec → redactor
```

## W3-1. Profile config entry (written by `electron/local/mcp/config-writer.cjs`; applied only on the user's click)
```yaml
mcp_servers:
  hermes-desk:
    command: <absolute path of the app's Electron executable>     # dev: node_modules/electron binary
    args: [<abs path of shim .cjs (asar.unpacked in packaged builds)>, --profile, <P>, --socket, <abs socket path>]
    env: { ELECTRON_RUN_AS_NODE: "1" }
    tools: {}          # NEVER `tools: all` (crashes Hermes ≥0.15.1)
```
Plus, optionally (default on, reversible), the profile's built-in `browser` toolset is disabled, so the model doesn't use headless
Chromium instead. The worker confirms the exact config keys in Hermes source. The entry must pass Hermes's
`_disable_suspicious_mcp_servers` check (`hermes_cli/config.py`) and `tools/mcp_tool_config.py`. Every write shows a diff, backs up to
`config.yaml.bak-hermesdesk-<ts>` and gets native confirmation. Removal is symmetric.

## W3-2. Socket protocol (app ⇄ shim)
- Socket: `<userData>/mcp/hermes-desk.sock`, dir mode 0700, socket 0600. NDJSON, one JSON object per line.
- shim→app `{id, method:'hello', params:{profile, shimVersion, pid}}` → `{id, result:{protocol:1, appVersion}}` or `{id, error:{code, message}}`
- shim→app `{id, method:'tools/list', params:{profile}}` → `{id, result:{tools:[<MCP Tool: name, description, inputSchema>]}}`
- shim→app `{id, method:'tools/call', params:{profile, name, arguments, callId}}` → `{id, result:{content:[{type:'text',text}|{type:'image',data,mimeType}], isError?}}`
- shim→app `{method:'cancel', params:{callId}}` (from MCP `notifications/cancelled`)
- Typed failures (`user_took_control`, `blocked_by_policy`, `timeout`, `no_such_ref`, `tab_closed`, `bad_args`, `not_enabled`,
  `app_unavailable`) are returned as `isError:true` text content `"<code>: <human message>"`, never JSON-RPC errors (the model must see them).
- Profile gate: the app refuses calls unless P is in `getConfig().workspace.enabledProfiles` → `not_enabled`.
- If the app isn't running or the socket is missing, the shim still completes the MCP handshake and lists the tools, then answers each call with
  `app_unavailable: Hermes Desk is not running`.
- Tool names (no prefix; Hermes namespaces MCP tools itself): `browser_navigate, browser_snapshot, browser_click, browser_type,
  browser_press, browser_scroll, browser_screenshot, browser_back, browser_tabs, browser_tab_activate`, with arguments mirroring
  Hermes's own browser tool schemas (read them in `~/.hermes/hermes-agent/tools/browser*`).

## W3-3. Main seam
`require('./mcp/index.cjs').registerMcp({ userDataDir, lanes, overlay, urlPolicy, redactor, securePrompt, audit, getConfig,
getSessionForProfile, serveClient, isPackaged, appPath })` → `{ status() -> {state:'off'|'ready'|'error', detail, socketPath},
onStatus(cb), configEntryFor(profile) -> object, dispose() }`.
Boot (electron-int) calls it after `registerWorkspace`. To support that, `registerWorkspace` also returns
`parts: {lanes, overlay, urlPolicy, redactor, securePrompt, audit}`. `host.status().controller` reports the MCP route's state;
`'ready'` = socket listening. Takeover steering uses `getSessionForProfile(P)` (from `hd:ws:registerSession`).
