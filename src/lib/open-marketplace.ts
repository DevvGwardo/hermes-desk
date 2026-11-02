/**
 * Ask the app shell to open Connect apps (the Marketplace) from anywhere,
 * e.g. Settings → Chat apps. App.tsx listens. Same pattern as
 * open-settings.ts.
 */
const EVENT = 'nub:open-marketplace'

export function requestOpenMarketplace(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(EVENT))
}

export function onOpenMarketplaceRequest(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(EVENT, cb)
  return () => window.removeEventListener(EVENT, cb)
}
