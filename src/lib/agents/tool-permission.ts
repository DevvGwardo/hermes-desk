import type { ApprovalOption, ApprovalRisk, PendingToolPermission, ToolPermissionChoice } from './types'

let pending: readonly PendingToolPermission[] = []
let lastConversation: string | undefined
const listeners = new Set<() => void>()

export function getPendingToolPermission(conversationId = lastConversation): PendingToolPermission | null {
  return pending.find(ask => ask.conversationId === conversationId) ?? (conversationId === undefined ? pending[0] : undefined) ?? null
}

export function getPendingToolPermissions(): readonly PendingToolPermission[] { return pending }

export function setPendingToolPermission(next: PendingToolPermission | null, opts?: { queue?: boolean }): void {
  if (!next) { pending = []; lastConversation = undefined }
  else {
    // Native requests each need an answer; legacy notification cards replace their session's card.
    const index = pending.findIndex(ask => opts?.queue ? ask.id === next.id
      : ask.conversationId === next.conversationId && ask.sessionId === next.sessionId)
    if (index < 0 || pending[index].id !== next.id) lastConversation = next.conversationId
    pending = index < 0 ? [...pending, next] : pending.map((ask, i) => i === index ? next : ask)
  }
  for (const l of [...listeners]) l()
}

export function clearPendingToolPermission(id: string): void {
  const next = pending.filter(ask => ask.id !== id)
  if (next.length === pending.length) return
  pending = next
  if (!pending.some(ask => ask.conversationId === lastConversation)) lastConversation = pending.at(-1)?.conversationId
  for (const listener of [...listeners]) listener()
}

export function subscribePendingToolPermission(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

const CHOICES: ToolPermissionChoice[] = ['once', 'session', 'always', 'deny']

export function normalizePermissionChoices(raw: unknown): ToolPermissionChoice[] {
  if (!Array.isArray(raw)) return [...CHOICES]
  const allowed = new Set<string>(CHOICES)
  const out = raw.filter((c): c is ToolPermissionChoice => typeof c === 'string' && allowed.has(c))
  return out.length > 0 ? out : ['once', 'deny']
}

/**
 * Grok 0.24 widget parity (A1): normalize an `approval.request` `options` array
 * into choice chips. Accepts strings or `{id?, label|value, hint?}` rows.
 * Returns undefined for absent/empty/garbage payloads so transports omit the
 * field entirely and the dock keeps the legacy Allow/Deny buttons.
 */
export function parseApprovalOptions(raw: unknown): ApprovalOption[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ApprovalOption[] = []
  for (const item of raw.slice(0, 9)) {
    if (typeof item === 'string') {
      const label = item.trim()
      if (label) out.push({ id: label, label })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const o = item as { id?: unknown; label?: unknown; value?: unknown; hint?: unknown }
    const label = typeof o.label === 'string' ? o.label.trim() : typeof o.value === 'string' ? o.value.trim() : ''
    if (!label) continue
    const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : label
    const hint = typeof o.hint === 'string' && o.hint.trim() ? o.hint.trim() : undefined
    out.push(hint ? { id, label, hint } : { id, label })
  }
  return out.length > 0 ? out : undefined
}

export type ApprovalMode = 'ask' | 'smart' | 'yolo'

const APPROVAL_KEY = 'maia:approvalMode'
const APPROVAL_MODES: ApprovalMode[] = ['ask', 'smart', 'yolo']

export function parseApprovalMode(raw: unknown): ApprovalMode {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === 'yolo' || s === 'off' || s === 'true' || s === '1') return 'yolo'
  if (s === 'smart') return 'smart'
  return 'ask'
}

export function getApprovalMode(): ApprovalMode {
  if (typeof window === 'undefined') return 'ask'
  try {
    return parseApprovalMode(window.localStorage.getItem(APPROVAL_KEY))
  } catch {
    return 'ask'
  }
}

export function setApprovalMode(mode: ApprovalMode): void {
  if (typeof window === 'undefined') return
  if (!APPROVAL_MODES.includes(mode)) return
  try {
    window.localStorage.setItem(APPROVAL_KEY, mode)
  } catch {
    /* quota */
  }
}

/** YOLO skips the in-chat Allow once / Always / Deny dock. */
export function shouldPromptToolPermission(mode: ApprovalMode = getApprovalMode()): boolean {
  return mode !== 'yolo'
}

/**
 * Money-movement signals in an approval's command / description / message.
 * Substring terms are chosen to avoid false positives on ordinary dev
 * commands; bare `buy` / `pay` / `charge` go through a word-boundary regex
 * so `payload` or `rechargeable` don't trip it.
 */
const HIGH_STAKES_SUBSTRINGS = [
  'purchase',
  'checkout',
  'subscription',
  'subscribe',
  'payment',
  'invoice',
  'billing',
  'stripe',
  'paypal',
  'venmo',
  'zelle',
  'cashapp',
  'cash app',
  'usdc',
  'solana',
  'bitcoin',
  'crypto',
  'withdraw',
  'transfer',
  'refund',
  'deposit',
]

const HIGH_STAKES_WORDS_RE = /\b(buy|buys|buying|pay|pays|paying|charge|charges|charging)\b/i

/**
 * Classify an approval request as `high-stakes` when it looks like money
 * movement (purchase, payment, transfer, …). Conservative by design: a
 * false positive only costs the user one extra tap per occurrence, while a
 * false negative would hand out a standing grant for spending.
 */
export function isHighStakesApproval(
  command?: string,
  description?: string,
  message?: string,
): boolean {
  const text = [command, description, message].filter(Boolean).join('\n').toLowerCase()
  if (!text) return false
  if (HIGH_STAKES_WORDS_RE.test(text)) return true
  return HIGH_STAKES_SUBSTRINGS.some((s) => text.includes(s))
}

/**
 * Filter normalized choices by risk class. High-stakes approvals never offer
 * standing grants: `always` and `session` are stripped so every occurrence
 * needs a fresh decision. Falls back to `['once', 'deny']` when nothing
 * one-time remains.
 */
export function choicesForApprovalRisk(
  choices: unknown,
  risk: ApprovalRisk,
): ToolPermissionChoice[] {
  const base = normalizePermissionChoices(choices)
  if (risk !== 'high-stakes') return base
  const once = base.filter((c) => c === 'once' || c === 'deny')
  return once.length > 0 ? once : ['once', 'deny']
}
