/**
 * Action audit timeline (A5) — Grok `sand_action_audit_logs` parity.
 *
 * Append-only local log of tool / subagent / permission activity. Rows live
 * in localStorage (same envelope style as persist.ts) so history survives
 * restart, capped at AUDIT_CAP entries per instance (the desktop client talks
 * to one active instance; the cap is enforced on the whole list, dropping the
 * oldest rows first). Read-only by design — no editing, no server sync.
 */

export type AuditVerb = 'tool' | 'subagent' | 'permission'
export type AuditOutcome = 'running' | 'completed' | 'failed' | 'pending'
export type AuditOrigin = 'mac' | 'vm'

export interface AuditRow {
  ts: string
  conversationId: string
  verb: AuditVerb
  /** Tool name, subagent label, or command/description of an approval ask. */
  target: string
  outcome: AuditOutcome
  origin: AuditOrigin
  /** Short result summary when the transport carried one. */
  detail?: string
  /**
   * Stable identity for upserts (a tool call that goes running → completed
   * updates its row instead of appending a second one).
   */
  key?: string
}

/** Ring-buffer size per instance (plan: ~500). */
export const AUDIT_CAP = 500

const STORAGE_KEY = 'maia:audit-log:v1'

interface PersistEnvelope {
  slice: 'maia.audit'
  schemaVersion: 1
  scope: 'client-persisted'
  value: AuditRow[]
}

interface AuditStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function resolveStorage(injected?: AuditStorage): AuditStorage | null {
  if (injected) return injected
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

/** Enforce the ring buffer — keep the newest AUDIT_CAP rows. */
export function capAuditRows(rows: AuditRow[], cap = AUDIT_CAP): AuditRow[] {
  if (rows.length <= cap) return rows
  return rows.slice(rows.length - cap)
}

export function readAuditRows(storage?: AuditStorage): AuditRow[] {
  const s = resolveStorage(storage)
  if (!s) return []
  try {
    const raw = s.getItem(STORAGE_KEY)
    if (!raw) return []
    const env = JSON.parse(raw) as PersistEnvelope
    if (env?.slice !== 'maia.audit' || !Array.isArray(env.value)) return []
    return env.value.filter(
      (r): r is AuditRow =>
        !!r && typeof r === 'object' && typeof r.ts === 'string' && typeof r.verb === 'string',
    )
  } catch {
    return []
  }
}

/** Append (or upsert by key), cap, and persist. Returns the stored list. */
export function appendAuditRows(rows: AuditRow[], storage?: AuditStorage): AuditRow[] {
  const s = resolveStorage(storage)
  if (!s || rows.length === 0) return readAuditRows(s ?? undefined)
  const current = readAuditRows(s)
  for (const row of rows) {
    if (row.key) {
      const idx = current.findIndex((r) => r.key === row.key)
      if (idx >= 0) {
        current[idx] = row
        continue
      }
    }
    current.push(row)
  }
  const next = capAuditRows(current)
  try {
    const env: PersistEnvelope = {
      slice: 'maia.audit',
      schemaVersion: 1,
      scope: 'client-persisted',
      value: next,
    }
    s.setItem(STORAGE_KEY, JSON.stringify(env))
  } catch {
    /* quota / private mode — best effort */
  }
  return next
}

export function clearAuditLog(storage?: AuditStorage): void {
  const s = resolveStorage(storage)
  if (!s) return
  try {
    s.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Human-friendly presentation for audit rows (Agent info → Activity).
 *
 * Raw tool labels are often full shell pipelines (`cd /opt/data/... && git
 * ... | head -c 8`, `TOKEN=*** ... curl .../pulls/108/merge ... python3 -c
 * 'import json ...'`). Rendering those verbatim turns the timeline into
 * unreadable debug output (2026-09-12 UX report). These helpers collapse
 * anything shell-shaped into one plain-English line; the raw command stays
 * available behind a collapsed "Details" disclosure.
 */

function looksLikeShellCommand(target: string): boolean {
  if (target.length > 60) return true
  return /(\bcd\s|\s&&\s|\|\s*head|\|\s*cut|\/opt\/data\/|TOKEN=|curl\s|python3?\s+-c|git\s+remote|ghc?red)/i.test(target)
}

/** Collapse a raw approval ask into one plain-English summary. Shell-shaped
 *  asks never render verbatim as the row title — the raw text stays behind
 *  the "Details" disclosure. Short human asks pass through untouched. */
function summarizePermissionTarget(target: string): string {
  const oneLine = target.replace(/\s+/g, ' ').trim()
  if (!looksLikeShellCommand(oneLine)) {
    return oneLine.length > 80 ? `${oneLine.slice(0, 79).trimEnd()}…` : oneLine
  }
  const lower = oneLine.toLowerCase()
  if (lower.includes('/pulls/') && lower.includes('/merge')) return 'Finishing a code update'
  if (lower.includes('issue_comment') || lower.includes('/issues/')) return 'Reading updates'
  if (lower.includes('git remote') || lower.includes('get-url origin')) return 'Checking where your work is saved'
  if (lower.includes('git ')) return 'Working on your code'
  if (lower.includes('curl ') || lower.includes('token=')) return 'Checking for updates'
  if (lower.includes('python3') && lower.includes('import json')) return 'Tidying up results'
  if (lower.includes('/opt/data/workspace')) return 'Working on your files'
  return 'Needs your OK to continue'
}

/** Collapse a raw shell pipeline into one plain-English summary. */
export function summarizeAuditTarget(verb: AuditVerb, target: string): string {
  const t = target.trim() || (verb === 'subagent' ? 'Worker' : verb === 'permission' ? 'Approval request' : 'Tool call')
  if (verb === 'subagent') return t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t
  if (verb === 'permission') return summarizePermissionTarget(t)
  // verb === 'tool'
  if (!looksLikeShellCommand(t)) return t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t
  const lower = t.toLowerCase()
  if (lower.includes('/pulls/') && lower.includes('/merge')) return 'Merged a pull request'
  if (lower.includes('issue_comment') || (lower.includes('/issues/') && lower.includes('curl'))) {
    return 'Read issue comments'
  }
  if (lower.includes('git remote') || lower.includes('get-url origin')) return 'Checked the git remote'
  if (lower.includes('git ')) return 'Ran a git command'
  if (lower.includes('curl ') && lower.includes('api.github.com')) return 'Called the GitHub API'
  if (lower.includes('curl ')) return 'Called a web API'
  if (lower.includes('python3') && lower.includes('import json')) return 'Parsed command output'
  return 'Ran a shell command'
}

/** Plain-English status for the timeline subtitle. */
export function auditStatusLabel(verb: AuditVerb, outcome: AuditOutcome): string {
  if (verb === 'permission' && outcome === 'pending') return 'Waiting for you'
  switch (outcome) {
    case 'running':
      return 'Running…'
    case 'pending':
      return 'Waiting…'
    case 'failed':
      return 'Failed'
    default:
      return 'Done'
  }
}

/** Minimal structural view of the transport events we audit. */
export interface AuditableTransportEvent {
  type: string
  conversationId?: string
  message?: {
    id?: string
    threadId?: string
    toolEvents?: { tool: string; label?: string; status: string; summary?: string }[]
  }
  run?: {
    id?: string
    kind?: string
    label?: string
    title?: string
    status?: string
    startedAt?: string
    finishedAt?: string
  }
  ask?: { command?: string; description?: string; options?: unknown[] } | null
}

/**
 * Map one transport event to zero or more audit rows. Permission-clear
 * events (`ask: null`) produce nothing — the arrival row already exists and
 * resolution intent isn't observable on the wire.
 */
export function auditRowsFromTransportEvent(
  ev: AuditableTransportEvent,
  origin: AuditOrigin,
  now = new Date().toISOString(),
): AuditRow[] {
  if (ev.type === 'message' && ev.message?.toolEvents?.length) {
    return []
  }
  if (ev.type === 'subagent' && ev.run) {
    const status = ev.run.status ?? 'running'
    return [
      {
        ts: now,
        conversationId: '',
        verb: 'subagent',
        target:
          ev.run.label?.trim() ||
          ev.run.title?.trim() ||
          ev.run.kind ||
          'subagent',
        outcome:
          status === 'completed'
            ? 'completed'
            : status === 'failed' || status === 'cancelled'
              ? 'failed'
              : 'running',
        origin,
        key: `run:${ev.run.id ?? now}`,
      },
    ]
  }
  if (ev.type === 'permission' && ev.ask) {
    return [
      {
        ts: now,
        conversationId: ev.conversationId ?? '',
        verb: 'permission',
        target:
          ev.ask.command?.trim() ||
          ev.ask.description?.trim() ||
          (ev.ask.options?.length ? 'question from agent' : 'approval request'),
        outcome: 'pending',
        origin,
      },
    ]
  }
  return []
}
