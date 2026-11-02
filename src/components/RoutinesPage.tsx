/**
 * Routines main view (`#/routines`): every scheduled job in one place,
 * replacing the chat in the main pane. Rows group into Active / Paused;
 * a row opens the existing RoutineEditor, the switch pauses or resumes
 * in place, and "Run now" reuses the editor's test-run path.
 *
 * Pure view: App owns the data (the same routine cache the palette and the
 * Info panel read) and every write.
 */

import { useEffect, useState } from 'react'
import type { Routine } from '../lib/routines'
import { describeRoutineSchedule, displayRoutineName, nextRunAt } from '../lib/routines'
import { deliveryRowLabel } from '../lib/routine-cron'
import { PillSwitch } from './PillSwitch'
import { RoutineTemplates } from './RoutineTemplates'
import { startAdaptivePoll } from '../lib/poll-cadence'

export interface RoutinesPageProps {
  routines: Routine[]
  /** First load (or a refresh with nothing cached yet). */
  loading?: boolean
  onClose: () => void
  onCreate: () => void
  onOpen: (job: Routine) => void
  /** Pause / resume in place. Omitted ⇒ the row opens the editor instead. */
  onToggle?: (job: Routine, enabled: boolean) => Promise<void>
  /** Omitted ⇒ no Run now button. */
  onRunNow?: (job: Routine) => Promise<void>
  /** A template created a routine on the agent — refresh the list. */
  onTemplateCreated?: () => void
  /** Re-read the routines. Called every few seconds while one is running, so
   *  "Running…" turns into "Finished" without a reload. */
  onRefresh?: () => void
  /** The linked agent's scheduler didn't answer: its routines aren't listed. */
  unreachable?: boolean
  onRetry?: () => void
  /** Where the back link goes, in words ("Back to chat" on desktop; the
   *  phone shell returns to its home list). */
  backLabel?: string
}

/** How often the page re-reads routines while one runs. */
export const RUNNING_POLL_MS = 8_000
/** After Run now, show "Running…" this long while the agent claims the run. */
const LOCAL_START_GRACE_MS = 3 * 60_000
/** A run that ended this recently shows its outcome instead of the schedule. */
const RECENT_OUTCOME_MS = 15 * 60_000

/** "Active (2)" / "Paused (1)": enabled first, each keeping list order. */
export function groupRoutines(routines: Routine[]): { active: Routine[]; paused: Routine[] } {
  return {
    active: routines.filter((r) => r.enabled !== false),
    paused: routines.filter((r) => r.enabled === false),
  }
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function formatNext(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  try {
    const soon = ms - now < 6 * 86_400_000
    return d.toLocaleString(
      undefined,
      soon
        ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
        : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
    )
  } catch {
    return d.toISOString()
  }
}

function formatAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const days = Math.round(h / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/** Schedule in words, then where it runs / where results go. */
function rowMeta(job: Routine): string {
  return [
    job.schedule ? describeRoutineSchedule(job) : 'No schedule',
    job.origin === 'hermes' ? 'On this computer' : job.origin === 'local' ? 'Draft' : null,
    job.origin === 'remote' ? [job.profile, deliveryRowLabel(job.deliver)].filter(Boolean).join(' · ') : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

/** When this row's run started: the agent's own signal, or our Run now
 *  while the agent hasn't claimed it yet. Null = not running. */
export function runningStartMs(job: Routine, localStart: number | undefined, now = Date.now()): number | null {
  const server = parseMs(job.runningSince)
  if (server != null) return server
  if (localStart == null || now - localStart > LOCAL_START_GRACE_MS) return null
  const last = parseMs(job.lastRunAt)
  // The run already recorded its outcome.
  if (last != null && last >= localStart - 5_000) return null
  return localStart
}

export type RowStatus =
  | { kind: 'running'; text: string }
  | { kind: 'ok' | 'failed' | 'warn'; text: string }
  | { kind: 'idle'; text: string; failedSuffix?: string }

/** The row's third line: running, a fresh outcome, or the schedule. */
export function rowStatus(job: Routine, startMs: number | null, now = Date.now()): RowStatus {
  if (startMs != null) return { kind: 'running', text: `Running… ${formatElapsed(now - startMs)}` }
  const last = parseMs(job.lastRunAt)
  const status = job.lastStatus ?? null
  if (last != null && now - last < RECENT_OUTCOME_MS && status) {
    const ago = formatAgo(last, now)
    if (status === 'error') {
      const why = job.lastError ? ` · ${job.lastError.split('\n')[0].slice(0, 120)}` : ''
      return { kind: 'failed', text: `Failed ${ago}${why}` }
    }
    if (status === 'delivery_failed') return { kind: 'warn', text: `Finished ${ago}, but couldn’t deliver the result` }
    return { kind: 'ok', text: `Finished ${ago}` }
  }
  if (status === 'error' && last != null) {
    return { kind: 'idle', text: rowTiming(job, false), failedSuffix: `Last run failed ${formatAgo(last, now)}` }
  }
  return { kind: 'idle', text: rowTiming(job) }
}

/** "Next Tue 8:28 PM · Last ran 2 h ago" (either part may be missing). */
function rowTiming(job: Routine, withLast = true): string {
  const parts: string[] = []
  if (job.enabled !== false) {
    const next = parseMs(job.nextRunAt) ?? (job.origin === 'local' && job.schedule ? nextRunAt(job.schedule) : null)
    if (next != null) parts.push(`Next ${formatNext(next)}`)
  }
  if (withLast) {
    const last = parseMs(job.lastRunAt)
    parts.push(last != null ? `Last ran ${formatAgo(last)}` : 'Hasn’t run yet')
  }
  return parts.join(' · ')
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 5.5v13l10-6.5-10-6.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}

function RoutineRow({
  job,
  startMs,
  now,
  onStarted,
  onOpen,
  onToggle,
  onRunNow,
}: {
  job: Routine
  startMs: number | null
  now: number
  onStarted: (job: Routine) => void
  onOpen: (job: Routine) => void
  onToggle?: (job: Routine, enabled: boolean) => Promise<void>
  onRunNow?: (job: Routine) => Promise<void>
}) {
  const [busy, setBusy] = useState<'toggle' | 'run' | null>(null)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const enabled = job.enabled !== false
  const name = displayRoutineName(job)

  const toggle = async (next: boolean) => {
    if (!onToggle) {
      onOpen(job)
      return
    }
    // The row moves between Active and Paused (a remount), so a keyboard
    // user's focus would fall to the page: put it back on this switch.
    const switchHadFocus =
      document.activeElement?.getAttribute('role') === 'switch' &&
      document.activeElement.closest('[data-routine-id]')?.getAttribute('data-routine-id') === String(job.id)
    setBusy('toggle')
    setNote(null)
    try {
      await onToggle(job, next)
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'Couldn’t change this routine.', error: true })
    } finally {
      setBusy(null)
      if (switchHadFocus) {
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(`[data-routine-id="${CSS.escape(String(job.id))}"] [role="switch"]`)
            ?.focus()
        })
      }
    }
  }

  const run = async () => {
    if (!onRunNow) return
    setBusy('run')
    setNote(null)
    try {
      await onRunNow(job)
      onStarted(job)
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'Couldn’t start this routine.', error: true })
    } finally {
      setBusy(null)
    }
  }

  // The page clock only ticks while something runs; idle rows read the real one.
  const status = rowStatus(job, startMs, startMs != null ? now : Date.now())
  const running = status.kind === 'running'
  const dot = running
    ? 'bg-[var(--ca-primary)] animate-pulse'
    : status.kind === 'failed' || (status.kind === 'idle' && status.failedSuffix)
      ? 'bg-[var(--ca-danger)]'
      : enabled
        ? 'bg-[var(--ca-success)]'
        : 'bg-[var(--ca-border-strong)]'
  const tone =
    status.kind === 'running'
      ? 'text-[var(--ca-primary-text)]'
      : status.kind === 'ok'
        ? 'text-[var(--ca-success-text)]'
        : status.kind === 'failed'
          ? 'text-[var(--ca-danger)]'
          : status.kind === 'warn'
            ? 'text-[var(--ca-warn-text)]'
            : ''

  return (
    <li className="flex items-center gap-2 bg-[var(--ca-card)] pr-3 transition hover:bg-[var(--ca-primary-soft)]" data-routine-id={job.id} data-routine-status={status.kind}>
      <button
        type="button"
        onClick={() => onOpen(job)}
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3.5 text-left"
        aria-label={`${name}, ${rowMeta(job)}`}
      >
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--ca-ink)]">{name}</span>
          <span className="block truncate text-[12px] text-[var(--ca-ink-muted)]">{rowMeta(job)}</span>
          <span className="block truncate text-[11px] text-[var(--ca-ink-muted)]" role={running ? 'status' : undefined}>
            {note ? (
              <span className={note.error ? 'text-[var(--ca-danger)]' : 'text-[var(--ca-success-text)]'}>{note.text}</span>
            ) : status.kind === 'idle' ? (
              <>
                {status.text}
                {status.failedSuffix ? (
                  <>
                    {status.text ? ' · ' : ''}
                    <span className="text-[var(--ca-danger)]">{status.failedSuffix}</span>
                  </>
                ) : null}
              </>
            ) : (
              <span className={tone}>{status.text}</span>
            )}
          </span>
        </span>
      </button>
      {onRunNow ? (
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy !== null || running}
          aria-label={running ? `${name} is running` : `Run ${name} now`}
          title={running ? 'Running now' : 'Run it now, without waiting for its time'}
          className="nub-touch-44 inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)] transition hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)] disabled:opacity-50"
        >
          <PlayIcon />
          <span aria-hidden="true" className="hidden sm:inline">
            {running ? 'Running' : 'Run now'}
          </span>
        </button>
      ) : null}
      <PillSwitch
        label={enabled ? `Pause ${name}` : `Resume ${name}`}
        title={enabled ? 'On: runs on its schedule. Click to pause.' : 'Paused: won’t run. Click to turn on.'}
        checked={enabled}
        busy={busy !== null}
        onChange={(next) => void toggle(next)}
      />
    </li>
  )
}

function Group({
  label,
  jobs,
  starts,
  ...row
}: {
  label: string
  jobs: Routine[]
  starts: (job: Routine) => number | null
  now: number
  onStarted: (job: Routine) => void
  onOpen: (job: Routine) => void
  onToggle?: (job: Routine, enabled: boolean) => Promise<void>
  onRunNow?: (job: Routine) => Promise<void>
}) {
  if (jobs.length === 0) return null
  return (
    <section aria-label={label} className="space-y-2">
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--ca-ink-soft)]">
        {label} <span className="font-normal">({jobs.length})</span>
      </h2>
      <ul className="divide-y divide-[var(--ca-border)] overflow-hidden rounded-xl border border-[var(--ca-border)]">
        {jobs.map((job) => (
          <RoutineRow key={`${job.origin}:${job.profile ?? 'default'}:${job.id}`} job={job} startMs={starts(job)} {...row} />
        ))}
      </ul>
    </section>
  )
}

export function RoutinesPage({
  routines,
  loading = false,
  onClose,
  onCreate,
  onOpen,
  onToggle,
  onRunNow,
  onTemplateCreated,
  onRefresh,
  unreachable = false,
  onRetry,
  backLabel = 'Back to chat',
}: RoutinesPageProps) {
  const { active, paused } = groupRoutines(routines)
  const empty = routines.length === 0
  // Run now starts, keyed by routine, until the agent reports the run.
  const [localStarts, setLocalStarts] = useState<Record<string, number>>({})
  const [now, setNow] = useState(() => Date.now())
  const keyOf = (job: Routine) => `${job.origin}:${job.profile ?? 'default'}:${job.id}`
  const starts = (job: Routine) => runningStartMs(job, localStarts[keyOf(job)], now)
  const anyRunning = routines.some((job) => starts(job) != null)

  // While something runs: tick the elapsed time every second and re-read
  // the routines every few seconds, so the row turns into its outcome.
  useEffect(() => {
    if (!anyRunning) return
    let tick: ReturnType<typeof setInterval> | null = null
    const syncClock = () => {
      if (tick) clearInterval(tick)
      tick = null
      if (!document.hidden) {
        setNow(Date.now())
        tick = setInterval(() => setNow(Date.now()), 1_000)
      }
    }
    syncClock()
    document.addEventListener('visibilitychange', syncClock)
    const poll = onRefresh ? startAdaptivePoll(onRefresh, RUNNING_POLL_MS, { immediate: false, live: () => true }) : null
    return () => {
      if (tick) clearInterval(tick)
      poll?.()
      document.removeEventListener('visibilitychange', syncClock)
    }
  }, [anyRunning, onRefresh])

  const onStarted = (job: Routine) => {
    const at = Date.now()
    setLocalStarts((prev) => ({ ...prev, [keyOf(job)]: at }))
    setNow(at)
    onRefresh?.()
  }
  const rowProps = { starts, now, onStarted, onOpen, onToggle, onRunNow }

  return (
    <div
      className="ca-enter flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--ca-canvas)]"
      data-testid="routines-page"
    >
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6 sm:py-8">
          <button
            type="button"
            onClick={onClose}
            className="-ml-1 mb-3 inline-flex min-h-11 items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium text-[var(--ca-ink-soft)] transition hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)] sm:min-h-0"
            title={`${backLabel} · Esc`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {backLabel}
          </button>
          {/* Text straight on the sky canvas uses --ca-ink-soft: --ca-ink-muted
              measures 3.6:1 there, under the 4.5:1 floor (tools/blueprint/themes.mjs). */}
          <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-[20px] font-semibold text-[var(--ca-ink)]">Routines</h1>
              <p className="mt-0.5 text-[13px] text-[var(--ca-ink-soft)]">
                Things your agent does on a schedule, like a morning briefing or a weekly check-in.
              </p>
            </div>
            <button type="button" onClick={onCreate} className="nub-touch-44 nub-btn-primary shrink-0 px-3.5 py-1.5 text-[13px]">
              New routine
            </button>
          </header>

          {unreachable && !loading ? (
            <div
              role="status"
              className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-3.5 py-3 text-[13px] text-[var(--ca-ink-muted)]"
            >
              <span>Can’t reach your agent right now, so its routines aren’t shown.</span>
              {onRetry ? (
                <button type="button" onClick={onRetry} className="nub-chip shrink-0 px-3 py-1 text-[12px] font-medium">
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}

          {loading && empty ? (
            <div className="space-y-2" aria-busy="true" aria-label="Loading routines">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton-shine h-14 rounded-xl" style={{ animationDelay: `${i * 160}ms` }} />
              ))}
            </div>
          ) : empty && unreachable ? null : empty ? (
            <div className="space-y-4">
              <p className="rounded-xl bg-[var(--ca-primary-soft)] px-3.5 py-3 text-[13px] text-[var(--ca-ink-muted)]">
                Nothing scheduled yet. Start from a template below, or write your own with New routine.
              </p>
              <div className="nub-card p-4">
                <h2 className="mb-2 text-[13px] font-semibold text-[var(--ca-ink)]">Start from a template</h2>
                <RoutineTemplates onCreated={() => onTemplateCreated?.()} onCancel={onCreate} />
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <Group label="Active" jobs={active} {...rowProps} />
              <Group label="Paused" jobs={paused} {...rowProps} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
