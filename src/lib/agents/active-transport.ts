/** Hermes Desk always talks to local serve, including while it is offline. */
import type { AgentTransport } from './transport'
import { HermesLocalTransport } from './hermes-local-transport'
import { setConversationSyncSink } from './store'
import type { HermesTransportMode } from './transport-routing'

export interface ActiveTransport {
  transport: AgentTransport
  mode: HermesTransportMode
  source: string
}

let active: ActiveTransport | null = null

export function resetActiveTransport(): void {
  if (active?.transport instanceof HermesLocalTransport) active.transport.dispose()
  active = null
  setConversationSyncSink(null)
}

export function getActiveTransport(): Promise<ActiveTransport> {
  active ??= { transport: new HermesLocalTransport(), mode: 'serve', source: 'local:hermes-serve' }
  return Promise.resolve(active)
}

export function describeActiveTransportSync(): { mode: HermesTransportMode; source: string } {
  return { mode: 'serve', source: 'local:hermes-serve' }
}

/** Compatibility for the old Settings caller. There is no transport override. */
export function setStoredTransportMode(_mode: HermesTransportMode): void {
  resetActiveTransport()
}
