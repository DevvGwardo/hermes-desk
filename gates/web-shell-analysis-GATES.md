# Gates — analyze uncommitted web-app shell work (maiavm-desktop)

Task: full analysis of the uncommitted web-shell work (4 modified + 2 untracked files).
Mode: solo (analysis, no implementation). Status: **7/7 checked.**

- [x] G1-inventory — every dirty/untracked file accounted for; nothing unexpected.
  CHECK: `git status --porcelain=v1` + `git diff --stat`
  EVIDENCE: 4 modified (package.json +1, vite.config.ts, App.tsx, TopBar.tsx) + 2 untracked source (src/components/WebConnect.tsx, src/lib/capabilities.ts). `git diff --stat`: 4 files, 106 insertions / 16 deletions. `?? gates/ocgo-redis-poison-verify.md` + `?? gates/web-shell-analysis-GATES.md` are gate docs, not source. `git check-ignore -v dist/index.html` → `.gitignore:4:dist` (dist gitignored). Matches expectation exactly.

- [x] G2-read — all 6 changed/new source files read IN FULL, plus the integration modules they depend on.
  EVIDENCE: read in full — WebConnect.tsx (322L), capabilities.ts (44L), App.tsx diff (72 changed lines), TopBar.tsx diff, vite.config.ts (full new), package.json diff; integration — session.ts (67L), pairing.ts (83L), platform.ts (27L), vm-preview.ts (178L), active-transport.ts (231L), maiavm-api.ts (lines 1–110 + targeted), deploy-client.ts (targeted: startDesktopAuth L70, pollDesktopAuth L89, pollIntervalMs L65), build-env.ts (3L), hermes-deploy-transport.ts (readDeploySessionFromStorage L155–166), index.html CSP block (L5–14), panel effect guards (KanbanPanel/McpPanel/HermesSurfacesPanel/ComputerPanel/FilesPanel).

- [x] G3-integration — every cross-module assumption verified at file:line.
  EVIDENCE:
  - session key chain: `session.ts:3` STORAGE_KEY='nub:mobile-session' === `hermes-deploy-transport.ts:74` MOBILE_SESSION_KEY (same key). WebConnect→saveMobileSession→readDeploySessionFromStorage reads same key.
  - active-transport.ts:75–85 deployTransportIfPaired() → HermesDeployTransport(deploy); :110–120 prod path returns unlinkedTransport() when no session (never mock in prod) → WebConnect gate ensures a session exists before main UI mounts.
  - build-env.ts:2 isProdBuild()=import.meta.env.PROD → true under `vite build --mode web` (so isMockMode()=false in web prod, deploy transport selected).
  - deploy-client.ts endpoints exist: `/api/nub/desktop/auth/start` (L71), `/api/nub/desktop/auth/poll?code=` (L90).
  - capabilities.ts imports resolve: platform.ts:22 isPhoneShell(), vm-preview.ts:40 isDesktopPreviewAvailable() — signatures match.
  - capabilities.ts:44 isWebProd = shell==='web' && PROD; App.tsx:919 gate `if (isWebProd && !webSession) return <WebConnect/>`.
  - resetActiveTransport already imported (App.tsx:32); onLinked calls resetActiveTransport() then window.location.reload() (correct order — transport singleton rebuilt on fresh mount).

- [x] G4-electron-surface — exhaustive sweep for Electron-only surface reachable in the web shell.
  CHECK: `grep -rn "require('electron')|from 'electron'|ipcRenderer|__dirname|process.versions" src` → **0 hits** (no direct Electron imports anywhere in src; all Electron surface is the `window.nubAgent` bridge).
  EVIDENCE: nubAgent referenced in 39 files; every access is defensive optional chaining (`window.nubAgent?.x`, e.g. vm-preview.ts:37–38, maiavm-api.ts:68–72, vm-instance-action.ts:135/181). Panels guard their effects on `open` (KanbanPanel:95/115/145 `if(!open)`, McpPanel:105 `if(open)`, HermesSurfacesPanel:63/167, ComputerPanel:185). App.tsx triple-gates Electron surfaces: TopBar `computerEnabled={caps.vmPreview}` + `onToggleFiles={caps.vmFs?…:undefined}` (TopBar.tsx diff), panel `open` props ANDed with caps (`open={showComputer && caps.vmPreview}` L1033, `open={showFiles && caps.vmFs}` L1082, Kanban L1127, Mcp L1130, HermesSurfaces L1136), palette entries filtered via HIDDEN_PALETTE_IDS (App.tsx:64–73; all 6 ids confirmed real at L679–717 of 14 total), UpdateBanner gated by caps.updates (L1189).
  **Empirical proof (runtime smoke, not reasoning):** served freshly built dist (vite build --mode web) via `vite preview`, drove in headless Chromium 1440×900 with NO window.nubAgent — the exact web-shell condition. Unpaired → WebConnect heading "Link to your agent" rendered; pairing-code surface present. Injected `nub:mobile-session` (fake creds) → reload → WebConnect gate lifted, full desktop chrome mounted (369 chars body text). **pageerrors: 0** (zero uncaught JS exceptions in either state). console errors: 4×, all `401` from www.maiavm.com with fake creds — expected auth failures, proving the deploy transport actually fires real calls. Screenshots saved: gates/web-shell-smoke-unpaired.png (146KB), gates/web-shell-smoke-paired.png (195KB). [Not visually inspected — running on a text-only model; textual assertions + PNG file sizes are the evidence.]

- [x] G5-build — web build pipeline verified; honest split of tsc vs vite.
  EVIDENCE: `npm run build:web` (= `tsc -b && vite build --mode web`) exits **1 at `tsc -b`** — 20 TS errors. **A/B attribution via `git stash -u`**: `tsc -b` on HEAD (stashed dirty tree) also exits 1 with 20 errors; `diff /tmp/tsc-head.txt /tmp/tsc-dirty.txt` → **IDENTICAL**. → All 20 errors pre-exist on main; the web work introduces **zero** new type errors. `npx vite build --mode web` alone exits **0** (1.52s). dist/index.html carries the tightened web CSP: `grep -c 'nub-vm' dist/index.html` = **0**, `grep -c '127.0.0.1' dist/index.html` = **0**; asset base absolute (`src="/assets/index-DlH6v4BY.js"`). → Web bundling works; the `build:web` script is blocked only by pre-existing repo-wide typecheck debt (unrelated to this feature). Finding, not a pass: see report F1.

- [x] G6-tests — existing suite green on the dirty tree.
  CHECK: `npx vitest run`
  EVIDENCE: exit 0. **96 test files / 670 tests passed**, 0 failed (9.33s). No regressions from the web work.

- [x] G7-report — final report delivered; every claim carries file:line or command-output backing; numbers re-measured at report time.
  EVIDENCE: report below. Numbers re-measured this turn: 4 modified / 2 untracked source files; 106 ins / 16 del; 20 pre-existing TS errors (identical HEAD vs dirty); 670/670 tests; 0 pageerrors; 4× 401 in smoke.
