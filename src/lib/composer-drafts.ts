/**
 * Unsent composer text, one per conversation. The composer is one component
 * that stays mounted across conversation switches; with a single draft,
 * text typed in one chat followed you into the next and could be sent there.
 * Kept in localStorage (this device only) so a reload or a restart keeps a
 * half-written message, like other chat apps. Best-effort: storage that is
 * missing or full only costs persistence, never the draft in memory.
 */

const KEY = 'nub.composer-drafts.v1'
/** Oldest drafts are dropped past this many conversations. */
const MAX_DRAFTS = 50
/** A draft this long is not worth keeping on disk (a pasted log). */
const MAX_STORED_CHARS = 20_000

let drafts: Map<string, string> | null = null

function load(): Map<string, string> {
  if (drafts) return drafts
  drafts = new Map()
  try {
    const raw = window.localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && v) drafts.set(k, v)
      }
    }
  } catch {
    /* no storage: drafts live in memory only */
  }
  return drafts
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function persistSoon(): void {
  if (saveTimer !== null) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistNow()
  }, 400)
}

function persistNow(): void {
  const map = load()
  const out: Record<string, string> = {}
  for (const [k, v] of map) if (v.length <= MAX_STORED_CHARS) out[k] = v
  try {
    if (Object.keys(out).length === 0) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, JSON.stringify(out))
  } catch {
    /* full or blocked: keep the in-memory copy */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (saveTimer === null) return
    clearTimeout(saveTimer)
    saveTimer = null
    persistNow()
  })
}

export function draftFor(threadKey: string): string {
  if (typeof window === 'undefined') return ''
  return load().get(threadKey) ?? ''
}

export function setDraftFor(threadKey: string, text: string): void {
  if (typeof window === 'undefined' || !threadKey) return
  const map = load()
  const had = map.get(threadKey) ?? ''
  if (had === text) return
  map.delete(threadKey)
  if (text.trim()) map.set(threadKey, text)
  while (map.size > MAX_DRAFTS) map.delete(map.keys().next().value as string)
  persistSoon()
}

/** Test hook. */
export function resetDraftsForTests(): void {
  drafts = null
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = null
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
