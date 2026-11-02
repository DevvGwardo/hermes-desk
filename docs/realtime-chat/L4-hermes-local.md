# L4 Local Hermes stream

Investigation of the desktop local Hermes path (`hermes-transport.ts` +
`hermes-stream.ts`) and the remote-VM Electron bridge (`nubChatStream` /
`nubChatAbort`). Four passes: full map, expert re-read, defect hunt, fix
sketches. Claims cite `path:line`.

## Protocol and timeouts

### Two backends, one UI bubble

`HermesServeTransport.sendMessage` (`src/lib/agents/hermes-transport.ts:868`)
creates one assistant bubble with `streaming: true` / `toolEvents: []`
(`hermes-transport.ts:892-904`), then prefers `hermes serve` WS
(`serveCreateSession` + `servePromptSubmit`, `hermes-transport.ts:911-931`).
On serve failure it falls through to OpenAI-compat SSE via
`streamViaApi` → `streamChatCompletion` (`hermes-transport.ts:936-938`,
`hermes-transport.ts:997-1014`), else mock.

`streamChatCompletion` (`src/lib/hermes-stream.ts:222`) POSTs
`{model, messages, stream: true}` to `/v1/chat/completions`
(`hermes-stream.ts:242-274`). Local loopback stays in the renderer
(`shouldUseNubChatBridge` false for localhost, `hermes-stream.ts:113-117`;
covered by `src/lib/__tests__/hermes-stream-bridge.test.ts:13-17`). Remote
Nub VMs go through Electron `nubChatStream`
(`hermes-stream.ts:238-239`, `electron/main.cjs:753-770`,
`electron/preload.cjs:164-181`) because VM CORS is dashboard-origin only
(`hermes-stream.ts:16-18`).

### Wire frames

SSE (api_server / nub-link):

- `data:` JSON `{choices:[{delta:{content}}]}` → `onDelta`
  (`hermes-stream.ts:320-326`; main `electron/nub-link.cjs:582-587`)
- `event: hermes.tool.progress` → `onTool` / `{type:'tool',...}`
  (`hermes-stream.ts:336-344`; `nub-link.cjs:592-596`)
- `subagent.*` / `hermes.subagent` → `onSubagent`
  (`hermes-stream.ts:349-357`; `nub-link.cjs:602-610`)
- finish via `finish_reason` then `[DONE]` (`hermes-stream.ts:327-330`,
  `hermes-stream.ts:310`)
- Continuity header `X-Hermes-Session-Id` request+response
  (`hermes-stream.ts:272`, `hermes-stream.ts:289-290`;
  `nub-link.cjs:378-379`, `nub-link.cjs:477-481`)

Serve WS (primary local path):

- `message.delta` appends onto the latest `streaming` bubble
  (`hermes-transport.ts:257-270`)
- `tool.start` / `tool.complete` → `pushToolEvent` onto same bubble
  (`hermes-transport.ts:272-291`, `hermes-transport.ts:462-493`)
- `message.complete` clears `streaming`, drops
  `streamingByConversation`, clears `streamWatch`, starts delegate watch
  (`hermes-transport.ts:293-329`)
- `subagent.*` gateway events do **not** mutate the parent text bubble;
  they materialize / update `SubagentRun` pills via
  `applyDelegateGateway` (`hermes-transport.ts:216-218`,
  `hermes-transport.ts:367-381`)

### Timeouts — what happens to the bubble

| Timer | Value | Where | Bubble effect |
|---|---|---|---|
| `FIRST_TOKEN_MS` | 30_000 | `hermes-stream.ts:72`, local `hermes-stream.ts:301-303`, bridge `hermes-stream.ts:135-138`, main `nub-link.cjs:248` + `nub-link.cjs:561-565` | No SSE frame yet → abort. Local returns `error: 'no first token'` (`hermes-stream.ts:397`, `hermes-stream.ts:407-409`). Bridge aborts via `nubChatAbort` then same. |
| `DEFAULT_TIMEOUT_MS` / `CHAT_TIMEOUT_MS` | 120_000 | `hermes-stream.ts:70`, wall-clock `hermes-stream.ts:257` / race `hermes-stream.ts:178`; main `nub-link.cjs:246` + `nub-link.cjs:460` | Mid/late abort → `stream timed out` if body already seen (`hermes-stream.ts:206-209`). |
| `STREAM_IDLE_MS` / `streamWatch` | 120_000 idle | `hermes-transport.ts:111`, armed `hermes-transport.ts:712-716`, bumped on any session event `hermes-transport.ts:210-214` + `hermes-transport.ts:719-722` | Missing `message.complete` → `onStreamWatchFire` → `settleHungStream`: `streaming:false`, keep partial text, no error string (`hermes-transport.ts:725-757`). Skips fire while tool permission pending or live delegates (`hermes-transport.ts:726-733`). Best-effort `serveInterrupt` (`hermes-transport.ts:738-743`). |

`streamViaApi` finalizes the bubble with `streaming: false` and whatever
`result.content` survived (`hermes-transport.ts:1050-1063`). Unlike
`mock-transport.streamLocalHermes` (`src/lib/agents/mock-transport.ts:372-379`),
it does **not** rewrite empty failures into a linked-agent error string;
empty + `!ok` returns `false` and the outer catch may delete the empty
bubble (`hermes-transport.ts:945-956`) or hand off to mock.

### STATE.md raceTimeout claim — **confirmed (primitive), mitigated (caller)**

`STATE.md:51`: "Renderer `raceTimeout` around `nubChatStream` does not
close the main-process fetch unless `nubChatAbort` is called."

**Confirm:** `raceTimeout` (`hermes-stream.ts:85-109`) only `reject`s; it
never touches the underlying promise or IPC. The main-process fetch stays
in `inflightChats` until `abortChat` (`nub-link.cjs:264-274`,
`main.cjs:772-775`).

**Mitigation today:** `streamViaNubBridge` catch always calls
`nubChatAbort(requestId)` (`hermes-stream.ts:204`). First-token timer also
aborts (`hermes-stream.ts:137-138`). Test
`hermes-stream-bridge.test.ts:54-74` asserts abort on hung stream.
The lesson remains: any new `raceTimeout(nubChatStream)` without an
explicit abort reopens zombie runs against the VM 10-run cap
(`STATE.md:50`, `nub-link.cjs:252`).

## Desktop liveAlready / sending lock

`useAgentRuntime.handleSend` (`src/lib/agents/useAgentRuntime.ts:329-371`):

1. `beginFlight(conversationId)` bumps `inFlightCounts`
   (`useAgentRuntime.ts:107-110`, `useAgentRuntime.ts:334`)
2. Starts `transport.sendMessage` then **immediately** `release()` /
   `endFlight` (`useAgentRuntime.ts:356-360`) — comment: unlock `sending`
   once the transport has the turn; stream liveness is `message.streaming`
3. `sending` = selected conv still in `inFlightIds`
   (`useAgentRuntime.ts:214-216`) — therefore only true for the brief
   window before `release()`, not for the whole SSE/WS turn
4. `liveConversationIds` = in-flight ∪ any thread with `m.streaming`
   (`useAgentRuntime.ts:209-211`, `src/lib/agents/activity.ts:138-146`)
   — this is what keeps the sidebar orb alive after selection changes

**`liveAlready` (busy reply)** lives in fallback/mock and deploy, **not**
in `HermesServeTransport`:

- mock/Nub SSE: `getMessages(...).some(m => m.streaming)` →
  "Still working on your last one…"
  (`mock-transport.ts:624-636`, `mock-transport.ts:78-79`)
- deploy: same pattern (`hermes-deploy-transport.ts:1086+`,
  `linkedDeployBusyReply` at `hermes-deploy-transport.ts:136-137`)
- serve transport: `sendMessage` always appends a new `streaming: true`
  bubble (`hermes-transport.ts:892-904`) with **no** prior-live check,
  even though `streamingByConversation` is tracked
  (`hermes-transport.ts:131`, set at `hermes-transport.ts:904`)

So on the primary local Hermes path, a second Send while the first bubble
is still streaming can stack two live assistants; the desktop "Still
working…" copy is mock/deploy-only (`STATE.md:52`).

## Tool chips and subagents on the same bubble

**Tool chips (join same streaming bubble):**

- SSE: `onTool` → `upsertToolProgress` → `patchMessage({ toolEvents })`
  on the in-flight `replyId` (`hermes-transport.ts:1022-1027`;
  mock `mock-transport.ts:281-285`). Upsert keys by `toolCallId` else
  running same-tool (`hermes-stream.ts:31-44`).
- Serve WS: `pushToolEvent` finds latest `m.streaming` and patches
  `toolEvents` in place (`hermes-transport.ts:462-493`). Store
  `subscribe` (`useAgentRuntime.ts:99`) refreshes UI without a transport
  `emit` on the tool path.
- Activity line prefers running tool verb over "Typing…"
  (`src/lib/__tests__/tool-activity.test.ts:149-163`).

**Subagents (interrupt/join as sibling pills, not text deltas):**

- SSE `delegate_task` tool.running → `noteDelegateFromSse` /
  `materializeDelegateRuns` + `emit({type:'subagent'})`
  (`hermes-transport.ts:1028-1029`, `hermes-transport.ts:434-443`)
- SSE `onSubagent` → `noteSubagentFromSse` (`hermes-transport.ts:1031-1033`)
- Serve `subagent.*` → `applyDelegateGateway` (`hermes-transport.ts:367-381`)
- Explicit spawn also `appendSubagentMessage` (role `subagent` bubble)
  (`hermes-transport.ts:1091-1101`)
- Parent `message.complete` does **not** cancel specialists; it calls
  `watchLiveDelegates` (`hermes-transport.ts:312-314`). Idle watchdog
  similarly defers while delegates live (`hermes-transport.ts:731-733`).

Net: tool progress stays on the parent streaming assistant; subagents
appear as separate run pills / `role:'subagent'` messages and keep the
conversation "live" after the parent text finishes.

## Defects (numbered, path:line)

1. **No `liveAlready` on serve path.** `HermesServeTransport.sendMessage`
   never gates on `streamingByConversation` / existing `m.streaming`
   (`hermes-transport.ts:868-904`). Contrast `mock-transport.ts:624-636`
   and `hermes-deploy-transport.ts:1086`. Double-send → two
   `streaming:true` bubbles; `message.delta` attaches to the *latest*
   only (`hermes-transport.ts:262-264`).

2. **`streamWatch` silent settle.** `settleHungStream` clears
   `streaming` with no error/partial marker (`hermes-transport.ts:747-757`).
   User sees a stopped empty/partial bubble with no "timed out" copy
   (mock SSE path *does* write failure text, `mock-transport.ts:372-379`).

3. **`raceTimeout` is wall-clock, not idle, on the bridge.** Bridge wraps
   the whole `nubChatStream` in 120s (`hermes-stream.ts:140-179`) while
   serve uses idle `streamWatch` (`hermes-transport.ts:111`). A slow but
   active remote tool turn can die at 120s wall even though frames still
   arrive — and first-token abort + full timeout both call
   `nubChatAbort` (`hermes-stream.ts:137`, `hermes-stream.ts:204`).

4. **Role-only frame clears first-token.** Local `sawFrame = true` on any
   parsed choice (`hermes-stream.ts:319`); main `markAlive()` even when
   `deltaText` is empty (`nub-link.cjs:582-588`). Matches
   `STATE.md:52` "connected but didn't finish a reply" — first-token
   protection ends, then the turn burns the full 120s.

5. **Serve `pushToolEvent` does not `emit('message')`.**
   (`hermes-transport.ts:493` vs delta path `hermes-transport.ts:269`).
   Relies on store subscription; any transport-only listener misses tool
   chips.

6. **`sending` unlocks before stream ends.** `release()` right after
   starting `sendMessage` (`useAgentRuntime.ts:356-360`) means the input
   is not locked for the turn; only transport-level busy replies (missing
   on serve — defect 1) prevent overlap.

7. **`streamViaApi` success path never arms `streamWatch`.** Watch is
   armed only after successful `servePromptSubmit`
   (`hermes-transport.ts:931`). SSE fallback relies solely on
   `hermes-stream` timers — fine — but a hung serve that *returns* from
   `prompt.submit` without later events depends entirely on idle watch;
   if `armStreamWatch` raced with an early `streamingByConversation`
   delete, watch no-ops (`hermes-transport.ts:714`).

## Ranked improvements (P0/P1/P2)

**P0 — Gate concurrent sends in `HermesServeTransport.sendMessage`.**
Before appending the streaming reply, if
`streamingByConversation.has(conversationId)` or any `m.streaming`, emit
the same busy string as mock (`linkedAgentBusyReply`) and return. Mirror
`mock-transport.ts:624-636`. Optionally keep `sending` true until
`message.complete` / settle if product wants input lock.

**P1 — Make hung-stream visible.** In `settleHungStream`
(`hermes-transport.ts:747-757`), if content is empty set a clear error
(reuse linked slow/timeout copy); if partial, append a muted
"(stopped — no reply complete)" or set a `partial` flag. Align SSE
`streamViaApi` empty-failure handling with `mock-transport.ts:372-379`.

**P1 — Idle (not wall) budget on nub bridge.** Replace or supplement
`raceTimeout(..., DEFAULT_TIMEOUT_MS)` (`hermes-stream.ts:140-179`) with
an idle watchdog reset on delta/tool/subagent (same shape as
`bumpStreamWatch`). Keep `FIRST_TOKEN_MS` as the headers-only fuse.
Always pair any timeout reject with `nubChatAbort` (already true;
preserve in refactors — `STATE.md:51`).

**P2 — Treat role-only chunks as not-alive for first-token.** Only
`markAlive` / `sawFrame` when `delta.content` non-empty or tool/subagent
arrives (`hermes-stream.ts:319-326`, `nub-link.cjs:582-588`). Prevents
burning 120s after a silent role frame (`STATE.md:52`).

**P2 — Emit message on `pushToolEvent`.** After `patchMessage`,
`this.emit({ type: 'message', ... })` (`hermes-transport.ts:493`) for
transport-listener parity with deltas.

**P2 — Tests.** Extend `hermes-stream-bridge.test.ts` for mid-stream
abort + idle; add hermes-transport unit coverage for `streamWatch` fire,
`message.complete`, and liveAlready. `hermes-serve.test.ts` today only
covers WS JSON-RPC framing, not transport bubble lifecycle.

## What I did not verify

- Live runtime against a real `hermes serve` or linked Nub VM (static
  read + tests only).
- Whether UI ChatPanel disables the composer from `liveConversationIds`
  independently of `sending` (composer wiring not fully traced).
- Exact `hermes-deploy-transport` busy-reply branch beyond the
  `m.streaming` guard at `hermes-deploy-transport.ts:1086`.
- Main-process JSON fallback path (`nub-link.cjs:417-433`) interaction
  with desktop bubble text when SSE returns headers-only.
- Android / Capacitor chat path (out of L4 desktop scope).

## Pass log

1. **Full map** — protocol, dual backends, three timers, bridge IPC,
   tool/subagent join rules (above).
2. **Expert re-read** — confirmed `message.complete` is the only clean
   serve settle (`hermes-transport.ts:293-311`); `streamWatch` is the
   safety net for a missing complete; bridge abort story matches tests.
3. **Defect hunt** — seven issues, strongest: missing serve
   `liveAlready`, silent idle settle, wall-clock bridge timeout,
   role-only first-token false safety.
4. **Fix sketches** — P0 concurrent-send gate; P1 visible hang + idle
   bridge budget; P2 role-only / emit / tests.
