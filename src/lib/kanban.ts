/**
 * Kanban client.
 *
 * Hosted VM (linked Nub agent, any shell): dashboard REST only
 * (/api/plugins/kanban/* via kanban-rest.ts) — never the local CLI.
 *
 * Local hermes (desktop, nothing linked): local `hermes serve` REST raced
 * against the Electron bridge (window.nubAgent.kanban → `hermes kanban <verb>`
 * in the main process, where it runs as a PARENT context — kanban refuses
 * delegated child contexts). In a plain browser without a link, calls
 * resolve with a clear desktop-only error.
 */

import type { KanbanServeTask } from './kanban-serve'
import { isHostedAgent } from './agent-rest'

export interface KanbanTask {
  id: string
  title: string
  status: string
  priority?: string
  assignee?: string | null
  assignedWorker?: string | null
  spec?: string | null
  /** The CLI serializes the spec/description as `body` (not `spec`). */
  body?: string | null
  /** Attachment count, when the bridge/CLI surfaces it. */
  attachmentsCount?: number
  result?: string | null
  createdTs?: number | string | null
  updatedTs?: number | string | null
  [key: string]: unknown
}

export interface KanbanAttachment {
  id: number | string
  filename?: string
  name?: string
  content_type?: string
  size?: number
  uploaded_by?: string
  created_at?: number | string
  [key: string]: unknown
}

export interface KanbanResult {
  ok: boolean
  code?: number
  data?: unknown
  error?: string
}

type Bridge = (args: string[]) => Promise<KanbanResult>

function getBridge(): Bridge | null {
  // `window.nubAgent` (incl. `kanban`) is declared in src/vite-env.d.ts.
  return window.nubAgent?.kanban ?? null
}

export const kanbanAvailable = (): boolean => getBridge() != null

/** Where kanban calls go right now. */
export type KanbanBackend = 'rest' | 'local' | 'none'

export async function kanbanBackend(): Promise<KanbanBackend> {
  if (await isHostedAgent()) return 'rest'
  return getBridge() != null ? 'local' : 'none'
}

async function hostedRest(): Promise<typeof import('./kanban-rest') | null> {
  if (!(await isHostedAgent())) return null
  return import('./kanban-rest')
}

/** Normalize whatever JSON shape `hermes kanban list --json` returns into
 *  a flat task array. Defensive: accepts array | {tasks:[]} | {items:[]}. */
export function normalizeTasks(data: unknown): KanbanTask[] {
  if (Array.isArray(data)) return data as KanbanTask[]
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    for (const k of ['tasks', 'items', 'cards', 'results']) {
      const v = o[k]
      if (Array.isArray(v)) return v as KanbanTask[]
    }
  }
  return []
}

export async function kanbanExec(args: string[]): Promise<KanbanResult> {
  const bridge = getBridge()
  if (!bridge) {
    return {
      ok: false,
      error:
        'Kanban requires the desktop app (local Hermes bridge). Open Nub Agent via Electron, not a plain browser tab.',
    }
  }
  try {
    return await bridge(args)
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
}

/** Serve-vs-CLI race budget on open — serve usually wins; the CLI caps the wait. */
const KANBAN_RACE_MS = 2500

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function serveBoardToTasks(board: { columns: { tasks: KanbanServeTask[] }[] } | null): KanbanTask[] | null {
  if (!board) return null
  return board.columns.flatMap((col) =>
    col.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority ?? undefined,
      assignee: t.assignee ?? null,
      assignedWorker: t.assignee ?? null,
      spec: typeof t.body === 'string' ? t.body : undefined,
      body: typeof t.body === 'string' ? t.body : null,
      result: typeof t.result === 'string' ? t.result : null,
      createdAt: t.created_at ?? undefined,
      updatedAt: t.updated_at ?? undefined,
    })),
  )
}

async function kanbanListCli(board?: string): Promise<{ tasks: KanbanTask[]; error?: string }> {
  const args = ['list']
  if (board && board.trim()) args.push('--board', board.trim())
  const res = await kanbanExec(args)
  if (!res.ok) return { tasks: [], error: res.error ?? `kanban list failed (${res.code})` }
  return { tasks: normalizeTasks(res.data) }
}

export async function kanbanList(board?: string): Promise<{ tasks: KanbanTask[]; error?: string }> {
  const rest = await hostedRest()
  if (rest) {
    const res = await rest.restBoard(board)
    if (!res.ok) return { tasks: [], error: res.error }
    return { tasks: serveBoardToTasks(res.data ?? { columns: [] }) ?? [] }
  }
  // Race: serve REST and the CLI start together; serve wins when it lands
  // inside the budget, otherwise the CLI snapshot is authoritative.
  const serveP = (async () => {
    try {
      const { kanbanServeBoard } = await import('./kanban-serve')
      return serveBoardToTasks(await kanbanServeBoard(board))
    } catch {
      return null
    }
  })()
  const cliP = kanbanListCli(board)
  const serveTasks = await withTimeout(serveP, KANBAN_RACE_MS)
  if (serveTasks) return { tasks: serveTasks }
  return cliP
}

export interface KanbanBoardsResult {
  boards: string[]
  /** Slug of the currently active board, when the CLI reports one. */
  currentBoard?: string
  /** Display names by slug (REST only). */
  labels?: Record<string, string>
  error?: string
}

/** Parse the 'Current board: X' marker out of `hermes kanban boards` text. */
function parseCurrentBoard(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  const m = text.match(/current board:\s*([^\s]+)/i)
  return m ? m[1] : undefined
}

export async function kanbanBoards(): Promise<KanbanBoardsResult> {
  const rest = await hostedRest()
  if (rest) {
    const res = await rest.restBoards()
    if (!res.ok) return { boards: [], error: res.error }
    const list = res.data?.boards ?? []
    return {
      boards: list.map((b) => b.slug),
      currentBoard: res.data?.current ?? list.find((b) => b.isCurrent)?.slug,
      labels: Object.fromEntries(list.map((b) => [b.slug, b.name])),
    }
  }
  const res = await kanbanExec(['boards'])
  if (!res.ok) return { boards: [], error: res.error }
  const names: string[] = []
  // The `boards` verb is auto --json'd by the main process when the CLI
  // emits JSON; otherwise it falls back to box-drawing text. Handle both.
  if (Array.isArray(res.data)) {
    for (const b of res.data as Record<string, unknown>[]) {
      const slug = (b.slug ?? b.name ?? b.board) as string | undefined
      if (slug) names.push(slug)
    }
  } else if (typeof res.data === 'string') {
    // Box-drawing table: row lines like '  default    Default board  12'.
    for (const line of res.data.split('\n')) {
      const m = line.match(/^\s*([a-z0-9][a-z0-9_-]*)\s{2,}/i)
      if (m) names.push(m[1])
    }
  }
  return { boards: names, currentBoard: parseCurrentBoard(res.data) }
}

export async function kanbanCreate(opts: {
  title: string
  spec?: string
  status?: string
  assignee?: string
  board?: string
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const rest = await hostedRest()
  if (rest) {
    const res = await rest.restCreateTask(
      {
        title: opts.title,
        body: opts.spec,
        assignee: opts.assignee,
        triage: opts.status === 'triage' || !opts.status,
      },
      opts.board,
    )
    return res.ok ? { ok: true, id: res.data?.id } : { ok: false, error: res.error }
  }
  // Serve-first create.
  try {
    const { kanbanServeCreate } = await import('./kanban-serve')
    const created = await kanbanServeCreate({
      title: opts.title,
      body: opts.spec,
      assignee: opts.assignee,
      triage: opts.status === 'triage' || !opts.status,
    })
    if (created) {
      const { createdTaskId } = await import('./kanban-rest')
      return { ok: true, id: createdTaskId(created) }
    }
  } catch {
    /* fall back to CLI */
  }
  const args = ['create', '--title', opts.title]
  if (opts.spec) args.push('--spec', opts.spec)
  if (opts.status) args.push('--status', opts.status)
  if (opts.assignee) args.push('--assignee', opts.assignee)
  const res = await kanbanExec(args)
  if (!res.ok) return { ok: false, error: res.error }
  // CLI prints the created id; --json isn't guaranteed for create — regex it.
  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  const m = text.match(/(?:id|task)[:\s]+([a-zA-Z0-9_-]{6,})/i)
  return { ok: true, id: m ? m[1] : undefined }
}

export async function kanbanComplete(id: string, board?: string): Promise<{ ok: boolean; error?: string }> {
  const rest = await hostedRest()
  if (rest) {
    const res = await rest.restUpdateTask(id, { status: 'done' }, board)
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  }
  try {
    const { kanbanServeUpdate } = await import('./kanban-serve')
    const updated = await kanbanServeUpdate(id, { status: 'done' })
    if (updated) return { ok: true }
  } catch {
    /* fall back to CLI */
  }
  const res = await kanbanExec(['complete', id])
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true }
}

export async function kanbanAssign(
  id: string,
  worker: string,
  board?: string,
): Promise<{ ok: boolean; error?: string }> {
  const rest = await hostedRest()
  if (rest) {
    const res = await rest.restUpdateTask(id, { assignee: worker }, board)
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  }
  try {
    const { kanbanServeUpdate } = await import('./kanban-serve')
    const updated = await kanbanServeUpdate(id, { assignee: worker })
    if (updated) return { ok: true }
  } catch {
    /* fall back to CLI */
  }
  const res = await kanbanExec(['assign', id, worker])
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true }
}

export async function kanbanSwarm(opts: {
  goal: string
  workers?: number
}): Promise<{ ok: boolean; error?: string }> {
  if (await isHostedAgent()) {
    return { ok: false, error: 'Swarm runs are not available on hosted agents yet. Use “Break this down” on a task.' }
  }
  const args = ['swarm', '--goal', opts.goal]
  if (opts.workers) args.push('--workers', String(opts.workers))
  const res = await kanbanExec(args)
  return { ok: res.ok, error: res.error }
}

/**
 * Append a comment to a task.
 * CLI: `hermes kanban comment <task_id> <text...>` — task_id positional, text
 * is nargs="+" (space-joined). Passing the body as a single argv element keeps
 * spaces intact. Optional `--author` maps to the local profile by default.
 */
export async function kanbanComment(
  id: string,
  text: string,
  board?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!text.trim()) return { ok: false, error: 'comment body is empty' }
  const rest = await hostedRest()
  if (rest) {
    const res = await rest.restComment(id, text.trim(), board)
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  }
  try {
    const { kanbanServeComment } = await import('./kanban-serve')
    const commented = await kanbanServeComment(id, text.trim())
    if (commented) return { ok: true }
  } catch {
    /* fall back to CLI */
  }
  const res = await kanbanExec(['comment', id, text.trim()])
  if (!res.ok) return { ok: false, error: res.error ?? `kanban comment failed (${res.code})` }
  return { ok: true }
}

/** Normalize whatever shape `hermes kanban attachments <id>` returns into a
 *  flat array. Defensive: accepts array | {attachments:[]} | {items:[]}. */
export function normalizeAttachments(data: unknown): KanbanAttachment[] {
  if (Array.isArray(data)) return data as KanbanAttachment[]
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    for (const k of ['attachments', 'items', 'results']) {
      const v = o[k]
      if (Array.isArray(v)) return v as KanbanAttachment[]
    }
  }
  return []
}

/**
 * List a task's attachments. CLI: `hermes kanban attachments <task_id>` (auto
 * --json'd by the bridge). The parent list output doesn't carry an attachment
 * count, so this is the per-task way to surface what's attached.
 */
export async function kanbanAttachments(
  id: string,
  board?: string,
): Promise<{ attachments: KanbanAttachment[]; error?: string }> {
  const rest = await hostedRest()
  if (rest) {
    const res = await rest.restAttachments(id, board)
    if (!res.ok) return { attachments: [], error: res.error }
    return { attachments: normalizeAttachments(res.data) }
  }
  const res = await kanbanExec(['attachments', id])
  if (!res.ok) return { attachments: [], error: res.error ?? `kanban attachments failed (${res.code})` }
  return { attachments: normalizeAttachments(res.data) }
}

/** Best-effort attachment count read off a task's normalized fields. */
export function attachmentCount(t: KanbanTask): number | undefined {
  const n = Number(
    t.attachmentsCount ?? t.num_attachments ?? t.attachmentCount ?? t.attachments_count,
  )
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Make `slug` the agent's active board (hosted: REST; local: the panel just filters). */
export async function kanbanSwitchBoard(slug: string): Promise<{ ok: boolean; error?: string }> {
  const rest = await hostedRest()
  if (!rest) return { ok: true }
  const res = await rest.restSwitchBoard(slug)
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

/**
 * "Break this down": ask the agent to split a task into smaller child tasks.
 * Hosted: POST /tasks/{id}/decompose. Local: `hermes kanban decompose <id>`.
 */
export async function kanbanDecompose(
  id: string,
  board?: string,
): Promise<{ ok: boolean; childCount?: number; message?: string; error?: string }> {
  const rest = await hostedRest()
  if (rest) {
    const res = await rest.restDecompose(id, board)
    if (!res.ok) return { ok: false, error: res.error }
    const n = res.data?.childIds.length ?? 0
    return {
      ok: true,
      childCount: n,
      message: res.data?.fanout
        ? `Split into ${n} smaller task${n === 1 ? '' : 's'}.`
        : res.data?.reason || 'This task is already small enough.',
    }
  }
  // `--board` is a kanban-level flag (before the verb), which the bridge's
  // verb allowlist does not accept — local decompose uses the active board.
  const res = await kanbanExec(['decompose', id])
  if (!res.ok) return { ok: false, error: res.error ?? `kanban decompose failed (${res.code})` }
  return { ok: true, message: 'Broken down into smaller tasks.' }
}
