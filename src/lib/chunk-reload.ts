/**
 * Stale-chunk recovery for the hosted web app.
 *
 * A tab opened before a deploy still runs the old entry chunk, which imports
 * lazy chunks by their old fingerprinted names. Those files are gone from the
 * new deploy, so the dynamic import fails ("Failed to fetch dynamically
 * imported module" / "Expected a JavaScript-or-Wasm module script") and the
 * error boundary shows "Something went wrong". A reload fetches the new
 * index.html and its new chunk names, which fixes it.
 *
 * Reload at most once per RELOAD_WINDOW_MS: if the fresh page fails the same
 * way (a broken deploy, or offline), the error boundary shows instead of a
 * reload loop.
 */

const RELOAD_KEY = 'nub:chunk-reload-at'
const RELOAD_WINDOW_MS = 30_000

const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Expected a JavaScript.*module script|Unable to preload CSS/i

export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false
  const message = err instanceof Error ? err.message : String(err)
  return CHUNK_ERROR.test(message)
}

/** Reloads the page unless it already did so in the last RELOAD_WINDOW_MS.
 *  Returns true when a reload was started. */
export function reloadForStaleChunk(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last < RELOAD_WINDOW_MS) return false
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    // No sessionStorage means no loop guard, so don't auto-reload.
    return false
  }
  window.location.reload()
  return true
}

/** Vite fires `vite:preloadError` when a preload helper fails. Handle it
 *  before the import rejects into React. */
export function installStaleChunkReload(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForStaleChunk()) event.preventDefault()
  })
}
