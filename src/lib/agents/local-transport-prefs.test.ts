import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocalPrefs, LOCAL_PREFS_KEY, updateLocalPrefs } from '../local-prefs'
import { HermesLocalTransport } from './hermes-local-transport'
import { bindLocalWorkspaceSession, configureLocalTransport, getTransportPrefs, setTransportPrefs } from './local-transport-prefs'
import { createConversation, getHydrateStatus, getState, resetStore, setState } from './store'

let transport: HermesLocalTransport
let socketId: string
let listeners: Set<(event: { id: string; type: string; data?: string }) => void>
let rpc = vi.fn(async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({}))
const binding = { profile: 'fixture', storedId: 'stored_fixture', runtimeId: 'runtime_fixture' }

function push(frame: unknown) {
  for (const listener of listeners) listener({ id: socketId, type: 'message', data: JSON.stringify(frame) })
}
function event(type: string, seq: number, payload: unknown = {}) {
  push({ jsonrpc: '2.0', method: 'event', params: { type, seq, session_id: binding.runtimeId, payload } })
}

beforeEach(() => {
  window.localStorage.clear()
  resetStore()
  updateLocalPrefs({ pinnedOrder: [], hiddenProfiles: [], showScratch: false, sessionSources: ['desktop'] })
  listeners = new Set()
  rpc = vi.fn(async (method: string) => {
    if (method === 'session.create' || method === 'session.resume') return {
      session_id: binding.runtimeId, stored_session_id: binding.storedId, info: { profile_name: binding.profile },
    }
    if (method === 'session.history') return { messages: [] }
    if (method === 'profiles.list') return { profiles: [
      { name: 'fixture', path: '/fake/fixture' }, { name: 'other', path: '/fake/other' },
      { name: 'session-scratch', path: '/fake/scratch' },
    ] }
    return { status: 'streaming' }
  })
  window.nubAgent = {
    serveConfig: async () => ({ present: true, baseUrl: 'http://127.0.0.1:19122' }),
    serveSocket: {
      onEvent: (callback: (event: { id: string; type: string; data?: string }) => void) => {
        listeners.add(callback); return () => listeners.delete(callback)
      },
      open: async ({ id }: { id: string }) => {
        socketId = id
        queueMicrotask(() => {
          for (const listener of listeners) listener({ id, type: 'open' })
        })
        return { ok: true }
      },
      send: async (_id: string, text: string) => {
        const frame = JSON.parse(text)
        if (frame.method) push({ jsonrpc: '2.0', id: frame.id, result: await rpc(frame.method, frame.params) })
        return { ok: true }
      },
      close: async () => ({ ok: true }),
    },
  } as unknown as NonNullable<Window['nubAgent']>
  vi.stubGlobal('WebSocket', vi.fn(() => { throw new Error('No renderer socket allowed') }))
  transport = new HermesLocalTransport()
})
afterEach(() => { transport.dispose(); vi.unstubAllGlobals(); delete window.nubAgent })

describe('single-store local transport adapter', () => {
  it('maps both directions without writing the obsolete transport prefs key', () => {
    updateLocalPrefs({ pinnedOrder: ['profile:fixture'], hiddenProfiles: ['other'], showScratch: true, sessionSources: ['desktop', 'cli'] })
    expect(getTransportPrefs()).toEqual({
      pinnedOrder: ['profile:fixture'], hidden: ['other'], showScratch: true, sources: ['desktop', 'cli'],
    })
    setTransportPrefs({ hidden: ['fixture'] })
    expect(getLocalPrefs()).toMatchObject({ hiddenProfiles: ['fixture'], pinnedOrder: ['profile:fixture'], sessionSources: ['desktop', 'cli'] })
    expect(window.localStorage.getItem(LOCAL_PREFS_KEY)).toBeTruthy()
    expect(window.localStorage.getItem('hermes-desk:localPrefs')).toBeNull()
  })

  it('uses the shared settings by default, even before shell configuration, including hide mutations', async () => {
    updateLocalPrefs({ hiddenProfiles: ['other'] })
    expect((await transport.listAgents()).map((a) => a.id)).toEqual(['profile:fixture'])
    await transport.removeAgent('profile:fixture')
    expect(getLocalPrefs().hiddenProfiles).toEqual(['other', 'fixture'])
    updateLocalPrefs({ hiddenProfiles: [], showScratch: true, pinnedOrder: ['profile:other'] })
    expect((await transport.listAgents()).map((a) => a.id)).toEqual(['profile:other', 'profile:fixture', 'profile:session-scratch'])
  })

  it('publishes stored/runtime ids and acknowledges only an actual message.start', async () => {
    await transport.listAgents()
    const conversation = createConversation({ type: 'agent', agentId: 'profile:fixture' })
    configureLocalTransport(transport)
    configureLocalTransport(transport) // Configuring twice must not duplicate events.
    await transport.sendMessage(conversation, 'Synthetic local message')
    const userId = getState().messagesByThreadId[conversation.id].find((m) => m.role === 'user')!.id
    expect(getHydrateStatus().localSessions[conversation.id].binding).toEqual(binding)
    expect(getHydrateStatus().localSessions[conversation.id].pickedUpMessageIds).toBeUndefined()
    event('status.update', 1, { text: 'Starting…' })
    expect(getHydrateStatus().localSessions[conversation.id].pickedUpMessageIds).toBeUndefined()
    event('message.start', 2)
    expect(getHydrateStatus().localSessions[conversation.id].pickedUpMessageIds).toEqual([userId])
    event('message.start', 2)
    expect(getHydrateStatus().localSessions[conversation.id].pickedUpMessageIds).toEqual([userId])
    const stored = getState().conversations.find((c) => c.id === conversation.id)!
    expect(await bindLocalWorkspaceSession(transport, stored)).toEqual(binding)
    expect(rpc.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1)
  })

  it('never creates a runtime session for an unsent draft or when offline', async () => {
    setState({ agents: [] })
    expect(await bindLocalWorkspaceSession(transport, {
      id: 'draft', target: { type: 'agent', agentId: 'profile:fixture' },
      title: '', preview: '', createdAt: '', lastUsedAt: '',
    })).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })
})
