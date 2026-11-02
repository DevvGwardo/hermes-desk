# Real-time chat: desktop vs Android — synthesis

Parent integration of L1–L5 (Grok 4.5). Numbers re-measured 2026-08-18.

**Do first:** attach `/events` on the *follower* device (open thread) and
clear `streaming` on 410. That is the live-feel gap. Paint polish is second.

## How it actually works

Same Vite `ChatPanel` paints tokens on desktop and Android. Android is an
empty Capacitor `BridgeActivity` + WebView — no Kotlin renderer
(`L2`, `MainActivity.java:3-5`).

| Role | Path | Live feel |
|---|---|---|
| Device that sent | POST `/api/chat` SSE (deploy) or hermes WS/SSE (local) | Token-by-token, rAF-coalesced |
| Other device, open chat | Poll `getMessages` then `followTurnByState` | Discover in **10s** (phone) / **15s** (desktop), then **1250ms** snapshots |
| Other device, home/sidebar | `listConversations({ followLive: false })` | **15s**, often no preview text |

There is **no** idle SSE/WebSocket fan-out. Persist is localStorage only
and strips `streaming` before write (`store.ts:105`, `persist.ts:129-131`).
Partial text on the other device exists only if `/api/chat/state` already
has `assistantContent`.

## STATE.md verdicts (re-checked)

| Lesson | Verdict |
|---|---|
| Double bubble (`msg_*` vs turn id) | Past bug, **fixed** via `rebindMessageId` + `X-Hermes-Turn-Id`. Residual if header missing or group “any streaming” fallback (`L3`). |
| Clean POST close without `id:` reprints tokens | Past bug, **fixed** in `consumeWithReattach`. Residual: fresh `attachTurn(..., 0)` can append onto already-hydrated text (`L3`). |
| No second `HermesDeployTransport` in MobileApp | **Obeyed.** Singleton `getActiveTransport()` (`L2`, `L3`). |
| `raceTimeout` without `nubChatAbort` | Primitive still unsafe; current `streamViaNubBridge` **does** abort (`L4`). |
| “Still working on your last one” | Deploy + mock only. **Missing** on local `HermesServeTransport` (`L4`). Local-store only — not a server lock (`L5`). |

## Ranked improvements

Do-now (must):

- **P0** Follower SSE: when open-thread `getMessages` sees `pending|streaming`, call `attachTurn(..., { follow: true })` instead of only `followTurnByState`. Files: `hermes-deploy-transport.ts:946-948`, `MobileChat.tsx:73-91`. Cuts follower paint from 1250ms snapshots to token SSE. Keep state poll as 410 fallback.
- **P0** Discovery + resume: poll open thread every 2–3s when not locally streaming; on `visibilityBecameVisible` immediately `getMessages`. Files: `MobileChat.tsx:16`, `MobileApp.tsx:106-111` (home already does this).
- **P0** `attachTurn` 410/404: `reattachBody` null currently `return`s with `streaming: true` (`hermes-deploy-transport.ts:711-712`). Clear streaming (mirror `followTurnByState` finally at `:927-930`) or the caret/busy-gate sticks forever.
- **P0** `attachTurn` from event id 0 must not append onto non-empty content (`hermes-deploy-transport.ts:711`, `:440-442`). Track last event id per turn, or replace/skip.
- **P0** `appendMessageContent` in `store.ts` so hermes/mock stop store-read-then-replace (drops tokens in one rAF). Deploy already accumulates locally (`hermes-deploy-transport.ts:440-442`). `hermes-transport.ts:265-267` is the hole.

Later (nice):

- **P1** Honor unused `streaming` on `MessageBody` (`MessageBody.tsx:197-211`): plain prewrap while live, markdown once. Stops fence flicker.
- **P1** Stick-to-bottom gate in `ChatPanel.tsx:1073-1114` — do not `scrollTop = scrollHeight` if the user scrolled up.
- **P1** `liveAlready` on `HermesServeTransport.sendMessage` (`hermes-transport.ts:868-904`) — same busy string as mock/deploy.
- **P1** Server-side single-flight per session so two devices cannot both POST (`L5` race until 10–15s hydrate).
- **P1** Align Capacitor `Keyboard.resize: 'none'` with Android `adjustResize` (`capacitor.config.ts:13` vs `AndroidManifest.xml:19`).
- **P1** Idle (not 120s wall) budget on `nubChatStream`; only `markAlive` on real delta/tool (`L4`).
- **P1** `findBoundAssistant` must key group bubbles by `fromAgentId` (`hermes-deploy-transport.ts:281-287`).
- **P2** Home preview `existing.preview \|\| row.preview` never updates (`hermes-deploy-transport.ts:782-783`).
- **P2** Group `getMessages` returns local-only (`hermes-deploy-transport.ts:935-936`) — cross-device group chat is blind.
- **P2** Collapse ChatPanel double-rAF scroll; move caret into MessageBody; quarantine unused `deploy-client` `sendChat`.
- **P2** Visible copy on `settleHungStream` silent timeout (`hermes-transport.ts:747-757`).

## What is already fine

1. Same `ChatPanel` + rAF `patchMessage` (no mid-stream persist).
2. Local sender SSE is real-time on both shells.
3. Singleton deploy transport (no second client).
4. Historical double-bubble and no-id replay guards are in and tested.

## Slice order (if we implement next)

1. `attachTurn` 410 + no-replay-from-0 (L3 P0) — ~1 hour, tests already in `hermes-deploy-transport.test.ts`.
2. Open-thread `attachTurn` + visibility tick (L2/L5 P0) — ~2 hours.
3. `appendMessageContent` + serve `liveAlready` (L1/L4 P0) — ~2 hours.
4. MessageBody streaming mode + stick-to-bottom (L1 P1) — ~2 hours.
5. Server single-flight (needs hermes-deploy) — afternoon.

Leaf reports: `docs/realtime-chat/L1-desktop-render.md` … `L5-cross-device.md`.

## Parent verification

- Re-ran leaf CHECKs: 15/15 MET (`gate-check.mjs --status` on L1–L5).
- Line counts: L1 123, L2 199, L3 303, L4 262, L5 109 (all ≥80).
- Citation counts: L1 22, L2 28, L3 45, L4 55, L5 28.
- Spot-checked in source: unused `streaming` prop (`MessageBody.tsx:204` not in destructure); `attachTurn` early return at `:712`; store-read delta at `hermes-transport.ts:265-267`; poll 10_000 / 15_000 / 1250; group `getMessages` short-circuit `:936`.
