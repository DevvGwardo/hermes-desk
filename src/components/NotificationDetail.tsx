/**
 * Right-side drawer for one bell notification. The popover row is a two-line
 * preview; a routine's result is a markdown report, so a click opens it here
 * in full (the run's saved output, not the 220-char preview) with the routine
 * one button away. Same drawer/sheet split as ThreadPane.
 */

import { memo, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BusNotification } from '../lib/hermes-rest'
import { kindLabel } from '../lib/notifications'
import { listRoutineRuns, readRunOutput, splitSilence, type RoutineRun } from '../lib/routine-cron'
import { MessageBody } from './MessageBody'
import { formatFriendlyWhen } from '../lib/friendly-time'

type Body =
  | { state: 'loading' }
  | { state: 'full'; text: string }
  /** Output not readable (older agent, run pruned): the stored preview. */
  | { state: 'preview' }

/**
 * The run a routine notification was raised for. Items written before
 * `runId` was stored fall back to the newest run that started at or before
 * the notification (it is written right after the run ends).
 */
export function pickRun(runs: RoutineRun[], n: Pick<BusNotification, 'runId' | 'at'>): RoutineRun | undefined {
  if (n.runId) return runs.find((r) => r.id === n.runId)
  const at = n.at ? Date.parse(n.at) : NaN
  if (!Number.isFinite(at)) return runs[0]
  return runs.find((r) => r.startedAt != null && r.startedAt <= at) ?? runs[0]
}

async function loadRoutineOutput(n: BusNotification): Promise<string | null> {
  const jobId = n.target?.id
  if (!jobId) return null
  // A routine made by one of your agents keeps its runs in that agent's
  // profile; the item stores it. Older items without one look the run up.
  let raw = n.runId ? await readRunOutput(n.runId, n.runProfile) : null
  if (!raw && !n.runProfile) {
    const run = await listRoutineRuns(jobId, 10).then((r) => (r.kind === 'ok' ? pickRun(r.value, n) : undefined))
    if (run && (run.id !== n.runId || run.profile)) raw = await readRunOutput(run.id, run.profile)
  }
  if (!raw) return null
  const { text } = splitSilence(raw)
  return text.trim() ? text : null
}

function fmtWhen(at?: string): string {
  if (!at || !Number.isFinite(Date.parse(at))) return ''
  return formatFriendlyWhen(at)
}

export const NotificationDetail = memo(function NotificationDetail({
  notification: n,
  onClose,
  onOpenTarget,
}: {
  notification: BusNotification
  onClose: () => void
  /** Opens what the item points at (routine, chat, link). */
  onOpenTarget: (n: BusNotification) => void
}) {
  const routine = n.target?.kind === 'routines' && n.kind === 'routine'
  const [body, setBody] = useState<Body>(routine ? { state: 'loading' } : { state: 'preview' })
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 720)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!routine) {
      setBody({ state: 'preview' })
      return
    }
    let alive = true
    setBody({ state: 'loading' })
    loadRoutineOutput(n)
      .catch(() => null)
      .then((text) => {
        if (alive) setBody(text ? { state: 'full', text } : { state: 'preview' })
      })
    return () => {
      alive = false
    }
  }, [n, routine])

  // Focus lands in the drawer, so keyboard and screen-reader users start there.
  useEffect(() => {
    panelRef.current?.focus()
  }, [n.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      // Full screen on a phone: Tab stays inside, like any other dialog.
      if (e.key !== 'Tab' || !narrow || !panelRef.current) return
      const items = [...panelRef.current.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')]
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      const at = document.activeElement
      if (e.shiftKey && (at === first || at === panelRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && at === last) {
        e.preventDefault()
        first.focus()
      } else if (!panelRef.current.contains(at)) {
        e.preventDefault()
        first.focus()
      }
    }
    const onResize = () => setNarrow(window.innerWidth <= 720)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [onClose, narrow])

  const pill = kindLabel(n.kind)
  const when = fmtWhen(n.at)
  const action = n.target
    ? n.target.kind === 'routines'
      ? 'Open routine'
      : 'Open chat'
    : n.url
      ? 'Open link'
      : null

  return createPortal(
    <aside
      ref={panelRef}
      tabIndex={-1}
      data-testid="notification-detail"
      data-esc-layer
      role={narrow ? 'dialog' : 'complementary'}
      aria-modal={narrow ? true : undefined}
      aria-label={`Notification: ${n.title}`}
      className={
        narrow
          ? 'fixed inset-0 z-[60] flex flex-col bg-[var(--ca-card)] outline-none'
          : 'fixed bottom-0 right-0 top-0 z-[60] flex w-[28rem] outline-none max-w-[92vw] flex-col border-l border-[var(--ca-border)] bg-[var(--ca-card)] shadow-[0_0_48px_rgba(0,0,0,0.25)]'
      }
    >
      <div className="flex items-start gap-2 border-b border-[var(--ca-border)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {pill ? (
              <span className="shrink-0 rounded-md px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)]">
                {pill}
              </span>
            ) : null}
            {when ? <span className="truncate text-[11px] text-[var(--ca-ink-muted)]">{when}</span> : null}
          </div>
          <h2 className="mt-1 text-[15px] font-semibold leading-snug text-[var(--ca-ink)]">{n.title}</h2>
          {n.repo ? <p className="truncate text-[11px] text-[var(--ca-ink-muted)]">{n.repo}</p> : null}
        </div>
        <button
          type="button"
          data-testid="notification-detail-close"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded-full px-2 py-1 text-[11px] text-[var(--ca-ink-muted)] hover:bg-[var(--ca-primary-soft)] hover:text-[var(--ca-ink)]"
        >
          Close
        </button>
      </div>

      <div
        data-testid="notification-detail-body"
        className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[13.5px] leading-relaxed text-[var(--ca-ink)]"
      >
        {body.state === 'loading' ? (
          <p className="text-[12px] text-[var(--ca-ink-muted)]">Loading the full result…</p>
        ) : body.state === 'full' ? (
          <MessageBody content={body.text} variant="markdown" />
        ) : n.body ? (
          <MessageBody content={n.body} variant="markdown" />
        ) : (
          <p className="text-[12px] text-[var(--ca-ink-muted)]">Nothing more to show.</p>
        )}
      </div>

      {action ? (
        <div className="flex justify-end border-t border-[var(--ca-border)] px-4 py-2.5">
          <button
            type="button"
            data-testid="notification-detail-open"
            onClick={() => onOpenTarget(n)}
            className="nub-btn-primary px-3 py-1 text-[12px]"
          >
            {action}
          </button>
        </div>
      ) : null}
    </aside>,
    document.body,
  )
})
