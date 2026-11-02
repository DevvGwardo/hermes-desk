# System stats (CPU / memory / disk) — extended draft (not wired in)

Status: **draft for review**. No source files changed. This doc is the full
spec + copy-pasteable type sketch for the cheapest route: read the CPU data
`hermes serve` already returns.

## 1. What upstream already returns

Source of truth: `~/.hermes/hermes-agent/hermes_cli/web_routers/status.py:563-617`
(`GET /api/system/stats`). Docstring: "Non-sensitive: no env values, no
paths beyond hermes home."

| Field | Shape | Notes |
|---|---|---|
| `arch` / `hostname` | `string` | stdlib `platform` |
| `python_version` / `python_impl` | `string` | display only |
| `hermes_version` | `string` | already typed in Desk |
| `cpu_count` | `number` | `os.cpu_count()` |
| `cpu_percent` | `number` | `psutil.cpu_percent(interval=0.1)` — **blocks ~100ms per call** |
| `load_avg` | `[n1, n5, n15]` | `psutil.getloadavg()` w/ `os.getloadavg()` fallback; absent on Windows |
| `memory` | `{total, available, used, percent}` | bytes + percent |
| `disk` | `{total, used, free, percent}` | scoped to hermes home |
| `uptime_seconds` | `number` | since boot |
| `process` | `{pid, rss, create_time, num_threads}` | serve process only, not Desk |
| `psutil` | `boolean` | `false` ⇒ only stdlib fields present (`load_avg` maybe, no `cpu_percent`/`memory`) |

Implication: **no backend change needed**. Desk's client type is just stale.

## 2. What Desk has today

- `src/lib/hermes-rest.ts:606-623` — `ServeSystemStats` + `getServeSystemStats()`.
  Only declares `hermes_version, hostname, memory, disk`. **Dead code: zero
  callers** (verified 2026-10-07).
- `src/components/HermesSurfacesPanel.tsx:184-191,461-479` — `usage` tab
  shows LLM tokens via `getServeUsage()`. Don't mix host stats in here.
- Route already allowlisted: `src/lib/dashboard-routes.ts:16` +
  `electron/dashboard-routes.cjs:31` (tests assert parity — no edit needed
  for this route).
- Formatters to reuse: `formatBytes` in `src/lib/usage-format.ts:32-38`.
- Polling precedent: `useEffect` + `getHostBridge()` + `setInterval` + `alive`
  flag + `clearInterval` — see `Sidebar.tsx:275-285` (60s), `ComputerPip.tsx:66`.

## 3. Extended type sketch (backwards-compatible)

Drop-in replacement for the `ServeSystemStats` block in
`src/lib/hermes-rest.ts:606-623`. All new fields optional — old serves and
`psutil:false` hosts stay renderable.

```ts
export interface ServeProcessStats {
  pid?: number;
  rss?: number;
  create_time?: number;
  num_threads?: number;
}

export interface ServeSystemStats {
  hermes_version?: string;
  hostname?: string;
  arch?: string;
  python_version?: string;
  python_impl?: string;
  cpu_count?: number;
  /** 0–100, host-wide. Absent when serve has no psutil. Poll ≥5s: each call costs ~100ms server-side (interval=0.1). */
  cpu_percent?: number;
  /** 1/5/15-min load. May be absent (Windows / minimal builds). */
  load_avg?: [number, number, number];
  uptime_seconds?: number;
  memory?: { total?: number; used?: number; available?: number; percent?: number };
  disk?: ServeDiskStats;
  process?: ServeProcessStats;
  psutil?: boolean;
  [key: string]: unknown;
}
```

Parsing rules:

1. `cpu_percent` valid only when `typeof === 'number'`, finite, `0 <= v <= 100`.
   Else treat as unknown (don't render 0 — 0% is a lie under load).
2. `load_avg` valid only when array of 3 finite numbers ≥ 0.
3. `memory.percent` / `disk.percent` same 0–100 guard; byte fields must be
   finite and ≥ 0 (reuse the `num()` guard already in `hermes-rest.ts:408-410`).
4. `psutil === false` ⇒ expect `cpu_percent`/`memory` missing; UI shows
   "limited stats (serve without psutil)" instead of zeros.

Display helpers (new, next to `usage-format.ts`):

```ts
export function cpuLabel(s: ServeSystemStats): string   // "12%" | "—"
export function loadLabel(s: ServeSystemStats): string  // "0.8 / 0.6 / 0.5" | "—"
export function uptimeLabel(s: ServeSystemStats): string // "3d 4h" | "5h 12m" | "—"
export function memLabel(m): string  // "12.1 GB of 32.0 GB (38%)" via formatBytes
export function diskLabel(d): string // same shape
```

## 4. Fetch + poll sketch (serve route, renderer)

```ts
// New hook, e.g. src/components/system/useSystemStats.ts
import { useEffect, useState } from 'react';
import { getServeSystemStats, type ServeSystemStats } from '../../lib/hermes-rest';

const POLL_MS = 10_000; // cpu_percent costs ~100ms server-side; 5s min, 10s default

export function useSystemStats(active: boolean) {
  const [stats, setStats] = useState<ServeSystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const tick = async () => {
      const s = await getServeSystemStats();
      if (!alive) return;
      if (s === null) setError('system stats unavailable');
      else { setStats(s); setError(null); }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [active]);
  return { stats, error };
}
```

Notes:

- Reuses `serveGet` (30s timeout, single-flight not needed at 10s cadence).
- No `dashboard-routes` edits (route already allowed).
- Don't poll when tab hidden / panel closed (`active` flag, same as `MemoryPane`).

## 5. UI placement (proposal, not committed)

- **Don't** extend the `usage` tab's raw key/value dump
  (`HermesSurfacesPanel.tsx:461-479` — that's LLM tokens).
- Preferred: new **`System` section** in the same slide-over (5th tab) or a
  compact row on Settings/Home status area:
  `CPU 12% · MEM 38% · DISK 61% · up 3d 4h`, tap ⇒ detail rows
  (cores, load avg, serve process RSS/threads, hermes version, hostname).
- Loading: existing `"Loading usage…"` pattern; error: existing
  `usage route unavailable` banner pattern with `system stats unavailable`.
- `psutil:false` ⇒ detail rows show `—` + one-line note, never fake zeros.

## 6. Tests to add when this gets built

- Type-guard unit tests: `cpu_percent` NaN/negative/>100/absent,
  `load_avg` wrong length/non-numeric, `psutil:false` payload, old-shape
  payload (memory+disk only — must still render).
- Label tests: `cpuLabel/loadLabel/uptimeLabel/memLabel/diskLabel` incl.
  `formatBytes` reuse.
- Hook test: polls once on mount, clears interval on unmount, ignores
  late resolve after unmount (`alive` flag).
- No Electron test changes (no new IPC in this route).

## 7. Explicitly out of scope (later, separate)

- Electron-main `hd:host:sysInfo` IPC (`os.cpus()`, `app.getAppMetrics()`,
  `process.getCPUUsage()`) — only needed for per-process Desk CPU
  (whisper.cpp is CPU-bound per `electron/main.cjs:1913`) or offline display.
  Costs: new channel in `electron/local/boot.cjs`, preload entry in
  `electron/preload.cjs:17-30`, bridge types, plus updates to
  `boot.test.mjs`, `preload.test.mjs`, `security-invariants.test.mjs`.
- Charts/history (sparkline, 24h retention). This draft is latest-values only.
- Alerting/thresholds.

## 8. Open questions for review

1. New `System` tab vs. compact status row — which surface?
2. 5s vs. 10s poll default? (`cpu_percent` costs 100ms serve-side per hit.)
3. Show serve `process.rss` (serve process) or hide it (confusing next to host MEM)?
