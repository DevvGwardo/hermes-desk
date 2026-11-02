/**
 * "Open Home when Hermes Desk starts" — its own key so the sidebar's
 * versioned local-prefs envelope stays untouched. On by default; storage
 * failures fall back to the in-memory value.
 */
export const HOME_ON_LAUNCH_KEY = 'hermes-desk:home-on-launch'
const listeners = new Set<() => void>()
let memory = true

export function getHomeOnLaunch(): boolean {
  try {
    if (typeof window === 'undefined') return memory
    const raw = window.localStorage.getItem(HOME_ON_LAUNCH_KEY)
    return raw !== 'false'
  } catch {
    return memory
  }
}

export function setHomeOnLaunch(value: boolean): void {
  memory = value
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(HOME_ON_LAUNCH_KEY, String(value))
  } catch {
    // Keep the in-memory preference when persistence is unavailable.
  }
  for (const listener of listeners) listener()
}

export function subscribeHomeOnLaunch(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === HOME_ON_LAUNCH_KEY || event.key === null) listener()
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}
