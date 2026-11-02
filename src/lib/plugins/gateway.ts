/**
 * Plugin gateway door — the single JSON-RPC path `host.request` wraps.
 *
 * Resolves the active transport; when it's a serve-mode HermesServeTransport
 * it calls the new `request()` method (which reuses the live WS client).
 * Anything else (mock/deploy) rejects — plugins are a serve/desktop feature.
 */
import { getActiveTransport } from '../agents/active-transport'

export async function gatewayRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const { transport, mode } = await getActiveTransport()

  if (mode !== 'serve') {
    throw new Error(`Hermes gateway unavailable (transport mode: ${mode})`)
  }

  const serve = transport as unknown as { request?: (m: string, p: Record<string, unknown>) => Promise<T> }

  if (typeof serve.request !== 'function') {
    throw new Error('Hermes gateway unavailable (serve transport has no request door)')
  }

  return serve.request(method, params)
}

/** Sync label for the gateway state atom (no probe). */
export function describeGatewayMode(): string {
  try {
    const stored = window.localStorage.getItem('maia:hermesTransport')
    return stored ?? 'auto'
  } catch {
    return 'auto'
  }
}
