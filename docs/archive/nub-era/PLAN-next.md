# Plan: remaining-work triage + next safe batch (orchestrated, spark crew)

> **SUPERSEDED 2026-09-05.** The triage completed and every item it listed has since
> shipped, merged, or parked as a reviewed open PR awaiting only a 1Password Mac
> (secrets reveal — see `STATE.md`); the file below is frozen history.

Depth: tree 3   Mode: orchestrated

## Why

Tree is clean and green (`8db2f86`, ahead 1 of origin, suite 1260/1260, tsc
clean), sweep-5 is closed D-01..D-11, and D-07..D-11 sits unreleased (0.1.15
candidate, held — no release this run). What remains is multi-area: stale web
build, WEBAPP Phase 2 router, cross-session FTS, orphaned-run list/stop, DNS
gap, Grok parity tail (resize scheduling, notify feed, secrets reveal),
browser-use skeleton, voice-call triage. Mapping before code — no blind picks.

## Objective (definition of done)

Evidence-backed remaining-work map + ONE safe batch implemented (no release,
no deploy, no version bump, test-pinned) + spark-reviewer APPROVED + full
ledger pasted with re-measured numbers.

## Contract

- Wave 1 is READ-ONLY: no edits, commits, pushes, deploys, releases.
  Read-only shell allowed (vitest, `vite build` to /tmp only, grep/rg).
  Returns capped at ~30 lines each: findings + one batch nominee.
- Wave 2 ownership is disjoint per the architect's map — never two writers
  on one file. Reviewer gates last, read-only, APPROVED or BLOCKED.
- Prod touch is banned this run (update channel, Vercel, R2, version files).
  The ahead-1 commit is NOT pushed without an explicit ask.
- Numbers are re-measured at report time or labeled unverified.

## Tree

- 1 triage (Wave 1: all 10 crew, parallel, read-only)
  - 1.I integration: gates/next-triage-GATES.md (G1-G3)
- 2 implement (Wave 2: owning agents only, disjoint files)
  - 2.I integration: gates/next-implement-GATES.md (written after batch
    selection, before Wave 2 — gates before work, per phase)
- 3 review gate (spark-reviewer, read-only, over the Wave-2 diff)
- I integration (lead): suite + tsc + gate-check re-run, ledger paste

## Risks / decisions

- Agent output volume → 30-line cap per return; lead synthesizes.
- Overlapping batch nominees → architect's ownership map decides.
- Sibling-subdomain OAuth hops outside the IdP domain stay explicit
  (D-09 follow-up, provider-side, not this run).
- `dist/` is build output: perf probes build to /tmp, never overwrite dist.

## Budget

Wave 1 bounded triage; Wave 2 one batch ≤30 min. No subagent overhead
beyond the two waves.

## Status log

- 2026-09-04: plan written. Baseline re-measured: HEAD `8db2f86` ahead 1,
  suite 1260/1260, `tsc -b` exit 0. Wave 1 fanning out.
- 2026-09-04: Wave-2 selected — test-only hardening, 6 leaves
  (gates/next-implement-GATES.md G1-G6). Ownership (disjoint, one
  writer/file): L1 spark-security → electron/security-invariants.test.mjs;
  L2 spark-perf → src/lib/__tests__/bundle-budget.test.ts; L3 spark-data →
  src/lib/__tests__/search-index.test.ts; L4 spark-backend →
  src/lib/__tests__/routines.test.ts; L5 spark-test →
  electron/update-manifest-keys.test.mjs; L6 spark-debug →
  scripts/probe-orphan-runs.mjs + src/lib/__tests__/orphan-probe.test.ts.
  Contract: no release / no deploy / no version bump; builds to /tmp only,
  never dist/; prod touch banned. Reviewer (read-only) BLOCKs on: suite not
  green or tsc dirty; any prod (non-test/gate/plan/probe) file touched;
  release/deploy/version-bump attempted; dist/ overwritten; winArm64 gap
  pinned as correct; numbers unverified.
