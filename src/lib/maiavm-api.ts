/** Loopback endpoints only. The desktop bridge resolves the running serve port. */
export function isLocalHermesServeUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim())
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username && !url.password && !url.search && !url.hash &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function getHermesServeUrl(): string | null {
  const value = import.meta.env.VITE_HERMES_SERVE_URL
  return typeof value === 'string' && isLocalHermesServeUrl(value) ? value.trim().replace(/\/+$/, '') : null
}

/** Kept for renderer callers pending wave-2 platform pruning; never hosted. */
export function getApiBase(): string {
  return getHermesServeUrl() ?? 'http://127.0.0.1:9119'
}

export function isMockMode(): boolean {
  return false
}

export interface NubApiConnection {
  baseUrl: string
  instanceId?: string
  desktopToken?: string
}

/** Platform callers cannot select a VM in this project. */
export async function resolveNubApiConnection(): Promise<NubApiConnection | null> {
  return null
}

export type { HermesTransportMode } from './agents/transport-routing'

export function getHermesTransportMode(): import('./agents/transport-routing').HermesTransportMode {
  return 'serve'
}
