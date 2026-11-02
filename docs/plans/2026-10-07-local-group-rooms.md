# Local group rooms: multi-agent chat on `hermes serve`

Status: Draft 2 (revised 2026-10-07 after agy/Gemini 3.1 Pro cross-check).
Port of `hermes-deploy`'s server-run rooms
(`docs/plans/2026-09-25-group-rooms.md`) to the local transport.

## Cross-check revisions (agy second opinion)

Four issues flagged by the agy review and addressed in this revision:

1. **Race condition in the lock** (Phase 3) — `Set<string>` lock had a TOCTOU
   gap. Replaced with an async task queue per room.
2. **Serial/parallel contradiction** (Phase 4) — plan said "serial" but also
   "hand-offs run in parallel." Resolved: **all turns are serial in v1**.
3. **Brittle `[pass]` parsing** (Phase 6) — `startsWith` check fails on
   "I don't have anything to add, so [pass]". Replaced with regex extraction.
4. **Unbounded delta** (Phase 5) — no limit on messages sent to a member.
   Added a sliding window cap.

## Why

hermes-desk supports groups today, but only when talking to a **hermes-deploy**
server. The local transport (`HermesLocalTransport` → `hermes serve` on
`127.0.0.1:9120`) binds one conversation to one profile session and submits via
`prompt.submit`. There is no fan-out, no turn loop, no room feed. Groups in the
sidebar do nothing when you message them locally.

The UI layer is already transport-agnostic: `rooms.ts` (998 lines), the handoff
strip, presence line, and `turns-to-messages.ts` all consume `RoomMessageDTO` /
`RoomTurnDTO` shapes. The gap is purely in the transport.

## What exists (don't rebuild)

| Layer | File | Status |
|-------|------|--------|
| `Group` type, `ThreadRef` | `src/lib/agents/types.ts:266` | done |
| Group CRUD (local state) | `hermes-transport.ts:1607` (`createGroup`, `setGroupMembers`) | done — local state only |
| Room rendering, handoff strip, presence | `src/lib/agents/rooms.ts` | done — consumes DTOs |
| Mention parsing | `src/lib/mentions.ts:90` (`parseMentions`) | done |
| Orchestrator/Chief detection | `src/lib/peer-roster.ts` (`isOrchestrator`) | done |
| `roomsEnabled()` hook | `useAgentRuntime.ts:915` | calls transport, returns false |
| Per-member session storage | `store.ts:382` (`memberSessionIds`) | done — unused locally |
| Server room runner (reference) | `hermes-deploy/docs/plans/2026-09-25-group-rooms.md` | shipped — port this |

## What's missing

1. `HermesLocalTransport.sendMessage` has no `target.type === 'group'` branch.
2. No local turn loop (routing, delta construction, cascade bounds, pass/reply).
3. `roomsEnabled()` not implemented on `HermesLocalTransport` (returns false).
4. No room event emission in `RoomMessageDTO` / `RoomTurnDTO` shapes.
5. No per-member session binding (each member needs its own `hermes serve` session).

## Plan

### Phase 1: Per-member session binding

**File:** `src/lib/agents/hermes-local-transport.ts`

The existing `bind()` (line 432) creates one `SessionBinding` per conversation.
For groups, each member needs its own session on its own profile.

```
private groupBindings = new Map<string, Map<string, SessionBinding>>()
// key: conversationId → (memberAgentId → binding)

private async bindMember(
  conversation: Conversation,
  group: Group,
  memberAgentId: string,
): Promise<SessionBinding>
```

- Resolve the member's profile from the agent id (`profile:<name>` → `<name>`).
- Reuse `session.create` / `session.resume` with `profile: <memberProfile>`.
- Session id convention: `room:<groupId>:<memberAgentId>` (matches hermes-deploy).
- Store in `groupBindings` so each member has a persistent session across turns.
- Clean up on conversation delete / transport dispose.

**Verify:** Can create and resume sessions for 3 different profiles
simultaneously against `hermes serve`.

### Phase 2: Room state store

**New file:** `src/lib/agents/local-rooms.ts`

In-memory state for active rooms (no Prisma — local only, no persistence
across restarts for v1):

```typescript
interface LocalRoomState {
  roomId: string           // = group.id
  conversationId: string
  messages: RoomMessage[]   // seq-ordered, the source of truth
  turns: Map<string, RoomTurn>  // turnId → turn
  nextSeq: number
  memberCursors: Map<string, number>  // memberAgentId → last cursorSeq
}

interface RoomMessage {
  id: string; seq: number; speakerKind: 'human' | 'agent' | 'system'
  speakerId?: string; speakerName: string; text: string
  replyToId?: string; rootId?: string; depth: number
  roomTurnId?: string; createdAt: string
}

interface RoomTurn {
  id: string; memberId: string; rootId: string; triggerId: string
  depth: number; kind: 'reply' | 'wrap'
  windingDown: boolean; status: 'queued' | 'running' | 'sent' | 'pass' | 'error' | 'cancelled'
  cursorSeq: number; partialText?: string
  createdAt: string; completedAt?: string
}
```

**Verify:** State store can track a 3-member room through a full cascade.

### Phase 3: Turn loop (the runner)

**File:** `src/lib/agents/local-rooms.ts`

Port `hermes-deploy/src/lib/rooms/runner.ts` → `runRoom(roomId)`:

1. **Lock: async task queue per room.** Instead of a `Set<string>` lock (which
   has a TOCTOU race — a kick arriving as the loop exits its final iteration
   gets lost), use a per-room async queue. Each room gets its own
   micro-task chain; `kick(roomId)` enqueues a `runRoomLoop` call that runs
   after the current one finishes. This guarantees no message is ever lost.

   ```typescript
   private roomQueues = new Map<string, Promise<void>>()

   private kick(roomId: string): void {
     const existing = this.roomQueues.get(roomId) ?? Promise.resolve()
     const next = existing.then(() => this.runRoomLoop(roomId)).catch((e) =>
       this.logRoomError(roomId, e))
     this.roomQueues.set(roomId, next)
     // Clean up the queue entry after it settles to avoid leaks.
     next.finally(() => {
       if (this.roomQueues.get(roomId) === next) this.roomQueues.delete(roomId)
     })
   }
   ```

   `runRoomLoop` is the single-iteration loop body. `kick` chains them so
   only one loop body runs at a time per room, and a kick during the final
   iteration of the previous loop queues a new one that sees the new
   messages.
2. **Loop body (`runRoomLoop`):**
   - Settle finished turns: parse reply → `sent` or `pass`. Write `RoomMessage`.
   - Run follow-up routing (mentions → new queued turns).
   - Run Chief-wrap check (when all hand-offs settle, Chief gets one more turn).
   - Start `queued` turns whose member has no running turn.
   - If anything was started or settled, loop again (call `kick` self).
   - Exit when nothing is queued or running.
3. **Starting a turn:**
   - Build delta: messages with `seq > member.cursorSeq`, not written by that
     member, capped to the last `MAX_DELTA_MESSAGES` (see Phase 5).
   - Set `cursorSeq` to current `nextSeq`.
   - Build the ephemeral instructions (role prompt + room context — see below).
   - `prompt.submit` to the member's session.
   - Subscribe to the SSE stream for `partialText` and completion.
4. **Bounds (same as hermes-deploy):**
   - `MAX_DEPTH = 3`
   - `MAX_TURNS_PER_ROOT = 8`
   - `windingDown` when `depth >= MAX_DEPTH` or turns spent >= `MAX_TURNS_PER_ROOT - 2`
   - Single-flight per member (fold new work into next turn, don't kill running turns).
5. **No deadline** (same decision as hermes-deploy 2026-09-29).

**Verify:** A 3-member room with a Chief answers a human message in 1 turn
(Chief answers) or 3 turns (Chief → specialist → wrap). Pass works. Depth cap
stops cascades. A message sent while the loop is exiting triggers a new loop
iteration (no lost messages).

### Phase 4: Routing table

**File:** `src/lib/agents/local-rooms.ts`

Same rules as the hermes-deploy plan:

| New message | Who gets a turn |
|---|---|
| Human, with @mentions | Mentioned members (`@all` = everyone) |
| Human, no mention, room has Chief | Chief only |
| Human, no mention, no Chief | Every member (each may pass) |
| Agent, @mentions others, depth < MAX_DEPTH | Mentioned members (not author) |
| Agent, no mention | Nobody (except Chief-wrap) |

- **Chief-wrap:** when Chief hands off and all hand-off turns settle, Chief
  gets one more `windingDown` turn. `MAX_CHIEF_FOLLOWUPS = 2`.
- **Mention parsing:** reuse `parseMentions(text, members)` from `src/lib/mentions.ts`.
- **Chief detection:** reuse `isOrchestrator` from `src/lib/peer-roster.ts`.
- **Serial execution:** all turns are serial in v1 — members answer one at a
  time, ordered by mention order, then best-suited first. Hand-offs from a
  member also queue serially (not parallel). This simplifies the state
  machine: we never need to track "when all parallel hand-offs settle" —
  there's only one turn running at a time. hermes-deploy runs hand-offs in
  parallel for latency; we sacrifice that for correctness simplicity in v1.
  If latency becomes a problem, v2 can parallelize hand-offs with a
  `Promise.all` settle check.

**Verify:** Mention routing dispatches to the right member. `@all` hits
everyone. No-Chief rooms fan out to all. Chief rooms route to Chief only.

### Phase 5: Prompt construction

**File:** `src/lib/agents/local-rooms.ts`

Per-turn ephemeral `instructions` (same as hermes-deploy):

```
[You are <Name> · <Title>. Stay in this role. <description>]

[Group room "<room>". Members: <Name> — <description>; … (you are <Name>)
You get the room messages you haven't seen yet, each tagged with its speaker.
Reply only as yourself and never write lines for other members.
Answer only when you add something new. A bare acknowledgement is not a reply.
If you have nothing to add, reply with exactly [pass] and nothing else.
To hand work to a member, @mention them by name with a clear, self-contained ask.]

(Chief of Staff:)
[You lead this room. When the user doesn't name anyone, the message comes to
you. Answer it yourself when you can. When a member is better suited, @mention
them with a clear ask and add a one-line note for the user. You'll get another
turn after they reply, so don't wait on them or poll.]

(windingDown:)
[This exchange is wrapping up. Give the user the outcome or the decision they
need to make, or [pass]. Do not hand off to anyone else.]
```

Turn input (the `text` sent to `prompt.submit`):

```
[Room update: new messages since your last turn]
Torrey: …
CoderBob: …
(You were mentioned by AllenNub.)
```

- Member profiles (name, title, description, role) come from the `Group`'s
  `memberAgentIds` → resolved via `listHermesProfiles` / `profileToAgent`.
- If no profile metadata exists, fall back to `{ id, name: id }`.
- **Delta cap:** the delta is capped to the last `MAX_DELTA_MESSAGES = 50`
  messages (sliding window). If more than 50 messages accumulated since the
  member's last turn, only the most recent 50 are sent. A system note
  `(… N earlier messages)` is prepended so the member knows context was
  truncated. This prevents context window exhaustion on long cascades or
  when a member catches up after being idle.

**Verify:** A member turn with the constructed prompt produces a coherent
in-character reply or `[pass]`. A delta with 100+ messages is capped to 50
with a truncation note.

### Phase 6: Output parsing

**File:** `src/lib/agents/local-rooms.ts`

```
function parseMemberReply(raw: string): { pass: boolean; text: string }
```

- Pass when empty or the text **contains** `[pass]` (case-insensitive). The
  regex `/\[pass\]/i` searches anywhere in the text, not just `startsWith`.
  This handles "I don't have anything to add, so [pass]" and "[pass]" and
  "[pass] nothing to add" — all correctly detected as pass.
- Strip leading member-name or short-code tags (e.g. `[Penny] ...`).
- Strip any `[pass]` tokens from the text (global replace).
- Remaining text becomes the `RoomMessage`. If the text is empty after
  stripping `[pass]` tokens and whitespace, it's a pass.

```typescript
const PASS_RE = /\[pass\]/i

function parseMemberReply(raw: string): { pass: boolean; text: string } {
  const stripped = raw.replace(/^\[([a-zA-Z0-9_-]+)\]\s*/, '') // strip [Name] tags
  const hasPass = PASS_RE.test(stripped)
  const text = stripped.replace(/\[pass\]/gi, '').trim()
  return { pass: hasPass || text === '', text }
}
```

**Verify:**
- `[pass]` → pass ✓
- `I don't have anything to add, so [pass]` → pass ✓
- `[pass] nothing to add` → pass ✓
- `[Penny] I'll handle it` → `{ pass: false, text: "I'll handle it" }` ✓
- Empty string → pass ✓
- `Sure, here's my take: ...` → `{ pass: false, text: "Sure, here's my take: ..." }` ✓

### Phase 7: Event emission (wire to the UI)

**File:** `src/lib/agents/hermes-local-transport.ts`

Emit `TransportEvent`s that the existing `rooms.ts` rendering code consumes:

- **Message events:** `emit({ type: 'message', conversationId, message })`
  where `message` carries `speakerKind`, `speakerId`, `speakerName`,
  `roomTurnId`, `rootId`, `depth`, `seq`.
- **Turn events:** `emit({ type: 'turn', turn })` where `turn` carries
  `memberId`, `phase` (`queued`/`reading`/`working`/`typing`), `activity`,
  `partialText`, `rootId`, `triggerId`.
- **Phase mapping:** no runId → `queued`; tool activity → `working`;
  non-pass text → `typing`; otherwise `reading`.

The UI code in `rooms.ts` already handles these shapes (it was written for
the deploy transport). No React changes needed.

**Verify:** Messages appear in the chat with correct speaker names. Turn
bubbles stream. Handoff pills appear under @mentioned messages. Presence
line shows who's working.

### Phase 8: `sendMessage` group branch

**File:** `src/lib/agents/hermes-local-transport.ts`

Override `sendMessage` to branch on `conversation.target.type`:

```typescript
override async sendMessage(conversation, text, options) {
  if (conversation.target.type === 'group') {
    return this.sendGroupMessage(conversation, text, options)
  }
  return super.sendMessage(conversation, text, options)  // existing 1:1 path
}
```

`sendGroupMessage`:
1. Resolve the `Group` from state.
2. Write the human `RoomMessage` (seq, speakerKind: 'human').
3. Emit it as a `message` event.
4. Plan initial turns (routing table).
5. Queue them in `LocalRoomState`.
6. Kick `runRoom(roomId)`.
7. Return `{ turnId }`.

**Verify:** Sending a message to a group conversation triggers member turns.

### Phase 9: `roomsEnabled` + group CRUD

**File:** `src/lib/agents/hermes-local-transport.ts`

```typescript
override async roomsEnabled(): Promise<boolean> {
  return true  // local rooms are always available
}
```

`createGroup` and `setGroupMembers` are already on `HermesServeTransport`
(`hermes-transport.ts:1607`). They manipulate local state only — that's fine
for local rooms. No changes needed.

**Verify:** `roomsEnabled()` returns true. Groups appear in sidebar. Members
can be added/removed.

### Phase 10: Stop / cancel

**File:** `src/lib/agents/local-rooms.ts`

`stopRoom(roomId)`:
- Cancel all `queued` turns → `cancelled`.
- Send `session.interrupt` to each `running` member's session.
- Mark running turns as `cancelled` when the interrupt lands.

**Verify:** Stop button cancels in-flight turns. No orphaned sessions.

## Files touched

| File | Change |
|------|--------|
| `src/lib/agents/local-rooms.ts` | **NEW** — room state, turn loop, routing, prompt, output parsing (~600 lines) |
| `src/lib/agents/hermes-local-transport.ts` | `sendMessage` group branch, `sendGroupMessage`, `bindMember`, `roomsEnabled`, group binding cleanup (~150 lines) |
| `src/lib/agents/rooms.ts` | None — already consumes the DTO shapes |
| `src/lib/agents/types.ts` | None — `Group`, `ThreadRef` already support groups |
| `src/lib/agents/store.ts` | None — `memberSessionIds` already exists |
| React components | None — rendering is transport-agnostic |

## What we're NOT doing (v1)

- No persistence across restarts (room state is in-memory). v2 should persist
  `RoomMessage` logs to the local SQLite DB (same as 1:1 conversations use
  `hermes serve`'s session history).
- No cross-machine rooms (local profiles only).
- No Telegram rooms.
- No retention/pruning (rooms die with the process). v2 should prune
  `messages[]` and `turns Map` for long-lived rooms.
- No parallel hand-offs (all turns serial). v2 can parallelize with a
  `Promise.all` settle check if latency matters.
- No Redis lock (single-process, per-room async queue is enough).

## Testing

1. **Unit:** `local-rooms.test.ts` — routing table, delta construction, pass
   parsing (all 6 cases from Phase 6), cascade bounds, Chief-wrap, **async
   queue: message sent during loop exit triggers new iteration**. Pure
   functions, no gateway.
2. **Integration:** Create a 3-profile group (e.g. `nub`, `default`,
   `agent-two`), send a message, verify turns fire and messages render.
3. **Edge:** Stop mid-cascade. Member passes. Depth cap. No Chief. `@all`.
   Delta cap (send 60+ messages, verify truncation note).

## Open questions

1. Should member sessions be created lazily (first turn) or eagerly (group
   creation)? **Rec: lazy** — don't spin up sessions for members that never
   get a turn.
2. Should we reuse the member's existing 1:1 session if one exists, or always
   create a fresh `room:<groupId>:<member>` session? **Rec: fresh** — keeps
   room context isolated from 1:1 history (matches hermes-deploy).
3. Config flag to enable/disable? **Rec: no** — `roomsEnabled()` always true
   locally. Groups are opt-in by creating one.
