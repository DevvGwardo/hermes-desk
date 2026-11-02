# Plan: optimize the Nub frontend + ship a browser (webapp) build

Status log appended at the bottom; never rewritten.

## Goal

Turn the existing **Nub Agent** React app (this repo, `@maiavm/desktop`) into a
lean, routed, deep-linkable web app that runs in a plain browser against
`https://www.maiavm.com` — **same single-user client, no multi-tenant accounts**.
A user opens the site, links their existing Telegram/VM account (same device-code
flow the desktop uses today), and gets the same chat + Computer + Files + Routines
surface they get in Electron. The Electron and Android builds keep working unchanged.

**Non-goals:** public signup/billing/provisioning, a marketing-only landing page,
restyling away from the Nub `--ca-*` tokens, or touching the backend beyond the
minimal auth/CORS support a browser client needs.

## Current state (verified 2026-08-18)

- React 19 + TypeScript + Vite + Tailwind v4. ~52k lines in `src/`. 631+ tests green.
- Three surfaces from one tree: Electron (`electron/`), Android (`src/mobile/`),
  browser (Vite dev / `vite preview`). `main.tsx` picks `App` vs `MobileApp` on
  `max-width: 720px`; `isMockMode()` falls back to mock data when `window.nubAgent`
  is absent, so the app already boots in a browser tab.
- All privileged capabilities flow through the `window.nubAgent` preload bridge
  (full surface in `src/vite-env.d.ts`): auth (`nubAuthStart/Poll/Refresh/LinkStatus/
  Unlink/Connection`), VM REST/FS/screenshot (`nubVmRest/nubVmFs/nubVmScreenshot/
  nubVmZipSave/nubVmCopy/nubVmInstance/nubVmConfig/nubVmMcp`), chat streaming
  (`nubChatStream/nubChatAbort`), local STT (`sttStatus/sttTranscribe`), Hermes
  (`hermes/serveConfig`), updates (`updateCheck`), `openExternal`.
- Backend already reachable from a browser: `index.html` CSP `connect-src` allows
  `https://www.maiavm.com`; `maiavm-api.ts` uses `fetch(credentials:'include')`.
  Device-code endpoints exist (`/api/nub/desktop/auth/start` + `/auth/poll`, seen in
  `src/mobile/deploy-client.ts`).
- Pain points: `App.tsx` 1,142 lines (~30 `useState` flags + all keyboard/wiring);
  no router (every panel is a boolean); no code-splitting (biggest files `ChatPanel`
  1,693, `SettingsStub` 1,115, `Sidebar` 1,058, `hermes-deploy-transport` 1,508,
  `hermes-transport` 1,315); `window.nubAgent.*` called ad hoc in ~30 sites.

## Architecture — the one keystone

Introduce a **platform bridge** so the renderer never touches `window.nubAgent`
directly. One interface, three implementations:

```
src/lib/platform/
  types.ts        // PlatformBridge interface (mirrors NubAgentApi + derived needs)
  context.tsx     // PlatformProvider + usePlatform() hook (defaults: auto-detect)
  electron.ts     // wraps window.nubAgent 1:1 (current behavior, zero change)
  browser.ts      // HTTP impl against maiavm.com (auth token + fetch + SSE)
  index.ts        // resolvePlatform(): electron | browser (webapp build flag / UA)
```

Every existing `window.nubAgent.X` call site becomes `platform.X`. This is the
seam that lets Phases 3–5 swap Electron for HTTP without touching UI code.

## Phases

### Phase 0 — Platform seam (prerequisite, behavior-neutral)
- Leaves: `types.ts` (interface from `NubAgentApi` + `resolveNubApiConnection`),
  `electron.ts` adapter, `context.tsx` provider, `index.ts` resolver, migrate the
  ~30 call sites (`stt.ts`, `vm-copy.ts`, `updates.ts`, `hermes.ts`, `nub-vm.ts`,
  `vm-preview.ts`, `hermes-stream.ts`, `hermes-rest.ts`, `vm-instance-action.ts`,
  `TelegramConnect.tsx`, `SettingsStub.tsx`, `AgentInfo.tsx`, …).
- Gates: `tsc --noEmit` clean; `vitest run` green; Electron + `vite preview` mock
  smoke unchanged; no behavior diff.

### Phase 1 — Optimize the existing React app
- Leaves: code-split off-canvas panels behind `React.lazy` + `Suspense`
  (`SettingsStub`, `KanbanPanel`, `McpPanel`, `HermesSurfacesPanel`,
  `CommandPalette`, `FilePreview`, `AgentEditor`, `RoutineEditor`, `HostModal`);
  decompose `ChatPanel`/`SettingsStub`/`Sidebar` (message row, composer, settings
  section, sidebar row); extract `App.tsx` keyboard + update/routine/sync effects
  into `src/lib/hooks/` (`useKeyboardShortcuts`, `useAppUpdatePoll`,
  `useRoutineEngine`, `useCrossDeviceSync`).
- Gates: tsc clean; tests green; `vite build` chunk report shows panels split;
  initial JS meaningfully smaller (record before/after `dist/assets/*.js`).

### Phase 2 — Routing / deep links
- Leaves: lightweight router (state → URL sync; no heavy dep needed) mapping
  Settings/Kanban/MCP/Hermes-Tools/Files/Preview/agent/conversation to
  `#/…` or path routes; browser back/forward + ⌘K deep-link; shareable URLs.
- Gates: every panel reachable by URL and survives reload; back button works;
  no behavior regression in Electron (router active in both).

### Phase 3 — Browser auth (same account, device code)
- Leaves: `browser.ts` auth impl using `/api/nub/desktop/auth/start` + `/poll`
  (Telegram device code) against `VITE_MAIAVM_API_BASE`; token handling — prefer an
  HttpOnly session cookie set by the backend, else in-memory + `sessionStorage`
  (never persistent localStorage); `usePlatform()` exposes `linked`/`present`.
- Gates: in a plain browser tab, link via Telegram, reload, session survives
  (cookie) or re-pairs cleanly (storage); no token in localStorage; logout/unlink works.

### Phase 4 — Browser transport (chat + VM over HTTP)
- Leaves: `nubChatStream` → fetch/SSE against the VM gateway with bearer; `nubVmRest`
  / `nubVmFs` / `nubVmScreenshot` / `nubVmCopy` / `nubVmZipSave` → direct HTTP when
  served from an origin the VM CORS allowlist trusts (www.maiavm.com / nub.maiavm.com);
  `nubVmInstance`/`nubVmConfig`/`nubVmMcp` equivalents.
- Gates: chat streams, Files list/read, screenshot, zip download all work in-browser
  with no Electron; mock mode still the offline fallback.

### Phase 5 — Browser-only capabilities
- Leaves: STT via Web Speech API (feature-detect; hide mic when unsupported) replacing
  the whisper.cpp bridge; file save → `download` link/Blob instead of `nubVmZipSave`
  IPC path; `openExternal` → `window.open` (gated); update banner → no-op in browser.
- Gates: dictation works where the browser supports it; downloads work; no dead buttons.

### Phase 6 — Deploy + measure
- Leaves: `vite build` with a webapp base; deploy to a static host on
  www.maiavm.com / nub.maiavm.com (same origin as the API for cookie + CORS); audit
  bundle size, LCP, INP, a11y; add a `npm run webapp:build`/`webapp:preview` script.
- Gates: production webapp live; bundle/LCP/INP recorded; keyboard + reduced-motion
  paths verified; mobile shell still switches at 720px.

## Risks / open questions

- **Token security in-browser.** HttpOnly cookie is the right answer and needs a small
  backend change (set the session cookie on the auth endpoints). Until then, memory +
  `sessionStorage` is the interim. Confirm the backend owner is OK adding the cookie.
- **VM CORS.** Direct VM REST/FS needs the webapp origin in the VM CORS allowlist
  (today it's the dashboard origin). Hosting the webapp on that same origin avoids it.
- **STT fidelity.** Web Speech API is cloud STT (unlike local whisper.cpp). Acceptable
  for a browser build, but it changes the privacy story — flag it in the UI.
- **Two transports.** `hermes-transport` (serve) vs `hermes-deploy-transport` (deploy)
  already split; the browser path lands on deploy. Don't invent a third.

## Status log

- 2026-09-04: Phase 2 SHIPPED (live `index-Cmn65FS3.js` == local build, SPA + CSP verified; gates `gates/web-phase2-GATES.md` 6/6). Hash-query router, no dep, all 8 surfaces routed, headless-proven. Deploy path fixed: project now git-connected (`vercel git connect`), push main = auto-deploy (46s first build). Stale CLI deployment rm'd.
- 2026-08-18: plan written (webapp model = same single-user client in browser).
  Awaiting go on Phase 0.
