/** Display helpers for Settings usage / storage. */

/**
 * User-facing name for the bundled Maia model. The platform supplies and
 * manages one metered model behind the scenes; which upstream model that is
 * is an internal detail — never show it to users.
 */
export const MAIA_MODEL_LABEL = 'Maia'

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

/** A usage cap as a share, never dollars: "42% used". Caps are metered in
 *  USD server-side, but the plan is a flat price — users see tokens and %. */
export function capPercentLabel(used: number, limit: number): string {
  if (!(limit > 0) || !Number.isFinite(used)) return '—'
  const pct = Math.max(0, (used / limit) * 100)
  return `${pct > 0 && pct < 1 ? '<1' : Math.min(999, Math.round(pct))}% used`
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00'
  // Cents from $1 up ("$16.78", not "$16.7779"); sub-dollar amounts keep up
  // to 4 decimals because a day of cheap calls can be a fraction of a cent.
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n >= 1 ? 2 : 4 })}`
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export interface UsageTotals {
  sessions: number
  /** Every model call (replies, titles, vision, compression), not chats. */
  apiCalls: number
  estimatedCost: number
  /** Input tokens INCLUDING the cached slice (cachedTokens ⊆ inputTokens). */
  inputTokens: number
  outputTokens: number
  cachedTokens: number
}

export interface MaiavmUsageRow {
  day?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  requests?: number
  /** Billed µUSD (marked up, cache-discounted) — what the ledger debits. */
  costMicros?: string
  /** Deprecated server-side: raw provider list price, no markup. */
  costUsd?: number
}

export interface MaiavmUsagePayload {
  account?: {
    balanceMicros?: string
    grantedMicros?: string
    /** Lifetime GROSS debits — refunds never decrement it. */
    spentMicros?: string
    /** Newer servers only. */
    refundedMicros?: string
    /** Newer servers only: spentMicros − refundedMicros. */
    netSpentMicros?: string
  } | null
  usage?: MaiavmUsageRow[]
  /** Newer servers only: LLM_PROMO_UNLIMITED is on (calls are free). */
  promo?: boolean
  /** Newer servers only: ISO start of the usage period (UTC month). */
  periodStart?: string
  totals?: {
    /** Deprecated server-side: list price without markup. Don't display. */
    costUsd?: number
    costMicros?: string
    /** Newer servers only — the fields below are exact period aggregates. */
    billedMicros?: string
    promoMicros?: string
    requests?: number
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
  }
  /** Newer servers only: plan status + allowance (parse with plan-display.ts parseUsagePlan). */
  plan?: unknown
  budget?: Array<{
    window: string
    label: string
    usedUsd: number
    limitUsd: number
    resetAt: number
  }>
}

export function microsToUsd(raw: string | number | undefined): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw / 1_000_000
  if (typeof raw !== 'string' || !raw.trim()) return 0
  const n = Number(raw)
  return Number.isFinite(n) ? n / 1_000_000 : 0
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Roll maiavm.com GET /api/llm/usage (day×model rows + cost totals). Newer
 * servers send exact period totals (the row scan is capped); older ones
 * don't, so the rows are summed as before.
 */
export function rollupMaiavmUsage(data: MaiavmUsagePayload): UsageTotals {
  const rows = Array.isArray(data.usage) ? data.usage : []
  let inputTokens = 0
  let outputTokens = 0
  let cachedTokens = 0
  let apiCalls = 0
  let estimatedCost = Number(data.totals?.costUsd ?? 0) || 0
  for (const row of rows) {
    inputTokens += Number(row.inputTokens ?? 0) || 0
    outputTokens += Number(row.outputTokens ?? 0) || 0
    cachedTokens += Number(row.cachedTokens ?? 0) || 0
    apiCalls += Number(row.requests ?? 0) || 0
    if (!data.totals?.costUsd) estimatedCost += Number(row.costUsd ?? 0) || 0
  }
  if (!estimatedCost) estimatedCost = microsToUsd(data.totals?.costMicros)
  const t = data.totals ?? {}
  return {
    sessions: 0,
    apiCalls: finiteNumber(t.requests) ?? apiCalls,
    estimatedCost,
    inputTokens: finiteNumber(t.inputTokens) ?? inputTokens,
    outputTokens: finiteNumber(t.outputTokens) ?? outputTokens,
    cachedTokens: finiteNumber(t.cachedTokens) ?? cachedTokens,
  }
}

/** Share of input tokens served from the prompt cache, 0–100 (rounded). */
export function cachedPct(t: Pick<UsageTotals, 'inputTokens' | 'cachedTokens'>): number {
  if (!(t.inputTokens > 0) || !(t.cachedTokens > 0)) return 0
  return Math.min(100, Math.round((t.cachedTokens / t.inputTokens) * 100))
}

export interface UsageMoney {
  /** Spendable credit; null when the account has never been funded. */
  balance: number | null
  /** Marked-up cost of chargeable calls this month; null = server too old. */
  billedThisMonth: number | null
  /** Calls are free right now (LLM promo). False on older servers. */
  promo: boolean
  /** Lifetime spend net of refunds; null = server too old (never show gross). */
  netSpent: number | null
}

/**
 * The money lines for the Usage card. Deliberately never falls back to
 * `spentMicros` (lifetime gross — ignores refunds) or `totals.costUsd`
 * (list price, no markup): an old server just shows fewer lines.
 */
export function usageMoney(data: MaiavmUsagePayload | null | undefined): UsageMoney | null {
  if (!data) return null
  const account = data.account ?? null
  const billedRaw = data.totals?.billedMicros
  return {
    balance: account && typeof account.balanceMicros === 'string' ? microsToUsd(account.balanceMicros) : null,
    billedThisMonth: typeof billedRaw === 'string' ? microsToUsd(billedRaw) : null,
    promo: data.promo === true,
    netSpent: account && typeof account.netSpentMicros === 'string' ? microsToUsd(account.netSpentMicros) : null,
  }
}

const DAY_MS = 24 * 3600_000
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

function rowUsd(row: MaiavmUsageRow): number {
  // Billed µUSD when the server sends it; the list-price costUsd otherwise.
  if (typeof row.costMicros === 'string' && row.costMicros.trim()) return microsToUsd(row.costMicros)
  return Number(row.costUsd) || 0
}

/**
 * Daily spend for the chart: the last 14 UTC days ending today, oldest first,
 * with zero days filled in. The server only returns the current month, so
 * the window never reaches before `periodStart` (else the month start) —
 * showing last month's days as $0 would be a lie. Rows outside the window
 * are dropped.
 */
export function dailyCosts(
  rows: MaiavmUsageRow[] | undefined,
  opts: { now?: Date; periodStart?: string } = {},
): { day: string; usd: number }[] {
  return dailyUsage(rows, opts).map(({ day, usd }) => ({ day, usd }))
}

/**
 * dailyCosts plus model calls per day: same window (the last 14 UTC days
 * ending today, clamped to the start of the period), zero days filled in.
 */
export function dailyUsage(
  rows: MaiavmUsageRow[] | undefined,
  opts: { now?: Date; periodStart?: string } = {},
): { day: string; usd: number; calls: number; tokens: number }[] {
  const map = new Map<string, { usd: number; calls: number; tokens: number }>()
  for (const row of rows ?? []) {
    if (typeof row.day !== 'string' || !ISO_DAY.test(row.day)) continue
    const cur = map.get(row.day) ?? { usd: 0, calls: 0, tokens: 0 }
    cur.usd += rowUsd(row)
    cur.calls += Number(row.requests) || 0
    // Input already includes the cached slice — never add cachedTokens again.
    cur.tokens += (Number(row.inputTokens) || 0) + (Number(row.outputTokens) || 0)
    map.set(row.day, cur)
  }
  const now = opts.now ?? new Date()
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const parsedStart = opts.periodStart ? Date.parse(opts.periodStart) : NaN
  const monthStart = Number.isFinite(parsedStart)
    ? parsedStart
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const first = Math.max(today - 13 * DAY_MS, monthStart)
  const out: { day: string; usd: number; calls: number; tokens: number }[] = []
  for (let t = first; t <= today; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10)
    const v = map.get(day)
    out.push({ day, usd: v?.usd ?? 0, calls: v?.calls ?? 0, tokens: v?.tokens ?? 0 })
  }
  return out
}

/**
 * Which bars get a date under them. Fourteen "Sep 15" labels don't fit a
 * phone, so only the first bar, every 7th back from today and today itself
 * (as "Today") are labelled; tapping any bar shows its exact date.
 */
export function chartDayLabel(index: number, count: number, day: string): string {
  if (index === count - 1) return 'Today'
  if (index === 0 || (count - 1 - index) % 7 === 0) return dayLabel(day)
  return ''
}

export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Collapse billed usage rows into a single branded row. The platform
 * supplies one metered model; the per-model breakdown would leak the
 * internal model id, so everything sums under the Maia label.
 */
export function modelsFromMaiavmUsage(
  data: MaiavmUsagePayload,
): { name: string; tokens: number }[] {
  let tokens = 0
  for (const row of data.usage ?? []) {
    tokens += (Number(row.inputTokens ?? 0) || 0) + (Number(row.outputTokens ?? 0) || 0)
  }
  return tokens > 0 ? [{ name: MAIA_MODEL_LABEL, tokens }] : []
}

export function rollupUsage(data: {
  daily?: unknown[]
  totals?: Record<string, unknown>
}): UsageTotals {
  const totals = data.totals ?? {}
  if (Object.keys(totals).length > 0) {
    return {
      sessions: Number(totals.sessions ?? 0) || 0,
      apiCalls: Number(totals.api_calls ?? totals.apiCalls ?? 0) || 0,
      estimatedCost: Number(totals.estimated_cost ?? totals.estimatedCost ?? 0) || 0,
      inputTokens: Number(totals.input_tokens ?? totals.inputTokens ?? 0) || 0,
      outputTokens: Number(totals.output_tokens ?? totals.outputTokens ?? 0) || 0,
      // Local analytics' input/cache split isn't guaranteed to match the
      // platform's (cached ⊆ input), so no cache share is claimed for it.
      cachedTokens: 0,
    }
  }
  const t: UsageTotals = {
    sessions: 0,
    apiCalls: 0,
    estimatedCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
  }
  for (const raw of data.daily ?? []) {
    const d = raw as Record<string, unknown>
    t.sessions += Number(d.sessions ?? 0) || 0
    t.apiCalls += Number(d.api_calls ?? d.apiCalls ?? 0) || 0
    t.estimatedCost += Number(d.estimated_cost ?? d.estimatedCost ?? 0) || 0
    t.inputTokens += Number(d.input_tokens ?? d.inputTokens ?? 0) || 0
    t.outputTokens += Number(d.output_tokens ?? d.outputTokens ?? 0) || 0
  }
  return t
}

/** "resets in 8h" / "resets in 3 days" for a cap window; null when unknown or past. */
export function resetsInLabel(resetAt: number | undefined, now = Date.now()): string | null {
  if (typeof resetAt !== 'number' || !Number.isFinite(resetAt)) return null
  // Accept seconds or milliseconds.
  const ms = (resetAt < 1e11 ? resetAt * 1000 : resetAt) - now
  if (ms <= 0) return null
  const hours = ms / 3_600_000
  if (hours < 1) return `resets in ${Math.max(1, Math.round(ms / 60_000))} min`
  if (hours < 36) return `resets in ${Math.round(hours)}h`
  return `resets in ${Math.round(hours / 24)} days`
}
