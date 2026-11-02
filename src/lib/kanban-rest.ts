/**
 * Kanban over dashboard REST for hosted VMs (hermes kanban plugin,
 * plugins/kanban/dashboard/plugin_api.py, mounted at /api/plugins/kanban).
 *
 * Routes used:
 *   GET    /board?board=                    → {columns:[{name,tasks}]}
 *   POST   /tasks?board=                    {title, body, assignee, triage, priority} → {task}
 *   PATCH  /tasks/{id}?board=               {status | assignee | …}
 *   POST   /tasks/{id}/comments?board=      {body}
 *   GET    /tasks/{id}/attachments?board=
 *   POST   /tasks/{id}/decompose?board=     {} → {ok, fanout, child_ids, reason}
 *   GET    /boards                          → {boards:[{slug,name,is_current,total}], current}
 *   POST   /boards/{slug}/switch            → {current}
 *   POST   /dispatch?max=1&board=
 *
 * Goes through hermes-rest's serve* helpers, so it reaches the linked VM
 * (Electron `nubVmRest` or the maiavm.com dashboard proxy on web/mobile).
 */

import { serveGetDetailed, serveSend } from './hermes-rest'
import { restFailureText } from './agent-rest'
import type { KanbanServeTask } from './kanban-serve'
import type { SubagentKind } from './agents/types'
import type { SpawnResult } from './spawn'

export const KANBAN_BASE = '/api/plugins/kanban'

function boardQs(board?: string, extra?: Record<string, string>): string {
  const qs = new URLSearchParams(extra ?? {})
  if (board && board !== 'default') qs.set('board', board)
  const s = qs.toString()
  return s ? `?${s}` : ''
}

const enc = encodeURIComponent

export interface RestResult<T = undefined> {
  ok: boolean
  data?: T
  error?: string
  status?: number
}

function fail<T>(res: { status?: number; error?: string }, fallback: string): RestResult<T> {
  return { ok: false, status: res.status, error: restFailureText(res, fallback) }
}

export async function restBoard(
  board?: string,
): Promise<RestResult<{ columns: { name: string; tasks: KanbanServeTask[] }[] }>> {
  const res = await serveGetDetailed<{ columns?: { name: string; tasks: KanbanServeTask[] }[] }>(
    `${KANBAN_BASE}/board${boardQs(board)}`,
  )
  if (!res.data) {
    return fail({ status: res.status ?? res.error?.status, error: res.error?.message }, 'Could not load the board.')
  }
  return { ok: true, data: { columns: Array.isArray(res.data.columns) ? res.data.columns : [] } }
}

export interface RestBoardInfo {
  slug: string
  name: string
  total?: number
  isCurrent: boolean
}

export async function restBoards(): Promise<RestResult<{ boards: RestBoardInfo[]; current?: string }>> {
  const res = await serveGetDetailed<{ boards?: Record<string, unknown>[]; current?: string }>(`${KANBAN_BASE}/boards`)
  if (!res.data) {
    return fail({ status: res.status ?? res.error?.status, error: res.error?.message }, 'Could not load boards.')
  }
  const current = typeof res.data.current === 'string' ? res.data.current : undefined
  const boards = (Array.isArray(res.data.boards) ? res.data.boards : [])
    .map((b): RestBoardInfo | null => {
      const slug = typeof b.slug === 'string' ? b.slug : ''
      if (!slug) return null
      return {
        slug,
        name: typeof b.name === 'string' && b.name.trim() ? b.name : slug,
        ...(typeof b.total === 'number' ? { total: b.total } : {}),
        isCurrent: b.is_current === true || slug === current,
      }
    })
    .filter((b): b is RestBoardInfo => b !== null)
  return { ok: true, data: { boards, current } }
}

export async function restSwitchBoard(slug: string): Promise<RestResult<{ current: string }>> {
  const res = await serveSend<{ current?: string }>('POST', `${KANBAN_BASE}/boards/${enc(slug)}/switch`)
  if (!res.ok) return fail(res, 'Could not switch boards.')
  return { ok: true, data: { current: res.data?.current ?? slug } }
}

/** Pull the created task id out of `{task:{id}}` (current) or `{id}` (older). */
export function createdTaskId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const o = data as { id?: unknown; task?: { id?: unknown } | null }
  if (o.task && typeof o.task.id === 'string') return o.task.id
  return typeof o.id === 'string' ? o.id : undefined
}

export async function restCreateTask(
  payload: { title: string; body?: string; assignee?: string; triage?: boolean },
  board?: string,
): Promise<RestResult<{ id?: string; warning?: string }>> {
  const body: Record<string, unknown> = { title: payload.title }
  if (payload.body) body.body = payload.body
  if (payload.assignee) body.assignee = payload.assignee
  if (payload.triage) body.triage = true
  const res = await serveSend<{ task?: { id?: string }; warning?: string }>(
    'POST',
    `${KANBAN_BASE}/tasks${boardQs(board)}`,
    body,
  )
  if (!res.ok) return fail(res, 'Could not create the task.')
  return {
    ok: true,
    data: {
      id: createdTaskId(res.data),
      ...(typeof res.data?.warning === 'string' ? { warning: res.data.warning } : {}),
    },
  }
}

export async function restUpdateTask(
  taskId: string,
  patch: Record<string, unknown>,
  board?: string,
): Promise<RestResult> {
  const res = await serveSend('PATCH', `${KANBAN_BASE}/tasks/${enc(taskId)}${boardQs(board)}`, patch)
  if (!res.ok) return fail(res, 'Could not update the task.')
  return { ok: true }
}

export async function restComment(taskId: string, text: string, board?: string): Promise<RestResult> {
  const res = await serveSend('POST', `${KANBAN_BASE}/tasks/${enc(taskId)}/comments${boardQs(board)}`, {
    body: text,
  })
  if (!res.ok) return fail(res, 'Could not post the comment.')
  return { ok: true }
}

export async function restAttachments(taskId: string, board?: string): Promise<RestResult<unknown>> {
  const res = await serveGetDetailed<unknown>(`${KANBAN_BASE}/tasks/${enc(taskId)}/attachments${boardQs(board)}`)
  if (res.data === null || res.data === undefined) {
    return fail({ status: res.status ?? res.error?.status, error: res.error?.message }, 'Could not load attachments.')
  }
  return { ok: true, data: res.data }
}

export interface DecomposeOutcome {
  /** True when the task was split into child tasks. */
  fanout: boolean
  childIds: string[]
  /** hermes' reason when nothing was split (not an HTTP error). */
  reason?: string
}

/** "Break this down": fan a task out into child tasks via the agent. */
export async function restDecompose(taskId: string, board?: string): Promise<RestResult<DecomposeOutcome>> {
  const res = await serveSend<{ ok?: boolean; fanout?: boolean; child_ids?: string[]; reason?: string }>(
    'POST',
    `${KANBAN_BASE}/tasks/${enc(taskId)}/decompose${boardQs(board)}`,
    {},
  )
  if (!res.ok) return fail(res, 'Could not break this task down.')
  const d = res.data ?? {}
  const childIds = Array.isArray(d.child_ids) ? d.child_ids.filter((x): x is string => typeof x === 'string') : []
  if (d.ok === false) {
    return { ok: false, error: d.reason || 'Your agent could not break this task down.' }
  }
  return {
    ok: true,
    data: { fanout: d.fanout === true || childIds.length > 0, childIds, ...(d.reason ? { reason: d.reason } : {}) },
  }
}

/** Nudge the dispatcher so a fresh ready task is picked up right away. */
export async function restDispatch(board?: string, max = 1): Promise<RestResult> {
  const res = await serveSend('POST', `${KANBAN_BASE}/dispatch${boardQs(board, { max: String(max) })}`)
  if (!res.ok) return fail(res, 'Could not start the task.')
  return { ok: true }
}

/** Hosted VM: create a ready kanban task (assigned when a profile is named) and nudge dispatch. */
export async function spawnHostedKanbanTask(
  kind: SubagentKind,
  goal: string,
  agent?: string,
): Promise<SpawnResult> {
  try {
    const { profileIdForName, DEFAULT_PROFILE } = await import('./agent-profiles')
    // Unassigned tasks never dispatch: route to the named agent's profile, else the main agent.
    const assignee = agent?.trim() ? profileIdForName(agent) : DEFAULT_PROFILE
    const created = await restCreateTask({ title: goal, assignee })
    if (!created.ok) {
      return { ok: false, kind, channel: 'kanban', error: created.error ?? 'Could not create the task.' }
    }
    // Best-effort nudge; the dispatcher also picks tasks up on its own tick.
    await restDispatch(undefined, 1)
    return { ok: true, kind, channel: 'kanban', ...(created.data?.id ? { taskId: created.data.id } : {}) }
  } catch (err) {
    return { ok: false, kind, channel: 'kanban', error: String((err as Error)?.message ?? err) }
  }
}
