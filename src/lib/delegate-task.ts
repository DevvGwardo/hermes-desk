/**
 * Hermes `delegate_task` — parse tool args / gateway subagent.* payloads.
 *
 * Grok Bot exposes Message/Check/Stop as model tools. Hermes does not.
 * The parent model calls `delegate_task`; the host maps those events to pills.
 * Parallel fan-out is `tasks: [...]` on that one call, not a desktop spawn loop.
 */

import type { Agent } from './agents/types'
import { matchPeerDelegate, peerToken } from './peer-roster'

export const DELEGATE_TASK_TOOL = 'delegate_task'

export interface DelegateTaskSpec {
  goal: string
  context?: string
  subagentType?: string
  role?: 'leaf' | 'orchestrator'
  index: number
}

export interface SubagentGatewayPayload {
  goal?: string
  subagent_id?: string
  child_session_id?: string
  parent_id?: string
  task_index?: number
  task_count?: number
  status?: string
  summary?: string
  text?: string
  tool_name?: string
  tool_preview?: string
  duration_seconds?: number
}

export function isDelegateTaskTool(name: unknown): boolean {
  return typeof name === 'string' && name === DELEGATE_TASK_TOOL
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* not JSON */
    }
  }
  return {}
}

function firstString(...candidates: unknown[]): string {
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function taskRole(value: unknown): 'leaf' | 'orchestrator' | undefined {
  if (value === 'leaf' || value === 'orchestrator') return value
  return undefined
}

/** Pull one or many child specs from a `delegate_task` tool-call payload. */
export function parseDelegateTaskArgs(args: unknown): DelegateTaskSpec[] {
  const record = asRecord(args)
  const rawTasks = Array.isArray(record.tasks) ? record.tasks : []
  const tasks = rawTasks.length > 0 ? rawTasks.map(asRecord) : [record]
  const topType = firstString(record.subagent_type, record.subagentType)
  const topRole = taskRole(record.role)
  return tasks.map((task, index) => {
    const goal = firstString(task.goal, record.goal) || 'Delegated task'
    const context = firstString(task.context, record.context) || undefined
    const subagentType =
      firstString(task.subagent_type, task.subagentType, topType) || undefined
    const role = taskRole(task.role) ?? topRole
    return { goal, context, subagentType, role, index }
  })
}

export function stableDelegateRunId(opts: {
  subagentId?: string
  toolCallId?: string
  index: number
}): string {
  if (opts.subagentId?.trim()) return `run_${opts.subagentId.trim()}`
  if (opts.toolCallId?.trim()) return `run_${opts.toolCallId.trim()}_${opts.index}`
  return `run_delegate_${opts.index}`
}

/** Display name for the Grok-style "Messaged TravelAgent" pill. */
export function labelForDelegate(
  spec: DelegateTaskSpec,
  agents: Agent[],
  opts?: { currentAgentId?: string | null; hintText?: string },
): string {
  if (spec.subagentType) {
    const needle = spec.subagentType.trim().toLowerCase()
    const hit = agents.find((a) => {
      const token = peerToken(a).toLowerCase()
      return token === needle || a.name.toLowerCase() === needle || a.id.toLowerCase() === needle
    })
    if (hit) return hit.name
    return spec.subagentType
  }
  // The Chief is told to open every goal with "<Name>:" (peerRosterBlock).
  // An exact roster name there wins over fuzzy matching of the task body,
  // which may mention other agents.
  const prefix = /^\s*([^:\n]{1,64}):/.exec(spec.goal)?.[1]?.trim().toLowerCase()
  if (prefix) {
    const named = agents.find(
      (a) => a.id !== opts?.currentAgentId && a.name.trim().toLowerCase() === prefix,
    )
    if (named) return named.name
  }
  const blob = [spec.goal, spec.context, opts?.hintText].filter(Boolean).join('\n')
  const peer = matchPeerDelegate(blob, agents, opts?.currentAgentId)
  if (peer) return peer.agent.name
  const firstLine = spec.goal.split('\n')[0]?.trim() ?? ''
  if (firstLine.length > 2 && firstLine.length <= 40 && !/\s{2,}/.test(firstLine)) {
    const beforeColon = firstLine.split(/[:·]/)[0]?.trim() ?? ''
    if (beforeColon && beforeColon.length <= 32) return beforeColon
  }
  return 'Specialist'
}

export function mapGatewayStatus(
  status: string | undefined,
  fallback: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled',
): 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' {
  const s = (status ?? '').toLowerCase()
  if (s === 'queued' || s === 'pending' || s === 'starting') return 'queued'
  if (s === 'running') return 'running'
  if (s === 'failed' || s === 'error') return 'failed'
  if (s === 'interrupted' || s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'completed' || s === 'succeeded' || s === 'success') return 'completed'
  return fallback
}

/** Top-level `delegate_task` completes immediately with a background handle. */
export function delegateToolFailed(result: unknown): string | null {
  if (result == null) return null
  if (typeof result === 'string') {
    const t = result.trim()
    if (/^error\b/i.test(t) || /unknown subagent_type/i.test(t)) return t.slice(0, 400)
    return null
  }
  if (typeof result === 'object') {
    const r = result as { is_error?: boolean; error?: unknown; status?: string }
    if (r.is_error === true) {
      return typeof r.error === 'string' ? r.error : 'delegate_task failed'
    }
    if (typeof r.error === 'string' && r.error.trim()) return r.error.trim()
  }
  return null
}

export function readSubagentPayload(raw: unknown): SubagentGatewayPayload {
  const record = asRecord(raw)
  const taskIndex =
    typeof record.task_index === 'number'
      ? record.task_index
      : typeof record.taskIndex === 'number'
        ? record.taskIndex
        : undefined
  const taskCount =
    typeof record.task_count === 'number'
      ? record.task_count
      : typeof record.taskCount === 'number'
        ? record.taskCount
        : undefined
  return {
    goal: firstString(record.goal) || undefined,
    subagent_id: firstString(record.subagent_id, record.subagentId) || undefined,
    child_session_id: firstString(record.child_session_id, record.childSessionId) || undefined,
    parent_id: firstString(record.parent_id, record.parentId) || undefined,
    task_index: taskIndex,
    task_count: taskCount,
    status: firstString(record.status) || undefined,
    summary: firstString(record.summary) || undefined,
    text: firstString(record.text, record.preview, record.tool_preview) || undefined,
    tool_name: firstString(record.tool_name, record.toolName) || undefined,
    tool_preview: firstString(record.tool_preview, record.toolPreview) || undefined,
    duration_seconds:
      typeof record.duration_seconds === 'number'
        ? record.duration_seconds
        : typeof record.duration_s === 'number'
          ? record.duration_s
          : undefined,
  }
}
