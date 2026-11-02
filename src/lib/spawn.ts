/**
 * Spawn router — wires the 14 subagent kinds to REAL local spawners.
 *
 * Two backends:
 *   - task     → the ~/.agent-tasks queue via the Electron bridge
 *               (`window.nubAgent.task` → `~/.agent-tasks/bin/task` in main).
 *               Verified: the CLI defaults `add` to the registered default
 *               agent (`task agent list` shows `* hermes-local`), so we use
 *               plain `['add', goal]` — no `--agent` (a bare 'hermes' agent
 *               isn't registered, and the CLI has no --json).
 *   - kanban   → `hermes kanban create` + `dispatch` via the existing
 *               generalized Hermes bridge (`window.nubAgent.hermes('kanban',…)`),
 *               same path KanbanPanel/kanban.ts already use.
 *
 * Hosted VM (linked Nub agent): every kind becomes a kanban task on the VM
 * over dashboard REST (POST /api/plugins/kanban/tasks + /dispatch) — the
 * local ~/.agent-tasks queue and CLI never run for a hosted agent.
 *
 * In a plain browser (vite dev without Electron) both bridges are absent:
 * spawns resolve with channel 'unavailable' and a desktop-only error.
 */
import type { SubagentKind } from './agents/types'

export type SpawnChannel = 'task' | 'kanban' | 'unavailable'

export interface SpawnResult {
  ok: boolean
  kind: SubagentKind
  channel: SpawnChannel
  /** Queue/task id when the backend reported one (best-effort). */
  taskId?: string
  error?: string
}

interface BridgeResult {
  ok: boolean
  code?: number
  data?: unknown
  error?: string
}

type TaskBridge = (args: string[]) => Promise<BridgeResult>
type HermesBridge = (kind: string, args: string[]) => Promise<BridgeResult>

/** Kinds that spawn onto the local task-queue worker. */
const TASK_KINDS: ReadonlySet<SubagentKind> = new Set<SubagentKind>([
  'bash',
  'shell',
  'explore',
  'debug',
  'computerUse',
  'mediaReview',
  'watchVideo',
  'fileGlobbed',
  'custom',
  'browserUse',
  // watcher / cursorGuide aren't named in the routing brief; route them to
  // the local worker too so all 14 kinds are covered.
  'watcher',
  'cursorGuide',
])

/** Kinds that spawn as kanban cards, then dispatch a worker pass. */
const KANBAN_KINDS: ReadonlySet<SubagentKind> = new Set<SubagentKind>(['executor', 'cloudCoder'])

function getTaskBridge(): TaskBridge | null {
  // All target members are optional, so a direct assertion is comparable-safe
  // (no need for the unchecked `as unknown as` double cast).
  const w = window as { nubAgent?: { task?: TaskBridge } }
  return w.nubAgent?.task ?? null
}

function getHermesBridge(): HermesBridge | null {
  const w = window as unknown as { nubAgent?: { hermes?: HermesBridge } }
  return w.nubAgent?.hermes ?? null
}

/** True when either local spawner is reachable (desktop app running). */
export const spawnAvailable = (): boolean =>
  getTaskBridge() != null || getHermesBridge() != null

/** Prefix the worker prompt so hydration can claim the session as a side_chat. */
export function taggedSpawnGoal(runId: string, goal: string): string {
  return `[maia-run:${runId}] ${goal}`
}

/** Args for `task add`. `--agent` is best-effort — callers fall back if the CLI rejects it. */
export function taskAddArgs(goal: string, agent?: string): string[] {
  return agent ? ['add', '--agent', agent, goal] : ['add', goal]
}

function parseTaskId(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  const m = text.match(/\b(t-[a-z0-9_-]+)\b/i)
  return m ? m[1] : undefined
}

async function spawnToTaskQueue(
  kind: SubagentKind,
  goal: string,
  agent?: string,
): Promise<SpawnResult> {
  const bridge = getTaskBridge()
  if (!bridge) {
    return {
      ok: false,
      kind,
      channel: 'unavailable',
      error: 'Task queue requires the desktop app (local ~/.agent-tasks bridge).',
    }
  }
  try {
    let res = await bridge(taskAddArgs(goal, agent))
    if (!res.ok && agent) {
      res = await bridge(taskAddArgs(goal))
    }
    if (!res.ok) {
      return { ok: false, kind, channel: 'task', error: res.error ?? `task add failed (${res.code})` }
    }
    return { ok: true, kind, channel: 'task', taskId: parseTaskId(res.data) }
  } catch (err) {
    return { ok: false, kind, channel: 'task', error: String((err as Error)?.message ?? err) }
  }
}

async function spawnToKanban(
  kind: SubagentKind,
  goal: string,
): Promise<SpawnResult> {
  const bridge = getHermesBridge()
  if (!bridge) {
    return {
      ok: false,
      kind,
      channel: 'unavailable',
      error: 'Kanban requires the desktop app (local Hermes bridge).',
    }
  }
  try {
    const createRes = await bridge('kanban', ['create', '--title', goal, '--assignee', 'hermes'])
    if (!createRes.ok) {
      return {
        ok: false,
        kind,
        channel: 'kanban',
        error: createRes.error ?? `kanban create failed (${createRes.code})`,
      }
    }
    // Kick a worker pass so the fresh card actually gets picked up.
    const dispatchRes = await bridge('kanban', ['dispatch', '--max', '1'])
    if (!dispatchRes.ok) {
      return {
        ok: false,
        kind,
        channel: 'kanban',
        error: `card created but dispatch failed: ${dispatchRes.error ?? dispatchRes.code}`,
      }
    }
    return { ok: true, kind, channel: 'kanban' }
  } catch (err) {
    return { ok: false, kind, channel: 'kanban', error: String((err as Error)?.message ?? err) }
  }
}

/**
 * Spawn a subagent kind onto a real local spawner.
 *
 * @returns {Promise<SpawnResult>} never throws — failures are reported on the
 * result. channel 'task' | 'kanban' | 'unavailable'.
 */
export async function spawnSubagent(
  kind: SubagentKind,
  goal: string,
  opts?: { agent?: string },
): Promise<SpawnResult> {
  const clean = goal.trim()
  if (!clean) {
    return { ok: false, kind, channel: 'unavailable', error: 'goal is empty' }
  }
  if (KANBAN_KINDS.has(kind) || TASK_KINDS.has(kind)) {
    if (await isHostedAgent()) {
      const { spawnHostedKanbanTask } = await import('./kanban-rest')
      return spawnHostedKanbanTask(kind, clean, opts?.agent)
    }
  }
  if (KANBAN_KINDS.has(kind)) return spawnToKanban(kind, clean)
  if (TASK_KINDS.has(kind)) return spawnToTaskQueue(kind, clean, opts?.agent)
  return {
    ok: false,
    kind,
    channel: 'unavailable',
    error: `unrouted subagent kind: ${kind}`,
  }
}

async function isHostedAgent(): Promise<boolean> {
  const { isHostedAgent: hosted } = await import('./agent-rest')
  return hosted()
}
