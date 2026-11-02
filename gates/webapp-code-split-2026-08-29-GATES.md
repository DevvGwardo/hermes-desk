# Gates — webapp code-split 2026-08-29 (improve the Maia VM web app)

Scope: hosted web client polish run. Lazy code-split the off-canvas panels
(12) + the phone shell, kill the eager mermaid/cytoscape preload, keep
Electron/Android behavior identical. Baseline: `npm run test:run` 1213/1213,
`tsc -b` clean, `build:web` 7.62s, entry `index-DN4U15P1.js` 624,716 B,
App chunk 225,463 B, index.html modulepreload'ed mermaid (2,793,508 B) +
cytoscape (646,236 B) + katex + pdf + xlsx + markdown + motion at first paint
(measured live: all fetched on the pairing screen, ~6.2 MB raw JS).

## Checks (all must be reproducibly verifiable; G8 is the behavioral gate)

- [x] G1: full vitest suite green, ≥1217 passed (1213 baseline + 4 new
  useEverOpened tests)
  CHECK: npm run test:run 2>&1 | tail -3
  EXPECT: /Tests\s+\d+ passed/ with no "failed"
  EVIDENCE: Test Files 146 passed (146) | Tests 1217 passed (1217), ~20s (1213 baseline + 4 new useEverOpened tests).

- [x] G2: typecheck clean (both tsconfigs)
  CHECK: npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit
  EXPECT: exit 0, no output
  EVIDENCE: `npx tsc --noEmit` exit 0; `npx tsc -p tsconfig.node.json --noEmit` exit 0.

- [x] G3: build:web green
  CHECK: npm run build:web 2>&1 | grep -E "built in|error"
  EXPECT: /built in/ and no error lines
  EVIDENCE: build:web "✓ built in 6.19s" (baseline 7.62s).

- [x] G4: entry chunk shrank vs baseline (624,716 B)
  CHECK: ls -la dist/assets/index-*.js | sort -rn | head -1
  EXPECT: entry < 500,000 B
  EVIDENCE: entry index-DFTlJjHN.js = 409,209 B vs baseline 624,716 B (-34.5%). App chunk App-a0LskLjD.js = 76,069 B vs 225,463 B (-66%).

- [x] G5: index.html no longer modulepreloads the heavy lazy chunks
  CHECK: grep -oE 'href="/assets/[^"]*"' dist/index.html
  EXPECT: no mermaid / cytoscape / katex / pdf- / xlsx- / sheet- in the list
  EVIDENCE: index.html preload list = only assets/index-Be0DGq1X.css (was motion + cytoscape + mermaid + css).

- [x] G6: entry chunk has no static import edge to mermaid (the
  __vitePreload-helper-in-mermaid bug is gone)
  CHECK: grep -oE 'from"\./[A-Za-z0-9_-]+\.js"' dist/assets/index-*.js | sort -u
  EXPECT: no mermaid-*.js line; preload-helper-*.js isolated chunk present
  EVIDENCE: entry static imports = motion-CQ79q8dj.js, preload-helper-uXat0MnT.js (1,286 B isolated helper), index-CV4Cquht.js (Capacitor runtime, 8,258 B). NO mermaid-*.js edge.

- [x] G7: source split is real — App.tsx statically imports none of the 12
  panels; main.tsx lazy-imports MobileApp
  CHECK: grep -cE "^import \{?[A-Za-z]+\}? from './components/(SettingsStub|KanbanPanel|McpPanel|HermesSurfacesPanel|CommandPalette|FilePreview|FilesPanel|AgentEditor|RoutineEditor|HostModal|AgentInfo|ComputerPanel)'" src/App.tsx
  EXPECT: 0
  CHECK: grep -c "lazy(() => import('./mobile/MobileApp'))" src/main.tsx
  EXPECT: 1
  EVIDENCE: App.tsx static panel imports = 0 (12 panels lazy); main.tsx lazy MobileApp = 1.

- [x] G8: BEHAVIORAL — a real headless browser fetching the built app does NOT
  download mermaid/cytoscape/katex/pdf/xlsx at first paint; the pairing screen
  renders; opening Settings fetches the SettingsStub chunk and shows the panel.
  CHECK: npx vite preview --port 4173 & node /tmp/verify-codesplit.cjs
  EXPECT: "NONE ✓ (all lazy)", "SETTINGS PANEL VISIBLE: true"
  EVIDENCE: first paint fetched index css/js + preload-helper + motion + App +
  ChatPanel + markdown + audit-log (8 assets, ~930 KB raw); heavy lazy chunks
  NONE ✓; Settings click → SettingsStub-D7xe5cRE.js fetched → panel visible.
  (401s in the probe are the expected fake-session API calls — the same 4×401
  the pre-change live build produced with a fake session.)
