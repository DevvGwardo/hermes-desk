# Adding GENUI to Hermes Desk — Research & Implementation-Requirements Report

*Research only (initial pass, 2026-10-12). Every codebase claim cites a path (and function/line area); every external claim cites a URL.*

## Implementation Status (2026-10-13 — Bounded GenUI v1 Shipped)

Bounded, **data-only** Generated UI v1 is implemented and accepted in [docs/genui-delivery-2026-10-13.md](../genui-delivery-2026-10-13.md), with companion Hermes Agent skill instructions in [skills/genui/SKILL.md](../../skills/genui/SKILL.md):

- **Resolved architectural decisions (§5 & Torrey decisions 1–7)**:
  - **Carrier & authorization**: Instead of reading unverified `p.args`, widgets are authorized strictly from the completed MCP result envelope (`structuredContent: { genui, genuiOccurrence }`) minted by [electron/local/mcp/dispatch.cjs](../../electron/local/mcp/dispatch.cjs) and validated by the shared zero-dependency contract in [electron/local/mcp/genui.mjs](../../electron/local/mcp/genui.mjs) (plus inline parity in [electron/local/mcp/shim/hermes-desk-mcp.cjs](../../electron/local/mcp/shim/hermes-desk-mcp.cjs)).
  - **Component catalog**: Fixed v1 catalog of four data-only widget types (`stat`, `table`, `bar_chart`, `checklist`) rendered by [src/components/genui/GeneratedUi.tsx](../../src/components/genui/GeneratedUi.tsx) across both `classic` and `messenger` skins.
  - **Interactivity & persistence**: Checklist toggles are local-only user notes ([src/components/genui/checklist-state.ts](../../src/components/genui/checklist-state.ts), 32 entries / 128 KiB / 7-day TTL) scoped by conversation, profile, call ID, server-issued `genuiOccurrence`, and spec revision; they never send follow-up turns. Transcript durability uses authenticated raw session export supplementation ([src/lib/agents/local-history.ts](../../src/lib/agents/local-history.ts)) and atomic room checkpoints ([src/lib/agents/local-room-runner.ts](../../src/lib/agents/local-room-runner.ts)).
  - **Tool Search discovery, UI polish, search/activity indexing & Copy/Reply fallbacks**: [skills/genui/SKILL.md](../../skills/genui/SKILL.md) guides local Hermes profiles through `tool_search` discovery and strict schema bounds; [src/lib/agents/tool-activity.ts](../../src/lib/agents/tool-activity.ts), [src/components/chat/ToolChipRow.tsx](../../src/components/chat/ToolChipRow.tsx), [src/lib/settings-index.ts](../../src/lib/settings-index.ts), and [src/components/settings/local/WorkspacePane.tsx](../../src/components/settings/local/WorkspacePane.tsx) surface truthful `Rendering generated UI` / `Rendered generated UI` status labels and settings search keywords; [src/lib/search-index.ts](../../src/lib/search-index.ts), [src/lib/home-activity.ts](../../src/lib/home-activity.ts), [src/components/ChatsPage.tsx](../../src/components/ChatsPage.tsx), and [src/App.tsx](../../src/App.tsx) index validated GenUI widget text across Command Palette (`⌘K`), in-chat Find (`⌘F`), Home recent activity, and Chats archive previews/search; and [src/components/MessageActions.tsx](../../src/components/MessageActions.tsx) and [src/components/ChatPanel.tsx](../../src/components/ChatPanel.tsx) provide Copy and Reply-quote fallbacks on tool-only GenUI bubbles while ignoring unvalidated or failed tool events.

---

## Executive summary

- **The hard part is already built.** Hermes Desk already runs a full client-side tool bridge to `hermes-agent`: a stdio MCP shim (`electron/local/mcp/shim/hermes-desk-mcp.cjs`), a main-process socket server (`electron/local/mcp/socket-server.cjs`), a dispatch/lane layer (`electron/local/mcp/dispatch.cjs`), and a tool catalog (`electron/local/mcp/tools.cjs`). The model can already call desktop tools. A GENUI "render this component" tool is one more entry in that catalog — **no backend change required**.
- **The insertion point in the renderer is `ChatMessage.toolEvents`.** Serve `tool.start`/`tool.complete` events become `toolEvents` rows (`src/lib/agents/hermes-transport.ts:410-425`, `pushToolEvent` at :725) and render through `ToolChipRow` (`src/components/chat/ToolChipRow.tsx`) mounted at `src/components/MessageBody.tsx:757`. A second hook exists in the markdown component map (`MessageBody.tsx:398`) for a tagged/fenced block.
- **Two concrete blockers found in the current code.** Tool args are truncated to 300 chars (`safeJson`, `hermes-transport.ts:208-217`) and tool results to 400 chars (`hermes-transport.ts:193`), and nothing in the UI renders a tool *result* at all — only a caption. A UI spec cannot ride the existing `toolEvents` fields unchanged. **The fix is cheap**: `pushToolEvent` receives the *raw* `ServeToolEvent` (full `p.args`) before truncation, so a dedicated `genui` field can be written there without touching the truncated display fields.
- **The security model is already the right one, and it dictates the design.** The app runs `sandbox:true` + `contextIsolation` + `nodeIntegration:false` (`electron/main.cjs:837-847`) and already has two proven patterns for untrusted content: a sandboxed iframe with a strict CSP (`src/components/PreviewModal.tsx:31,38`) and a trusted in-process React contribution registry (`src/plugins/areas.ts`). **GENUI should use the second (whitelisted React components from validated JSON), not the first (arbitrary HTML).**
- **Shipped v1 contract:** one MCP tool (`render_ui`, exposed to Hermes profiles as `mcp__hermes_desk__render_ui`) whose arguments are `{ "version": 1, "components": [...] }`, a fixed catalog of 4 data-only components (`stat`, `table`, `bar_chart`, `checklist`), validated by the zero-dependency contract in `electron/local/mcp/genui.mjs` and rendered inline via `<GeneratedUi>` in `src/components/MessageBody.tsx`. Because `tools.tool_search.enabled: auto` defers MCP schemas, agents discover `mcp__hermes_desk__render_ui` via `tool_search` (`{"queries": ["hermes desk render_ui"]}`) and `tool_describe` (`{"names": ["mcp__hermes_desk__render_ui"]}`). Agents must never claim `render_ui` is unbuilt and must never emit `::preview{file="..."}` HTML workarounds.

---

## 1. Current rendering pipeline — where a GENUI payload hooks in

### 1.1 Two transports, only one can carry a payload

There are two chat transports, and they are not equal for GENUI:

- **`api_server` SSE** — `src/lib/hermes-stream.ts`. `StreamCallbacks.onTool` emits `ToolProgressEvent { tool, emoji?, label?, toolCallId?, status }` (`hermes-stream.ts:23-29`, `:46-64`). **No args, no result.** The SSE parser only recognizes `hermes.tool.progress` frames carrying that shape (`:389-403`). A GENUI spec cannot ride this path without a new event type.
- **`serve` WebSocket JSON-RPC** — the primary transport. Documented in `docs/HERMES_SERVE_PROTOCOL.md:45-128`; event types `tool.start {tool_id, name, args?, args_text?}` and `tool.complete {tool_id, name, args, result, duration_s?, summary?, todos?, inline_diff?}` (`docs/HERMES_SERVE_PROTOCOL.md:88-90`). **This path carries full args and a `result` JsonValue.** GENUI must be built on serve.

### 1.2 Serve event → `ChatMessage` (the write path)

`src/lib/agents/hermes-transport.ts` is the reducer:

- `tool.start` → `pushToolEvent(..., 'running')` (`hermes-transport.ts:410-415`)
- `tool.complete` → `pushToolEvent(..., status)` (`hermes-transport.ts:417-425`)
- `pushToolEvent` (`hermes-transport.ts:725-742`) finds the streaming reply message, upserts into its `toolEvents` array, and calls `patchMessage`.
- `toolEventFromPayload` (`hermes-transport.ts:177-199`) is where each row's shape is built — and where `args` is capped at 300 chars (`safeJson`, `:208-217`) and `result` at 400 chars (`:193`).
- Message text arrives separately: `message.delta` → `appendMessageContent` (`hermes-transport.ts:~405`).

The `ChatMessage` shape is in `src/lib/agents/types.ts:183-253`; the relevant fields are `content`, `toolEvents` (`:212-224`), and `choices` (`:209`).

### 1.3 Render path (the read path)

`ChatPanel.tsx` → `TranscriptRow` (`src/components/chat/TranscriptRow.tsx:477`) → `Bubble` (`:158`) → `MessageBody` (`src/components/MessageBody.tsx:710`).

- `toolEvents` is threaded only in the `messenger` skin: `TranscriptRow.tsx:323` passes `msg.toolEvents`, and `MessageBody.tsx:757` renders `<ToolChipRow events={toolEvents} />`.
- `ToolChipRow` (`src/components/chat/ToolChipRow.tsx:35-80`) renders a collapsed "N steps" list; each row shows an icon + a caption from `toolCaption()` (`:12-33`). **It never renders `result`.** `args` is parsed only to extract a URL or a shell command for the caption.
- Markdown rendering: `src/lib/markdown-blocks.ts` splits the body into prefix-stable chunks; `MessageBody.tsx:398` (`markdownComponents`) overrides `pre`/`code`/`img`/`a`/headings, with `MarkdownPre` (`:247`) and `FencedCode` (`:211`) handling fenced blocks.

### 1.4 The two hook points (and a third that already exists)

1. **Tool-result slot** — extend `pushToolEvent` to also write a validated `genui` field on the message, and render a `<GenUiBlock>` next to `<ToolChipRow>` in `MessageBody.tsx`. This is the clean, model-driven path.
2. **Markdown component override** — add a component for a ` ```genui ` fence in `markdownComponents` (`MessageBody.tsx:398`). Simpler to prototype, but parse-on-stream and prefix-chunking (`markdown-blocks.ts:82-103`) make partial/streaming specs fragile.
3. **The precedent that already exists:** `msg.choices` (`types.ts:178-181,209`) renders model-supplied buttons inline (`TranscriptRow.tsx:355-369`) whose clicks go back to the agent via `handleChoice` → `handleSend("[choice:id] label")` (`useAgentRuntime.ts:754-759`). **This is a primitive, single-widget GENUI already shipping.** The right mental model is "generalize `choices` into a component registry."

`useAgentRuntime.ts` is the conversation/selection/send orchestrator (`handleSend` at `:669`); it is *not* the per-token render path (rows subscribe individually via `useLiveMessage`, `TranscriptRow.tsx:558`). So GENUI work touches the transport and the row renderer, **not** `useAgentRuntime`.

---

## 2. What the hermes-agent protocol offers today

*Verified against the local checkout `~/.hermes/hermes-agent` (`46d7718a52`) and its bundled `website/docs/`.*

- **Full tool-result shape exists on the wire.** `ToolCompletePayload` (`tui_gateway/contracts/events.py:283-299`) carries `result: JsonValue`, `summary`, `result_text`, `inline_diff`, `todos`, `revision`, plus `args`. `ToolStartPayload` (`:266-280`) carries `args` and `args_text`. So a tool result can be structured JSON and survives to the desktop — subject to the desktop's own 400-char truncation (§1.2).
- **`rendered` on message events is *not* a component channel.** `message.delta`/`message.complete` carry an optional `rendered: str` (`events.py:116-129,205`), but it is the terminal ANSI render — `tui_gateway/render.py:27 render_message(text, cols)`, set at `prompt_turn.py:764,970`. It is column-formatted text for the TUI, not UI.
- **Client-side tools = MCP.** The desktop's own route is already documented and proven in `docs/plans/hermes-desk-mcp-route.md`: stdio JSON-RPC shim → app Unix socket → dispatch → lane executor. Tools are namespaced `mcp__hermes_desk__<name>` (`docs/plans/hermes-desk-mcp-route.md:92`). A GENUI tool is a new entry in `electron/local/mcp/tools.cjs` (`TOOLS`/`listTools()`, `tools.cjs:36-57`) plus a handler branch in `dispatch.cjs` (see `contentFor`, `dispatch.cjs:92-114`).
- **Non-MCP custom tools exist but aren't the desktop's path.** Python plugins register tools in-process (`website/docs/user-guide/features/plugins.md`) and core tools live in `tools/`/`toolsets.py` (`website/docs/developer-guide/adding-tools.md`). Both require running code inside hermes-agent; the desktop deliberately does not patch Hermes (`docs/plans/hermes-desk-mcp-route.md:20`, "No npm dependency or Hermes patch is needed").
- **No schema-enforced structured output to lean on.** No per-request `response_format`/`json_schema` enforcement was found in `gateway/platforms/api_server.py` (only internal `_active_structured_run_count` bookkeeping at `:1329-1418`). **The tool argument schema is the only structured-output surface** — which is exactly what MCP `inputSchema` gives you.
- **The closest existing "artifacts in chat" feature is file-based, not interactive.** Hermes' *Deliverable Mode* (`website/docs/user-guide/features/deliverable-mode.md`) scans the agent's reply text for absolute file paths and attaches those files natively on messaging gateways. It is a "mention a path → host renders it" pattern with **no interactivity and no component vocabulary** — a useful precedent for the delivery mechanic, useless as a UI substrate.
- **The native Hermes Desktop has a plugin SDK — but it is a different app.** `website/docs/developer-guide/desktop-plugin-sdk.md` documents `@hermes/plugin-sdk` and `$HERMES_HOME/desktop-plugins/` for `hermes desktop`. Hermes Desk is a separate Electron app that talks to `hermes serve`; the SDK is not reusable, but it is strong prior art for "one import, register a surface, hot-reload."

**Bottom line:** the only model-driven, desktop-visible channel that exists today is **an MCP tool call, which surfaces as `tool.start`/`tool.complete` with full `args` and a `result`.** That is the GENUI carrier.

---

## 3. Prior art worth copying (tight)

| System | Mechanism | One-line takeaway |
|---|---|---|
| **Vercel AI SDK (generative UI)** — [vercel.com/blog/ai-sdk-3-generative-ui](https://vercel.com/blog/ai-sdk-3-generative-ui), [ai-sdk.dev generative user interfaces](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces) | Tools map to React components; the model's tool call *is* the render request; `streamUI` / data parts stream partial props | A **tool-name → component registry** is the whole pattern; the model never writes markup. |
| **ChatGPT "Intelligent UI"** — reverse-engineered: [openui.com/blog/how-chatgpt-intelligent-ui-works](https://www.openui.com/blog/how-chatgpt-intelligent-ui-works) | Model writes **DIL** (Markdown + JSX-like tags + JS); server compiles to JS + JSON constants; a **sandboxed client runtime** renders **native components** from a fixed catalog | Three layers: inference format, server-side validation/compile, client render against a **catalog**. The catalog is what bounds risk. |
| **Claude Artifacts (chat)** — [bloom.security/blog/claude-artifacts](https://bloom.security/blog/claude-artifacts) | Self-contained HTML page in a **sandboxed iframe** on `*.claudeusercontent.com` under a strict CSP; no host-page access | Sandboxed page = safe. If you want interactive-but-trusted, use a **component registry**, not an HTML page. |
| **Claude Cowork artifacts (desktop)** — same source | Real local program, `cowork-artifact://local`, **injected `window.cowork` IPC bridge** to MCP tools; grants persist; all artifacts share one origin | This is the **anti-pattern to avoid**: injected IPC + shared origin + trusted-by-default code. |
| **Grok Bot** — the owner's own RE: `docs/GROK_ARTIFACTS_RE.md:15-29` | No artifact panel, no preview iframe, no hosted URL — VNC + file cards + downloads only | Nothing to copy; Grok is the negative example. |
| **Electron/React rendering choice** | iframe (isolated origin) vs React-in-slot (shares the app origin) | Hermes Desk already ships **both**: `PreviewModal.tsx` (iframe) and `src/plugins/` (React-in-slot). Pick per trust level. |

---

## 4. Security surface

### 4.1 What the app already enforces (and what it implies)

- **Process/window lockdown.** `electron/main.cjs:837-847`: `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, `webSecurity:true`, `webviewTag:false`, `allowRunningInsecureContent:false`. The HUD window repeats it (`main.cjs:236-247`).
- **No generic IPC.** `electron/preload.cjs` exposes a **fixed, named** `window.nubAgent` surface via `contextBridge` (`preload.cjs:9-303`) — no raw `ipcRenderer`. Any GENUI action must go through an *existing or newly-named* channel, not arbitrary IPC.
- **Strict CSPs on every agent-reachable document.** `PreviewModal.tsx:31` (`default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`), `electron/local/workspace/overlay.html:5`, `electron/local/pip.html:6`. `electron/security-invariants.test.mjs:99-283` asserts these directives.
- **Existing URL sanitisers.** `src/lib/safe-image-url.ts` (`safeLinkUrl`, `safeImageUrl`) and `src/lib/project-artifacts.ts:59-69` (`openableHostedUrl`, https + host allowlist). Reuse them; do not invent new URL handling.
- **The trust boundary is the model, not the local user.** `docs/plans/hermes-desk-mcp-route.md:323-328` (HD-06) is explicit: profile tokens stop cross-profile confusion, **not** hostile same-UID code; "the local user and their same-UID programs remain trusted." So a rendered component must be a hard boundary against **model-supplied strings**, while not pretending to defend against local processes.

### 4.2 What must be sandboxed / constrained for GENUI

1. **No arbitrary HTML or JS.** The moment the model can emit markup, you inherit Claude's Cowork-artifact problem set. Restrict to a **fixed component vocabulary**; props are data, never code.
2. **Props are untrusted text.** Every string is model output. Render as text (React escapes by default); never `dangerouslySetInnerHTML`; never `eval`; never interpolate into a URL without `safeLinkUrl`.
3. **URLs.** Any link/image prop must pass the existing sanitisers and, for links, the https-only + `target=_blank rel="noopener noreferrer"` pattern already in `MessageBody.tsx:406-418`.
4. **Forms/actions must not reach the network.** A button/select's callback should send a **follow-up turn** (the `choices` → `handleSend` pattern, `useAgentRuntime.ts:754`) or call a **named, typed IPC method** — never `fetch`, never a real `<form action>`. This is why the sandboxed-iframe approach (`connect-src 'none'`, `form-action 'none'`, `PreviewModal.tsx:31`) is safe but *weak*: it also can't call back.
5. **No new origin, no shared storage.** Avoid the Cowork `cowork-artifact://local` mistake (one shared origin ⇒ one shared `localStorage`). React-in-slot inherits the app origin but exposes no script surface if props are data-only — the correct trade for a whitelist.

**Conclusion:** whitelisted React components + validated data props + existing sanitisers + follow-up-turn actions is strictly safer than an HTML artifact panel and fits the app's existing invariants.

---

## 5. Concrete implementation plan for this codebase

### 5.1 The carrier decision (do this first)

The UI spec must travel **on a channel that is not truncated**. Three options, in order of simplicity:

- **(A) Dedicated `genui` field written in `pushToolEvent`.** `pushToolEvent` (`hermes-transport.ts:725`) receives the raw `ServeToolEvent p` — with full `p.args` — *before* `toolEventFromPayload` truncates. When `p.name` matches the render tool, validate `p.args` and write a separate `genui` field on the message. **No wire change, no truncation change, no new event.** ← recommended
- **(B) Raise the truncation** for this tool name in `toolEventFromPayload`. Smaller diff but couples the spec to the display string and still needs a parse step.
- **(C) New serve event type.** Cleanest long-term, but requires a hermes-agent-side change — rejected, since the desktop deliberately does not patch Hermes (`docs/plans/hermes-desk-mcp-route.md:20`).

### 5.2 Phased plan

**Phase 1 — minimal viable GENUI (≈3–5 dev-days)**

1. **Tool definition** — add `hermes_desk_render_ui` to `electron/local/mcp/tools.cjs` with an `inputSchema` of `{ component: enum[...], props: object }` (the enum is the whitelist; see `tools.cjs:9-39` for the existing definition pattern).
2. **Handler** — add a branch in `dispatch.cjs` that returns an ack `{content:[{type:'text',text:'rendered <component>'}]}`. The component *renders from the tool call's args on the desktop*, not from the tool result — so the handler is a no-op acknowledgment. (This keeps the spec out of the 400-char result cap entirely.)
3. **Registry** — new `src/components/genui/registry.tsx`: `Record<componentName, ComponentType<Props>>`, each built from existing `src/components/ui/` primitives (`Button`, `Select`, `Switch`, `Badge`, `Section`, `ListRow`, …). Start with 3–5: **stat card**, **bar/line chart** (there is `mermaid` already; or plain SVG), **form** (inputs → submit sends a turn), **table**, **picker/choices** (superset of `choices`).
4. **Validation** — `src/lib/genui/spec.ts`: a small explicit validator (or `zod`; **note: `zod` is not a dependency today** — `package.json` deps are dompurify/exceljs/framer-motion/gifenc/katex/mediabunny/mermaid/pdfjs-dist/react/react-dom/react-markdown/remark-gfm). Given the repo's "no new dependency without reason" posture (`AGENTS.md §2`), a hand-rolled per-component prop check is the more in-character choice; `zod` is defensible if more components land.
5. **Transport** — add `genui?: GenUiSpec` to `ChatMessage` (`types.ts:183`) and write it in `pushToolEvent`.
6. **Render** — new `<GenUiBlock>` in `src/components/MessageBody.tsx` beside `<ToolChipRow>` (`:757`), with an error boundary (the repo already has `ErrorBoundary.tsx` + `CapturedRenderFailure.tsx`).
7. **MCP config** — no change; the route already exists. The tool appears as `mcp__hermes_desk__render_ui` once the profile is enabled through the existing confirmed settings flow (`docs/plans/hermes-desk-mcp-route.md:112-154`).

**Phase 2 — interactivity & lifecycle (≈3–5 dev-days)**

- Action callbacks: component events send a follow-up turn (reuse `handleChoice`/`handleSend`) or a named IPC method in `preload.cjs`.
- Persistence: the spec must survive transcript reload — either persist it with the message or re-derive from the stored tool call (`GET /api/sessions/{id}/messages` returns the tool call; see `docs/HERMES_SERVE_PROTOCOL.md:138`).
- Streaming/partial specs: render only on `tool.complete` first; partial rendering is a Phase-3 nicety (mirrors ChatGPT's "compile the half-written response" problem, §3).

**Phase 3 — richer surface (≈1 week+)**

- Per-agent / per-skill component catalogs.
- Optional sandboxed-HTML escape hatch **reusing `PreviewModal.tsx`** for genuinely free-form output (strict CSP, `sandbox="allow-scripts"`, no callback) — never for interactive widgets.
- Possibly a new plugin area (see risk below) so third-party components can register.

### 5.3 Files that change (Phase 1)

| File | Change |
|---|---|
| `electron/local/mcp/tools.cjs` | + `hermes_desk_render_ui` definition |
| `electron/local/mcp/dispatch.cjs` | + handler branch returning the ack |
| `src/lib/agents/types.ts` | + `genui?: GenUiSpec` on `ChatMessage` |
| `src/lib/agents/hermes-transport.ts` | `pushToolEvent` (`:725`) writes `genui` from raw `p.args` |
| `src/lib/genui/spec.ts` (new) | validator + types |
| `src/components/genui/registry.tsx` (new) | component map |
| `src/components/genui/GenUiBlock.tsx` (new) | renderer + error boundary |
| `src/components/MessageBody.tsx` | mount `<GenUiBlock>` (`:749-761`) |
| tests | `src/lib/__tests__/genui-spec.test.ts`, a `hermes-transport` tool-event test, `electron/local/mcp/tools.test.mjs` |

### 5.4 Effort summary

- Phase 1: **3–5 dev-days** (transport + registry + validator + render + tests).
- Phase 2: **3–5 dev-days** (actions, persistence).
- Phase 3: **1 week+** (catalogs, escape hatch, plugin area).
- Biggest hidden cost: **component design**, not plumbing. The plumbing is a day; a catalog that looks native is the rest.

---

## Recommended phased plan (one-liner view)

- **Phase 1 (3–5d):** `hermes_desk_render_ui` MCP tool → raw-args → validated `genui` field on `ChatMessage` → fixed registry of 3–5 components → `<GenUiBlock>` beside `ToolChipRow`. No HTML, no scripts, no new origin, no backend change.
- **Phase 2 (3–5d):** component actions route back as follow-up turns; specs persist/re-derive across transcript reloads.
- **Phase 3 (1w+):** per-agent catalogs, sandboxed-HTML escape hatch via the existing `PreviewModal` pattern, optional plugin-registry area.

---

## Decisions needed from Torrey

1. **Carrier:** dedicated `genui` field written in `pushToolEvent` from raw args (recommended) vs. a new serve event type (needs a hermes-agent change, which this repo avoids).
2. **Validation dependency:** hand-rolled prop checks (in-character, zero deps) vs. add `zod`. The repo currently has **no** schema-validation library.
3. **Component vocabulary for v1:** which 3–5? (Proposed: stat card, chart, form, table, picker.) The `choices` chip already ships — is generalizing it the priority, or is a dashboard/card the priority?
4. **Action semantics:** do component interactions send a **follow-up turn** (agent sees the click), or stay purely local/visual? This is the single biggest UX/architecture fork.
5. **Escape hatch:** ship arbitrary-HTML artifacts later via the sandboxed `PreviewModal` iframe, or never (whitelist only)?
6. **Third-party extension:** should GENUI components be a new **plugin area** in `src/lib/plugins/types.ts` (currently there is **no** chat/message area — only panes, palette, composer, keybinds, routes, sidebar, titlebar, statusbar, themes), or a closed, first-party registry?
7. **Which transport is authoritative for GENUI:** confirm serve/WS only. The `api_server` SSE fallback (`hermes-stream.ts`) carries no tool args/results and would need a new event type — is "GENUI requires serve" acceptable, or must the fallback degrade gracefully (it should, by simply rendering nothing)?

---

## Notable open risks

- **Truncation is load-bearing:** `safeJson` caps args at 300 chars (`hermes-transport.ts:213`) and results at 400 (`:193`). Any design that carries the spec in those existing fields silently corrupts it. Route around them (§5.1A).
- **Tool Search defers MCP schemas:** the default `tools.tool_search.enabled: auto` means `render_ui` may need discovery via `tool_search` before the model can call it (`docs/plans/hermes-desk-mcp-route.md:173-205`). Budget for a prompt/nudge or a pinned toolset.
- **Same-UID trust (HD-06):** a rendered component is a boundary against the model, **not** against local processes (`docs/plans/hermes-desk-mcp-route.md:323-328`). Don't over-claim isolation.
- **`choices` already exists** — avoid building a parallel mechanism that duplicates it; extend the same click→`handleSend` path (`useAgentRuntime.ts:754`).
- **Perf:** the transcript is performance-sensitive (`markdown-blocks.ts`, `content-visibility` rows at `TranscriptRow.tsx:570-582`, the WeakMap artifact caches in `project-artifacts.ts:331-364`). Components must mount lazily and memoize like every other row type.
