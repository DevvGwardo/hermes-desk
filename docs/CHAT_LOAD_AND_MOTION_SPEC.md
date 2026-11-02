# Spec: chat open, streaming, and mascot frame time

Status: proposed. Grounded in the tree as of 2026-09-21 (`0.1.18`).
Scope: desktop shell, hosted web shell, and the phone chat (`MobileChat`). Marketing studio, Loop Lab, and HUD click-to-act are out of scope except where they share the orb engine.

This document is an implementation spec. Each slice has a file target, a behavior change, a budget, and a check. Do the slices in order. Later slices assume earlier ones landed.

## 1. What the user should feel

1. Tapping a conversation paints the latest messages in under **150 ms** after the transcript bytes arrive, including threads of a few hundred turns.
2. While a reply is streaming, the activity mascot stays on the display refresh (60 Hz, or the panel refresh when it is higher). Scrolling the transcript does not stutter.
3. Opening Find, jumping to an old message, or loading earlier history does not freeze the mascot for a visible beat.
4. A chat that is merely open (no tokens arriving) does not wake the main thread on a timer.

## 2. Already shipped — do not redo

These are in the tree and working. The remaining hitch is beside them.

| Mechanism | Where | What it already does |
|---|---|---|
| Tail window | `ChatPanel.tsx` ~1360–1400, `WINDOW_CHUNK = 60` | First paint mounts the last 60 top-level rows. “Load earlier” grows by 60 and restores `scrollTop`. Measured note in that comment: 2,100 messages used to mount ~28k DOM nodes and take ~2.1 s. |
| Row memo | `TranscriptRow`, `Bubble`, `ConversationRow` | Streaming replaces one message object. Unchanged rows bail out if parent callbacks stay stable. |
| Token coalesce | `store.ts` `appendMessageContent` / `patchMessage` | Token deltas flush once per animation frame. `streaming: false` and tool chips flush immediately. |
| Plain text while live | `MessageBody.tsx` ~392–409 | A streaming bubble is one `whitespace-pre-wrap` paragraph. `react-markdown` runs only after `streaming` clears. Markdown is a separate chunk (`vite.config.ts` `manualChunks`). |
| Persist debounce | `persist.ts` `schedulePersist` | Full `localStorage` stringify waits 800 ms after the last store write, so a continuous token stream does not stringify every frame. Cap is 200 messages per thread. |
| Orb cost gate | `GrokOrb.tsx` ~224–305 | Each mark pauses when `IntersectionObserver` says it is offscreen, or when `prefers-reduced-motion` matches. |
| Idle sidebar freeze | `Sidebar.tsx` `sidebarOrbPaused` | Idle rows pass `still`. Every row freezes when the window is unfocused. Live rows keep animating. |
| Selection short-circuit | `useAgentRuntime.ts` ~432–451 | A thread that already has a user or agent message is not fetched again on select. |
| Single-flight fetch | `singleFlightTranscript` in deploy + serve paths | Concurrent `getMessages` callers share one HTTP request per session. |

`docs/ANIMATION_FLUENCY_GAP.md` describes the old `useBlobFx` React publish path (`FX_PUBLISH_MS = 40`). The product mascot no longer uses that hook. `FatCatIcon` renders `GrokOrb`, which mounts `vzt` from `src/lib/grok-orb/core.js` (~154 KB) and paints with `setAttribute` inside its own `requestAnimationFrame` (`core.js` ~1628). Treat the fluency-gap doc as historical. The live problem is **how many of those loops run, and what else the main thread does on the same frames**.

`useBlobFx` has no UI caller. Leave it until slice M4. Do not port it back onto the product mark.

## 3. Where time goes today

### 3.1 Opening a chat commits once per turn

Deploy (the production transport) loads history here:

```1455:1478:src/lib/agents/hermes-deploy-transport.ts
return singleFlightTranscript(`deploy-turns:${sessionId}`, async () => {
  // GET /api/chat/conversations
  for (const turn of turns) {
    if (!turn?.id) continue
    await this.applyTurnState(conversationId, { ...turn, status: ... }, opts)
  }
  return turns
})
```

`applyTurnState` (`hermes-deploy-transport.ts` ~1482) calls `appendMessage` or `patchMessage` per turn. Each of those calls `setState`, which notifies every store subscriber and arms `schedulePersist`. A 120-turn thread is ~120 React commits of `ChatPanel` before the windowed list is stable. The tail window only helps after those commits. The first frames still pay `threadGroups(messages)` and `deriveProjectArtifacts(messages, cwd)` on every intermediate array.

Serve / CLI hydrate is better: `tryServeTranscript` (`hermes-sessions.ts` ~471) writes the whole thread in **one** `setState`. Deploy and the 2.5 s phone poll do not.

Group rooms fan the same loop out per member session (`getMessages` ~1388–1407), in parallel, so N members means N commit storms overlapping.

### 3.2 An open chat keeps re-applying history

| Surface | Interval | Call |
|---|---|---|
| Phone `MobileChat.tsx` | `OPEN_THREAD_POLL_MS = 2500` | `transport.getMessages(conversationId)` always |
| Desktop / web `App.tsx` ~610–633 | 15 s, plus focus and visibility | same, for `selectedConversationId` |

`getMessages` on deploy does **not** return early when the thread is already hydrated. It only bails out while `hasLiveStream` is true. After the stream ends, the next poll walks every turn again. Settled turns hit the `patchMessage(..., { streaming: false, content })` branch (~1582) even when the bubble already matches. `patchMessage` treats `streaming: false` as urgent and flushes a store notify immediately.

The selection effect’s “skip if `hasReal`” guard does not cover these polls.

### 3.3 Every streamed frame still scans the whole transcript

Token flush is one store notify per frame. That notify changes the `messages` array identity, so `ChatPanel` recomputes:

- `threadGroups(messages)` (~1345) over every message, including rows outside the window.
- `deriveProjectArtifacts(messages, cwd)` (~1456). `collectText` concatenates the thread, then several regexes run (`project-artifacts.ts` ~175).
- The scroll-pin effect (~1824) reads `scrollHeight` and writes `scrollTop` on the same frame while `streamActive` is true.

`artifactAnchorIndex` is cached on ids, which is correct. `deriveProjectArtifacts` itself is not cached across streaming ticks. Screenshot paths are cached per message (`screenshotPathsCache`); the project scan is not.

When `streaming` flips to false, `MessageBody` swaps the plain paragraph for `react-markdown` + GFM on the full body in the same turn as the mascot should settle. A long final message is a synchronous parse on the frame the user is watching.

Find and palette jump set `showAll` (`ChatPanel.tsx` ~1372). That mounts every top-level row and, for settled agent rows, parses markdown for all of them. The windowing comment already says scroll was fine and mount was the cost. Find reintroduces that cost.

### 3.4 Mascots are N independent simulators

`core.js` starts a `requestAnimationFrame` loop per mounted, unpaused `vzt`. Product callers that leave the loop running:

- Activity line: `FatCatIcon` at **42 px**, `expression={markState}`, `still={!focused}` (`ChatPanel.tsx` ~427). `working` / `thinking` / `loading` are the heavy belt-and-particle states.
- Every **live** sidebar row: `still={frozen}` is false when `sidebarOrbPaused` is false (`Sidebar.tsx` ~135, ~386). Five working conversations means five full engines plus the activity mark.
- Phone home and featured row use the same `sidebarOrbPaused` rule.
- Side-chat header runs a second mark while the child is `queued` or `running` (`SideChatHeader`, size 18, not `still`).

Paused marks still mount the engine; they pass `paused`. That is cheaper than simulating, and it is not free: each instance owns DOM (gradients, trail nodes) created by `vzt`. Sidebar rows that are idle are paused, which is the right default. Live rows are not.

There is no shared clock. Ten loops means ten `performance.now` samples, ten integrators, and ten SVG attribute writes per frame, on the same thread that is pinning scroll and reconciling the streaming bubble.

`nub-glass` uses `backdrop-filter: blur(16px)` (`index.css` ~242). Anything that scrolls or animates under that filter promotes extra compositor layers. `.status-pulse` on the live dot is a cheap CSS animation and should stay; it is not a substitute for a second particle system.

Voice bars set `will-change: transform` permanently (`index.css` ~267). That only matters while dictating.

### 3.5 History ceiling

Serve transcript fetch is `limit=500&order=latest` (`hermes-transport.ts` ~993, `hermes-sessions.ts` ~396). There is no cursor. Threads longer than 500 messages drop the older prefix with no UI for it. Deploy’s `/api/chat/conversations` payload size is unbounded on the client: the whole JSON is parsed, then applied turn by turn. Client windowing does not reduce that parse.

Confirm sort order in the slice that touches the fetch. The mapper does not reverse the array. If `order=latest` is newest-first, the transcript is upside down until something else sorts it. One reverse at the fetch boundary, then immutable chronological order in the store.

## 4. Budgets

Measure on a throttled 4× CPU profile in Chrome (or Electron) against a fixture thread of **200 turns**, last agent message **~8 KB** markdown, one live activity mark, three other live sidebar rows. Record before slice C1 and after C3, M1, M2.

| Budget | Target |
|---|---|
| Store commits while hydrating 200 turns | **1** (plus at most 1 if a live turn is still streaming) |
| Main-thread tasks > 50 ms during hydrate | **0** after the network parse |
| Time from “transcript JSON parsed” to last visible row committed | **≤ 150 ms** |
| Long tasks > 16 ms during a streaming frame | **0** on the fixture (activity mark + last bubble + scroll pin) |
| Concurrent unpaused `vzt` loops in the shell | **1** (the activity mark). Sidebar live state is the existing CSS dot. |
| `getMessages` on an unchanged open thread | **0** `setState` calls |
| Find on a 200-turn thread | First paint of matches **≤ 100 ms**, then mount in chunks. The mascot must keep producing frames during the chunked mount. |

Reduced motion: every new animation path must stay paused when `prefers-reduced-motion: reduce` matches. `GrokOrb` already does this. Do not add a second policy.

## 5. Slices

### C1 — One commit for a transcript hydrate

**Change** `HermesDeployTransport.hydrateSessionTurns` so it builds the next `ChatMessage[]` in memory and calls `setState` once.

Rules:

- Pure function `turnsToMessages(turns, existing, opts) -> { messages, liveTurnId | null }` with no store access. Unit-test it on: empty thread, duplicate turn ids, reply-note user text (`decodeReplyNote` / `displayUserPrompt`), group `fromAgentId`, a turn that is still `streaming`.
- Merge onto `existing` by turn id. Keep local-only rows the server does not know (pending outbox bubbles, subagent bubbles `submsg_*`, reaction fields). `mergePreservedReactions` is the pattern in `hermes-sessions.ts`.
- If the built array is deep-equal on the fields the UI renders (`id`, `role`, `content`, `streaming`, `error`, `toolEvents`, `replyTo`, `pending`, `fromAgentId`), return the existing array and **do not** `setState`.
- A still-live turn may `patchMessage` after the batch, once. Do not interleave it inside the historical loop.
- Group hydrate: each member session still fetches in parallel, then **one** merge of all member messages into the room thread, one `setState`. Do not commit per member as results arrive if that re-renders the open room N times. Buffer, then commit. A member that fails keeps the previous messages for that `fromAgentId`.

**Files:** `src/lib/agents/hermes-deploy-transport.ts`, new helper next to it or under `src/lib/agents/` (keep `applyTurnState` for the single live snapshot path, or make it call the same pure function with a one-element list). Tests live beside the existing deploy transport tests.

**Check:** hydrate fixture of 200 turns notifies subscribers once. Reloading the same payload notifies zero times. A streaming turn still grows the bubble.

### C2 — Polls become no-ops when nothing changed

**Change** both timers:

- `MobileChat` 2.5 s poll.
- `App.tsx` 15 s / focus / visibility refresh.

Behavior:

- If the conversation has a live local stream, keep today’s bail-out (`hasLiveStream`).
- Otherwise fetch. C1’s equality check means an unchanged body does not `setState`.
- Desktop may stay at 15 s. Phone may stay at 2.5 s **only while** `document.visibilityState === 'visible'` and the chat route is mounted. Hidden documents already stop deploy state polling (`followTurnByState`); the transcript poll must match that.
- Do not add a third poll.

**Check:** with a stable thread, 10 s of phone-chat time produces zero `setState` from `getMessages`. A message appended on the server shows up on the next tick, one commit.

### C3 — Stop scanning settled history on each token

**Change** `ChatPanel` so a streaming tick does not rescan settled messages.

- Cache `deriveProjectArtifacts` on a key of `(cwd, message ids, last message id + content length + toolEvents length)`. Settled messages are immutable during a stream (`ChatPanel` already documents this for the anchor cache). Recompute only when that key changes.
- `threadGroups`: same idea. Reply links on settled messages do not change when the last bubble’s `content` grows. Cache groups on the id list plus each message’s `replyTo.id`. Content growth of the tail must not rebuild groups.
- `artifactAnchorIndex` already has a cache. Keep it. Do not call `deriveProjectArtifacts` on every prefix inside the hot path; the current function does (`project-artifacts.ts` ~255–263). Once C3’s cache exists, the anchor scan should use the cached artifacts plus a stored “first message id that created them”, computed once when the artifact id set changes.

**Check:** React profiler on a 200-message stream. `deriveProjectArtifacts` and `threadGroups` do not run on content-only ticks. They do run when a new message id appears.

### C4 — Settle markdown off the paint frame

**Change** `MessageBody`.

- When `streaming` flips from true to false, keep the plain paragraph for one frame.
- Parse markdown in `requestIdleCallback` (fallback: `setTimeout(0)`), then swap. If the message is under 2 KB, parsing inline is acceptable; gate the defer on `content.length > 2048`.
- Collapsed huge bodies (`COLLAPSE_AT = 20 KB`) stay as they are.
- `showAll` (Find, focus jump): mount plain text first for every newly mounted row over 2 KB, then upgrade visible rows to markdown in idle slices of **8 rows**. Rows that scroll out of the window before their slice runs stay plain until visible (`IntersectionObserver`, root = the transcript scroller). This keeps Find usable without parsing 200 bodies in one task.

**Check:** ending an 8 KB stream does not produce a long task > 50 ms on the same frame as the `streaming: false` commit. Find on 200 turns stays responsive enough to type into the find field while rows upgrade.

### C5 — Scroll pin without layout thrash

**Change** the pin effect in `ChatPanel` (~1824).

- While `streamActive`, do not read `scrollHeight` if the user has disarmed stick-to-bottom. That part already returns early. Keep it.
- While stuck to the bottom, pin with `overflow-anchor` if the browser supports it, and only assign `scrollTop` when the distance from the bottom is greater than **2 px**. A token that did not change height must not write `scrollTop`.
- Track height with a `ResizeObserver` on the message list inner wrapper, not on the `messages` array identity. The rAF inside the effect can go away.
- Non-stream arrivals (a single new settled message) use instant `scrollTop` assignment. Remove `scrollTo({ behavior: 'smooth' })` on this path. Smooth scrolling here fights the next token and the mascot. Find and focus jump may keep smooth scroll; they are user-initiated and rare.
- “Load earlier” prepend compensation (`useLayoutEffect` on `renderFrom`) stays. It is correct.

**Check:** during a stream of short tokens, `scroll` event count stays near zero when content height is unchanged. Stick-to-bottom still follows a tall code block. Scrolling up still disarms following.

### C6 — Paged history past the window, and past 500

Client windowing stays. Add a real older-page fetch so “Load earlier” is not only a DOM window over an already-downloaded array.

- Deploy: if the conversations API can take `before` / `cursor`, request the next page when the user hits “Load earlier” and `renderFrom === 0` while the server reports more. If the API cannot cursor yet, document that as a backend dependency and ship the client batching from C1 anyway. Do not block C1–C5 on the API.
- Serve: `order=latest&limit=500` needs `before_id` or equivalent. Same rule: one chronological reverse at the boundary, then append older pages **above** the current array in one `setState`, then the existing prepend scroll compensation runs.
- Never replace the visible tail while prepending. Build `older.concat(current)`.

**Check:** a thread whose tail is visible stays visually still when an older page commits (no jump). This is the same invariant as `pendingPrependRef`.

### M1 — One heavy mascot

**Change** who is allowed to run `vzt` unpaused.

- The activity-line mark (42 px, live `markState`) is the only unpaused product orb while the main shell is showing.
- Sidebar, phone home, featured row, and group stacks keep `FatCatIcon` for shape and color, with `still` **or** `paused` always, including when `live` is true. The green `.status-pulse` dot already communicates “working”.
- Side-chat header child mark stays `still` even when `childRunning` is true. The header text and the activity line carry motion.
- `GrokOrb` intersection and reduced-motion gates stay for the one live mark and for any future surface that opts in (avatar studio, HUD). Avatar studio may keep a live mark; it is not on the chat path. Gate it so it pauses when the studio is not the visible route.

Implementation note: prefer a prop the callers set (`still`) over a global singleton inside `core.js`. `core.js` is a verbatim engine port. Do not edit it for this slice. If a caller forgets, a dev-only counter of unpaused mounts (test or `logger` behind a flag) fails a unit test that renders `Sidebar` with three live conversations plus `ActivityLine` and expects a single unpaused `data-nubcat-gated` absence. Count `paused` props into `vzt` rather than patching the engine.

**Check:** the gating test above. Manually, three live sidebar rows plus a streaming chat show one moving mark. The status dots still pulse. Blurring the window still freezes the activity mark (`useWindowFocused` already does).

### M2 — Shared clock only if M1 is not enough

Do this only if a trace after M1 still shows the activity mark missing frames while streaming.

- Add a tiny registry in `GrokOrb.tsx` (wrapper, not `core.js`): at most one unpaused engine. A second caller that wants motion receives `paused` until the first unmounts or pauses. The activity line registers first because it is the foreground.
- Do not rewrite `vzt` springs.

**Check:** mounting two `GrokOrb` with `paused={false}` results in one actually simulating. Unmounting the first resumes the second.

### M3 — Paint containment on the transcript

**Change** `TranscriptRow` root and the scroller.

- On each row: `content-visibility: auto; contain-intrinsic-size: auto 88px;` (tune the intrinsic height after measuring a typical bubble; 88 px is a starting guess for one text row).
- On the scroller: `overflow-anchor: auto` (default in Chromium, set it explicitly).
- Do not use `content-visibility` on the streaming row. A changing intrinsic height plus content-visibility skips layout and breaks stick-to-bottom. Exclude the last row while `m.streaming` is true.

**Check:** scrolling a 60-row window with several long settled markdown messages keeps frame times under 16 ms in the performance panel. The streaming row still grows smoothly.

### M4 — Dead motion code and glass

After M1–M3, in a separate change:

- Delete `useBlobFx` from the product graph if no lab import remains. Confirm with a repo search. If Loop Lab or marketing preview still needs a rAF, leave those loops alone; they are not mounted in chat.
- `framer-motion` stays for `AppModal`, `NewChatBar`, `AgentInfo`, `TelegramConnect`. Do not animate the transcript with it. Do not add `AnimatePresence` around message rows.
- Audit `.nub-glass` usages on surfaces that scroll (sidebar is not glass; confirm chat wallpaper and composer). If the composer or top bar blurs the moving transcript, replace that one surface with a solid `var(--ca-card)` at the same alpha the design already uses in dark mode (`index.css` dark `.nub-glass` block ~1469). Do not remove blur from modal backdrops.
- Remove permanent `will-change` on `.ca-voice-bars > span`. Set it while `dictateStatus === 'listening'`, clear it after.

### O1 — Shell weight (only after chat slices)

`App.tsx` is ~70 KB of source and `ChatPanel.tsx` is ~97 KB. They ship in the first-paint graph because the shell imports them directly. Entry budget is 420 KiB raw (`bundle-budget.test.ts`). Do not start a split until C1–C3 and M1 have landed and a production build shows the entry over budget.

If it is over budget, lazy-load in this order: `AgentInfo`, settings, kanban, marketing composer, command palette. Do not lazy-load `ChatPanel` or `Sidebar`; they are the first useful paint after pairing. `GrokOrb` / `core.js` stays in the shell chunk because the activity mark is on that paint. Re-run `npm run test:bundle`.

## 6. Order and size

| Order | Slice | Size | Depends on |
|---|---|---|---|
| 1 | C1 batch hydrate | ~1 day | none |
| 2 | C2 quiet polls | ~2 hours | C1 equality check |
| 3 | C3 scan cache | ~half day | none, but easier to measure after C1 |
| 4 | M1 one heavy mascot | ~half day | none |
| 5 | C5 scroll pin | ~half day | none |
| 6 | C4 markdown idle upgrade | ~1 day | C3 so Find’s `showAll` is the only full mount |
| 7 | M3 content-visibility | ~2 hours | C5 |
| 8 | C6 older pages | ~1 day plus API support | C1 |
| 9 | M2 shared clock | ~half day | only if M1 traces still drop frames |
| 10 | M4 dead code and glass | ~half day | M1 |
| 11 | O1 code-split | only if the bundle test fails | chat slices done |

C1 and M1 are the two changes that move the feeling. Ship them before any visual redesign.

## 7. Tests

Add or extend:

1. `turnsToMessages` pure tests (C1): order, reply notes, reactions preserved, identical reapply returns the same array reference.
2. Deploy transport test: 50 turns → one `setState` (spy on `subscribe`).
3. Poll test: second `getMessages` with the same payload → subscriber count unchanged.
4. `ChatPanel` test already covers windowing and row memo. Add: streaming content growth does not change `data-testid="load-earlier"` count, and does not remount earlier `data-message-id` nodes (same DOM nodes).
5. `sidebarOrbPaused` tests exist. Add a render test: three live conversations render `FatCatIcon` paused / `still`, activity line does not.
6. Reduced motion: `GrokOrb` gating test already covers the media query. Keep it green. New CSS (`content-visibility`) needs no motion exception.

Manual pass (15 minutes) after C1, C2, C5, M1:

1. Cold open a long VM thread. Tail is readable without a multi-frame cascade of bubbles popping in one by one.
2. Send a message. Activity mark animates while tokens append. Scroll up; the view stays put. Scroll back to the bottom; following resumes.
3. Leave the chat open for 30 s with no traffic. The mascot stays smooth. React DevTools “Highlight updates” stays dark.
4. Toggle `prefers-reduced-motion`. The mark freezes. Bubbles still appear.
5. Phone width (~390 px): same open and stream checks. “Load earlier” does not jump the viewport.

## 8. Out of scope

- Rewriting `src/lib/grok-orb/core.js` or copying more of the Grok particle system. The engine is already imperative and per-frame.
- Virtualizing the sidebar until a roster exceeds ~200 rows. Memoized rows plus paused marks are enough below that. Revisit only with a trace.
- Replacing `react-markdown`. Deferring it (C4) is the win.
- Animating message enter/exit. New rows appear in place. Motion belongs on the single activity mark.
- Backend model streaming protocol changes, except a cursor for C6 if the API lacks one.

## 9. Status update (2026-09-29)

Measured on a production build at 4× CPU throttle with a realistic streamed reply (paragraphs, a list, a 40-line code block):

| Metric | Before | After |
|---|---|---|
| Main-thread busy (9 s scenario) | 8.25 s | 7.18 s |
| Dropped frames (> 20 ms) | 135 | 98 |
| Long tasks | 10 (577 ms) | 3 (180 ms) |
| Per-frame transcript shifts > 20 px | 18.5 | 4.5 |
| Largest single shift | 108–687 px | ~33 px |

What changed, against the slices above:

- **Markdown while streaming** (replaces the C4 plain-text-then-upgrade). Bodies split into prefix-stable chunks (`src/lib/markdown-blocks.ts`); only the growing tail re-parses, a long tail on a length-scaled timer, and a streaming code block skips the parser (`fencedCodeTail`). A reply no longer reflows when it settles.
- **C5 revised: glide, not hop.** Stick-to-bottom eases toward the current bottom every frame (`src/lib/bottom-follow.ts`, τ ≈ 70 ms). Thread open, jumps larger than 1.5 viewports, and reduced motion still snap.
- **New rows ease in** (`.ca-row-in`): only rows appended after the thread first rendered.
- **Activity line opens/closes its row** (`.ca-activity-slot`, grid 0fr↔1fr) so the scroller does not resize by ~65 px in one frame at reply start/end.
- **M3 fix:** every row carries `contain-intrinsic-size: auto 88px`, so a row that first gains `content-visibility` on settle keeps its remembered height (it used to collapse to 88 px for a frame and scroll anchoring threw the view ~600 px).
- **M2 done, as a frame budget:** `src/lib/grok-orb/frame-clock.ts` — one shared clock for all orb engines (`core.js` calls it instead of raw rAF), capped at 60 fps, 30 fps while tokens stream or while the page drops frames. The engine integrates from real frame deltas, so motion timing is unchanged.
- **Per-token render cost:** the Sidebar no longer re-renders on every token (stable `liveConversationIds` identity and callbacks); date labels use cached `Intl.DateTimeFormat`s (`src/lib/date-format.ts`); project artifacts are scanned when a reply settles, not per token.

## Amendment (2026-09-29): working sidebar rows animate, within a budget

In use, the green `.status-pulse` dot alone did not read as "this agent is
doing something". The desktop sidebar now runs the real mascot engine for
working rows, bounded by `SIDEBAR_LIVE_ORB_BUDGET = 2` (the open
conversation first, then sidebar order); working rows past the budget get a
transform-only CSS bob (`.sidebar-orb-bob`, no rAF). Idle rows, an unfocused
window and reduced motion run nothing. Group rows run only the lead member.
Worst case in the shell: activity line + 2 sidebar engines. Phone home,
featured row and group stacks keep the M1 rule (always still).
Tests: `src/components/__tests__/sidebar-live-orb.test.tsx`.


## Amendment (2026-10-04): opening a cached thread that is behind

Reported on the phone: a conversation opened on its cached (old) messages,
then the newer ones popped in with no sign anything was loading. The cached
open is instant by design. Before this change the refresh waited out a 250 ms
debounce plus the network round trip, showed nothing while it ran, and
stick-to-bottom snapped past a long reply (>1.5 viewports, or anything
landing within 600 ms of open).

- **Known staleness.** `cachedTranscriptBehind` (`src/lib/agents/transcript-freshness.ts`)
  compares the sync row's `lastUsedAt` (server `lastTurnAt`) with the newest
  server-stamped cached row (`turnCreatedAt`, 5 s skew margin). It also flags a
  reply that was persisted mid-stream when no turn is live any more. It
  is conservative: a group, a thread with no stamps, or a local tail is never
  "known behind". A fetch remembers the `lastUsedAt` it started from, so a turn
  that adds no rows cannot keep a thread behind forever.
- **Selection.** Plan `behind` fetches at once (no debounce, freshness
  ignored) and publishes `HydrateStatus.transcriptSync`. The runtime exposes
  `transcriptSyncing: 'behind' | 'checking' | null`.
- **Pill.** `TranscriptSyncPill` floats over the transcript (out of flow, so it
  moves no rows). `behind` shows "Loading new messages" at once. Other cached
  re-checks show "Checking for new messages" only after 700 ms.
- **Arrival.** Caught-up rows (server-stamped, not during an own send) glide in
  instead of snapping. A batch taller than the screen lands with its first row
  near the top (`src/lib/catch-up-scroll.ts`), and the "Latest" pill offers the
  rest. Rows below the fold are laid out for real (`content-visibility:
  visible` for one frame) before measuring, because the 88 px placeholder
  would hide a long reply's height.
- **Background.** `useBehindWarmup` refetches up to `WARM_COUNT` recent cached
  threads the sync feed moved past (once per `lastUsedAt`, visible document,
  cheap connection, never a live thread). Opening one usually paints the new
  turns straight from cache.

Tests: `transcript-freshness.test.ts`, `prefetch.test.ts`,
`catch-up-scroll.test.ts`, `chat-transcript-loading.test.tsx`.

## Amendment (2026-10-05): M4 dead motion code

`useBlobFx` was already gone. The rest of the clean-room blob-fx engine it
drove (`engine.ts`, ~1,000 lines: frame, ring, particle and glyph samplers)
and the constants and types only it used had no importers, so they were
deleted. `src/lib/blob-fx/` now holds only the FX state tables the product
mark and its demo read (`FX_STATES`, `FX_STATE_LABELS`, `PRESENCE_TO_FX`).
