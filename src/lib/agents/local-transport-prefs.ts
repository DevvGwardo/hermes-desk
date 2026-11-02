import { getLocalPrefs, updateLocalPrefs } from '../local-prefs'
import type { Conversation } from './types'
import type { HermesLocalTransport } from './hermes-local-transport'

export interface LocalTransportPrefs {
  pinnedOrder?: readonly string[]
  hidden?: readonly string[]
  showScratch?: boolean
  sources?: readonly string[]
}


export function getTransportPrefs(): LocalTransportPrefs {
  const prefs = getLocalPrefs()
  return {
    pinnedOrder: prefs.pinnedOrder,
    hidden: prefs.hiddenProfiles,
    showScratch: prefs.showScratch,
    sources: prefs.sessionSources,
  }
}

export function setTransportPrefs(prefs: LocalTransportPrefs): void {
  updateLocalPrefs({
    ...(prefs.pinnedOrder !== undefined ? { pinnedOrder: [...prefs.pinnedOrder] } : {}),
    ...(prefs.hidden !== undefined ? { hiddenProfiles: [...prefs.hidden] } : {}),
    ...(prefs.showScratch !== undefined ? { showScratch: prefs.showScratch } : {}),
    ...(prefs.sources !== undefined ? { sessionSources: [...prefs.sources] } : {}),
  })
}

export const localTransportPrefs = { getPrefs: getTransportPrefs, setPrefs: setTransportPrefs }

export function configureLocalTransport(transport: HermesLocalTransport): void {
  transport.configurePrefs(localTransportPrefs)
}

export async function bindLocalWorkspaceSession(
  transport: HermesLocalTransport, conversation: Conversation,
): Promise<{ profile: string; storedId: string; runtimeId: string } | null> {
  return transport.bindWorkspaceSession(conversation)
}
