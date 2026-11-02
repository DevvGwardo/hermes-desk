/**
 * Deleted-conversation tombstones.
 *
 * The server conversation list (/api/chat/sync) is authoritative for deletes
 * once the DELETE is acked; until then a poll could still carry the row and
 * resurrect it. A tombstone is the conversation id and/or its
 * hermesSessionId, persisted to localStorage so an un-acked delete survives
 * reload. The sync apply step checks rows against this set; an ack shortens
 * the entry to a brief grace window (expireDeletedConversation).
 *
 * Bounded: at most 500 entries (FIFO — oldest evicted first) and a 90-day
 * TTL, so the key cannot grow unbounded over years of use.
 */

const KEY = 'maia:deleted-conversations:v1'

export const MAX_TOMBSTONES = 500
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000

interface TombstoneEntry {
  id: string
  /** Epoch ms when the delete was recorded. */
  at: number
}

let cache: TombstoneEntry[] | null = null

function nowMs(): number {
  return Date.now()
}

function fresh(entry: TombstoneEntry, now: number): boolean {
  return (
    typeof entry?.id === 'string' &&
    entry.id !== '' &&
    typeof entry?.at === 'number' &&
    Number.isFinite(entry.at) &&
    now - entry.at <= TOMBSTONE_TTL_MS
  )
}

function normalize(raw: unknown): TombstoneEntry[] {
  const now = nowMs()
  if (!Array.isArray(raw)) return []
  const out: TombstoneEntry[] = []
  for (const row of raw) {
    // Legacy envelope: plain string ids (pre-TTL). Adopt with a fresh stamp
    // so upgrading clients do not instantly resurrect old deletes.
    if (typeof row === 'string') {
      if (row.trim() !== '') out.push({ id: row, at: now })
      continue
    }
    if (row && typeof row === 'object') {
      const o = row as { id?: unknown; at?: unknown }
      const entry: TombstoneEntry = {
        id: typeof o.id === 'string' ? o.id : '',
        at: typeof o.at === 'number' ? o.at : now,
      }
      if (entry.id !== '' && fresh(entry, now)) out.push(entry)
    }
  }
  return out
}

function load(): TombstoneEntry[] {
  if (cache) return cache
  try {
    const raw = window.localStorage.getItem(KEY)
    cache = raw ? normalize(JSON.parse(raw)) : []
  } catch {
    cache = []
  }
  return cache
}

function asSet(entries: TombstoneEntry[]): Set<string> {
  return new Set(entries.map((e) => e.id))
}

function persist(next: TombstoneEntry[]): void {
  // FIFO cap: insertion order is oldest-first (re-records move to the tail).
  const capped = next.length > MAX_TOMBSTONES ? next.slice(next.length - MAX_TOMBSTONES) : next
  cache = capped
  try {
    window.localStorage.setItem(KEY, JSON.stringify(capped))
  } catch {
    /* best-effort */
  }
}

/** Record a deletion by conversation id and (when present) hermes session id. */
export function recordDeletedConversation(id: string, sessionId?: string | null): void {
  const now = nowMs()
  const live = load().filter((e) => fresh(e, now))
  const add = (key: string) => {
    const trimmed = (key ?? '').trim()
    if (!trimmed) return
    const rest = live.filter((e) => e.id !== trimmed)
    rest.push({ id: trimmed, at: now })
    live.length = 0
    live.push(...rest)
  }
  add(id)
  add(sessionId ?? '')
  persist(live)
}

/** True when this id (conversation id or session id) was deleted. */
export function isDeletedConversation(id: string | null | undefined): boolean {
  const key = (id ?? '').trim()
  return Boolean(key) && asSet(load()).has(key)
}

/**
 * The server acked the delete, so the tombstone is only a short guard now:
 * re-stamp these ids to expire `graceMs` from now (long enough to outlive a
 * poll computed before the delete committed). Unknown ids are ignored.
 */
export function expireDeletedConversation(ids: string[], graceMs: number): void {
  const keys = new Set(ids.map((id) => (id ?? '').trim()).filter(Boolean))
  if (keys.size === 0) return
  const now = nowMs()
  const at = now - TOMBSTONE_TTL_MS + graceMs
  let touched = false
  const next = load()
    .filter((e) => fresh(e, now))
    .map((e) => {
      if (!keys.has(e.id) || e.at <= at) return e
      touched = true
      return { ...e, at }
    })
  if (touched) persist(next)
}

/** Test-only: reset module cache AND localStorage. */
export function resetDeletedTombstonesForTest(): void {
  cache = null
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

/** Test-only: clear only the in-memory cache so the next read hits localStorage. */
export function _clearTombstoneCacheForTest(): void {
  cache = null
}
