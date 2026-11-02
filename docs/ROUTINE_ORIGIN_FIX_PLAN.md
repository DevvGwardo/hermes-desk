# Plan: Fix host cron jobs showing as VM-agent routines

**Date:** 2026-08-15
**Status:** Draft — needs review before implementation

## Problem

The Agent info dialog (AlienNub, "remote") lists routines that live on the
**host Mac**, not on the linked VM: `cheeksbase-maintenance`,
`ig-db-backup-clone`, `overnight-audit`, `log-rotator`, `ig-cookie-refresh`,
`error-lessons-nightly`, `learning-loop-dashboard-sync`, `solana-daily-watch`,
`workflow-journal-latest-rotator`, `ig-cookie-auto-refresh`,
`game-improvement-loop`, `trader-sim`. These are the host's `~/.hermes` cron
jobs (script jobs, `no_agent: true`) and should not appear as the VM agent's
routines.

## Root cause (verified)

1. `loadRoutines()` (`src/lib/routines.ts:303`) tries, in order:
   - VM dashboard REST `GET /api/cron/jobs` via `serveGet()` → `nubVmRest`
     (Electron → `nubLink.vmRestHandle`)
   - host `hermes serve` at `127.0.0.1:9119`
   - host `hermes cron list` via IPC (`electron/main.cjs:477` →
     `listCronJobsFromDisk()` reads `~/.hermes/cron/jobs.json`)
2. At load time both REST paths failed:
   - host serve is down (nothing on `127.0.0.1:9119`, connection refused)
   - a VM link session exists (`nub-desktop-session.bin` present), so
     `serveGet()` went through the VM dashboard proxy and returned null —
     VM `/api/cron/jobs` unreachable (route exists in hermes-agent
     `web_routers/cron.py`, so this is an availability failure, not a
     missing route — confirm on the VM whether `hermes dashboard` is up)
3. The host CLI fallback succeeded, so `routineCache` filled with host jobs
   (`origin: 'hermes'`).
4. `App.tsx:911` passes `routineCache` straight to `AgentInfo`, which renders
   all jobs with **no origin badge and no filtering** — host jobs look like
   the VM agent's own routines. The dialog copy says "Routines are recurring
   tasks this agent runs on a schedule", which is false for host jobs.

Secondary hazard found while tracing:

- `upsertRoutine()` (`src/lib/routines.ts:350`) falls back to
  `createHermesCliJob()` when `createServeCron` fails — i.e. **creating a
  routine while the VM scheduler is unreachable silently writes the job to
  the HOST's cron store**. Same misattribution, in the write direction.

## Goals

1. A remote VM agent's dialog never shows host-origin routines.
2. Origin is honest everywhere it appears (badge/label: VM / Host / Draft).
3. Routine creation never silently lands on the wrong machine.
4. All existing tests stay green; new tests cover the filtering logic.

## Design decisions

- Keep the host CLI fallback in `loadRoutines()` — it exists so the palette
  and the host-only mode still work when the VM is down. Instead, make the
  **UI origin-aware**:
  - **AgentInfo dialog** (VM agent context): when a VM is linked but the VM
    cron route failed, show an empty state ("VM scheduler unreachable" +
    Retry) instead of host jobs. When no VM is linked, host jobs are correct
    to show but must be labeled "Host".
  - **CommandPalette** (app-level context): keep showing whatever loaded,
    with origin badges. No behavior change.
- No per-agent scoping in this pass: hermes cron jobs have no agent binding
  (only local drafts carry `agentId`). Fixing attribution, not inventing
  scoping.

## Slices

### Slice 1 — Track the routine source in App state

- `App.tsx` `refreshRoutines()`: store `loadRoutines()`'s `source` alongside
  `routineCache` (new state `routineSource: RoutineOrigin | 'none'` —
  reuse the `source: 'remote' | 'hermes' | 'local'` return).
- Verify: `routineSource` correct in devtools for linked-VM-down and
  host-only scenarios.

### Slice 2 — AgentInfo: hide host jobs when VM is linked

- Add props to `AgentInfo`: `routineSource` and `vmLinked` (already
  available in App as `nubLinked` state).
- Filter in `App.tsx` before passing (keep the dialog dumb): when
  `vmLinked && routineSource === 'hermes'`, pass `routines={[]}` plus a
  `routineError` string like "VM scheduler unreachable — retry".
- Dialog empty state already supports `cronError` text (AgentInfo.tsx:621);
  add a Retry button wired to `refreshRoutines`.
- Verify: linked VM + dead cron route → dialog shows unreachable state, no
  host jobs. Host-only mode → host jobs still listed (Slice 3 labels them).

### Slice 3 — Origin badges

- In the dialog's routine rows, show a small badge: `remote` → "VM",
  `hermes` → "Host", `local` → "Draft".
- Optional same badge in CommandPalette routine rows (palette already has
  origin in the row model).
- Verify: badge renders per origin in both surfaces.

### Slice 4 — Guard routine creation against silent host writes

- In `upsertRoutine()`: when a VM link is present but `createServeCron`
  returns null, do **not** fall through to `createHermesCliJob()`. Instead
  return a typed error ("VM scheduler unreachable — routine not saved")
  which the editor surfaces.
- Host-only mode (no link) keeps the CLI fallback.
- Verify: create while VM cron down → error toast, host `~/.hermes/cron`
  unchanged. Host-only → create still works.

### Slice 5 — Tests

- Unit: extract the dialog filter as a pure function
  (`routinesForAgentInfo(routines, source, vmLinked)`) and test all four
  combinations (linked×remote, linked×hermes, unlinked×hermes, local
  drafts).
- Unit: `upsertRoutine` linked-VM failure path throws/no-ops on host.
- Component: AgentInfo renders badges; renders unreachable state + Retry
  when passed the error string.
- Run `npm run test:run` (154 existing tests must stay green) and
  `npm run build` (tsc + vite).

### Slice 6 — Confirm the VM side & docs

- On the VM, confirm whether `hermes dashboard`/serve is running and
  `/api/cron/jobs` responds (health check through the desktop proxy or
  maiavm.com API). If it's down, note whether that's a separate ops issue
  to fix or expected.
- Update `STATE.md` with a verified-facts entry for the fallback
  misattribution and the new origin-aware behavior.

## Out of scope

- Per-agent routine scoping on the VM (hermes cron has no agent binding).
- Changing the `loadRoutines()` fallback chain itself.
- Alerting/ops tooling for the VM scheduler being down.

## Success criteria

- [ ] Linked VM + unreachable VM cron: AlienNub dialog shows no host jobs.
- [ ] Host-only mode: host jobs visible, labeled "Host".
- [ ] Linked VM + reachable VM cron: VM jobs listed as before.
- [ ] Creating a routine never silently writes to the host when linked.
- [ ] `npm run test:run` green; `npm run build` green.
