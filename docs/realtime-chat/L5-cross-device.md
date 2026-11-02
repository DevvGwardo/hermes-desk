# L5 Cross-device live sync

Question: if desktop is streaming a reply, how/when does the Android app show those tokens, and vice versa?

All numbers below are **measured-from-source** (named constants / `setInterval` periods in the cited lines). Network RTT is additive and not coded as a constant.

## Topology (who pushes, who polls)

Shared cloud store is the deploy chat API (`POST /api/chat`, `GET /api/chat/state`, `GET /api/chat/conversations`, optional `GET /api/chat/runs/:turnId/events`). Both phone and paired desktop resolve to `HermesDeployTransport` when a desktopToken session is present (`active-transport.ts:75-84`, `active-transport.ts:94-106`).

**Sender (device that called send):**
- Local bubble is appended with `streaming: true` immediately (`hermes-deploy-transport.ts:1151-1160`).
- Tokens arrive on that device via the POST SSE body or `attachTurn` → `/events` (`hermes-deploy-transport.ts:1205-1230`, `hermes-deploy-transport.ts:677-717`).
- `beginLiveStream` / `hasLiveStream` block state-hydration from racing the local SSE (`hermes-deploy-transport.ts:203-215`, `hermes-deploy-transport.ts:937-940`).

**Idle / other device:**
- **No** shared WebSocket / SSE fan-out to clients that did not start the turn.
- Phone open chat: interval poll `transport.getMessages` every `OPEN_THREAD_POLL_MS = 10_000` (`MobileChat.tsx:16`, `MobileChat.tsx:69-91`).
- Phone home: `HOME_CONV_POLL_MS = 15_000` → `listConversations({ followLive: false })` (`home-refresh.ts:7`, `MobileApp.tsx:41-49`, `MobileApp.tsx:103-105`). Opening a row also one-shots `getMessages` (`MobileApp.tsx:157-166`, `MobileApp.tsx:181-186`).
- Desktop (deploy only): interval every `15_000` ms → `listConversations({ followLive: false })` + `getMessages(openId)` (`App.tsx:344-372`). Window `focus` triggers the same refresh (`App.tsx:374-375`).
- Once `getMessages` sees `pending`/`streaming`, it enters `followTurnByState`, which re-GETs `/api/chat/state` every `STATE_POLL_MS = 1250` until complete/error or `STATE_POLL_MAX_MS = 15 * 60 * 1000` (`hermes-deploy-transport.ts:88-89`, `hermes-deploy-transport.ts:934-954`, `hermes-deploy-transport.ts:897-923`).
- `listConversations` default `followLive: true` can `attachTurn` (SSE `/events`) for `inFlightTurnId` rows (`hermes-deploy-transport.ts:848-875`). Recurring home/desktop polls pass `followLive: false`, so they **never** attach (`MobileApp.tsx:46`, `App.tsx:360`).

**Client persist is not a cross-device channel.** `persist.ts` writes `localStorage` key `maia:agents-store:v1` on the same renderer only (`persist.ts:17`, `persist.ts:119-134`). Debounce is 800 ms (`persist.ts:152-160`).

`useAgentRuntime.ts` does not poll the cloud; it only bridges the in-memory store + local send flights (`useAgentRuntime.ts:98-102`, `useAgentRuntime.ts:329-368`). Cross-device visibility is entirely the transport poll loops above.

## Latency table (desktop→phone, phone→desktop, home vs open chat)

| Path | Discovery poll | After live turn found | Worst-case first paint of remote tokens / preview | Notes |
|---|---|---|---|---|
| Desktop streaming → phone **open chat** | `OPEN_THREAD_POLL_MS` **10_000** (`MobileChat.tsx:16`) | `STATE_POLL_MS` **1_250** state snapshots (`hermes-deploy-transport.ts:88`, `:922`) | **≈ 10_000 ms + 1 RTT** to first `getMessages`/`loadTurnState`; then content advances every **1_250 ms** | Immediate `void tick()` on open (`MobileChat.tsx:86`) can be 1 RTT if you open mid-stream; worst case is just-missed interval. Path uses **state poll, not `/events` SSE**. |
| Desktop streaming → phone **home list** | `HOME_CONV_POLL_MS` **15_000** (`home-refresh.ts:7`) | n/a (no turn follow; `followLive: false`) | **≈ 15_000 ms** for `lastUsedAt`/row churn **if** server sends `lastUsedAt`; subtitle often **never** updates (see Persist / Defects) | Home does not call `getMessages`. Preview keep-local: `existing.preview \|\| row.preview` (`hermes-deploy-transport.ts:782-783`). |
| Phone streaming → desktop **open chat** | Desktop sync **15_000** (`App.tsx:372`) | same **1_250** follow (`hermes-deploy-transport.ts:88`) | **≈ 15_000 ms + 1 RTT** worst-case; focus refresh can cut wait (`App.tsx:374-375`) | Same `getMessages` → `followTurnByState` path (`App.tsx:366`, `hermes-deploy-transport.ts:946-948`). |
| Phone streaming → desktop **sidebar / list** | **15_000** list poll (`App.tsx:372`) | no attach (`followLive: false`) | **≈ 15_000 ms** for list metadata; open-thread text only after `getMessages` | Mount-time `listConversations()` defaults `followLive: true` once (`App.tsx:325`) and may SSE-attach that once. |
| Local sender (either device) | n/a | SSE deltas on the send socket | **≈ 0 ms coded delay** (raf-coalesced patches) | `patchMessage` coalesces to rAF unless `streaming: false` / toolEvents (`store.ts:146-167`). |

**Answer (gate L5-3):** worst-case for the phone to **see desktop tokens in an already-open thread** is one full open-thread interval: **10_000 ms** (`MobileChat.tsx:16`) plus the `getMessages`/`/api/chat/state` round trip, then partial text refreshes only every **1_250 ms** (`hermes-deploy-transport.ts:88`) via state snapshots — not a live `/events` subscription. On the home list the worst case is **15_000 ms** (`home-refresh.ts:7`) and often shows no token text at all.

## Persist: what the other device can even read

1. **localStorage settle strips in-flight.** `savePersistedState` always runs `settleStaleInFlight`, forcing `streaming: false` (and cancelling live tools/subagents/turns) before disk write (`persist.ts:41-60`, `persist.ts:119-131`). Confirmed by tests (`persist-settle.test.ts:57-67`, `persist-settle.test.ts:143-163`).
2. **Streaming patches do not schedule persist.** `applyPendingMessagePatches` sets `persist` only when some patch has `streaming === false` (`store.ts:105-126`). Mid-stream token growth stays RAM-only on the sender.
3. **Debounce 800 ms** after mutations that do persist (`persist.ts:152-160`) — irrelevant across devices; the peer never reads this disk.
4. **Cross-device partial text** therefore depends entirely on server `ChatTurnState.assistantContent` while `status` is `pending`/`streaming` (`hermes-deploy-transport.ts:167-173`, `hermes-deploy-transport.ts:1042-1047`). If the backend only flushes final text, the follower sees an empty/working bubble until complete despite `followTurnByState`.
5. **Home subtitle freeze.** Leaving chat snapshots preview into the conversation (`home-refresh.ts:17-21`, `MobileApp.tsx:131-134`). `homeRowPreview` prefers stored preview and refuses to walk the live transcript (`home-model.ts:72-78`). Combined with keep-local preview merge (`hermes-deploy-transport.ts:782-783`), mid-stream desktop tokens do not rewrite the phone home row.

## liveAlready / "Still working on your last one" across devices

- Deploy transport: before POST, if **local** store already has any `streaming` agent message, append busy copy from `linkedDeployBusyReply()` — *"Still working on your last one. Wait a moment, then try again."* — and return (`hermes-deploy-transport.ts:1086-1097`, `hermes-deploy-transport.ts:136-137`).
- Desktop/mock Nub path: same idea via `liveAlready` on local messages (`mock-transport.ts:624-636`, `mock-transport.ts:79`).
- This gate is **per-renderer store**, not a server lock. Device B only learns Device A is live after B's `getMessages`/`applyTurnState` writes `streaming: true` (`hermes-deploy-transport.ts:1042-1047`).
- Race window: both devices can send successfully until one has hydrated the other's in-flight turn (up to the discovery intervals in the table). After hydration, a second send on that device gets the busy bubble instead of a new POST.
- `useAgentRuntime` `inFlightCounts` / `sending` are also local-only (`useAgentRuntime.ts:86-117`, `useAgentRuntime.ts:214-216`) and do not propagate.

## App background, lock screen, WebView freeze

- Android WebView fires `visibilitychange`/`blur` noisily; only **hidden → visible** counts as resume (`home-refresh.ts:1-2`, `home-refresh.ts:9-14`).
- Home poll is registered only while `screen === 'home'` (`MobileApp.tsx:96-117`). Chat uses its own 10 s interval; navigating home clears the chat effect (`MobileChat.tsx:73-91`).
- On true resume, home forces `refreshFromVm({ roster: true })` (`MobileApp.tsx:107-110`). **Open chat does not** re-`getMessages` on visibility — it waits for the next 10 s tick (or remount).
- OS/WebView timer throttling while locked/backgrounded is not handled in app code; intervals may stretch beyond the constants. `MobileHome` freezes orb focus when inactive (`MobileHome.tsx:119-133`) but keeps DOM; that does not refresh transcript.
- Desktop uses `window` `focus` as an extra sync trigger (`App.tsx:374-375`); phone has no equivalent for the open-thread poll.

## Defects (numbered, path:line)

1. **No idle SSE fan-out.** Other device never subscribes to `/events` from the open-thread poll path; only `followTurnByState` JSON snapshots every 1250 ms after a slow discovery poll (`MobileChat.tsx:16`, `hermes-deploy-transport.ts:934-948`, `hermes-deploy-transport.ts:897-923`).
2. **Asymmetric discovery intervals.** Phone open chat 10 s vs desktop open chat 15 s (`MobileChat.tsx:16` vs `App.tsx:372`) — phone→desktop open-thread worst case is worse than desktop→phone.
3. **Recurring polls disable `followLive`.** Home and desktop sync pass `followLive: false`, skipping `attachTurn` SSE resume for `inFlightTurnId` (`MobileApp.tsx:46`, `App.tsx:360`, `hermes-deploy-transport.ts:848-875`).
4. **Home preview keep-local blocks remote snippets.** `existing.preview || row.preview` never replaces a set local preview (`hermes-deploy-transport.ts:782-783`); plus snapshot on back (`home-refresh.ts:17-21`) → home list can stay stale while an open chat is streaming on the other device.
5. **liveAlready is local-only.** Cross-device double-send race until hydration (`hermes-deploy-transport.ts:1086-1097`; discovery up to 10–15 s).
6. **Persist cannot carry partial bubbles.** `streaming: false`-only persist (`store.ts:105`) + settle on save (`persist.ts:129-131`) — by design for reload UX (`persist-settle.test.ts:143-163`), but means reload mid-stream on the *same* device also loses “live” and must re-hydrate from server.
7. **Open-chat no visibility refresh.** Background → foreground while in `MobileChat` does not call `getMessages` (`MobileChat.tsx:73-91` vs home’s `visibilityBecameVisible` at `MobileApp.tsx:107-110`).
8. **Group threads skip cloud hydrate.** `getMessages` returns local-only for `target.type === 'group'` (`hermes-deploy-transport.ts:935-936`) — cross-device group token sync is broken on that path.
9. **Overlapping `getMessages` while following.** Interval keeps firing during `followTurnByState` (up to 15 min, `hermes-deploy-transport.ts:89`); `attaching` short-circuits follow (`hermes-deploy-transport.ts:903`) but still re-runs `hydrateSessionTurns` every tick (`hermes-deploy-transport.ts:942`).

## Ranked improvements (P0/P1/P2)

**P0 — Subscribe `/events` while the thread is open.**
When `getMessages` (or open-chat effect) sees `pending`/`streaming`, call `attachTurn(..., { follow: true })` (or `consumeWithReattach` via `eventsUrl`) instead of only `followTurnByState`. Keep state poll as 410/fallback (already commented at `hermes-deploy-transport.ts:1227-1229`). Cuts ongoing token latency from **1250 ms** snapshots toward SSE frame latency; discovery still gated by the open-thread interval unless you also push.

**P0 — Server-side busy / single-flight per session.**
Reject or queue a second `POST /api/chat` for the same `sessionId` while a turn is streaming, so `liveAlready` is not a local guess (`hermes-deploy-transport.ts:1086-1097`).

**P1 — Lower or event-driven discovery.**
- Replace 10 s open-thread poll with long-poll / SSE on conversation or instance (`MobileChat.tsx:16`).
- Align desktop open-thread cadence with phone (or share one helper) (`App.tsx:372`).
- On `visibilityBecameVisible` while `screen === 'chat'`, immediately `getMessages` (mirror `MobileApp.tsx:107-110`).

**P1 — Home preview truth.**
When `followLive` is false, still update preview from server if `row.updatedAt`/`lastUsedAt` is newer; or show an explicit “live” affordance from `inFlightTurnId` without attaching (`hermes-deploy-transport.ts:782-783`, `hermes-deploy-transport.ts:838-844`).

**P2 — Optional `followLive: true` on a slow home cadence** for `inFlightTurnId` attach, or a dedicated “sync live turns” pass separate from preview merge (`hermes-deploy-transport.ts:848-875`).

**P2 — Group `getMessages`** should hydrate member sessions or room state the same way as agent threads (`hermes-deploy-transport.ts:935-936`).

## Expert re-read / defect hunt notes

- Pass 1 mapped topology and constants (10_000 / 15_000 / 1_250 / 800 / 15 min).
- Pass 2 confirmed persist never shares partial streaming bubbles across devices; only `/api/chat/state` can.
- Pass 3 confirmed no idle websocket fan-out; `/events` exists but is sender/`followLive` attach only.
- Pass 4: busiest footguns are preview keep-local, `followLive: false` on recurring sync, local `liveAlready`, and open-chat missing resume refresh.

## What I did not verify

- Whether the deploy backend writes incremental `assistantContent` on `/api/chat/state` during streaming (code assumes yes at `hermes-deploy-transport.ts:1042-1047`; not exercised against a live server here).
- Exact WebView timer throttling quanta on lock screen / Doze.
- Electron non-deploy modes (local `hermes serve` / mock): those do **not** share Postgres turns with the phone (`active-transport.ts:7-12`, `App.tsx:358` early-return unless `HermesDeployTransport`).
- End-to-end dual-device timing with wall clock (latencies above are from source constants only).
- Push notifications / FCM for completed turns (not present in the cited mobile poll paths).
