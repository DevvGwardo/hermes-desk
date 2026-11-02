/** Local UI preferences use the same versioned envelope as agents/persist.ts.
 * CONTRACT: that existing persistence layer uses localStorage; there is no
 * prefs.json IPC in the shared bridge yet. No profile or session data is saved.
 */
export interface LocalPrefs {
  pinnedOrder: string[]
  hiddenProfiles: string[]
  showScratch: boolean
  sessionSources: string[]
}

export const LOCAL_PREFS_KEY = 'hermes-desk:local-prefs:v1'
const listeners = new Set<() => void>()
const defaults = (): LocalPrefs => ({
  pinnedOrder: [],
  hiddenProfiles: [],
  showScratch: false,
  sessionSources: ['desktop'],
})
let snapshot = defaults()
let lastRaw: string | null = null

function strings(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((s): s is string => typeof s === 'string' && s.trim().length > 0))]
    : [...fallback]
}

function normalize(value: Partial<LocalPrefs>): LocalPrefs {
  return {
    pinnedOrder: strings(value.pinnedOrder),
    hiddenProfiles: strings(value.hiddenProfiles),
    showScratch: value.showScratch === true,
    sessionSources: strings(value.sessionSources, ['desktop']),
  }
}

export function loadLocalPrefs(): LocalPrefs {
  let raw: string | null
  try {
    if (typeof window === 'undefined') return snapshot
    raw = window.localStorage.getItem(LOCAL_PREFS_KEY)
  } catch {
    return snapshot
  }
  if (raw === lastRaw) return snapshot
  lastRaw = raw
  try {
    const env = raw ? JSON.parse(raw) : null
    snapshot = env?.slice === 'hermes-desk.local-prefs' && env.schemaVersion === 1 &&
      env.scope === 'client-persisted' && env.value && typeof env.value === 'object'
      ? normalize(env.value)
      : defaults()
  } catch {
    // Corrupt data never blocks the sidebar. Cache its fallback snapshot.
    snapshot = defaults()
  }
  return snapshot
}

export const getLocalPrefs = loadLocalPrefs

export function saveLocalPrefs(value: LocalPrefs): void {
  snapshot = normalize(value)
  try {
    if (typeof window !== 'undefined') {
      const raw = JSON.stringify({
        slice: 'hermes-desk.local-prefs',
        schemaVersion: 1,
        scope: 'client-persisted',
        savedAt: new Date().toISOString(),
        value: snapshot,
      })
      window.localStorage.setItem(LOCAL_PREFS_KEY, raw)
      lastRaw = raw
    }
  } catch {
    // Keep the in-memory preference when persistence is unavailable.
  }
  for (const listener of listeners) listener()
}

export function updateLocalPrefs(patch: Partial<LocalPrefs>): LocalPrefs {
  const next = normalize({ ...getLocalPrefs(), ...patch })
  saveLocalPrefs(next)
  return next
}

export function subscribeLocalPrefs(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === LOCAL_PREFS_KEY || event.key === null) listener()
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}
