/**
 * Boot splash (BootOrbSplash) hold decision, shared by the desktop/web shell
 * (App.tsx) and the phone shell (MobileApp.tsx).
 *
 * With an empty cache the splash waits for the first roster/thread hydrate
 * (bounded by `maxMs`) so the first thing on screen is real content. When
 * threads are already on disk (persisted store slice), the shell has
 * something real to show at first paint: the splash only plays its short
 * minimum and hydration refreshes the rows in place.
 */

/** Splash hold when cached threads are on screen (desktop/web). */
export const BOOT_CACHED_MIN_MS = 150

interface ThreadLike {
  hiddenFromSidebar?: boolean
  placeholder?: boolean
}

/** True when the store holds at least one real, visible thread (not a
 *  synthesized placeholder) — i.e. the shell can paint content right away. */
export function hasCachedThreads(state: { conversations: readonly ThreadLike[] }): boolean {
  return state.conversations.some((c) => !c.placeholder && !c.hiddenFromSidebar)
}

/** Milliseconds left to hold the splash (0 = drop it now). */
export function bootSplashWaitMs(opts: {
  elapsedMs: number
  hydrating: boolean
  cached: boolean
  minMs: number
  maxMs: number
  cachedMinMs?: number
}): number {
  const { elapsedMs, hydrating, cached, minMs, maxMs } = opts
  if (cached) return Math.max(0, (opts.cachedMinMs ?? BOOT_CACHED_MIN_MS) - elapsedMs)
  if (hydrating) return Math.max(0, maxMs - elapsedMs)
  return Math.max(0, minMs - elapsedMs)
}
