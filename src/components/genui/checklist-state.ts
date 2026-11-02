import type { GenUiChecklist } from '../../lib/genui'

export const CHECKLIST_STORAGE_KEY = 'hermes-desk:genui-local-checklists:v1'
export const CHECKLIST_MAX_ENTRIES = 32
export const CHECKLIST_MAX_BYTES = 131_072
export const CHECKLIST_TTL_MS = 7 * 24 * 60 * 60 * 1000
interface Entry { key: string; revision: string; checked: string[]; updatedAt: number }

function entries(storage: Storage, now: number): Entry[] {
  try {
    const text = storage.getItem(CHECKLIST_STORAGE_KEY)
    if (!text || text.length > CHECKLIST_MAX_BYTES || new TextEncoder().encode(text).byteLength > CHECKLIST_MAX_BYTES) return []
    const raw: unknown = JSON.parse(text)
    if (!Array.isArray(raw)) return []
    return raw.slice(0, CHECKLIST_MAX_ENTRIES).filter((e): e is Entry =>
      !!e && typeof e === 'object' && typeof e.key === 'string' && e.key.length <= 1024 &&
      typeof e.revision === 'string' && e.revision.length <= 16_384 &&
      Number.isFinite(e.updatedAt) && e.updatedAt <= now && now - e.updatedAt < CHECKLIST_TTL_MS &&
      Array.isArray(e.checked) && e.checked.length <= 20 &&
      e.checked.every((id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(id)))
  } catch { return [] }
}

export function readChecklist(storage: Storage | undefined, key: string, revision: string, spec: GenUiChecklist, now = Date.now()): string[] {
  const entry = storage && entries(storage, now).find(e => e.key === key && e.revision === revision)
  const selected = entry?.checked ?? spec.items.filter(item => item.checked).map(item => item.id)
  return spec.items.filter(item => selected.includes(item.id)).map(item => item.id)
}

export function writeChecklist(storage: Storage | undefined, key: string, revision: string, checked: string[], now = Date.now()): void {
  if (!storage || key.length > 1024 || revision.length > 16_384) return
  try {
    const next = [...entries(storage, now).filter(e => e.key !== key),
      { key, revision, checked: checked.slice(0, 20), updatedAt: now }].slice(-CHECKLIST_MAX_ENTRIES)
    let serialized = JSON.stringify(next)
    while (new TextEncoder().encode(serialized).byteLength > CHECKLIST_MAX_BYTES && next.length) {
      next.shift()
      serialized = JSON.stringify(next)
    }
    storage.setItem(CHECKLIST_STORAGE_KEY, serialized)
  } catch { /* Storage unavailable/full: interaction remains local, in memory. */ }
}
