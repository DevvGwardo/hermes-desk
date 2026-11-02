# Deploy-Transport Feature Wiring + Red Team — Plan

> **SUPERSEDED 2026-09-05 (streams landed; §7 red-team writeup outstanding).**
> Desktop stream B is in the tree (event parse, transport wiring,
> feature-detected stop/steer control methods) and the hermes-deploy proxy
> routes (`approval`, `steer`, `stop`, `skills`) exist; only the §7
> `RED_TEAM_FINDINGS.md` writeup was never produced. Plan text below is
> frozen history.

> **Status:** plan only. The Grok message-styling pass (Task 1) and its three bug
> fixes (Task 5) are already shipped — see [Already done](#already-done). Everything
> below is the remaining work: wiring `HermesDeployTransport` stubs to real VM
> capabilities, then the red-team pass.
>
> **Ground truth re-verified 2026-08-15** against:
> - `~/.hermes/hermes-agent/gateway/platforms/api_server.py` (the VM gateway — **native** `/v1/runs/*` surface)
> - `hermes-deploy` overlay: `gateway/platforms/dashboard_runs.py` + `run_buffer.py` (decoded from `src/lib/overlay-assets.ts` — the **overlay** `/v1/dashboard/runs/*` surface the deploy proxy actually uses)
> - `/Users/devgwardo/hermes-deploy/src/app/api/chat/route.ts` + `src/lib/chat-runs.ts` (the proxy)
> - `/Users/devgwardo/maiavm-desktop/src/lib/agents/hermes-deploy-transport.ts` (the client)
> - `/Users/devgwardo/maiavm-desktop/docs/HERMES_SERVE_PROTOCOL.md` (serve-transport reference)
>
> **Correction 2026-08-15:** §2 previously conflated the native `/v1/runs/*` API with
> the `/v1/dashboard/runs/*` overlay. The deploy proxy uses the overlay only, and the
> overlay has no subagent/approval events and no stop/steer/approval routes. §2/§4
> have been rewritten around that fact.

---

## 1. Already done (this session)

| Change | Files |
|---|---|
| Grok-style hover-reveal CSS (`--maia-msg-actions-opacity` pattern) for message action bar, reaction pills, reaction picker, reply quote/pill, reduced-motion | `src/index.css` |
| Right-click context menu now clamps to viewport (was raw `clientX/Y`, could render off-screen) | `src/components/MessageActions.tsx` |
| Reaction pill labels resolve real agent names from store instead of hardcoded "Hermes" | `src/components/MessageActions.tsx` |
| `hydrateMessageExtras` accepts `replyToId` so hydrated reply quotes get a real id | `src/lib/message-actions.ts` |

## 2. Ground truth — two gateway surfaces, and deploy uses the overlay

The VM gateway (`api_server.py`) mounts **two** distinct run APIs on the same
aiohttp app. The plan previously conflated them; only one is on the deploy path.

### 2.1 Two surfaces

**Native — `/v1/runs/*`** (`api_server.py:2053 _http_route_table()`). This is what
the **serve / local-relay transport** uses. It is **not** what the deploy proxy
uses.

| Method + path | Purpose |
|---|---|
| `POST /v1/runs` | start a run, returns `run_id` |
| `GET /v1/runs/{id}` / `GET /v1/runs/{id}/events` | status / SSE stream |
| `POST /v1/runs/{id}/approval` | resolve pending approval |
| `POST /v1/runs/{id}/steer` | inject mid-run instruction |
| `POST /v1/runs/{id}/stop` | interrupt a running agent |
| `GET /v1/skills`, `GET /v1/toolsets`, `GET /v1/capabilities` | read-only lists |
| `/api/jobs` CRUD + `pause/resume/run` | cron-ish jobs (future) |

**Overlay — `/v1/dashboard/runs/*`** (hermes-deploy-shipped
`gateway/platforms/dashboard_runs.py` + `run_buffer.py`; base64 in
`src/lib/overlay-assets.ts`, registered by the DR-01/DR-02 patches). This is the
**only** run surface the deploy proxy talks to (`chat/route.ts:250`,
`chat-runs.ts:615/665`, `runs/[turnId]/events/route.ts:136`).

| Method + path | Purpose |
|---|---|
| `POST /v1/dashboard/runs` | start a run (the proxy's chat send) |
| `GET /v1/dashboard/runs/{id}/events` | durable SSE + `Last-Event-Id` reattach |
| `GET /v1/dashboard/runs/{id}` | snapshot |
| `DELETE /v1/dashboard/runs/{id}` | cooperative cancel |

It exists precisely so an agent run survives Vercel function timeouts and viewer
disconnects — the native `/v1/runs` stream has no durable buffer and is swept when
unsubscribed, which is why the deploy path can't just switch to native.

### 2.2 What the overlay actually emits

From `dashboard_runs.py` `_on_delta` / `_on_tool_progress` / `_run_and_close`:

- `message.delta` ✅ (translated → OpenAI chunk)
- `tool.started` ✅ (translated → `hermes.tool.progress`)
- `run.completed` / `run.failed` ✅ (translated)
- `tool.completed`, `reasoning.available`, `run.started` — emitted, forwarded as
  informational/no-op.

**Not emitted on this stream: `subagent.start`/`subagent.complete` and
`approval.request`.** Those exist only on the *native* `/v1/runs` stream (via
`_make_run_event_callback` at `api_server.py:6543` and the `_approval_notify` hook
at `:6814`). The overlay's callback never registers the approval notify and has no
`subagent.*` branch, so those events never enter the buffer.

### 2.3 Why the stubs are stubs (corrected)

The proxy is **not** "dropping" events the VM emits. `translateRunEventToOpenAi`
(`chat-runs.ts:474`) and the client's `processSseBlock` faithfully forward the
overlay's event set. The real gap is upstream:

1. The overlay's event vocabulary has no `subagent.*` / `approval.request`.
2. Native `/v1/runs/{id}/stop|steer|approval` resolve via **native-only registries**
   (`_run_statuses`, `_active_run_agents`, `_active_run_tasks`,
   `_run_approval_sessions`, `_run_streams`). The overlay never populates these — it
   stores its agent in the `RunBuffer` (`buf._agent_ref` / `buf._agent_task`). A
   native control call against a dashboard `run_…` id returns **404**, not a working
   stop/steer/approval.

Consequence: there is **no** "add three proxy routes + passthrough" shortcut. The
overlay itself must be extended (A0 below), *then* the proxy routes (A1/A2).

### 2.4 Approval-mode prerequisite (easy to miss)

Dashboard VMs ship with `approvals.mode: off` — deliberately, because the dashboard
chat could never surface a prompt (see `AGENTS.md`). Even after the overlay emits
`approval.request` and the proxy/desktop render it, a dashboard VM will **never
raise an approval** until its `approvals.mode` is flipped to `smart` (Config tab →
`config.yaml`, or the config PATCH route). Without this the approval feature looks
wired but silently never fires. Include the flip in the rollout and in the manual
test (§8.3).

### 2.5 Reactions: local-only is *correct* (don't "fix" it)

The runs stream carries **no** `message.reaction` events — reactions exist only on the
serve transport's WS JSON-RPC (`message.react` method + `message.reaction` event).
The desktop cannot reach the VM gateway directly (no `publicUrl`/API key; only
`host` = hermes-deploy + `desktopToken`). So `reactToMessage` doing optimistic local
application + `mergePreservedReactions` on re-sync is the right behavior for the
deploy path. Leave it; document in STATE.md.

## 3. Gap table

| Client method (deploy transport) | Today | Root cause | Fix |
|---|---|---|---|
| `reactToMessage` | local-only, correct | no server channel | keep; add doc comment |
| `spawnSubagentInto` | returns `failed` run | overlay never emits `subagent.*`; no spawn route | A0: emit events; client renders them; spawn via `sendMessage` with `subagent` instruction until a real route exists |
| `listSubagents` | `[]` | no listing route | server: `GET /api/chat/runs` list? (later); client: derive from `subagent.start/complete` events into store |
| `cancelSubagent` | no-op | overlay has no stop route | A0: add `POST /v1/dashboard/runs/{id}/stop`; server: `POST /api/chat/runs/:turnId/stop` → it; client call |
| `messageSubagent` | no-op | overlay has no steer route | A0: add `POST /v1/dashboard/runs/{id}/steer`; server: `POST /api/chat/runs/:turnId/steer` → it; client call |
| `respondPermission` | no-op | overlay never emits `approval.request` + no respond route | A0: approval notify + respond route; server passthrough + `POST /api/chat/runs/:turnId/approval`; client call; **also flip `approvals.mode: smart`** |
| memory/skills | nothing | gateway exposes only `GET /v1/skills`/`/v1/toolsets` | server: read-only `GET /api/chat/skills` proxy; client skills viewer |

## 4. Work stream A — hermes-deploy (VM overlay + proxy)

> Repo: `/Users/devgwardo/hermes-deploy`. Proxy routes re-use
> `resolveDashboardCaller` + `loadOwnedTurn` (turnId → runId via the `ChatTurn`
> table) + the `sessionInstanceId === turn.instanceId` binding check, exactly as
> `src/app/api/chat/runs/[turnId]/events/route.ts` does. **Never accept `runId`
> from the client** — resolve it server-side.

### A0. Extend the overlay (prerequisite — this is the real A1)

`dashboard_runs.py` + `run_buffer.py` are hermes-deploy assets (base64 in
`src/lib/overlay-assets.ts`, installed by `scripts/install-runs-overlay.ts`,
self-healed by `templates/overlay-repair.py`). Native `/v1/runs` is a near-identical
runner that already has all the wiring — port it into the overlay's
`_run_and_close` and add routes:

1. **Subagent events** — add `subagent.start` / `subagent.complete` branches to
   `_on_tool_progress`, mirroring `_make_run_event_callback` (`api_server.py:6585`):
   pass through `subagent_id`, `child_session_id`, `goal`, `status`, `output_tail`,
   token/cost counters, and redact free-text with
   `redact_sensitive_text(v, force=True)`.
2. **Approval events + resolution** — in `_run_sync`, before `run_conversation`,
   replicate native `_run_sync` (`api_server.py:6825`): `set_current_session_key` +
   `register_gateway_notify(approval_session_key, _approval_notify)`;
   `_approval_notify` builds `approval.request` (redact `command` via
   `_redact_approval_command`, add `_approval_event_choices`) and appends to the
   buffer instead of the native `q`. Store the session key on the buffer so the
   respond route can resolve it.
3. **Control routes** — register on the overlay app, all behind `_check_auth` (the
   same `API_SERVER_KEY` the proxy already presents):
   - `POST /v1/dashboard/runs/{run_id}/stop` → `request_hard_interrupt(buf._agent_ref[0], …)`
   - `POST /v1/dashboard/runs/{run_id}/steer` → `buf._agent_ref[0].steer(text)`
   - `POST /v1/dashboard/runs/{run_id}/approval` → `resolve_gateway_approval(key, choice, …)`
4. **Ship it** — re-encode `RUN_BUFFER_PY_B64` / `DASHBOARD_RUNS_PY_B64` in
   `overlay-assets.ts`, keep the `install-runs-overlay.ts` + `overlay-repair.py`
   anchors in lockstep, re-run the install on the fleet.
5. **Flip `approvals.mode: smart`** on the VMs you want approvals on (§2.4).

### A1. Proxy: forward the new events

Extend `RunEvent` (`chat-runs.ts`) with the subagent/approval fields, then in
`translateRunEventToOpenAi` add frames before the informational fallthrough:

```ts
if (evt.event === "subagent.start" || evt.event === "subagent.complete") {
  return `id: ${evt.id}\nevent: ${evt.event}\ndata: ${JSON.stringify({…})}\n\n`;
}
if (evt.event === "approval.request") {
  return `id: ${evt.id}\nevent: hermes.approval.request\ndata: ${JSON.stringify({…})}\n\n`;
}
```

The overlay already redacts `goal`/`summary`/`output_tail`/`command` (force=True),
so the proxy passes them through as opaque JSON — always `JSON.stringify`, never
hand-splice fields into the `data:` line. Gate behind `CHAT_SSE_EXTRA_EVENTS` if a
staged rollout is wanted.

### A2. Proxy: new control routes (target the overlay, not native)

All under `src/app/api/chat/runs/[turnId]/…`, all POST, all mirroring the auth +
ownership of `events/route.ts` (`resolveDashboardCaller` → `loadOwnedTurn` →
`sessionInstanceId === turn.instanceId`, else 404):

- `stop/route.ts` → `POST ${publicUrl}/v1/dashboard/runs/${runId}/stop`
- `steer/route.ts` → `POST …/steer` with `{ input: text }` (gateway accepts
  `input|message|text`)
- `approval/route.ts` → `POST …/approval` with `{ choice }`; whitelist
  `once|session|always|deny` before proxying (mirror `_handle_run_approval`'s 400)
- `skills/route.ts` → `GET ${publicUrl}/v1/skills` — this one is a **native**
  read-only route, not keyed to run registries, so it works today with **no**
  overlay change. Read-only; the gateway already redacts its response.

Each route: `applyDesktopCors` + the same rate-limit posture as the chat route.
404 (not 403) when the turn isn't owned, matching the events route's
not-found/forbidden collapse.

### A3. Subagent spawn route (optional, phase 2)

The overlay's `POST /v1/dashboard/runs` accepts `{input, instructions,
conversation_history, session_id}` (no `model` override is sent today). A spawn is
expressible as a normal turn with `instructions` describing the delegate +
`child_session_id` carried in the `subagent.*` events once A0 ships. Two options:
1. **Client-only spawn via existing chat send** — `spawnSubagentInto` becomes a
   `sendMessage` with a spawn instruction prefix and `parentSessionId`; the returned
   `SubagentRun` tracks the turn, and `subagent.*` events hydrate it. No server route.
2. **Real route** `POST /api/chat/subagents` — more work, only if the gateway grows a
   native subagent param.

Recommend (1) first — it's the same "spawn = guided turn" model the serve transport
uses (`prompt.submit` with `parent_session_id`).

## 5. Work stream B — desktop client

> Repo: `/Users/devgwardo/maiavm-desktop`.

### B1. `deploy-stream.ts` — parse the new events

Add `onSubagent?: (ev: SubagentEvent)` and `onApproval?: (ev: ApprovalRequest)`
handlers; route `event: subagent.start|subagent.complete` and
`event: hermes.approval.request` in `processSseBlock`. Keep unknown events silent
(forward-compat).

### B2. `hermes-deploy-transport.ts` — wire the methods

- `consumeIntoMessage`/`attachTurn` already receive the stream → forward `onSubagent`
  to `upsertSubagent` (store) + emit a `TransportEvent`, and `onApproval` to the
  permission surface (`tool-permission.ts`).
- `cancelSubagent(runId)` → `POST /api/chat/runs/{turnId}/stop` (map runId→turnId via
  the `ChatTurn`-mirroring `SubagentRun` field — see `types.ts`).
- `messageSubagent(runId, text)` → `POST .../steer` with `{ message: text }`.
- `respondPermission(conversationId, choice)` → `POST .../approval` with the choice,
  using the conversation's in-flight turn id.
- `spawnSubagentInto` → option (1) from A3: replace the immediate `failed` run with a
  real `sendMessage`-based spawn, status `queued`, and let `subagent.*` events update it.
- Feature-detect each route (`HEAD`/`OPTIONS` once, cache result) so a stale
  hermes-deploy without the new routes degrades to today's stubs instead of 404ing
  in the UI.

### B3. Store + types

- `types.ts`: `SubagentRun` gains `childSessionId?`; add `ApprovalRequest` type
  (`{ turnId, command, message, choices }`).
- `TransportEvent` gains `{ type: 'approval'; conversationId; ask }` so the existing
  permission UI (tool-permission.ts) renders deploy approvals the same as serve ones.
- `store.ts`: `upsertSubagent` already exists — confirm it handles the event-driven
  update path.

### B4. UI touchpoints

- Approval toast/panel: verify `useAgentRuntime` already surfaces `TransportEvent['permission']`;
  if deploy emits `approval` events, route them there so `respondPermission` gets called.
- Skills: add a read-only skills list (Settings or command palette) fed by
  `GET /api/chat/skills`.

## 6. Work stream C — memory / skills / approvals surfaces

- **Memory**: the gateway has **no** memory REST surface (memory is scoped via
  `X-Hermes-Session-Key` for the model, not readable by the desktop). Deploy path
  cannot expose memory today — document as a hard limit, do not fake it.
- **Skills**: `GET /v1/skills` exists → read-only viewer (B4). No install/toggle via
  gateway (that's `/api/skills` on the serve transport only).
- **Approvals**: wireable, but only via A0 (overlay) + A2 + B2, **and** it requires
  `approvals.mode: smart` on the VM (§2.4). This is the highest-value deploy feature
  (the VM runs terminal-capable tools; today the desktop has no way to approve).

## 7. Red team pass (after wiring)

Audit targets, in priority order:

1. **AuthZ on the new proxy routes** — `loadOwnedTurn` must enforce ownership before
   touching a run; verify `desktopToken` (nub_desk_…) is scoped per-instance and can't
   drive another user's turn/run. Mirror `runs/[turnId]/events/route.ts` exactly:
   `resolveDashboardCaller` → `loadOwnedTurn` → the
   `sessionInstanceId === turn.instanceId` check (a desktop token is pinned to one
   instance, so `loadOwnedTurn` alone is insufficient).
2. **`/v1/dashboard/runs/{id}/steer` and `/stop` from a second client** — can a desktop
   that knows a turnId (from a leaked `Last-Event-Id`/state URL) stop/steer a run it
   doesn't own? `ChatTurn.id` is a `cuid()`; the gateway-side `run_id` is `run_…`.
   The invariant to enforce: the client sends only a `turnId`, never a `runId` — the
   proxy resolves `runId` via `loadOwnedTurn` and rejects foreign turns with 404.
3. **Approval choice injection** — strict `once|session|always|deny` whitelist; reject
   unknown choices before proxying (mirror gateway's 400).
4. **SSE injection via event passthrough** — the proxy now forwards gateway JSON into
   the client parser. Confirm `parseRunEventBlock` treats JSON fields as opaque strings
   (no `data:` payload splicing). Redact `command`/`output_tail` server-side (gateway
   already redacts `force=True` for free-text fields — verify proxy doesn't undo it).
5. **Reactions** — confirm no server channel exists; ensure local optimistic reactions
   never leak into the wire (they don't today).
6. **`getComputerUrl`** — returns a fake `nub-vm://` URL on deploy; verify nothing in
   the computer rail tries to load it as a real remote URL (SSRF-ish path).
7. **State/polling endpoints** — `/api/chat/state` + `/api/chat/conversations` take
   `instanceId` + `sessionId`; verify a caller can't read another instance's sessions
   with a forged `instanceId` (desktopToken ↔ instance binding).
8. **CORS** — `applyDesktopCors`; verify new routes inherit it (else browser blocks
   the desktop's fetch).
9. **Redaction** — gateway redacts secrets on `output_tail`/`goal`/`summary`; confirm
   the new passthrough doesn't re-emit unredacted tool output.
10. **Rate limiting** — new `/approval|/steer|/stop` routes: do they bypass
    `checkAbuseRateLimit`? Mirror the chat route's rate-limit usage.

**Output:** write findings to `docs/RED_TEAM_FINDINGS.md` — each item as
`[risk] target • evidence • impact • suggested fix`, with a `CONFIRMED`/`INVESTIGATE`
marker so the user can hand it to another agent to validate.

## 8. Verification

1. `npx vitest run src/lib/agents` — existing deploy tests stay green (they assert
   the stub behaviors; update the ones asserting `failed` spawn after B2).
2. Add unit tests in `hermes-deploy` for the three new routes (auth, ownership, choice
   validation) + a passthrough test for `subagent.start`/`approval.request` frames.
3. Manual: paired desktop → send a prompt that triggers a tool approval on the VM →
   confirm the approval panel appears and `always` persists.
4. Manual: spawn a subagent from the palette on a VM conversation → confirm the
   `subagent.start`/`complete` chips render and cancel/steer work.
5. Run `npm run lint` + `tsc --noEmit` in both repos.

## 9. Order of execution

1. **A0** (extend the overlay) — the actual prerequisite; nothing downstream works
   without it. Do the overlay edits, re-encode `overlay-assets.ts`, re-run the
   install on a test VM, and flip `approvals.mode: smart` there.
2. **A1** (proxy passthrough) + A2 (control routes) + tests — now the events/routes
   actually exist upstream.
3. B1/B2/B3 (client parse + wire + types) with feature-detect fallback.
4. B4 (UI touchpoints: approval panel, skills list).
5. A3 option (1) — subagent spawn via guided turn.
6. Red team (Section 7) → `docs/RED_TEAM_FINDINGS.md`.
7. Update `STATE.md` with the new hard limits (memory, reactions) and capabilities.
