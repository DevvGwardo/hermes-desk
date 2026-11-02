# hermes-desk gap analysis — 2026-10-07 (read-only)

Source: parallel read-only audits of `electron/`, `src/`, tests/scripts/config/docs.
No code changes made.

## 1. Security boundary (highest value, small patches)

- **Main-renderer can drive OS input:** `electron/main.cjs:1073` (`maia:hud:clickAt`), `:1357` (`typeText`), `:1011` (`moveTo`) accept any `assertMainSender` passer. Contrast `see` at `:1216`, drag at `:1025-1055` which enforce HUD-only via `hudEventFromHud`. A main-window XSS could click/type into frontmost app when orb expanded. Fix: add HUD-sender check to `clickAt`/`typeText`/`moveTo`.
- **No `will-redirect` guard on app windows:** `electron/vm-nav-guard.cjs:34-49` + `main.cjs:883,322` only install `will-navigate`. Workspace views (`local/workspace/views.cjs:151-169`) listen to redirect/frame-navigate, app windows don't. Server-side redirect off-origin isn't re-checked.
- **`fs read-text/read-data-url` uncapped:** `main.cjs:1727-1738` reads whole file; `read-data-url` +33% base64. Multi-GB request OOMs main. Serve paths already cap 1–5MB (`serve-auth.cjs:234,250,318`), STT has `MAX_AUDIO_BYTES` — fs is the outlier. Cap 5–10MB + `too-large` error.
- **`typeText` unbounded:** `main.cjs:1376-1377` checks non-empty only. Cap ~4k chars.
- **`Access-Control-Allow-Origin: *`** on loopback REST proxy (`main.cjs:196`). Token-gated (256-bit bearer) so low risk, but any local page can attempt. Echo origin or comment intent.
- Minor: plugin pin `Map` unbounded (`main.cjs:788-794`, cap like `originApprovals` 100-LRU); `originApprovals` in `secrets-op.cjs:57-77` in-memory no expiry; `validateFsPath` resolves relatives against cwd (`fs-guard.cjs:62`) — require absolute.

Token handling itself is solid: presence-only to renderer (`serve-auth.cjs:131-142`), header injection scoped (`:168-181`), WS relayed main-side, D-07 hatch correct.

## 2. Frontend: dead code + polling + bundle

- **Dead probes still polled:** `src/lib/hermes-rest.ts:714-733,762-794,825-835` hardcode `false`/`null` (resize, browser-jobs, notifications), but `src/lib/use-browser-jobs.ts:19`, `src/components/NotificationsBell.tsx:64-65,140,163` still probe them. Bell keeps full filter-chip UI (`:40-44,242-258`) that can never fire. Delete bus path or filters.
- **Router fields dropped:** `src/lib/router.ts:35,107` `mcp` parsed but never read in `src/App.tsx:399-456`; `inviteCode` always `null` (`:45,62`). `?mcp=1` silently lost on next serialize.
- **Polling ignores `poll-cadence.ts`:** `Sidebar.tsx:283,309` 60s, `ChatPanel.tsx:534` 15s, `ComputerPip.tsx:66` 1s, `RoutinesPage.tsx:364-365` 1s + REST poll, `src/lib/use-system-notifications.ts:212` 3min chain. Only `KanbanPanel.tsx:174` and `NotificationsBell.tsx:100` use adaptive delay. Gate routines/cron REST on `document.hidden` like Bell does.
- **`refreshRoster()` on every prefs change** (`src/App.tsx:270`) — theme/width tweaks trigger `listConversations()` with no debounce/singleflight. Filter keys or debounce 500ms.
- **Per-chunk O(history) scan:** `src/App.tsx:244-254` runs `JSON.parse(tool.args)` + `flatMap.findLast(streaming)` on every `message` event. Index streaming-by-agent or throttle to `turn` events.
- **Entry still heavy:** `src/App.tsx:2-8` eagerly mounts Sidebar/TopBar/ChatPanel (2800+ lines)/Home; Chat stays mounted under Home via `display:none` (`:560`). `lazy()` Home or ChatPanel. `src/components/FatCatIcon.tsx:2` statically imports `GrokOrb` while `vite.config.ts:56` isolates `legacy-mascot` — extra static edge on startup.
- **`useEverOpened` never unmounts** (`src/App.tsx:133-141,636-667`) — Files/Kanban/Settings accumulate DOM. Cap heavy panels.
- **CSP vs code contradiction:** `index.html:9` `img-src` lacks `https:` but `src/lib/safe-image-url.ts:89` allows `https:` — remote images always break. Either add `https:` or tighten helper to local/blob/data. Missing `worker-src` (pdf worker relies on `script-src blob:` fallback), no `frame-ancestors 'none'`.
- A11y: bare `<button>` Dismiss/Retry (`src/App.tsx:593`, `src/components/OfflineBanner.tsx:16-22`), `hidden` panels not `inert` (`src/components/SidePanel.tsx:28-29`), ticking timestamps (`src/components/Sidebar.tsx:290`, `src/components/ChatPanel.tsx:558`) churn screen readers — `aria-hidden` + `<time dateTime>`.

## 3. Tests / scripts / config drift

- **No `lint`/`typecheck`/`coverage` scripts;** coverage floors in `vitest.config.ts:62-70` unenforced. No eslint config in repo.
- **`tsc -b` skips `electron/` + `scripts/`:** `tsconfig.node.json:20` only includes vite/vitest configs. `build` green ≠ checked.
- **E2E orphaned:** `tests/e2e/vitest.config.mjs` (9 files + `fake-model/`) has no npm script; root `unit` project only runs `*.test.{ts,tsx}`.
- **~30 `scripts/*.mjs` probes unwired**, no discoverability. `electron:dev` ≡ `dev:local` duplicate.
- **~37 `src/lib/*.ts` with no name-matched test**, incl. security-relevant `desktop-bridge`, `fs`, `host-config`, `outbox`, `logger`. Preload contract test (`electron/preload.test.mjs:21-51`) only pins host/workspace/computer channels — `serveSocket/hud/stt/kanban/plugins` drift silently.
- Missing: sender-rejection test for `clickAt`/`typeText`, `will-redirect` coverage (`d04` covers `will-navigate` only), size-cap tests.

## 4. Docs / version hygiene

- `package.json:4` `0.1.0` vs `STATE.md` shipped `0.1.13–0.1.18`; no `android/` dir so gradle refs dangle.
- `STATE.md:1` title still `maiavm-desktop`; 114KB all Nub-era, no `hermes-desk` entry despite `f78711a` rename snapshot.
- Root `PLAN.md` / `PLAN-next.md` both `SUPERSEDED 2026-09-05` (hermes-deploy history) occupying active slots.
- `docs/` ~90 files two eras mixed; `gates/` 100% pre-rename; `vite.config.ts` comments still reference Capacitor/APK/`nub-boot-mark`.
- `README.md:61` trailing "Wave 1… still in progress" stale vs Oct-06 spec.
- Dirty tree at audit time: `M ChatPanel, MessageActions, NotificationsBell, hermes-rest, notifications` + `?? tests/e2e/runtime-console.mjs`.

## Smallest high-leverage batch

1. HUD-sender check on `clickAt`/`typeText`
2. fs read cap + `typeText` cap
3. `will-redirect` on app windows
4. Kill dead notification/browser-job poll path
5. Debounce `refreshRoster` + gate routine polls on hidden
6. Add `typecheck`/`lint` scripts + extend tsconfig to `electron/`
7. Archive root superseded plans + add one `hermes-desk` STATE entry
