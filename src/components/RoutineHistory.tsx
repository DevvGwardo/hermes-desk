/**
 * A routine's results: its runs with status and time, and the selected run's
 * output rendered as markdown (the agent writes reports in it), with hermes'
 * `[SILENT]` marker shown as a "Not sent" chip, not text.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AGENT_OUTDATED_COPY,
  listRoutineRuns,
  readRunOutputDetailed,
  SILENT_RUN_TEXT,
  type Loaded,
  type RoutineRun,
  type RunStatus,
} from '../lib/routine-cron'
import { MessageBody } from './MessageBody'
import { formatFriendlyWhen } from '../lib/friendly-time'

const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running now',
  ok: 'Done',
  failed: 'Didn’t finish',
}

const STATUS_CLASS: Record<RunStatus, string> = {
  running: 'bg-[var(--ca-primary-soft)] text-[var(--ca-primary-text)]',
  ok: 'bg-[var(--ca-success)]/15 text-[var(--ca-success-text)]',
  failed: 'bg-[var(--ca-danger)]/15 text-[var(--ca-danger)]',
}

function formatDuration(run: RoutineRun): string {
  if (run.startedAt == null || run.endedAt == null) return ''
  const s = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000))
  // Under a second isn't a real run length (a row closed as it was written).
  if (s < 1) return ''
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`
}

type OutputState =
  | { state: 'loading' }
  | { state: 'done'; text: string; silent: boolean }
  | { state: 'empty' }
  | { state: 'error' }

/** "Today, 8:29 PM" / "Yesterday, 8:29 PM" / "Thu, Oct 2, 8:29 PM". */
export function formatRunWhen(ms: number | null, now = Date.now()): string {
  return formatFriendlyWhen(ms, now)
}

/** While a run is going (or one was just started), re-read this often. */
export const RESULTS_POLL_MS = 10_000
/** A run still marked running after this long was orphaned (the agent
 *  restarted mid-run): it no longer counts as live. */
export const RUN_STALE_MS = 3 * 3_600_000

/** A run's status as shown: an orphaned "running" run didn't finish. */
export function shownStatus(run: RoutineRun, now = Date.now()): RunStatus {
  if (run.status !== 'running') return run.status
  return run.startedAt != null && now - run.startedAt > RUN_STALE_MS ? 'failed' : 'running'
}

/** After Run now, wait this long for the agent to list the new run. */
const STARTED_GRACE_MS = 5 * 60_000

/** The runs route caps one page at 100. */
const HISTORY_MAX = 100

/**
 * The routine editor's Results tab: runs down the left, the selected run's
 * output in full on the right, newest run open on arrival. While a run is
 * going it re-reads the list, so "Running" turns into the report without a
 * reload, and Run now starts one from here.
 */
interface RoutineRunsReaderProps {
  jobId: string
  profile?: string
  limit?: number
  startedAt?: number | null
  onRunNow?: () => Promise<void>
}
export function RoutineRunsReader(props: RoutineRunsReaderProps) {
  return <RoutineRunsScope key={`${props.profile ?? 'default'}:${props.jobId}`} {...props} />
}
function RoutineRunsScope({
  jobId,
  profile,
  limit = 20,
  startedAt = null,
  onRunNow,
}: {
  jobId: string
  profile?: string
  limit?: number
  /** When Run now was pressed (ms): the list follows the new run. */
  startedAt?: number | null
  onRunNow?: () => Promise<void>
}) {
  const [runs, setRuns] = useState<Loaded<RoutineRun[]> | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** Keep the newest run open as new ones arrive, until the user picks one. */
  const [followNewest, setFollowNewest] = useState(true)
  const [outputs, setOutputs] = useState<Record<string, OutputState>>({})
  const [copied, setCopied] = useState(false)
  const [retryTick, setRetryTick] = useState(0)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  const [localStart, setLocalStart] = useState<number | null>(startedAt)
  const pendingRun = useRef<object | null>(null)

  useEffect(() => {
    setLocalStart(startedAt)
    if (startedAt != null) {
      setFollowNewest(true)
    }
  }, [jobId, startedAt])

  useEffect(() => {
    pendingRun.current = null
    setStarting(false)
    setStartError('')
    return () => { pendingRun.current = null }
  }, [jobId])

  const shown = useRef<Loaded<RoutineRun[]> | null>(null)
  const currentJob = useRef(jobId)
  currentJob.current = jobId
  const loadGeneration = useRef(0)
  const requestSequence = useRef(0)
  const appliedSequence = useRef(0)
  /** How many runs to ask for: one page, more after "Show older runs". */
  const pageSize = useRef(limit)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const load = useCallback(
    async (quiet = false) => {
      const generation = loadGeneration.current
      const sequence = ++requestSequence.current
      if (!quiet) {
        setRuns(null)
        pageSize.current = limit
      }
      const requestedPageSize = pageSize.current
      let r: Loaded<RoutineRun[]>
      try {
        r = await listRoutineRuns(jobId, requestedPageSize, profile)
      } catch {
        r = { kind: 'unavailable', message: 'Couldn’t load results.' }
      }
      // Drop obsolete results, but let a slow poll finish while the next waits.
      if (currentJob.current !== jobId || generation !== loadGeneration.current ||
          sequence < appliedSequence.current || requestedPageSize !== pageSize.current) return
      const prev = shown.current
      // A failed quiet re-read keeps what's on screen.
      if (quiet && r.kind !== 'ok' && prev) return
      appliedSequence.current = sequence
      // A run that just ended has new output: drop what we cached for it.
      if (prev?.kind === 'ok' && r.kind === 'ok') {
        const ended = prev.value.filter(
          (old) => old.status === 'running' && r.value.some((n) => n.id === old.id && n.status !== 'running'),
        )
        if (ended.length) setOutputs((o) => ended.reduce((acc, run) => omit(acc, run.id), o))
      }
      shown.current = r
      setRuns(r)
    },
    [jobId, limit, profile],
  )

  useEffect(() => {
    void load()
    return () => { loadGeneration.current++ }
  }, [load])

  const list = runs?.kind === 'ok' ? runs.value : []
  const newestId = list[0]?.id ?? null
  useEffect(() => {
    if (newestId && (followNewest || !selectedId || !list.some((r) => r.id === selectedId))) setSelectedId(newestId)
    // list is derived from runs; newestId covers the change that matters.
  }, [newestId, followNewest])

  // Only the newest run can still be going; an orphaned one doesn't poll forever.
  const anyRunning = list[0] != null && shownStatus(list[0]) === 'running'
  const waitingForStart =
    localStart != null &&
    Date.now() - localStart < STARTED_GRACE_MS &&
    !list.some((r) => r.startedAt != null && r.startedAt >= localStart - 60_000)
  const live = anyRunning || waitingForStart

  useEffect(() => {
    if (!live) return
    const t = setInterval(() => void load(true), RESULTS_POLL_MS)
    return () => clearInterval(t)
  }, [live, load])

  const selected = list.find((r) => r.id === selectedId) ?? null
  const selectedRunning = selected != null && shownStatus(selected) === 'running'

  useEffect(() => {
    // A running run has nothing to read yet; it loads once it ends.
    if (!selectedId || selectedRunning || outputs[selectedId]) return
    let alive = true
    setOutputs((o) => ({ ...o, [selectedId]: { state: 'loading' } }))
    void readRunOutputDetailed(selectedId, selected?.profile)
      .catch(() => null)
      .then((result) => {
        if (!alive) return
        // A failed read is retryable, never shown as a run with no output.
        const next: OutputState = !result || result.kind !== 'ok' ? { state: 'error' }
          : result.value ? { state: 'done', ...result.value } : { state: 'empty' }
        setOutputs((o) => ({ ...o, [selectedId]: next }))
      })
    return () => {
      alive = false
      // An abandoned load must not stay 'loading' forever.
      setOutputs((o) => (o[selectedId]?.state === 'loading' ? omit(o, selectedId) : o))
    }
    // outputs is read only as a cache check; re-running on it would refetch.
    // retryTick re-runs it after Retry cleared the failed entry.
  }, [selectedId, selectedRunning, retryTick])

  useEffect(() => setCopied(false), [selectedId])

  const runNow = async () => {
    if (!onRunNow || pendingRun.current || starting || live) return
    const action = {}
    pendingRun.current = action
    setStarting(true)
    setStartError('')
    try {
      await onRunNow()
      if (pendingRun.current !== action || currentJob.current !== jobId) return
      setLocalStart(Date.now())
      setFollowNewest(true)
      void load(true)
    } catch (err) {
      if (pendingRun.current === action && currentJob.current === jobId)
        setStartError(err instanceof Error ? err.message : 'Couldn’t start this routine.')
    } finally {
      if (pendingRun.current === action) {
        pendingRun.current = null
        if (currentJob.current === jobId) setStarting(false)
      }
    }
  }

  const runNowButton = onRunNow ? (
    <button
      type="button"
      onClick={() => void runNow()}
      disabled={starting || live}
      className="rounded-full px-2.5 py-0.5 font-medium text-[var(--ca-primary-text)] ring-1 ring-[var(--ca-border)] hover:bg-[var(--ca-primary-soft)] disabled:opacity-50"
    >
      {starting ? 'Starting…' : live ? 'Running…' : 'Run now'}
    </button>
  ) : null

  const banner =
    startError ? (
      <p role="alert" className="border-b border-[var(--ca-border)] bg-[var(--ca-pink-soft)] px-4 py-2 text-[12px] text-[var(--ca-danger)]">
        {startError}
      </p>
    ) : waitingForStart ? (
      <p role="status" className="border-b border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-4 py-2 text-[12px] text-[var(--ca-ink)]">
        Started. It shows up here in a moment, and the results appear when it finishes.
      </p>
    ) : null

  if (runs === null) return <p className="p-4 text-[12px] text-[var(--ca-ink-muted)]">Loading results…</p>
  if (runs.kind === 'outdated') return <p className="p-4 text-[12px] text-[var(--ca-ink-muted)]">{AGENT_OUTDATED_COPY}</p>
  if (runs.kind === 'unavailable') {
    return (
      <p className="p-4 text-[12px] text-[var(--ca-ink-muted)]">
        Couldn’t load results.
        <button type="button" onClick={() => void load()} className="ml-2 font-medium text-[var(--ca-primary-text)] hover:underline">
          Retry
        </button>
      </p>
    )
  }
  if (list.length === 0) {
    return (
      <div className="text-[12px]">
        {banner}
        <div className="flex flex-wrap items-center gap-3 p-4 text-[var(--ca-ink-muted)]">
          <span>This routine hasn’t run yet. Its results show here after each run.</span>
          {runNowButton}
        </div>
      </div>
    )
  }

  const index = Math.max(0, list.findIndex((r) => r.id === selectedId))
  const run = list[index]!
  const out = outputs[run.id]
  const duration = formatDuration(run)
  const text = out?.state === 'done' ? out.text : ''

  const pick = (id: string) => {
    setSelectedId(id)
    setFollowNewest(id === list[0]?.id)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      /* clipboard blocked: nothing to do */
    }
  }

  return (
    <div className="flex h-[min(620px,calc(100vh-220px))] min-h-[320px] flex-col" data-testid="routine-runs-reader">
      {banner}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <ul
          aria-label="Runs"
          className="max-h-40 shrink-0 overflow-y-auto border-b border-[var(--ca-border)] sm:max-h-none sm:w-56 sm:border-b-0 sm:border-r"
        >
          {list.map((r) => {
            const active = r.id === run.id
            return (
              <li key={r.id}>
                <button
                  type="button"
                  data-testid={`routine-run-${r.id}`}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => pick(r.id)}
                  className={`flex w-full flex-col gap-0.5 border-l-2 px-3 py-2 text-left transition ${
                    active
                      ? 'border-[var(--ca-primary)] bg-[var(--ca-primary-soft)]'
                      : 'border-transparent hover:bg-[var(--ca-hover)]'
                  }`}
                >
                  <span className="truncate text-[12.5px] font-medium text-[var(--ca-ink)]">{formatRunWhen(r.startedAt)}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-[var(--ca-ink-muted)]">
                    <span className={`rounded-full px-1.5 py-px text-[10px] font-medium ${STATUS_CLASS[shownStatus(r)]}`}>
                      {STATUS_LABEL[shownStatus(r)]}
                    </span>
                    {formatDuration(r)}
                  </span>
                </button>
              </li>
            )
          })}
          {/* A full page means there may be older runs behind it. */}
          {list.length >= pageSize.current && pageSize.current < HISTORY_MAX ? (
            <li>
              <button
                type="button"
                disabled={loadingOlder}
                onClick={async () => {
                  pageSize.current = Math.min(pageSize.current + limit, HISTORY_MAX)
                  setLoadingOlder(true)
                  await load(true)
                  setLoadingOlder(false)
                }}
                className="w-full px-3 py-2 text-left text-[11px] font-medium text-[var(--ca-primary-text)] hover:underline disabled:opacity-50"
              >
                {loadingOlder ? 'Loading…' : 'Show older runs'}
              </button>
            </li>
          ) : null}
        </ul>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Run output">
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--ca-border)] px-4 py-2 text-[12px]">
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASS[shownStatus(run)]}`}>
              {STATUS_LABEL[shownStatus(run)]}
            </span>
            <span className="min-w-[8rem] flex-1 truncate text-[var(--ca-ink)]">
              {formatRunWhen(run.startedAt)}
              {duration ? <span className="text-[var(--ca-ink-muted)]"> · took {duration}</span> : null}
            </span>
            {out?.state === 'done' && out.silent ? (
              <span
                className="rounded-full bg-[var(--ca-ink-muted)]/15 px-1.5 py-0.5 text-[10px] text-[var(--ca-ink-muted)]"
                title="Nothing new, so nothing was sent"
              >
                Not sent
              </span>
            ) : null}
            {/* The run list sits beside the output on wide screens; these are for phones. */}
            <button
              type="button"
              aria-label="Newer run"
              disabled={index === 0}
              onClick={() => pick(list[index - 1]!.id)}
              className="rounded-full px-2 py-0.5 text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)] disabled:opacity-30 sm:hidden"
            >
              ‹ Newer
            </button>
            <button
              type="button"
              aria-label="Older run"
              disabled={index === list.length - 1}
              onClick={() => pick(list[index + 1]!.id)}
              className="rounded-full px-2 py-0.5 text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)] disabled:opacity-30 sm:hidden"
            >
              Older ›
            </button>
            {text ? (
              <button
                type="button"
                onClick={() => void copy()}
                className="rounded-full px-2 py-0.5 font-medium text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            ) : null}
            {runNowButton}
          </div>
          <div
            data-testid="routine-run-output"
            className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[14px] leading-relaxed text-[var(--ca-ink)]"
          >
            {selectedRunning ? (
              <p role="status" className="text-[12px] text-[var(--ca-ink-muted)]">
                Working on it. The results show here when it finishes.
              </p>
            ) : !out || out.state === 'loading' ? (
              <p className="text-[12px] text-[var(--ca-ink-muted)]">Loading results…</p>
            ) : out.state === 'error' ? (
              <p role="alert" className="text-[12px] text-[var(--ca-ink-muted)]">
                Couldn’t load this run’s output.
                <button
                  type="button"
                  onClick={() => {
                    setOutputs((o) => omit(o, run.id))
                    setRetryTick((t) => t + 1)
                  }}
                  className="ml-2 font-medium text-[var(--ca-primary-text)] hover:underline"
                >
                  Retry
                </button>
              </p>
            ) : out.state === 'empty' ? (
              <p className="text-[12px] text-[var(--ca-ink-muted)]">
                {shownStatus(run) === 'failed' ? 'It didn’t finish, and no output was saved.' : 'No output was saved for this run.'}
              </p>
            ) : out.text ? (
              <MessageBody content={out.text} variant="markdown" />
            ) : (
              <p className="text-[12px] text-[var(--ca-ink-muted)]">{SILENT_RUN_TEXT}</p>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function omit<T>(o: Record<string, T>, key: string): Record<string, T> {
  const next = { ...o }
  delete next[key]
  return next
}
