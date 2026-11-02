/**
 * Kanban dashboard REST + WS client for `hermes serve`.
 *
 * Protocol (frozen in docs/HERMES_SERVE_PROTOCOL.md §5):
 *   - REST under /api/plugins/kanban/* — board, tasks CRUD, bulk, comments,
 *     links, dispatch, workers, runs. Auth: X-Hermes-Session-Token header,
 *     attached by the Electron main process (never held here — #161).
 *   - WS /api/plugins/kanban/events?since=<id>&token=... — live event tail,
 *     opened by main via the serve socket relay (serve-bridge.ts).
 *
 * Falls back to the Electron CLI bridge when serve is unavailable (the
 * KanbanPanel keeps working via `hermes kanban <verb>`).
 */
import { openServeSocket, serveBridgeConnection, serveTokenHeader, type ServeSocketLike } from './serve-bridge'

export interface KanbanServeTask {
  id: string
  title: string
  status: string
  priority?: string | null
  assignee?: string | null
  body?: string | null
  result?: string | null
  progress?: { done: number; total: number } | null
  comment_count?: number
  link_counts?: { parents: number; children: number }
  diagnostics?: unknown[]
  warnings?: string
  created_at?: string | number | null
  updated_at?: string | number | null
  [key: string]: unknown
}

export interface KanbanServeBoard {
  columns: { name: string; tasks: KanbanServeTask[] }[]
  tenants: string[]
  assignees: string[]
  latest_event_id: number
  now: number
}

export interface KanbanServeEvent {
  id: number
  task_id: string | null
  run_id: string | null
  kind: string
  payload: unknown
  created_at: number
}

export interface KanbanServeConfig {
  baseUrl: string
  token: string
}

/** Resolve serve auth for kanban (same bridge source as the transport). */
export async function kanbanServeAuth(): Promise<KanbanServeConfig | null> {
  return serveBridgeConnection()
}

async function kanbanFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  const auth = await kanbanServeAuth()
  if (!auth) return null
  try {
    const res = await fetch(`${auth.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...serveTokenHeader(auth.token),
        ...(init?.headers ?? {}),
      },
      credentials: 'omit',
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** Fetch the full board grouped by status column. */
export async function kanbanServeBoard(board?: string): Promise<KanbanServeBoard | null> {
  const qs = board && board !== 'default' ? `?board=${encodeURIComponent(board)}` : ''
  return kanbanFetch<KanbanServeBoard>(`/api/plugins/kanban/board${qs}`)
}

/** Create a task. Returns the created task id (or null on failure). */
export async function kanbanServeCreate(payload: {
  title: string
  body?: string
  assignee?: string
  priority?: string
  tenant?: string
  parents?: string[]
  triage?: boolean
}, board?: string): Promise<{ id: string } | null> {
  const qs = board && board !== 'default' ? `?board=${encodeURIComponent(board)}` : ''
  return kanbanFetch<{ id: string }>(`/api/plugins/kanban/tasks${qs}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** Update a task (status/assignee/priority/title/body/result). */
export async function kanbanServeUpdate(
  taskId: string,
  patch: Record<string, unknown>,
  board?: string,
): Promise<Record<string, unknown> | null> {
  const qs = board && board !== 'default' ? `?board=${encodeURIComponent(board)}` : ''
  return kanbanFetch<Record<string, unknown>>(
    `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}${qs}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  )
}

/** Add a comment to a task. */
export async function kanbanServeComment(
  taskId: string,
  body: string,
  board?: string,
): Promise<Record<string, unknown> | null> {
  const qs = board && board !== 'default' ? `?board=${encodeURIComponent(board)}` : ''
  return kanbanFetch<Record<string, unknown>>(
    `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}/comments${qs}`,
    { method: 'POST', body: JSON.stringify({ body }) },
  )
}

/**
 * Incrementally apply a serve event batch onto a task list (avoids a full
 * board re-fetch on every worker flurry). An event whose payload looks like
 * a task (id + title/status, flat or under `task`) is upserted; a
 * delete/remove-kind event drops the row. Returns the same array reference
 * when nothing changed so callers can skip re-render.
 */
export function applyServeEventsToTasks<T extends { id: string }>(
  tasks: T[],
  events: KanbanServeEvent[],
): { tasks: T[]; changed: boolean } {
  if (!Array.isArray(events) || events.length === 0) return { tasks, changed: false }
  let next = tasks
  let changed = false
  const upsert = (row: T): void => {
    const i = next.findIndex((t) => t.id === row.id)
    if (i < 0) {
      next = [...next, row]
      changed = true
    } else if (JSON.stringify(next[i]) !== JSON.stringify(row)) {
      next = [...next.slice(0, i), row, ...next.slice(i + 1)]
      changed = true
    }
  }
  for (const ev of events) {
    const kind = String(ev.kind ?? '').toLowerCase()
    if (/delete|remove|archive/.test(kind) && ev.task_id) {
      if (next.some((t) => t.id === ev.task_id)) {
        next = next.filter((t) => t.id !== ev.task_id)
        changed = true
      }
      continue
    }
    const p = ev.payload as Record<string, unknown> | null | undefined
    const cand =
      p && typeof p === 'object'
        ? ((p.task as Record<string, unknown> | undefined) ?? p)
        : null
    if (
      cand &&
      typeof cand.id === 'string' &&
      (typeof cand.title === 'string' || typeof cand.status === 'string')
    ) {
      upsert(cand as unknown as T)
    } else if (ev.task_id && /update|move|assign|comment|create/.test(kind)) {
      // Known task touched but no row payload — caller should re-list.
      return { tasks: next, changed }
    }
  }
  return { tasks: next, changed }
}

/**
 * Live event tail: opens a WS to /api/plugins/kanban/events and invokes
 * `onEvents` with each batch. Returns an unsubscribe function.
 * Reconnect-on-close is handled by the caller (pass a `since` cursor).
 */
export function kanbanServeEvents(
  cfg: KanbanServeConfig,
  onEvents: (events: KanbanServeEvent[], cursor: number) => void,
  onState?: (state: 'open' | 'closed' | 'error') => void,
  opts: { since?: number; board?: string } = {},
): () => void {
  let ws: ServeSocketLike | null = null
  let closed = false
  const query: Record<string, string> = {}
  if (opts.since) query.since = String(opts.since)
  if (opts.board && opts.board !== 'default') query.board = opts.board

  try {
    ws = openServeSocket(cfg, '/api/plugins/kanban/events', query)
  } catch {
    onState?.('error')
    return () => {
      closed = true
    }
  }

  ws.addEventListener('open', () => onState?.('open'))
  ws.addEventListener('message', (msg) => {
    try {
      const data = JSON.parse((msg as MessageEvent).data as string) as {
        events?: KanbanServeEvent[]
        cursor?: number
      }
      if (Array.isArray(data.events)) {
        onEvents(data.events, data.cursor ?? 0)
      }
    } catch {
      /* ignore malformed frame */
    }
  })
  ws.addEventListener('close', () => {
    if (!closed) onState?.('closed')
  })
  ws.addEventListener('error', () => onState?.('error'))

  return () => {
    closed = true
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    ws = null
  }
}
