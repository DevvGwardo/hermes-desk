# Script triage — 2026-08-18 (46 untracked scripts, full sweep)

Decision per file, recorded before commit. KEEP = ship in repo (feature/tooling/test
value). DECLINE = one-off capture/probe/demo artifact; moved to
`~/maiavm-desktop-scratch/2026-08-18/` (outside the repo) so nothing is destroyed
and the working tree is clean. 20 kept, 26 declined.

## KEEP (20) — commit as tooling

| # | file | reason |
|---|------|--------|
| 1 | scripts/android-assets.py | Nub splash + Play feature graphic generator (used by the committed mobile work) |
| 2 | scripts/assemble-grok-orb.mjs | Rebuilds `src/lib/grok-orb/core.js` from extracted Grok source |
| 3 | scripts/epipe-guard-test.sh | Regression test for the EPIPE guard in electron main |
| 4 | scripts/gen-y3-ts.mjs | Regenerates `src/lib/creature-mark/eyes-y3.ts` from grok Y3 JSON |
| 5 | scripts/hermes-chat-proxy.mjs | Local chat proxy (CORS/auth shim) for dev |
| 6 | scripts/hermes-chat-proxy.test.mjs | Unit test for the proxy |
| 7 | scripts/hermes-preview-router.py | VM preview/computer/zip routes overlay for cubes on older Hermes |
| 8 | scripts/mobile-prod-smoke.mjs | Mobile prod build smoke |
| 9 | scripts/normal-launch-check.sh | Packaged-app launch sanity check |
| 10 | scripts/orb-geometry-smoke.mjs | Orb area/ratio verification |
| 11 | scripts/orb-inspect-smoke.mjs | Orb DOM inspection |
| 12 | scripts/parity-check.mjs | Headless Grok-parity smoke |
| 13 | scripts/plugins-tools-smoke.mjs | Plugins + tools smoke |
| 14 | scripts/reactions-replies-smoke.mjs | Reactions/replies smoke |
| 15 | scripts/relaunch.sh | Kill + relaunch packaged app (dev iteration) |
| 16 | scripts/search-palette-smoke.mjs | Search palette smoke |
| 17 | scripts/sidebar-grok-parity-smoke.mjs | Sidebar parity smoke |
| 18 | scripts/ssr-all-shapes.mjs | SSR across icon shapes |
| 19 | scripts/stt-local-probe.mjs | STT probe — referenced by `gates/dictate-local-stt.md` G2 |
| 20 | scripts/verify-agent-editor.mjs | Agent editor verification |

## DECLINE (26) — moved to scratch archive, not committed

| # | file | reason |
|---|------|--------|
| 21 | scripts/cat-preview.tsx | Dev preview scratch |
| 22 | scripts/crash-repro.tsx | One-off repro |
| 23 | scripts/default-shape-check.tsx | Dev scratch |
| 24 | scripts/demo-loop-test.tsx | Demo scratch |
| 25 | scripts/engine-fx-single-shot.py | One-off FX screenshot |
| 26 | scripts/extract_nqe.py | One-off extraction probe |
| 27 | scripts/fx-closeup-shot.py | One-off screenshot |
| 28 | scripts/fx-dom-dump.py | One-off DOM dump |
| 29 | scripts/fx-dom-probe.py | One-off probe |
| 30 | scripts/fx-grid-framed-shot.py | One-off screenshot |
| 31 | scripts/fx-grid-shot.py | One-off screenshot |
| 32 | scripts/fx-motion-shot.py | One-off screenshot |
| 33 | scripts/fx-peak-shot.py | One-off screenshot |
| 34 | scripts/fx-position-trace.py | One-off probe |
| 35 | scripts/gen-cat-variants.mjs | Preview-variant generator (outputs committed) |
| 36 | scripts/gen-creature-mark-preview.mjs | Preview scratch |
| 37 | scripts/gen-kitten-path.mjs | Preview scratch |
| 38 | scripts/gen-orb-icon.py | Orb icon render scratch |
| 39 | scripts/orb-shape-demo.tsx | Demo scratch |
| 40 | scripts/send-trajectory.py | One-off probe |
| 41 | scripts/settings-overflow-probe.py | One-off probe |
| 42 | scripts/settings-shot-bottom.py | One-off screenshot |
| 43 | scripts/settings-shot.py | One-off screenshot |
| 44 | scripts/sidebar-budget.tsx | Perf probe scratch |
| 45 | scripts/sidebar-liveness.tsx | Probe scratch |
| 46 | scripts/wiggle-probe.tsx | Probe scratch |

_Note (2026-09-06): row 38's `scripts/gen-orb-icon.py` never existed in the
tree; the canonical icon generator is now `scripts/build-icons.mjs`._

## Also declinated

- `.hermes/plans/2026-08-16_214000-maiavm-prod-only-transport.md` — runtime-dir
  duplicate of the tracked `docs/plans/2026-08-16-maiavm-prod-only-transport.md`;
  moved to the archive, `.hermes/` removed from the tree.