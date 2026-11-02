# L1 Desktop stream render

## What I opened (file count)

Opened **14** files for this leaf (read-only):

1. `src/components/ChatPanel.tsx` — bubble list, streaming-caret, scroll pin, `streamActive`
2. `src/components/MessageBody.tsx` — markdown / plain paint, memo, unused `streaming` prop
3. `src/lib/agents/store.ts` — `patchMessage`, rAF coalesce, urgent flush, persist flag
4. `src/lib/agents/persist.ts` — `schedulePersist` 800ms debounce, settle-before-write
5. `src/lib/agents/useAgentRuntime.ts` — `useSyncExternalStore` → `runtime.messages`
6. `src/lib/agents/hermes-transport.ts` — `message.delta` / `onDelta` content append
7. `src/lib/agents/hermes-deploy-transport.ts` — local `content += delta` (safe path)
8. `src/lib/agents/mock-transport.ts` — store-read-on-delta (same hazard as hermes)
9. `src/lib/agents/tool-activity.ts` — `liveActivityFromMessages` Working… / Typing…
10. `src/lib/agents/__tests__/store.test.ts` — rAF coalesce notify tests
11. `src/components/__tests__/message-body.test.tsx` — markdown / plain / fence paint
12. `src/components/__tests__/tool-call-rendering.test.tsx` — empty stream + caret
13. `src/components/__tests__/chat-find.test.tsx` — `scrollIntoView` for find only
14. `src/index.css` — `.streaming-caret` / `caret-blink` keyframes

Also skimmed `project-artifact-scroll.test.tsx` (scroll container shape) and `App.tsx` ChatPanel wiring.

## How tokens become pixels

### Architecture (store → React → DOM)

```
SSE / mock onDelta
  → patchMessage(threadId, id, { content })     // store.ts
  → requestAnimationFrame coalesce (~1 notify/frame)
  → setState({ messagesByThreadId }, { persist: false })
  → useSyncExternalStore(subscribe, getState)   // useAgentRuntime.ts
  → runtime.messages → <ChatPanel messages=…>
  → map key={m.id} → memo Bubble → MessageBody(content)
  → ReactMarkdown(remarkGfm) → .nub-md DOM
  → sibling <span class="streaming-caret"> while msg.streaming
  → ChatPanel scroll effect: double-rAF → scrollTop = scrollHeight when streamActive
```

### Data path with evidence

1. **Coalesce.** Token patches land in `pendingMsgPatches` and schedule one `requestAnimationFrame(applyPendingMessagePatches)` unless urgent (`streaming === false` or `toolEvents` present). See `src/lib/agents/store.ts:146-168`. Batch apply notifies listeners once per frame and sets `persist` only when some patch carries `streaming: false` (`src/lib/agents/store.ts:100-127`).

2. **Subscribe.** `useAgentRuntime` binds the whole agents store via `useSyncExternalStore(subscribe, getState, getState)` (`src/lib/agents/useAgentRuntime.ts:99`). Selected thread messages are sliced at `src/lib/agents/useAgentRuntime.ts:167-170` and passed into ChatPanel from `App.tsx`.

3. **List keys / empty stream.** Rows use stable `key={m.id}` (`src/components/ChatPanel.tsx:1348`). A bubble is kept alive while `m.streaming` even if `content` is empty (`src/components/ChatPanel.tsx:1337-1342`). Tests assert the empty streaming bubble still paints a caret (`src/components/__tests__/tool-call-rendering.test.tsx:132-136`).

4. **MessageBody paint.** Agent bubbles call `<MessageBody … variant="markdown" streaming={msg.streaming} />` (`src/components/ChatPanel.tsx:531-535`). `MessageBody` is `memo`, but returns `null` when `!content` (`src/components/MessageBody.tsx:197-211`) and **never reads** the `streaming` prop — markdown always goes through full `ReactMarkdown` (`src/components/MessageBody.tsx:188-194`).

5. **Caret.** While `msg.streaming`, Bubble appends `<span className="streaming-caret" />` after the body (`src/components/ChatPanel.tsx:537`). CSS blinks it at 0.9s steps (`src/index.css:278-297`).

6. **Scroll.** `streamActive = Boolean(sending || lastMessage?.streaming)` (`src/components/ChatPanel.tsx:1017`). On every `messages` (and related) change, a double-`requestAnimationFrame` pins the transcript: hard `scrollTop = scrollHeight` while streaming, smooth `scrollTo` otherwise (`src/components/ChatPanel.tsx:1073-1114`). Find/focus paths use `scrollIntoView` (`src/components/ChatPanel.tsx:1006`, `:1064`); stream pin deliberately avoids `scrollIntoView` so ancestors are not yanked (`src/components/ChatPanel.tsx:1077-1078`).

7. **Activity line.** `liveActivityFromMessages` shows `Working…` until the first non-empty streamed content, then `Typing…` (`src/lib/agents/tool-activity.ts:376-380`). Held 800ms across rapid tool hops (`src/lib/agents/tool-activity.ts:383-414`).

8. **60fps vs rAF.** Ideal paint rate is one store notify ≈ one React commit per display frame (~60fps), not one commit per SSE token. That matches the store contract (`src/lib/agents/store.ts:150-152`) and the coalesce test (`src/lib/agents/__tests__/store.test.ts:250-272`). Persist I/O is **not** on that path mid-stream: token batches pass `{ persist: false }` (`src/lib/agents/store.ts:106,127`). Disk write happens on `streaming: false` (debounced 800ms via `schedulePersist`, `src/lib/agents/persist.ts:152-160`) and always settles in-flight flags before stringify (`src/lib/agents/persist.ts:128-134`).

9. **Transport variance.** Deploy transport accumulates safely with a local `content += delta` then patches the full string (`src/lib/agents/hermes-deploy-transport.ts:440-442`). Hermes serve / mock read **applied** store content for each delta (`src/lib/agents/hermes-transport.ts:266-267`, `:1016-1019`; `src/lib/agents/mock-transport.ts:277-279`), which interacts badly with rAF coalesce (defect 1).

### React commit cost (implied)

| Stage | Per token burst (one frame) | Cost |
|---|---|---|
| `patchMessage` | merge into pending map | cheap |
| rAF flush | 1 `setState` + N listeners | one notify |
| `useAgentRuntime` | new `state` identity | App re-render |
| ChatPanel | new `messages` array | full map walk |
| Bubble (`memo`) | only patched msg new identity | skip siblings |
| MessageBody | new `content` string | remount markdown tree |
| ReactMarkdown | full GFM reparse | **dominant** |
| Scroll effect | double-rAF + snap | fights user scroll-up |

So coalesce correctly caps **store notifies** at ~60/s, but each notify still pays a **full markdown remount** for the live bubble. There is no incremental AST, no plain-text streaming fallback, and no stick-to-bottom gate.

## Defects (numbered, each with path:line)

1. **rAF coalesce drops multi-delta content when transport reads the store.** `patchMessage` merges patches with object spread (`src/lib/agents/store.ts:156-160`), so a later `{ content }` replaces an earlier pending `{ content }`. Hermes/mock compute that string from `getMessagesForConversation` **before** the rAF apply (`src/lib/agents/hermes-transport.ts:266-267`, `src/lib/agents/mock-transport.ts:277-279`). Two deltas in one frame → second overwrite loses the first token(s). Deploy path avoids this via local accumulate (`src/lib/agents/hermes-deploy-transport.ts:440-442`).

2. **Every painted delta remounts markdown.** `MessageBody` always routes agent content through `ReactMarkdown` (`src/components/MessageBody.tsx:208-209`, `:188-194`). The accepted `streaming?: boolean` prop is unused (`src/components/MessageBody.tsx:197-211`), so there is no plain-prewrap / deferred-parse mode while the fence is incomplete. Incomplete ``` fences during stream flip tree shape → visible markdown flicker.

3. **Scroll fights the user.** Stream pin runs whenever `messages` changes and `streamActive` is true, unconditionally setting `scrollTop = scrollHeight` (`src/components/ChatPanel.tsx:1073-1085`, deps `:1101-1114`). There is no near-bottom / user-scrolled-away check anywhere in `src/`.

4. **Double-rAF scroll lag on top of rAF coalesce.** Tokens already wait one animation frame in the store (`src/lib/agents/store.ts:166-167`). ChatPanel then schedules **two** more rAFs before pinning (`src/components/ChatPanel.tsx:1093-1096`). First-token and follow-up paints can feel ~1–2 frames late relative to the store notify; first content also flips activity Working… → Typing… (`src/lib/agents/tool-activity.ts:376-380`).

5. **Empty stream body is intentionally blank until first token.** `MessageBody` returns `null` for empty content (`src/components/MessageBody.tsx:207`), so the bubble is caret-only until the first applied delta. That matches the empty-stream test (`src/components/__tests__/tool-call-rendering.test.tsx:132-136`) but means first-token layout jumps from caret-only → full `.nub-md` block.

6. **Caret is outside MessageBody and tied only to `msg.streaming`.** Caret mounts/unmounts with the flag (`src/components/ChatPanel.tsx:537`). End-of-stream removes it in the same commit as the final markdown pass — a one-frame caret flicker / jump is likely when `streaming: false` flushes urgently (`src/lib/agents/store.ts:146-147`, `:161-163`).

7. **Memo holes above the bubble.** `Bubble` / `MessageBody` memo help (`src/components/ChatPanel.tsx:433`, `src/components/MessageBody.tsx:197`), and unpatched message object identities are preserved by the map (`src/lib/agents/store.ts:120-123`). But each stream frame still recomputes `projectArtifacts`, `artifactAfterIndex`, `liveActivityFromMessages`, and `findHits` from the full `messages` array (`src/components/ChatPanel.tsx:789-796`, `:870`, `:1019-1020`). `ChatPanel` itself re-renders every notify because `messages` is a new array reference (`src/lib/agents/useAgentRuntime.ts:167-170`).

8. **Urgent `toolEvents` flush amplifies defect 1.** Any tool patch flushes the pending map immediately (`src/lib/agents/store.ts:147`, `:161-163`). If pending content was already wrong from overwrite, the tool chip flush **commits** the truncated string to applied state before more deltas arrive.

9. **Persist is correct for tokens, but unrelated `setState` still JSON-stringifies the whole store.** Mid-stream token batches skip persist (`src/lib/agents/store.ts:106`). `schedulePersist` still runs for other mutations (append placeholder, touch conversation, etc.) with an 800ms debounce (`src/lib/agents/persist.ts:152-160`). Not a mid-token write, but a large stringify can still hitch the main thread if something else mutates during a long stream.

10. **Find `scrollIntoView` can race stream pin.** Find/focus set `highlightMessageId` and call `scrollIntoView` (`src/components/ChatPanel.tsx:999-1008`, `:1058-1071`). The stream pin effect bails while those ids are set (`src/components/ChatPanel.tsx:1076`), which is good — but clearing highlight after 1600ms (`:1068-1069`) re-enables pin while `streamActive` may still be true, yanking the user back to the bottom.

## Ranked improvements (P0/P1/P2)

Improvements this leaf can own later (ChatPanel / MessageBody / store paint path — not mobile):

### P0
1. **`patchMessage` content-append API (or pending-aware read).** Prefer `appendMessageContent(threadId, id, delta)` that concatenates onto pending-or-applied content inside `store.ts`, and migrate hermes/mock `onDelta` call sites off store-read-then-replace. Keeps rAF coalesce without dropping tokens. Mirror deploy’s local accumulate (`hermes-deploy-transport.ts:440-442`) into the store so all transports share one correct path.
2. **Stick-to-bottom gate in ChatPanel scroll effect.** Track `listRef` distance-from-bottom; only run `snap()` / `scrollTo` when the user was already near the bottom (or just sent). Stop fighting scroll-up during `streamActive` (`ChatPanel.tsx:1073-1114`).

### P1
3. **Honor `streaming` in `MessageBody`.** While `streaming === true`, render plain `whitespace-pre-wrap` (or a cheap incremental renderer); switch to `ReactMarkdown` once on `streaming: false`. Kills mid-stream markdown remount / fence flicker (`MessageBody.tsx:197-211`).
4. **Collapse scroll scheduling to one rAF (or layout effect).** Drop the double-`requestAnimationFrame` nest (`ChatPanel.tsx:1093-1096`) now that the store already coalesces per frame.
5. **Move caret into `MessageBody` trailing slot** so empty→first-token and stream-end share one layout box; optional short opacity hold after `streaming` clears to avoid caret flicker (`ChatPanel.tsx:537`, `index.css:278-297`).

### P2
6. **Narrow ChatPanel stream subscriptions.** Pass a stable `messages` selector / split streaming tail so artifact derivation and find index do not rerun on every token (`ChatPanel.tsx:789-796`, `:870`).
7. **Fence-aware markdown:** if staying on ReactMarkdown mid-stream, buffer incomplete fences as plain text until closed to avoid remount thrash in `FencedCode` (`MessageBody.tsx:73-94`, `:188-194`).
8. **Regression tests:** extend `store.test.ts` coalesce suite with two deltas same frame asserting concatenation; add ChatPanel scroll test that simulates user `scrollTop` up during `streamActive` and expects no snap.

## What I did not verify

- Runtime FPS / Chrome performance traces on a real long SSE (reasoning only from code + unit tests).
- Whether hermes-serve ever emits >1 `message.delta` per animation frame in production (defect 1 severity depends on that rate).
- Android Capacitor paint (out of scope; same Vite bundle but not owned by L1).
- Electron main-process jank during `localStorage.setItem` of a large settled store.
- Visual caret / markdown flicker on a physical display (inferred from remount + CSS, not screen-recorded).
- Whether `flushMessagePatches` is always called on transport abort paths for every backend.
