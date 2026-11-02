/**
 * Local day → chats activity log behind the Home heatmap. Hermes only lists
 * each profile's most recent sessions and transcripts are not persisted, so
 * every day a chat is seen active is remembered here (ids only, no content).
 * Recording is an idempotent set-union; storage failures keep memory.
 */
export const ACTIVITY_LOG_KEY = 'hermes-desk:activity-log:v1'
/** Days kept: a full heatmap year plus slack. */
export const ACTIVITY_LOG_DAYS = 400
export type ActivityLog = Readonly<Record<string, readonly string[]>>
export interface ActivityEntry { conversationId: string; at: string | number }

const listeners = new Set<() => void>()
let snapshot: ActivityLog = {}
let lastRaw: string | null | undefined

/** Local calendar day, `YYYY-MM-DD`. */
export function dayKey(at: number | Date): string {
  const d = at instanceof Date ? at : new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parse(raw: string | null): ActivityLog {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<string, string[]> = {}
    for (const [day, ids] of Object.entries(value)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(ids)) out[day] = ids.filter((id): id is string => typeof id === 'string')
    }
    return out
  } catch { return {} }
}

export function readActivityLog(): ActivityLog {
  try {
    if (typeof window === 'undefined') return snapshot
    const raw = window.localStorage.getItem(ACTIVITY_LOG_KEY)
    if (raw !== lastRaw) { lastRaw = raw; snapshot = parse(raw) }
  } catch { /* keep the in-memory log */ }
  return snapshot
}

/** Adds entries; returns true when anything new was recorded. */
export function recordActivity(entries: readonly ActivityEntry[], now = Date.now()): boolean {
  const current = readActivityLog()
  const oldest = dayKey(now - ACTIVITY_LOG_DAYS * 86_400_000)
  const next: Record<string, string[]> = {}
  for (const [day, ids] of Object.entries(current)) if (day >= oldest) next[day] = [...ids]
  let changed = Object.keys(next).length !== Object.keys(current).length
  for (const { conversationId, at } of entries) {
    const ms = typeof at === 'number' ? at : Date.parse(at)
    // Epoch-zero placeholders and clock-skewed future stamps are not activity.
    if (!conversationId || !Number.isFinite(ms) || ms <= 0 || ms > now + 60_000) continue
    const day = dayKey(ms)
    if (day < oldest) continue
    const ids = next[day] ??= []
    if (!ids.includes(conversationId)) { ids.push(conversationId); changed = true }
  }
  if (!changed) return false
  snapshot = next
  try {
    if (typeof window !== 'undefined') {
      const raw = JSON.stringify(next)
      window.localStorage.setItem(ACTIVITY_LOG_KEY, raw)
      lastRaw = raw
    }
  } catch { /* quota / private mode: memory only */ }
  for (const listener of listeners) listener()
  return true
}

export function subscribeActivityLog(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => { if (event.key === ACTIVITY_LOG_KEY || event.key === null) listener() }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

/** Test hook. */
export function resetActivityLog(): void {
  snapshot = {}
  lastRaw = undefined
}
