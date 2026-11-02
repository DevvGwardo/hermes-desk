/**
 * Settings → Plan & usage: words for the `plan` block of GET /api/llm/usage
 * (hermes-deploy src/lib/nub/usage-plan.ts). The status lines mirror the
 * Mini App's (hermes-deploy src/lib/nub/plan-status.ts planStatusLine), so
 * the app and Telegram describe a plan the same way: a prepaid month or a
 * trial never "renews".
 */
import { formatTokenCount } from './usage-format'

export interface PlanStatus {
  state: 'active' | 'renewing' | 'ended' | 'none'
  billing: 'card' | 'prepaid' | 'trial' | null
  endsAt: string | null
  cancelling: boolean
}

export interface UsagePlan {
  status: PlanStatus
  allowance: {
    monthlyTokens: string
    usedTokens: string
    periodStart: string
    periodEnd: string
  } | null
  /** Promo on: the allowance isn't enforced right now. */
  unlimited: boolean
}

const DAY_MS = 86_400_000

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function daysLeft(iso: string, now: number): number {
  const ms = Date.parse(iso) - now
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / DAY_MS)) : 0
}

function daysLeftText(days: number): string {
  return days <= 1 ? 'last day' : `${days} days left`
}

/** The card's title: "Nub Pro", "Free trial", "Plan ended" or "No plan". */
export function planTitle(status: PlanStatus): string {
  switch (status.state) {
    case 'active':
      return status.billing === 'trial' ? 'Free trial' : 'Nub Pro'
    case 'renewing':
      return 'Nub Pro'
    case 'ended':
      return 'Plan ended'
    default:
      return 'No plan'
  }
}

/** When it renews or ends, in plain words; null when there's nothing to say. */
export function planLine(status: PlanStatus, now = Date.now()): string | null {
  if (!status.endsAt) return null
  const date = shortDate(status.endsAt)
  switch (status.state) {
    case 'active':
      if (status.billing === 'trial') return `Free trial · ${daysLeftText(daysLeft(status.endsAt, now))}`
      if (status.billing === 'prepaid') return `Paid through ${date} · ${daysLeftText(daysLeft(status.endsAt, now))}`
      return status.cancelling ? `Ends ${date}` : `Renews ${date}`
    case 'renewing':
      return 'Renewing your card now'
    case 'ended':
      return `Ended ${date}`
    default:
      return null
  }
}

/** "3.2M of 40M tokens" plus the raw numbers for a bar; null without an allowance. */
export function allowanceView(plan: UsagePlan): { used: number; limit: number; label: string } | null {
  if (!plan.allowance) return null
  const used = Number(plan.allowance.usedTokens)
  const limit = Number(plan.allowance.monthlyTokens)
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null
  // "40M", not "40.0M": a round allowance reads as a round number.
  const short = (n: number) => formatTokenCount(n).replace(/\.0(?=[MK]$)/, '')
  return { used, limit, label: `${short(used)} of ${short(limit)} tokens` }
}

/** Narrow an unknown JSON value to a UsagePlan (older servers send none). */
export function parseUsagePlan(raw: unknown): UsagePlan | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<UsagePlan>
  const s = r.status as Partial<PlanStatus> | undefined
  if (!s || typeof s.state !== 'string') return null
  const a = r.allowance
  return {
    status: {
      state: (['active', 'renewing', 'ended', 'none'] as const).includes(s.state as PlanStatus['state'])
        ? (s.state as PlanStatus['state'])
        : 'none',
      billing: s.billing === 'card' || s.billing === 'prepaid' || s.billing === 'trial' ? s.billing : null,
      endsAt: typeof s.endsAt === 'string' ? s.endsAt : null,
      cancelling: s.cancelling === true,
    },
    allowance:
      a && typeof a.monthlyTokens === 'string' && typeof a.usedTokens === 'string'
        ? {
            monthlyTokens: a.monthlyTokens,
            usedTokens: a.usedTokens,
            periodStart: String(a.periodStart ?? ''),
            periodEnd: String(a.periodEnd ?? ''),
          }
        : null,
    unlimited: r.unlimited === true,
  }
}
