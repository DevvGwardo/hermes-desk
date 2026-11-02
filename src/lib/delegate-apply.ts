/**
 * Materialize Hermes `delegate_task` / `subagent.*` events into SubagentRun
 * pills. The parent model already gets the specialist result in-session —
 * this module never injects a fake "[Desktop] Specialist finished" prompt.
 */

import type { Agent, Conversation, SubagentRun } from './agents/types'
import {
  appendSubagentMessage,
  getMessagesForConversation,
  getState,
  syncSubagentMessage,
  upsertSubagent,
} from './agents/store'
import {
  type DelegateTaskSpec,
  type SubagentGatewayPayload,
  labelForDelegate,
  mapGatewayStatus,
  parseDelegateTaskArgs,
  readSubagentPayload,
  stableDelegateRunId,
} from './delegate-task'
import { isPlaceholderResult } from './subagent-result'

/** Give up on a still-running `delegate_task` child after this long. */
export const DELEGATE_TIMEOUT_MS = 10 * 60 * 1000

const TERMINAL: ReadonlySet<SubagentRun['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
])

const delegateTimeouts = new Map<string, number>()

function nowIso(): string {
  return new Date().toISOString()
}

function parentAgentIdOf(conversation: Conversation): string {
  return conversation.target.type === 'agent' ? conversation.target.agentId : ''
}

export function findDelegateRun(opts: {
  subagentId?: string
  childSessionId?: string
  toolCallId?: string
  index?: number
}): SubagentRun | null {
  const runs = Object.values(getState().subagentsById)
  if (opts.subagentId) {
    const id = opts.subagentId
    const hit = runs.find(
      (r) => r.hermesSubagentId === id || r.id === id || r.id === `run_${id}`,
    )
    if (hit) return hit
  }
  if (opts.childSessionId) {
    const hit = runs.find((r) => r.hermesSessionId === opts.childSessionId)
    if (hit) return hit
  }
  if (opts.toolCallId) {
    const index = opts.index ?? 0
    const hit = runs.find((r) => r.toolCallId === opts.toolCallId && (r.taskIndex ?? 0) === index)
    if (hit) return hit
  }
  return null
}

/** Same conversation + task slot, including terminal pills. Prefer a live child. */
export function findDelegateSlot(opts: {
  conversationId: string
  index: number
  subagentId?: string
}): SubagentRun | null {
  const runs = Object.values(getState().subagentsById).filter((r) => {
    if (r.conversationId !== opts.conversationId) return false
    if (r.source !== 'delegate_task') return false
    if ((r.taskIndex ?? 0) !== opts.index) return false
    if (opts.subagentId && r.hermesSubagentId && r.hermesSubagentId !== opts.subagentId) {
      return false
    }
    return true
  })
  const live = runs.find((r) => r.status === 'queued' || r.status === 'running')
  if (live) return live
  if (opts.subagentId) {
    const bound = runs.find((r) => r.hermesSubagentId === opts.subagentId)
    if (bound) return bound
  }
  return runs.find((r) => !r.hermesSubagentId) ?? runs[0] ?? null
}

function lastHintText(conversationId: string): string {
  const msgs = getMessagesForConversation(conversationId)
  const parts: string[] = []
  for (let i = msgs.length - 1; i >= 0 && parts.length < 4; i--) {
    const m = msgs[i]
    if (!m?.content.trim()) continue
    if (m.role === 'user' || m.role === 'agent') parts.push(m.content)
  }
  return parts.join('\n')
}

export function conversationHasLiveDelegates(conversationId: string): boolean {
  return Object.values(getState().subagentsById).some(
    (r) =>
      r.conversationId === conversationId &&
      (r.status === 'queued' || r.status === 'running'),
  )
}

/** Child dropped off `delegation.status` after we had seen it live. */
export function shouldFinishAfterLeavingActive(opts: {
  seenActive: boolean
  stillActive: boolean
  startedAt?: string
  nowMs: number
  graceMs?: number
}): boolean {
  if (!opts.seenActive || opts.stillActive) return false
  const started = opts.startedAt ? Date.parse(opts.startedAt) : 0
  if (!Number.isFinite(started) || started <= 0) return false
  return opts.nowMs - started >= (opts.graceMs ?? 8_000)
}

export function usableDelegateSummary(run: SubagentRun): string {
  const candidates = [
    run.result?.summary,
    ...[...run.digests].reverse().map((d) => d.text),
  ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
  return candidates.find((s) => !isPlaceholderResult(s))?.trim() ?? ''
}

export function armDelegateTimeout(runId: string, timeoutMs = DELEGATE_TIMEOUT_MS): void {
  if (delegateTimeouts.has(runId)) return
  if (typeof window === 'undefined') return
  const timer = window.setTimeout(() => {
    delegateTimeouts.delete(runId)
    timeoutDelegateRun(runId)
  }, timeoutMs)
  delegateTimeouts.set(runId, timer)
}

/** Child activity restarts the clock: the timeout measures silence, not total runtime. */
export function touchDelegateTimeout(runId: string, timeoutMs = DELEGATE_TIMEOUT_MS): void {
  clearDelegateTimeout(runId)
  armDelegateTimeout(runId, timeoutMs)
}

export function clearDelegateTimeout(runId: string): void {
  const timer = delegateTimeouts.get(runId)
  if (timer !== undefined && typeof window !== 'undefined') window.clearTimeout(timer)
  delegateTimeouts.delete(runId)
}

export function resetDelegateTimeouts(): void {
  if (typeof window !== 'undefined') {
    for (const timer of delegateTimeouts.values()) window.clearTimeout(timer)
  }
  delegateTimeouts.clear()
}

export function timeoutDelegateRun(runId: string): SubagentRun | null {
  const run = getState().subagentsById[runId]
  if (!run || TERMINAL.has(run.status)) return null
  return writeRun({
    ...run,
    status: 'failed',
    finishedAt: nowIso(),
    error: 'Specialist timed out before reporting back.',
  })
}

function writeRun(next: SubagentRun): SubagentRun {
  upsertSubagent(next)
  syncSubagentMessage(next)
  return getState().subagentsById[next.id] ?? next
}

function createRun(opts: {
  conversation: Conversation
  spec: DelegateTaskSpec
  agents: Agent[]
  toolCallId?: string
  subagentId?: string
  childSessionId?: string
  status?: SubagentRun['status']
  at?: string
}): SubagentRun {
  const at = opts.at ?? nowIso()
  const label = labelForDelegate(opts.spec, opts.agents, {
    currentAgentId: parentAgentIdOf(opts.conversation) || null,
    hintText: lastHintText(opts.conversation.id),
  })
  const id = stableDelegateRunId({
    subagentId: opts.subagentId,
    toolCallId: opts.toolCallId,
    index: opts.spec.index,
  })
  const existing =
    getState().subagentsById[id] ??
    findDelegateRun({
      subagentId: opts.subagentId,
      childSessionId: opts.childSessionId,
      toolCallId: opts.toolCallId,
      index: opts.spec.index,
    }) ??
    (opts.toolCallId || opts.subagentId
      ? null
      : findDelegateSlot({
          conversationId: opts.conversation.id,
          index: opts.spec.index,
          subagentId: opts.subagentId,
        }))
  const title =
    opts.spec.goal.length > 48 ? `${opts.spec.goal.slice(0, 48)}…` : opts.spec.goal
  const nextStatus =
    existing && TERMINAL.has(existing.status)
      ? existing.status
      : (opts.status ?? existing?.status ?? 'queued')
  const base: SubagentRun = existing
    ? {
        ...existing,
        title: existing.title || title,
        label: existing.label || label,
        status: nextStatus,
        toolCallId: existing.toolCallId ?? opts.toolCallId,
        taskIndex: existing.taskIndex ?? opts.spec.index,
        source: existing.source ?? 'delegate_task',
        hermesSubagentId: existing.hermesSubagentId ?? opts.subagentId,
        hermesSessionId: existing.hermesSessionId ?? opts.childSessionId,
      }
    : {
        id,
        parentAgentId: parentAgentIdOf(opts.conversation),
        kind: 'custom',
        title,
        status: opts.status ?? 'queued',
        createdAt: at,
        startedAt: opts.status === 'running' ? at : undefined,
        digests: [],
        conversationId: opts.conversation.id,
        label,
        source: 'delegate_task',
        toolCallId: opts.toolCallId,
        taskIndex: opts.spec.index,
        hermesSubagentId: opts.subagentId,
        hermesSessionId: opts.childSessionId,
      }
  const next = writeRun(base)
  if (!existing) appendSubagentMessage(opts.conversation.id, next)
  if (!TERMINAL.has(next.status)) armDelegateTimeout(next.id)
  else clearDelegateTimeout(next.id)
  return getState().subagentsById[next.id] ?? next
}

/** Create one pill per `delegate_task` child (including parallel `tasks[]`). */
export function materializeDelegateRuns(opts: {
  conversation: Conversation
  args: unknown
  toolCallId?: string
  agents?: Agent[]
}): SubagentRun[] {
  const agents = opts.agents ?? getState().agents
  const specs = parseDelegateTaskArgs(opts.args)
  return specs.map((spec) =>
    createRun({
      conversation: opts.conversation,
      spec,
      agents,
      toolCallId: opts.toolCallId,
      status: 'running',
      at: nowIso(),
    }),
  )
}

export function failDelegateRuns(opts: {
  conversation: Conversation
  toolCallId?: string
  error: string
}): SubagentRun[] {
  const at = nowIso()
  const runs = Object.values(getState().subagentsById).filter((r) => {
    if (r.conversationId !== opts.conversation.id) return false
    if (r.status !== 'queued' && r.status !== 'running') return false
    if (opts.toolCallId) return r.toolCallId === opts.toolCallId
    return r.source === 'delegate_task'
  })
  return runs.map((run) => {
    clearDelegateTimeout(run.id)
    return writeRun({
      ...run,
      status: 'failed',
      finishedAt: at,
      error: opts.error,
    })
  })
}

/** Close SSE-only delegate pills when the parent stream ends with no subagent.complete. */
export function settleOrphanDelegates(opts: {
  conversation: Conversation
  reason: string
  status?: 'failed' | 'completed'
}): SubagentRun[] {
  const at = nowIso()
  const status = opts.status ?? 'failed'
  const runs = Object.values(getState().subagentsById).filter((r) => {
    if (r.conversationId !== opts.conversation.id) return false
    if (r.source !== 'delegate_task') return false
    if (r.status !== 'queued' && r.status !== 'running') return false
    if (r.hermesSessionId) return false
    return true
  })
  return runs.map((run) => {
    const summary =
      run.result?.summary ||
      run.digests.at(-1)?.text ||
      opts.reason
    clearDelegateTimeout(run.id)
    return writeRun({
      ...run,
      status,
      finishedAt: at,
      error: status === 'failed' ? opts.reason : run.error,
      result: status === 'completed' ? { summary } : run.result,
    })
  })
}

function digestLine(run: SubagentRun, text: string, at: string): SubagentRun['digests'] {
  const trimmed = text.trim()
  if (!trimmed) return run.digests
  const last = run.digests.at(-1)
  if (last?.id === 'live') {
    return [{ id: 'live', at, text: trimmed }]
  }
  if (last?.text === trimmed) return run.digests
  return [...run.digests, { id: `d_${at}`, at, text: trimmed }]
}

/**
 * Apply a gateway `subagent.*` event (arrives on the PARENT session id).
 * Returns the updated run, or null when the event cannot be bound.
 */
export function applySubagentGatewayEvent(opts: {
  conversation: Conversation
  type: string
  payload: unknown
  agents?: Agent[]
  toolCallId?: string
}): SubagentRun | null {
  const payload: SubagentGatewayPayload = readSubagentPayload(opts.payload)
  const agents = opts.agents ?? getState().agents
  const index = payload.task_index ?? 0
  const spec: DelegateTaskSpec = {
    goal: payload.goal || 'Delegated task',
    subagentType: undefined,
    index,
  }
  let run =
    findDelegateRun({
      subagentId: payload.subagent_id,
      childSessionId: payload.child_session_id,
      toolCallId: opts.toolCallId,
      index,
    }) ??
    findDelegateSlot({
      conversationId: opts.conversation.id,
      index,
      subagentId: payload.subagent_id,
    }) ??
    createRun({
      conversation: opts.conversation,
      spec,
      agents,
      toolCallId: opts.toolCallId,
      subagentId: payload.subagent_id,
      childSessionId: payload.child_session_id,
      status: opts.type === 'subagent.spawn_requested' ? 'queued' : 'running',
    })

  const at = nowIso()
  const type = opts.type
  if (payload.subagent_id && !run.hermesSubagentId) {
    run = { ...run, hermesSubagentId: payload.subagent_id }
  }
  if (payload.child_session_id && !run.hermesSessionId) {
    run = { ...run, hermesSessionId: payload.child_session_id }
  }
  if (payload.goal && run.title === 'Delegated task') {
    run = {
      ...run,
      title: payload.goal.length > 48 ? `${payload.goal.slice(0, 48)}…` : payload.goal,
    }
  }

  if (!TERMINAL.has(run.status) && (type === 'subagent.start' || type === 'subagent.progress' ||
    type === 'subagent.thinking' || type === 'subagent.tool')) touchDelegateTimeout(run.id)

  if (type === 'subagent.spawn_requested') {
    return writeRun({
      ...run,
      status: TERMINAL.has(run.status) ? run.status : 'queued',
    })
  }
  if (type === 'subagent.start') {
    return writeRun({
      ...run,
      status: TERMINAL.has(run.status) ? run.status : 'running',
      startedAt: run.startedAt ?? at,
    })
  }
  if (type === 'subagent.progress' || type === 'subagent.thinking' || type === 'subagent.tool') {
    const text = payload.text || payload.tool_preview || payload.summary || ''
    if (!text.trim()) return writeRun(run)
    return writeRun({
      ...run,
      status: TERMINAL.has(run.status) ? run.status : 'running',
      digests: digestLine(run, text, at),
    })
  }
  if (type === 'subagent.complete') {
    const raw =
      payload.summary ||
      payload.text ||
      run.result?.summary ||
      run.digests.at(-1)?.text ||
      ''
    const status = mapGatewayStatus(payload.status, 'completed')
    const real = raw.trim() && !isPlaceholderResult(raw) ? raw.trim() : usableDelegateSummary(run)
    clearDelegateTimeout(run.id)
    if (status === 'completed' && !real) {
      return writeRun({
        ...run,
        status: 'failed',
        finishedAt: at,
        error: 'Specialist returned no summary.',
      })
    }
    return writeRun({
      ...run,
      status,
      finishedAt: at,
      digests: real ? digestLine(run, real, at) : run.digests,
      result: real ? { summary: real } : run.result,
      error: status === 'failed' ? real || raw || run.error : run.error,
    })
  }
  return writeRun(run)
}

export function parseToolArgs(args: unknown, argsText?: string): unknown {
  if (args && typeof args === 'object') return args
  if (typeof argsText === 'string' && argsText.trim()) {
    try {
      return JSON.parse(argsText) as unknown
    } catch {
      return { goal: argsText }
    }
  }
  return args
}

// ---------------------------------------------------------------------------
// Browser-use progress (plan step 2)
// ---------------------------------------------------------------------------

export interface BrowserProgressPayload {
  jobId: string
  status: string
  url?: string
  screenshotRef?: string
}

function readBrowserProgress(payload: unknown): BrowserProgressPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  if (typeof p.jobId !== 'string' || !p.jobId.trim()) return null
  if (typeof p.status !== 'string' || !p.status.trim()) return null
  const out: BrowserProgressPayload = { jobId: p.jobId.trim(), status: p.status.trim() }
  if (typeof p.url === 'string' && p.url.trim()) out.url = p.url.trim()
  if (typeof p.screenshotRef === 'string' && p.screenshotRef.trim()) {
    out.screenshotRef = p.screenshotRef.trim()
  }
  return out
}

function mapBrowserStatus(status: string): SubagentRun['status'] | null {
  const s = status.trim().toLowerCase()
  if (s === 'done' || s === 'completed' || s === 'success') return 'completed'
  if (s === 'failed' || s === 'error') return 'failed'
  if (s === 'stopped' || s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'queued' || s === 'pending' || s === 'created') return 'queued'
  if (s === 'running' || s === 'working' || s === 'in_progress' || s === 'in-progress') {
    return 'running'
  }
  return null
}

/**
 * Apply a `browser.progress` event ({jobId, status, url?, screenshotRef?})
 * to the matching `browserUse` run. Binds by job id; falls back to the
 * oldest still-active unbound `browserUse` run in the conversation (the job
 * id is server-issued, so a fresh spawn has nothing to match yet).
 * Fail-closed: malformed payloads, unknown jobs with no active run, and
 * already-terminal runs all leave the store untouched (null, no phantom
 * pills). Screenshot refs ride in the digest text so the existing VmShot
 * path picks up `/opt/data/…` refs with no new renderer code.
 */
export function applyBrowserProgressEvent(opts: {
  conversation: Conversation
  payload: unknown
}): SubagentRun | null {
  const hit = readBrowserProgress(opts.payload)
  if (!hit) return null
  const runs = Object.values(getState().subagentsById).filter(
    (r) =>
      r.conversationId === opts.conversation.id &&
      r.kind === 'browserUse' &&
      (r.status === 'queued' || r.status === 'running'),
  )
  if (runs.length === 0) return null
  const bound = runs.find((r) => r.browserJobId === hit.jobId)
  const run = bound ?? runs.find((r) => !r.browserJobId) ?? null
  if (!run) return null

  const at = nowIso()
  const status = mapBrowserStatus(hit.status) ?? run.status
  const next: SubagentRun = {
    ...run,
    status,
    browserJobId: run.browserJobId ?? hit.jobId,
  }
  if ((status === 'running' || status === 'queued') && !next.startedAt) next.startedAt = at
  const urlBit = hit.url ? ` ${hit.url}` : ''
  const shotBit = hit.screenshotRef ? `\nscreenshot: ${hit.screenshotRef}` : ''
  const text = `Browsing${urlBit}…${shotBit}`.trim()
  next.digests = digestLine(next, text, at)
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    next.finishedAt = at
    if (status === 'failed' && !next.error) next.error = `Browser job ${hit.jobId} failed`
  }
  return writeRun(next)
}
