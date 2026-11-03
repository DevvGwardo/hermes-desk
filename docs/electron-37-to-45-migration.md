# Electron 37 → 45 Migration Plan & Validation Matrix

> **Status:** DONE — shipped to `main` on 2026-11-03 (Electron 45.2.1, commits
> `e7821c1` + `ccda574`). See §Outcome for what actually broke versus what this
> plan predicted.
> **Scope:** 8 major releases (Electron 38 → 45).
> **Branch strategy:** the work landed on `feat/electron-45`, fast-forwarded to
> `main` after the gates below passed.

## Outcome (2026-11-03)

The upgrade itself was clean; the two real defects were both silent.

1. **The top-navigation lock stopped firing.** `will-frame-navigate` emits
   `(event, details)` in Electron 38+; the old handler read `isMainFrame` off the
   event, which no longer carries it, so the guard never ran and no test noticed.
   Fixed in `electron/local/workspace/views.cjs` with a single-argument fallback.
2. **A focus-triggered tooltip became audited page content.** Chromium 156 keeps
   a tooltip open when a dialog hands focus back to its opener; the portal sits
   outside every landmark, so axe reported `region` on all four chat views. The
   harness now drops focus before auditing (§6), and the same 13 states audit
   clean again.

Validation actually run: `check:node` 311 files · `tsc -b --force` and
`tsc -p tsconfig.electron.json` clean · unit 4,464 passed + 1 expected fail ·
electron 1,876 passed · `build` ok · layout, a11y and sidebar harnesses 0
failures · `electron:build` produced a 269 MB app whose Electron Framework
reports 45.2.1. `electron-builder` stayed on 26.15.3 (v27 is alpha-only) and
`playwright-core` on 1.63.0 (CDP attach against Chromium 156 exercised by the
three harnesses above). The installed `/Applications` app was **not** replaced.

## 0. Authoritative version table (verified 2026-11-03 against https://releases.electronjs.org/releases.json)

| Version | Chromium | Node | V8 |
|---|---|---|---|
| **37.10.3** (current baseline) | 138.0.7204.251 | 22.21.1 | 13.8.258.32 |
| **45.2.1** (target) | 156.0.8078.75 | 24.22.1 | 15.6.75.25 |

All version numbers elsewhere in this document must agree with this table.
Per-intermediate-release Chromium/Node/V8 cells in §3 are **UNVERIFIED** (carried over, not re-checked against releases.json) — treat only the two rows above as ground truth.

## 1. Baseline repo facts (verified in-repo)

- `package.json`: `electron: ^37.2.6` (installed 37.10.3), `electron-builder: ^26.0.12`, `playwright-core: ^1.63.0`.
- App shell: `electron/main.cjs` (2,306 lines), `electron/preload.cjs` (587 lines), plus `hud-preload.cjs`, `region-picker-preload.cjs`, `self-modification-review-preload.cjs`, `electron/local/pip-preload.cjs`.
- Hardcoded runtime pins at `electron/preload.cjs:5`, `electron/self-modification-native-mode.cjs:13`, `electron/self-modification-native-contract.cjs:111` — all assert `'37.10.3'` (see Fix 1).
- Signing: ad-hoc only (`"identity": null`, `"notarize": false` in `package.json`; `scripts/build-desktop.mjs` enforces hardened-runtime `disable-library-validation`). No Apple Developer account — notifications behaviour in Fix 5 follows from this.
- Packaging: `scripts/build-desktop.mjs` → mac build; `npm run package:release` → zip + checksums.
- CI: `.github/workflows/ci.yml` (PR quick job + macOS full job incl. native layout harness), `secrets.yml`, `release-mac.yml` (+ `release-win.yml`).

## 2. Codebase API audit (condensed — full detail was in the superseded plan)

- **Windows/views:** main window, HUD orb, region picker, Computer-Use PiP, workspace overlay, self-modification preview/review all use `new BrowserWindow(...)` with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` (spot-check `electron/main.cjs:233,842,1203`, `electron/local/workspace/views.cjs:141,209`, `electron/local/computer-pip.cjs:161`). Workspace tabs already use `WebContentsView`; zero `BrowserView` usage. **Assessment: expected compatible — UNVERIFIED until Tier 3/4 pass on Electron 45.**
- **Preloads:** all 5 preloads import only `{ contextBridge, ipcRenderer }` from `electron` and use web-standard APIs — no `events`/`timers`/`url`, `Buffer`, `setImmediate`/`clearImmediate` observed in audit. **Expected compliant with Electron 45 sandbox restrictions — UNVERIFIED until runtime boot check (§7, Stage 3 step 3).**
- **IPC:** ~55 async `ipcMain.handle` channels (workspace, host/Hermes, HUD, STT/secrets, files, plugins, self-modification changes) + sync `hd:rooms:read/save` + one-way `maia:region:done` + `webContents.send` push events. No version-sensitive surface identified.
- **Custom protocols** (`electron/main.cjs:35-39`, before `whenReady`): `hd-candidate`, `hd-avatar`, `hd-media` (Range/`206` streaming via `electron/media-protocol.cjs`). Scheme names are lowercase alphanumerics.
- **Sessions/partitions:** `persist:ws-user` + `persist:ws-agent-<profile>` with localhost egress proxy binding (`electron/local/workspace/index.cjs:100-158`), selective cookie copy (`lane-data.cjs:42-58`), fail-closed agent permissions. No version-sensitive API identified, but proxy/`webRequest` behaviour must be re-proven in manual checklist.
- **Navigation guards:** popup denial + `will-attach-webview` prevention + top-navigation lock (`electron/vm-nav-guard.cjs:34`). `will-frame-navigate` listener signature needs Fix 2.

## 3. Breaking changes, Electron 38 → 45

Only the baseline/target endpoints below are verified (§0). Intermediate Chromium/Node/V8 cells are **UNVERIFIED**.

| Release | Chromium | Node.js | V8 | Min macOS | Key changes |
|---|---|---|---|---|---|
| 37 (baseline) | 138.0.7204.251 ✓ | 22.21.1 ✓ | 13.8.258.32 ✓ | macOS 11+ | Baseline |
| 38 | *unverified (~140)* | *unverified* | *unverified* | macOS 12+ (11 dropped) | CoreAudio Tap `desktopCapturer` → needs `NSAudioCaptureUsageDescription` (Fix 4); Ozone `auto`; OSR paint `handle` |
| 39 | *unverified (~142)* | *unverified* | *unverified* | macOS 12+ | `--host-rules` → `--host-resolver-rules`; `dsym.zip` → `dsym.tar.xz`; `window.open` resizable default; ASAR integrity stable |
| 40 | *unverified (~144)* | *unverified (Node 24 LTS upgrade)* | *unverified* | macOS 12+ | **Node 22 → 24 major**; renderer `clipboard` deprecated; `net.request bypassCustomProtocolHandlers` |
| 41 | *unverified (~146)* | *unverified* | *unverified* | macOS 12+ | PDF OOPIF migration; cookie `changed` causes refined; ASAR integrity hardening |
| 42 | *unverified (~148)* | *unverified* | *unverified* | macOS 12+ | **macOS `UNNotification` migration — code-signing effectively mandatory** (Fix 5); electron npm postinstall removed |
| 43 | *unverified (~150)* | *unverified* | *unverified* | macOS 12+ | Downloads → OS `Downloads` dir; `nativeImage` sRGB; last 32-bit series |
| 44 | *unverified (~152/154)* | *unverified* | *unverified* | macOS 13+ (12 dropped) | **Renderer `clipboard` removed**; 32-bit binaries removed; ANGLE statically linked (`libEGL`/`libGLESv2` no longer packaged) |
| 45 (target) | 156.0.8078.75 ✓ | 24.22.1 ✓ | 15.6.75.25 ✓ | macOS 13+ | **Sandboxed preload restrictions** (Fix 3); worker Node scoping fix; contentTracing → Perfetto; experimental Prompt API |

## 4. Code adaptations required (7 fixes)

### Fix 1 — Hardcoded version pins → major-range checks
`electron/preload.cjs:5`, `electron/self-modification-native-mode.cjs:13`, `electron/self-modification-native-contract.cjs:111`: replace `!== '37.10.3'` exact pins with major-version acceptance of 45 (e.g. split `.` and require major `45`, or `startsWith('45.')`). Update mock version fixtures in `electron/self-modification-integrated-repairs.test.mjs`, `electron/self-modification-native-phase1.test.mjs`, `electron/self-modification-native-shutdown.test.support.mjs`, `scripts/build-completion-preview-privacy.test.mjs`, `scripts/build-completion-preview-snapshot.test.mjs` to the target runtime.

### Fix 2 — `will-frame-navigate` signature
`electron/local/workspace/views.cjs:265`: accept `(event, details)` (Electron 38+ emits both) with fallback to legacy single-arg shape; route `event.preventDefault()` through the real event object to preserve the D-04 top-navigation lock.

### Fix 3 — Sandboxed preload hardening
Add ESLint guard in `eslint.config.mjs` for `electron/*preload*.cjs` banning `Buffer`, `setImmediate`, `clearImmediate` globals and `events`/`timers`/`url` (plus `fs`/`path`/`crypto`) imports. Audit says current preloads are clean — re-confirm at Stage 3 boot check.

### Fix 4 — `NSAudioCaptureUsageDescription`
Add `build.mac.extendInfo.NSAudioCaptureUsageDescription` in `package.json` (Electron 38+, required on macOS 14.2+ for `desktopCapturer` audio; fallback switch `disable-features=MacCatapLoopbackAudioForScreenShare`).

### Fix 5 — `UNNotification` resilience on ad-hoc builds
`electron/main.cjs` notify path (~line 2234): wrap `new Notification(...).show()` in try/catch + `notif.on('failed', …)` graceful-degradation warning. Expected on unsigned local builds; must not crash.

### Fix 6 — `electron-builder` version — OPEN DECISION, UNVERIFIED
Superseded docs contradict each other: one says upgrade to `^27.1.0` (for Node 24 / ASAR digest embedding), the other says `^26.0.12`/`26.18.0` already supports Electron 45. **Do not bump blindly** — resolve by checking the electron-builder release notes for Electron 45 support at migration time, then pin whichever major is current. Preserve `--config.npmRebuild=false` + explicit `electronDist`/`electronVersion` in `scripts/build-desktop.mjs`.

### Fix 7 — `playwright-core` compatibility
`^1.63.0` connects over CDP (`--remote-debugging-port=0`); `tests/e2e/cdp-exec.cjs` `capturePage` fallback guards capture stalls. If attach fails against Chromium 156, bump to the latest stable supporting Chromium 156 (previously suggested `^1.64.1` — **UNVERIFIED**, re-check at migration time).

## 5. Dependency & native-module audit (from validation report)

- **Zero runtime native C/C++ addons in `dependencies`** (12 packages audited: `dompurify`, `exceljs`, `framer-motion`, `gifenc`, `katex`, `mediabunny`, `mermaid`, `pdfjs-dist`, `react`, `react-dom`, `react-markdown`, `remark-gfm` — all pure JS/WASM). Persistence is atomic `node:fs` + JSON journals. **Re-verify with `npm ls` / filesystem scan at migration time — dependency tree may have drifted since this audit.**
- `@napi-rs/canvas-darwin-arm64` present in `node_modules` (pulled via `pdfjs-dist` peer chain) is reported as never required at runtime (renderer uses browser `<canvas>` + `pdf.worker.min.mjs`). **UNVERIFIED — confirm with a require-graph scan before packaging.**
- Build-time native binaries (`@tailwindcss/oxide`, `lightningcss`, `@rollup/rollup-darwin-arm64`, `fsevents`, `@esbuild/darwin-arm64`) run on host Node only; unaffected by the Electron runtime bump, but host toolchain runs Node 22 in CI (`setup-node` `node-version: 22`) while the target runtime is Node 24.22.1 — confirm build tooling runs cleanly (Stage 1 step 3).
- In-tree C sources: `electron/self-modification-native-probe.c` (standalone Mach/Seatbelt probe binary via clang — not an ABI-linked addon) and `electron/self-modification-native-fd.c` (N-API, `NAPI_VERSION 8`; Node-API ABI stability is *expected* to carry it across Node 22→24 **without rebuild verification — UNVERIFIED, re-prove by compiling and running its tests on the new runtime**). Mach rendezvous naming claim (`com.github.Electron.MachPortRendezvousServer.<pid>` unchanged in 45) is **UNVERIFIED**.
- Reported dry-run (`npm install --dry-run electron@45.2.1`, engines `>= 22.12.0`, `extract-zip` → `@electron-internal/extract-zip`) is **UNVERIFIED — re-run at migration time**.

## 6. Tiered validation plan

Run before (baseline) and after each stage bump:

| Tier | Command | Scope |
|---|---|---|
| 1 Static | `npm run lint` | `tsc -b`, electron tsconfig, `check-node-syntax` |
| 2 Unit | `npm run test:unit` | renderer/components (prior doc claimed 437 files — **UNVERIFIED**) |
| 3 Electron invariants | `npm run test:electron` | main-process/security suites incl. `security-invariants`, `d04-will-navigate`, `fs-guard`, `serve-auth`, `self-modification-*` (prior doc claimed 1,869 tests / 103 files — **UNVERIFIED, re-count when run**) |
| 4 E2E | `npm run test:all-e2e` | Playwright harnesses under `tests/e2e/` (composer typing, attachments, secrets, modal layers, sidebar-compact, a11y, layout, …); CI macOS job also runs the native layout harness |
| 5 Package | `npm run electron:build` + `codesign --verify --deep --strict` + `node tests/e2e/packaged-media.mjs` | hardened-runtime ad-hoc signature, entitlements, packaged launch |

### Mutation testing (security tripwires — run at Stage 3)
MUT-01 `contextIsolation: false` → expect `security-invariants` fail · MUT-02 `sandbox: false` → expect sandbox/D-04 fail · MUT-03 remove `will-navigate` handler → expect `d04-will-navigate` fail · MUT-04 remove `showMessageBox` gate → expect external-open-dialog fail · MUT-05 invert packaged-dev gate → expect truth-table fail · MUT-06 weaken Seatbelt policy → expect native-policy fail. Procedure: apply → `npm run test:electron` must fail with the named violation → revert → green.

## 7. Staged rollout

- **Stage 0 (on 37):** apply Fixes 1–5 in compatibility-preserving form; run Tiers 1–3 + `electron:build`; branch `upgrade/electron-45-prep`.
- **Stage 1 (37 → 40):** Node 22→24 transition; update version pins; `typecheck` + Tiers 2–3; `node tests/e2e/runtime-console.mjs`; tag `electron-upgrade-stage1-v40`.
- **Stage 2 (40 → 42):** `electron:build`, ad-hoc codesign check, packaged-launch notification test; `test:media:packaged`, `attachments-lifetime`; tag `electron-upgrade-stage2-v42`.
- **Stage 3 (42 → 45.2.1):** install target + resolved builder (Fix 6); finalize pins to `45.x`; dev-boot check (`window.nubAgent` populated, `versions` reports electron `45.2.1` / chrome `156.0.8078.75` / node `24.22.1`, no sandbox warnings); full Tiers 1–5 + mutation tests.
- **Stage 4 (manual sign-off, macOS arm64):** multi-lane tabs + egress proxy + popup denial + `copySignIn` + `clearLaneData`; HUD toggle/drag/Screen-See + region picker; Computer-Use PiP frames + dock; STT transcribe; `hd-media://` seek (206), `hd-avatar://` load; self-modification review modal + token gate.

## 8. Rollback

- Revert branch to `main` pins (`electron@^37.2.6`, `electron-builder@^26.0.12`); `typecheck` + Tiers 2–3.
- Intermediate fallback: hold at 40 (Node 24 secured) or 42 while addressing an Electron-45-specific delta.

## 9. Dropped / downgraded from superseded docs

- Exact test counts (6,333+; 1,869/1,869; 4,464/4,464; 437 unit files; 103 electron files): kept as expectations, marked UNVERIFIED.
- "Fully compatible" per-window verdicts: downgraded to "expected compatible — UNVERIFIED".
- electron-builder `^27.1.0` and `playwright-core ^1.64.1` pins: downgraded to open decisions (Fixes 6–7).
- `engines.node >= 22.12.0` host check, dry-run exit 0, `extract-zip` swap: UNVERIFIED, re-run.
- Mach rendezvous name stability, N-API zero-change guarantee, `@napi-rs/canvas` never-loaded, `_electron.launch` "verified passing" on 45, CDP flag compatibility: all UNVERIFIED.
- Intermediate-version Chromium/Node/V8 cells and "Chromium 134→144" style range claims: corrected (baseline is 138) or marked UNVERIFIED.
- Target strings `45.2.x` / `24.22.x` / `156.0.x`: corrected to exact `45.2.1` / `24.22.1` / `156.0.8078.75`.
