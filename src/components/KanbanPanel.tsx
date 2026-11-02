import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  attachmentCount,
  kanbanAssign,
  kanbanAttachments,
  kanbanAvailable,
  kanbanBackend,
  kanbanBoards,
  kanbanComment,
  kanbanComplete,
  kanbanCreate,
  kanbanDecompose,
  kanbanList,
  kanbanSwarm,
  kanbanSwitchBoard,
  type KanbanBackend,
  type KanbanAttachment,
  type KanbanTask,
} from '../lib/kanban'
import { AppModal } from './AppModal'
import { startAdaptivePoll } from '../lib/poll-cadence'
import { formatFriendlyWhen } from '../lib/friendly-time'
import { formatBytes } from '../lib/usage-format'

const COLUMNS: { status: string; label: string; dot: string }[] = [
  { status: 'triage', label: 'Triage', dot: 'bg-[var(--ca-ink-muted)]' },
  { status: 'todo', label: 'Todo', dot: 'bg-[var(--ca-primary)]/60' },
  { status: 'ready', label: 'Ready', dot: 'bg-[var(--ca-primary)]' },
  { status: 'running', label: 'Running', dot: 'bg-[var(--ca-success)]' },
  { status: 'review', label: 'Review', dot: 'bg-[#f5b13f]' },
  { status: 'blocked', label: 'Blocked', dot: 'bg-[var(--ca-danger)]' },
  { status: 'done', label: 'Done', dot: 'bg-[var(--ca-ink-muted)]' },
]

const TITLE_FOR_STATUS: Record<string, string> = {
  triage: 'New',
  todo: 'To do',
  ready: 'Ready',
  running: 'In progress',
  review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
}

/** "Today, 8:29 PM" for a task's created time (seconds or ms); empty when unknown. */
function fmtTs(ts: unknown): string {
  if (!ts) return ''
  const n = typeof ts === 'number' ? ts : Number(ts)
  if (!Number.isFinite(n)) return ''
  return formatFriendlyWhen(n > 1e12 ? n : n * 1000)
}

interface KanbanPanelProps {
  open: boolean
  onClose: () => void
}

/**
 * Kanban board access — multi-agent task board backed by the local Hermes
 * kanban (SQLite at ~/.hermes/kanban.db). Columns = the kanban statuses;
 * each task is a card. Create/complete/assign/swarm ride the Electron
 * bridge. Desktop-only (needs the local hermes CLI).
 */
export function KanbanPanel({ open, onClose }: KanbanPanelProps) {
  const [tasks, setTasks] = useState<KanbanTask[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Hosted VM ⇒ REST; local hermes ⇒ serve/CLI bridge; resolved on open.
  const [backend, setBackend] = useState<KanbanBackend>(() => (kanbanAvailable() ? 'local' : 'none'))
  const available = backend !== 'none'
  const hosted = backend === 'rest'
  const [notice, setNotice] = useState<string | null>(null)
  // Per task, not one slot: break down A then B, and A's button stayed
  // enabled while A was still running (and A finishing cleared B's state).
  const [decomposing, setDecomposing] = useState<ReadonlySet<string>>(() => new Set())
  const [boardLabels, setBoardLabels] = useState<Record<string, string>>({})
  const [title, setTitle] = useState('')
  const [spec, setSpec] = useState('')
  const [swarmGoal, setSwarmGoal] = useState('')
  const [swarmWorkers, setSwarmWorkers] = useState(3)
  /** In flight: 'create', 'swarm', or a task id (Done / Assign), each its own. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const markBusy = (key: string, on: boolean) =>
    setBusy((cur) => {
      const next = new Set(cur)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  const [showCreate, setShowCreate] = useState(false)
  const [showSwarm, setShowSwarm] = useState(false)
  const [board, setBoard] = useState<string>('')
  const [boardList, setBoardList] = useState<string[]>([])
  const [currentBoard, setCurrentBoard] = useState<string>('')
  // Comment box visibility + drafts, and lazily-fetched attachments per task.
  const [openComment, setOpenComment] = useState<Record<string, boolean>>({})
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({})
  const [commentBusy, setCommentBusy] = useState<string | null>(null)
  const [openAttach, setOpenAttach] = useState<Record<string, boolean>>({})
  const [attachments, setAttachments] = useState<Record<string, KanbanAttachment[]>>({})
  const [attachmentsErr, setAttachmentsErr] = useState<Record<string, string>>({})
  /** The task whose Done is waiting for "Yes" (Done can't be undone). */
  const [confirmDone, setConfirmDone] = useState<string | null>(null)
  /** Task whose Done button takes focus back once "Keep" dismisses its confirm. */
  const refocusDone = useRef<string | null>(null)
  const keepTask = (id: string) => {
    refocusDone.current = id
    setConfirmDone(null)
  }
  /** Serve event cursor (reconnects resume since=cursor) + list mirror for
   *  incremental payload apply without a full re-list. */
  const cursorRef = useRef(0)
  const tasksRef = useRef<KanbanTask[]>([])
  /** Adaptive burst debounce: 400ms idle → 1s warm → 2s hot. */
  const burstRef = useRef(0)
  const lastEvtRef = useRef(0)
  /** Attachment fetches in flight per task — no double-fetch on fast toggles. */
  const attachInflight = useRef(new Set<string>())

  // Only the newest list may land: switch boards quickly and the old
  // board's answer could arrive last and fill the new board with its tasks.
  const listSeq = useRef(0)
  const refresh = useCallback(async () => {
    if (!available) return
    const seq = ++listSeq.current
    setLoading(true)
    setError(null)
    const { tasks: list, error: err } = await kanbanList(board || undefined)
    if (seq !== listSeq.current) return
    if (err) setError(err)
    tasksRef.current = list
    setTasks(list)
    setLoading(false)
  }, [available, board])

  useEffect(() => {
    if (!open) return
    // A fresh look each open: no notice or attachment list left from last time.
    setNotice(null)
    setBoardError(null)
    setConfirmDone(null)
    setOpenAttach({})
    setAttachments({})
    setAttachmentsErr({})
    let cancelled = false
    void kanbanBackend().then((b) => {
      if (!cancelled) setBackend(b)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open || !available) return
    // Load the board list + current board marker once per open.
    void (async () => {
      const { boards, currentBoard: cur, labels, error: boardErr } = await kanbanBoards()
      if (boardErr) setError(boardErr)
      setBoardList(boards)
      setCurrentBoard(cur ?? '')
      setBoardLabels(labels ?? {})
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, available, hosted])

  // Re-list whenever the panel opens or the selected board changes.
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  // Live board via the serve kanban events WS (Hermes-native). Event payloads
  // apply incrementally onto the list; touches without a row payload fall
  // back to a debounced re-list. Burst debounce adapts 400ms → 1s → 2s so a
  // worker flurry doesn't hammer REST; reconnects resume since=cursor.
  // Hosted VM: no direct event socket to the dashboard — poll gently instead.
  useEffect(() => {
    if (!open || !hosted) return
    // Backs off when idle (lib/poll-cadence): each poll is a platform call.
    return startAdaptivePoll(() => refresh(), 15_000, { immediate: false })
  }, [open, hosted, refresh])

  useEffect(() => {
    if (!open || hosted) return
    let unsub: (() => void) | null = null
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = () => {
      const now = Date.now()
      burstRef.current = now - lastEvtRef.current < 2000 ? burstRef.current + 1 : 1
      lastEvtRef.current = now
      const delay = burstRef.current > 6 ? 2000 : burstRef.current > 2 ? 1000 : 400
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (!cancelled) void refresh()
      }, delay)
    }
    const subscribe = async (): Promise<void> => {
      const { kanbanServeAuth, kanbanServeEvents, applyServeEventsToTasks } = await import(
        '../lib/kanban-serve'
      )
      if (cancelled) return
      const cfg = await kanbanServeAuth()
      if (!cfg || cancelled) return
      unsub = kanbanServeEvents(
        cfg,
        (events, cursor) => {
          if (cursor > cursorRef.current) cursorRef.current = cursor
          const { tasks: next, changed } = applyServeEventsToTasks(tasksRef.current, events)
          if (changed) {
            tasksRef.current = next
            setTasks(next)
            return
          }
          scheduleRefresh()
        },
        (state) => {
          if ((state === 'closed' || state === 'error') && !cancelled) {
            unsub?.()
            unsub = null
            if (retryTimer) clearTimeout(retryTimer)
            retryTimer = setTimeout(() => {
              if (!cancelled) void subscribe()
            }, 3000)
          }
        },
        { board: board || undefined, since: cursorRef.current || undefined },
      )
    }
    void subscribe()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (retryTimer) clearTimeout(retryTimer)
      unsub?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, board, hosted])

  if (!open) return null

  const byStatus = new Map<string, KanbanTask[]>()
  for (const t of tasks) {
    const key = t.status || 'todo'
    if (!byStatus.has(key)) byStatus.set(key, [])
    byStatus.get(key)!.push(t)
  }

  const onCreate = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    markBusy('create', true)
    const res = await kanbanCreate({ title: title.trim(), spec: spec.trim() || undefined, board: board || undefined })
    markBusy('create', false)
    if (!res.ok) {
      setError(res.error ?? 'Couldn’t create this task.')
      return
    }
    setTitle('')
    setSpec('')
    setShowCreate(false)
    void refresh()
  }

  const onSwarm = async (e: FormEvent) => {
    e.preventDefault()
    if (!swarmGoal.trim()) return
    markBusy('swarm', true)
    const res = await kanbanSwarm({ goal: swarmGoal.trim(), workers: swarmWorkers })
    markBusy('swarm', false)
    if (!res.ok) {
      setError(res.error ?? 'Couldn’t start the helpers.')
      return
    }
    setSwarmGoal('')
    setShowSwarm(false)
    void refresh()
  }

  const onComplete = async (id: string) => {
    setConfirmDone(null)
    if (busy.has(id)) return
    markBusy(id, true)
    const res = await kanbanComplete(id, board || undefined)
    markBusy(id, false)
    if (!res.ok) setError(res.error ?? 'Couldn’t mark this task done.')
    else void refresh()
  }

  const onAssign = async (id: string, worker: string) => {
    if (!worker.trim()) return
    if (busy.has(id)) return
    markBusy(id, true)
    const res = await kanbanAssign(id, worker.trim(), board || undefined)
    markBusy(id, false)
    if (!res.ok) setError(res.error ?? 'Couldn’t assign this task.')
    else void refresh()
  }

  const onComment = async (id: string) => {
    const text = (commentDrafts[id] ?? '').trim()
    if (!text) return
    setCommentBusy(id)
    setError(null)
    const res = await kanbanComment(id, text, board || undefined)
    setCommentBusy(null)
    if (!res.ok) {
      setError(res.error ?? 'Couldn’t post that comment.')
      return
    }
    setCommentDrafts((d) => ({ ...d, [id]: '' }))
    setOpenComment((o) => ({ ...o, [id]: false }))
  }

  const onDecompose = async (id: string) => {
    if (decomposing.has(id)) return
    setDecomposing((cur) => new Set(cur).add(id))
    setError(null)
    setNotice(null)
    const res = await kanbanDecompose(id, board || undefined)
    setDecomposing((cur) => {
      const next = new Set(cur)
      next.delete(id)
      return next
    })
    if (!res.ok) {
      setError(res.error ?? 'Could not break this task down.')
      return
    }
    setNotice(res.message ?? null)
    void refresh()
  }

  /** Numbers board picks: only the latest one's answer moves the picker. */
  const boardPickSeq = useRef(0)
  /** A refused switch, kept apart from `error`: putting the board back
   *  re-lists it, and a list load clears `error`. */
  const [boardError, setBoardError] = useState<string | null>(null)
  const onPickBoard = async (slug: string) => {
    const before = board
    setBoardError(null)
    setBoard(slug)
    if (!hosted) return
    const seq = ++boardPickSeq.current
    const target = slug || 'default'
    const res = await kanbanSwitchBoard(target)
    if (seq !== boardPickSeq.current) return
    if (res.ok) {
      setCurrentBoard(target)
      return
    }
    // The agent stayed on the old board: put the picker (and the list) back
    // rather than show a board the error says we couldn't switch to.
    setBoard(before)
    setBoardError(res.error ?? 'Could not switch boards.')
  }

  /** Lazily load a task's attachments the first time its section is opened. */
  const onToggleAttachments = async (id: string) => {
    const nextOpen = !openAttach[id]
    setOpenAttach((o) => ({ ...o, [id]: nextOpen }))
    if (!nextOpen) return
    if (attachments[id] || attachInflight.current.has(id)) return // cached / in flight
    attachInflight.current.add(id)
    setError(null)
    // A retry starts clean, and a success clears an earlier failure (it used
    // to stay on screen above the files that did load).
    setAttachmentsErr((e) => {
      if (!(id in e)) return e
      const { [id]: _drop, ...rest } = e
      return rest
    })
    try {
      const { attachments: list, error: err } = await kanbanAttachments(id, board || undefined)
      if (err) setAttachmentsErr((e) => ({ ...e, [id]: err }))
      else setAttachments((a) => ({ ...a, [id]: list }))
    } finally {
      attachInflight.current.delete(id)
    }
  }

  /** The CLI `attach` verb needs a real filesystem path, which a renderer
   *  file input cannot supply (it yields a File object, not a path). So the
   *  upload UI is intentionally omitted — attachment counts/list are shown,
   *  and adding a file must go through the desktop/CLI. */
  const specText = (t: KanbanTask): string => {
    const s = (t.body ?? t.spec ?? '').trim()
    return s.length > 200 ? `${s.slice(0, 200)}…` : s
  }

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="Tasks"
      size="xl"
      actions={
        <>
          {available && boardList.length > 0 && (
            <select
              aria-label="Board"
              value={board || (currentBoard === 'default' ? '' : currentBoard) || ''}
              onChange={(e) => void onPickBoard(e.target.value)}
              className="rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-1.5 py-1 text-[11px] text-[var(--ca-ink)] outline-none"
              title={currentBoard ? `Current board: ${boardLabels[currentBoard] ?? currentBoard}` : 'Select board'}
            >
              {!boardList.includes('default') && <option value="">Default</option>}
              {boardList.map((b) => (
                <option key={b} value={b === 'default' ? '' : b}>
                  {boardLabels[b] ?? b}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="rounded-lg px-2 py-1 text-[11px] font-semibold text-[var(--ca-primary-text)] hover:bg-[var(--ca-primary-soft)]"
          >
            + Task
          </button>
          {!hosted && (
          <button
            type="button"
            onClick={() => setShowSwarm((v) => !v)}
            className="rounded-lg px-2 py-1 text-[11px] font-semibold text-[var(--ca-primary-text)] hover:bg-[var(--ca-primary-soft)]"
            title="Let several helpers work on one goal at the same time, then check and combine their work"
          >
            Helpers
          </button>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="rounded-lg px-2 py-1 text-[11px] font-semibold text-[var(--ca-ink-muted)] hover:bg-[var(--ca-primary-soft)] disabled:opacity-50"
          >
            {loading ? '…' : 'Refresh'}
          </button>
        </>
      }
    >

        {(showCreate || showSwarm) && (
          <div className="border-b border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-4 py-3">
            {showCreate && (
              <form onSubmit={onCreate} className="flex flex-col gap-2">
                <input
                  aria-label="Task title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Task title"
                  className="rounded-lg border border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[var(--ca-primary)]/30"
                />
                <textarea
                  aria-label="Task spec"
                  value={spec}
                  onChange={(e) => setSpec(e.target.value)}
                  placeholder="Details: what “done” looks like (optional)"
                  rows={2}
                  className="rounded-lg border border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[var(--ca-primary)]/30"
                />
                <div className="flex justify-end gap-1">
                  <button
                    type="submit"
                    disabled={busy.has('create') || !title.trim()}
                    className="nub-btn-primary px-3 py-1 text-xs disabled:opacity-50"
                  >
                    {busy.has('create') ? 'Creating…' : 'Create task'}
                  </button>
                </div>
              </form>
            )}
            {showSwarm && (
              <form onSubmit={onSwarm} className="flex flex-col gap-2">
                <textarea
                  aria-label="Swarm goal"
                  value={swarmGoal}
                  onChange={(e) => setSwarmGoal(e.target.value)}
                  placeholder="What should the helpers work on together?"
                  rows={2}
                  className="rounded-lg border border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[var(--ca-primary)]/30"
                />
                <div className="flex items-center gap-3">
                  <label className="text-[11px] text-[var(--ca-ink-muted)]">
                    Helpers
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={swarmWorkers}
                      onChange={(e) => setSwarmWorkers(Number(e.target.value))}
                      className="ml-2 w-14 rounded-lg border border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-1.5 py-0.5 text-sm outline-none"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busy.has('swarm') || !swarmGoal.trim()}
                    className="nub-btn-primary ml-auto px-3 py-1 text-xs disabled:opacity-50"
                  >
                    {busy.has('swarm') ? 'Starting…' : 'Start helpers'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {notice && !error && !boardError && (
          <div role="status" className="border-b border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-4 py-2 text-[11px] text-[var(--ca-ink)]">
            {notice}
          </div>
        )}

        {(error || boardError) && (
          <div role="alert" className="border-b border-[var(--ca-danger)]/30 bg-[var(--ca-danger)]/10 px-4 py-2 text-[11px] text-[var(--ca-danger)]">
            {error ?? boardError}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-3">
          {!available ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--ca-ink-muted)]">
              Link your agent to see its task board.
            </div>
          ) : loading && tasks.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--ca-ink-muted)]">
              Loading board…
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--ca-ink-muted)]">
              <span>Board is empty.</span>
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="text-[var(--ca-primary-text)] hover:underline"
              >
                Create the first task
              </button>
            </div>
          ) : (
            // Below `sm` (phones) the columns stack full width and empty ones
            // hide, instead of a sideways strip a 224px column at a time.
            <div className="flex flex-col gap-3 pb-2 sm:flex-row sm:overflow-x-auto">
              {COLUMNS.map((col) => {
                const colTasks = byStatus.get(col.status) ?? []
                return (
                  <div
                    key={col.status}
                    className={`${colTasks.length === 0 ? 'hidden sm:flex' : 'flex'} w-full flex-col rounded-xl bg-[var(--ca-primary-soft)] sm:w-56 sm:shrink-0`}
                  >
                    <div className="flex items-center gap-1.5 px-2.5 py-2">
                      <span className={`h-1.5 w-1.5 rounded-full ${col.dot}`} />
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ca-ink)]">
                        {col.label}
                      </span>
                      <span className="ml-auto text-[10px] text-[var(--ca-ink-muted)]">
                        {colTasks.length}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1.5 px-2 pb-2">
                      {colTasks.length === 0 && (
                        <div className="rounded-lg border border-dashed border-[var(--ca-border)] px-2 py-3 text-center text-[10px] text-[var(--ca-ink-muted)]">
                          {TITLE_FOR_STATUS[col.status] ?? col.status}
                        </div>
                      )}
                      {colTasks.map((t) => (
                        <div
                          key={t.id}
                          className="rounded-lg bg-[var(--ca-card)] p-2 shadow-[var(--ca-shadow-soft)] ring-1 ring-[var(--ca-border)]"
                        >
                          <div className="text-xs font-medium leading-snug text-[var(--ca-ink)]">
                            {t.title}
                          </div>
                          {specText(t) && (
                            <div className="mt-1 text-[10px] leading-snug text-[var(--ca-ink-muted)]">
                              {specText(t)}
                            </div>
                          )}
                          <div className="mt-1 flex items-center gap-1 text-[9px] text-[var(--ca-ink-muted)]">
                            {t.assignee || t.assignedWorker ? (
                              <span className="truncate">{String(t.assignee ?? t.assignedWorker)}</span>
                            ) : null}
                            {fmtTs(t.createdTs ?? t.created_at) ? (
                              <span className="ml-auto">{fmtTs(t.createdTs ?? t.created_at)}</span>
                            ) : null}
                          </div>
                          {confirmDone === t.id && (
                            <div
                              role="alertdialog"
                              aria-label="Mark this task done?"
                              onKeyDown={(e) => {
                                if (e.key !== 'Escape') return
                                e.stopPropagation()
                                keepTask(t.id)
                              }}
                              className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]"
                            >
                              <span className="text-[var(--ca-ink)]">
                                {col.status === 'running' ? 'Stop and mark done?' : 'Mark this done?'}
                              </span>
                              <button
                                type="button"
                                autoFocus
                                onClick={() => keepTask(t.id)}
                                className="rounded-md px-1.5 py-0.5 font-medium text-[var(--ca-ink-muted)] hover:bg-[var(--ca-primary-soft)]"
                              >
                                Keep
                              </button>
                              <button
                                type="button"
                                onClick={() => void onComplete(t.id)}
                                className="rounded-md bg-[var(--ca-primary-fill)] px-1.5 py-0.5 font-semibold text-white"
                              >
                                Yes, done
                              </button>
                            </div>
                          )}
                          {col.status !== 'done' && col.status !== 'archived' && confirmDone !== t.id && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1">
                              <button
                                type="button"
                                disabled={busy.has(t.id)}
                                ref={(el) => {
                                  if (!el || refocusDone.current !== t.id) return
                                  refocusDone.current = null
                                  el.focus()
                                }}
                                onClick={() => setConfirmDone(t.id)}
                                className="rounded-md bg-[var(--ca-primary-soft)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--ca-primary-text)] hover:bg-[var(--ca-card)] disabled:opacity-50"
                              >
                                {busy.has(t.id) ? 'Saving…' : 'Done'}
                              </button>
                              {(col.status === 'triage' || col.status === 'todo' || col.status === 'ready') && (
                                <button
                                  type="button"
                                  disabled={decomposing.has(t.id)}
                                  onClick={() => void onDecompose(t.id)}
                                  title="Ask your agent to split this into smaller tasks"
                                  className="rounded-md bg-[var(--ca-primary-soft)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--ca-primary-text)] hover:bg-[var(--ca-card)] disabled:opacity-50"
                                >
                                  {decomposing.has(t.id) ? 'Breaking down…' : 'Break this down'}
                                </button>
                              )}
                              {!t.assignee && !t.assignedWorker && (
                                <input
                                  aria-label="Assign to"
                                  title="Type a name, then press Enter"
                                  placeholder="Assign to…"
                                  defaultValue=""
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      onAssign(t.id, (e.target as HTMLInputElement).value)
                                    }
                                  }}
                                  className="w-16 rounded-md border border-[var(--ca-border)] bg-[var(--ca-card)] px-1 py-0.5 text-[11px] text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-ink-muted)] [@media(pointer:coarse)]:w-24"
                                />
                              )}
                            </div>
                          )}
                          <div className="mt-1.5 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setOpenComment((o) => ({ ...o, [t.id]: !o[t.id] }))}
                              className="text-[11px] font-semibold text-[var(--ca-primary-text)] hover:underline"
                            >
                              Comment
                            </button>
                            <button
                              type="button"
                              onClick={() => void onToggleAttachments(t.id)}
                              className="text-[11px] font-semibold text-[var(--ca-primary-text)] hover:underline"
                              title={
                                attachmentCount(t)
                                  ? `${attachmentCount(t)} attachment(s)`
                                  : 'View attachments'
                              }
                            >
                              📎 {openAttach[t.id] ? 'Hide' : 'Attachments'}
                              {attachmentCount(t) ? ` (${attachmentCount(t)})` : ''}
                            </button>
                          </div>
                          {openComment[t.id] && (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault()
                                void onComment(t.id)
                              }}
                              className="mt-1.5 flex items-center gap-1"
                            >
                              <input
                                autoFocus
                                aria-label="Add comment"
                                value={commentDrafts[t.id] ?? ''}
                                onChange={(e) =>
                                  setCommentDrafts((d) => ({ ...d, [t.id]: e.target.value }))
                                }
                                placeholder="comment…"
                                className="min-w-0 flex-1 rounded-md border border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-1 py-0.5 text-[11px] outline-none"
                              />
                              <button
                                type="submit"
                                disabled={commentBusy === t.id || !(commentDrafts[t.id] ?? '').trim()}
                                className="shrink-0 rounded-md bg-[var(--ca-primary-soft)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--ca-primary-text)] hover:bg-[var(--ca-card)] disabled:opacity-50"
                              >
                                {commentBusy === t.id ? '…' : 'Post'}
                              </button>
                            </form>
                          )}
                          {openAttach[t.id] && (
                            <div className="mt-1.5 rounded-lg bg-black/5 px-2 py-1.5">
                              {attachmentsErr[t.id] ? (
                                <div className="text-[9px] text-[var(--ca-danger)]">
                                  {attachmentsErr[t.id]}
                                </div>
                              ) : !attachments[t.id] ? (
                                <div className="text-[9px] text-[var(--ca-ink-muted)]">
                                  Loading…
                                </div>
                              ) : attachments[t.id].length === 0 ? (
                                <div className="text-[9px] text-[var(--ca-ink-muted)]">
                                  No attachments.
                                </div>
                              ) : (
                                <ul className="flex flex-col gap-0.5">
                                  {attachments[t.id].map((a) => (
                                    <li
                                      key={String(a.id)}
                                      className="truncate font-mono text-[9px] text-[var(--ca-ink)]"
                                      title={a.content_type || undefined}
                                    >
                                      📄 {a.filename ?? a.name ?? String(a.id)}
                                      {typeof a.size === 'number' ? ` · ${formatBytes(a.size)}` : ''}
                                      {a.uploaded_by ? ` · ${a.uploaded_by}` : ''}
                                    </li>
                                  ))}
                                </ul>
                              )}
                              <div className="mt-1 text-[9px] text-[var(--ca-ink-muted)]">
                                To add a file, ask your agent in chat to attach it to this task.
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
    </AppModal>
  )
}
