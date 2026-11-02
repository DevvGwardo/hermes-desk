# L3 Deploy SSE / turn identity

Investigation leaf L3 — phone + paired cube chat path.
Sources: `HermesDeployTransport`, `deploy-stream.ts`, mobile `deploy-client.ts`,
`active-transport.ts`, tests, `docs/DEPLOY_TRANSPORT_WIRING_PLAN.md`, `STATE.md`.
Investigation only; no `src/` edits.

## Protocol (POST, events, poll)

Wire (header comment at `hermes-deploy-transport.ts:1-4`):

1. **Start:** `POST /api/chat` with `stream: true`, `transport: 'poll'`
   (`hermes-deploy-transport.ts:1169-1182`).
2. **Auth:** `Authorization: Bearer ${desktopToken}` only
   (`hermes-deploy-transport.ts:228-232`). No `gatewayToken`.
3. **Identity headers on response:**
   - `X-Hermes-Turn-Id` → server turn id (`hermes-deploy-transport.ts:1191-1193`)
   - `X-Hermes-Session-Id` → cloud session (`hermes-deploy-transport.ts:1185-1189`)
4. **SSE body path:** if `content-type` is `text/event-stream`, consume POST body
   via `consumeIntoMessage` → `consumeWithReattach`
   (`hermes-deploy-transport.ts:1205-1208`, `424-471`).
5. **JSON / 202 poll path:** read `turnId` from JSON, then
   `attachTurn(..., { follow: true })` which GETs
   `/api/chat/runs/:turnId/events` (`hermes-deploy-transport.ts:1211-1230`,
   `677-713`, `412-421`).
6. **Reattach:** `Last-Event-Id` header when `lastEventId > 0`
   (`deploy-stream.ts:196-198`, `234-241`; `hermes-deploy-transport.ts:412-416`).
7. **410 / 404 on events:** `reattachBody` returns `null`
   (`hermes-deploy-transport.ts:418`). Caller stops consuming.
8. **State poll fallback:** `STATE_POLL_MS = 1250`,
   `STATE_POLL_MAX_MS = 15 * 60 * 1000` (`hermes-deploy-transport.ts:88-89`).
   `followTurnByState` loops `loadTurnState` → `applyTurnState`
   (`hermes-deploy-transport.ts:898-931`). Used by `getMessages` when a turn is
   still `pending|streaming` (`hermes-deploy-transport.ts:946-948`), and as the
   documented refresh/410 fallback (`hermes-deploy-transport.ts:872-873`,
   `1227-1229`).
9. **SSE parse:** OpenAI `choices[0].delta.content`,
   `event: hermes.tool.progress`, `subagent.*`, `hermes.approval.request`,
   `data: [DONE]`, `id:` lines (`deploy-stream.ts:51-137`).
10. **Mobile pairing helper** (`src/mobile/deploy-client.ts`) still has
    `sendChat` / `attachRunEvents` / `consumeSseStream`, but **live chat does
    not use them**. `MobileApp` / `MobileChat` call `getActiveTransport()` only
    (`MobileApp.tsx:44`, `72`, `161`; `MobileChat.tsx:79`). `deploy-client` is
    pairing auth + `RemoteThread` typing (`MobileConnect.tsx` imports).

## Identity (local id vs X-Hermes-Turn-Id vs persist)

### sendMessage → runCubeTurn bubble lifecycle

1. **Busy gate:** if any message in the thread has `streaming: true`, append a
   busy agent bubble (`linkedDeployBusyReply`) and return a synthetic turn id
   (`hermes-deploy-transport.ts:1086-1098`). No second cloud POST.
2. **Claim stream:** `beginLiveStream(conversationId)` **before** the POST
   (`hermes-deploy-transport.ts:1147-1150`). Ref-counted map
   (`hermes-deploy-transport.ts:201-215`). Blocks `getMessages` /
   `applyTurnState` / mid-poll `followTurnByState` from hydrating
   (`hermes-deploy-transport.ts:912`, `940`, `983`).
3. **Placeholder:** local `replyId = uid('msg')` → `msg_<time>_<rand>`,
   `streaming: true`, empty content (`hermes-deploy-transport.ts:1151-1163`).
4. **Rebind on header:** as soon as `X-Hermes-Turn-Id` arrives,
   `rebindMessageId(conversationId, replyId, headerTurn)` rewrites the store
   row id (or drops the local row if `toId` already exists)
   (`hermes-deploy-transport.ts:1191-1193`, `255-278`).
5. **Deltas:** `consumeIntoMessage` patches **the rebound** `liveReplyId`
   (`hermes-deploy-transport.ts:1206-1207`, `440-442`).
6. **Complete:** after stream, `streaming: false`
   (`hermes-deploy-transport.ts:473-476`). `endLiveStream` in `finally`
   (`hermes-deploy-transport.ts:1236-1238`).
7. **Hydrate match:** `findBoundAssistant` prefers `m.id === turnId`, else any
   `role === 'agent' && streaming` (`hermes-deploy-transport.ts:281-287`).
   `applyTurnState` rebinds a mismatched streaming (or same-content complete)
   row onto `turn.id` before append (`hermes-deploy-transport.ts:1007-1019`).

### Session persist

- Empty local thread → mint `api-<16 hex>` via `newHermesSessionId`
  (`hermes-deploy-transport.ts:130-134`).
- Echoed `X-Hermes-Session-Id` written to `conversation.hermesSessionId`
  (`hermes-deploy-transport.ts:359-374`, `1185-1189`).
- Group members keep per-agent `memberSessionIds`
  (`hermes-deploy-transport.ts:376-399`).

### consumeWithReattach / Last-Event-Id

```
canResume = result.aborted || lastEventId > 0 || !sawDelta
```
(`deploy-stream.ts:234-238`)

| POST close shape | sawDelta | lastEventId | Reattach? |
|---|---|---|---|
| Tokens, no `id:`, no `[DONE]` | true | 0 | **No** (clean full response) |
| Tokens + `id: N`, no `[DONE]` | true | N | Yes, `Last-Event-Id: N` |
| Abort mid-stream | — | maybe N | Yes (`aborted`) |
| No tokens yet | false | 0 | Yes (still waiting) |
| `[DONE]` | — | — | No (`complete`) |

Test lock: `deploy-stream.test.ts:196-213` ("does not replay a clean POST
close that already delivered tokens").

`attachTurn` always opens events at **0**
(`hermes-deploy-transport.ts:711`) — resume cursor is only inside a single
`consumeWithReattach` chain, not across separate `attachTurn` calls.

## STATE.md verdicts (confirm/refute each)

### 1. Hydrate/getMessages matching only on turn id → second bubble (local `msg_*` vs server turn id). Bind streaming bubble to `X-Hermes-Turn-Id`.

**CONFIRMED as a real past bug; FIXED in current code (with residual holes).**

Evidence of the fix:

- Comment + `rebindMessageId` at `hermes-deploy-transport.ts:252-278`.
- Send path rebinds immediately on header: `hermes-deploy-transport.ts:1191-1193`.
- `applyTurnState` / `attachTurn` also rebind via `findBoundAssistant`
  (`hermes-deploy-transport.ts:684-686`, `1007-1010`).
- `liveStreams` prevents `getMessages` from state-hydrating during the local
  send (`hermes-deploy-transport.ts:934-940`; test
  `hermes-deploy-transport.test.ts:574-634`).
- After send, agent bubble id is the turn id
  (`hermes-deploy-transport.test.ts:277-279`).

Residual: if the POST never returns `X-Hermes-Turn-Id`, the bubble stays
`msg_*`. After `streaming: false`, `findBoundAssistant` no longer matches by
streaming; only same-content rebind in `applyTurnState`
(`hermes-deploy-transport.ts:1012-1019`) saves you — content drift ⇒ second
bubble. Group fan-out: `findBoundAssistant`'s "any streaming agent" fallback
(`hermes-deploy-transport.ts:285`) can cross-wire two in-flight member bubbles
during hydrate/`attachTurn` (send path itself rebinds by its own `replyId`, so
the send path is safe).

### 2. Clean `/api/chat` POST close without SSE `id:` is the full response. Reattaching `/events` from 0 reprints the same tokens.

**CONFIRMED as a real past bug; FIXED in `consumeWithReattach`.**

Evidence:

- Guard + comment at `deploy-stream.ts:234-238`.
- Unit test `deploy-stream.test.ts:196-213` asserts `reattach` is **not**
  called when tokens arrived with no `id:` and no `[DONE]`.
- When `id:` *was* seen, reattach forwards `Last-Event-Id`
  (`deploy-stream.ts:224-226`, `196-198`; test `deploy-stream.test.ts:139-161`).

Residual: a **fresh** `attachTurn(..., 0)` still replays the full durable
buffer into whatever content is already on the bubble
(`hermes-deploy-transport.ts:711`, `440-442` appends). Mitigated for the
"already complete, id matches" list-conversations case
(`hermes-deploy-transport.ts:854`), but not if state hydrate wrote partial
`assistantContent` while `attachTurn({ follow: true })` also runs.

### 3. Do not construct a second `HermesDeployTransport` in `MobileApp`. `getActiveTransport()` is the singleton.

**CONFIRMED as a required invariant; CURRENTLY OBEYED.**

Evidence:

- `MobileApp.tsx` only imports/calls `getActiveTransport` /
  `resetActiveTransport` (`MobileApp.tsx:4`, `44`, `72`, `161`, `202`, `292`).
  Zero `new HermesDeployTransport` in `src/mobile/`.
- `MobileChat.tsx:79` likewise uses the singleton for open-thread poll.
- Singleton cache: `active-transport.ts:43-50`, `179-199`.
- Construction happens only inside `deployTransportIfPaired` /
  `deployTransportFromNubLink` during resolve (`active-transport.ts:75-106`),
  then cached. Tests assert deploy selection via `getActiveTransport`
  (`hermes-deploy-transport.test.ts:138-154`).

Note: `resetActiveTransport()` on pair/unlink intentionally drops the cache so
the next resolve builds a fresh transport from the new session — that is one
singleton over time, not two concurrent senders.

## Defects (numbered, path:line)

1. **`attachTurn` 410/404 leaves `streaming: true`.**
   `reattachBody` null → early `return` with no `streaming: false`
   (`hermes-deploy-transport.ts:711-712`). `finally` only clears
   `attaching` / `inFlightByConversation` (`714-716`). Contrast
   `followTurnByState` which clears streaming in `finally`
   (`927-930`). Symptom: stuck typing indicator; busy-gate blocks the next
   send (`1086-1098`).

2. **`attachTurn` always resumes from event id 0.**
   (`hermes-deploy-transport.ts:711`). If the bubble already holds text from
   `applyTurnState` and `follow: true` forces attach while streaming
   (`688-689`), `onDelta` appends (`440-442`) → duplicated tokens. List path
   skips only the complete+matching-id case (`854`).

3. **Missing `X-Hermes-Turn-Id` on SSE POST.**
   Bubble stays `msg_*` (`1193`, `1206`). Post-complete hydrate can append a
   second agent row when content-equality rebind fails (`1012-1038`).

4. **`findBoundAssistant` streaming fallback is conversation-global.**
   (`281-287`). Group `Promise.all` of two `runCubeTurn`s
   (`1105-1118`) can make hydrate/`attachTurn` rebind the wrong member's
   bubble.

5. **Legacy `deploy-client` chat helpers have no `Last-Event-Id` / no
   reattach / no turn rebind.**
   `attachRunEvents` (`deploy-client.ts:271-287`) GETs events with no resume
   header; `consumeSseStream` (`243-268`) has no `[DONE]`/id tracking beyond
   delta lines. Not on the live UI path today, but a footgun if re-wired.

6. **Fire-and-forget `attachTurn` from `listConversations`.**
   (`hermes-deploy-transport.ts:874`). Errors/410 don't surface; combined with
   defect 1, home `inFlightTurnId` follow can stick a streaming placeholder.

7. **`consumeWithReattach` returns `complete: false` on clean no-id close.**
   (`deploy-stream.ts:237-238`, test expects `complete: false` at
   `deploy-stream.test.ts:211`). Callers still force `streaming: false` in
   `consumeIntoMessage` (`473-476`) — OK for the bubble, but any future caller
   that keys off `complete` may mis-handle.

8. **Open-thread poll vs live send is protected; open-thread poll vs
   `attachTurn` is not fully serialized.**
   `getMessages` yields only while `hasLiveStream` (`940`). After local send
   ends, MobileChat's 10s `getMessages` (`MobileChat.tsx:73-90`) and a
   followLive conversations poll can interleave state snapshots with events
   replay (defect 2).

## Ranked improvements (P0/P1/P2)

### P0

1. **`attachTurn` — clear streaming on null body.**
   In `attachTurn`, when `reattachBody` returns null, call
   `patchMessage(conversationId, turnId, { streaming: false })` (and optionally
   fall through to `followTurnByState` as the documented 410 fallback). Mirror
   `followTurnByState`'s `finally` at `927-930`.

2. **Do not append deltas onto non-empty content when attaching from 0.**
   Options in `attachTurn` / `consumeIntoMessage`:
   - If `existing.content` is non-empty and `lastEventId` start is 0, replace
     (seed from state) or skip SSE and stay on `followTurnByState`.
   - Or track high-water event id per turn on the transport and pass it into
     `reattachBody` instead of hard-coded `0` (`711`).

### P1

3. **Harden identity when header is missing.**
   In `runCubeTurn`, if SSE/JSON lacks turn id, keep a side table
   `localReplyId → pending`, and on first `applyTurnState` / events URL
   discovery call `rebindMessageId` before any append.

4. **Scope `findBoundAssistant` for groups.**
   Prefer `(m.id === turnId) || (m.streaming && m.fromAgentId === expected)`
   instead of bare first streaming agent (`285`).

5. **Serialize followLive attach with state hydrate.**
   After send, if `inFlightByConversation` or a streaming row exists for that
   turn, prefer one owner (events **or** state), not both.

### P2

6. **Delete or wrap legacy `deploy-client` stream helpers** so they cannot be
   mistaken for the production chat path; or route them through
   `consumeWithReattach` + turn rebind.

7. **Treat clean no-id close as `complete: true`** in `consumeWithReattach`
   when `sawDelta && lastEventId === 0 && !aborted` (`deploy-stream.ts:237`),
   matching the semantic "full response" comment — keeps return value honest.

8. **Test matrix to add:** 410 during `attachTurn` ⇒ not streaming; attach
   after partial `applyTurnState` ⇒ no duplicated text; group dual-stream
   hydrate ⇒ two distinct turn ids.

## What I did not verify

- Live network against www.maiavm.com / a real cube (no runtime POST/SSE).
- hermes-deploy proxy `runs/[turnId]/events` Last-Event-Id semantics on the
  server (only client assumptions + plan doc §2.1).
- Whether production ever omits `X-Hermes-Turn-Id` on SSE 200.
- Android WebView-specific AbortError / stream-close behavior.
- Desktop Electron paired path beyond the same `HermesDeployTransport` class
  (assumed identical; `App.tsx` also uses `getActiveTransport`).
- Overlay event emission completeness (plan notes historical gaps; STATE.md
  says overlay was later extended — not re-validated here).
- Exact race timing between MobileChat 10s poll and home conversation poll
  under load (reasoned from code only).

---

## Pass notes (investigation discipline)

**Pass 1 — full trace (≥80 lines):** protocol, identity, reattach, poll,
mobile wiring documented above with `path:line` citations.

**Pass 2 — expert re-read:** re-checked `rebindMessageId`, `liveStreams`,
`canResume`, `attachTurn` early-return, MobileApp singleton, and tests
`deploy-stream.test.ts:196-213` + `hermes-deploy-transport.test.ts:574-634`.
STATE.md lessons 43–45 map 1:1 to those three mechanisms.

**Pass 3 — defect hunt:** eight residual holes listed; highest severity is
stuck `streaming: true` after 410 and attach-from-0 append duplication.

**Pass 4 — fix sketches (function names):**

- `HermesDeployTransport.attachTurn` — null-body streaming clear + optional
  `followTurnByState` fallback; pass last event id into `reattachBody`.
- `HermesDeployTransport.consumeIntoMessage` — optional `replaceContent` /
  skip-append when reseeding from state.
- `HermesDeployTransport.findBoundAssistant` — add `fromAgentId` argument.
- `HermesDeployTransport.runCubeTurn` — pending-rebind map when header absent.
- `consumeWithReattach` (`deploy-stream.ts`) — mark clean no-id close complete.
- Tests: extend `hermes-deploy-transport.test.ts` + `deploy-stream.test.ts`.
