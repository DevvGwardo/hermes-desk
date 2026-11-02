# Hermes Desk: a local-Hermes desktop app built on maiavm-desktop

> **Status:** Spec v1, 2026-10-06. Nothing is implemented yet.
> **Working name:** *Hermes Desk*. Build flavor id `hermes-local`, appId `com.devgwardo.hermesdesk`.
> **Base:** `maiavm-desktop` @ `b710c06` (v0.1.38). Local Hermes `0.21.5+4905.gf42f579` (state.db schema v31).
> **Reference UI:** the "Hermes — Alan's way" screenshot. It has a bot sidebar, a chat pane, a "Workspace — on your Mac" tabbed browser, a "VPS computer" PiP, and a footer reading "TELEGRAM · MAC · VPS".
> **Telegram is visual only.** The reference app is *styled* like Telegram. Hermes Desk copies that look (§8) and has **no Telegram integration**: no bot chats, no inbox, no messaging platforms.
> **Local only.** Everything runs on this Mac: the app, Hermes and the browser. There is no VPS, remote machine, cloud handoff or hosted service. The reference's "VPS computer" becomes a view of the agent's own Mac session.

> **2026-10-06 change (owner): separate project.** Hermes Desk lives in its own repo (`~/hermes-desk`),
> cloned from maiavm-desktop @ `b710c06`. That replaces D1/D10 and §4.1: there is no flavor switch, platform code is
> removed rather than gated, and Nub Agent is untouched by construction. Module interfaces for the parallel build
> are in `docs/plans/hermes-desk-contracts.md`, which wins where it differs from this spec.

---

## 0. Summary of decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Same repo, second build flavor.** No fork. | Gets the most out of the existing code. A fork would drift. That has already happened once: the orb engine copied into yeti-trader is now out of sync. One `APP_FLAVOR` switch picks the build-time branding, transport and feature gates. |
| D2 | **Chat runs over `hermes serve` (tui_gateway JSON-RPC over WS)**, not the 8642 gateway. | maiavm already ships `HermesServeTransport` for it. It is the richest protocol: server→client `approval`, `clarify` and `secret` requests, `browser.controller.*`, per-session events. One process can host several profiles, so it avoids the shared-bot-token problem that blocks gateway multiplexing. The official Hermes.app uses the same contract. |
| D3 | **The 8642 gateway is left alone.** The app reads its `/health` only. | It already runs under launchd (`ai.hermes.gateway`) for Hermes's own purposes. The app doesn't depend on it or on any messaging platform. |
| D4 | **Agents = Hermes profiles.** | `~/.hermes/profiles/<name>/` already holds SOUL, memory, skills, `.env` and `state.db`. maiavm already has `profileToAgent()`. |
| D5 | **The chat UI uses a Telegram-style skin** (§8): dark charcoal, rounded bubbles, inline timestamps and read ticks, quoted-reply bars, date pills, a round-button composer. It is built as a theme on the existing `ChatPanel`/`MessageBody`. | It's the look you want. Building it as a skin, not a fork, keeps maiavm's markdown, mermaid, KaTeX, tool chips and approvals for free. |
| D6 | **The workspace browser is built from Electron `WebContentsView`s, one session partition per agent.** The agent drives it through **Hermes's native browser-controller protocol** (`browser.extension_control`), carried out by the app over `webContents.debugger` (CDP). | The agent gets scoped, auditable control of one lane only. **Rejected:** exposing `--remote-debugging-port` plus `browser.cdp_url`. That would hand the agent every webContents in the app, including the app's own UI renderer. |
| D7 | **Agent input never moves the real mouse.** Clicks and keys go through CDP `Input.dispatch*` into the tab and show as a coloured ghost cursor. Any real user input in a tab pauses that lane. | This is the "doesn't fight you" requirement. |
| D8 | **Secrets are redacted in the main process before any snapshot or screenshot reaches the agent.** The agent fills credentials through placeholders that the app resolves via `secrets-op.cjs` (1Password). The values never enter the model context. | This is the "doesn't leak secrets" requirement. It reuses existing hardened code. |
| D9 | **Local only. No remote machine, no Mac↔server handoff, no update server.** The PiP shows the agent's own computer-use session on this Mac. Builds install from source. | It's a local desktop app for the local Hermes. Nothing leaves the Mac except the model calls Hermes already makes. |
| D10 | **Nub Agent production stays deploy-only.** | The `hermes-local` flavor must not reopen the local hatches that `docs/plans/2026-08-16-maiavm-prod-only-transport.md` closed in the Nub build. The gates read the build-time flavor, never localStorage. |

---

## 1. Goals and non-goals

### Goals
1. A native macOS app for **the Hermes agents running on this Mac**. It shows every profile as an agent, with streaming chat, live tool activity, approvals, steer and stop.
2. **A Telegram-style chat experience**: each agent reads like a chat in a messenger, with previews, unread counts and live activity lines in the sidebar.
3. **A Workspace pane**: a real multi-tab browser on the Mac.
   - The user browses normally.
   - Each agent gets its own isolated *lane* of tabs with its own cookies and storage, and can open, read, click and type in the background.
   - The user can hand a tab to an agent ("Give to agent"), view the tabs agents are using ("Agent tabs"), and take control back at any moment.
4. **A Computer PiP.** A floating, draggable live view of the agent's computer-use session, with Take control, Paste, and a watch-only default.
5. **Secret safety.** Passwords, OTPs and card numbers are never sent to the model and never written to disk.
6. **Maximum reuse of maiavm-desktop.** Share the Electron hardening, chat UI, orb/mascot engine, plugin host, HUD, STT, 1Password and file panels. Changes stay additive and flavor-gated.

### Non-goals (v1)
- Platform features: accounts, billing, credits, marketplace purchases, invites, VM provisioning, Android/Capacitor, the web build.
- **Any Telegram or messaging-platform integration.** The Telegram look is purely visual.
- **Anything remote:** VPS or cloud machines, moving tabs or logins between computers, hosted update feeds, sync, telemetry.
- Windows/Linux packaging. The code stays portable, but only macOS arm64 is built and tested.
- Replacing the official `/Applications/Hermes.app`. This app is a different shape (multi-agent cockpit, browser lanes, messenger-style UI).

---

## 2. Reference UI → component breakdown

```
┌──────────────┬──────────────────────────┬──────────────────────────────────────────────┐
│ Hermes Desk ⌕ +│        [● Alan Hermes]  ▣ │ WORKSPACE  ON YOUR MAC                  ⧉   │
│ YOUR AGENTS 6│                          │ Alan Hermes                       [Agent tabs]│
│ ▸ Alan Hermes│  …transcript…            │ ◐Start │◆Inbox(33)×│◆Hermes Agent×│+          │
│   preview…   │  ┌ quoted reply ───────┐ │ ← → ⟳ [https://…                ] ✦ ▤ ⇄ [Give to agent]│
│   activity   │  │ ALEX: explain it…   │ │ ┌──────────────────────────────────────────┐ │
│ ▸ Alan Sr    │  └─────────────────────┘ │ │                                          │ │
│ ▸ Hugo       │  markdown body…          │ │        live WebContentsView               │ │
│ ▸ Scout      │                          │ │        (ghost cursor overlay)             │ │
│ ▸ Pyro       │                          │ │                     ┌─ ● Computer ──────┐ │ │
│ ▸ OpenClaw   │                          │ │                     │ [Take control][Paste]│ │
│──────────────│                          │ │                     │   live frames     │ │ │
│   (avatar)   │                          │ │                     └───────────────────┘ │ │
│  Alan Hermes │                          │ └──────────────────────────────────────────┘ │
│  activity    │ [≡][📎] Message    [☺][🎙]│ You in control · Mac      Browser connector ready│
│ ⚙ Settings ● │ Local Hermes · 6 profiles│                                              │
│ Restore hidden│                         │                                              │
│ GATEWAY · SERVE · BROWSER               │                                              │
└──────────────┴──────────────────────────┴──────────────────────────────────────────────┘
```

| Screenshot element | Hermes Desk component | Base in maiavm-desktop |
|---|---|---|
| Sidebar header "Hermes — Alan's way", ⌕, + | `Sidebar` header (search reuses `CommandPalette`, + = new agent) | `src/components/Sidebar.tsx`, `CommandPalette.tsx`, `AgentEditor.tsx` |
| "YOUR AGENTS 6" rows (avatar, name, preview, activity line) | `AgentRow` fed by `profileToAgent()` + latest session | `Sidebar.tsx`, `lib/agents/hermes-profiles.ts:38`, `agents/activity.ts` |
| "Activity unavailable" | Real activity text from `sessions.last_activity_description` and live `tool.*` events | `lib/agents/activity.ts`, `lib/tool-activity.ts` |
| Bottom agent card (big avatar) | `AgentCard`: orb/mascot or profile image, presence | `FatCatIcon.tsx`, `lib/grok-orb/`, `lib/blob-fx/` |
| Settings ● (green dot = healthy) | `Settings` with a connector health dot | `SettingsStub.tsx` (pruned) |
| "Restore hidden bots" | Un-hide profiles hidden from the sidebar (local pref) | new, small |
| Footer "TELEGRAM · MAC · VPS" | `ConnectorStrip`: HERMES (serve up) · BROWSER (workspace controller ready) · COMPUTER (computer-use available) | new, small |
| Chat header pill "● Alan Hermes" + panel toggle | `TopBar` + workspace toggle | `TopBar.tsx` |
| Quoted reply block | Reply-to quote | `MessageBody.tsx` / `ThreadPane.tsx` |
| Composer: ≡ menu, 📎, emoji, 🎙 | `ChatPanel` composer; mic = on-device STT | `ChatPanel.tsx`, `lib/dictate.ts`, `electron/stt-local.cjs` |
| "Your Telegram account · bot chats only" | Context line under the composer: "Local Hermes · <profile> · <model>" | new |
| WORKSPACE / ON YOUR MAC header, agent name, Agent tabs | `WorkspacePane` | new, hosted in `SidePanel.tsx` dock |
| Tab strip, nav, URL bar, ✦ ▤ ⇄, Give to agent | `WorkspaceTabs`, `WorkspaceNav` | new |
| "VPS computer" PiP, Take control / Paste | `ComputerPip`: the agent's computer-use session on this Mac | new; window chrome reuses the HUD window pattern (`main.cjs:199`) |
| "You in control · Mac" / "Browser connector ready" | `WorkspaceStatusBar` (control owner + controller state) | new |

---

## 3. Ground truth (verified 2026-10-06)

### 3.1 maiavm-desktop
- **Stack:** Electron 37, React 19, Vite 6, Tailwind 4, vitest 4. The renderer is sandboxed with context isolation. All IPC goes through `ipcHandle()` + `assertMainSender()` (`electron/main.cjs:751-762`).
- **Transport interface:** `AgentTransport` in `src/lib/agents/transport.ts:62`. Implementations:
  - `HermesDeployTransport`: platform. Drop it.
  - **`HermesServeTransport`**: `src/lib/agents/hermes-transport.ts:206`, client `src/lib/hermes-serve.ts:179`. Local `hermes serve` over `/api/ws`, relayed by main via `serve-auth.cjs`'s `createServeSocketBroker` (`:197`). **Today `listAgents()` (`:1056`) returns a single `local-hermes` agent and per-profile routing is not wired.**
  - `mockTransport` "api" mode: OpenAI SSE to 8642, but it needs `scripts/hermes-chat-proxy.mjs` to inject `API_SERVER_KEY`.
- **Local modes are dev-only.** `isProdBuild()` (`src/lib/build-env.ts`) forces deploy-only. It is checked in `active-transport.ts` (`buildForMode` `:121`), `transport-routing.ts`, `maiavm-api.ts` and `store.ts`.
- **State:** a hand-rolled store, `lib/agents/store.ts`, bridged with `useSyncExternalStore` (`useAgentRuntime.ts`). There are also `plugins/atom.ts` atoms. Routing uses the hash router in `lib/router.ts`.
- **Right dock:** `SidePanel.tsx` (resizable, width persisted) hosts Files, File and AgentInfo, one at a time.
- **Security posture:** `webviewTag:false`, and `will-attach-webview` is blocked on every window (`main.cjs:250, 259, 812, 850, 1143`). No `WebContentsView`, `BrowserView` or partitions exist anywhere. **The embedded browser is net-new and goes against a deliberate lockdown (see §15).**
- **The agent→desktop path today** is only HUD text markers (`[POINT|CLICK|TYPE]`, `lib/hud-protocol.ts:20-35`), parsed in `HudShell.tsx:336-405`. HUD clicks are real `CGEventPost` (`screen-act.cjs`), which **moves the real mouse**. The new workspace must not use this path for browser actions.
- **Reusable hardened modules:** `serve-auth`, `fs-guard`, `bin-guard`, `agent-env`, `secrets-op`, `system-notify`, `stt-local`, `plugin-host`, `dashboard-routes`, `hud-*`, `screen-see`, `region-picker`.

### 3.2 Local Hermes
- **Gateway** `ai.hermes.gateway`: listens on `127.0.0.1:8642`. Bearer `API_SERVER_KEY` lives in `~/.hermes/.env`. Every route is mirrored under `/p/{profile}`, but **multiplex is off**: `gateway_state.json` `served_profiles: []` because `default` shares its Telegram, Discord and Slack tokens with `backend-eng` and `chief-of-staff`. Only `default` is reachable on 8642 today.
- **`hermes serve` / dashboard:** default port `9119`, not running now. Auth is the `X-Hermes-Session-Token` header or `?token=` on loopback WS. `HERMES_DASHBOARD_SESSION_TOKEN` pins the token. It offers about 240 REST routes (`/api/profiles*`, `/api/sessions?profile=`, `/api/skills*`, `/api/cron/*`, `/api/mcp/servers*`, `/api/memory`, `/api/tools/computer-use/*`, …) and WS `/api/ws` (JSON-RPC), `/api/events`, `/api/pty`.
- **JSON-RPC** (`tui_gateway/`, contract in `apps/shared/src/gateway-contract.generated.ts` and `gateway-contract.openrpc.json`):
  - Methods: `session.create|resume|list|history|interrupt|steer|branch|title|usage|events.since`, `prompt.submit`, `approval.respond|pending`, `profiles.list|create|configure`, `browser.controller.*`.
  - Server→client requests: `approval`, `clarify`, `sudo`, `secret`, `vault.*`, `preview.*`, `window.read`.
  - Events: `message.start|delta|complete`, `reasoning.delta`, `tool.start|complete|generating`, `status.update`, `session.usage|title`, `todo.updated`, `sessions.changed`, `browser.controller.command`.
- **Browser controller** (`gateway/browser_control_broker.py`, `tui_gateway/methods_browser_control.py:150`):
  - **Session-scoped and profile-scoped.** The controller attaches to one session on its transport, and cross-profile exclusivity is enforced.
  - Capabilities: `browser_navigate|click|type|press|scroll|snapshot|screenshot|back|tabs|tab_activate`. `developer_mode` adds `browser_cdp|browser_evaluate`.
  - Frames: `browser.controller.command {command_id, action, arguments, tool_call_id}` → `browser.controller.result {command_id, ok, result|error}`, plus heartbeat, detach and cancel.
  - Gated by `browser.extension_control.enabled: true`, which is **not set today** (`~/.hermes/config.yaml` `browser:` block, line 111).
- **Profiles:** default (at `~/.hermes`), nub, agent-two, grok, chief-of-staff, backend-eng, frontend-eng, ops, researcher, plus many `session-*` scratch profiles. Each has its own `state.db`. `profile.yaml` can carry `ui_meta` and `orchestrator: true`.
- **Computer use:** `tools/computer_use/` (cua-driver; background click and type is configured as `cua:*:background` in config). Status and permissions are exposed via `/api/tools/computer-use/*`.
- **Known bug:** `GET /v1/skills` returns 500 at this commit (an `include_editorial` kwarg mismatch, `api_server.py:2959` vs `tools/skills_tool.py:184`). Use the serve `/api/skills` route instead.
- **Known gotcha:** MCP `tools: all` crashes; use `tools: {}`.

---

## 4. Architecture

### 4.1 Repo strategy (D1)

One repo, two flavors chosen at **build time**:

```
APP_FLAVOR = 'nub' (default, unchanged)  |  'hermes-local'
```

- **Vite:** add `--mode local`. `vite.config.ts` defines `import.meta.env.VITE_APP_FLAVOR` and the `__FLAVOR__` constant, and selects `index.local.html` (CSP allows `ws://127.0.0.1:*` and `http://127.0.0.1:*` only).
- **Renderer:** a new `src/lib/flavor.ts` exports `FLAVOR`, `isLocalFlavor()` and a `features` table. Dead-code elimination drops platform modules from the local bundle, and the platform-only imports become dynamic so they tree-shake away.
- **Electron:** `electron/main.cjs` reads the flavor from `electron/flavor.json`, which `scripts/build-desktop.mjs --flavor local` writes. The flavor is never read from an env var at runtime in a packaged build. Flavor-specific wiring lives in new modules (`electron/local/*.cjs`), and `main.cjs` gains one `if (FLAVOR === 'hermes-local') require('./local/boot.cjs')(ctx)` seam plus guards around `nub-link` registration.
- **Packaging:** a second electron-builder config, `electron-builder.local.cjs`: appId `com.devgwardo.hermesdesk`, productName `Hermes Desk`, its own icon. No update feed: builds install from source. It has **no** `nub-vm:` scheme and no `nub-link`.
- **Tests:** add a vitest project `local` that runs the unit suite with `VITE_APP_FLAVOR=hermes-local`. Add a guard test that the `nub` prod bundle contains no `hermes-local` transport code, and the reverse.

> Fallback if flavor gating gets too invasive: extract `packages/desktop-core` (Electron hardening, chat UI, orb). That is a bigger refactor, so do it only if flavor `if`s exceed about 40 sites (track this with a lint rule that counts `isLocalFlavor(` call sites).

### 4.2 Process model

```
                         ┌──────────────────────── Hermes Desk (Electron) ────────────────────────┐
                         │ Main process                                                            │
 launchd                 │  ├─ local/hermes-host.cjs    supervise/attach `hermes serve` (:9119)    │
 ai.hermes.gateway ◄─────┼──┤  ├─ local/gateway-client.cjs  8642 health + /v1/runs approval fallback│
 (8642, untouched)      │  ├─ serve-auth.cjs           WS broker (token never in renderer)        │
 hermes serve ◄──────────┼──┤  ├─ local/workspace/*      WebContentsView tabs, lanes, CDP executor  │
 (child or attached)     │  │    ├─ controller-bridge.cjs  browser.controller.* ⇄ CDP              │
                         │  │    ├─ redactor.cjs           snapshot/screenshot secret scrubbing     │
                         │  │    └─ takeover.cjs           user-input → pause lane                  │
                         │  ├─ local/computer-pip.cjs   PiP window + frame source                   │
                         │  └─ reused: secrets-op, stt-local, plugin-host, hud-*, fs-guard …       │
                         │ Renderer (sandboxed, contextIsolation)                                  │
                         │  └─ React: Sidebar · ChatPanel · WorkspacePane · ComputerPip(UI)        │
                         └─────────────────────────────────────────────────────────────────────────┘
```

**Rule:** the renderer never holds a Hermes token, never opens a socket itself, and never touches a tab's `webContents`. Everything goes through narrow, allowlisted IPC.

### 4.3 Hermes host supervision: `electron/local/hermes-host.cjs`

1. **Discover.**
   - Resolve the `hermes` binary via `bin-guard` (`~/.hermes/hermes-agent/venv/bin/hermes` or the `$PATH` shim), pinned to the realpath.
   - Read `~/.hermes/gateway_state.json` (gateway health) and probe `GET 127.0.0.1:8642/health` (no auth).
2. **Attach or spawn serve.**
   - If a serve on `HERMES_SERVE_URL` (default `127.0.0.1:9119`) answers `/api/status` with a token we hold, attach to it.
   - Otherwise spawn `hermes serve --host 127.0.0.1 --port <free from 9119>` with:
     - `HERMES_DASHBOARD_SESSION_TOKEN=<32 random bytes, per launch, kept in main memory>`
     - an env scrubbed by `agent-env.cjs`
     - `HERMES_HOME=~/.hermes`
3. **Supervise.** Restart with backoff (1s→30s), surface the last stderr lines in Settings → Diagnostics, and kill the child on quit (`before-quit`). Do **not** register a launchd job in v1, so the app owns serve's lifetime.
4. **Multi-profile.** Phase 0 spike: confirm one serve process can create sessions for any profile (`session.create {profile}`; `launch_profile_policy.py`). If it can't, the fallback is one serve per *active* profile on 9120+, started lazily when that agent is opened, with an LRU cap of 4.
5. **Coexistence with Hermes.app.** If the official app holds a session lease, `session.resume` is refused. In that case show "Open in Hermes.app holds this chat" and offer *Branch here* (`session.branch`).

---

## 5. What's kept, adapted, or dropped

### 5.1 Electron

| Module | Action |
|---|---|
| `main.cjs` | **Adapt.** Flavor seam. Skip `nub-link`, the `nub-vm:` scheme and the updater (`maia:updateCheck|Apply`) for the local flavor. Keep the HUD, tray, permission policy, `runHermes`, and the kanban/hermes/task/fs/stt/secrets/serve IPC. |
| `preload.cjs` | **Adapt.** Expose `nubAgent.*` minus `nub*`. Add `nubAgent.workspace.*`, `nubAgent.computer.*`, `nubAgent.host.*` (§11). Keep the global name `nubAgent` so shared renderer code works unchanged. |
| `serve-auth.cjs` | **Reuse.** Feed it the per-launch token from `hermes-host`. |
| `secrets-op.cjs` | **Reuse and extend.** Add `resolveForFill(ref)`, which returns the value only to `controller-bridge` in main, never over IPC. |
| `fs-guard`, `bin-guard`, `agent-env`, `system-notify`, `stt-local`, `plugin-host`, `dashboard-routes` | **Reuse.** `dashboard-routes` gains the serve routes this app calls. |
| `hud-*`, `screen-see`, `screen-act`, `region-picker` | **Reuse as-is.** The HUD cat is still a nice extra, but its marker-click path is **not** used for the workspace. |
| `update-signature.cjs` | **Not loaded.** No update feed; updating = `git pull` + rebuild (§16). |
| `nub-link.cjs`, `vm-preview.cjs`, `vm-copy.cjs`, `vm-save.cjs`, `link-raise.cjs` | **Not loaded** in the local flavor. `vm-nav-guard.cjs`'s idea is reused for the app window. |

### 5.2 Renderer

| Area | Action |
|---|---|
| `lib/agents/hermes-transport.ts` (`HermesServeTransport`) | **Extend** into a `HermesLocalTransport` subclass: per-profile agents, browser-lane events (§6). |
| `lib/hermes-serve.ts`, `serve-bridge.ts`, `hermes-rest.ts` | **Reuse.** Remove the `vmLinked()` branch in the local flavor. |
| `active-transport.ts`, `transport-routing.ts`, `maiavm-api.ts`, `build-env.ts` | **Adapt.** If `isLocalFlavor()`, always choose `local`. No localStorage override (D10). |
| `hermes-profiles.ts`, `hermes-sessions.ts`, `agent-profiles.ts`, `hermes-agents.ts` | **Reuse.** They become the source of the sidebar roster. |
| `Sidebar`, `ChatPanel`, `MessageBody`, `MessageActions`, `ThreadPane`, `TopBar`, `SidePanel`, `CommandPalette`, `AgentEditor`, `FilesPanel`, `KanbanPanel`, `HermesSurfacesPanel`, `RoutinesPage`, `MemoryPane`, `SkillsGallery`, `HudShell`, `FatCatIcon` | **Reuse.** Small flavor props only (labels, hidden platform affordances). |
| `grok-orb/`, `blob-fx/`, `avatar-spec.ts`, `agents/activity.ts` | **Reuse.** Optional per-profile image avatar from `profile.yaml ui_meta.avatar`. |
| `SettingsStub.tsx` | **Adapt.** Drop Account, Billing, Keys and Usage-limit. Add Hermes host, Workspace, Secrets and Diagnostics. |
| Platform UI (`TelegramConnect`, `WebConnect`, `InviteRedeem`, `WaitlistCapture`, `UsageLimitBanner`, `UsageResets`, `PendingPairingBadge`, `PlatformPanes`, marketplace purchase flow, `src/mobile/`) | **Not imported** in the local flavor. |
| `analytics.ts` (PostHog) | **Off** in the local flavor. No telemetry. |

---

## 6. Hermes connectivity and transport

### 6.1 `HermesLocalTransport extends HermesServeTransport`

**File:** `src/lib/agents/hermes-local-transport.ts`

| `AgentTransport` method | Implementation |
|---|---|
| `listAgents()` | `profiles.list` (JSON-RPC), else `GET /api/profiles`, then `profileToAgent()`. Hide `session-*` scratch profiles by default (Settings toggle). Sort by pinned order, then last activity. |
| `listConversations()` | For each visible profile: `session.list {profile, limit:50}`, filtered by default to sessions this app created (`source:'desktop'`); CLI and cron sessions sit behind a filter. Each conversation carries `{agentId, sessionId, source, title, preview, lastActivityAt, unread}`. |
| `getMessages(id)` / `loadOlderMessages` | `session.history {session_id, limit, before}`. |
| `sendMessage(conv, text, opts)` | `session.resume` (or `session.create {profile, source:'desktop'}` on the first message), then `prompt.submit`. Attachments via the existing upload path. |
| `stopTurn` / steer | `session.interrupt` / `session.steer`. |
| `respondPermission` | Answer the server→client `approval` request (`once\|session\|always\|deny`) using the existing `tool-permission.ts` UI. |
| `listSkills` | `skills.manage list` (avoids the broken `/v1/skills`). |
| `subscribe(cb)` | Maps JSON-RPC events to `TransportEvent` (table below). |
| `createAgent` | `profiles.create` + SOUL via `agent-profiles.ts` (`putHermesProfileSoul`). |
| `removeAgent` | **Hide only** (local pref). Deleting a profile is never done from the UI in v1. |

**Event mapping**

| tui_gateway event | `TransportEvent` / UI |
|---|---|
| `message.start/delta/complete` | `message` (streaming bubble) |
| `reasoning.delta` | collapsible "thinking" block (exists in `MessageBody`) |
| `tool.start/generating/complete` | `turn` tool-activity chips + sidebar activity line + orb presence |
| `status.update` | composer status line ("Searching…") |
| `todo.updated` | todo strip (existing `KanbanPanel` mini-view) |
| `session.usage` | token and cost footer |
| `session.title` | conversation rename |
| `sessions.changed` | `conversations` refresh (debounced 500ms) |
| `browser.controller.command` | **workspace lane executor** (§9.5); never shown raw |
| server request `approval` | `permission` card |
| server request `clarify` | inline question card with options |
| server request `secret` / `sudo` | **secure prompt in main** (§9.8), never a renderer text field |

### 6.2 Gateway client: `electron/local/gateway-client.cjs`
- Reads `API_SERVER_KEY` from `~/.hermes/.env` in main only. It is never logged and never sent over IPC.
- Uses: `/health` only, for Diagnostics. Nothing in the app depends on the gateway being up.
- Replaces `scripts/hermes-chat-proxy.mjs` for this flavor. No CORS proxy is needed because the renderer never calls 8642.

### 6.3 Resilience
- Reconnect the serve WS with backoff. After a reconnect, call `session.events.since {session_id, seq}` for every open session, so streams resume without gaps (`event_replay.py`).
- If serve can't start, the app enters **read-only mode**. Cached transcripts stay visible, the composer is disabled, and a banner reads "Hermes serve offline — Retry / Diagnostics".

---

## 7. Agents, sidebar and presence

- **Roster source:** profiles → `Agent { id:'profile:<name>', name: ui_meta.display_name ?? titleCase(name), persona: first line of SOUL.md, hermesProfile }`. `default` is shown as `ui_meta.display_name` or "Hermes".
- **Row content:**
  - avatar (orb colour from `NUBCAT_COLORS` by id, or `ui_meta.avatar` image)
  - name
  - preview of the last message across sources
  - activity line, in priority order:
    1. a live tool chip ("Browsing en.wikipedia.org", "Running terminal")
    2. `last_activity_description`
    3. relative time
- **Unread badges:** the sum over that agent's conversations (`last_read_at` rule). Opening a conversation calls `PATCH /api/sessions/{id} {unread:false}` on serve.
- **Order:** user-pinned first, then by most recent activity. Drag to reorder (persisted locally).
- **Hide and restore:** right-click → Hide adds the profile to `localPrefs.hiddenProfiles`; the "Restore hidden bots" footer link lists them.
- **Bottom agent card:** the selected agent's large avatar, presence (idle, thinking, tool, browsing, waiting-approval) and a model chip (from profile config). Clicking it opens `AgentInfo` (SOUL, memory, skills, MCP, cron for that profile, via existing panels with `?profile=`).
- **Orchestrator:** profiles with `orchestrator: true` get a crown glyph and can be the default target of `@all` (Phase 4).

---

## 8. Chat UI: the Telegram-style skin

This section covers look and feel only. There is no Telegram code. It ships as `src/styles/skin-messenger.css` plus small prop additions to the existing components. maiavm's current look stays the default for the Nub flavor.

### 8.1 Visual language (measured from the reference)

| Element | Spec |
|---|---|
| Canvas | Near-black app chrome (`#0e0e0f`), chat area charcoal (`#1c1c1e`), sidebar `#161617`, hairline dividers `#ffffff14` |
| Incoming bubble | `#2a2a2c`, radius 18px with a 6px "tail" corner bottom-left, max width 72% of the pane, padding 10/14, body 15px/1.45 |
| Outgoing bubble | lighter grey pill (`#3a3a3d`), right-aligned, same radius with the tail bottom-right |
| Timestamp | inside the bubble, bottom-right, 11px, 55% opacity; outgoing adds read ticks (✓ sent, ✓✓ the agent picked it up = `message.start` received) |
| Quoted reply | inside the bubble: a 3px accent left bar (the agent's colour), sender name in small caps, one-line quote; clicking it scrolls to the original |
| Date separator | centred pill ("Today", "Yesterday", "Mon 5 Oct"), translucent, sticky while scrolling |
| Header | centred pill with avatar + agent name (clicking opens AgentInfo); the workspace toggle ▣ sits on the right |
| Composer | round ≡ menu button (slash commands, model, attach), 📎, a rounded "Message" field with ☺ inside, a round 🎙 button that turns into ➤ when there's text. Hold 🎙 to dictate (`stt-local`) |
| Sidebar rows | 40px round avatar, bold name, one-line grey preview, a small activity line; the selected row is a rounded highlight (`#2c2c2e`); unread is a round count badge in the agent's colour |
| Typography | system UI stack (SF Pro), no custom font |
| Motion | a bubble rises 6px and fades in over 160ms; the streaming caret pulses; the reduced-motion setting is respected |

### 8.2 Agent-specific bits inside the skin
- **Tool activity** renders as slim chips *between* bubbles ("🌐 Browsing wikipedia.org · 2.1s"), collapsible into a "3 steps" pill. This reuses `tool-activity.ts`.
- **Approvals and clarify questions** render as an incoming bubble with inline buttons (Once / Session / Always / Deny), in Telegram inline-keyboard style.
- **Reasoning** is a collapsed "Thinking…" line inside the incoming bubble.
- **Code, mermaid, KaTeX and tables** use the existing renderers, restyled to sit inside bubbles (full-width bubble for wide content).
- **Long replies** stay one bubble. Swipe left or right-click a bubble → Reply (quotes it into the composer), Copy, Retry (`retryTurn`), Branch (`session.branch`).

### 8.3 Files touched
`ChatPanel.tsx`, `MessageBody.tsx`, `MessageActions.tsx`, `Sidebar.tsx`, `TopBar.tsx` get a `skin` prop or a `data-skin="messenger"` root attribute. All styling lives in `skin-messenger.css`, so the Nub flavor is untouched. A visual regression test uses the existing snapshot/blueprint harness with a fixed transcript fixture.

---

## 9. Workspace browser ("Workspace — on your Mac")

### 9.1 Model

```
Workspace
 ├─ Lane "you"            partition persist:ws-user          (the user's own tabs)
 ├─ Lane profile:alan     partition persist:ws-agent-alan    (agent-owned tabs)
 ├─ Lane profile:scout    partition persist:ws-agent-scout
 └─ …
Tab { id, laneId, partition, url, title, favicon, state: idle|loading|agent-acting|user-paused,
      controller: 'user'|'agent', createdBy: 'user'|'agent', sessionId? }
```

- **One `WebContentsView` per tab.** The main window composes the active tab's view into the workspace rect. The renderer reports that rect through `workspace.setBounds(rect)` on resize, throttled with rAF.
- **Partitions:** `session.fromPartition('persist:ws-agent-<profile>')` per agent. A lane persists its logins between runs, so the agent stays signed in and never sees the user's cookies. The user's lane is separate.
- **Tab strip:** shows the *focused lane* (the selected agent's tabs plus the user's tabs, each badged). **Agent tabs** opens a popover listing every lane, with tab counts, the current URL and a live state per lane, so you can jump to any agent's tab.
- **Limits:** at most 8 tabs per agent lane and 20 total live views. Least-recently-used background tabs are *discarded*: the view is destroyed and the URL and title are kept.

### 9.2 Chrome (toolbar)
- Back, forward, reload; a URL bar (Enter navigates; typing a non-URL searches with a configurable engine); ✦ = "Ask agent about this page" (sends a page snapshot reference into chat); ▤ = reader/snapshot preview; ⇄ = move the tab between lanes; **Give to agent**.
- **Status bar:** left side shows "You in control · Mac" or "**Alan Hermes** in control · Mac" (agent colour), or "Paused — you took control". Right side shows the controller state: "Browser connector ready", "Connecting…" or "Not enabled (Settings)".

### 9.3 "Give to agent"
1. The user clicks it on one of their own tabs, picks an agent (defaults to the selected one), and optionally types an instruction.
2. **The tab moves into the agent's lane but keeps its partition** (`persist:ws-user`). The agent can act in that one tab with the user's login. A yellow "shared login" badge stays on the tab while this is the case.
3. The app posts a message into the agent's active desktop session: "[Workspace] You now control tab T (<url>). <instruction>". It also makes sure a browser controller is registered for that session (§9.5).
4. **Take back:** a click or keypress in the tab pauses the agent (§9.6). "Return to me" moves the tab back to the user's lane.

> Copying cookies from `ws-user` into an agent partition is **not** done implicitly. It is a separate, explicit action ("Copy sign-in for <site> to <agent>"), with a per-origin consent dialog, logged to the audit log (§15.3).

### 9.4 Enabling Hermes's controller (Phase 0 config, needs owner approval)

```yaml
# ~/.hermes/config.yaml  (and each profile config the app should drive)
browser:
  extension_control:
    enabled: true
    developer_mode: false     # keep false: no browser_cdp / browser_evaluate for the agent
```

The app checks this flag on startup through `/api/status` or config read. If it's off, the status bar says "Not enabled" and offers a **one-click enable**. That writes to the config via serve's config API, shows a diff, and backs up `config.yaml.bak-hermesdesk-<ts>` first.

### 9.5 Controller bridge: `electron/local/workspace/controller-bridge.cjs`

**Registration (per agent session that may browse)**
1. Call `browser.controller.register` on the serve WS (attached to that session) with:
   ```
   { protocol_version: 1, controller_id: 'hermesdesk:<install-id>', browser_profile_id: 'ws-agent-<profile>',
     session_id, capabilities: [navigate, click, type, press, scroll, snapshot, screenshot, back, tabs, tab_activate] }
   ```
2. Register lazily, on the first turn of a session in a profile with workspace enabled. Send heartbeats on the broker's interval and `detach` when the session closes or the app quits.
3. Hermes routes the agent's `browser_*` tool calls to us as `browser.controller.command`. Those calls would otherwise launch a headless Chromium via agent-browser.

**Execution (per command, inside the lane's tab, via `webContents.debugger.attach('1.3')`)**

| Hermes action | CDP execution | Notes |
|---|---|---|
| `browser_navigate {url}` | `Page.navigate`, wait for `Page.loadEventFired` or a 30s timeout | URL policy check (§9.9). Opens a new tab in the lane if none is active. |
| `browser_snapshot` | `Accessibility.getFullAXTree` + `DOM.getDocument` → compact ref tree (`[ref=e12] button "Sign in"`) | **Through the redactor (§9.7).** Refs map to `backendNodeId`s, kept in main. |
| `browser_click {ref}` | `DOM.scrollIntoViewIfNeeded` → `DOM.getBoxModel` → ghost cursor animate → `Input.dispatchMouseEvent` press/release at the centre | No OS events, so the real cursor never moves. |
| `browser_type {ref, text}` | focus via `DOM.focus` → `Input.insertText` (or `dispatchKeyEvent` per char when `slowly`) | `text` may contain `{{secret:<ref>}}` placeholders, resolved in main (§9.8). Refused on password fields unless the text is a placeholder. |
| `browser_press {key}` | `Input.dispatchKeyEvent` keyDown/keyUp | |
| `browser_scroll {dir, amount}` | `Input.dispatchMouseEvent` type `mouseWheel` | |
| `browser_screenshot` | `Page.captureScreenshot` (jpeg q70, max 1568px long edge, same cap as `screen-see.cjs`) **after** the redaction mask overlay | Masks are drawn before capture (§9.7). |
| `browser_back` | `webContents.navigationHistory.goBack()` | |
| `browser_tabs` | the lane's tab list `{id, url, title, active}` | Only that lane's tabs, never the user's or other agents'. |
| `browser_tab_activate {id}` | switch the lane's active tab | Doesn't steal focus from the user's visible tab unless the user is watching that lane. |

- **Concurrency:** one command at a time per lane (FIFO queue). Lanes run in parallel. A cancel frame aborts the in-flight command and clears the queue.
- **Results** carry `{ok, result}` with `url`, `title`, and the snapshot or screenshot data URL. Errors are typed: `user_took_control`, `blocked_by_policy`, `timeout`, `no_such_ref`, `tab_closed`.
- **Background operation:** lanes run in hidden `WebContentsView`s. `backgroundThrottling:false` is set **only while a command is in flight**, so idle background tabs don't burn CPU.

### 9.6 Ghost cursor and taking control
- **Ghost cursor:** a click-through overlay `WebContentsView` (app-owned, `nodeIntegration:false`, static local HTML) sits above the active tab. The bridge sends `{x, y, phase: move|press|release, color}` before each input. It animates a 250ms ease to the target, a pulse on press and a fade after 2s idle. The colour is the agent's orb colour and the label is the agent's name. **Nothing is injected into the page DOM.**
- **Pause on user input:** `takeover.cjs` listens on each agent-controlled tab's `before-input-event` and on the view's `mouseDown` and `wheel`.
  1. Any real input marks the lane `user-paused`.
  2. It rejects the in-flight command with `user_took_control` and sends `session.steer {text:"[Workspace] User took control of tab T; wait for them to hand it back."}`.
  3. The status bar shows "Paused — you're in control" with a **Resume agent** button.
  4. Resume clears the pause and steers "[Workspace] Control returned."
- **Hard stop:** ⌘. stops the agent's turn (`session.interrupt`) and pauses every lane.

### 9.7 Redaction pipeline: `electron/local/workspace/redactor.cjs`

Runs in main on every snapshot and screenshot **before** it leaves the app.

**Sensitive node detection (DOM via CDP)**
- `input[type=password]`
- `autocomplete` ∈ {`current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`, `cc-exp*`}
- `name|id|aria-label` matching `/pass|pwd|otp|2fa|totp|cvv|cvc|card.?num|ssn|routing|iban/i`
- `inputmode=numeric` with `maxlength` 4–8 next to OTP text
- `contenteditable` within those

**Text scrubbing (snapshot strings and the values of every input)**
- Luhn-valid 13–19 digit runs → `[card ••••1234]`
- 4–8 digit OTP near "code|verification|2fa" → `[code]`
- known token shapes (`sk-…`, `ghp_…`, `xox[bpas]-…`, `AKIA…`, JWTs, PEM blocks) → `[secret]`
- email-and-password pairs in the same form → keep the email and mask the password

**Snapshots:** sensitive nodes become `textbox "Password" [ref=e7] (sensitive, value hidden)`. The agent can still *target* them, but only with placeholders.

**Screenshots:** before `captureScreenshot`, a solid-black mask is drawn over every sensitive node's box model via the **overlay view**, not the page. The image composites the overlay. Fallback: capture, then black-fill the rects in main with `nativeImage`.

**Persistence and fail-closed behaviour**
- Snapshots and screenshots live in memory only. They are never written to disk by the app. `browser.record_sessions` stays `false` (current config).
- **Fail closed:** if detection throws, the snapshot is refused (`blocked_by_policy`), not sent unredacted.
- **Tests:** a fixture corpus (login, checkout, OTP and banking pages saved as local HTML) with asserted redaction output. See §17.

### 9.8 Secrets the agent needs to *use*
- The agent asks for a credential with Hermes's `secret` server request (or a `vault.*` request), or by writing a `{{secret:<label>}}` placeholder in `browser_type`.
- Main shows a **native secure prompt** (not the renderer): "Alan Hermes wants to fill **Password** on **github.com**". Choices: pick a 1Password item, type it once, or deny.
- The value goes only to `Input.insertText` in that tab. It is never returned in the tool result, logged, sent over IPC, or stored. The result reads `"typed [secret]"`.
- Origin binding: a resolved secret is valid only for the origin it was approved for. If a navigation happens between approval and fill, the fill is aborted.

### 9.9 Browser security hardening
- **Tab views:**
  - `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, **no preload**
  - `webSecurity:true`, `allowRunningInsecureContent:false`
  - `setWindowOpenHandler` → opens in the same lane, never a new `BrowserWindow`
  - `will-attach-webview` denied
- **Permissions:** per-partition `setPermissionRequestHandler`.
  - Agent lanes deny camera, mic, geolocation, notifications, MIDI, HID, serial and USB.
  - The user lane prompts the user.
- **Downloads:**
  - Agent lanes save to `~/Downloads/Hermes Desk/<agent>/` (fs-guarded), with a size cap of 200MB.
  - Executables (`.app`, `.pkg`, `.dmg`, `.command`, `.sh`) are blocked for agent lanes.
- **URL policy:**
  - `http(s)` only, with no `file:`, `chrome:` or `devtools:`.
  - Agent lanes block `127.0.0.1:{8642, 9119, serve ports}` and the app's own origins, so the agent can't attack its own control plane. Other private URLs are allowed, matching `browser.allow_private_urls: true`.
  - A per-agent allow/deny list lives in Settings.
- **Debugger scope:** `webContents.debugger` is attached **only** to lane tab views, never to the app renderer, the overlay or the PiP. A unit test asserts this.
- **No CDP server:** `--remote-debugging-port` is never set in a packaged build. A test asserts this.

---

## 10. Computer PiP (the reference's "VPS computer", made local)

### 10.1 Source: the agent's computer-use session on this Mac
- Hermes `computer_use` (cua-driver) acts in the **background** on the Mac (`cua:click:background`, `cua:type:background`). The PiP shows what it's doing.
  - **Frames:** poll `GET /api/tools/computer-use/status` on serve for the latest screenshot or frame reference while a `computer_use` tool is active: 2 fps while active, stopped when idle. If cua exposes a frame stream, use that instead (Phase 0 spike: inspect `cua_backend_capture.py`).
  - **Overlay:** the agent's last action point in its colour (same ghost-cursor component).

### 10.2 Window
- A frameless, always-on-top, rounded `BrowserWindow` built from the HUD window factory (`main.cjs:199`). Position and size persist via `hud-state.cjs`'s schema. It can dock into the workspace's bottom-right or float free ("drag the preview anywhere").
- **Header:** "● Computer · <agent>" with buttons **Take control**, **Paste** and ⤢.
- **Footer hint:** "Watching · drag anywhere · Take control for mouse and keyboard".

### 10.3 Controls
- **Watching** (default): view only.
- **Take control:** sends `session.interrupt` for that agent's computer-use turn and pauses cua (`computer_use` stop), then switches the PiP to "You in control". The user then just uses their real mouse; the PiP stays a monitor.
- **Paste:** writes the clipboard text into the agent's focused field through `computer_use` type (background) after a confirm. It goes through the redactor's secret detector; if the text looks like a secret, it asks "Fill as secret?" and uses the §9.8 path.

---

## 11. IPC surface (new, allowlisted)

```ts
nubAgent.host = {
  status(): Promise<{ gateway: Health; serve: Health; controller: 'off'|'ready'|'error' }>
  restartServe(): Promise<void>
  enableBrowserControl(profiles: string[]): Promise<ConfigDiff>   // shows diff, requires confirm
  onStatus(cb): Unsubscribe
}
nubAgent.workspace = {
  setBounds(rect): void
  list(): Promise<LaneSummary[]>
  openTab(laneId, url?): Promise<TabId>
  closeTab(tabId): Promise<void>
  activate(tabId): Promise<void>
  navigate(tabId, urlOrQuery): Promise<void>
  back(tabId); forward(tabId); reload(tabId)
  giveToAgent(tabId, profile, instruction?): Promise<void>
  returnToUser(tabId): Promise<void>
  resumeAgent(laneId): Promise<void>
  copySignIn(origin, fromLane, toLane): Promise<void>   // consent dialog in main
  onState(cb): Unsubscribe      // tabs, titles, favicons, controller, cursor (for status only)
}
nubAgent.computer = {
  open(profile); close(); takeControl(); paste(); onFrame(cb); onState(cb)
}
```

Every handler uses `ipcHandle` + `assertMainSender`. Arguments are validated: `tabId` and `laneId` against a regex, URLs parsed and checked against the policy. No handler returns a secret, token or raw CDP access.

---

## 12. Settings (local flavor)

| Section | Contents |
|---|---|
| **Hermes** | Hermes home path; serve: attach vs. spawn, port, restart; gateway health; version (`/health`); "Show scratch profiles" toggle |
| **Agents** | Order, hide/restore, display name and avatar (writes `profile.yaml ui_meta`), default model chip (read-only, links to profile config) |
| **Workspace** | Controller enable (per profile), per-agent URL allow/deny lists, tab limits, downloads folder, search engine, "Clear agent lane data" (per partition `clearStorageData`) |
| **Secrets** | 1Password status (`secrets-op`), default vault, the per-origin approvals list with revoke |
| **Computer** | PiP source, fps, docked or floating |
| **Diagnostics** | Serve stderr tail, connector log, audit log viewer (§15.3), "Copy debug bundle" (redacted) |
| **Appearance** | Reuse `theme.ts`; messenger skin on by default, with a toggle back to the classic maiavm look; which session sources appear in the sidebar (desktop by default; cli and cron optional) |

---

## 13. Persistence

| Data | Where | Notes |
|---|---|---|
| Conversations and messages | Hermes `state.db` (authoritative) | The app caches the last 50 messages per open conversation in memory only |
| UI prefs (order, hidden, pane widths, last conversation) | `userData/prefs.json` via the existing `persist.ts` | No secrets |
| Browser lanes | Electron partitions `persist:ws-*` under `userData/Partitions` | Clearable per lane |
| Open tab sets | `userData/workspace.json` (lane → [{url, title}]) | Restored lazily (discarded until focused) |
| Audit log | `userData/audit.jsonl`, rotated at 5MB × 3 | Actions only: no page content, no secrets |
| Serve token | memory only | Regenerated each launch |
| Gateway key | read from `~/.hermes/.env` on demand | Never copied |

---

## 14. HUD, tray and notifications
- The HUD cat and orb (⌘⇧H) are kept. Its activity feed (`hud-activity-relay.cjs`) gains workspace events ("Scout is browsing notion.so").
- Tray: show/hide window, PiP toggle, "Pause all agents' browsing", serve status.
- Notifications via `system-notify.cjs` for: approval requests, a `clarify` question waiting, and an agent finishing a long run while the window is unfocused. Clicking one deep-links to the conversation via the existing `onNotifyClick`.

---

## 15. Security model

### 15.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| A prompt-injected page tells the agent to exfiltrate data | Lanes are isolated (an agent sees only its lane). There are no CDP or evaluate capabilities (`developer_mode:false`), redaction is in place, secret placeholders are origin-bound, and agent lanes can't reach the control-plane ports. |
| The agent steers its browser at the local Hermes API or dashboard | URL policy blocks the serve, gateway and app ports in agent lanes (§9.9). |
| A page escapes to the app | Tab views are sandboxed with no preload, a window-open handler, and no webview; the debugger is attached only to tab views. Run the red-team checklist from `docs/RED_TEAM_SWEEP_2026-09-28.md` against the new surface. |
| The renderer is compromised (XSS in markdown) | The renderer holds no tokens and can't reach CDP. IPC is allowlisted with validated args. `MessageBody` keeps DOMPurify. The CSP allows only loopback connect. |
| Secrets end up in the transcript or logs | Redactor fail-closed, the secure prompt in main, `"typed [secret]"` results, and an audit log without content. |
| The agent clicks something destructive while the user isn't looking | Hermes approvals still apply to tools. Workspace "sensitive action" heuristics (buttons matching `/pay|buy|purchase|delete|transfer|send money|confirm order/i` on a checkout or bank origin) need a desktop confirm before the click executes. Configurable per agent. |
| A local process impersonates the app to serve | A per-launch random serve token held in main. Serve binds 127.0.0.1 only. |
| Reopening the Nub prod local hatches | The flavor is fixed at build time. Guard tests cover both bundles (D10). |

### 15.2 Red-team gate
Before v1 ships: a red-team sweep in the repo's existing format (`docs/RED_TEAM_SWEEP_*.md`), focused on §9 and §11, with findings fixed or explicitly accepted.

### 15.3 Audit log
Each entry is `{ts, agent, lane, tab, action, origin, result, durationMs, byUser?}`. It is viewable in Diagnostics and is never sent anywhere.

---

## 16. Build, release, run

- **Scripts:**
  - `npm run dev:local` runs `node scripts/launch-desktop.mjs --flavor local` (Vite `--mode local`, Electron with `electron/flavor.json` = local, no `MAIAVM_*` env).
  - `npm run build:local` runs `tsc -b && vite build --mode local`.
  - `npm run electron:build:local` runs `node scripts/build-desktop.mjs --flavor local`. It uses `electron-builder.local.cjs`, ad-hoc or Developer ID signing as today (`docs/no-apple-developer-account.md`). No update-zip signing.
- **Install and update:** `npm run install:local` builds the app and copies `Hermes Desk.app` into `/Applications`. To update, `git pull` and run it again. There is no update server and the app makes no network calls of its own.
- **Entitlements:** reuse `build/entitlements.mac.plist`; no new entitlements are needed. Screen Recording and Accessibility are only needed for the HUD and PiP extras, not the workspace, because CDP needs neither.
- **Bundle budget:** add a `local` entry in `bundle-budget.test.ts`. The target is **≤ the Nub entry**, because platform code is dropped.

---

## 17. Testing and verification

| Layer | Tests |
|---|---|
| Unit (renderer) | `hermes-local-transport` event mapping (fixtures recorded from a real serve WS), roster from profiles, unread math, messenger skin snapshot, flavor gating |
| Unit (electron, `node`) | `redactor` against the HTML corpus (assert no fixture secret strings appear in snapshot or OCR'd screenshot); `controller-bridge` with a fake broker; URL policy; IPC arg validation; "debugger only on tab views" and "no remote-debugging-port" invariants (pattern of `security-invariants.test.mjs`) |
| Integration | Spawn a real `hermes serve` with a temp `HERMES_HOME` (a test profile, the cheap model via opencode-zen), then: send a message → stream → tool event → approval round trip; browser controller: the agent navigates a local fixture site, fills a form with a `{{secret:…}}` placeholder, and the assertion is that the transcript has no secret |
| E2E (Playwright-electron, already a devDependency) | The golden path from the screenshot: pick agent → chat → agent opens a tab → ghost cursor → user clicks → paused → resume → Give to agent → Return to me → PiP opens |
| Blueprint | Add `tools/blueprint/hermes-desk.mjs` following the repo's blueprint harness pattern. It measures cold start, first token, and tab-command latency (targets below). |
| Bundle | `npm run test:bundle` for both flavors |

**Performance targets (M-series Mac)**
- Cold start to sidebar populated: under 1.5s with serve attached, under 4s when spawning serve.
- First token latency: no more than serve's own latency plus 50ms.
- Agent click command to page event: under 150ms excluding the 250ms cursor animation.
- 6 agents with 3 tabs each, idle: under 1.2GB RSS total.

---

## 18. Phased plan

Each phase ends green on `npm run test:run` (both flavors), `tsc -b`, and the bundle budget. Work happens on `feat/hermes-desk-*` branches with one PR per phase, and **nothing is pushed or released without the owner's OK**.

### Phase 0: Spikes and prerequisites (≈1 day)
1. **Serve multi-profile:** confirm one `hermes serve` can `session.create {profile:'nub'}` and `{profile:'agent-two'}` concurrently, and record the method shapes from `gateway-contract.openrpc.json`.
2. **Controller:** with `browser.extension_control.enabled: true` on a **scratch profile** (not default), register a fake controller over serve WS and log the commands a `browser_navigate` tool call produces.
3. **Computer frames:** find the cua frame/screenshot surface (`cua_backend_capture.py`, `/api/tools/computer-use/status`).
4. **SQLite access:** check whether `node:sqlite` is available in Electron 37's Node; otherwise use the `sqlite3` CLI.
5. Write the findings into §3 of this doc (v1.1).

**Exit:** all four answered. Fallbacks are chosen where needed (§4.3 step 4, §8.1).

### Phase 1: Flavor skeleton and chat (≈3–4 days)
- `src/lib/flavor.ts`, Vite `--mode local`, `index.local.html`, `electron/flavor.json`, `electron/local/boot.cjs`, `hermes-host.cjs`, `gateway-client.cjs`, `electron-builder.local.cjs`, plus scripts.
- `HermesLocalTransport` (agents = profiles, desktop sessions, streaming, tools, approvals, clarify, stop and steer).
- Gate out platform UI. Settings: Hermes, Agents, Diagnostics.
- Connector strip (GATEWAY · SERVE).

**Acceptance:**
- Launching the packaged local build lists all non-scratch profiles.
- Chatting with nub and agent-two in parallel streams correctly.
- An approval round-trips.
- Killing serve auto-restarts it and the stream resumes via `events.since`.
- The Nub build is byte-identical in behaviour (its full suite passes unchanged).

### Phase 2: Messenger skin and presence (≈2–3 days)
- `skin-messenger.css` and the component props (§8), date pills, quoted replies, inline approval buttons, tool-chip rows, read ticks, the round composer, the real activity line, the bottom agent card, unread badges and mark-read, hide/restore, reorder, notifications.

**Acceptance:**
- Side by side with the reference screenshot, the sidebar, bubbles, composer and header match the layout and spacing.
- The visual snapshot test passes.
- The Nub flavor's snapshots are unchanged.

### Phase 3: Workspace browser, user-driven (≈3–4 days)
- WebContentsView tabs, lanes and partitions, chrome and status bar, Agent tabs popover, URL policy, permissions, downloads, tab discard and restore, hardening (§9.9), invariant tests.

**Acceptance:**
- Browse, sign in, and restart the app with the session persisted.
- Agent lanes are empty and isolated (cookie test).
- The security invariants pass.

### Phase 4: Agent control (≈5–6 days)
- `controller-bridge.cjs`, CDP executor, ghost-cursor overlay, `takeover.cjs`, `redactor.cjs` plus the corpus, secure secret prompt plus `secrets-op.resolveForFill`, Give to agent / Return to me, copy sign-in with consent, sensitive-action confirm, audit log, the one-click controller enable with diff.

**Acceptance:**
- Six agents each browse a different site in parallel without crosstalk.
- The real mouse never moves (assert the `screen-act` cursor read-back is unchanged).
- A user click pauses within one command.
- The redaction corpus passes.
- The secret-fill integration test passes.
- Red-team sweep §15.2 is done.

### Phase 5: Computer PiP (≈2 days)
- PiP window from the HUD factory, cua frames, Take control (pause), Paste via redactor.

**Acceptance:** the agent's background computer-use on this Mac is visible live, and Take control halts it.

### Phase 6: Polish and release (≈2 days)
- App icon and branding (not Nub-branded), onboarding (detects Hermes, offers controller enable), empty states, keyboard map (⌘1–9 agents, ⌘T new tab in your lane, ⌘⇧T in the agent's lane, ⌘. stop), blueprint report, `install:local` script.

**Total to v1 (Phases 0–6): about 3–4 weeks of focused work.** The work splits by file into disjoint lanes for parallel workers: transport | messenger skin | electron/local/workspace | renderer workspace UI | redactor + corpus | tests/blueprint.

---

## 19. Hermes-side changes (each needs explicit owner approval)

| Change | Why | Risk |
|---|---|---|
| `browser.extension_control.enabled: true` on the profiles the app drives | Required for D6 | Low. Off by default; `developer_mode` stays false. |
| (Optional) Upstream fix for `/v1/skills` `include_editorial` | Not needed by the app (it uses serve) | **Never open upstream PRs/issues without asking** (standing rule). Local patch only if wanted, and note that `hermes update` clobbers local patches. |
| Nothing changes in `~/.hermes/profiles/*/.env` | — | — |

Hermes v0.15.1+ crashes on MCP `tools: all`. This app registers **no** MCP server in v1. If one is added later (for example a `hermes-desk` MCP exposing "open in workspace"), use `tools: {}`.

---

## 20. Risks and open questions

**Risks**
- **R1. Serve and gateway both write `state.db`.** Both are Hermes processes with WAL and lock guards (`hermes_state_lockguard.py`), which is the intended design (Hermes.app does the same). The app never opens `state.db` itself.
- **R2. The controller protocol could change** with `hermes update` (protocol_version 1). Pin to the version reported in register, show "Controller protocol mismatch" instead of failing silently, and add a contract test against `gateway-contract.generated.ts`.
- **R3. WebContentsView memory** with many lanes. Mitigated by discard, LRU and caps.
- **R4. Flavor gating spread** in shared files. Mitigated by the lint counter, with `desktop-core` extraction as the fallback (§4.1).
- **R5. Session lease conflicts** with the official Hermes.app. Handled with Branch here (§4.3).

**Open questions (owner)**
- **Q1. Name and branding.** Is "Hermes Desk" OK? Avatar style: orb/cat engine or Hermes bust images per agent?
- **Q2. Scratch `session-*` profiles.** Hidden by default (proposed), or archive them?
- **Q3. Workspace on/off per agent.** Should the controller be enabled for every profile, or only an allowlist such as default, nub and agent-two?

---

## Appendix A: File plan (new)

```
electron/
  flavor.json                          (generated at build)
  local/
    boot.cjs                           wires everything below into main.cjs
    hermes-host.cjs                    serve attach/spawn/supervise
    gateway-client.cjs                 8642 health + run approvals
    computer-pip.cjs                   PiP window + frame source
    workspace/
      lanes.cjs                        lanes, tabs, partitions, discard
      views.cjs                        WebContentsView lifecycle + bounds
      controller-bridge.cjs            browser.controller.* ⇄ CDP
      cdp-exec.cjs                     action → CDP implementations
      redactor.cjs                     snapshot/screenshot scrubbing
      takeover.cjs                     user input → pause
      overlay.html                     ghost cursor + masks (static)
      url-policy.cjs
      secure-prompt.cjs                native secret prompt (uses secrets-op)
      audit.cjs
    *.test.mjs                         per module
src/
  lib/flavor.ts
  lib/agents/hermes-local-transport.ts
  styles/skin-messenger.css
  lib/workspace/{store.ts, types.ts}
  components/workspace/{WorkspacePane, WorkspaceTabs, WorkspaceNav, WorkspaceStatusBar,
                        AgentTabsPopover, GiveToAgentDialog}.tsx
  components/{ConnectorStrip, AgentCard, ComputerPip}.tsx
  components/settings/local/{HermesPane, AgentsPane, WorkspacePane,
                             SecretsPane, ComputerPane, DiagnosticsPane}.tsx
index.local.html
electron-builder.local.cjs
tests/fixtures/{redaction-corpus/*.html, serve-ws/*.jsonl, messenger-transcript.json}
tools/blueprint/hermes-desk.mjs
```

## Appendix B: Where facts came from
- maiavm-desktop: `electron/main.cjs`, `preload.cjs`, `serve-auth.cjs`, `nub-link.cjs`, `src/lib/agents/{transport,hermes-transport,active-transport,hermes-profiles}.ts`, `src/lib/hermes-serve.ts`, `docs/{HERMES_SERVE_PROTOCOL,BROWSER_USE_PLAN,HUD}.md`, `docs/plans/2026-08-16-maiavm-prod-only-transport.md`.
- Hermes: `gateway/platforms/api_server.py` (routes `:1745-1793`, auth `:1562-1608`, multiplex `:1674-1743`), `api_server_runs.py`, `api_server_openai_routes.py`, `gateway/browser_control_broker.py`, `tui_gateway/methods_browser_control.py`, `tui_gateway/AGENTS.md`, `tools/browser_tool_cdp.py`, `tools/computer_use/`, `~/.hermes/gateway_state.json`, `~/.hermes/config.yaml`, `apps/shared/src/gateway-contract.generated.ts`.
