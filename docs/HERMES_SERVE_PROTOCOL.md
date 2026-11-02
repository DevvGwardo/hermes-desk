# Hermes Serve Protocol (frozen contract)

Verified against source on 2026-08-12:

- `~/.hermes/hermes-agent/hermes_cli/web_server.py` (REST routes, WS auth, `/api/ws`)
- `~/.hermes/hermes-agent/tui_gateway/` (`server.py`, `ws.py`, `methods_*.py`) — the JSON-RPC method surface
- `~/.hermes/hermes-agent/apps/shared/src/json-rpc-gateway.ts` + `websocket-url.ts` — the official client dialect
- `~/.hermes/hermes-agent/web/src/lib/api.ts` — the SPA's auth header/query handling
- `~/.hermes/hermes-agent/plugins/kanban/dashboard/plugin_api.py` — the kanban plugin REST + WS
- `~/.hermes/hermes-agent/hermes_cli/web_routers/*.py` — sessions/cron/profiles/skills/mcp/tools REST

## 1. Launching the backend

```
hermes serve                 # headless backend: JSON-RPC/WS, no SPA build
hermes serve --host 127.0.0.1 --port 9119 --skip-build
hermes dashboard             # same port, also mounts the React SPA
```

- Default bind: `127.0.0.1`, default port **9119** (fixed-port operator-managed shape).
- Desktop-local spawn shape is `hermes serve --host 127.0.0.1 --port 0` (ephemeral port).
- `--isolated` = per-profile server. `--ssh-session-token-file` is serve-only (remote auth).
- Loopback bind: auth = ephemeral `_SESSION_TOKEN` (random 32 bytes per process, unless
  `HERMES_DASHBOARD_SESSION_TOKEN` env is set). Non-loopback bind without `--insecure`:
  OAuth gate (`auth_required`), `--insecure` is a no-op since June 2026 hardening.

## 2. Auth (all surfaces)

| Surface | Loopback / `--insecure` | Gated (non-loopback) |
|---|---|---|
| REST `/api/*` | `X-Hermes-Session-Token: <token>` header (or legacy `Authorization: Bearer <token>`) | session cookie via `credentials: include` |
| WS `/api/ws`, `/api/pty`, `/api/pub`, `/api/events` | `?token=<token>` query param | `?ticket=<single-use>` (browser-minted) or `?internal=` (server-spawned only) |
| Kanban plugin REST `/api/plugins/kanban/*` | same session token header as any `/api/` route | cookie via the gate |
| Kanban WS `/api/plugins/kanban/events` | `?token=<token>` | `?ticket=` |

Token source for the desktop app: `HERMES_DASHBOARD_SESSION_TOKEN` env (set by the
launcher), or a token file path configured in Settings. Never persist the token in
localStorage — read it via the Electron main process.

**Auth is REQUIRED on plugin routes** (this repo's older docs claiming "plugin routes
are unauthenticated" are stale — the plugin was hardened; see plugin_api.py docstring).
WS upgrades additionally pass a Host/Origin guard: packaged Electron `file://` /
`null` / `app://` origins are accepted (non-web origin → credential is the boundary).

## 3. WebSocket JSON-RPC (`/api/ws`) — the chat transport

Wire protocol: **newline-delimited JSON-RPC 2.0** in both directions (same dialect the
Ink TUI uses over stdio). One JSON object per line, no framing beyond `\n`.

Connect: `ws://<host>:9119/api/ws?token=<token>`

Server pushes immediately on accept:

```json
{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{"skin":{...},"change_events":true}}}
```

Requests (client → server):

```json
{"jsonrpc":"2.0","id":"w1","method":"session.create","params":{...}}
```

Responses (server → client, matches `id`):

```json
{"jsonrpc":"2.0","id":"w1","result":{...}}
{"jsonrpc":"2.0","id":"w1","error":{"code":4006,"message":"session_id required"}}
```

Events (server → client, no `id`):

```json
{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":"abc12345","payload":{"text":"..."}}}
```

### Event types (frozen)

| Type | Payload | Notes |
|---|---|---|
| `gateway.ready` | `{skin, change_events}` | first frame after accept |
| `session.info` | full session info (model, provider, running, title, profile_name, usage…) | emitted on create/resume/turn-end |
| `message.start` | — | turn started |
| `message.delta` | `{text, rendered?}` | streamed tokens (~30fps coalesced) |
| `message.interim` | `{text, already_streamed}` | interim assistant text |
| `message.complete` | `{text, usage, status, error?, partial?, rendered?}` | turn ended |
| `thinking.delta` / `reasoning.delta` | `{text}` | reasoning stream (high-frequency, coalesced) |
| `tool.start` | `{tool_id, name, args?, args_text?}` | tool call began |
| `tool.progress` | tool progress events | |
| `tool.complete` | `{tool_id, name, args, result, duration_s?, summary?, todos?, inline_diff?}` | tool finished |
| `tool.generating` | `{name}` | |
| `clarify.request` / `approval.request` / `sudo.request` / `secret.request` | approval payloads | respond via `*.respond` methods |
| `background.complete` | `{task_id, text}` | prompt.background finished |
| `error` | | |
| `skin.changed` | | global broadcast (session-less) |
| plus `pet.changed`, `cron.changed`, `sessions.changed` | | change_events broadcasts — demote legacy polls to slow backstops |

### Core methods (frozen)

| Method | Key params | Returns |
|---|---|---|
| `session.create` | `messages?`, `title?`, `model?`, `provider?`, `reasoning_effort?`, `fast?`, `cwd?`, `profile?`, `parent_session_id?`, `source?`, `cols?` | `{session_id, stored_session_id, message_count, messages, info}` — `info` includes `model`, `provider`, `tools`, `skills`, `cwd`, `project`, `profile_name`, `desktop_contract: 6` |
| `session.list` | `limit?` (default 200), `profile?` | `{sessions:[{id, title, preview, started_at, message_count, source}]}` — denies `kanban`/`tool` sources |
| `session.resume` | `session_id` (or title), `cols?`, `profile?`, `omit_messages?` | session info; streamed events follow |
| `session.history` | `session_id` | transcript |
| `session.status` | `session_id` | status |
| `session.most_recent` | `profile?` | `{session_id, title, started_at, source}` or `{session_id: null}` |
| `prompt.submit` | `session_id`, `text`, `queued?`, `truncate_before_user_ordinal?`, `confirm_truncate?`, `surface?` | `_ok` — turn streams as events |
| `prompt.background` | `session_id`, `text` | `{task_id}` (async, `background.complete` event later) |
| `session.interrupt` | `session_id` | interrupt current turn |
| `session.steer` / `subagent.steer` / `subagent.interrupt` | session/run ids | steer/subagent control |
| `session.branch` / `session.save` / `session.close` / `session.compress` / `session.undo` | session id | transcript ops |
| `command.dispatch` | `name` (slash name), `arg?`, `session_id?` | executes slash command |
| `slash.exec` | | slash execution |
| `config.get` / `config.set` / `config.show` | | config surface |
| `model.options` | | model picker list |
| `tools.list` / `tools.show` / `tools.configure` / `toolsets.list` | | tools/toolsets |
| `agents.list` | | agent roster |
| `skills.manage` / `skills.reload` | | skills surface |
| `cron.manage` | | cron surface |
| `insights.get` | | usage/insights |
| `plugins.list` / `plugins.manage` | | plugin surface |
| `session.active_list` / `session.activate` | | active session presence |
| `projects.list` / `projects.get` / `projects.create` / `projects.tree` | | project surface |

Error codes: `4006` missing session_id, `4007` session not found, `4012` text
required, `4018` target no longer in history / command failed, `5006` db unavailable,
`-32700` parse error, `-32603` internal.

## 4. REST (auth header required unless noted)

| Route | Notes |
|---|---|
| `GET /api/health` | liveness (public) |
| `GET /api/status` | status blob |
| `GET /api/sessions?limit=&offset=&order=created\|recent&source=&profile=` | session list; `le=100` page cap |
| `GET /api/sessions/{id}` | detail |
| `GET /api/sessions/{id}/messages?limit=&offset=&order=oldest\|latest&profile=` | paginated transcript (default latest 500) |
| `GET /api/sessions/{id}/export` | JSON export |
| `DELETE /api/sessions/{id}` / `PATCH /api/sessions/{id}` | delete / rename-archive |
| `POST /api/sessions/bulk-delete` / `prune` / `import` | manage |
| `GET /api/profiles` / `GET /api/profiles/active` | profile roster + active |
| `PATCH /api/profiles/{name}` / `PUT /api/profiles/{name}/model` / `PUT /api/profiles/{name}/soul` / `PUT /api/profiles/{name}/description` | profile surface |
| `POST /api/profiles/{name}/describe-auto` | auto description |
| `GET /api/cron/jobs` / `GET /api/cron/jobs/{id}` / `GET /api/cron/jobs/{id}/runs` | cron list/detail |
| `POST /api/cron/jobs` / `PUT /api/cron/jobs/{id}` / `DELETE /api/cron/jobs/{id}` | cron CRUD |
| `POST /api/cron/jobs/{id}/pause\|resume\|trigger` / `POST /api/cron/fire` | cron control |
| `GET /api/skills` / `PUT /api/skills/toggle` / `GET /api/skills/content` | skills |
| `POST /api/skills` / `PUT /api/skills/content` | install/update |
| `GET /api/mcp/servers` / `POST` / `PUT` / `DELETE /{name}` / `POST /{name}/test` / `PUT /{name}/enabled` | MCP servers |
| `GET /api/mcp/catalog` / `POST /api/mcp/catalog/install` / `POST /api/mcp/servers/{name}/auth` | MCP catalog + auth |
| `GET /api/tools/toolsets` / `PUT /api/tools/toolsets/{name}` / `GET /{name}/models` / `PUT /{name}/model\|provider` | toolsets + models |
| `GET /api/tools/computer-use/status` | computer-use capability |
| `GET /api/model/options` / `GET /api/model/info` / `POST /api/model/set` | model surface (REST) |
| `GET /api/analytics/usage?days=` / `GET /api/analytics/models?days=` | usage analytics |
| `GET /api/files` / `GET /api/files/read` / `GET /api/files/download?token=` | files (download supports `?token=`) |
| `POST /api/files/upload` / `POST /api/files/upload-stream` / `POST /api/files/mkdir` / `DELETE /api/files` | file ops |
| `GET /api/fs/list` / `GET /api/fs/read-text` / `POST /api/fs/write-text` / `GET /api/fs/git-root` / `GET /api/fs/default-cwd` | fs surface |
| `GET /api/memory` / `PUT /api/memory/provider` | memory provider config |
| `GET /api/logs` / `GET /api/system/stats` / `GET /api/egress/status` | diagnostics |
| `GET /api/actions/{name}/status` | action status |
| `GET /api/dashboard/plugins` | dashboard plugin roster |

## 5. Kanban plugin (`/api/plugins/kanban/*`)

Mounted by the dashboard plugin system when the `kanban` plugin is enabled. ALL
routes require the session token (HTTP: `X-Hermes-Session-Token` header; WS: `?token=`).

**Board columns (frozen):** `triage, todo, scheduled, ready, running, blocked, review, done`

| Route | Notes |
|---|---|
| `GET /board?board=&tenant=&include_archived=` | `{columns:[{name,tasks[]}], tenants, assignees, latest_event_id, now}` — each task has `id,title,status,priority,assignee,body?,result?,progress?,comment_count,link_counts,diagnostics?,warnings?` |
| `GET /tasks/{task_id}?board=` | full task + comments + events + links + runs |
| `POST /tasks?board=` | create `{title, body?, assignee?, priority?, tenant?, parents?[], triage?}` |
| `PATCH /tasks/{task_id}?board=` | status/assignee/priority/title/body/result |
| `DELETE /tasks/{task_id}?board=` | delete |
| `POST /tasks/bulk?board=` | batch patch `{ids[], ...}` |
| `POST /tasks/{task_id}/comments?board=` | add comment |
| `POST /tasks/{task_id}/specify?board=` / `POST /tasks/{task_id}/decompose?board=` | LLM decompose |
| `POST /tasks/{task_id}/reassign` / `POST /tasks/{task_id}/reclaim` | assignment ops |
| `POST /links?board=` / `DELETE /links?board=` | task links |
| `POST /dispatch?max=&dry_run=&board=` | nudge dispatcher |
| `GET /diagnostics?board=` | per-task diagnostics |
| `GET /workers/active?board=` | active workers |
| `GET /runs/{run_id}` / `GET /runs/{run_id}/inspect` / `POST /runs/{run_id}/terminate` | worker runs |
| `GET /estimate` | text estimate |
| `GET /config` / `GET /orchestration` / `PUT /orchestration` / `GET /profiles` / `PUT /profiles` | board prefs + orchestration + profiles |

### Kanban live events WS

`WS /api/plugins/kanban/events?since=<event_id>&token=<token>&board=<slug>`

Server polls `task_events` and pushes frames:

```json
{"events":[{"id":123,"task_id":"t_abc","run_id":null,"kind":"status","payload":{...},"created_at":173...}],"cursor":123}
```

Client keeps the last cursor and re-subscribes `?since=<cursor>` after reconnect.
Event `kind` values include status/comment/claim/complete/block/unblock/link/run events.

## 6. API fallback (unchanged)

The existing OpenAI-compat SSE route (`POST /v1/chat/completions`, gateway platform
`api_server`, header `X-Hermes-Session-Id` for continuity) stays supported as the
`api` transport mode. See `src/lib/hermes-stream.ts`.

## 7. Desktop app contract

- Transport selection precedence: `localStorage['maia:hermesTransport']` →
  `VITE_HERMES_TRANSPORT` → auto (serve if reachable, else api, else mock).
- Serve mode needs: base URL (default `http://127.0.0.1:9119`) + token (env or token
  file, read via Electron main — never localStorage).
- Remote/VM mode: base URL points at the deployed serve (behind tunnel), token from
  the deployed instance's `HERMES_DASHBOARD_SESSION_TOKEN` / token file.
- Never bind serve to `0.0.0.0` without the auth gate understood.
