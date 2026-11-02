'use strict'

/**
 * D-04 (red team sweep 2026-08-30): VM-controlled content (PreviewModal's
 * `nub-vm://` frame, agent-written pages) must never top-navigate the
 * desktop app's window away from the app shell — a preload-bearing window
 * landing on attacker HTML is the whole finding. Extracted from main.cjs so
 * the allow/deny decision is behavior-tested, not text-pinned.
 *
 * Wiring (main.cjs): will-navigate and will-redirect use this guard on
 * every window that loads the app renderer (main + HUD). `window.open` stays
 * with setWindowOpenHandler — this guard is for top-level navigations.
 */

/**
 * Build the will-navigate handler for an app window.
 *
 * Only the app's own origin (packaged file:// index.html or, in dev, the
 * vite server origin) may top-navigate these windows. Everything else is
 * denied — in particular:
 *   - nub-vm: previews stay IN-FRAME via the protocol handler; a
 *     top-navigation to nub-vm: would swap the preload-bearing window onto
 *     VM-controlled content.
 *   - http(s) top-navigation (external links use setWindowOpenHandler).
 *
 * file:// URLs are compared as FULL PATHS to dist/index.html by the
 * isAppOrigin callback in main.cjs — never by origin alone, since every
 * file:// URL shares the opaque 'null' origin.
 *
 * @param {(url: string) => boolean} isAppOrigin answers for the file://
 *   index.html path and, in dev, the vite server origin
 * @returns {(event: { preventDefault: () => void }, url: string) => void}
 */
function willNavigateGuard(isAppOrigin) {
  return function onWillNavigate(event, url) {
    let allowed = false
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'nub-vm:') {
        allowed = false
      } else if (parsed.protocol === 'file:' || parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        allowed = isAppOrigin(url)
      }
    } catch {
      allowed = false
    }
    if (!allowed) event.preventDefault()
  }
}

module.exports = { willNavigateGuard }
