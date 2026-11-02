import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activityCounts, activityEntries, buildHeatmap, heatCellLabel, heatLevel } from '../home-heatmap'
import { ACTIVITY_LOG_KEY, dayKey, readActivityLog, recordActivity, resetActivityLog, subscribeActivityLog } from '../activity-log'
import type { ChatMessage } from '../agents/types'

// Wednesday 7 Oct 2026, mid-afternoon local time.
const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime()
const day = (daysAgo: number, hour = 12) => { const d = new Date(NOW); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return d }
const counts = (entries: Record<number, number>) => new Map(Object.entries(entries).map(([ago, n]) => [dayKey(day(Number(ago))), n]))

beforeEach(() => { window.localStorage.clear(); resetActivityLog() })
afterEach(() => vi.restoreAllMocks())

describe('activity entries and counts', () => {
  it('counts each chat once per local day across start, last activity, messages and the log', () => {
    const conversations = [
      { id: 'a', createdAt: day(2).toISOString(), lastUsedAt: day(0, 9).toISOString() },
      { id: 'b', createdAt: day(0, 10).toISOString(), lastUsedAt: day(0, 11).toISOString(), lastActivityAt: day(0, 14).toISOString() },
      { id: 'ph', createdAt: day(0).toISOString(), lastUsedAt: day(0).toISOString(), placeholder: true },
      { id: 'epoch', createdAt: new Date(0).toISOString(), lastUsedAt: new Date(0).toISOString() },
    ]
    const messages = { a: [
      { id: '1', threadId: 'a', role: 'user', content: 'x', createdAt: day(1).toISOString() },
      { id: '2', threadId: 'a', role: 'agent', content: '', createdAt: day(5).toISOString(), streaming: true },
      { id: '3', threadId: 'a', role: 'system', content: 'x', createdAt: day(6).toISOString() },
    ] as ChatMessage[] }
    const result = activityCounts(activityEntries(conversations, messages), { [dayKey(day(10))]: ['old'], [dayKey(day(0))]: ['a'] }, NOW)
    expect(Object.fromEntries(result)).toEqual({
      [dayKey(day(0))]: 2, [dayKey(day(1))]: 1, [dayKey(day(2))]: 1, [dayKey(day(10))]: 1,
    })
  })

  it('ignores future timestamps', () => {
    expect(activityCounts([{ conversationId: 'a', at: NOW + 86_400_000 }], {}, NOW).size).toBe(0)
  })
})

describe('buildHeatmap', () => {
  it('lays out Sunday-first week columns ending this week, with future days marked', () => {
    const model = buildHeatmap(new Map(), NOW, 53)
    expect(model.weeks).toHaveLength(53)
    expect(model.weeks.every((week) => week.length === 7)).toBe(true)
    expect(new Date(model.weeks[0][0].date).getDay()).toBe(0)
    const last = model.weeks.at(-1)!
    expect(last.findIndex((cell) => cell.day === dayKey(NOW))).toBe(3) // Wednesday
    expect(last.slice(4).every((cell) => cell.future)).toBe(true)
    expect(model.months[0].week).toBe(0)
    expect(new Set(model.months.map((m) => m.week)).size).toBe(model.months.length)
    expect(model.months.every((m) => m.week <= 51)).toBe(true) // never squeezed into the last column
  })

  it('scales levels to the busiest day and summarises streaks, totals and months', () => {
    const model = buildHeatmap(counts({ 0: 1, 1: 2, 2: 8, 3: 4, 9: 1 }), NOW, 4)
    const byDay = new Map(model.weeks.flat().map((cell) => [cell.day, cell]))
    expect(byDay.get(dayKey(day(2)))).toMatchObject({ count: 8, level: 4 })
    expect(byDay.get(dayKey(day(3)))!.level).toBe(2)
    expect(byDay.get(dayKey(day(0)))!.level).toBe(1)
    expect(model).toMatchObject({ max: 8, activeDays: 5, chats: 16, currentStreak: 4, longestStreak: 4 })
    expect(model.busiest!.day).toBe(dayKey(day(2)))
    expect(model.monthly.reduce((n, row) => n + row.chats, 0)).toBe(16)
  })

  it('keeps the streak alive through an empty today but not an empty yesterday', () => {
    expect(buildHeatmap(counts({ 1: 1, 2: 1 }), NOW, 2).currentStreak).toBe(2)
    expect(buildHeatmap(counts({ 2: 1, 3: 1 }), NOW, 2).currentStreak).toBe(0)
    expect(buildHeatmap(new Map(), NOW, 2)).toMatchObject({ max: 0, activeDays: 0, busiest: null, currentStreak: 0 })
  })

  it('labels levels and cells plainly', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => heatLevel(n, 4))).toEqual([0, 1, 2, 3, 4, 4])
    expect(heatLevel(3, 0)).toBe(0)
    expect(heatCellLabel({ count: 1, date: day(0).getTime() })).toMatch(/^1 chat · /)
    expect(heatCellLabel({ count: 0, date: day(0).getTime() })).toMatch(/^No chats · /)
  })
})

describe('activity log', () => {
  it('records ids per day idempotently and persists them', () => {
    const listener = vi.fn()
    const off = subscribeActivityLog(listener)
    expect(recordActivity([{ conversationId: 'a', at: day(0).toISOString() }, { conversationId: 'a', at: day(0, 9).getTime() }], NOW)).toBe(true)
    expect(recordActivity([{ conversationId: 'a', at: day(0).toISOString() }], NOW)).toBe(false)
    expect(listener).toHaveBeenCalledOnce()
    expect(JSON.parse(window.localStorage.getItem(ACTIVITY_LOG_KEY)!)).toEqual({ [dayKey(day(0))]: ['a'] })
    off()
  })

  it('drops epoch, future and expired days and reads corrupt storage as empty', () => {
    recordActivity([
      { conversationId: 'a', at: 0 }, { conversationId: 'b', at: NOW + 3_600_000 }, { conversationId: 'c', at: day(500).getTime() },
      { conversationId: '', at: day(0).getTime() },
    ], NOW)
    expect(readActivityLog()).toEqual({})
    window.localStorage.setItem(ACTIVITY_LOG_KEY, '{broken')
    expect(readActivityLog()).toEqual({})
    window.localStorage.setItem(ACTIVITY_LOG_KEY, JSON.stringify({ 'not-a-day': ['x'], '2026-10-01': ['y', 7] }))
    expect(readActivityLog()).toEqual({ '2026-10-01': ['y'] })
  })

  it('keeps recording in memory when storage fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota') })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Private mode') })
    recordActivity([{ conversationId: 'a', at: day(0).getTime() }], NOW)
    expect(readActivityLog()).toEqual({ [dayKey(day(0))]: ['a'] })
  })
})
