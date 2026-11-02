/** Legacy mode names remain type-compatible until the Settings UI is pruned. */
export type HermesTransportMode = 'serve' | 'api' | 'mock' | 'auto'

export const TRANSPORT_MODES: readonly HermesTransportMode[] = ['serve']

export function normalizeTransportMode(raw: unknown): HermesTransportMode | null {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'serve' ? 'serve' : null
}

export interface TransportConfigInput {
  stored?: unknown
  env?: unknown
  serveUrl?: unknown
  desktop?: boolean
}

export interface ResolvedTransportConfig {
  mode: HermesTransportMode
  probeServe: boolean
  source: string
}

export function resolveTransportConfig(_input: TransportConfigInput = {}): ResolvedTransportConfig {
  return { mode: 'serve', probeServe: false, source: 'local:hermes-serve' }
}
