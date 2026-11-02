/** Native rooms are authoritative across renderer origins. Web/test builds keep
 * their existing storage adapter. Migration imports only when no native
 * document exists, so returning to a stale origin cannot resurrect deletions. */
import type { AgentsState } from './store'
import type { LocalRoomState } from './local-rooms'

interface RoomJournalBridge {
  read(): { ok: boolean; revision?: number; value?: string | null }
  save(revision: number, value: string): { ok: boolean; revision?: number }
}
interface Snapshot {
  version: 1
  agents: AgentsState['agents']
  groups: AgentsState['groups']
  conversations: AgentsState['conversations']
  selectedConversationId: string | null
}
const empty = (): AgentsState => ({ agents: [], groups: [], conversations: [], messagesByThreadId: {},
  subagentsById: {}, turnsById: {}, selectedConversationId: null })
function bridge(): RoomJournalBridge | undefined {
  return typeof window === 'undefined' ? undefined :
    (window as unknown as { nubAgent?: { roomJournal?: RoomJournalBridge } }).nubAgent?.roomJournal
}
let owner: RoomJournalBridge | undefined
let revision: number | undefined
let writtenValue: string | null = null
let writtenRooms = new Map<string, LocalRoomState>()

function remember(conversations: AgentsState['conversations']) {
  writtenRooms = new Map(conversations.flatMap(c => c.localRoom ? [[c.id, c.localRoom]] : []))
}
function parse(raw: string): Snapshot {
  const snapshot = JSON.parse(raw) as Snapshot
  if (snapshot.version !== 1 || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.groups) ||
      !Array.isArray(snapshot.conversations) || snapshot.conversations.some(c => c.target?.type !== 'group' ||
        (c.localRoom && (c.localRoom.version !== 1 || !Array.isArray(c.localRoom.messages) ||
          !Array.isArray(c.localRoom.turns) || !c.localRoom.bindings || !c.localRoom.cursors ||
          !Array.isArray(c.localRoom.cancelledRoots))))) throw new Error('Invalid native room journal')
  return snapshot
}

export function restoreNativeRooms(local: AgentsState | null): AgentsState | null {
  owner = bridge()
  revision = undefined
  writtenValue = null
  writtenRooms.clear()
  if (!owner) return local
  try {
    const saved = owner.read()
    if (!saved.ok || !Number.isSafeInteger(saved.revision) || saved.revision! < 0) return local
    revision = saved.revision
    if (saved.value == null) {
      if (local?.groups.length) saveNativeRooms(local)
      return local
    }
    const snapshot = parse(saved.value)
    writtenValue = saved.value
    remember(snapshot.conversations)
    const base = local ?? empty()
    const conversations = [...base.conversations.filter(c => c.target.type !== 'group'), ...snapshot.conversations]
    const selected = snapshot.selectedConversationId ?? base.selectedConversationId
    return {
      ...base,
      agents: [...new Map([...base.agents, ...snapshot.agents].map(a => [a.id, a])).values()],
      groups: snapshot.groups,
      conversations,
      selectedConversationId: conversations.some(c => c.id === selected) ? selected : null,
    }
  } catch {
    // A bad read must never turn into an overwrite of the existing document.
    revision = undefined
    return local
  }
}

export function hasNativeRoomStorage(): boolean { return !!bridge() }

export function isNativeRoomPersisted(id: string, journal: LocalRoomState): boolean {
  return owner === bridge() && revision !== undefined && writtenRooms.get(id) === journal
}

export function saveNativeRooms(state: AgentsState): boolean {
  const native = bridge()
  if (!native) return false
  if (native !== owner || revision === undefined) return false
  const groups = state.groups.filter(g => g.memberAgentIds.every(id => id.startsWith('profile:')))
  const conversations = state.conversations.filter(c => c.target.type === 'group' &&
    groups.some(g => c.target.type === 'group' && g.id === c.target.groupId))
  // Don't seal an empty, never-migrated origin before an old origin can open.
  if (writtenValue === null && !groups.length && !conversations.length) return true
  const snapshot: Snapshot = { version: 1, agents: state.agents.filter(a => a.id.startsWith('profile:')),
    groups, conversations, selectedConversationId:
      conversations.some(c => c.id === state.selectedConversationId) ? state.selectedConversationId : null }
  try {
    const value = JSON.stringify(snapshot)
    if (value !== writtenValue) {
      const result = native.save(revision, value)
      if (!result.ok || result.revision !== revision + 1) return false
      revision = result.revision
      writtenValue = value
    }
    remember(conversations)
    return true
  } catch { return false }
}
