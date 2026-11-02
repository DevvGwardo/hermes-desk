/**
 * Which port `npm run electron:dev` serves the renderer on.
 *
 * 5173 is every Vite project's default, so another repo's dev server
 * (e.g. nubcat-studio) often already holds it — and the launcher used to die
 * with "Port 5173 is still in use". Now:
 *   - NUB_DEV_PORT=<n> pins the port; if something that is not ours holds it,
 *     fail with a clear message instead of guessing.
 *   - otherwise take the first port from 5173 upward that is free after our
 *     own stale Vite is stopped. Another project's server is never killed.
 * The chosen port reaches Electron as VITE_DEV_SERVER_URL, which main.cjs
 * already honors for the main window, the HUD and the navigation guard.
 *
 * Pure: `busy(port)` reports whether anything else still listens there.
 */

export const DEFAULT_DEV_PORT = 5173
export const DEV_PORT_SPAN = 27 // 5173–5199

/**
 * @param {{ env?: Record<string, string | undefined>, busy: (port: number) => boolean }} opts
 * @returns {{ ok: true, port: number, pinned: boolean } | { ok: false, error: string }}
 */
export function pickDevPort({ env = process.env, busy }) {
  const raw = (env.NUB_DEV_PORT ?? '').trim()
  if (raw) {
    const port = Number(raw)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return { ok: false, error: `NUB_DEV_PORT must be a port number 1024–65535 (got "${raw}")` }
    }
    if (busy(port)) {
      return { ok: false, error: `NUB_DEV_PORT=${port} is in use by another process. Pick another port or unset it.` }
    }
    return { ok: true, port, pinned: true }
  }
  for (let port = DEFAULT_DEV_PORT; port < DEFAULT_DEV_PORT + DEV_PORT_SPAN; port++) {
    if (!busy(port)) return { ok: true, port, pinned: false }
  }
  return {
    ok: false,
    error: `No free dev port in ${DEFAULT_DEV_PORT}–${DEFAULT_DEV_PORT + DEV_PORT_SPAN - 1}. Set NUB_DEV_PORT to a free one.`,
  }
}
