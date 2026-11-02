import { describe, expect, it } from 'vitest'
import {
  capPercentLabel,
  dailyCosts,
  dailyUsage,
  chartDayLabel,
  dayLabel,
  formatBytes,
  formatTokenCount,
  formatUsd,
  cachedPct,
  microsToUsd,
  modelsFromMaiavmUsage,
  usageMoney,
  rollupMaiavmUsage,
  rollupUsage,
} from '../usage-format'

describe('usage-format', () => {
  it('formats tokens, money, and bytes', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(1500)).toBe('1.5K')
    expect(formatUsd(1.23456)).toBe('$1.23')
    expect(formatUsd(0.012345)).toBe('$0.0123')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  it('prefers totals over daily rollup', () => {
    expect(
      rollupUsage({
        totals: { sessions: 2, input_tokens: 100, output_tokens: 40 },
        daily: [{ sessions: 9, input_tokens: 1 }],
      }),
    ).toEqual({
      sessions: 2,
      apiCalls: 0,
      estimatedCost: 0,
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 0,
    })
  })

  it('sums daily rows when totals are missing', () => {
    const t = rollupUsage({
      daily: [
        { sessions: 1, api_calls: 2, input_tokens: 10, output_tokens: 3 },
        { sessions: 1, api_calls: 1, input_tokens: 5, output_tokens: 1 },
      ],
    })
    expect(t).toEqual({
      sessions: 2,
      apiCalls: 3,
      estimatedCost: 0,
      inputTokens: 15,
      outputTokens: 4,
      cachedTokens: 0,
    })
  })

  it('rolls maiavm.com /api/llm/usage rows without a VM dashboard', () => {
    expect(microsToUsd('2500000')).toBe(2.5)
    const billed = rollupMaiavmUsage({
      totals: { costUsd: 1.25, costMicros: '1250000' },
      usage: [
        { model: 'deepseek-v4-flash', inputTokens: 800, outputTokens: 200, requests: 3, costUsd: 0.8 },
        { model: 'deepseek-v4-flash', inputTokens: 200, outputTokens: 50, requests: 1, costUsd: 0.45 },
        { model: 'grok-4.5', inputTokens: 100, outputTokens: 20, requests: 1, costUsd: 0.1 },
      ],
    })
    expect(billed).toEqual({
      sessions: 0,
      apiCalls: 5,
      estimatedCost: 1.25,
      inputTokens: 1100,
      outputTokens: 270,
      cachedTokens: 0,
    })
    expect(modelsFromMaiavmUsage({ usage: billed && [] })).toEqual([])
    expect(
      modelsFromMaiavmUsage({
        usage: [
          { model: 'deepseek-v4-flash', inputTokens: 800, outputTokens: 200 },
          { model: 'deepseek-v4-flash', inputTokens: 200, outputTokens: 50 },
        ],
      }),
    ).toEqual([{ name: 'Maia', tokens: 1250 }])
  })

  it('prefers exact server totals and reports the cached share', () => {
    const t = rollupMaiavmUsage({
      totals: { requests: 10, inputTokens: 1000, outputTokens: 50, cachedTokens: 840 },
      usage: [{ inputTokens: 1, outputTokens: 1, cachedTokens: 1, requests: 1 }],
    })
    expect(t).toMatchObject({ apiCalls: 10, inputTokens: 1000, outputTokens: 50, cachedTokens: 840 })
    expect(cachedPct(t)).toBe(84)
    // Old server: cached tokens still summed from the rows.
    const old = rollupMaiavmUsage({ usage: [{ inputTokens: 100, cachedTokens: 25 }] })
    expect(cachedPct(old)).toBe(25)
    expect(cachedPct({ inputTokens: 0, cachedTokens: 5 })).toBe(0)
  })

  it('usageMoney: net spend, billed, promo — never the gross or list-price numbers', () => {
    expect(
      usageMoney({
        account: {
          balanceMicros: '5000000',
          spentMicros: '28030000',
          refundedMicros: '11210000',
          netSpentMicros: '16820000',
        },
        promo: false,
        totals: { costUsd: 3, billedMicros: '8650000' },
      }),
    ).toEqual({ balance: 5, billedThisMonth: 8.65, promo: false, netSpent: 16.82 })
    // Old server: only the balance is trustworthy.
    expect(
      usageMoney({ account: { balanceMicros: '5000000', spentMicros: '28030000' }, totals: { costUsd: 3 } }),
    ).toEqual({ balance: 5, billedThisMonth: null, promo: false, netSpent: null })
    expect(usageMoney({ account: null, promo: true, totals: { billedMicros: '0' } })).toEqual({
      balance: null,
      billedThisMonth: 0,
      promo: true,
      netSpent: null,
    })
    expect(usageMoney(null)).toBeNull()
  })

  it('charts the last 14 UTC days with zero days filled, clamped to the period', () => {
    const now = new Date('2026-09-28T15:00:00Z')
    const rows = [
      { day: '2026-09-20', costUsd: 0.5 },
      { day: '2026-09-20', costUsd: 0.25 },
      { day: '2026-09-27', costMicros: '1500000', costUsd: 9 }, // billed µUSD wins
      { day: 'not-a-day', costUsd: 9 },
      { day: '2026-09-03T00:00:00Z', costUsd: 9 },
      { costUsd: 9 },
    ]
    const days = dailyCosts(rows, { now })
    expect(days).toHaveLength(14)
    expect(days[0]).toEqual({ day: '2026-09-15', usd: 0 })
    expect(days[13]).toEqual({ day: '2026-09-28', usd: 0 })
    expect(days.find((d) => d.day === '2026-09-20')!.usd).toBe(0.75)
    expect(days.find((d) => d.day === '2026-09-27')!.usd).toBe(1.5)
    // Early in the month the window stops at the period start.
    const early = dailyCosts([{ day: '2026-10-02', costUsd: 1 }], { now: new Date('2026-10-03T01:00:00Z') })
    expect(early.map((d) => d.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    const fromServer = dailyCosts([], { now, periodStart: '2026-09-25T00:00:00.000Z' })
    expect(fromServer.map((d) => d.day)).toEqual(['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'])
    expect(dayLabel('garbage')).toBe('garbage')
  })
})

describe('capPercentLabel', () => {
  it('shows a cap as a share, never dollars', () => {
    expect(capPercentLabel(1.25, 6)).toBe('21% used')
    expect(capPercentLabel(0.001, 6)).toBe('<1% used')
    expect(capPercentLabel(0, 6)).toBe('0% used')
    expect(capPercentLabel(7, 6)).toBe('117% used')
    expect(capPercentLabel(1, 0)).toBe('—')
  })
})

describe('dailyUsage + chartDayLabel', () => {
  const now = new Date('2026-09-28T12:00:00Z')
  it('sums calls, tokens and cost per day with zero days filled', () => {
    const days = dailyUsage(
      [
        { day: '2026-09-28', requests: 3, costMicros: '100000', inputTokens: 1000, outputTokens: 50, cachedTokens: 800 },
        { day: '2026-09-28', requests: 2, costMicros: '50000', inputTokens: 200, outputTokens: 10 },
        { day: '2026-09-20', requests: 1 },
      ],
      { now },
    )
    expect(days).toHaveLength(14)
    expect(days[13].calls).toBe(5)
    expect(days[13].usd).toBeCloseTo(0.15, 6)
    // input + output; the cached slice is already inside input
    expect(days[13].tokens).toBe(1260)
    expect(days.find((d) => d.day === '2026-09-20')?.calls).toBe(1)
    expect(days.find((d) => d.day === '2026-09-21')).toEqual({ day: '2026-09-21', usd: 0, calls: 0, tokens: 0 })
  })
  it('labels only the first bar, weekly ticks and Today', () => {
    const labels = Array.from({ length: 14 }, (_, i) => chartDayLabel(i, 14, `2026-09-${15 + i}`))
    expect(labels[13]).toBe('Today')
    expect(labels[6]).not.toBe('')
    expect(labels[0]).not.toBe('')
    expect(labels.filter((l) => l !== '').length).toBe(3)
  })
})
