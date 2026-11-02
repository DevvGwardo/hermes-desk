/**
 * Dev-gated logger — never leaks internals to prod DevTools.
 * In production (import.meta.env.PROD) every call is a no-op and
 * will be tree-shaken away. In dev it proxies to console.
 */

function isDev(): boolean {
  try {
    return Boolean(import.meta.env.DEV)
  } catch {
    return false
  }
}

export const logger = {
  log(...args: unknown[]): void {
    if (isDev()) console.log(...args)
  },
  warn(...args: unknown[]): void {
    if (isDev()) console.warn(...args)
  },
  error(...args: unknown[]): void {
    if (isDev()) console.error(...args)
  },
  info(...args: unknown[]): void {
    if (isDev()) console.info(...args)
  },
  debug(...args: unknown[]): void {
    if (isDev()) console.debug(...args)
  },
}
