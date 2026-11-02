# Gates — Production Hardening + loop/improve Integration — DONE

> **SUPERSEDED 2026-08-28.** The "Final State" block below is a frozen Aug-24 snapshot and its
> last two lines are NO LONGER TRUE as instructions: the `loop/improve-hygiene` branch was
> merged, so "Ready for PR to main" and "Next: open PR" are void. Phase 1/Phase 2 checkboxes
> above remain valid history. Current branch state lives in `STATE.md`.

## Phase 1 — Critical Blockers (GREEN) — commit 666f745
- [x] G1 ErrorBoundary
- [x] G2 logger (0 raw console)
- [x] G3 fs-guard realpath
- [x] G4 sheet 12MB + cellFormula
- [x] G5 dump nonce + /tmp/nub-*
- [x] G6 vmDest isInsideRoot
- [x] G7 Vite chunks 594k
- [x] G8 SECURITY.md
- [x] G9 mermaid strict / katex throwOnError
- [x] G10 792 tests, TSC 0, build 5.42s

## Phase 2 — loop/improve Integration (GREEN) — merge 3d22e29
30 commits merged from loop/improve (no bulk, verified). 42 files, +1211/-421, 90 new tests.

- [x] Perf (5): rAF coalesce (plugin host + ComputerPanel), visibility-gated polls, WeakMap screenshot memo, skip no-op audit setState, skip palette corpus rebuild — **why**: less layout thrash, battery, jank on stream ticks
- [x] A11y (5): AppModal/CopyPermissionModal focus trap + Escape, aria-labels on icon buttons — **why**: keyboard-only users were trapped
- [x] Type (6): drop as any / as unknown as, narrow any->unknown — **why**: fail loudly at compile, not silently at runtime
- [x] Dead code (6): 436 lines deleted (MOCK_AGENTS, stickySpring, etc.) — **why**: smaller bundle, less confusion, grep proved 0 importers
- [x] Tests (8): cat-face, hermes, kanban, notifications, spawn, updates, vm-fs-http, hermes-profiles, app-modal — **why**: guard regressions, covers perf/a11y paths
- [x] Conflict: maiavm-api.ts InstanceSummary removal kept (dead, 0 importers)
- [x] Fix: hermes-profiles.test persona! for strict null check
- [x] Verify: 125 files 882 tests, TSC 0, build 592k (shrank 2k from dead code)

## Final State
- Branch: loop/improve-hygiene@3d22e29 — 60 ahead of main, pushed to origin
- loop/improve now fully merged — can be deleted (its 30 commits are in hygiene)
- Ready for PR to main — prod hardening + hygiene in one verified branch
- Next: open PR, delete stale /tmp/grok-goal worktree (prunable)

Check: `npm run test:run` 125/882, `npx tsc -b` 0, `npm run build` 5.35s 592k main
