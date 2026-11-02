# L2 Android / mobile chat surface

## What I opened

- `src/mobile/MobileChat.tsx` — open-thread shell; reuses desktop `ChatPanel`; polls `getMessages` every `OPEN_THREAD_POLL_MS = 10_000`.
- `src/mobile/MobileApp.tsx` — phone router; `openConversation` / send via `runtime.handleSend` + `getActiveTransport()` singleton.
- `src/mobile/deploy-client.ts` — pairing + thin `/api/chat` helpers; **not** the MobileChat send path.
- `src/mobile/session.ts`, `native-app.ts`, `home-refresh.ts`, `keyboard-inset.ts`.
- `src/main.tsx`, `src/lib/platform.ts` — Capacitor / ≤720px selects `MobileApp`.
- `src/lib/agents/active-transport.ts`, `hermes-deploy-transport.ts`, `useAgentRuntime.ts`.
- `src/App.tsx`, `src/components/TopBar.tsx`, `src/components/ChatPanel.tsx` — desktop live chrome comparison.
- `capacitor.config.ts`, `android/app/src/main/` (`MainActivity.java`, `AndroidManifest.xml`, `activity_main.xml`, `styles.xml`, baked `capacitor.config.json`).
- `STATE.md` singleton rule for `HermesDeployTransport`.

**Confirmed:** Android is Capacitor wrapping the same Vite app. There is **no** separate Kotlin chat renderer. `MainActivity` is an empty `BridgeActivity` (`android/app/src/main/java/com/maiavm/nub/MainActivity.java:3-5`); layout is a single WebView (`android/app/src/main/res/layout/activity_main.xml:10-14`); zero `.kt` files under `android/`. Native Capacitor and browser ≤720px both mount `MobileApp` (`src/main.tsx:26`, `src/lib/platform.ts:1-26`).

## How Android shows a live reply

### Boot / shell selection

1. Root picks phone shell when `isPhoneShell()` (`src/main.tsx:14-26`).
2. Phone also runs `lockPhoneViewport()` so `--vv-*` CSS vars track the visual viewport (`src/main.tsx:22-25`, `src/mobile/keyboard-inset.ts:49-76`).
3. `.nub-mobile` is `position: fixed` sized to those vars (`src/mobile/mobile.css:31-41`).

### Open a thread (hydrate)

1. Home row → `openConversation(id)` → `handleSelect` + `setScreen('chat')` + `followThread(id)` (`src/mobile/MobileApp.tsx:181-187`).
2. `followThread` calls `getActiveTransport()` then `transport.getMessages(conversationId)` once (`src/mobile/MobileApp.tsx:157-167`).
3. `MobileChat` mounts shared `ChatPanel` with `onSend={props.onSend ?? runtime.handleSend}` (`src/mobile/MobileChat.tsx:147-167`).

### Local send (token stream)

1. Composer → `runtime.handleSend` (`src/lib/agents/useAgentRuntime.ts:329-361`).
2. `handleSend` resolves **the singleton** `{ transport } = await getActiveTransport()` — never `new HermesDeployTransport` (`src/lib/agents/useAgentRuntime.ts:355`, `src/lib/agents/active-transport.ts:178-199`). Matches `STATE.md`: do not construct a second deploy transport.
3. `HermesDeployTransport.sendMessage` → `runCubeTurn`: `beginLiveStream`, POST `/api/chat` with `stream: true`, consume SSE into one bubble bound to `X-Hermes-Turn-Id` (`src/lib/agents/hermes-deploy-transport.ts:1057-1238`).
4. While `hasLiveStream`, open-thread `getMessages` returns local store and does **not** state-hydrate (avoids second bubble) (`src/lib/agents/hermes-deploy-transport.ts:934-940`).
5. `ChatPanel` pins transcript `scrollTop` while `streamActive` (`src/components/ChatPanel.tsx:1017-1085`).
6. Header: `FatCatIcon still={!live}` + `chromeStatusLine` from `liveConversationIds` / sending / VM busy (`src/mobile/MobileChat.tsx:39-55`, `131-141`).

### Remote / cross-device reply (desktop started the turn)

1. `MobileChat` effect: immediate `getMessages` + `setInterval(..., OPEN_THREAD_POLL_MS)` where **`OPEN_THREAD_POLL_MS = 10_000`** (`src/mobile/MobileChat.tsx:16`, `73-91`).
2. Comment claims `getMessages` “also follows an in-flight turn” (`src/mobile/MobileChat.tsx:71-72`) — **true**: deploy `getMessages` hydrates turns, and if status is `pending`/`streaming` it `await`s `followTurnByState` (`src/lib/agents/hermes-deploy-transport.ts:941-948`).
3. `followTurnByState` polls turn state every **`STATE_POLL_MS = 1250`**, not token SSE (`src/lib/agents/hermes-deploy-transport.ts:88-89`, `906-922`). SSE `attachTurn` / `reattachBody` is used by local send / `listConversations({ followLive: true })`, not by this open-thread path.
4. Home list poll (`HOME_CONV_POLL_MS = 15_000`) runs only while `screen === 'home'` with `followLive: false` (`src/mobile/home-refresh.ts:7`, `src/mobile/MobileApp.tsx:96-105`, `41-46`) — **paused while chatting**.

### Pairing vs chat HTTP

`deploy-client.ts` exposes `sendChat` / `attachRunEvents` / `getChatState` (`src/mobile/deploy-client.ts:191-314`) but MobileChat/MobileApp live path does not import them. Pairing UI uses `startDesktopAuth` / `pollDesktopAuth` only. Chat traffic goes through `HermesDeployTransport` via `getActiveTransport()`.

### Capacitor / WebView surface

| Setting | Value | Path |
|---|---|---|
| `webDir` | `dist` (same Vite build) | `capacitor.config.ts:4` |
| `androidScheme` | `https` | `capacitor.config.ts:6` |
| `allowMixedContent` | `false` | `capacitor.config.ts:9` |
| Keyboard plugin `resize` | `'none'` | `capacitor.config.ts:13-14` |
| StatusBar overlays WebView | `false` | `capacitor.config.ts:18` |
| Soft input mode | `adjustResize` | `AndroidManifest.xml:19` |
| Native activity | empty `BridgeActivity` | `MainActivity.java:3-5` |

No custom WebView SSE / keep-alive / mixed-content overrides in Java — stock Capacitor Bridge.

## Desktop vs phone differences (table)

| Concern | Desktop (`App.tsx`) | Phone (`MobileApp` / `MobileChat`) |
|---|---|---|
| Shell | 3-column Electron chrome | Capacitor WebView / ≤720px `MobileApp` (`src/main.tsx:26`) |
| Chat renderer | `ChatPanel` | **Same** `ChatPanel` (`src/mobile/MobileChat.tsx:147`) |
| Send transport | `getActiveTransport()` singleton | Same singleton (`useAgentRuntime.ts:355`; `STATE.md`) |
| Open-thread poll | 15s + `getMessages(openId)` (`App.tsx:361-372`) | **10s** `OPEN_THREAD_POLL_MS` (`MobileChat.tsx:16`, `87`) |
| List poll while in chat | Always (App mount effect) | **No** — home interval only when `screen === 'home'` (`MobileApp.tsx:96-105`) |
| Resume hydrate | `window` `focus` refresh (`App.tsx:374-375`) | Home: `visibilityBecameVisible` (`MobileApp.tsx:106-111`); **chat: none** |
| Live FatCat | `TopBar` `still={!live}` (`TopBar.tsx:51-56`) | `still={!live}` (`MobileChat.tsx:131-132`) |
| `statusLine` | `chromeStatusLine` + idle agent/group summary (`App.tsx:874-880`) | Same helper; groups fall back to member count (`MobileChat.tsx:51-55`, `124-126`) |
| `liveConversationIds` | Sidebar + header live | Header live + home row dots (`MobileApp.tsx:273-274`) |
| Activity tool `where` | `resolveToolWhere` (`App.tsx:859-866`) | Hardcoded `'vm'` (`MobileChat.tsx:47-49`) |
| Keyboard | OS window chrome | `lockPhoneViewport` + Capacitor Keyboard `resize: 'none'` + manifest `adjustResize` |
| Background | Electron focus | WebView timers freeze; only home resumes on visible |

## Defects (numbered, path:line)

1. **P0 — Up-to-10s gap before a remote in-flight turn is discovered.** Open thread only polls every `10_000` ms (`src/mobile/MobileChat.tsx:16`, `87`). Desktop/other-device tokens can stream for nearly 10s before phone `getMessages` notices `inFlightTurnId`.

2. **P0 — Chat has no resume hydrate on Capacitor pause → visible.** Home listens for hidden→visible (`src/mobile/MobileApp.tsx:106-111`, `src/mobile/home-refresh.ts:1-15`). `MobileChat` interval ignores visibility (`src/mobile/MobileChat.tsx:73-91`). After Android freezes the WebView, the next chat refresh can wait another full 10s. `native-app.ts` never subscribes to `appStateChange` / pause / resume — only pairing URL + back button (`src/mobile/native-app.ts:38-72`).

3. **P1 — Remote follow uses state poll (1.25s), not SSE.** Once discovered, `getMessages` → `followTurnByState` (`src/lib/agents/hermes-deploy-transport.ts:946-948`, `906-922`). Local send gets true SSE deltas (`hermes-deploy-transport.ts:1205-1207`). Phone watching a desktop-started turn sees chunky 1.25s snapshots, not token stream.

4. **P1 — `getMessages` while following blocks the poll tick for the whole turn.** `followTurnByState` can run up to `STATE_POLL_MAX_MS = 15 * 60 * 1000` (`hermes-deploy-transport.ts:88-89`, `906`). MobileChat `await`s that inside the interval callback (`MobileChat.tsx:77-80`). Overlapping ticks rely on `attaching` dedupe; first tick stays stuck in the await.

5. **P1 — IME / viewport conflict risk covering the streaming bubble.** Capacitor Keyboard `resize: 'none'` (`capacitor.config.ts:13-14`) vs Android `windowSoftInputMode="adjustResize"` (`AndroidManifest.xml:19`). Shell trusts `visualViewport` (`keyboard-inset.ts:52-55`, `mobile.css:38-41`). If VV events lag or double-resize fights, composer + trailing stream can sit under the IME even though `ChatPanel` pins scroll (`ChatPanel.tsx:1073-1085`).

6. **P1 — WebView SSE longevity unhardened.** No Java WebView tweaks beyond stock Bridge (`MainActivity.java:5`). Long `fetch` SSE (`reattachBody` / `consumeIntoMessage`, `hermes-deploy-transport.ts:412-421`, `424-471`) can die when Android backgrounds the activity; there is no chat-level reattach-on-resume.

7. **P2 — While chatting, conversation-list live flags go stale.** Home poll stopped off-home (`MobileApp.tsx:96`); open-thread poll does not update other conversations’ `inFlightTurnId` / `liveConversationIds` from list rows.

8. **P2 — `deploy-client` parallel chat API is a footgun.** Unused by MobileChat today, but `sendChat` / `attachRunEvents` (`deploy-client.ts:271-314`) could tempt a second transport path contradicting `STATE.md` / `active-transport.ts:21-22`.

9. **P2 — Activity `where: 'vm'` on phone vs resolved deploy/serve on desktop** (`MobileChat.tsx:47-49` vs `App.tsx:859-866`) — live verb copy can disagree across surfaces.

10. **P2 — Hydrate-on-open is best-effort only.** `followThread` swallows errors (`MobileApp.tsx:163-165`); empty thread stays empty until the 10s poll succeeds.

## Ranked improvements (P0/P1/P2)

### P0 (this leaf would own)

1. **Resume-on-visible for open thread.** Mirror home: on `visibilityBecameVisible` (and optionally Capacitor `appStateChange`), immediately `getActiveTransport().getMessages(selectedId)`. Keep the 10s interval as backup. Files: `MobileChat.tsx`, reuse `visibilityBecameVisible` from `home-refresh.ts`.

2. **Tighten discovery while a thread is open and not locally streaming.** e.g. poll every 2–3s when `!runtime.sending && !has local streaming message`, else 10s; or one-shot `listConversations({ followLive: true })` on open + resume to attach SSE for remote `inFlightTurnId`. Files: `MobileChat.tsx`; possibly call transport list with `followLive: true` only for the selected id.

### P1

3. **Prefer SSE attach for remote in-flight turns discovered on phone** — route open-thread follow through `attachTurn` / events stream (already used by `listConversations` followLive) instead of only `followTurnByState`, so tokens paint like a local send.

4. **Make `followTurnByState` non-blocking for pollers** — fire-and-forget follow from `getMessages` when caller is a refresh tick; return hydrated snapshot immediately so interval ticks do not serialize behind a 15‑minute await.

5. **Unify keyboard policy.** Pick one: Capacitor `Keyboard.resize: 'body'` **or** keep `none` + proven VV lock; align `windowSoftInputMode` (`adjustPan` vs `adjustResize`) with that choice; add a focused composer scroll test under IME.

6. **Reattach SSE on resume** after Capacitor pause if `message.streaming` and live stream ended uncleanly.

### P2

7. Keep a slow `listConversations({ followLive: false })` even on the chat screen so home live dots stay honest when user backs out.

8. Delete or quarantine unused `deploy-client` `sendChat`/`attachRunEvents` from the mobile chat mental model (pairing-only module).

9. Pass the same `resolveToolWhere` into MobileChat live activity as desktop.

## Concrete fix sketches

```ts
// MobileChat.tsx — resume + adaptive poll (sketch)
useEffect(() => {
  const conversationId = runtime.selectedConversation?.id
  if (!conversationId) return
  let cancelled = false
  const tick = async () => {
    try {
      const { transport } = await getActiveTransport()
      if (!cancelled) await transport.getMessages(conversationId)
    } catch { /* retry next tick */ }
  }
  void tick()
  const id = window.setInterval(() => void tick(), OPEN_THREAD_POLL_MS)
  let hidden = document.visibilityState === 'hidden'
  const onVis = () => {
    const next = visibilityBecameVisible(hidden, document.visibilityState)
    hidden = next.hidden
    if (next.becameVisible) void tick()
  }
  document.addEventListener('visibilitychange', onVis)
  return () => {
    cancelled = true
    window.clearInterval(id)
    document.removeEventListener('visibilitychange', onVis)
  }
}, [runtime.selectedConversation?.id])
```

```ts
// hermes-deploy-transport getMessages — do not await long follow on refresh
if (turn.status === 'pending' || turn.status === 'streaming') {
  void this.followTurnByState(conversationId, turn.id) // or attachTurn(..., { follow: true })
}
return getMessagesForConversation(conversationId)
```

```xml
<!-- AndroidManifest: align with Capacitor Keyboard resize:none + VV lock -->
android:windowSoftInputMode="adjustPan"
```

## Expert re-read (file:line evidence)

- Shared panel: `ChatPanel` import and render at `src/mobile/MobileChat.tsx:2`, `147-180`.
- Poll constant: `OPEN_THREAD_POLL_MS = 10_000` at `src/mobile/MobileChat.tsx:16`; interval at `:87`.
- getMessages follows in-flight: comment `:71-72`; implement `hermes-deploy-transport.ts:946-948`.
- Singleton send: `useAgentRuntime.ts:355` → `active-transport.ts:178-199`; MobileApp never `new HermesDeployTransport`; unlink resets via `resetActiveTransport()` (`MobileApp.tsx:200-203`, `292`).
- Capacitor wrap confirmed: `capacitor.config.ts:1-24`; empty Bridge `MainActivity.java:5`; WebView-only layout `activity_main.xml:10-14`.
- Background: chat poll has no visibility listener (`MobileChat.tsx:73-91`); home does (`MobileApp.tsx:106-116`).
- IME: `keyboard-inset.ts:49-76` + `mobile.css:38-41` + Keyboard `resize: 'none'` (`capacitor.config.ts:13`) vs `adjustResize` (`AndroidManifest.xml:19`).
- Live chrome parity: phone `still={!live}` `MobileChat.tsx:131-132`; desktop `TopBar.tsx:56`; both use `liveConversationIds` (`MobileChat.tsx:41`, `App.tsx:868-870`).

## Pass summary (four passes)

1. **Architecture report** — above sections (Capacitor WebView → MobileApp → MobileChat → shared ChatPanel → singleton HermesDeployTransport SSE for local; 10s getMessages + state follow for remote).
2. **Expert re-read** — citations in preceding section; singleton rule held; ChatPanel shared; OPEN_THREAD_POLL_MS measured at 10_000.
3. **Defect hunt** — 10s gap (#1), background freeze (#2), no second transport in MobileApp (good; deploy-client footgun #8), hydrate-on-open present but best-effort (#10), IME conflict (#5), WebView SSE (#6).
4. **Fix sketches** — resume tick, non-blocking follow / SSE attach, soft-input align.

## What I did not verify

- Runtime behavior on a physical Android device (IME covering stream, WebView SSE kill on pause, timer freeze duration).
- Whether Capacitor Keyboard plugin version ignores `adjustResize` in practice on API 34+.
- Server-side `/api/chat/state` latency vs `STATE_POLL_MS`.
- iOS Capacitor parity (out of Android leaf scope).
- Whether `listConversations({ followLive: true })` from phone would double-attach with an in-flight desktop SSE consumer.
- End-to-end cross-device timing with a stopwatch (claims are from code paths only).
