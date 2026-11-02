/**
 * Home activity heatmap model (GitHub-style contribution grid). Pure.
 * Unit: chats active on a day — a chat counts once per day it was started,
 * last active, had a loaded message, or was recorded in the local activity log.
 */
import type { ChatMessage, Conversation } from './agents/types'
import { dayKey, type ActivityEntry, type ActivityLog } from './activity-log'

export const HEAT_WEEKS = 53
export type HeatLevel = 0 | 1 | 2 | 3 | 4
export interface HeatCell { day: string; date: number; count: number; level: HeatLevel; future: boolean }
export interface HeatMonth { label: string; week: number }
export interface HeatMonthTotal { label: string; activeDays: number; chats: number }
export interface HeatModel {
  weeks: HeatCell[][]
  months: HeatMonth[]
  max: number
  activeDays: number
  /** Sum of daily active chats across the range. */
  chats: number
  currentStreak: number
  longestStreak: number
  busiest: HeatCell | null
  monthly: HeatMonthTotal[]
}

type ConversationLike = Pick<Conversation, 'id' | 'createdAt' | 'lastUsedAt' | 'placeholder'> & { lastActivityAt?: string }

/** Every (chat, moment) the app knows about — also what App records into the log. */
export function activityEntries(
  conversations: readonly ConversationLike[],
  messagesByThreadId: Readonly<Record<string, readonly ChatMessage[] | undefined>> = {},
): ActivityEntry[] {
  const entries: ActivityEntry[] = []
  for (const c of conversations) {
    if (c.placeholder) continue
    entries.push({ conversationId: c.id, at: c.createdAt }, { conversationId: c.id, at: c.lastActivityAt ?? c.lastUsedAt })
    for (const m of messagesByThreadId[c.id] ?? []) {
      if ((m.role === 'user' || m.role === 'agent') && !m.streaming && !m.pending) entries.push({ conversationId: c.id, at: m.createdAt })
    }
  }
  return entries
}

/** Distinct active chats per local day, merging live data with the persisted log. */
export function activityCounts(entries: readonly ActivityEntry[], log: ActivityLog = {}, now = Date.now()): Map<string, number> {
  const days = new Map<string, Set<string>>()
  const add = (day: string, id: string) => { let set = days.get(day); if (!set) days.set(day, set = new Set()); set.add(id) }
  for (const [day, ids] of Object.entries(log)) for (const id of ids) add(day, id)
  for (const { conversationId, at } of entries) {
    const ms = typeof at === 'number' ? at : Date.parse(at)
    if (conversationId && Number.isFinite(ms) && ms > 0 && ms <= now + 60_000) add(dayKey(ms), conversationId)
  }
  return new Map([...days].map(([day, set]) => [day, set.size]))
}

/** Quartiles of the busiest day, so one huge day does not flatten the rest into level 1. */
export function heatLevel(count: number, max: number): HeatLevel {
  if (count <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4))) as HeatLevel
}

function monthLabel(date: Date, withYear = false): string {
  return date.toLocaleDateString(undefined, withYear ? { month: 'short', year: 'numeric' } : { month: 'short' })
}

export function buildHeatmap(counts: ReadonlyMap<string, number>, now = Date.now(), weeks = HEAT_WEEKS): HeatModel {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const todayKey = dayKey(today)
  const start = new Date(today)
  start.setDate(start.getDate() - start.getDay() - (Math.max(1, weeks) - 1) * 7)
  const cells: HeatCell[] = []
  for (const d = new Date(start); cells.length < Math.max(1, weeks) * 7; d.setDate(d.getDate() + 1)) {
    const day = dayKey(d)
    const future = day > todayKey
    cells.push({ day, date: d.getTime(), count: future ? 0 : counts.get(day) ?? 0, level: 0, future })
  }
  const past = cells.filter((cell) => !cell.future)
  const max = Math.max(0, ...past.map((cell) => cell.count))
  for (const cell of cells) cell.level = heatLevel(cell.count, max)

  const grid: HeatCell[][] = []
  for (let i = 0; i < cells.length; i += 7) grid.push(cells.slice(i, i + 7))
  const months: HeatMonth[] = []
  grid.forEach((week, index) => {
    const first = new Date(week[0].date)
    const previous = index > 0 ? new Date(grid[index - 1][0].date) : null
    // Label the column where a month starts; skip a label that would collide with the
    // previous one or run past the grid's right edge (it needs about two columns).
    if ((!previous || previous.getMonth() !== first.getMonth()) && (!months.length || index - months.at(-1)!.week >= 3) &&
      grid.length - index >= 2) {
      months.push({ label: monthLabel(first), week: index })
    }
  })

  let longest = 0
  let run = 0
  for (const cell of past) { run = cell.count ? run + 1 : 0; longest = Math.max(longest, run) }
  let current = 0
  // An empty today does not break the streak yet.
  for (let i = past.length - 1 - (past.at(-1)?.count ? 0 : 1); i >= 0 && past[i].count; i--) current++

  const monthly = new Map<string, HeatMonthTotal>()
  for (const cell of past) {
    const label = monthLabel(new Date(cell.date), true)
    const row = monthly.get(label) ?? { label, activeDays: 0, chats: 0 }
    if (cell.count) { row.activeDays++; row.chats += cell.count }
    monthly.set(label, row)
  }
  const busiest = past.reduce<HeatCell | null>((best, cell) => cell.count && (!best || cell.count > best.count) ? cell : best, null)
  return {
    weeks: grid, months, max,
    activeDays: past.filter((cell) => cell.count).length,
    chats: past.reduce((sum, cell) => sum + cell.count, 0),
    currentStreak: current, longestStreak: longest, busiest, monthly: [...monthly.values()],
  }
}

export function heatCellLabel(cell: Pick<HeatCell, 'count' | 'date'>): string {
  const when = new Date(cell.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  return `${cell.count ? `${cell.count} ${cell.count === 1 ? 'chat' : 'chats'}` : 'No chats'} · ${when}`
}
