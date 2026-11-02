# Webapp improvement audit — 2026-08-29

Read-only audit of the hosted web client (https://agent-nub-lol.vercel.app,
same tree as Electron/Android) → ranked findings → bounded implementation.
Audit sources: `docs/WEBAPP_PLAN.md`, `docs/maiavm-feature-gaps.md`,
`docs/ANIMATION_FLUENCY_GAP.md`, `docs/SUBAGENTS_AND_MULTI_AGENT.md`,
`docs/BLOB_FX.md`, `GATES.md`, `STATE.md`, live headless-Chromium render of the
prod site, and a fresh local `build:web` (deterministic hash == live:
`index-DN4U15P1.js` / `App-Dk4mnNoT.js`).

Baseline: `npm run test:run` **1213/1213** (145 files), `tsc -b` clean,
`build:web` 7.62s. Live app renders the pairing screen with **0 console errors,
0 page errors**; a11y names on all interactive elements; Tab focus works;
`role="alert"` + `aria-live="polite"` on pairing status; focus trap +
`aria-modal` in AppModal; GrokOrb already pauses rAF on
`prefers-reduced-motion` and off-screen (IntersectionObserver). Those are
DONE — not findings.

## Findings (ranked: severity × user impact × effort)

### P0-1 — First paint pulls the ENTIRE bundle graph (~6.2 MB raw / ~1.6 MB gz) [perf · HIGH]
`dist/index.html` emits `<link rel="modulepreload">` for **mermaid
(2,793,508 B), xlsx (940,195 B), cytoscape (646,236 B), pdf (479,344 B), katex
(261,183 B), markdown (157,052 B), motion (138,317 B)** — the pairing screen
(which needs one button + one code) downloads all of them on load. Root cause:
`App.tsx` statically imports every off-canvas panel (`SettingsStub` 1,385 lines,
`CommandPalette`, `FilePreview` → `lib/preview/markdown-math` → **mermaid**
static import, `HermesSurfacesPanel`, `KanbanPanel`, `McpPanel`, `FilesPanel`,
`AgentInfo`, `AgentEditor`, `RoutineEditor`, `HostModal`, `ComputerPanel`) and
`main.tsx` statically imports the entire `src/mobile/*` phone shell (~2,100
lines) into the desktop/web entry. `manualChunks` splits vendor files but the
imports stay eager, so every split chunk is still fetched.
**Fix (Phase 1 of WEBAPP_PLAN):** `React.lazy` + render-on-first-open the
panels; lazy `MobileApp` in `main.tsx`. Expected: mermaid/katex/pdf/xlsx/
cytoscape drop out of the initial preload list entirely; entry shrinks by the
mobile shell's weight. Electron/Android share the same tree: Electron also
loads faster; the phone shell keeps a splash fallback so the APK's boot look
is unchanged.

### P1-2 — No routing / deep links (Phase 2 of WEBAPP_PLAN) [ux · MED]
Every panel is a boolean; the URL never changes; refresh always lands on the
root; no ⌘K-deep-link, no shareable state. A hash router (`#/settings` etc.)
would fix back/forward + reload survival. **Deferred** — code-splitting first
(router on lazy panels is the natural follow-up).

### P1-3 — Lazy panels have no loading affordance [ux · LOW-MED]
Once panels are lazy, the first open pays a chunk load. Without a fallback the
modal flashes nothing for 100–300 ms. Fix: small centered `PanelFallback`
spinner for the heavy ones, `null` for instant ones.

### P2-4 — Reduced-motion + animation budget — already handled [a11y · DONE]
`GrokOrb` pauses its rAF loop under `prefers-reduced-motion: reduce` and stops
when off-screen (grok-orb-gating test exists). No action needed. (The
`ANIMATION_FLUENCY_GAP` P0 imperative-paint refactor is a fluency project, not
a web-polish blocker — out of scope here.)

### P2-5 — Pairing flow — already solid [ux · DONE]
Live screen: code chip w/ `aria-label`, copy, "Open Telegram" deep link,
`maiavm.com/pair#token=` fallback, "I have a code" paste path, `role="alert"`
error + Try again, `aria-live` hint. 0 console errors. Pairing CORS fix is
live (commit 6364a99). Nothing to fix.

### P2-6 — Error recovery — already solid [ux · DONE]
Fake-session boot shows "Couldn't load agents from the VM." + Retry, and
"Connecting…" while transport resolves. No dead-end states observed.

### P3-7 — Mobile shell boots in a phone browser (≤720px) [ux · LOW]
`MobileApp` renders correctly in a 390px browser viewport (pairing screen with
"Preview without linking", 0 errors) — the 720px switch works. Its lazy
extraction is safe for the native APK (splash fallback).

## Implemented this run (see gates/webapp-code-split-2026-08-29-GATES.md)

1. **Code-split off-canvas panels** (12 panels lazy via `React.lazy` +
   `useEverOpened` — state-preserving mount-once) + **lazy `MobileApp`** in
   `main.tsx` with a Nub-splash fallback.
2. **`PanelFallback`** loading affordance for the heavy lazy panels.
3. Artifact-verified: `index.html` preload list drops mermaid/katex/pdf/xlsx/
   cytoscape; entry + App chunk shrink; bundle delta recorded below.

## Before/after (build:web)

| Asset | Before | After | Delta |
|---|---|---|---|
| index-*.js (entry) | 624,716 | 409,209 | **-215,507 (-34.5%)** |
| App-*.js | 225,463 | 76,069 | **-149,394 (-66%)** |
| ChatPanel-*.js (own chunk) | (in App) | 148,973 | — |
| Initial JS fetched at first paint | ~6.2 MB raw (9 chunks: index, App, mermaid 2.79MB, xlsx 940KB, cytoscape 646KB, pdf 479KB, katex 261KB, markdown 157KB, motion 138KB) | ~930 KB raw (8 assets: index, preload-helper 1.3KB, motion, App, ChatPanel, markdown, audit-log, css) | **~6.7× less** |
| Heavy lazy chunks fetched at load | mermaid+cytoscape+katex+pdf+xlsx (5.1MB) | **NONE** (verified in headless browser) | 5.1MB → 0 |

Also: `modulePreload:false` + preload-helper isolated chunk in vite.config.ts —
see the config comment for the rollup helper-parking bug that made the pairing
screen download mermaid.
