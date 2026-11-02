/**
 * Live subagent status sync (Grok Bot parity, hermes-agent backend).
 *
 * When a subagent is spawned onto the local ~/.agent-tasks queue
 * (window.nubAgent.task), we poll `task show <id>` until the run reaches a
 * terminal state, then fold the queue status + turns + result back into the
 * store's SubagentRun so the bubble and sub-thread show real progress
 * (queued → running → completed/failed) instead of fabricated chips.
 *
 * Desktop-only: the bridge is absent in a plain browser, so polling no-ops.
 */

import {
  boundHermesSessionIds,
  findSubagentRunForSession,
  getState,
  subscribe,
  syncSubagentMessage,
  upsertSubagent,
} from './agents/store'
import type { SubagentDigest, SubagentRun, SubagentStatus } from './agents/types'
import { isPlaceholderResult } from './subagent-result'
import { parseSessionsTable } from './agents/hermes-sessions'

type TaskBridge = (args: string[]) => Promise<{ ok: boolean; data?: unknown; error?: string }>
type HermesBridge = (kind: string, args: string[]) => Promise<{
  ok: boolean
  data?: unknown
  error?: string
}>

function getTaskBridge(): TaskBridge | null {
  const w = window as Window & { nubAgent?: { task?: TaskBridge } }
  return w.nubAgent?.task ?? null
}

function getHermesBridge(): HermesBridge | null {
  const w = window as Window & { nubAgent?: { hermes?: HermesBridge } }
  return w.nubAgent?.hermes ?? null
}

/** Map a queue status word to our SubagentStatus. */
export function mapStatus(word: string): SubagentStatus | null {
  const w = word.trim().toLowerCase()
  if (w === 'queued' || w === 'pending' || w === 'waiting' || w === 'created') return 'queued'
  if (
    w === 'running' ||
    w === 'working' ||
    w === 'in_progress' ||
    w === 'in-progress' ||
    w === 'claimed' ||
    w === 'waiting_user'
  ) {
    return 'running'
  }
  if (w === 'completed' || w === 'done' || w === 'success') return 'completed'
  if (w === 'failed' || w === 'error') return 'failed'
  if (w === 'cancelled' || w === 'canceled') return 'cancelled'
  return null
}

export interface TaskShowTurn {
  role: string
  content: string
}

export interface TaskShow {
  fields: Record<string, string>
  turns: TaskShowTurn[]
  result?: string
  reason?: string
}

/** Parse `task show <id>` text — header `key: value` lines plus turns/result. */
export function parseTaskShow(text: unknown): TaskShow {
  if (typeof text !== 'string') return { fields: {}, turns: [] }

  let result: string | undefined
  let reason: string | undefined
  let rest = text

  const failSplit = rest.split(/\n--- failure reason ---\n/)
  if (failSplit.length > 1) {
    reason = failSplit[1]!.trim() || undefined
    rest = failSplit[0]!
  }
  const resultSplit = rest.split(/\n--- result ---\n/)
  if (resultSplit.length > 1) {
    result = resultSplit[1]!.trim() || undefined
    rest = resultSplit[0]!
  }

  const turnsSplit = rest.split(/\n--- turns \(\d+\) ---\n/)
  const header = turnsSplit[0] ?? ''
  const turnsBody = turnsSplit[1]

  const fields: Record<string, string> = {}
  for (const line of header.split('\n')) {
    // Same contract as /^\s*([\w -]+?)\s*:\s*(.*?)\s*$/ without its
    // quadratic backtracking on long space runs: first colon, a key of word
    // characters, spaces and dashes, and a value with no line terminators.
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const prefix = line.slice(0, colon)
    const key = prefix.trim()
    const value = line.slice(colon + 1).trim()
    if (key ? !/^[\w -]+$/.test(key) : !prefix.includes(' ')) continue
    if (/[\r\u2028\u2029]/.test(value)) continue
    fields[key.toLowerCase()] = value
  }

  const turns: TaskShowTurn[] = []
  if (turnsBody) {
    const chunks = turnsBody.split(/^\[\d+\]\s+/m).filter((c) => c.trim().length > 0)
    for (const chunk of chunks) {
      const m = chunk.match(/^(\w+):\s*\n?([\s\S]*)$/)
      if (!m) continue
      const content = m[2]!
        .split('\n')
        .map((l) => l.replace(/^ {4}/, ''))
        .join('\n')
        .trim()
      turns.push({ role: m[1]!, content })
    }
  }

  return { fields, turns, result, reason }
}

/** Hermes CLI session ids look like `20260812_170840_d90055`. */
export function extractHermesSessionId(text: string): string | undefined {
  const m = text.match(/\b(\d{8}_\d{6}_[A-Za-z0-9]+)\b/)
  return m?.[1]
}

const TERMINAL: ReadonlySet<SubagentStatus> = new Set<SubagentStatus>([
  'completed',
  'failed',
  'cancelled',
])

function digestsFromTurns(turns: TaskShowTurn[], now: string): SubagentDigest[] {
  return turns
    .filter((t) => t.role !== 'user' && t.content.length > 0)
    .map((t, i) => ({
      id: `turn_${i}`,
      at: now,
      text: t.content,
    }))
}

function runChanged(a: SubagentRun, b: SubagentRun): boolean {
  if (a.status !== b.status) return true
  if (a.hermesSessionId !== b.hermesSessionId) return true
  if (a.error !== b.error) return true
  if (a.result?.summary !== b.result?.summary) return true
  if (a.digests.length !== b.digests.length) return true
  if (a.digests.at(-1)?.text !== b.digests.at(-1)?.text) return true
  return false
}

/**
 * Fold a `task show` payload into a run. Pure — the poller writes the result.
 * Status stays on the previous value when the show text has no recognised
 * status word.
 */
export function applyTaskShowToRun(
  run: SubagentRun,
  raw: string,
  now = new Date().toISOString(),
): SubagentRun {
  const parsed = parseTaskShow(raw)
  const status = mapStatus(parsed.fields['status'] ?? '') ?? run.status
  const next: SubagentRun = { ...run, status }
  if (status === 'running' && !next.startedAt) next.startedAt = now
  const sessionId = extractHermesSessionId(raw)
  if (sessionId) next.hermesSessionId = sessionId

  const digests = digestsFromTurns(parsed.turns, now)
  if (digests.length > 0) next.digests = digests

  if (TERMINAL.has(status)) {
    next.finishedAt = now
    if (parsed.result && !isPlaceholderResult(parsed.result)) {
      next.result = { summary: parsed.result }
    } else if (!next.result?.summary || isPlaceholderResult(next.result.summary)) {
      const last = [...(next.digests.length ? next.digests : digests)]
        .reverse()
        .find((d) => d.text && !isPlaceholderResult(d.text))
      next.result = {
        summary:
          parsed.result ||
          last?.text ||
          (status === 'completed'
            ? `Task ${run.taskId} completed on the local hermes worker.`
            : status === 'failed'
              ? `Task ${run.taskId} failed on the local hermes worker.`
              : `Task ${run.taskId} cancelled.`),
      }
    }
    if (status === 'failed') {
      next.error = parsed.reason || parsed.result || next.error || `Task ${run.taskId} failed`
    }
  }
  return next
}

const polling = new Map<string, number>()

/** Consecutive refused `task show` polls before the run is reported lost. */
export const MAX_POLL_FAILURES = 5

/** Test hook: drop in-flight pollers so cases don't leak across tests. */
export function resetSubagentPolling(): void {
  polling.clear()
}

async function tryBindHermesSession(run: SubagentRun): Promise<string | undefined> {
  if (run.hermesSessionId) return run.hermesSessionId
  const bridge = getHermesBridge()
  if (!bridge) return undefined
  try {
    const res = await bridge('sessions', ['list', '--limit', '20'])
    if (!res.ok || typeof res.data !== 'string') return undefined
    const rows = parseSessionsTable(res.data)
    const owned = boundHermesSessionIds()
    const hit =
      rows.find((r) => findSubagentRunForSession(r.id, r.title)?.id === run.id) ??
      rows.find((r) => !owned.has(r.id) && r.title.includes(`[maia-run:${run.id}]`))
    return hit?.id
  } catch {
    return undefined
  }
}

/**
 * Kick off (or continue) polling for a run. Called whenever the app observes
 * a non-terminal run with a taskId. Polls every 2.5s; stops on terminal state.
 * Keeps ticking across queued → running — a single status flip must not
 * kill the poller (that was the live /spawn freeze).
 */
export function pollSubagent(runId: string): void {
  if (polling.has(runId)) return
  const bridge = getTaskBridge()
  if (!bridge) return
  const run = getState().subagentsById[runId]
  if (!run?.taskId) return

  let failures = 0
  const tick = async () => {
    const cur = getState().subagentsById[runId]
    if (!cur || TERMINAL.has(cur.status)) {
      polling.delete(runId)
      return
    }
    try {
      const res = await bridge(['show', cur.taskId!])
      if (!res.ok || typeof res.data !== 'string') {
        // One refused read (queue busy, file mid-write) is not a verdict.
        if (++failures < MAX_POLL_FAILURES) {
          window.setTimeout(tick, 2500)
          return
        }
        polling.delete(runId)
        const latest = getState().subagentsById[runId]
        if (!latest || TERMINAL.has(latest.status)) return
        const failed: SubagentRun = {
          ...latest,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: `Lost track of task ${latest.taskId}: ${res.error || 'its status could not be read'}`,
        }
        upsertSubagent(failed)
        syncSubagentMessage(failed)
        return
      }
      failures = 0
      let next = applyTaskShowToRun(cur, res.data)
      if (!next.hermesSessionId) {
        const sid = await tryBindHermesSession(next)
        if (sid) next = { ...next, hermesSessionId: sid }
      }
      if (runChanged(cur, next)) {
        upsertSubagent(next)
        syncSubagentMessage(next)
      }
      if (TERMINAL.has(next.status)) {
        polling.delete(runId)
        return
      }
    } catch {
      /* transient bridge error — keep polling */
    }
    window.setTimeout(tick, 2500)
  }
  polling.set(runId, 1)
  void tick()
}

/**
 * Resolve when a run reaches completed/failed/cancelled. Used by the Chief
 * of Staff loop so the parent can summarize the specialist's result.
 */
export function waitForSubagent(runId: string, timeoutMs = 180_000): Promise<SubagentRun> {
  pollSubagent(runId)
  return new Promise((resolve, reject) => {
    const cur = getState().subagentsById[runId]
    if (cur && TERMINAL.has(cur.status)) {
      resolve(cur)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsub = subscribe(() => {
      const run = getState().subagentsById[runId]
      if (run && TERMINAL.has(run.status)) {
        if (timer) clearTimeout(timer)
        unsub()
        resolve(run)
      }
    })
    timer = setTimeout(() => {
      unsub()
      const run = getState().subagentsById[runId]
      if (run && TERMINAL.has(run.status)) resolve(run)
      else reject(new Error(`subagent ${runId} timed out`))
    }, timeoutMs)
  })
}
