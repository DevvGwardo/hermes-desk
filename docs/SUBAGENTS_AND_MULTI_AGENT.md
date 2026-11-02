# Subagents & multi-agent — clean-room design (Nub Agent)

Grok-shaped **UX patterns** mapped onto Nub Agent + MaiaVM / hermes-deploy.
No proprietary prompts, brand copy, or Cursor/Grok implementation secrets.
Surface inspiration only (sidebar agents, chat, Computer pane, short-lived workers).

**Related:** `docs/REVERSE_ENGINEERING.md`, `README.md`, `src/lib/maiavm-api.ts`, `src/lib/mock-data.ts`

---

## 0. Goals

1. Keep today’s Electron scaffold demoable **offline** (mock transport).
2. Make the data model ready for **one MaiaVM Instance = one named agent**.
3. Expose multi-agent UX that users expect from agent-desktop products:
   - Named agents (persistent)
   - Subagents (ephemeral workers)
   - 1:1 agent messaging + group rooms
   - Turn lifecycle with ack → work → deliver + background revival
4. Stay engineer-actionable: TypeScript types, mock API, concrete UI diffs.

---

## 1. Named agents (sidebar)

### Product rule (unchanged)

> **Agents are Instances** — one sidebar row equals one MaiaVM / Hetzner VM
> (`listInstances()` → sidebar). See `REVERSE_ENGINEERING.md`.

### What a named agent owns

| Concern | Nub field / surface | MaiaVM later |
| --- | --- | --- |
| Identity | `Agent.id`, `name`, avatar (CreatureMark / FatCat) | Instance id + display name |
| Chat thread | `ChatPanel` scoped by `agentId` | `POST /api/instances/:id/chat` + transcript store |
| Persona | `Agent.persona` (title, description, instructions summary) | Instance metadata / system prompt blob (server-side) |
| Memory | `AgentMemory` summary + pinned notes (UI); full store on box | Files under Instance box + optional server index |
| Box / Computer | `ComputerPanel` + `getComputerUrl(id)` | noVNC / brokered Linux box per Instance |
| Status | `running \| stopped \| provisioning \| error` | Instance lifecycle / power |
| Live workers | `AgentInfo` → “Subagents” section | Active child runs on that Instance |

### Sidebar (today → target)

**Today** (`Sidebar.tsx`): flat list of agents from `MOCK_AGENTS` / `listInstances()`.

**Target sections:**

```
┌─ Agents ─────────────┐
│  Research Alpha   ●  │
│  Ops Runner       ●  │
│  Draft Writer     ○  │
├─ Groups ─────────────┤
│  Deploy War Room     │
│  Research Circle     │
└─ Settings ───────────┘
```

- **Agents** — named Instances (1:1 with MaiaVM).
- **Groups** — multi-participant rooms (user + N agents); see §3.
- Right-click / context menu later: rename, delete (confirm), open Computer.
- Selecting a row swaps chat transcript + Computer target + AgentInfo.

### Persona / memory (MVP UI only)

Extend `Agent` (see §6) with optional:

```ts
persona?: { title?: string; description?: string; instructionsPreview?: string }
memory?: { summary?: string; pinnedNoteIds?: string[] }
```

AgentInfo shows these as read-only cards in mock mode. Real persistence lives on the Instance box / hermes-deploy later — desktop never invents server secrets.

---

## 2. Subagents — short-lived workers

### Mental model

A **named agent** (parent) may spawn **subagents**: short-lived workers that:

- Have a typed role (`kind`)
- Run one delegated task
- Stream progress digests back into the **parent’s** thread
- End with a final result (or failure), then disappear from “live” lists
- Do **not** get their own sidebar row (they are not Instances)

This mirrors the agent-desktop pattern of specialized helpers (shell/executor, browser GUI, desktop GUI, remote coding cloud run) without copying proprietary tool schemas or prompts.

### Canonical kinds (Nub names — clean-room)

| `SubagentKind` | Analogue role | Owns | Parent sees |
| --- | --- | --- | --- |
| `executor` | General worker on the **agent box** | Shell / files / code on Instance box | Digest cards + final report |
| `browserUse` | Browser GUI driver on the box | Click/type/navigate in box Chrome | Status + optional screenshots |
| `computerUse` | Full desktop GUI on the box | Mouse/keyboard/screenshot on display | Status + screenshots |
| `cloudCoder` | Remote coding agent (branch/PR) | GitHub repo work on a remote VM | Link to branch/PR + status |
| `watcher` | Background monitor / video / long poll | Read-only observation | Progress then digest |

> Naming is Nub’s. Do not ship Grok/Cursor product strings in UI copy.
> Kinds are an enum the mock transport understands; MaiaVM can map them to
> Instance-local runners or hermes job types later.

### Lifecycle

```
parent decides to delegate
        │
        ▼
  spawn(subagentSpec)  →  status: queued
        │
        ▼
  status: running  (+ optional ack chip in parent thread)
        │
        ├── progress digests (optional, streamed)
        │
        ▼
  status: completed | failed | cancelled
        │
        ▼
  final message folded into parent thread
  removed from AgentInfo “live” list (kept in run history)
```

### UI affordances

1. **Thread chips / digests** (in `ChatPanel` parent transcript)
   - Compact card: kind icon, title, status pill, elapsed, “Open detail”
   - Expand → last digest lines + final answer
   - Role styling distinct from user/agent bubbles (`role: 'subagent'`)

2. **AgentInfo → Live subagents**
   - List of `SubagentRun` with `status === 'queued' | 'running'`
   - Cancel button (mock: flips to `cancelled`)
   - Click → scroll/highlight digest chip in thread

3. **Composer / system cues**
   - While parent is waiting on children: `activityState: 'working'`
   - System chip: “Spawned executor · Summarize deploy docs”

4. **Computer pane**
   - Unchanged ownership: still the **named agent’s** box
   - `browserUse` / `computerUse` digests may attach screenshot thumbs that open Computer focus later

### Data model sketch

```ts
SubagentRun {
  id, parentAgentId, kind, title, status,
  createdAt, startedAt?, finishedAt?,
  digests: SubagentDigest[],
  result?: { summary: string; artifacts?: Attachment[] },
  error?: string
}
```

Subagents are **not** MaiaVM Instances. They are runs *on* (or *for*) an Instance.
`cloudCoder` may later map to a hermes job / external runner id — still keyed by `parentAgentId`.

---

## 3. Agent-to-agent messaging & group rooms

### 1:1 agent DMs

- Sidebar still lists named agents; opening agent A shows **user ↔ A**.
- Separately, agents may message each other (orchestration / handoff).
- UI: optional “Messages from other agents” system rows in A’s thread, or a filter chip “Agent mail”.
- Data: `ChatMessage` with `role: 'agent'` plus `fromAgentId` / `toAgentId` when not user-authored.

MVP: mock a single handoff example (“Ops Runner asked Research Alpha for the deploy summary”) as a system+agent pair in Alpha’s transcript. No real routing yet.

### Group rooms

A **Group** is a multi-participant chat:

| Field | Meaning |
| --- | --- |
| `id` | `grp_*` |
| `name` | Display name |
| `memberAgentIds` | Named agents in the room |
| `transcript` | Shared `ChatMessage[]` (roles: user, agent, system, subagent) |

**Sidebar → Groups** lists rooms. Selecting a group:

- `ChatPanel` shows shared transcript; agent bubbles tagged with speaker name
- `ComputerPanel` targets the **primary** member (or last-active member); AgentInfo shows Members list (from sand-app-ui pattern: Members in group chats)
- Sending a user message addresses the room; mock router picks one agent to reply (round-robin or `@mention`)

MaiaVM later: a Group is **not** an Instance. It is a coordination object that fans out to member Instances’ chat endpoints / a room service. Desktop keeps `Group` client-side until hermes exposes rooms.

---

## 4. Turn model

### Happy path (named agent)

```
User message
    → UI appends user bubble immediately
    → transport ack (mock: ~100–300ms) → optional system “Heard.” / activity listening
    → work phase (thinking → working; may spawn subagents)
    → deliver agent message (and fold subagent finals)
    → idle
```

Already partially staged in `App.tsx` (`listening` → `thinking` → `working` → reply). Extend that pipeline to emit subagent digests mid-turn.

### Background revival

Agents (and subagents) may finish work **after** the user navigates away or the desktop was idle:

| Event | UI behavior |
| --- | --- |
| Subagent completes in background | Badge on parent sidebar row; digest chip appears when thread reopened |
| Named agent finishes long turn | Unread indicator on sidebar; toast optional |
| Group member posts | Unread on Groups row |

Mock transport: `MockAgentRuntime` uses `setTimeout` / `queueMicrotask` to complete runs even if `selectedId` changed; state lives in a module-level store (`src/lib/agents/store.ts`), not only in React state for the active chat.

### Turn record (for debugging / future streaming)

```ts
Turn {
  id, agentId, userMessageId,
  phase: 'acked' | 'working' | 'delivering' | 'done' | 'failed',
  subagentRunIds: string[],
  startedAt, finishedAt?
}
```

Streaming later = patching `Turn.phase` + appending digests over SSE/WebSocket from hermes-deploy. Mock just advances phases on timers.

---

## 5. MVP slice (Electron app NOW) + MaiaVM mapping

### MVP NOW (mock transport — no real Hermes required)

Shipable in the current Vite/Electron app:

1. **Types + mock module** under `src/lib/agents/` (see §6).
2. **Sidebar sections**: Agents / Groups (Groups can be 1–2 mock rooms).
3. **Mock spawn**: when user sends a message matching a simple heuristic
   (e.g. contains “research”, “browser”, “desktop”, or “PR”), parent turn
   spawns 1 mock `executor` (or matching kind), emits 2 digests, then final.
4. **Thread chips** for `role: 'subagent'` messages in `ChatPanel`.
5. **AgentInfo → Live subagents** list bound to `listSubagents(parentId)`.
6. **Turn staging** kept (listening / thinking / working) + subagent overlap.
7. **Background completion**: switch agents mid-flight; digest still lands in the correct `messagesByAgent[parentId]`.
8. **Settings**: no new secrets; mock flag stays `VITE_MAIAVM_MOCK`.

Out of scope for MVP: real box tool bridge, real noVNC driving, real multi-Instance fan-out, auth, persistent memory store.

### Map to MaiaVM Instances later

| Desktop concept | hermes-deploy / MaiaVM |
| --- | --- |
| Named agent | Instance (VM) |
| Chat send | `POST /api/instances/:id/chat` (extend with turn id) |
| Computer | `GET /api/instances/:id/computer` → noVNC |
| Subagent run | Job / child task on that Instance (or attached runner); id returned in chat stream |
| Subagent digest | Chat stream events `subagent.progress` / `subagent.done` |
| Group room | Future room service; members = Instance ids |
| Agent DM | Server-side mailbag between Instance agents |
| Background revival | Push/WS events → desktop store hydrate |
| Persona / memory | Instance metadata + box filesystem |

Migration path: keep `src/lib/agents/types.ts` stable; swap `src/lib/agents/mock-transport.ts` for `src/lib/agents/maiavm-transport.ts` that wraps `maiavm-api.ts`. UI imports only the transport interface.

---

## 6. Proposed TypeScript types + mock API

Suggested layout:

```
src/lib/agents/
  types.ts          # all interfaces + enums
  mock-data.ts      # seed agents, groups, sample runs
  store.ts          # in-memory store + subscribers (for background revival)
  transport.ts      # interface AgentTransport
  mock-transport.ts # implements AgentTransport with timers
  index.ts          # re-exports
```

Existing `src/lib/mock-data.ts` and `maiavm-api.ts` keep Instance list/chat/computer; new module **owns** multi-agent / subagent concerns and can re-export / wrap the old helpers during migration.

### `types.ts` (proposed)

```ts
/** Named agent == MaiaVM Instance in the product mapping */
export type AgentStatus = 'running' | 'stopped' | 'provisioning' | 'error'

export interface AgentPersona {
  title?: string
  description?: string
  /** Short preview only — full instructions stay server/box side */
  instructionsPreview?: string
}

export interface AgentMemory {
  summary?: string
  pinnedNoteIds?: string[]
}

export interface Agent {
  id: string
  name: string
  status: AgentStatus
  region: string
  createdAt: string
  summary: string
  persona?: AgentPersona
  memory?: AgentMemory
  unreadCount?: number
}

export type SubagentKind =
  | 'executor'
  | 'browserUse'
  | 'computerUse'
  | 'cloudCoder'
  | 'watcher'

export type SubagentStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface SubagentDigest {
  id: string
  at: string
  text: string
  /** Optional screenshot / file refs for browser/computer digests */
  attachments?: { id: string; name: string; kind: 'file' | 'image' }[]
}

export interface SubagentRun {
  id: string
  parentAgentId: string
  kind: SubagentKind
  title: string
  status: SubagentStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  digests: SubagentDigest[]
  result?: {
    summary: string
    artifacts?: { id: string; name: string; kind: 'file' | 'image' }[]
  }
  error?: string
}

export type MessageRole = 'user' | 'agent' | 'system' | 'subagent'

export interface ChatChoice {
  id: string
  label: string
}

export interface ChatMessage {
  id: string
  /** Thread owner: agent id or group id */
  threadId: string
  role: MessageRole
  content: string
  createdAt: string
  /** When role==='agent' in a group or DM */
  fromAgentId?: string
  toAgentId?: string
  /** When role==='subagent' */
  subagentRunId?: string
  subagentKind?: SubagentKind
  subagentStatus?: SubagentStatus
  attachments?: { id: string; name: string; kind: 'file' | 'image' }[]
  choices?: ChatChoice[]
}

export type TurnPhase = 'acked' | 'working' | 'delivering' | 'done' | 'failed'

export interface Turn {
  id: string
  threadId: string
  agentId: string
  userMessageId: string
  phase: TurnPhase
  subagentRunIds: string[]
  startedAt: string
  finishedAt?: string
}

export interface Group {
  id: string
  name: string
  memberAgentIds: string[]
  primaryAgentId: string
  summary?: string
  unreadCount?: number
  createdAt: string
}

export type ThreadRef =
  | { type: 'agent'; agentId: string }
  | { type: 'group'; groupId: string }
```

### `transport.ts` surface

```ts
export interface AgentTransport {
  listAgents(): Promise<Agent[]>
  listGroups(): Promise<Group[]>
  getMessages(thread: ThreadRef): Promise<ChatMessage[]>
  sendMessage(thread: ThreadRef, text: string): Promise<{ turnId: string }>
  listSubagents(parentAgentId: string, opts?: { liveOnly?: boolean }): Promise<SubagentRun[]>
  getSubagent(runId: string): Promise<SubagentRun>
  cancelSubagent(runId: string): Promise<void>
  /** Subscribe to store patches (messages, runs, unread). */
  subscribe(cb: (ev: TransportEvent) => void): () => void
  getComputerUrl(agentId: string): Promise<{ url: string | null; provider: string }>
}

export type TransportEvent =
  | { type: 'message'; thread: ThreadRef; message: ChatMessage }
  | { type: 'turn'; turn: Turn }
  | { type: 'subagent'; run: SubagentRun }
  | { type: 'agents'; agents: Agent[] }
  | { type: 'groups'; groups: Group[] }
```

### Mock behavior (`mock-transport.ts`)

- `sendMessage` on an agent thread:
  1. Append user message
  2. Emit turn `acked` → `working`
  3. Heuristic spawn (optional) → `subagent` events with digests every ~800ms
  4. Append agent final (mentions subagent summary if any)
  5. Turn `done`
- `sendMessage` on a group: append user message; mock-pick `primaryAgentId` or `@Name` mention; reply as that agent with `fromAgentId`
- `cancelSubagent`: mark cancelled; append system line in parent thread
- All timers check a generation token so StrictMode double-mount doesn’t double-reply

### Seed data ideas

- Agents: keep Research Alpha, Ops Runner, Draft Writer, New Instance
- Groups: `grp_deploy` “Deploy War Room” = Alpha + Ops
- One completed historical `SubagentRun` on Alpha for AgentInfo history demo
- One in-flight run triggered by first send in a session

---

## 7. UI changes (concrete)

### 7.1 Sidebar (`Sidebar.tsx`)

- Props grow: `agents`, `groups`, `selected: ThreadRef`, `onSelect(thread)`
- Two labeled sections (`Agents`, `Groups`) with uppercase muted headers (match existing `text-[11px] uppercase` style)
- Group rows: stacked mini CreatureMarks or a single “room” glyph + member count
- Unread badge (dot or count) from `unreadCount`
- Settings footer unchanged (account path from sand-app-ui: bottom-left; Cmd+, already wired)

### 7.2 ChatPanel thread chips

- Extend `Bubble` for `role: 'subagent'`:
  - Left-aligned card with kind label (`Executor`, `Browser`, …), status pill, title
  - Body = latest digest or `result.summary`
  - Collapsible digest timeline
- Typing indicator may show “Working with N subagents…” when live runs > 0
- Keep choice chips / attachments as today

### 7.3 AgentInfo (`AgentInfo.tsx`)

Add sections **above** Routines / Connectors:

1. **Persona** — title, description, instructions preview  
2. **Memory** — summary blurb (mock)  
3. **Live subagents** — list from `listSubagents(id, { liveOnly: true })`  
   - kind · title · status · elapsed · Cancel  
4. **Members** — only when `selected.type === 'group'`  
5. Existing Routines / Connectors placeholders  
6. Mini Computer preview later (sand-app-ui: live preview over Routines) — post-MVP

Open/close: click agent name in TopBar / Cmd+Shift+I (wire when TopBar supports it); Close / X as today.

### 7.4 App shell (`App.tsx`)

- Replace ad-hoc `messagesByAgent` + `handleSend` staging with `AgentTransport` + `subscribe`
- Selection state becomes `ThreadRef`
- Computer URL resolves from `thread.type === 'agent' ? id : group.primaryAgentId`
- Activity phase derived from active `Turn` + live subagent count

### 7.5 Visual language

Stay on Nub tokens (`--ca-*`). No Grok brand colors/marks. CreatureMark expressions already map status → emotion; map subagent running → parent `working`.

---

## 8. Implementation order (suggested PRs)

| PR | Scope |
| --- | --- |
| 1 | `src/lib/agents/types.ts` + `mock-data.ts` + `store.ts` + `mock-transport.ts` (unit-testable, no UI) |
| 2 | Wire `App.tsx` to transport; keep UI identical (agents only) |
| 3 | Subagent digests in `ChatPanel` + Live list in `AgentInfo` |
| 4 | Sidebar Groups section + group thread + Members in AgentInfo |
| 5 | Unread + background revival polish |
| 6 | `maiavm-transport.ts` stub behind flag when chat streaming exists |

---

## 9. Non-goals / clean-room boundaries

- Do **not** copy proprietary system prompts, tool JSON schemas, or brand strings.
- Do **not** claim feature parity with any commercial agent desktop.
- Subagent kinds are **product roles** for UX + mock routing, not a re-implementation of another vendor’s harness.
- Computer View remains noVNC-first per README MVP roadmap; subagents don’t require a second pane.
- Auth stays mock until session cookie / bearer is real (`REVERSE_ENGINEERING.md` product rules).

---

## 10. Acceptance checklist (MVP)

- [ ] `src/lib/agents/` exists with types, mock transport, store
- [ ] Sending a message can spawn a mock `executor` with ≥1 digest chip + final agent reply
- [ ] Switching agents mid-run still delivers the digest to the correct thread
- [ ] AgentInfo shows live subagents with Cancel
- [ ] Sidebar shows Agents + Groups; one mock group has a shared transcript
- [ ] `VITE_MAIAVM_MOCK=true` demos fully offline
- [ ] No Grok/Cursor branding in UI copy
- [ ] Doc link from `README.md` Key files (optional follow-up)

---

## 11. Quick glossary

| Term | Meaning in Nub |
| --- | --- |
| Named agent | Persistent sidebar entity = MaiaVM Instance |
| Subagent | Ephemeral worker run under a named agent |
| Group | Multi-agent (+ user) room; not an Instance |
| Turn | One user message’s ack→work→deliver cycle |
| Digest | Short progress/final card from a subagent in the parent thread |
| Transport | Swappable mock vs MaiaVM API adapter |
| Box / Computer | Linux desktop behind ComputerPanel (noVNC) |
