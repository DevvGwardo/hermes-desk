/**
 * Safety settings on the agent (Settings → Safety: approvals, privacy,
 * websites, files, chat-history retention). Every write goes
 * through `patchAgentConfig` (key-allowlisted PUT /api/config), which hermes
 * applies live — approvals.mode changes are broadcast to running sessions, so
 * no VM restart is needed.
 */

import { getAgentConfig, patchAgentConfig, readDotted, type AgentConfig } from './agent-config'
import type { ServeSendResult } from './hermes-rest'
import { parseApprovalMode, type ApprovalMode } from './agents/tool-permission'

// ---------------------------------------------------------------------------
// Approval mode
// ---------------------------------------------------------------------------

/** App mode → hermes `approvals.mode` (mirrors electron nub-link hermesApprovalMode). */
export function hermesApprovalMode(mode: ApprovalMode): 'manual' | 'smart' | 'off' {
  if (mode === 'yolo') return 'off'
  if (mode === 'smart') return 'smart'
  return 'manual'
}

/**
 * Apply the approval mode live via PUT /api/config (no restart). Returns the
 * raw send result so the caller can fall back to the maiavm restart path when
 * the dashboard is unreachable or refuses.
 */
export function setApprovalModeLive(mode: ApprovalMode): Promise<ServeSendResult<unknown>> {
  return patchAgentConfig({ 'approvals.mode': hermesApprovalMode(mode) })
}

// ---------------------------------------------------------------------------
// Privacy & safety
// ---------------------------------------------------------------------------

export type CronMode = 'deny' | 'approve'

export interface SafetySettings {
  redactPii: boolean
  blocklistEnabled: boolean
  blockedDomains: string[]
  alwaysAllowed: string[]
  neverAllow: string[]
  cronMode: CronMode
  smartPolicy: string
  undoFileChanges: boolean
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

/** Read the safety section out of a GET /api/config document (hermes defaults on gaps). */
export function readSafetySettings(config: AgentConfig): SafetySettings {
  const cron = readDotted(config, 'approvals.cron_mode')
  const policy = readDotted(config, 'approvals.smart_policy')
  return {
    redactPii: bool(readDotted(config, 'privacy.redact_pii'), false),
    blocklistEnabled: bool(readDotted(config, 'security.website_blocklist.enabled'), false),
    blockedDomains: strList(readDotted(config, 'security.website_blocklist.domains')),
    alwaysAllowed: strList(readDotted(config, 'command_allowlist')),
    neverAllow: strList(readDotted(config, 'approvals.deny')),
    cronMode: cron === 'approve' ? 'approve' : 'deny',
    smartPolicy: typeof policy === 'string' ? policy : '',
    undoFileChanges: bool(readDotted(config, 'checkpoints.enabled'), false),
  }
}

export type SafetyLoad =
  /** approvalMode: the agent's approvals.mode, read-only here (Approvals owns writes). */
  | { kind: 'ok'; settings: SafetySettings; approvalMode: ApprovalMode }
  | { kind: 'unavailable'; message: string }

export async function loadSafetySettings(): Promise<SafetyLoad> {
  const res = await getAgentConfig()
  if (res.kind !== 'ok') return res
  return {
    kind: 'ok',
    settings: readSafetySettings(res.config),
    approvalMode: parseApprovalMode(readDotted(res.config, 'approvals.mode')),
  }
}

/**
 * `https://www.Example.com/path` → `www.example.com`. Wildcards (`*.ads.com`)
 * are kept; returns null for anything that is not a plausible host name.
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.split(/[/?#]/)[0]
  s = s.replace(/:\d+$/, '').replace(/\.$/, '')
  if (s.includes('@') || s.length > 253) return null
  if (!/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(s)) return null
  return s
}

/** Add `item` to `list` (trimmed, de-duplicated, order kept). */
export function addUnique(list: readonly string[], item: string): string[] {
  const v = item.trim()
  if (!v || list.includes(v)) return [...list]
  return [...list, v]
}

export function removeItem(list: readonly string[], item: string): string[] {
  return list.filter((x) => x !== item)
}

export const SAFETY_PATHS = {
  redactPii: 'privacy.redact_pii',
  blocklistEnabled: 'security.website_blocklist.enabled',
  blockedDomains: 'security.website_blocklist.domains',
  alwaysAllowed: 'command_allowlist',
  neverAllow: 'approvals.deny',
  cronMode: 'approvals.cron_mode',
  smartPolicy: 'approvals.smart_policy',
  undoFileChanges: 'checkpoints.enabled',
} as const satisfies Record<keyof SafetySettings, string>

/** Write one or more safety fields. */
export function saveSafety(patch: Partial<SafetySettings>): Promise<ServeSendResult<unknown>> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    out[SAFETY_PATHS[k as keyof SafetySettings]] = v
  }
  return patchAgentConfig(out)
}

// ---------------------------------------------------------------------------
// Chat history retention (sessions.retention_days + sessions.auto_prune)
// ---------------------------------------------------------------------------

export type RetentionChoice = 30 | 90 | 365 | 'forever'

export const RETENTION_CHOICES: ReadonlyArray<{ id: RetentionChoice; label: string }> = [
  { id: 30, label: '30 days' },
  { id: 90, label: '90 days' },
  { id: 365, label: '1 year' },
  { id: 'forever', label: 'Forever' },
]

/**
 * hermes prunes ended sessions older than `retention_days` only while
 * `auto_prune` is true (default true / 90). "Forever" = auto_prune off. A
 * custom day count set elsewhere is reported as-is (number).
 */
export function readRetention(config: AgentConfig): RetentionChoice | number {
  const auto = readDotted(config, 'sessions.auto_prune')
  if (auto === false) return 'forever'
  const days = Number(readDotted(config, 'sessions.retention_days'))
  if (!Number.isFinite(days) || days <= 0) return 90
  return days as RetentionChoice | number
}

export function retentionPatch(choice: RetentionChoice): Record<string, unknown> {
  if (choice === 'forever') return { 'sessions.auto_prune': false }
  return { 'sessions.auto_prune': true, 'sessions.retention_days': choice }
}

export function saveRetention(choice: RetentionChoice): Promise<ServeSendResult<unknown>> {
  return patchAgentConfig(retentionPatch(choice))
}
