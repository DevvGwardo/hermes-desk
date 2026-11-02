import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import streamFixture from '../../../tests/fixtures/serve-ws-synthetic/stream.jsonl?raw'
import requestFixture from '../../../tests/fixtures/serve-ws-synthetic/requests.jsonl?raw'
import replayFixture from '../../../tests/fixtures/serve-ws-synthetic/replay.jsonl?raw'
import { HermesLocalTransport, localHistoryMessages, type LocalTransportEvent, type LocalTransportPrefs } from './hermes-local-transport'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageBody } from '../../components/MessageBody'
import { createConversation, deleteConversation, flushMessagePatches, getHydrateStatus, getMessagesForConversation, getState, getStructuralState, hideConversation, patchMessage, resetStore, selectConversation, setHistoryPaging, setState, subscribe } from './store'
import { answerAgentPrompt, getAgentPrompts } from './agent-prompts'
import { getPendingToolPermission, setPendingToolPermission } from './tool-permission'
import { loadPersistedState } from './persist'
import type { HermesProfile } from './hermes-profiles'
import type { Conversation } from './types'
import { isDeletedConversation, resetDeletedTombstonesForTest } from './tombstones'
import { getRoomView, resetLearnedRoomNames, resetRoomViews, roomHandoffStrips, roomMemberName } from './rooms'

interface Frame {
  id?: string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}

const profiles: HermesProfile[] = [
  { name: 'default', path: '/fake/default', last_session: { id: 'd1', last_active: 3 } },
  { name: 'runner', path: '/fake/runner', ui_meta: { display_name: 'The Runner' }, soul: 'Reads local fixtures.\nMore details.', last_session: { id: 'r1', last_active: 9 } },
  { name: 'backend-eng', path: '/fake/backend', last_session: { id: 'b1', last_active: 7 } },
  { name: 'session-scratch', path: '/fake/scratch', last_session: { id: 's1', last_active: 99 } },
]
const lines = (raw: string) => raw.trim().split('\n').map((line) => JSON.parse(line))
let transport: HermesLocalTransport
let prefs: LocalTransportPrefs
let calls: Frame[]
let responses: Frame[]
let fetchMock: ReturnType<typeof vi.fn>
let connected: boolean
let bridgeEpoch: string
let rpc: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>
let sockets: string[]
let listeners: Set<(event: { id: string; type: string; data?: string }) => void>

it('inspects the native bound profile session without submitting a prompt or mutating its chat', async () => {
  const previous = rpc
  rpc = (method, params) => method === 'session.context_breakdown' ? {
    context_used: 800, context_max: 32000, context_estimated: true, context_source: 'local_estimate',
    categories: [{ id: 'memory', label: 'Memory', tokens: 30 }], context_files: [],
  } : previous(method, params)
  const conversation = (await transport.listConversations()).find(row => row.agentId === 'profile:runner')!
  const before = getMessagesForConversation(conversation.id)
  const data = await transport.inspectSessionContext(conversation.id)
  expect(data.used).toBe(800)
  expect(calls.find(call => call.method === 'session.context_breakdown')?.params)
    .toEqual({ session_id: 'runtime-runner', profile: 'runner' })
  expect(calls.some(call => call.method === 'prompt.submit')).toBe(false)
  expect(getMessagesForConversation(conversation.id)).toEqual(before)
  const fresh = createConversation({ type: 'agent', agentId: 'profile:runner' })
  await expect(transport.inspectSessionContext(fresh.id)).rejects.toThrow(/Send a message/)
  const room = createConversation({ type: 'group', groupId: 'fixture-room' })
  await expect(transport.inspectSessionContext(room.id)).rejects.toThrow(/individual/)
})

it('uses native owned delegation snapshots and controls without global status or optimistic cancellation', async () => {
  const previous = rpc
  let found = false
  rpc = (method, params) => {
    if (method === 'subagent.list') return { subagents: [{ subagent_id: 'native-child', goal: 'Local child', status: 'running' }], delegations: [] }
    if (method === 'subagent.tail') return { available: true, text: 'Fixture transcript', truncated: false }
    if (method === 'subagent.interrupt') return { found, subagent_id: params.subagent_id }
    if (method === 'subagent.steer') return { status: 'rejected' }
    return previous(method, params)
  }
  const conversation = (await transport.listConversations()).find(row => row.agentId === 'profile:runner')!
  const data = await transport.inspectDelegates(conversation.id)
  expect(data.subagents[0]!.subagent_id).toBe('native-child')
  expect(await transport.inspectDelegateTail(conversation.id, 'native-child', data.generation)).toEqual({
    available: true, text: 'Fixture transcript', truncated: false,
  })
  expect(await transport.steerDelegate(conversation.id, 'native-child', '   Local steer   ', data.generation)).toBe(false)
  expect(await transport.interruptDelegate(conversation.id, 'native-child', data.generation)).toBe(false)
  found = true
  expect(await transport.interruptDelegate(conversation.id, 'native-child', data.generation)).toBe(true)
  for (const call of calls.filter(call => call.method?.startsWith('subagent.'))) {
    expect(call.params).toMatchObject({ session_id: 'runtime-runner', profile: 'runner' })
  }
  expect(calls.some(call => call.method === 'delegation.status' || call.method === 'prompt.submit')).toBe(false)
  await expect(transport.interruptDelegate(conversation.id, 'native-child', 'retired-generation')).rejects.toThrow(/current connection/)
})

it('does not revive a completed native child or mark it cancelled when an interrupt fails', async () => {
  const previous = rpc
  rpc = (method, params) => method === 'subagent.interrupt' ? { found: false }
    : method === 'subagent.steer' ? { status: 'rejected' } : previous(method, params)
  const conversation = (await transport.listConversations()).find(row => row.agentId === 'profile:runner')!
  await transport.getMessages(conversation.id)
  setState({ subagentsById: { fixture: { id: 'fixture', conversationId: conversation.id, parentAgentId: 'profile:runner',
    kind: 'explore', title: 'Fixture', status: 'completed', createdAt: '2026-10-11', digests: [],
    source: 'delegate_task', hermesSubagentId: 'native-child' } } })
  expect(await transport.cancelSubagent('fixture')).toBe(false)
  expect(await transport.messageSubagent('fixture', 'Do not revive')).toBe(false)
  expect(getState().subagentsById.fixture.status).toBe('completed')
  expect(calls.some(call => call.method === 'prompt.submit')).toBe(false)
})

it('rejects a retired delegation inspector generation after backend replacement even if the runtime id repeats', async () => {
  const previous = rpc
  rpc = (method, params) => method === 'subagent.list' ? { subagents: [], delegations: [] } : previous(method, params)
  const conversation = (await transport.listConversations()).find(row => row.agentId === 'profile:runner')!
  const old = await transport.inspectDelegates(conversation.id)
  event('gateway.ready', { replay_epoch: 'replacement-epoch', skin: {} })
  await Promise.resolve()
  const current = await transport.inspectDelegates(conversation.id)
  expect(current.generation).not.toBe(old.generation)
  const before = calls.filter(call => call.method === 'subagent.interrupt').length
  await expect(transport.interruptDelegate(conversation.id, 'old-child', old.generation)).rejects.toThrow(/current connection/)
  expect(calls.filter(call => call.method === 'subagent.interrupt')).toHaveLength(before)
})

function push(frame: unknown, id = sockets.at(-1)!): void {
  for (const callback of listeners) callback({ id, type: 'message', data: JSON.stringify(frame) })
}

function event(type: string, payload: unknown, seq?: number): void {
  push({ jsonrpc: '2.0', method: 'event', params: { type, payload, session_id: 'runtime-runner', ...(seq ? { seq } : {}) } })
}

function closeSocket(): void {
  for (const callback of [...listeners]) callback({ id: sockets.at(-1)!, type: 'close' })
}

function bridge(): void {
  ;(window as unknown as { nubAgent: unknown }).nubAgent = {
    serveConfig: vi.fn(async () => ({ present: true, baseUrl: 'http://127.0.0.1:19120' })),
    serveSocket: {
      onEvent(callback: (event: { id: string; type: string; data?: string }) => void) {
        listeners.add(callback)
        return () => listeners.delete(callback)
      },
      open: vi.fn(async ({ id }: { id: string }) => {
        sockets.push(id)
        if (!connected) return { ok: false }
        queueMicrotask(() => {
          for (const callback of listeners) callback({ id, type: 'open' })
          push({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: bridgeEpoch, skin: {}, change_events: true } } }, id)
        })
        return { ok: true }
      }),
      send: vi.fn(async (id: string, text: string) => {
        const frame: Frame = JSON.parse(text)
        if (!frame.method) { responses.push(frame); return { ok: true } }
        calls.push(frame)
        try {
          const result = await rpc(frame.method, frame.params ?? {})
          push({ jsonrpc: '2.0', id: frame.id, result }, id)
        } catch (error) {
          const err = error as { code?: number; message: string }
          push({ jsonrpc: '2.0', id: frame.id, error: { code: err.code ?? -32601, message: err.message } }, id)
        }
        return { ok: true }
      }),
      close: vi.fn(async () => ({ ok: true })),
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  resetDeletedTombstonesForTest()
  resetStore()
  resetRoomViews()
  prefs = {}
  calls = []
  responses = []
  listeners = new Set()
  sockets = []
  connected = true
  bridgeEpoch = 'fake-epoch-1'
  rpc = (method, params) => {
    if (method === 'profiles.list') return { profiles }
    if (method === 'session.list') return { sessions: [
      { id: `stored-${params.profile}`, title: `${params.profile} chat`, source: 'desktop', started_at: 6 },
      { id: `cli-${params.profile}`, title: 'CLI chat', source: 'cli', started_at: 5 },
      { id: `cron-${params.profile}`, title: 'Cron chat', source: 'cron', started_at: 4 },
    ] }
    if (method === 'session.create' || method === 'session.resume') return {
      session_id: `runtime-${params.profile}`, stored_session_id: `stored-${params.profile}`, info: { profile_name: params.profile },
    }
    if (method === 'session.history') return { count: 2, messages: [
      { role: 'user', text: 'Hello', row_id: 1, timestamp: 1 },
      { role: 'assistant', text: 'Hi', row_id: 2, timestamp: 2, reasoning: 'Synthetic reasoning' },
    ] }
    if (method === 'session.events.since') return { events: [], latest_seq: 0, truncated: false, epoch: 'fake-epoch-1', open_requests: [] }
    if (method === 'skills.manage') return { skills: { coding: ['read-notes'], local: ['fixture-tool'] } }
    if (method === 'session.interrupt') return { status: 'interrupted' }
    if (method === 'session.steer') return { status: 'queued' }
    if (method === 'profiles.create') return { name: params.name, path: `/fake/${params.name}`, ok: true }
    return { status: 'streaming', ok: true }
  }
  bridge()
  fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/api/profiles') ? { profiles } : { ok: true },
  ), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  // Session edits first read Hermes's revision fence; tests assert on the edit itself.
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => String(url).includes('/mutation-snapshot')
    ? Promise.resolve(new Response(JSON.stringify({ exists: true, runtime_revision: 1, runtime_generation: 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }))
    : (fetchMock as unknown as typeof fetch)(url, init))
  vi.stubGlobal('WebSocket', vi.fn(() => { throw new Error('Renderer must use main relay') }))
  transport = new HermesLocalTransport({ getPrefs: () => prefs, setPrefs: (value) => { prefs = value } })
  setPendingToolPermission(null)
})

afterEach(() => {
  transport.dispose()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
})

it('prepends older history without replacing an active streaming reply', async () => {
  const previous = rpc
  rpc = (method, params) => method === 'session.history'
    ? { messages: Array.from({ length: 120 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `Row ${index}`, row_id: index + 1 })) }
    : previous(method, params)
  const target = (await transport.listConversations()).find((row) => row.agentId === 'profile:runner')!
  expect(await transport.getMessages(target.id)).toHaveLength(50)
  await transport.sendMessage(target, 'A synthetic live turn')
  event('message.delta', { text: 'Still streaming' })
  const active = getMessagesForConversation(target.id).at(-1)!
  expect(await transport.loadOlderMessages(target.id)).toBe(true)
  const messages = getMessagesForConversation(target.id)
  expect(messages).toHaveLength(102)
  expect(messages.at(-1)).toMatchObject({ id: active.id, content: 'Still streaming', streaming: true })
})

async function conversation() {
  await transport.listAgents()
  return createConversation({ type: 'agent', agentId: 'profile:runner' })
}

it('opts new and restored chats into the owning CLI profile route without supplying a model', async () => {
  const fresh = await conversation()
  await transport.sendMessage(fresh, 'Synthetic request')
  const create = calls.find(call => call.method === 'session.create')!
  expect(create.params).toMatchObject({ profile: 'runner', follow_profile_config: true })
  expect(create.params).not.toHaveProperty('model')
  const restored = (await transport.listConversations()).find(row => row.hermesSessionId === 'stored-backend-eng')!
  await transport.getMessages(restored.id)
  const resume = calls.find(call => call.method === 'session.resume')!
  expect(resume.params).toMatchObject({
    profile: 'backend-eng', session_id: 'stored-backend-eng',
  })
  // The backend refuses unknown resume params as "out of sync", so it must not be sent.
  expect(resume.params).not.toHaveProperty('follow_profile_config')
  expect(resume.params).not.toHaveProperty('provider')
})

it('reports the bound chat route, updates from session info, and does not rewrite the agent default', async () => {
  const previous = rpc
  rpc = (method, params) => method === 'session.create'
    ? { session_id: 'runtime-runner', stored_session_id: 'stored-runner',
      info: { profile_name: 'runner', model: 'initial-model', provider: 'nous' } }
    : previous(method, params)
  const target = await conversation()
  await transport.sendMessage(target, 'Synthetic route check')
  expect(getHydrateStatus().localSessions[target.id]?.modelRoute).toEqual({ model: 'initial-model', provider: 'nous' })
  event('session.info', { model: 'new-model', provider: 'openrouter', api_key: 'not-a-real-key' })
  expect(getHydrateStatus().localSessions[target.id]?.modelRoute).toEqual({ model: 'new-model', provider: 'openrouter' })
  expect(getState().agents.find(a => a.id === 'profile:runner')).not.toHaveProperty('model', 'new-model')
  event('session.info', { model: 'wrong-profile', provider: 'nous', profile_name: 'backend-eng' })
  expect(getHydrateStatus().localSessions[target.id]?.modelRoute?.model).toBe('new-model')
  push({ jsonrpc: '2.0', method: 'event', params: { type: 'session.info', session_id: 'retired-runtime',
    payload: { model: 'retired-model', provider: 'nous' } } })
  expect(getHydrateStatus().localSessions[target.id]?.modelRoute?.model).toBe('new-model')
  event('session.info', { approval_mode: 'manual' })
  expect(getHydrateStatus().localSessions[target.id]?.modelRoute?.model).toBe('new-model')
  event('session.info', { model: 'provider-not-reported' })
  expect(getHydrateStatus().localSessions[target.id]?.modelRoute).toEqual({ model: 'provider-not-reported', provider: undefined })
})

it('retains local group conversations through online and offline roster refresh', async () => {
  await transport.listAgents()
  const group = await transport.createGroup({ name: 'Fixture team', memberAgentIds: ['profile:runner', 'profile:backend-eng'] })
  const room = createConversation({ type: 'group', groupId: group.id }, group.name)
  expect((await transport.listConversations()).some(row => row.id === room.id)).toBe(true)
  const previous = rpc
  rpc = (method, params) => {
    if (method === 'session.list') throw new Error('Fixture disconnected')
    return previous(method, params)
  }
  expect((await transport.listConversations()).some(row => row.id === room.id)).toBe(true)
})

it('edits local room metadata and follows the room name without overwriting a custom chat title', async () => {
  await transport.listAgents()
  const group = await transport.createGroup({ name: 'Old room', memberAgentIds: ['profile:runner'] })
  const linked = createConversation({ type: 'group', groupId: group.id }, group.name)
  const custom = createConversation({ type: 'group', groupId: group.id }, 'Specific investigation')
  await transport.updateGroup(group.id, { name: 'New room', summary: 'Check the release' })
  expect(getState().groups.find(g => g.id === group.id)).toMatchObject({ name: 'New room', summary: 'Check the release' })
  expect(getState().conversations.find(c => c.id === linked.id)?.title).toBe('New room')
  expect(getState().conversations.find(c => c.id === custom.id)?.title).toBe('Specific investigation')
})

it('auto-names a blank room from members, follows membership changes, and preserves an explicit name', async () => {
  await transport.listAgents()
  const group = await transport.createGroup({ name: '  ', memberAgentIds: ['profile:runner', 'profile:backend-eng'] })
  expect(group.name).toBe('The Runner and Backend Eng')
  expect(group.autoNamed).toBe(true)
  const room = createConversation({ type: 'group', groupId: group.id }, group.name)
  await transport.setGroupMembers(group.id, ['profile:runner'])
  expect(getState().conversations.find(c => c.id === room.id)?.title).toBe('The Runner')
  await transport.updateGroup(group.id, { name: 'Release team' })
  await transport.setGroupMembers(group.id, ['profile:runner', 'profile:backend-eng'])
  expect(getState().groups.find(g => g.id === group.id)?.name).toBe('Release team')
  expect(getState().conversations.find(c => c.id === room.id)?.title).toBe('Release team')
  await transport.updateGroup(group.id, { name: ' ' })
  expect(getState().groups.find(g => g.id === group.id)).toMatchObject({ name: 'The Runner and Backend Eng', autoNamed: true })
  await transport.setGroupMembers(group.id, ['profile:runner'])
  expect(getState().conversations.find(c => c.id === room.id)?.title).toBe('The Runner')
})

describe('GENUI buffered room recovery through the real adapter and native relay', () => {
  const spec = { version: 1, components: [{ type: 'stat', title: 'Own data', value: '12' }] }
  const occurrence = '44444444-4444-4444-8444-444444444444'
  const successful = { type: 'tool.complete', session_id: 'runtime-runner', seq: 1,
    payload: { name: 'render_ui', tool_id: 'own', result: { genui: spec, genuiOccurrence: occurrence } } }
  const terminal = { type: 'message.complete', session_id: 'runtime-runner', seq: 5002, payload: { text: 'Done' } }
  const emit = (params: unknown) => push({ jsonrpc: '2.0', method: 'event', params })
  const journal = (id: string) => getState().conversations.find(c => c.id === id)!.localRoom!
  const widgets = (id: string) => journal(id).messages.filter(m => m.speakerKind === 'agent').flatMap(m => m.toolEvents ?? [])
  const microtasks = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
  async function running() {
    await transport.listAgents()
    const group = await transport.createGroup({ name: 'Buffered GENUI fixture', memberAgentIds: ['profile:runner'] })
    const room = createConversation({ type: 'group', groupId: group.id }, group.name)
    await transport.sendMessage(room, '@The Runner own data')
    await microtasks()
    expect(journal(room.id).turns[0].status).toBe('running')
    return room
  }
  async function heldReplay() {
    const previous = rpc
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void
    rpc = (method, params) => method === 'session.events.since' && params.session_id === 'runtime-runner'
      ? new Promise((yes, no) => { resolve = yes; reject = no }) : previous(method, params)
    await vi.advanceTimersByTimeAsync(30_000)
    await microtasks()
    expect(resolve).toBeDefined()
    return { resolve, reject }
  }
  function retained(id: string) {
    expect(widgets(id)).toEqual([expect.objectContaining({ toolCallId: 'own', genui: spec, genuiOccurrence: occurrence })])
    expect(journal(id).messages.filter(m => m.speakerKind === 'agent')).toHaveLength(1)
    expect(journal(id).messages.at(-1)?.text).toBe('Done')
    expect(getMessagesForConversation(id).filter(m => m.role === 'agent').flatMap(m => m.toolEvents ?? []).filter(e => e.genui))
      .toEqual([expect.objectContaining({ genuiOccurrence: occurrence })])
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  }

  it.each(['truncated', 'overlap', 'out-of-order', 'rpc-error', 'no-change', 'malformed-cache', 'earlier-terminal'])('preserves owning buffered data before terminal settlement: %s', async mode => {
    const room = await running(), held = await heldReplay()
    emit(mode === 'earlier-terminal' ? { ...successful, seq: 3 } : successful)
    emit(terminal)
    if (mode === 'rpc-error') held.reject(new Error('Synthetic replay read failure'))
    else held.resolve({ events: mode === 'overlap' ? [terminal, successful, terminal]
      : mode === 'out-of-order' ? [terminal, { ...successful, seq: 2 }]
      : mode === 'no-change' ? [] : mode === 'malformed-cache' ? [null, { session_id: 'foreign' }, terminal]
      : mode === 'earlier-terminal' ? [{ ...terminal, seq: 2 }, terminal] : [terminal],
      latest_seq: 5002, truncated: mode === 'truncated', epoch: 'fake-epoch-1', open_requests: [] })
    await microtasks()
    retained(room.id)
  })

  it('does not drain old buffered data or contaminate a replacement epoch watermark', async () => {
    const room = await running(), held = await heldReplay()
    emit(successful)
    emit(terminal)
    event('gateway.ready', { replay_epoch: 'fake-epoch-2', skin: {}, change_events: true })
    held.resolve({ events: [], latest_seq: 0, truncated: false, epoch: 'fake-epoch-1', open_requests: [] })
    await microtasks()
    expect(widgets(room.id)).toEqual([])
    expect(journal(room.id).messages.filter(m => m.speakerKind === 'agent')).toEqual([])
    expect(journal(room.id).bindings['profile:runner']).toMatchObject({ epoch: 'fake-epoch-2', lastSeen: 0 })
    expect(journal(room.id).turns[0].status).toBe('running')
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })

  it('keeps replacement-epoch live data while discarding the old replay finally buffer', async () => {
    const room = await running(), held = await heldReplay()
    emit(successful)
    emit(terminal)
    const retiredRpc = rpc
    // Hold only the already-issued retired replay. Replacement recovery now
    // makes its own RPC, which must receive this backend's current epoch.
    rpc = (method, params) => method === 'session.events.since'
      ? { events: [], latest_seq: 0, epoch: 'fake-epoch-2', open_requests: [] }
      : method === 'session.active_list' ? { sessions: [{ id: 'runtime-runner', status: 'working' }] }
        : retiredRpc(method, params)
    event('gateway.ready', { replay_epoch: 'fake-epoch-2', skin: {}, change_events: true })
    const fresh = '55555555-5555-4555-8555-555555555555'
    emit({ ...successful, payload: { ...successful.payload, result: { genui: spec, genuiOccurrence: fresh } } })
    await microtasks()
    expect(calls.filter(call => call.method === 'session.events.since')).toHaveLength(2)
    expect(journal(room.id).bindings['profile:runner']).toMatchObject({ epoch: 'fake-epoch-2', lastSeen: 1 })
    expect(journal(room.id).turns[0].toolEvents?.[0].genuiOccurrence).toBe(fresh)
    held.resolve({ events: [terminal], latest_seq: 5002, epoch: 'fake-epoch-1', open_requests: [] })
    await microtasks()
    expect(journal(room.id).bindings['profile:runner']).toMatchObject({ epoch: 'fake-epoch-2', lastSeen: 1 })
    expect(journal(room.id).turns[0].toolEvents?.[0].genuiOccurrence).toBe(fresh)
    expect(widgets(room.id)).toEqual([])
    emit({ ...terminal, seq: 2 })
    await microtasks()
    expect(widgets(room.id).map(event => event.genuiOccurrence)).toEqual([fresh])
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })

  it('retains critical owning data through a bounded progress flood and ignores foreign/old sequences', async () => {
    const room = await running(), held = await heldReplay()
    emit({ ...successful, seq: 0, payload: { ...successful.payload, tool_id: 'old' } })
    emit({ ...successful, session_id: 'foreign', payload: { ...successful.payload, tool_id: 'foreign' } })
    emit(successful)
    for (let seq = 2; seq < 5002; seq++) emit({ type: 'message.delta', session_id: 'runtime-runner', seq, payload: { text: '.' } })
    emit(terminal)
    held.resolve({ events: [terminal, terminal], latest_seq: 5002, epoch: 'fake-epoch-1', truncated: true, open_requests: [] })
    await microtasks()
    retained(room.id)
  })

  it('a buffered failed replacement still invalidates the earlier successful widget', async () => {
    const room = await running(), held = await heldReplay()
    emit(successful)
    emit({ ...successful, seq: 2, payload: { ...successful.payload, result: { ...successful.payload.result, isError: true } } })
    emit(terminal)
    held.resolve({ events: [terminal], latest_seq: 5002, epoch: 'fake-epoch-1', truncated: true, open_requests: [] })
    await microtasks()
    expect(widgets(room.id)).toEqual([])
    expect(journal(room.id).messages.at(-1)?.text).toBe('Done')
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })

  it('keeps a new owning question through a no-change replay snapshot and current buffered data', async () => {
    const room = await running(), held = await heldReplay()
    emit(successful)
    push({ jsonrpc: '2.0', id: 'live-own-question', method: 'approval',
      params: { session_id: 'runtime-runner', choices: ['once', 'deny'] } })
    held.resolve({ events: [], latest_seq: 0, epoch: 'fake-epoch-1', open_requests: [] })
    await microtasks()
    expect(getPendingToolPermission(room.id)?.id).toBe('live-own-question')
    expect(journal(room.id).turns[0].toolEvents?.[0].genuiOccurrence).toBe(occurrence)
    expect(widgets(room.id)).toEqual([])
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })
  it.each(['stop', 'delete', 'member-removed', 'dispose'])('fences an owning buffered completion after %s', async change => {
    const room = await running(), held = await heldReplay()
    emit(successful)
    emit(terminal)
    if (change === 'stop') await transport.stopTurn(room.id)
    else if (change === 'delete') deleteConversation(room.id)
    else if (change === 'member-removed' && room.target.type === 'group') await transport.setGroupMembers(room.target.groupId, [])
    else transport.dispose()
    const before = JSON.stringify(getState().conversations.find(c => c.id === room.id)?.localRoom)
    held.resolve({ events: [terminal], latest_seq: 5002, truncated: true, epoch: 'fake-epoch-1', open_requests: [] })
    await microtasks()
    expect(JSON.stringify(getState().conversations.find(c => c.id === room.id)?.localRoom)).toBe(before)
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })

  it('drains a current buffer arriving during active-list await before declaring completion lost', async () => {
    const room = await running()
    const previous = rpc
    let finish!: (value: unknown) => void
    rpc = (method, params) => method === 'session.active_list'
      ? new Promise(resolve => { finish = resolve }) : previous(method, params)
    await vi.advanceTimersByTimeAsync(30_000)
    await microtasks()
    expect(finish).toBeDefined()
    emit(successful)
    emit(terminal)
    finish({ sessions: [{ id: 'runtime-runner', status: 'idle' }] })
    await microtasks()
    retained(room.id)
  })
})

describe('GENUI outer reconnect export lifetime through the real adapter', () => {
  const spec = { version: 1, components: [{ type: 'stat', title: 'Owning data', value: '12' }] }
  const oldOccurrence = '66666666-6666-4666-8666-666666666666'
  const freshOccurrence = '77777777-7777-4777-8777-777777777777'
  const microtasks = async () => { for (let i = 0; i < 150; i++) await Promise.resolve() }
  const emit = (session: string, type: string, seq: number, payload: unknown) =>
    push({ jsonrpc: '2.0', method: 'event', params: { session_id: session, type, seq, payload } })
  const journal = (id: string) => getState().conversations.find(c => c.id === id)!.localRoom!
  const widgets = (id: string) => getMessagesForConversation(id).flatMap(m => m.toolEvents ?? []).filter(e => e.genui)
  const raw = () => new Response(JSON.stringify({ messages: [
    { role: 'user', row_id: 1, text: 'Owning export fixture' },
    { role: 'assistant', row_id: 2, tool_calls: [{ id: 'old-own', function: { name: 'render_ui' } }] },
    { role: 'tool', row_id: 3, tool_call_id: 'old-own', content: JSON.stringify({ genui: spec, genuiOccurrence: oldOccurrence }) },
  ] }), { status: 200 })
  async function heldExport(withRoom = false) {
    let room: Conversation | undefined
    if (withRoom) {
      await transport.listAgents()
      const group = await transport.createGroup({ name: 'Outer replay fixture', memberAgentIds: ['profile:runner'] })
      room = createConversation({ type: 'group', groupId: group.id }, group.name)
      await transport.sendMessage(room, '@The Runner original room submission')
    }
    const dm = (await transport.listConversations()).find(c => c.agentId === (withRoom ? 'profile:backend-eng' : 'profile:runner'))!
    await transport.sendMessage(dm, 'Owning export fixture')
    const session = withRoom ? 'runtime-backend-eng' : 'runtime-runner'
    const previous = rpc
    let release!: (value: Response) => void
    rpc = (method, params) => method === 'session.events.since' && params.session_id === session
      ? { events: [], latest_seq: 7000, truncated: true, epoch: 'fake-epoch-1', open_requests: [] }
      : method === 'session.events.since' ? { events: [], latest_seq: 0, epoch: bridgeEpoch, open_requests: [] }
      : method === 'session.active_list' ? { sessions: [{ id: 'runtime-runner', status: 'working' }] }
      : method === 'session.history' && params.session_id === session
        ? { messages: [{ role: 'user', row_id: 1, text: 'Owning export fixture' },
          { role: 'tool', row_id: 3, name: 'render_ui', tool_call_id: 'old-own' }] } : previous(method, params)
    fetchMock.mockImplementation(async (url: string) => url.includes('/export?')
      ? new Promise<Response>(resolve => { release = resolve })
      : new Response(JSON.stringify({ ok: true }), { status: 200 }))
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    await microtasks()
    expect(release).toBeDefined()
    return { dm, room, session, release }
  }

  it.each(['dm', 'room', 'repeat-close'])('excludes an old export and buffered output across replacement epochs: %s', async mode => {
    const f = await heldExport(mode !== 'dm')
    const session = f.room ? 'runtime-runner' : f.session
    emit(session, 'tool.complete', 1, { name: 'render_ui', tool_id: 'old-own', result: { genui: spec, genuiOccurrence: oldOccurrence } })
    emit(session, 'message.complete', 5002, { text: 'STALE final answer' })
    const previous = rpc
    let finishNew!: (value: unknown) => void
    rpc = (method, params) => method === 'session.events.since' && params.session_id === f.session
      ? new Promise(resolve => { finishNew = resolve }) : previous(method, params)
    bridgeEpoch = 'fake-epoch-2'
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000); await microtasks()
    expect(finishNew).toBeDefined() // Replacement must not coalesce behind the export.
    if (mode === 'repeat-close') {
      bridgeEpoch = 'fake-epoch-3'; finishNew = undefined!
      closeSocket(); await vi.advanceTimersByTimeAsync(1000); await microtasks()
      expect(finishNew).toBeDefined()
    }
    emit(session, 'tool.complete', 1, { name: 'render_ui', tool_id: 'fresh-own', result: { genui: spec, genuiOccurrence: freshOccurrence } })
    emit(session, 'message.complete', 2, { text: 'Fresh final answer' })
    f.release(raw()); await microtasks()
    expect(widgets(f.room?.id ?? f.dm.id)).toEqual([])
    if (f.room) expect(journal(f.room.id).bindings['profile:runner']).toMatchObject({ epoch: bridgeEpoch, lastSeen: 0 })
    finishNew({ events: [], latest_seq: 0, truncated: false, epoch: bridgeEpoch, open_requests: [] }); await microtasks()
    expect(widgets(f.room?.id ?? f.dm.id).map(e => e.genuiOccurrence)).toEqual([freshOccurrence])
    expect(getMessagesForConversation(f.room?.id ?? f.dm.id).some(m => m.content === 'Fresh final answer')).toBe(true)
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(f.room ? 2 : 1)
  })

  it.each(['stop', 'delete', 'rebound', 'dispose'])('fences DM history and buffered successful output after %s', async change => {
    const f = await heldExport()
    emit(f.session, 'tool.complete', 1, { name: 'render_ui', tool_id: 'old-own', result: { genui: spec, genuiOccurrence: oldOccurrence } })
    emit(f.session, 'message.complete', 5002, { text: 'STALE final answer' })
    if (change === 'stop') await transport.stopTurn(f.dm.id)
    if (change === 'delete') deleteConversation(f.dm.id)
    if (change === 'rebound') setState(state => ({ conversations: state.conversations.map(c => c.id === f.dm.id ? { ...c, hermesSessionId: 'replacement-stored' } : c) }))
    if (change === 'dispose') transport.dispose()
    const before = JSON.stringify(getMessagesForConversation(f.dm.id))
    f.release(raw()); await microtasks()
    expect(JSON.stringify(getMessagesForConversation(f.dm.id))).toBe(before)
    expect(widgets(f.dm.id)).toEqual([])
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })

  it('drains a genuinely current owning buffer after replay RPC failure, in order and once', async () => {
    const dm = (await transport.listConversations()).find(c => c.agentId === 'profile:runner')!
    await transport.sendMessage(dm, 'Original submission')
    const previous = rpc
    let fail!: (error: Error) => void
    rpc = (method, params) => method === 'session.events.since' ? new Promise((_yes, no) => { fail = no }) : previous(method, params)
    closeSocket(); await vi.advanceTimersByTimeAsync(1000); await microtasks()
    emit('runtime-runner', 'message.complete', 3, { text: 'Current final answer' })
    emit('runtime-runner', 'tool.complete', 2, { name: 'render_ui', tool_id: 'own', result: { genui: spec, genuiOccurrence: freshOccurrence } })
    emit('runtime-runner', 'tool.complete', 2, { name: 'render_ui', tool_id: 'own', result: { genui: spec, genuiOccurrence: freshOccurrence } })
    fail(new Error('Synthetic replay error')); await microtasks()
    expect(widgets(dm.id).map(e => e.genuiOccurrence)).toEqual([freshOccurrence])
    expect(getMessagesForConversation(dm.id).some(m => m.content === 'Current final answer')).toBe(true)
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })

  it.each(['success', 'export-error'])('keeps the current same-epoch room buffer and durable DM data: %s', async outcome => {
    const f = await heldExport(true)
    emit('runtime-runner', 'tool.complete', 1, { name: 'render_ui', tool_id: 'own', result: { genui: spec, genuiOccurrence: oldOccurrence } })
    emit('runtime-runner', 'message.complete', 5002, { text: 'Current final answer' })
    f.release(outcome === 'success' ? raw() : new Response('{}', { status: 500 }))
    await microtasks()
    expect(widgets(f.room!.id).map(e => e.genuiOccurrence)).toEqual([oldOccurrence])
    if (outcome === 'success') expect(widgets(f.dm.id).map(e => e.genuiOccurrence)).toEqual([oldOccurrence])
    expect(journal(f.room!.id).bindings['profile:runner'].lastSeen).toBe(5002)
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(2)
  })

  it('does not let a retired export failure clear the replacement history paging state', async () => {
    const f = await heldExport()
    const older = transport.loadOlderMessages(f.dm.id)
    await microtasks()
    bridgeEpoch = 'fake-epoch-2'
    closeSocket(); await vi.advanceTimersByTimeAsync(1000); await microtasks()
    setHistoryPaging(f.dm.id, { hasMore: false, loadingOlder: true })
    f.release(raw())
    expect(await older).toBe(false)
    expect(getHydrateStatus().historyPaging[f.dm.id]).toMatchObject({ hasMore: false, loadingOlder: true })
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })

  it('keeps cancellation of the still-identical owning question even when Stop retires successful data', async () => {
    const f = await heldExport()
    push({ jsonrpc: '2.0', id: 'own-stop-question', method: 'approval',
      params: { session_id: f.session, choices: ['once', 'deny'] } })
    expect(getPendingToolPermission(f.dm.id)?.id).toBe('own-stop-question')
    emit(f.session, 'request.cancel', 2, { id: 'own-stop-question' })
    await transport.stopTurn(f.dm.id)
    f.release(raw()); await microtasks()
    expect(getPendingToolPermission(f.dm.id)).toBeNull()
    expect(widgets(f.dm.id)).toEqual([])
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })

  it('advances the authoritative snapshot cursor after its own terminal without admitting an older live tail', async () => {
    const dm = (await transport.listConversations()).find(c => c.agentId === 'profile:runner')!
    await transport.sendMessage(dm, 'Original submission')
    const previous = rpc
    rpc = (method, params) => method === 'session.events.since' ? {
      events: [{ type: 'tool.complete', session_id: 'runtime-runner', seq: 1,
        payload: { name: 'render_ui', tool_id: 'own', result: { genui: spec, genuiOccurrence: freshOccurrence } } },
      { type: 'message.complete', session_id: 'runtime-runner', seq: 2, payload: { text: 'Current final answer' } }],
      latest_seq: 5002, epoch: bridgeEpoch, truncated: false, open_requests: [],
    } : previous(method, params)
    closeSocket(); await vi.advanceTimersByTimeAsync(1000); await microtasks()
    emit('runtime-runner', 'tool.complete', 3, { name: 'render_ui', tool_id: 'old-tail', result: { genui: spec, genuiOccurrence: oldOccurrence } })
    await microtasks()
    expect(widgets(dm.id).map(e => e.genuiOccurrence)).toEqual([freshOccurrence])
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })

  it('adopts the first genuine epoch when reconnect recovery starts before gateway.ready', async () => {
    bridgeEpoch = ''
    const dm = (await transport.listConversations()).find(c => c.agentId === 'profile:runner')!
    await transport.sendMessage(dm, 'Original submission')
    const previous = rpc
    rpc = (method, params) => method === 'session.events.since' ? {
      events: [{ type: 'tool.complete', session_id: 'runtime-runner', seq: 1,
        payload: { name: 'render_ui', tool_id: 'own', result: { genui: spec, genuiOccurrence: freshOccurrence } } },
      { type: 'message.complete', session_id: 'runtime-runner', seq: 2, payload: { text: 'Current final answer' } }],
      latest_seq: 2, epoch: bridgeEpoch, truncated: false, open_requests: [],
    } : previous(method, params)
    bridgeEpoch = 'fake-epoch-1'
    closeSocket(); await vi.advanceTimersByTimeAsync(1000); await microtasks()
    expect(widgets(dm.id).map(e => e.genuiOccurrence)).toEqual([freshOccurrence])
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })
})

describe('GENUI owning raw-history/live overlap through the real adapter', () => {
  const spec = { version: 1 as const, components: [{ type: 'stat' as const, title: 'Overlap data', value: '12' }] }
  const known = '88888888-8888-4888-8888-888888888888'
  const fresh = '99999999-9999-4999-8999-999999999999'
  const canonical = 'mcp__hermes_desk__render_ui'
  const microtasks = async () => { for (let i = 0; i < 150; i++) await Promise.resolve() }
  const emit = (type: string, seq: number, payload: unknown, session = 'runtime-runner') =>
    push({ jsonrpc: '2.0', method: 'event', params: { session_id: session, type, seq, payload } })
  const result = (occurrence = known, id = 'own', name = canonical, data = spec) =>
    ({ name, tool_id: id, result: { genui: data, genuiOccurrence: occurrence } })
  const widgets = (id: string) => getMessagesForConversation(id).flatMap(m => m.toolEvents ?? []).filter(e => e.genui)
  const third = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const fourth = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  async function held(options: { occurrence?: string; two?: boolean; four?: boolean; priorTurn?: boolean; cachedPrior?: boolean; profile?: string } = {}) {
    const profile = options.profile ?? 'runner'
    const conv = (await transport.listConversations()).find(c => c.agentId === `profile:${profile}`)!
    if (options.cachedPrior) setState(state => ({ messagesByThreadId: { ...state.messagesByThreadId,
      [conv.id]: localHistoryMessages(`stored-${profile}`, conv.id, profile, [{ role: 'user', row_id: 1, text: 'Original own prompt' }]) } }))
    await transport.sendMessage(conv, 'Original own prompt')
    const source = options.occurrence ?? known
    const previous = rpc
    const prompt = { role: 'user', row_id: 1, text: 'Original own prompt' }
    const dispatched = [{ id: 'own', occurrence: source },
      ...(options.two || options.four ? [{ id: 'two', occurrence: fresh }] : []),
      ...(options.four ? [{ id: 'three', occurrence: third }, { id: 'four', occurrence: fourth }] : [])]
    const projected = [prompt, ...dispatched.map((tool, i) => ({ role: 'tool', row_id: 3 + i, name: canonical, tool_call_id: tool.id })),
      { role: 'assistant', row_id: 8, text: 'Done' },
      ...(options.priorTurn ? [{ role: 'user', row_id: 9, text: 'Later own prompt' }] : [])]
    const raw = [prompt, { role: 'assistant', row_id: 2, tool_calls: [
      ...dispatched.map(tool => ({ id: tool.id, function: { name: canonical } }))] },
      ...dispatched.map((tool, i) => ({ role: 'tool', row_id: 3 + i, tool_call_id: tool.id, content: JSON.stringify(result(tool.occurrence).result) })),
      { role: 'assistant', row_id: 8, text: 'Done' },
      ...(options.priorTurn ? [{ role: 'user', row_id: 9, text: 'Later own prompt' }] : [])]
    rpc = (method, params) => params.profile === profile && method === 'session.events.since'
      ? { events: [], latest_seq: 5002, truncated: true, epoch: bridgeEpoch, open_requests: [] }
      : params.profile === profile && method === 'session.history' ? { messages: projected } : previous(method, params)
    let release!: () => void
    fetchMock.mockImplementation(async (url: string) => url.includes(`/export?profile=${profile}`)
      ? new Response(new ReadableStream({ start(controller) {
        release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ messages: raw }))); controller.close() }
      } }), { status: 200 }) : new Response('{}', { status: 200 }))
    closeSocket(); await vi.advanceTimersByTimeAsync(1000); await microtasks()
    expect(release).toBeDefined()
    return { conv, release }
  }
  it.each([canonical, 'mcp__hermes_desk_render_ui', 'render_ui'])('merges the same durable dispatch and pending/generic activity once: %s', async alias => {
    const f = await held()
    emit('tool.start', 5003, { name: alias, tool_id: 'own', args: { spec } })
    emit('tool.start', 5004, { name: 'read_file', tool_id: 'generic' })
    emit('tool.complete', 5005, { name: 'read_file', tool_id: 'generic', result: 'Read completed' })
    emit('tool.complete', 5006, result(known, 'own', alias))
    emit('message.complete', 5007, { text: 'Done' })
    f.release(); await microtasks()
    expect(widgets(f.conv.id).map(e => e.genuiOccurrence)).toEqual([known])
    const replies = getMessagesForConversation(f.conv.id).filter(m => m.role === 'agent')
    expect(replies).toHaveLength(1)
    expect(replies[0].toolEvents).toContainEqual(expect.objectContaining({ tool: 'read_file', status: 'completed' }))
    expect(replies[0].streaming).toBe(false)
    expect(replies[0].content).toBe('Done')
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })
  it.each([false, true])('retains durable owning prompt identity through repeated recovery, multiple widgets: %s', async two => {
    const f = await held({ two })
    const dispatched = [{ id: 'own', occurrence: known }, ...(two ? [{ id: 'two', occurrence: fresh }] : [])]
    const raw = [{ role: 'user', row_id: 1, text: 'Original own prompt' },
      { role: 'assistant', row_id: 2, tool_calls: dispatched.map(tool => ({ id: tool.id, function: { name: canonical } })) },
      ...dispatched.map((tool, i) => ({ role: 'tool', row_id: 3 + i, tool_call_id: tool.id,
        content: JSON.stringify(result(tool.occurrence).result) })),
      { role: 'assistant', row_id: 8, text: 'Done' }]
    emit('tool.complete', 5003, result())
    f.release(); await microtasks()
    const owningTurn = () => Object.values(getState().turnsById).find(turn => turn.threadId === f.conv.id)!
    const durablePrompt = () => getMessagesForConversation(f.conv.id).find(message => message.role === 'user')!
    const turnId = owningTurn().id
    expect(owningTurn().userMessageId).toBe(durablePrompt().id)
    for (let round = 1; round <= 3; round++) {
      let release!: () => void
      fetchMock.mockImplementation(async (url: string) => url.includes('/export?profile=runner')
        ? new Response(new ReadableStream({ start(controller) {
          release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ messages: raw }))); controller.close() }
        } }), { status: 200 }) : new Response('{}', { status: 200 }))
      closeSocket(); await vi.advanceTimersByTimeAsync(1000); await microtasks()
      expect(release).toBeDefined()
      emit('tool.complete', 5003 + round, result(two ? fresh : known, two ? 'two' : 'own'))
      release(); await microtasks()
      expect(owningTurn()).toMatchObject({ id: turnId, userMessageId: durablePrompt().id, phase: 'working' })
      expect(widgets(f.conv.id).map(tool => tool.genuiOccurrence)).toEqual(dispatched.map(tool => tool.occurrence))
      expect(getMessagesForConversation(f.conv.id).filter(message => message.role === 'agent')).toHaveLength(1)
    }
    emit('message.complete', 5007, { text: 'Done' }); await microtasks()
    expect(owningTurn()).toMatchObject({ id: turnId, userMessageId: durablePrompt().id, phase: 'done' })
    expect(calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
  })
  it.each(['known-first', 'new-first'])('keeps mixed known and new dispatches without duplicate messages: %s', async order => {
    const f = await held()
    const values = [result(), result(fresh, 'new')]
    if (order === 'new-first') values.reverse()
    values.forEach((value, i) => emit('tool.complete', 5003 + i, value))
    emit('message.complete', 5005, { text: 'Done with both' })
    f.release(); await microtasks()
    expect(widgets(f.conv.id).map(e => e.genuiOccurrence)).toEqual([known, fresh])
    expect(getMessagesForConversation(f.conv.id).filter(m => m.role === 'agent')).toHaveLength(1)
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })
  it('merges two known widgets exactly once', async () => {
    const f = await held({ two: true })
    emit('tool.complete', 5003, result())
    emit('tool.complete', 5004, result(fresh, 'two', 'render_ui'))
    emit('message.complete', 5005, { text: 'Done' })
    f.release(); await microtasks()
    expect(widgets(f.conv.id).map(e => e.genuiOccurrence)).toEqual([known, fresh])
    expect(getMessagesForConversation(f.conv.id).filter(m => m.role === 'agent')).toHaveLength(1)
  })
  it.each(['known-first', 'new-first', 'pending-new'])('keeps reused provider ids with different dispatch occurrences separate: %s', async order => {
    const f = await held()
    const values = [result(), result(fresh)]
    if (order === 'new-first') values.reverse()
    emit('tool.complete', 5003, values[0])
    if (order === 'pending-new') emit('tool.start', 5004, { name: canonical, tool_id: 'own' })
    emit('tool.complete', 5005, values[1])
    emit('message.complete', 5006, { text: 'New dispatch done' })
    f.release(); await microtasks()
    expect(widgets(f.conv.id).map(e => e.genuiOccurrence)).toEqual([known, fresh])
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })
  it.each(['legacy', 'invalid', 'revision', 'prior-turn', 'cached-prior-identical-prompt'])('does not promote mismatched historical metadata to merge authority: %s', async mode => {
    const f = await held({ occurrence: mode === 'legacy' ? '' : mode === 'invalid' ? 'not-an-occurrence' : known,
      priorTurn: mode === 'prior-turn', cachedPrior: mode === 'cached-prior-identical-prompt' })
    emit('tool.complete', 5003, result(known, 'own', canonical, mode === 'revision'
      ? { version: 1, components: [{ type: 'stat', title: 'Changed revision', value: '99' }] } : spec))
    emit('message.complete', 5004, { text: 'Current completion' })
    f.release(); await microtasks()
    expect(widgets(f.conv.id)).toHaveLength(2)
    expect(widgets(f.conv.id).at(-1)?.genuiOccurrence).toBe(known)
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })
  it('never lets another conversation/profile with the same historical occurrence suppress the current dispatch', async () => {
    const f = await held()
    const sibling = getState().conversations.find(c => c.target.type === 'agent' && c.target.agentId === 'profile:backend-eng')!
    setState(state => ({ messagesByThreadId: { ...state.messagesByThreadId, [sibling.id]: [{
      id: 'unrelated', threadId: sibling.id, role: 'agent', fromAgentId: 'profile:backend-eng', content: 'Other history',
      createdAt: new Date().toISOString(), toolEvents: [{ tool: canonical, toolCallId: 'own', status: 'completed', genui: spec, genuiOccurrence: fresh }],
    }] } }))
    emit('tool.complete', 5003, result(fresh, 'new'))
    emit('message.complete', 5004, { text: 'New Done' })
    f.release(); await microtasks()
    expect(widgets(f.conv.id).map(e => e.genuiOccurrence)).toEqual([known, fresh])
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })
  it.each(['known-first', 'new-first'])('retains genuinely new post-cursor data at the four-spec message bound: %s', async order => {
    const f = await held({ four: true })
    const extra = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const values = [result(), result(extra, 'new')]
    if (order === 'new-first') values.reverse()
    values.forEach((value, i) => emit('tool.complete', 5003 + i, value))
    emit('message.complete', 5005, { text: 'Both recovered' })
    f.release(); await microtasks()
    expect(widgets(f.conv.id).map(e => e.genuiOccurrence)).toEqual([known, fresh, third, fourth, extra])
    expect(getMessagesForConversation(f.conv.id).filter(m => m.role === 'agent')).toHaveLength(2)
    expect(getMessagesForConversation(f.conv.id).every(m => (m.toolEvents ?? []).filter(e => e.genui).length <= 4)).toBe(true)
    expect(calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
  })
})

describe('local shared rooms through the real adapter', () => {
  it('lists healthy chats when a saved room no longer has a group definition', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer recovery fixture')
    await drain()
    const retiredGroup = await transport.createGroup({
      name: 'Retired fixture group', memberAgentIds: ['profile:runner'],
    })
    const orphan = createConversation({ type: 'group', groupId: retiredGroup.id }, retiredGroup.name)
    const saved = getState().conversations.find(c => c.id === room.id)!.localRoom!
    setState(state => ({
      groups: state.groups.filter(g => g.id !== retiredGroup.id),
      conversations: state.conversations.map(c => c.id === orphan.id
        ? { ...c, localRoom: { ...saved, conversationId: orphan.id, bindings: {}, turns: [] } } : c),
    }))

    const rows = await transport.listConversations()
    expect(rows.some(c => c.id === room.id)).toBe(true)
    expect(rows.some(c => c.hermesSessionId === 'stored-runner')).toBe(true)
    expect(submitted()).toHaveLength(1)
    expect(getMessagesForConversation(room.id).filter(m => m.role === 'user')).toHaveLength(1)
  })

  it('declines unopened orphan-room requests and consumes its output without disrupting a healthy DM', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer orphan fixture task')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    const before = getState().conversations.find(c => c.id === room.id)!.localRoom
    transport.dispose()
    resetRoomViews()
    const groupId = room.target.type === 'group' ? room.target.groupId : ''
    setState(state => ({ groups: state.groups.filter(g => g.id !== groupId) }))
    transport = new HermesLocalTransport({ getPrefs: () => prefs, setPrefs: value => { prefs = value } })
    const dm = await conversation()
    await transport.sendMessage(dm, 'Healthy DM fixture task')
    const dmSession = String(submitted().at(-1)!.params!.session_id)

    push({ jsonrpc: '2.0', id: 'orphan-approval', method: 'approval',
      params: { session_id: writer, command: 'Orphan fixture', choices: ['once', 'deny'] } })
    push({ jsonrpc: '2.0', id: 'orphan-question', method: 'clarify',
      params: { session_id: writer, question: 'Orphan fixture?', choices: ['yes', 'no'] } })
    roomEvent(writer, 'message.delta', { text: 'Orphan late output' }, 1)
    roomEvent(writer, 'message.complete', { text: 'Orphan late output' }, 2)
    roomEvent(writer, 'approval.request', { request_id: 'orphan-legacy-approval', command: 'Orphan fixture' }, 3)
    roomEvent(writer, 'clarify.request', { request_id: 'orphan-legacy-question', question: 'Orphan fixture?' }, 4)
    await drain()
    expect(responses.find(r => r.id === 'orphan-approval')?.error?.code).toBe(-32000)
    expect(responses.find(r => r.id === 'orphan-question')?.error?.code).toBe(-32000)
    expect(getPendingToolPermission()).toBeNull()
    expect(getAgentPrompts()).toEqual([])
    expect(getRoomView(room.id)).toBeUndefined()
    expect(getState().conversations.find(c => c.id === room.id)?.localRoom).toEqual(before)

    complete(dmSession, 'Healthy DM answer')
    await drain()
    expect(getMessagesForConversation(dm.id).some(m => m.content === 'Healthy DM answer')).toBe(true)
    expect(getMessagesForConversation(room.id).some(m => m.content === 'Orphan late output')).toBe(false)
    expect(submitted()).toHaveLength(2)
  })

  it('answers distinct approval requests in FIFO order even from the same room member', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer investigate')
    await drain()
    const session = String(submitted().at(-1)!.params!.session_id)
    for (const id of ['first', 'second']) push({ jsonrpc: '2.0', id, method: 'approval',
      params: { session_id: session, choices: ['once', 'deny'] } })
    expect(getPendingToolPermission(room.id)?.id).toBe('first')
    await transport.respondPermission(room.id, 'once', { requestId: 'first' })
    expect(responses.at(-1)?.id).toBe('first')
    expect(getPendingToolPermission(room.id)?.id).toBe('second')
    await transport.respondPermission(room.id, 'deny', { requestId: 'second' })
    expect(responses.at(-1)?.id).toBe('second')
    expect(getPendingToolPermission(room.id)).toBeNull()
  })
  it('keeps approvals independently actionable in two rooms and ignores a stale card answer', async () => {
    const a = await team()
    await transport.sendMessage(a, '@Writer first')
    await drain()
    const first = String(submitted().at(-1)!.params!.session_id)
    const b = await team()
    await transport.sendMessage(b, '@Coder second')
    await drain()
    const second = String(submitted().at(-1)!.params!.session_id)
    for (const [id, session] of [['a-request', first], ['b-request', second]]) push({
      jsonrpc: '2.0', id, method: 'approval', params: { session_id: session, choices: ['once', 'deny'] },
    })
    expect(getPendingToolPermission(a.id)?.id).toBe('a-request')
    expect(getPendingToolPermission(b.id)?.id).toBe('b-request')
    event('request.cancel', { id: 'a-request', method: 'approval' })
    push({ jsonrpc: '2.0', id: 'a-new', method: 'approval', params: { session_id: first, choices: ['once', 'deny'] } })
    await transport.respondPermission(a.id, 'once', { requestId: 'a-request' })
    expect(responses).toEqual([])
    await transport.respondPermission(b.id, 'deny', { requestId: 'b-request' })
    expect(responses.at(-1)?.id).toBe('b-request')
    expect(getPendingToolPermission(a.id)?.id).toBe('a-new')
    await transport.respondPermission(a.id, 'once', { requestId: 'a-new' })
    expect(responses.at(-1)?.id).toBe('a-new')
  })
  let sessionNumber: number
  let roomSessions: Map<string, { profile: string; storedId: string; status: string }>
  let roomReplay: Map<string, { type: string; payload: unknown; session_id: string; seq: number }[]>
  const roomEvent = (sessionId: string, type: string, payload: unknown, seq: number) => {
    const params = { type, payload, session_id: sessionId, seq }
    roomReplay.set(sessionId, [...roomReplay.get(sessionId) ?? [], params])
    push({ jsonrpc: '2.0', method: 'event', params })
  }
  const submitted = () => calls.filter(c => c.method === 'prompt.submit')
  const drain = () => vi.advanceTimersByTimeAsync(0)

  beforeEach(() => {
    sessionNumber = 0
    roomSessions = new Map()
    roomReplay = new Map()
    const previous = rpc
    rpc = (method, params) => {
      if (method === 'profiles.list') return { profiles: [
        { name: 'runner', role: 'orchestrator', ui_meta: { display_name: 'Chief' } },
        { name: 'default', ui_meta: { display_name: 'Writer' } },
        { name: 'backend-eng', ui_meta: { display_name: 'Coder' } },
      ] }
      if (method === 'session.create') {
        const id = `room-runtime-${params.profile}-${++sessionNumber}`
        const storedId = `issued-stored-${sessionNumber}`
        roomSessions.set(id, { profile: String(params.profile), storedId, status: 'idle' })
        return { session_id: id, stored_session_id: storedId, info: { profile_name: params.profile } }
      }
      if (method === 'session.resume') {
        const found = [...roomSessions].find(([, s]) => s.storedId === params.session_id && s.profile === params.profile)
        if (!found) throw new Error('Unknown fixture stored session')
        return { session_id: found[0], stored_session_id: found[1].storedId, running: found[1].status === 'working', info: { profile_name: params.profile } }
      }
      if (method === 'prompt.submit') {
        const session = roomSessions.get(String(params.session_id))
        if (!session || session.profile !== params.profile) throw new Error('Wrong fixture owner')
        session.status = 'working'
        return { status: 'streaming' }
      }
      if (method === 'session.active_list') return { sessions: [...roomSessions].filter(([, s]) => s.profile === params.profile)
        .map(([id, s]) => ({ id, status: s.status })) }
      if (method === 'session.events.since') {
        const frames = roomReplay.get(String(params.session_id)) ?? []
        return { events: frames.filter(f => f.seq > Number(params.last_seen ?? 0)),
          latest_seq: Math.max(0, ...frames.map(f => f.seq)), epoch: 'fake-epoch-1', truncated: false, open_requests: [] }
      }
      return previous(method, params)
    }
  })

  async function team(memberAgentIds = ['profile:runner', 'profile:default', 'profile:backend-eng']) {
    await transport.listAgents()
    const group = await transport.createGroup({ name: 'Fixture team', memberAgentIds })
    return createConversation({ type: 'group', groupId: group.id }, group.name)
  }
  function complete(sessionId: string, text: string, seq = 3) {
    roomSessions.get(sessionId)!.status = 'idle'
    roomEvent(sessionId, 'message.complete', { text, status: 'complete' }, seq)
  }
  it('normalizes a known long member label without duplicating it in the room transcript', async () => {
    const name = 'Senior Database Reliability Engineer'
    const previous = rpc
    rpc = (method, params) => method === 'profiles.list' ? { profiles: [
      { name: 'runner', role: 'orchestrator', ui_meta: { display_name: 'Chief' } },
      { name: 'default', ui_meta: { display_name: name } },
      { name: 'backend-eng', ui_meta: { display_name: 'Coder' } },
    ] } : previous(method, params)
    const room = await team()
    await transport.sendMessage(room, `@${name} inspect the database.`)
    await drain()
    complete(String(submitted()[0]!.params!.session_id), `[${name}] Useful result.`)
    expect(getMessagesForConversation(room.id)).toContainEqual(expect.objectContaining({
      role: 'agent', fromAgentId: 'profile:default', content: 'Useful result.',
    }))
  })

  it('does not submit an address-like supplementary-letter token to the named peer profile', async () => {
    const room = await team()
    await transport.sendMessage(room, 'Reference address: 𐐀@Coder.example')
    await drain()
    expect(submitted().map(c => c.params!.profile)).toEqual(['runner'])
  })

  it('submits an exact display-name mention to its profile despite a no-space alias collision', async () => {
    const previous = rpc
    rpc = (method, params) => method === 'profiles.list' ? { profiles: [
      { name: 'runner', role: 'orchestrator', ui_meta: { display_name: 'Chief' } },
      { name: 'default', ui_meta: { display_name: 'Data Ops' } },
      { name: 'backend-eng', ui_meta: { display_name: 'DataOps' } },
    ] } : previous(method, params)
    const room = await team()
    await transport.sendMessage(room, '@DataOps audit the change.')
    await drain()
    expect(submitted().map(c => c.params!.profile)).toEqual(['backend-eng'])
  })


  it('runs a three-profile conversation with parallel specialists, interleaved speakers and a settled Chief wrap', async () => {
    const room = await team()
    expect(await transport.roomsEnabled?.()).toBe(true)
    await transport.sendMessage(room, 'Write copy and check code')
    await drain()
    const chief = String(submitted()[0]!.params!.session_id)
    expect(submitted()[0]!.params!.profile).toBe('runner')
    expect(Object.keys(submitted()[0]!.params!).sort()).toEqual(['profile', 'session_id', 'surface', 'text'])
    complete(chief, '@Writer draft copy. @Coder check code.')
    await drain()
    expect(submitted()).toHaveLength(3)
    const writer = String(submitted()[1]!.params!.session_id)
    const coder = String(submitted()[2]!.params!.session_id)
    expect(roomSessions.get(writer)?.status).toBe('working')
    expect(roomSessions.get(coder)?.status).toBe('working')
    const elsewhere = createConversation({ type: 'agent', agentId: 'profile:default' })
    selectConversation(elsewhere.id)
    roomEvent(writer, 'message.delta', { text: 'Copy ' }, 1)
    roomEvent(coder, 'message.delta', { text: 'Code ' }, 1)
    roomEvent(writer, 'message.delta', { text: 'ready' }, 2)
    roomEvent(coder, 'message.delta', { text: 'checked' }, 2)
    const streaming = getMessagesForConversation(room.id).filter(m => m.streaming)
    expect(streaming.map(m => [m.fromAgentId, m.content])).toEqual([
      ['profile:default', 'Copy ready'], ['profile:backend-eng', 'Code checked'],
    ])
    expect(getMessagesForConversation(elsewhere.id).filter(m => m.role === 'agent')).toEqual([])
    complete(writer, 'Copy ready')
    await drain()
    expect(submitted()).toHaveLength(3)
    complete(coder, '[pass] Code checked')
    await drain()
    expect(submitted()).toHaveLength(4)
    expect(submitted()[3]!.params!.session_id).toBe(chief)
    expect(submitted()[3]!.params!.text).toContain('Writer: Copy ready')
    expect(submitted()[3]!.params!.text).toContain('Coder: Code checked')
    complete(chief, 'Both results are ready.', 4)
    complete(coder, '[pass] Code checked')
    await drain()
    expect(submitted()).toHaveLength(4)
    expect(getRoomView(room.id)?.turns).toEqual([])
    const rows = getMessagesForConversation(room.id)
    expect(rows.filter(m => m.role === 'user')).toHaveLength(1)
    expect(rows.filter(m => m.role === 'agent')).toHaveLength(4)
    const strips = roomHandoffStrips(getRoomView(room.id)!, id => id)
    expect([...strips.values()][0]?.pills.map(p => p.state)).toEqual(['replied', 'replied'])
    expect([...strips.values()][0]?.wrap?.state).toBe('replied')
    const saved = getState().conversations.find(c => c.id === room.id)!
    expect(new Set(Object.values(saved.memberSessionIds ?? {})).size).toBe(3)
    expect(Object.values(saved.memberSessionIds ?? {}).every(id => id.startsWith('issued-stored-'))).toBe(true)
    expect(saved.hermesSessionId).toBeUndefined()
  })

  it('routes a reply to its member and serializes @everyone in a Chief-less room', async () => {
    const room = await team(['profile:default', 'profile:backend-eng'])
    // Remove the account Chief to exercise the no-Chief fallback.
    setState({ agents: getState().agents.filter(a => a.id !== 'profile:runner') })
    await transport.sendMessage(room, '@Coder then @Writer answer')
    await drain()
    expect(submitted().map(c => c.params!.profile)).toEqual(['backend-eng'])
    const coder = String(submitted()[0]!.params!.session_id)
    complete(coder, 'First answer')
    await drain()
    expect(submitted().map(c => c.params!.profile)).toEqual(['backend-eng', 'default'])
    const writer = String(submitted()[1]!.params!.session_id)
    expect(submitted()[1]!.params!.text).toContain('Coder: First answer')
    complete(writer, '[pass]')
    await drain()
    expect(getMessagesForConversation(room.id).filter(m => m.role === 'agent')).toHaveLength(1)
    const answer = getMessagesForConversation(room.id).find(m => m.role === 'agent')!
    await transport.sendMessage(room, 'Explain that', { replyTo: { id: answer.id, role: 'agent', snippet: answer.content } })
    await drain()
    expect(submitted().at(-1)!.params!.profile).toBe('backend-eng')
    complete(coder, 'Explanation', 4)
    await transport.sendMessage(room, '@everyone help')
    await drain()
    expect(getRoomView(room.id)?.turns.map(t => t.memberId)).toEqual(['profile:default', 'profile:backend-eng'])
  })

  it('keeps an active member label owned across a roster display-name refresh', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer stream a useful answer')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    setState(state => ({ agents: state.agents.map(a => a.id === 'profile:default' ? { ...a, name: 'Editor' } : a) }))
    roomEvent(writer, 'message.delta', { text: '[Writer] Useful answer' }, 1)
    expect(getMessagesForConversation(room.id).find(m => m.streaming)?.content).toBe('Useful answer')
    complete(writer, '[Writer] [pass]')
    expect(getMessagesForConversation(room.id).filter(m => m.role === 'agent')).toEqual([])
    expect(getRoomView(room.id)?.recent).toContainEqual(expect.objectContaining({
      memberId: 'profile:default', status: 'pass',
    }))
  })

  it('captures the label actually submitted after a rename during binding', async () => {
    const room = await team()
    const previous = rpc
    let release!: () => void
    rpc = (method, params) => {
      const result = previous(method, params)
      return method === 'session.create' ? new Promise(resolve => { release = () => resolve(result) }) : result
    }
    await transport.sendMessage(room, '@Writer inspect the database.')
    await drain()
    setState(state => ({ agents: state.agents.map(a => a.id === 'profile:default' ? { ...a, name: 'Editor' } : a) }))
    release()
    await drain()
    expect(String(submitted()[0]!.params!.text)).toContain('You are Editor')
    setState(state => ({ agents: state.agents.map(a => a.id === 'profile:default' ? { ...a, name: 'Proofreader' } : a) }))
    const writer = String(submitted()[0]!.params!.session_id)
    roomEvent(writer, 'message.delta', { text: '[Editor] Useful answer' }, 1)
    expect(getMessagesForConversation(room.id).find(m => m.streaming)?.content).toBe('Useful answer')
    complete(writer, '[Editor] Useful answer')
    expect(getMessagesForConversation(room.id).find(m => m.role === 'agent' && !m.streaming))
      .toMatchObject({ fromAgentId: 'profile:default', content: 'Useful answer' })
  })

  it('normalizes live speaker labels like final replies while preserving the raw journal', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer stream a useful answer')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    roomEvent(writer, 'message.delta', { text: '[Writer] Useful answer [pa' }, 1)
    expect(getMessagesForConversation(room.id).find(m => m.streaming)?.content).toBe('Useful answer ')
    expect(getState().conversations.find(c => c.id === room.id)?.localRoom?.turns[0]?.partialText)
      .toBe('[Writer] Useful answer [pa')
    complete(writer, '[Writer] Useful answer [pass]')
    expect(getMessagesForConversation(room.id).find(m => m.role === 'agent' && !m.streaming))
      .toMatchObject({ fromAgentId: 'profile:default', content: 'Useful answer' })
  })

  it('hides streamed trailing pass fragments while preserving substantive output and nonmarker brackets', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer stream a useful answer')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    roomEvent(writer, 'message.delta', { text: 'Useful answer [pa' }, 1)
    expect(getMessagesForConversation(room.id).find(m => m.streaming)?.content).toBe('Useful answer ')
    expect(getState().conversations.find(c => c.id === room.id)?.localRoom?.turns[0]?.partialText).toBe('Useful answer [pa')
    roomEvent(writer, 'message.delta', { text: 'ss] keeps content [Par' }, 2)
    expect(getMessagesForConversation(room.id).find(m => m.streaming)?.content).toBe('Useful answer  keeps content [Par')
    complete(writer, 'Useful answer [pass] keeps content [Paragraph]')
    await drain()
    expect(getMessagesForConversation(room.id).find(m => m.role === 'agent')?.content).toBe('Useful answer  keeps content [Paragraph]')
    expect(getRoomView(room.id)?.turns).toEqual([])
  })

  it('seats the account Chief and keeps member sessions separate from DMs and other rooms', async () => {
    const room = await team(['profile:default', 'profile:backend-eng'])
    await transport.sendMessage(room, 'Unmentioned work')
    await drain()
    expect(submitted()[0]!.params!.profile).toBe('runner')
    const other = await team(['profile:default'])
    await transport.sendMessage(other, '@Writer independent work')
    const dm = createConversation({ type: 'agent', agentId: 'profile:default' })
    await transport.sendMessage(dm, 'DM work')
    await drain()
    const handles = submitted().map(c => c.params!.session_id)
    expect(new Set(handles).size).toBe(3)
    expect((await transport.listConversations()).filter(c => handles.includes(c.hermesSessionId))).toEqual([])
  })

  async function delegated() {
    const room = await team()
    await transport.sendMessage(room, 'Independent fixture tasks')
    await drain()
    complete(String(submitted()[0]!.params!.session_id), '@Writer do task one. @Coder do task two.')
    await drain()
    return { room, writer: String(submitted()[1]!.params!.session_id), coder: String(submitted()[2]!.params!.session_id) }
  }

  it('wraps the original parallel batch once even when a specialist asks the Chief a question mid-batch', async () => {
    const { room, writer, coder } = await delegated()
    const chief = String(submitted()[0]!.params!.session_id)
    complete(writer, '@Chief choose the palette.')
    await drain()
    expect(submitted()).toHaveLength(4)
    expect(submitted().at(-1)!.params!.profile).toBe('runner')
    complete(chief, 'Use a blue palette.', 4)
    await drain()
    expect(submitted()).toHaveLength(4)
    expect(getRoomView(room.id)?.handoffs.some(t => t.kind === 'wrap')).toBe(false)
    complete(coder, 'Code checked.')
    await drain()
    expect(submitted()).toHaveLength(5)
    expect(submitted().at(-1)!.params!.text).toContain('Coder: Code checked.')
    complete(chief, 'Both tasks settled.', 5)
    complete(coder, 'Duplicate result')
    await drain()
    expect(submitted()).toHaveLength(5)
    expect(getRoomView(room.id)?.turns).toEqual([])
    expect(getRoomView(room.id)?.handoffs.filter(t => t.kind === 'wrap')).toHaveLength(1)
  })

  it('badges settled background room replies once, not streams, passes or duplicate completions', async () => {
    const { room, writer, coder } = await delegated()
    const elsewhere = createConversation({ type: 'agent', agentId: 'profile:default' })
    selectConversation(elsewhere.id)
    roomEvent(writer, 'message.delta', { text: 'Drafting' }, 1)
    expect(getState().conversations.find(c => c.id === room.id)?.hasUnread).toBeFalsy()
    complete(writer, 'Copy ready')
    await drain()
    expect(getState().conversations.find(c => c.id === room.id)).toMatchObject({ hasUnread: true, unreadCount: 1 })
    complete(writer, 'Copy ready')
    complete(coder, '[pass]')
    await drain()
    expect(getState().conversations.find(c => c.id === room.id)?.unreadCount).toBe(1)
    complete(String(submitted()[0]!.params!.session_id), 'Final result', 4)
    await drain()
    expect((await transport.listConversations()).find(c => c.id === room.id)).toMatchObject({ unread: true, unreadCount: 2 })
    expect(getState().conversations.find(c => c.id === elsewhere.id)?.hasUnread).toBeFalsy()
    selectConversation(room.id)
    await drain()
    expect(getState().conversations.find(c => c.id === room.id)).toMatchObject({ hasUnread: false, unreadCount: 0 })
  })

  it('marks a local room read without touching its member sessions or sibling unread badges', async () => {
    const room = await team()
    const elsewhere = createConversation({ type: 'agent', agentId: 'profile:default' })
    setState(state => ({ conversations: state.conversations.map(c => ({ ...c, hasUnread: true, unreadCount: 2 })) }))
    await transport.markRead(room.id)
    expect(getState().conversations.find(c => c.id === room.id)).toMatchObject({ hasUnread: false, unreadCount: 0 })
    expect(getState().conversations.find(c => c.id === elsewhere.id)).toMatchObject({ hasUnread: true, unreadCount: 2 })
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  })

  it.each([true, false])('stops every member, reports interrupt acceptance=%s honestly and fences late events', async accepted => {
    const { room, writer, coder } = await delegated()
    const previous = rpc
    rpc = (method, params) => method === 'session.interrupt'
      ? { status: accepted ? 'interrupted' : 'not_interrupted', interrupted: accepted } : previous(method, params)
    await transport.sendMessage(room, '@Writer queued fixture work')
    expect(await transport.stopTurn(room.id)).toBe(accepted)
    expect(calls.filter(c => c.method === 'session.interrupt').map(c => c.params!.session_id).sort()).toEqual([writer, coder].sort())
    roomEvent(writer, 'message.delta', { text: 'Late ghost' }, 1)
    complete(writer, '@Coder late cascade')
    complete(coder, 'Late reply')
    await drain()
    expect(submitted()).toHaveLength(3)
    expect(getRoomView(room.id)?.turns).toEqual([])
    expect(getMessagesForConversation(room.id).some(m => m.streaming || m.content.includes('Late'))).toBe(false)
    expect(getState().conversations.find(c => c.id === room.id)?.localRoom?.turns.slice(1).every(t => t.status === 'cancelled')).toBe(true)
  })

  it('quarantines a refused interrupt until the backend settles the old turn', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer old work')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    const previous = rpc
    rpc = (method, params) => method === 'session.interrupt' ? { status: 'not_interrupted' } : previous(method, params)
    expect(await transport.stopTurn(room.id)).toBe(false)
    await transport.sendMessage(room, '@Writer new work')
    await drain()
    expect(submitted()).toHaveLength(1)
    complete(writer, '@Coder cancelled old work')
    await drain()
    expect(submitted()).toHaveLength(2)
    expect(submitted()[1]!.params!.text).toContain('@Writer new work')
    expect(getRoomView(room.id)?.handoffs.some(t => t.memberId === 'profile:backend-eng')).toBe(false)
  })

  it.each([false, true])('repeats a quarantined room interruption without stopping a same-profile DM (accepted=%s)', async accepted => {
    const room = await team()
    await transport.sendMessage(room, '@Writer old fixture task')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    const dm = createConversation({ type: 'agent', agentId: 'profile:default' })
    await transport.sendMessage(dm, 'Independent DM fixture task')
    const dmSession = String(submitted()[1]!.params!.session_id)
    const previous = rpc
    let allow = false
    rpc = (method, params) => method === 'session.interrupt'
      ? { status: allow ? 'interrupted' : 'not_interrupted' } : previous(method, params)
    expect(await transport.stopTurn(room.id)).toBe(false)
    await transport.sendMessage(room, '@Writer queued fixture task')
    await drain()
    allow = accepted
    expect(await transport.stopTurn(room.id)).toBe(accepted)
    expect(calls.filter(c => c.method === 'session.interrupt').map(c => c.params!.session_id))
      .toEqual([writer, writer])
    expect(getRoomView(room.id)?.turns).toEqual([])
    expect(submitted()).toHaveLength(2)
    complete(writer, 'Late stopped room result')
    complete(dmSession, 'Independent DM answer')
    await drain()
    expect(getMessagesForConversation(room.id).some(m => m.content === 'Late stopped room result')).toBe(false)
    expect(getMessagesForConversation(dm.id).some(m => m.content === 'Independent DM answer')).toBe(true)
    expect(loadPersistedState()?.conversations.find(c => c.id === room.id)?.localRoom?.turns.every(t => t.status === 'cancelled')).toBe(true)
  })

  it('persists final stopped-task usage without charging or pausing a new root', async () => {
    const room = await team()
    const usage = (total: number) => ({ input: total / 2, output: total / 2, total })
    await transport.setRoomTokenBudget(room.id, 50)
    await transport.sendMessage(room, '@Writer stopped fixture task')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    roomEvent(writer, 'session.usage', { usage: usage(20) }, 1)
    expect(await transport.stopTurn(room.id)).toBe(true)
    await transport.sendMessage(room, '@Writer @Coder fresh fixture task')
    await drain()
    roomSessions.get(writer)!.status = 'idle'
    roomEvent(writer, 'message.complete', {
      status: 'interrupted', text: 'Stopped late output', usage: usage(100),
    }, 2)
    await drain()
    expect(loadPersistedState()?.conversations.find(c => c.id === room.id)?.localRoom?.turns[0])
      .toMatchObject({ status: 'cancelled', usage: usage(100) })
    expect(getMessagesForConversation(room.id).some(m => m.content === 'Stopped late output')).toBe(false)
    roomSessions.get(writer)!.status = 'idle'
    roomEvent(writer, 'message.complete', {
      status: 'complete', text: 'Fresh answer', usage: usage(120),
    }, 3)
    await drain()
    const saved = loadPersistedState()?.conversations.find(c => c.id === room.id)?.localRoom
    expect(saved?.turns[1]?.usage).toEqual(usage(20))
    expect(submitted()).toHaveLength(3)
    expect(submitted()[2]!.params!.profile).toBe('backend-eng')
  })

  it.each(['remove', 'delete'] as const)('%s cancels owned work without reviving it from late completion', async action => {
    const { room, writer, coder } = await delegated()
    if (action === 'remove') {
      const groupId = room.target.type === 'group' ? room.target.groupId : ''
      await transport.setGroupMembers(groupId, ['profile:runner', 'profile:backend-eng'])
    } else deleteConversation(room.id)
    await drain()
    expect(calls.some(c => c.method === 'session.interrupt' && c.params!.session_id === writer)).toBe(true)
    if (action === 'delete') expect(calls.some(c => c.method === 'session.interrupt' && c.params!.session_id === coder)).toBe(true)
    complete(writer, '@Coder late work')
    complete(coder, 'Current fixture result')
    await drain()
    if (action === 'remove') {
      // Removing one specialist leaves the request alive: the Chief still wraps the remaining reply.
      expect(submitted()).toHaveLength(4)
      expect(submitted()[3]!.params!.profile).toBe('runner')
      complete(String(submitted()[3]!.params!.session_id), 'Fixture wrap', 4)
      await drain()
      expect(getMessagesForConversation(room.id).some(m => m.content.includes('late work'))).toBe(false)
    } else expect(submitted()).toHaveLength(3)
    expect(getRoomView(room.id)?.turns ?? []).toEqual([])
    if (action === 'delete') expect(getMessagesForConversation(room.id)).toEqual([])
  })

  it('cancels saved active work when its profile is absent on transport restoration', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer saved fixture task')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    transport.dispose()
    const previous = rpc
    rpc = (method, params) => method === 'profiles.list' ? { profiles: [
      { name: 'runner', role: 'orchestrator', ui_meta: { display_name: 'Chief' } },
      { name: 'backend-eng', ui_meta: { display_name: 'Coder' } },
    ] } : previous(method, params)
    setState(state => ({ agents: state.agents.filter(a => a.id !== 'profile:default') }))
    transport = new HermesLocalTransport({ getPrefs: () => prefs, setPrefs: value => { prefs = value } })

    await transport.getMessages(room.id)
    await drain()
    expect(getRoomView(room.id)?.handoffs[0]).toMatchObject({
      status: 'cancelled', error: 'Room member removed',
    })
    expect(calls.some(c => c.method === 'session.interrupt' && c.params!.session_id === writer)).toBe(true)
    complete(writer, '@Coder departed member late work')
    await drain()
    expect(getMessagesForConversation(room.id).some(m => m.content.includes('departed member late work'))).toBe(false)
    await transport.sendMessage(room, '@Coder independent fixture task')
    await drain()
    expect(submitted()).toHaveLength(2)
    expect(submitted()[1]!.params!.profile).toBe('backend-eng')
    expect(getMessagesForConversation(room.id).filter(m => m.role === 'user')).toHaveLength(2)
  })

  it('handles deletion during session creation without submitting or surfacing an internal chat', async () => {
    const room = await team()
    const previous = rpc
    let resolve!: (value: unknown) => void
    rpc = (method, params) => method === 'session.create' ? new Promise(r => { resolve = r }) : previous(method, params)
    await transport.sendMessage(room, 'fixture work')
    await drain()
    deleteConversation(room.id)
    resolve({ session_id: 'late-room-runtime', stored_session_id: 'late-room-stored', info: { profile_name: 'runner' } })
    await drain()
    expect(submitted()).toEqual([])
    expect(isDeletedConversation('late-room-stored')).toBe(true)
  })

  it('does not lose a new human message arriving during the runner completion wake', async () => {
    const room = await team()
    await transport.sendMessage(room, 'First fixture request')
    await drain()
    const chief = String(submitted()[0]!.params!.session_id)
    complete(chief, 'First fixture answer')
    const next = transport.sendMessage(room, 'Arrived at shutdown')
    await next
    await drain()
    expect(submitted()).toHaveLength(2)
    expect(submitted()[1]!.params!.text).toContain('Arrived at shutdown')
  })

  it('deduplicates concurrent echo retries and does not rerun a completed human root', async () => {
    const room = await team()
    await Promise.all([
      transport.sendMessage(room, '@Writer retry fixture', { echoUser: false, echoId: 'stable-echo' }),
      transport.sendMessage(room, '@Writer retry fixture', { echoUser: false, echoId: 'stable-echo' }),
    ])
    await drain()
    expect(submitted()).toHaveLength(1)
    complete(String(submitted()[0]!.params!.session_id), 'Once')
    await transport.sendMessage(room, '@Writer retry fixture', { echoUser: false, echoId: 'stable-echo' })
    await drain()
    expect(submitted()).toHaveLength(1)
    expect(getMessagesForConversation(room.id).filter(m => m.role === 'user')).toHaveLength(1)
  })

  it('keeps two parallel approvals owned by their sessions and exposes the remaining request after answering', async () => {
    const { room, writer, coder } = await delegated()
    push({ jsonrpc: '2.0', id: 'approval-writer', method: 'approval', params: { session_id: writer, command: 'fixture writer', choices: ['once', 'deny'] } })
    push({ jsonrpc: '2.0', id: 'approval-coder', method: 'approval', params: { session_id: coder, command: 'fixture coder', choices: ['once', 'deny'] } })
    const first = getPendingToolPermission()!
    expect(first).toMatchObject({ memberId: 'profile:default', memberName: 'Writer' })
    await transport.respondPermission(room.id, 'once')
    expect(responses.at(-1)!.id).toBe(first.id)
    const remaining = getPendingToolPermission()
    expect(remaining?.id).not.toBe(first.id)
    expect(remaining?.sessionId).toBe(first.sessionId === writer ? coder : writer)
    await transport.respondPermission(room.id, 'deny')
    expect(new Set(responses.map(r => r.id))).toEqual(new Set(['approval-writer', 'approval-coder']))
    expect(getPendingToolPermission()).toBeNull()
  })

  it('a member completion clears only that member question, not its sibling question', async () => {
    const { room, writer, coder } = await delegated()
    for (const [session, id] of [[writer, 'question-writer'], [coder, 'question-coder']]) push({
      jsonrpc: '2.0', id, method: 'clarify', params: { session_id: session, question: `Question from ${id}`, choices: ['yes', 'no'] },
    })
    complete(writer, 'Writer finished')
    expect(getAgentPrompts().map(p => p.requestId)).toEqual(['question-coder'])
    expect(getAgentPrompts()[0]?.conversationId).toBe(room.id)
    expect(getAgentPrompts()[0]).toMatchObject({ memberId: 'profile:backend-eng', memberName: 'Coder' })
    await answerAgentPrompt('question-coder', { kind: 'clarify', answers: [{ answer: 'yes' }] })
    expect(responses.at(-1)!.id).toBe('question-coder')
  })

  it('reopens settled rooms with the same bindings without resubmitting completed work', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer fixture request')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    complete(writer, 'Settled fixture answer')
    expect(getState().conversations.find(c => c.id === room.id)).toMatchObject({ hasUnread: false, unreadCount: 0 })
    const before = getState().conversations.find(c => c.id === room.id)!.localRoom
    transport.dispose()
    setState({ messagesByThreadId: {} })
    selectConversation(createConversation({ type: 'agent', agentId: 'profile:default' }).id)
    transport = new HermesLocalTransport({ getPrefs: () => prefs })
    await transport.listAgents()
    await transport.getMessages(room.id)
    await drain()
    expect(getMessagesForConversation(room.id).filter(m => m.content === 'Settled fixture answer')).toHaveLength(1)
    expect(getState().conversations.find(c => c.id === room.id)).toMatchObject({ hasUnread: false, unreadCount: 0 })
    expect(getState().conversations.find(c => c.id === room.id)?.localRoom?.bindings).toEqual(before?.bindings)
    expect(submitted()).toHaveLength(1)
  })

  it('restores a departed member speaker name from the room journal without its profile roster entry', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer historical name fixture')
    await drain()
    complete(String(submitted()[0]!.params!.session_id), 'Historical Writer answer')
    await transport.setGroupMembers(room.target.type === 'group' ? room.target.groupId : '',
      ['profile:runner', 'profile:backend-eng'])
    transport.dispose()
    resetLearnedRoomNames()
    setState({ messagesByThreadId: {}, agents: getState().agents.filter(a => a.id !== 'profile:default') })
    transport = new HermesLocalTransport({ getPrefs: () => prefs })
    await transport.getMessages(room.id)
    expect(getMessagesForConversation(room.id)).toContainEqual(expect.objectContaining({
      content: 'Historical Writer answer', fromAgentId: 'profile:default',
    }))
    expect(roomMemberName('profile:default', getState().agents)).toBe('Writer')
    expect(submitted()).toHaveLength(1)
  })

  it('reconciles an interrupted restart explicitly, preserving the settled history without resubmission', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer fixture work')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    roomEvent(writer, 'message.delta', { text: 'Partial not a final' }, 1)
    transport.dispose()
    roomSessions.get(writer)!.status = 'idle'
    transport = new HermesLocalTransport({ getPrefs: () => prefs })
    await transport.listAgents()
    await transport.getMessages(room.id)
    await drain()
    expect(getRoomView(room.id)?.turns).toEqual([])
    expect(getRoomView(room.id)?.handoffs[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/interrupt|reconcil|completion/i) })
    expect(getMessagesForConversation(room.id).some(m => m.streaming || m.content === 'Partial not a final')).toBe(false)
    expect(submitted()).toHaveLength(1)
  })

  it('replays missing deltas during reconnect before a newer live delta can advance the watermark', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer reconnect fixture')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    roomEvent(writer, 'message.delta', { text: 'One ' }, 1)
    roomReplay.set(writer, [...roomReplay.get(writer)!, { type: 'message.delta', payload: { text: 'two ' }, session_id: writer, seq: 2 }])
    closeSocket()
    const previous = rpc
    let resolve!: (value: unknown) => void
    rpc = (method, params) => method === 'session.events.since' && params.session_id === writer
      ? new Promise(r => { resolve = r }) : previous(method, params)
    await transport.retryConnection()
    await drain()
    roomEvent(writer, 'message.delta', { text: 'three' }, 3)
    resolve({ events: roomReplay.get(writer)!.filter(f => f.seq <= 2), latest_seq: 2, epoch: 'fake-epoch-1', truncated: false, open_requests: [] })
    await drain()
    expect(getMessagesForConversation(room.id).find(m => m.streaming)?.content).toBe('One two three')
    complete(writer, 'One two three', 4)
    await drain()
    expect(submitted()).toHaveLength(1)
    expect(getRoomView(room.id)?.turns).toEqual([])
  })

  it('a restarted serve epoch cannot leave old watermarks hiding a new member turn', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer epoch fixture')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    roomEvent(writer, 'message.delta', { text: 'Old partial' }, 10)
    roomSessions.get(writer)!.status = 'idle'
    roomReplay.set(writer, [])
    push({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'fake-epoch-2' } } })
    await drain()
    expect(getRoomView(room.id)?.turns).toEqual([])
    await transport.sendMessage(room, '@Writer new epoch work')
    await drain()
    roomEvent(writer, 'message.delta', { text: 'New answer' }, 1)
    complete(writer, 'New answer', 2)
    await drain()
    expect(getMessagesForConversation(room.id).filter(m => m.content === 'New answer')).toHaveLength(1)
    expect(getRoomView(room.id)?.turns).toEqual([])
  })

  it.each(['watermark', 'quarantine'])('keeps a newer room %s while a reconnect resume is pending', async change => {
    const room = await team()
    await transport.sendMessage(room, '@Writer reconnect task')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    roomEvent(writer, 'message.delta', { text: 'One ' }, 1)
    closeSocket()
    const previous = rpc
    let finishResume!: () => void
    rpc = (method, params) => {
      if (method === 'session.resume' && params.profile === 'default') {
        const snapshot = previous(method, params)
        return new Promise(resolve => { finishResume = () => resolve(snapshot) })
      }
      return previous(method, params)
    }
    await transport.retryConnection()
    await drain()
    if (change === 'watermark') roomEvent(writer, 'message.delta', { text: 'two' }, 2)
    else await transport.stopTurn(room.id)
    finishResume()
    await drain()
    if (change === 'watermark') {
      expect(getMessagesForConversation(room.id).find(m => m.streaming)?.content).toBe('One two')
      complete(writer, 'One two', 3)
    } else {
      expect(getState().conversations.find(c => c.id === room.id)?.localRoom?.bindings['profile:default']?.blocked).toBe(true)
      await transport.sendMessage(room, '@Writer new queued task')
      await drain()
      expect(submitted()).toHaveLength(1)
      complete(writer, 'Old late result', 3)
      await drain()
      expect(submitted()).toHaveLength(2)
      complete(writer, 'Fresh result', 4)
    }
    await drain()
    expect(getRoomView(room.id)?.turns).toEqual([])
    expect(getMessagesForConversation(room.id).some(m => m.content === 'Old late result')).toBe(false)
  })

  it.each(['current', 'usage', 'closed', 'disposed', 'epoch', 'chief'] as const)(
    'fences cached room attachment ownership through the public transport when it becomes %s',
    async ownership => {
      const room = await team()
      const binding = await transport.attachmentSession(room)
      const preparing = transport.attachmentSession(room).then(
        value => ({ ok: true as const, value }), error => ({ ok: false as const, error }),
      )
      if (ownership === 'disposed') transport.dispose()
      if (ownership === 'epoch') event('gateway.ready', { replay_epoch: 'new-attachment-epoch', skin: {} })
      if (ownership === 'closed' || ownership === 'usage')
        roomEvent(binding.runtimeId, ownership === 'closed' ? 'session.closed' : 'session.usage', {}, 1)
      if (ownership === 'chief') setState({
        agents: getState().agents.map(agent => ({
          ...agent, role: agent.id === 'profile:default' ? 'orchestrator'
            : agent.id === 'profile:runner' ? 'specialist' : agent.role,
        })),
      })
      const result = await preparing
      if (ownership === 'current' || ownership === 'usage') expect(result).toEqual({ ok: true, value: binding })
      else {
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error).toBeInstanceOf(Error)
      }
      expect(submitted()).toEqual([])
    },
  )

  it('rejects a resume snapshot superseded by closure rather than reopening a closed attachment runtime', async () => {
    const room = await team()
    const first = await transport.attachmentSession(room)
    const session = roomSessions.get(first.runtimeId)!
    transport.dispose()
    transport = new HermesLocalTransport({ getPrefs: () => prefs })
    await transport.listAgents()
    const previous = rpc
    let finishResume!: () => void
    rpc = (method, params) => {
      if (method === 'session.resume' && params.session_id === first.storedId) {
        const snapshot = previous(method, params)
        return new Promise(resolve => { finishResume = () => resolve(snapshot) })
      }
      return previous(method, params)
    }
    const preparing = transport.attachmentSession(room).then(() => null, error => error as Error)
    await drain()
    roomEvent(first.runtimeId, 'session.closed', { reason: 'idle_timeout' }, 1)
    roomSessions.delete(first.runtimeId)
    finishResume()
    expect(await preparing).toMatchObject({ message: expect.stringMatching(/closed|resum|changed/i) })
    expect(loadPersistedState()?.conversations.find(c => c.id === room.id)?.localRoom?.bindings['profile:runner']?.closed).toBe(true)
    rpc = previous
    const replacement = `replacement-${first.runtimeId}`
    roomSessions.set(replacement, { ...session, status: 'idle' })
    expect((await transport.attachmentSession(room)).runtimeId).toBe(replacement)
    expect(submitted()).toEqual([])
  })

  it('recovers a missed completion with a later live watermark without resubmitting', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer missed completion')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    roomReplay.set(writer, [{ type: 'message.complete', payload: { text: 'Recovered final', status: 'complete' }, session_id: writer, seq: 1 }])
    roomSessions.get(writer)!.status = 'idle'
    roomEvent(writer, 'session.usage', { usage: {} }, 2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getMessagesForConversation(room.id).filter(m => m.content === 'Recovered final')).toHaveLength(1)
    expect(getRoomView(room.id)?.turns).toEqual([])
    expect(submitted()).toHaveLength(1)
  })

  it('keeps an authoritatively working long tool alive, without the DM silent-stream cutoff', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer harmless long fixture tool')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    roomEvent(writer, 'tool.start', { tool_id: 'long-tool', name: 'terminal' }, 1)
    await vi.advanceTimersByTimeAsync(12 * 60_000)
    expect(getRoomView(room.id)?.turns[0]?.phase).toBe('working')
    expect(calls.filter(c => c.method === 'session.interrupt')).toEqual([])
    complete(writer, 'Long fixture result', 2)
    await drain()
    expect(getRoomView(room.id)?.turns).toEqual([])
  })

  it('retries a definitively failed submission once without duplicating the human echo or completed work', async () => {
    const room = await team()
    const previous = rpc
    let fail = true
    rpc = (method, params) => {
      if (method === 'prompt.submit' && fail) throw Object.assign(new Error('Fixture submission refused'), { code: 4001 })
      return previous(method, params)
    }
    await transport.sendMessage(room, '@Writer submission fixture')
    await drain()
    expect(getRoomView(room.id)?.turns).toEqual([])
    expect(getRoomView(room.id)?.handoffs[0]?.status).toBe('error')
    fail = false
    expect(await transport.retryTurn(room.id)).toBe(true)
    await drain()
    expect(submitted()).toHaveLength(2)
    complete(String(submitted()[1]!.params!.session_id), 'Retried once')
    await drain()
    expect(await transport.retryTurn(room.id)).toBe(false)
    expect(getMessagesForConversation(room.id).filter(m => m.role === 'user')).toHaveLength(1)
    expect(getMessagesForConversation(room.id).filter(m => m.content === 'Retried once')).toHaveLength(1)
  })

  it.each([4001, 5000])('invalidates a cached room runtime only for session-not-found code=%s', async code => {
    const room = await team()
    await transport.sendMessage(room, '@Writer first stored task')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    complete(writer, 'First stored answer')
    const session = roomSessions.get(writer)!
    const replacement = `replacement-${writer}`
    const previous = rpc
    let refused = false
    rpc = (method, params) => {
      if (method === 'prompt.submit' && params.session_id === writer && !refused) {
        refused = true
        if (code === 4001) roomSessions.delete(writer)
        throw Object.assign(new Error(code === 4001 ? 'session not found' : 'Fixture provider refusal'), { code })
      }
      if (method === 'session.resume' && params.session_id === session.storedId) {
        roomSessions.set(replacement, { ...session, status: 'idle' })
        return { session_id: replacement, session_key: session.storedId, info: { profile_name: session.profile } }
      }
      return previous(method, params)
    }
    await transport.sendMessage(room, '@Writer next explicit task')
    await drain()
    expect(getRoomView(room.id)?.handoffs.at(-1)?.status).toBe('error')
    const persisted = loadPersistedState()?.conversations.find(c => c.id === room.id)?.localRoom
    expect(persisted?.turns.at(-1)?.status).toBe('error')
    expect(persisted?.bindings['profile:default']?.closed).toBe(code === 4001)
    expect(await transport.retryTurn(room.id)).toBe(true)
    await drain()
    const expectedRuntime = code === 4001 ? replacement : writer
    expect(submitted().at(-1)!.params!.session_id).toBe(expectedRuntime)
    expect(calls.filter(c => c.method === 'session.resume')).toHaveLength(code === 4001 ? 1 : 0)
    expect(calls.filter(c => c.method === 'session.create')).toHaveLength(1)
    complete(expectedRuntime, 'Next answer', code === 4001 ? 1 : 4)
    await drain()
    expect(getMessagesForConversation(room.id).filter(m => m.role === 'user')).toHaveLength(2)
    expect(getMessagesForConversation(room.id).filter(m => m.content === 'Next answer')).toHaveLength(1)
    expect(getRoomView(room.id)?.turns).toEqual([])
  })

  it('a failed session binding is terminal and can be retried without creating duplicate bindings', async () => {
    const room = await team()
    const previous = rpc
    let fail = true
    rpc = (method, params) => {
      if (method === 'session.create' && fail) throw new Error('Fixture profile unavailable')
      return previous(method, params)
    }
    await transport.sendMessage(room, '@Writer fixture work')
    await drain()
    expect(getRoomView(room.id)?.handoffs[0]?.status).toBe('error')
    fail = false
    expect(await transport.retryTurn(room.id)).toBe(true)
    await drain()
    expect(submitted()).toHaveLength(1)
    expect(Object.values(getState().conversations.find(c => c.id === room.id)?.memberSessionIds ?? {})).toHaveLength(1)
  })

  it('native room attachments bind a member session and retain image/file chips and prompt paths', async () => {
    const room = await team()
    const binding = await transport.attachmentSession(room)
    expect(binding.profile).toBe('runner')
    await transport.sendMessage(room, '@Writer inspect fixture paths', {
      attachments: [
        { name: 'fixture.png', path: '/fake/fixture.png', kind: 'image' },
        { name: 'fixture.txt', path: '/fake/fixture.txt', kind: 'file' },
      ],
    })
    await drain()
    expect(submitted()[0]!.params!.text).toContain('/fake/fixture.png')
    expect(getMessagesForConversation(room.id).find(m => m.role === 'user')?.attachments?.map(a => a.kind)).toEqual(['image', 'file'])
  })

  it.each(['file', 'image'] as const)('accepts a caption-free room %s without losing its chip or prompt path', async kind => {
    const room = await team()
    await transport.attachmentSession(room)
    const attachment = { name: kind === 'image' ? 'fixture.png' : 'fixture.txt', path: `/fake/caption-free.${kind === 'image' ? 'png' : 'txt'}`, kind }
    await transport.sendMessage(room, '', { attachments: [attachment] })
    await drain()
    expect(submitted()).toHaveLength(1)
    expect(submitted()[0]!.params).toMatchObject({ profile: 'runner', text: expect.stringContaining(attachment.path) })
    expect(getMessagesForConversation(room.id).find(m => m.role === 'user'))
      .toMatchObject({ content: '', attachments: [expect.objectContaining(attachment)] })
    complete(String(submitted()[0]!.params!.session_id), 'Reviewed the attachment.', 1)
    await drain()
    expect(getRoomView(room.id)?.turns).toEqual([])
  })

  it('submits original quoted attachment paths to a fresh member after the shared backlog omits their row', async () => {
    const room = await team()
    const paths = [`/fake/${'reference-'.repeat(24)}image.png`, '/fake/reference  notes.txt']
    await transport.sendMessage(room, '', { attachments: paths.map(path => ({
      name: path.split('/').pop()!, path, kind: 'file' as const,
    })) })
    await drain()
    const original = getMessagesForConversation(room.id).find(m => m.role === 'user')!
    complete(String(submitted()[0]!.params!.session_id), 'Initial file summary.')
    for (let i = 0; i < 60; i++) await transport.sendMessage(room, `Unrelated backlog ${i}: ${'x'.repeat(1000)}`)
    await transport.sendMessage(room, '@Coder inspect the quoted files.', {
      replyTo: { id: original.id, role: 'user', snippet: '' },
    })
    await drain()
    const prompt = String(submitted().find(c => c.params!.profile === 'backend-eng')!.params!.text)
    expect(prompt).toContain('earlier messages omitted')
    expect(prompt).toContain('replying to User')
    expect(paths.every(path => prompt.includes(path))).toBe(true)
    expect(prompt.length).toBeLessThanOrEqual(24_000)
  })

  it('submits newest shared safety context despite metadata-heavy older attachments', async () => {
    const room = await team()
    for (let i = 0; i < 45; i++) await transport.sendMessage(room, `Older attachment update ${i}`, {
      attachments: Array.from({ length: 4 }, (_, j) => ({
        name: `reference-${i}-${j}.txt`, kind: 'file' as const,
        path: `/fake/${'directory/'.repeat(18)}${'reference-'.repeat(18)}${i}-${j}.txt`,
      })),
    })
    const latest = 'LATEST SAFETY: inspect only, make no writes.'
    await transport.sendMessage(room, latest)
    await transport.sendMessage(room, '@Coder use the latest safety constraint.')
    await drain()
    const prompt = String(submitted().find(c => c.params!.profile === 'backend-eng')!.params!.text)
    expect(prompt).toContain(`User: ${latest}`)
    expect(prompt).toContain('Older attachment update 44')
    expect(prompt).toContain('earlier messages omitted')
    expect(prompt.length).toBeLessThanOrEqual(24_000)
  })

  it('submits UTF-8-safe shared context when an emoji straddles the text preview limit', async () => {
    const room = await team()
    await transport.sendMessage(room, 'x'.repeat(3999) + '😀 tail')
    await transport.sendMessage(room, '@Coder inspect the earlier note.')
    await drain()
    const prompt = String(submitted().find(c => c.params!.profile === 'backend-eng')!.params!.text)
    expect(new TextDecoder().decode(new TextEncoder().encode(prompt))).toBe(prompt)
    expect(prompt).toContain('@Coder inspect the earlier note.')
    expect(prompt.length).toBeLessThanOrEqual(24_000)
  })

  it('rejects empty room sends without usable uploaded paths and preserves the caption length limit', async () => {
    const room = await team()
    for (const attachments of [undefined, [], [{ name: 'missing.txt', path: ' \t ', kind: 'file' as const }]]) {
      await expect(transport.sendMessage(room, ' \n ', { attachments })).rejects.toThrow(/Room messages/)
    }
    await expect(transport.sendMessage(room, 'x'.repeat(16_001), {
      attachments: [{ name: 'fixture.txt', path: '/fake/fixture.txt', kind: 'file' }],
    })).rejects.toThrow(/Room messages/)
    expect(calls.filter(c => c.method === 'session.create' || c.method === 'prompt.submit')).toEqual([])
    expect(getMessagesForConversation(room.id).some(m => m.role === 'user')).toBe(false)
  })

  it.each(['session.create', 'session.resume'])('rejects an attachment owner removed while %s is pending', async method => {
    const room = await team(['profile:default', 'profile:backend-eng'])
    const removeChief = () => setState({ agents: getState().agents.filter(a => a.id !== 'profile:runner') })
    removeChief()
    if (method === 'session.resume') {
      await transport.attachmentSession(room)
      transport.dispose()
      transport = new HermesLocalTransport({ getPrefs: () => prefs })
      await transport.listAgents()
      removeChief()
    }
    const previous = rpc
    let finishBinding!: () => void
    rpc = (name, params) => name === method && params.profile === 'default'
      ? new Promise(resolve => { finishBinding = () => resolve(previous(name, params)) })
      : previous(name, params)
    const preparing = transport.attachmentSession(room).then(() => null, error => error as Error)
    await drain()
    await transport.setGroupMembers(room.target.type === 'group' ? room.target.groupId : '', ['profile:backend-eng'])
    finishBinding()
    expect(await preparing).toMatchObject({ message: expect.stringMatching(/member|removed|changed/i) })
    const remaining = await transport.attachmentSession(room)
    expect(remaining.profile).toBe('backend-eng')
    expect(submitted()).toEqual([])
  })

  it('declines approval/question requests arriving after a room has been stopped', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer request ownership fixture')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    await transport.stopTurn(room.id)
    push({ jsonrpc: '2.0', id: 'late-approval', method: 'approval', params: { session_id: writer, command: 'late fixture', choices: ['once', 'deny'] } })
    push({ jsonrpc: '2.0', id: 'late-question', method: 'clarify', params: { session_id: writer, question: 'Late fixture?', choices: ['yes', 'no'] } })
    expect(getPendingToolPermission()).toBeNull()
    expect(getAgentPrompts()).toEqual([])
    expect(responses.filter(r => r.error).map(r => r.id)).toEqual(['late-approval', 'late-question'])
  })

  it.each(['stopped', 'closed', 'removed'].flatMap(state =>
    ['approval.request', 'clarify.request'].map(type => ({ state, type }))))(
    'ignores late legacy $type from a $state room member', async ({ state, type }) => {
      const room = await team()
      await transport.sendMessage(room, '@Writer legacy lifecycle fixture')
      await drain()
      const writer = String(submitted()[0]!.params!.session_id)
      if (state === 'stopped') await transport.stopTurn(room.id)
      else if (state === 'closed') roomEvent(writer, 'session.closed', {}, 1)
      else await transport.setGroupMembers(room.target.type === 'group' ? room.target.groupId : '',
        ['profile:runner', 'profile:backend-eng'])
      roomEvent(writer, type, {
        request_id: 'late-legacy', command: 'echo legacy fixture', question: 'Late legacy question?',
        choices: type === 'approval.request' ? ['once', 'deny'] : ['yes', 'no'],
      }, 2)
      await drain()
      expect(getPendingToolPermission()).toBeNull()
      expect(getAgentPrompts()).toEqual([])
      expect(calls.filter(c => c.method === 'approval.respond' || c.method === 'clarify.respond')).toEqual([])
    })

  it.each(['approval.request', 'clarify.request'])('clears an active legacy %s when its room member stops', async type => {
    const room = await team()
    await transport.sendMessage(room, '@Writer active legacy fixture')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    roomEvent(writer, type, {
      request_id: 'active-legacy', command: 'echo active legacy fixture', question: 'Active legacy question?',
      choices: type === 'approval.request' ? ['once', 'deny'] : ['yes', 'no'],
    }, 1)
    if (type === 'approval.request') expect(getPendingToolPermission()?.sessionId).toBe(writer)
    else expect(getAgentPrompts()).toContainEqual(expect.objectContaining({ requestId: 'active-legacy', sessionId: writer }))
    await transport.stopTurn(room.id)
    expect(getPendingToolPermission()).toBeNull()
    expect(getAgentPrompts()).toEqual([])
    await transport.respondPermission(room.id, 'once')
    expect(calls.filter(c => c.method === 'approval.respond' || c.method === 'clarify.respond')).toEqual([])
  })

  it('attributes parallel legacy group questions to their owning members without crossing answers', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer first question owner')
    await transport.sendMessage(room, '@Coder second question owner')
    await drain()
    const writer = String(submitted().find(c => c.params!.profile === 'default')!.params!.session_id)
    const coder = String(submitted().find(c => c.params!.profile === 'backend-eng')!.params!.session_id)
    roomEvent(writer, 'clarify.request', { request_id: 'legacy-writer', question: 'Writer question?', choices: ['yes'] }, 1)
    roomEvent(coder, 'clarify.request', { request_id: 'legacy-coder', question: 'Coder question?', choices: ['no'] }, 1)
    expect(getAgentPrompts()).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: 'legacy-writer', memberId: 'profile:default', memberName: 'Writer', sessionId: writer }),
      expect.objectContaining({ requestId: 'legacy-coder', memberId: 'profile:backend-eng', memberName: 'Coder', sessionId: coder }),
    ]))
    expect(await answerAgentPrompt('legacy-writer', { kind: 'clarify', answers: [{ answer: 'yes' }] })).toBe(true)
    expect(calls.filter(c => c.method === 'clarify.respond').map(c => c.params))
      .toEqual([{ request_id: 'legacy-writer', answer: 'yes' }])
    complete(writer, 'Writer settled', 2)
    expect(getAgentPrompts()).toContainEqual(expect.objectContaining({ requestId: 'legacy-coder', memberName: 'Coder', status: 'pending' }))
    complete(coder, 'Coder settled', 2)
    await drain()
    expect(getAgentPrompts()).toEqual([])
  })

  it('reconciles an uncertain prompt acknowledgement instead of retrying accepted work', async () => {
    const room = await team()
    const previous = rpc
    rpc = (method, params) => {
      const result = previous(method, params)
      if (method === 'prompt.submit') throw new Error('Fixture response timeout after acceptance')
      return result
    }
    await transport.sendMessage(room, '@Writer uncertain submit fixture')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    complete(writer, 'Actually completed')
    await drain()
    expect(getMessagesForConversation(room.id).filter(m => m.content === 'Actually completed')).toHaveLength(1)
    expect(await transport.retryTurn(room.id)).toBe(false)
    expect(submitted()).toHaveLength(1)
  })

  it.each(['socket close', 'request timeout'])('keeps accepted work reconciling after native %s', async failure => {
    const room = await team()
    const previous = rpc
    let finishAck!: () => void
    rpc = (method, params) => {
      const result = previous(method, params)
      return method === 'prompt.submit'
        ? new Promise(resolve => { finishAck = () => resolve(result) })
        : result
    }
    await transport.sendMessage(room, '@Writer accepted before acknowledgement loss')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    if (failure === 'socket close') closeSocket()
    else await vi.advanceTimersByTimeAsync(120_000)
    await drain()
    expect(getRoomView(room.id)?.turns).toHaveLength(1)
    expect(getState().conversations.find(c => c.id === room.id)?.localRoom?.bindings['profile:default']?.blocked).toBe(true)
    expect(await transport.retryTurn(room.id)).toBe(false)
    complete(writer, 'Completed accepted work')
    await drain()
    finishAck()
    await drain()
    expect(getMessagesForConversation(room.id).filter(m => m.content === 'Completed accepted work')).toHaveLength(1)
    expect(getMessagesForConversation(room.id).filter(m => m.role === 'user')).toHaveLength(1)
    expect(getRoomView(room.id)?.turns).toEqual([])
    expect(submitted()).toHaveLength(1)
  })

  it.each(['rejection', 'nonstreaming acknowledgement', 'successful acknowledgement'])(
    'ignores an older attempt %s while retry is binding', async reply => {
      const room = await team()
      const previous = rpc
      let finishOriginal!: () => void
      let finishResume!: () => void
      rpc = (method, params) => {
        if (method === 'session.resume' && params.profile === 'default') {
          const session = [...roomSessions.values()].find(s => s.profile === 'default')!
          return new Promise(resolve => { finishResume = () => {
            roomSessions.set('retry-runtime', { ...session, status: 'idle' })
            resolve({ session_id: 'retry-runtime', session_key: session.storedId, info: { profile_name: session.profile } })
          } })
        }
        const result = previous(method, params)
        if (method === 'prompt.submit' && params.session_id !== 'retry-runtime')
          return new Promise((resolve, reject) => { finishOriginal = () => reply === 'rejection'
            ? reject(new Error('Old attempt rejected'))
            : resolve(reply === 'successful acknowledgement' ? result : { status: 'unknown' }) })
        return result
      }
      await transport.sendMessage(room, '@Writer attempt ownership fixture')
      await drain()
      const writer = String(submitted()[0]!.params!.session_id)
      roomSessions.get(writer)!.status = 'idle'
      roomEvent(writer, 'message.complete', { status: 'error', error: 'Original attempt failed' }, 1)
      roomEvent(writer, 'session.closed', {}, 2)
      expect(await transport.retryTurn(room.id)).toBe(true)
      await drain()
      finishOriginal()
      await drain()
      expect(getRoomView(room.id)?.turns).toHaveLength(1)
      let repeatedRetry: boolean | undefined
      const repeated = transport.retryTurn(room.id).then(result => { repeatedRetry = result })
      await drain()
      expect(repeatedRetry).toBe(false)
      finishResume()
      await repeated
      await drain()
      complete('retry-runtime', 'Retry attempt answer', 1)
      await drain()
      expect(submitted()).toHaveLength(2)
      expect(getMessagesForConversation(room.id).filter(m => m.role === 'user')).toHaveLength(1)
      expect(getMessagesForConversation(room.id).filter(m => m.content === 'Retry attempt answer')).toHaveLength(1)
      expect(getRoomView(room.id)?.turns).toEqual([])
    })

  it.each(['result', 'rejection'] as const)(
    'does not redirect a pending public Retry to a newer failed ask after old replay %s',
    async reply => {
      const room = await team()
      await transport.sendMessage(room, '@Writer @Coder original public retry target')
      await drain()
      const writer = String(submitted()[0]!.params!.session_id)
      roomSessions.get(writer)!.status = 'idle'
      roomEvent(writer, 'message.complete', { status: 'error', error: 'Original writer failure' }, 1)
      await drain()
      const coder = String(submitted()[1]!.params!.session_id), previous = rpc
      let hold = true, finishReplay!: () => void
      rpc = (method, params) => {
        const result = previous(method, params)
        if (hold && method === 'session.events.since' && params.session_id === coder)
          return new Promise((resolve, reject) => { finishReplay = () => reply === 'rejection'
            ? reject(new Error('Retired public replay failed'))
            : resolve(result) })
        return result
      }
      const pending = transport.retryTurn(room.id)
      await drain()
      expect(finishReplay).toBeTypeOf('function')
      hold = false
      event('gateway.ready', { replay_epoch: 'newer-public-retry-epoch', skin: {} })
      await drain()
      complete(coder, 'Original peer settled', 3)
      await drain()
      await transport.sendMessage(room, '@Writer newer public ask must not be retried')
      await drain()
      expect(submitted()).toHaveLength(3)
      roomSessions.get(writer)!.status = 'idle'
      roomEvent(writer, 'message.complete', { status: 'error', error: 'Newer public writer failure' }, 2)
      await drain()
      const before = structuredClone(getState().conversations.find(c => c.id === room.id)!.localRoom!)
      const transcript = structuredClone(getMessagesForConversation(room.id))
      const persisted = structuredClone(loadPersistedState()?.conversations.find(c => c.id === room.id)?.localRoom)
      expect(before.turns.at(-1)).toMatchObject({ status: 'error', error: 'Newer public writer failure' })
      expect(persisted).toEqual(before)
      finishReplay()
      expect(await pending).toBe(false)
      await drain()
      expect(submitted()).toHaveLength(3)
      expect(getState().conversations.find(c => c.id === room.id)!.localRoom).toEqual(before)
      expect(loadPersistedState()?.conversations.find(c => c.id === room.id)?.localRoom).toEqual(persisted)
      expect(getMessagesForConversation(room.id)).toEqual(transcript)
    },
  )

  it('refuses room execution when the durable routing journal cannot be saved', async () => {
    const room = await team()
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Fixture quota full', 'QuotaExceededError') })
    try {
      await expect(transport.sendMessage(room, '@Writer durable fixture')).rejects.toThrow(/persist|sav|storage/i)
      await drain()
      expect(submitted()).toEqual([])
      expect(getRoomView(room.id)?.turns).toEqual([])
    } finally { storage.mockRestore() }
  })

  it.each(['delegation', 'wrap'] as const)('does not execute an unsaved generated %s through real storage and transport', async path => {
    const room = await team()
    await transport.sendMessage(room, 'Investigate the durable fixture', { echoId: 'durable-fixture-root' })
    await drain()
    const chief = String(submitted()[0]!.params!.session_id)
    if (path === 'wrap') {
      complete(chief, '@Writer investigate the delegated fixture')
      await drain()
    }
    const callsBefore = calls.length
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Fixture quota full', 'QuotaExceededError')
    })
    try {
      if (path === 'delegation') complete(chief, '@Writer investigate the delegated fixture')
      else complete(String(submitted()[1]!.params!.session_id), 'Durable specialist result')
      await drain()
      expect(calls.slice(callsBefore).filter(c => ['session.create', 'session.resume', 'prompt.submit'].includes(c.method!))).toEqual([])
      const journal = getState().conversations.find(c => c.id === room.id)!.localRoom!
      expect(journal.turns.at(-1)).toMatchObject({ status: 'queued', kind: path === 'wrap' ? 'wrap' : 'reply' })
      expect(journal.turns.slice(0, -1).every(t => t.status === 'sent')).toBe(true)
      expect(getMessagesForConversation(room.id).filter(m => m.role === 'user')).toHaveLength(1)
    } finally { storage.mockRestore() }

    const pending = getState().conversations.find(c => c.id === room.id)!.localRoom!.turns.at(-1)!
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls.slice(callsBefore).filter(c => ['session.create', 'session.resume', 'prompt.submit'].includes(c.method!))).toEqual([])
    // The supported chat-list recovery path must flush before dispatching.
    await transport.listConversations()
    await drain()
    await transport.listConversations()
    await drain()
    expect(submitted()).toHaveLength(path === 'wrap' ? 3 : 2)
    const persisted = loadPersistedState()?.conversations.find(c => c.id === room.id)?.localRoom
    expect(persisted?.turns.at(-1)).toMatchObject({
      id: pending.id, rootId: pending.rootId, triggerId: pending.triggerId, memberId: pending.memberId, status: 'running',
    })
    expect(persisted?.messages.filter(m => m.speakerKind === 'human')).toHaveLength(1)
    expect(persisted?.messages.some(m => m.text === '@Writer investigate the delegated fixture')).toBe(true)
    expect(persisted?.bindings['profile:runner']?.runtimeId).toBe(chief)
  })

  it('recovers a binding whose real storage write failed without creating a second backend session', async () => {
    const room = await team()
    const previous = rpc
    let storage: ReturnType<typeof vi.spyOn> | undefined
    rpc = (method, params) => {
      const result = previous(method, params)
      if (method === 'session.create') storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('Fixture quota full', 'QuotaExceededError')
      })
      return result
    }
    try {
      await transport.sendMessage(room, '@Writer binding durability fixture')
      await drain()
      expect(submitted()).toEqual([])
      expect(getState().conversations.find(c => c.id === room.id)?.localRoom?.turns[0]).toMatchObject({ status: 'queued' })
    } finally { storage?.mockRestore() }
    const binding = getState().conversations.find(c => c.id === room.id)!.localRoom!.bindings['profile:default']!
    await transport.listConversations()
    await drain()
    await transport.listConversations()
    await drain()
    expect(calls.filter(c => c.method === 'session.create')).toHaveLength(1)
    expect(submitted()).toHaveLength(1)
    expect(submitted()[0]?.params).toMatchObject({ profile: binding.profile, session_id: binding.runtimeId })
    expect(loadPersistedState()?.conversations.find(c => c.id === room.id)?.localRoom?.bindings['profile:default']?.storedId).toBe(binding.storedId)
    expect(getMessagesForConversation(room.id).filter(m => m.role === 'user')).toHaveLength(1)
  })

  it('rejects a room retry when its journal cannot be saved, then retries once after storage recovers', async () => {
    const room = await team()
    const previous = rpc
    let failBinding = true
    rpc = (method, params) => {
      if (method === 'session.create' && failBinding) throw new Error('Fixture profile unavailable')
      return previous(method, params)
    }
    await transport.sendMessage(room, '@Writer retry durability fixture')
    await drain()
    const before = getState().conversations.find(c => c.id === room.id)!.localRoom
    expect(before?.turns[0]?.status).toBe('error')
    failBinding = false
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Fixture quota full', 'QuotaExceededError')
    })
    try {
      expect(await transport.retryTurn(room.id)).toBe(false)
      await drain()
      expect(submitted()).toEqual([])
      expect(getState().conversations.find(c => c.id === room.id)?.localRoom).toEqual(before)
      expect(getRoomView(room.id)?.recent[0]).toMatchObject({ status: 'error', retryable: true })
      expect(getRoomView(room.id)?.turns).toEqual([])
    } finally { storage.mockRestore() }

    expect(await transport.retryTurn(room.id)).toBe(true)
    await drain()
    expect(submitted()).toHaveLength(1)
    expect(loadPersistedState()?.conversations.find(c => c.id === room.id)?.localRoom?.turns[0])
      .toMatchObject({ id: before!.turns[0]!.id, status: 'running', attempts: [{ status: 'error' }] })
    expect(getMessagesForConversation(room.id).filter(m => m.role === 'user')).toHaveLength(1)
  })

  it('settles lost contact explicitly without leaving an active indicator or resubmitting', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer lost contact fixture')
    await drain()
    const previous = rpc
    rpc = (method, params) => {
      if (method === 'session.events.since' || method === 'session.active_list') throw new Error('Fixture liveness unavailable')
      return previous(method, params)
    }
    await vi.advanceTimersByTimeAsync(8 * 60_000 + 30_000)
    expect(getRoomView(room.id)?.turns).toEqual([])
    expect(getRoomView(room.id)?.handoffs[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/lost contact/i) })
    expect(submitted()).toHaveLength(1)
  })

  it('cuts off a hung member only at the three-hour hard backstop, not the old work limit', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer hard backstop fixture')
    await drain()
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000 + 30_000)
    expect(getRoomView(room.id)?.turns).toEqual([])
    expect(getRoomView(room.id)?.handoffs[0]?.status).toBe('timeout')
    expect(calls.filter(c => c.method === 'session.interrupt')).toHaveLength(1)
  })

  it('reconciles expired room member requests on reconnect without clearing a sibling live request', async () => {
    const { room, writer, coder } = await delegated()
    push({ jsonrpc: '2.0', id: 'expired-writer', method: 'approval', params: { session_id: writer, command: 'fixture', choices: ['once', 'deny'] } })
    push({ jsonrpc: '2.0', id: 'live-coder', method: 'clarify', params: { session_id: coder, question: 'Fixture question?', choices: ['yes'] } })
    const previous = rpc
    rpc = (method, params) => {
      const result = previous(method, params)
      if (method === 'session.events.since' && params.session_id === coder) return {
        ...(result as object), open_requests: [{ id: 'live-coder', method: 'clarify', params: { session_id: coder, question: 'Fixture question?', choices: ['yes'] } }],
      }
      return result
    }
    closeSocket()
    await transport.retryConnection()
    await drain()
    expect(getPendingToolPermission()).toBeNull()
    expect(getAgentPrompts().map(p => p.requestId)).toEqual(['live-coder'])
    expect(getAgentPrompts()[0]?.conversationId).toBe(room.id)
  })

  it('a session close reconciles its room turn immediately and does not create a ghost', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer close fixture')
    await drain()
    roomEvent(String(submitted()[0]!.params!.session_id), 'session.closed', { reason: 'idle_timeout' }, 1)
    expect(getRoomView(room.id)?.turns).toEqual([])
    expect(getRoomView(room.id)?.handoffs[0]?.status).toBe('cancelled')
  })

  it.each(['running', 'idle', 'stopped'] as const)('resumes a closed %s member with a new runtime cursor, preserving its stored binding', async state => {
    const room = await team()
    await transport.sendMessage(room, '@Writer first task')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    roomEvent(writer, 'message.delta', { text: 'Old partial' }, 8)
    if (state === 'idle') complete(writer, 'First answer', 9)
    if (state === 'stopped') await transport.stopTurn(room.id)
    roomEvent(writer, 'session.closed', { reason: 'idle_timeout' }, 10)
    const previousSession = roomSessions.get(writer)!
    roomSessions.delete(writer)
    const replacement = `reminted-${writer}`
    const previous = rpc
    rpc = (method, params) => {
      if (method === 'session.resume' && params.session_id === previousSession.storedId) {
        roomSessions.set(replacement, { ...previousSession, status: 'idle' })
        return { session_id: replacement, session_key: previousSession.storedId, info: { profile_name: previousSession.profile } }
      }
      return previous(method, params)
    }
    await transport.sendMessage(room, '@Writer second task')
    await drain()
    expect(getState().conversations.find(c => c.id === room.id)?.localRoom?.bindings['profile:default'])
      .toMatchObject({ storedId: previousSession.storedId, runtimeId: replacement })
    roomEvent(replacement, 'message.delta', { text: 'New answer' }, 1)
    expect(getMessagesForConversation(room.id).findLast(m => m.streaming)?.content).toBe('New answer')
    complete(replacement, 'New answer', 2)
    await drain()
    expect(getMessagesForConversation(room.id).filter(m => m.content === 'New answer')).toHaveLength(1)
    expect(getRoomView(room.id)?.turns).toEqual([])
    expect(submitted()).toHaveLength(2)
    expect(calls.filter(c => c.method === 'session.create')).toHaveLength(1)
  })

  it.each(['message.delta', 'message.complete', 'approval', 'clarify'])('ignores late %s from a closed room runtime while its replacement is binding', async type => {
    const room = await team()
    await transport.sendMessage(room, '@Writer first task')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    const previousSession = roomSessions.get(writer)!
    roomEvent(writer, 'session.closed', { reason: 'idle_timeout' }, 1)
    expect(loadPersistedState()?.conversations.find(c => c.id === room.id)?.localRoom?.bindings['profile:default']?.closed).toBe(true)
    roomSessions.delete(writer)
    const previous = rpc
    let resume!: (value: unknown) => void
    rpc = (method, params) => method === 'session.resume' && params.session_id === previousSession.storedId
      ? new Promise(resolve => { resume = resolve }) : previous(method, params)
    await transport.sendMessage(room, '@Writer second task')
    await drain()
    const requestId = `late-${type}`
    const isRequest = type === 'approval' || type === 'clarify'
    if (isRequest) push({ jsonrpc: '2.0', id: requestId, method: type, params: {
      session_id: writer, command: 'echo late fixture', question: 'Late question',
      choices: type === 'approval' ? ['once', 'deny'] : ['yes', 'no'],
    } })
    else roomEvent(writer, type, { text: 'Late stale answer', status: 'complete' }, 2)
    const ghost = getMessagesForConversation(room.id).some(m => m.content.includes('Late stale'))
    const approval = getPendingToolPermission()
    const questions = getAgentPrompts()
    const replacement = `reminted-${writer}`
    roomSessions.set(replacement, { ...previousSession, status: 'idle' })
    resume({ session_id: replacement, session_key: previousSession.storedId, info: { profile_name: previousSession.profile } })
    await drain()
    expect(loadPersistedState()?.conversations.find(c => c.id === room.id)?.localRoom?.bindings['profile:default']?.closed).toBe(false)
    expect(ghost).toBe(false)
    expect(approval).toBeNull()
    expect(questions).toEqual([])
    if (isRequest) expect(responses.find(r => r.id === requestId)?.error?.code).toBe(-32000)
    expect(submitted()).toHaveLength(2)
    roomEvent(replacement, 'message.delta', { text: 'Current result' }, 1)
    complete(replacement, 'Current result', 2)
    await drain()
    expect(getMessagesForConversation(room.id).filter(m => m.content === 'Current result')).toHaveLength(1)
    expect(getRoomView(room.id)?.turns).toEqual([])
  })

  it('does not retry an uncertain idle outcome that might already have completed on serve', async () => {
    const room = await team()
    await transport.sendMessage(room, '@Writer uncertain terminal fixture')
    await drain()
    const writer = String(submitted()[0]!.params!.session_id)
    roomSessions.get(writer)!.status = 'idle'
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getRoomView(room.id)?.turns).toEqual([])
    expect(await transport.retryTurn(room.id)).toBe(false)
    expect(submitted()).toHaveLength(1)
  })

  it('disposing during a member binding does not tombstone the surviving room', async () => {
    const room = await team()
    const previous = rpc
    let resolve!: (value: unknown) => void
    rpc = (method, params) => method === 'session.create' ? new Promise(r => { resolve = r }) : previous(method, params)
    await transport.sendMessage(room, 'binding disposal fixture')
    await drain()
    transport.dispose()
    resolve({ session_id: 'disposed-runtime', stored_session_id: 'disposed-stored', info: { profile_name: 'runner' } })
    await drain()
    expect(isDeletedConversation(room.id)).toBe(false)
    expect(submitted()).toEqual([])
  })
})

describe('local stale stream recovery', () => {
  it('submits a follow-up once when an idle backend rejects steering the stale reply', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Synthetic earlier turn')
    event('tool.start', { tool_id: 'finished-tool', name: 'terminal' }, 1)
    const previousReply = getMessagesForConversation(conv.id).find(message => message.role === 'agent')!
    const previous = rpc
    rpc = (method, params) => method === 'session.steer' ? { status: 'rejected' } : previous(method, params)

    const sent = await transport.sendMessage(conv, 'Synthetic follow-up')
    flushMessagePatches()
    const submits = calls.filter(call => call.method === 'prompt.submit')
    expect(submits).toHaveLength(2)
    expect(submits[1].params).toMatchObject({
      session_id: 'runtime-runner', profile: 'runner', text: 'Synthetic follow-up',
    })
    expect(getMessagesForConversation(conv.id).filter(message => message.content === 'Synthetic follow-up')).toHaveLength(1)
    expect(getMessagesForConversation(conv.id).find(message => message.id === previousReply.id)).toMatchObject({
      streaming: false, error: true, toolEvents: [expect.objectContaining({ status: 'failed' })],
    })
    expect(getMessagesForConversation(conv.id).at(-1)).toMatchObject({ role: 'agent', streaming: true, turnId: sent.turnId })
    expect(sent.turnId).not.toBe(previousReply.turnId)
    expect(calls.filter(call => call.method === 'session.interrupt')).toEqual([])

    event('message.complete', { status: 'complete', text: 'Synthetic follow-up answered' }, 2)
    expect(getState().turnsById[sent.turnId].phase).toBe('done')
  })

  it.each([false, true])('recovers a missed completion with a later live watermark=%s', async (laterFrame) => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Synthetic reply whose completion was missed')
    event('tool.start', { tool_id: 'finished-tool', name: 'terminal' }, 1)
    if (laterFrame) event('session.usage', { cost_usd: 0.001 }, 3)
    const reply = getMessagesForConversation(conv.id).find(message => message.role === 'agent')!
    const previous = rpc
    rpc = (method, params) => {
      if (method === 'session.active_list') return { sessions: [{ id: 'runtime-runner', status: 'idle' }] }
      if (method === 'session.events.since') return {
        events: [{
          type: 'message.complete', session_id: 'runtime-runner', seq: 2,
          payload: { status: 'complete', text: 'The completed synthetic answer' },
        }],
        latest_seq: 2, truncated: false, epoch: 'fake-epoch-1', open_requests: [],
      }
      return previous(method, params)
    }

    await vi.advanceTimersByTimeAsync(120_001)
    flushMessagePatches()
    expect(getMessagesForConversation(conv.id).find(message => message.id === reply.id)).toMatchObject({
      streaming: false, error: false, content: 'The completed synthetic answer',
      toolEvents: [expect.objectContaining({ status: 'completed' })],
    })
    expect(getState().turnsById[reply.turnId!].phase).toBe('done')
    expect(calls.find(call => call.method === 'session.active_list')?.params).toEqual({ profile: 'runner' })
    expect(calls.find(call => call.method === 'session.events.since')?.params).toEqual({
      session_id: 'runtime-runner', profile: 'runner', last_seen: 0,
    })
    expect(calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
    expect(calls.filter(call => ['session.interrupt', 'session.history'].includes(call.method!))).toEqual([])
  })

  it.each(['queued', 'redirected'])('keeps an accepted %s steer on the existing turn', async (status) => {
    const conv = await conversation()
    const first = await transport.sendMessage(conv, 'Synthetic running turn')
    event('tool.start', { tool_id: 'live-tool', name: 'terminal' }, 1)
    const previous = rpc
    rpc = (method, params) => method === 'session.steer' ? { status } : previous(method, params)
    const next = await transport.sendMessage(conv, 'Synthetic accepted correction')
    flushMessagePatches()
    expect(next.turnId).toBe(first.turnId)
    expect(calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'session.steer')).toHaveLength(1)
    expect(getMessagesForConversation(conv.id).filter(message => message.role === 'agent')).toEqual([
      expect.objectContaining({ streaming: true, turnId: first.turnId }),
    ])
    expect(calls.filter(call => call.method === 'session.interrupt')).toEqual([])
  })

  it.each([null, {}, { status: 'unknown' }])('does not resubmit after an ambiguous steer acknowledgement %j', async (result) => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Synthetic running turn')
    event('tool.start', { tool_id: 'live-tool', name: 'terminal' }, 1)
    const previous = rpc
    rpc = (method, params) => method === 'session.steer' ? result : previous(method, params)
    await expect(transport.sendMessage(conv, 'Synthetic ambiguous correction')).rejects.toThrow()
    flushMessagePatches()
    expect(calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'session.interrupt')).toEqual([])
    expect(getMessagesForConversation(conv.id).find(message => message.role === 'agent')).toMatchObject({
      streaming: true, toolEvents: [expect.objectContaining({ status: 'running' })],
    })
  })

  it('keeps attachment and quoted-reply context on the rejected-steer fallback', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Synthetic earlier turn')
    const previous = rpc
    rpc = (method, params) => method === 'session.steer' ? { status: 'rejected' } : previous(method, params)
    const options = {
      attachments: [{ name: 'notes.txt', path: '/fake/uploaded/notes.txt', kind: 'file' as const }],
      replyTo: { id: 'synthetic-parent', role: 'agent' as const, snippet: 'Synthetic quoted question' },
    }
    await transport.sendMessage(conv, 'Synthetic attached answer', options)
    const submit = calls.filter(call => call.method === 'prompt.submit').at(-1)!
    expect(submit.params?.text).toContain('Synthetic attached answer')
    expect(submit.params?.text).toContain('/fake/uploaded/notes.txt')
    expect(submit.params?.text).toContain('Synthetic quoted question')
    expect(getMessagesForConversation(conv.id).filter(message => message.content === 'Synthetic attached answer')).toEqual([
      expect.objectContaining({ replyTo: options.replyTo, attachments: [expect.objectContaining(options.attachments[0])] }),
    ])
  })

  it('does not submit or settle a reply that changed while a rejected steer was pending', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Synthetic running turn')
    let resolve!: (value: unknown) => void
    const held = new Promise(yes => { resolve = yes })
    const previous = rpc
    rpc = (method, params) => method === 'session.steer' ? held : previous(method, params)
    const send = transport.sendMessage(conv, 'Synthetic racing follow-up')
    const outcome = send.then(() => 'sent', error => error.message)
    await vi.advanceTimersByTimeAsync(0)
    event('message.delta', { text: 'The original turn is still alive' }, 1)
    resolve({ status: 'rejected' })
    expect(await outcome).toMatch(/reply changed.*try sending again/i)
    expect(calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'session.interrupt')).toEqual([])
    expect(getMessagesForConversation(conv.id).find(message => message.role === 'agent')).toMatchObject({
      streaming: true, content: 'The original turn is still alive',
    })
  })

  it('does not recover another session or infer idle from a missing live row', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Synthetic running tool')
    event('tool.start', { tool_id: 'live-tool', name: 'terminal' }, 1)
    const previous = rpc
    rpc = (method, params) => method === 'session.active_list'
      ? { sessions: [{ id: 'foreign-runtime', status: 'idle' }] }
      : previous(method, params)
    await vi.advanceTimersByTimeAsync(120_001)
    expect(getMessagesForConversation(conv.id).find(message => message.role === 'agent')?.streaming).toBe(true)
    expect(calls.filter(call => ['session.events.since', 'session.interrupt'].includes(call.method!))).toEqual([])
  })

  it('settles an authoritatively idle tool hang with no retained completion, without interrupting it', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Synthetic finished turn whose replay expired')
    event('tool.start', { tool_id: 'finished-tool', name: 'terminal' }, 1)
    const previous = rpc
    rpc = (method, params) => method === 'session.active_list'
      ? { sessions: [{ id: 'runtime-runner', status: 'idle' }] }
      : previous(method, params)
    await vi.advanceTimersByTimeAsync(120_001)
    flushMessagePatches()
    expect(getMessagesForConversation(conv.id).find(message => message.role === 'agent')).toMatchObject({
      streaming: false, error: true, toolEvents: [expect.objectContaining({ status: 'failed' })],
    })
    expect(calls.filter(call => call.method === 'session.interrupt')).toEqual([])
    expect(calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
  })

  it.each(['message', 'approval', 'delete', 'dispose'])('ignores a stale idle snapshot after %s', async (change) => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Synthetic running turn')
    event('tool.start', { tool_id: 'live-tool', name: 'terminal' }, 1)
    let resolve!: (value: unknown) => void
    const held = new Promise(yes => { resolve = yes })
    const previous = rpc
    rpc = (method, params) => method === 'session.active_list' ? held : previous(method, params)
    await vi.advanceTimersByTimeAsync(120_001)
    expect(calls.filter(call => call.method === 'session.active_list')).toHaveLength(1)
    if (change === 'message') event('message.delta', { text: 'Fresh progress' }, 2)
    if (change === 'approval') push(lines(requestFixture)[0])
    if (change === 'delete') deleteConversation(conv.id)
    if (change === 'dispose') transport.dispose()
    resolve({ sessions: [{ id: 'runtime-runner', status: 'idle' }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.filter(call => ['session.events.since', 'session.interrupt'].includes(call.method!))).toEqual([])
    if (change === 'delete') expect(getMessagesForConversation(conv.id)).toEqual([])
    else expect(getMessagesForConversation(conv.id).find(message => message.role === 'agent')?.streaming).toBe(true)
    if (change === 'approval') expect(getPendingToolPermission()).toMatchObject({ id: 'srq-approval', status: 'pending' })
  })

  it.each(['new-turn', 'approval', 'epoch'])('does not apply old replay after %s', async (change) => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Synthetic old turn')
    event('tool.start', { tool_id: 'finished-tool', name: 'terminal' }, 1)
    let resolve!: (value: unknown) => void
    const held = new Promise(yes => { resolve = yes })
    const previous = rpc
    let replayReads = 0
    rpc = (method, params) => {
      if (method === 'session.active_list') return { sessions: [{ id: 'runtime-runner', status: 'idle' }] }
      if (method === 'session.events.since') {
        if (++replayReads === 1) return held
        return { events: [], latest_seq: 0, truncated: false, epoch: 'fake-epoch-2', open_requests: [] }
      }
      return previous(method, params)
    }
    await vi.advanceTimersByTimeAsync(120_001)
    if (change === 'new-turn') {
      event('message.complete', { status: 'complete', text: 'Synthetic old completion' }, 2)
      await transport.sendMessage(conv, 'Synthetic new turn')
    }
    if (change === 'approval') push(lines(requestFixture)[0])
    if (change === 'epoch') {
      push({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'fake-epoch-2' } } })
    }
    resolve({
      events: [{ type: 'message.complete', session_id: 'runtime-runner', seq: 2, payload: { status: 'complete', text: 'Stale replay answer' } }],
      latest_seq: 2, truncated: false, epoch: 'fake-epoch-1', open_requests: [],
    })
    await vi.advanceTimersByTimeAsync(0)
    flushMessagePatches()
    expect(getMessagesForConversation(conv.id).some(message => message.content === 'Stale replay answer')).toBe(false)
    expect(getMessagesForConversation(conv.id).at(-1)?.streaming).toBe(true)
    expect(calls.filter(call => call.method === 'session.interrupt')).toEqual([])
    if (change === 'approval') expect(getPendingToolPermission()).toMatchObject({ id: 'srq-approval', status: 'pending' })
  })

  it('bounds an unavailable idle probe and retains the running-tool safeguard', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Synthetic live tool with an unavailable status probe')
    event('tool.start', { tool_id: 'live-tool', name: 'terminal' }, 1)
    const previous = rpc
    rpc = (method, params) => method === 'session.active_list' ? new Promise(() => {}) : previous(method, params)
    await vi.advanceTimersByTimeAsync(125_001)
    expect(getMessagesForConversation(conv.id).find(message => message.role === 'agent')?.streaming).toBe(true)
    expect(calls.filter(call => call.method === 'session.active_list')).toHaveLength(1)
    expect(calls.filter(call => ['session.events.since', 'session.interrupt'].includes(call.method!))).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls.filter(call => call.method === 'session.active_list')).toHaveLength(2)
  })
})

describe('deleted local conversation ownership', () => {
  const binding = {
    session_id: 'runtime-runner', stored_session_id: 'stored-runner', info: { profile_name: 'runner' },
  }

  function holdRpc(method: string) {
    const previous = rpc
    let resolve!: (value: unknown) => void
    let reject!: (error: Error) => void
    const held = new Promise((yes, no) => { resolve = yes; reject = no })
    rpc = (name, params) => name === method ? held : previous(name, params)
    return { resolve, reject }
  }

  it.each([false, true])('refuses a captured send after deletion with an existing binding=%s', async bound => {
    const conv = await conversation()
    if (bound) {
      await transport.sendMessage(conv, 'Synthetic earlier turn.')
      event('message.complete', { status: 'complete', text: 'Synthetic earlier reply.' })
    }
    deleteConversation(conv.id)
    calls.length = 0
    const accepted = await transport.sendMessage(conv, 'Synthetic deleted-chat send.').then(() => true, () => false)
    expect(accepted).toBe(false)
    expect(calls.filter(call => ['session.create', 'session.resume', 'prompt.submit'].includes(call.method!))).toEqual([])
    expect(getState().messagesByThreadId[conv.id]).toBeUndefined()
  })

  it.each(['session.create', 'session.resume'])('does not submit or publish a binding after deletion during %s', async method => {
    const conv = method === 'session.create' ? await conversation()
      : (await transport.listConversations()).find(row => row.agentId === 'profile:runner')!
    const held = holdRpc(method)
    const sending = transport.sendMessage(conv, 'Synthetic pending send.').then(() => true, () => false)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toContainEqual(expect.objectContaining({ method }))
    deleteConversation(conv.id)
    held.resolve(binding)
    expect(await sending).toBe(false)
    expect(calls.filter(call => call.method === 'prompt.submit')).toEqual([])
    expect(getState().messagesByThreadId[conv.id]).toBeUndefined()
    expect(getHydrateStatus().localSessions[conv.id]?.binding).toBeUndefined()
  })

  it('keeps a session created after deletion out of the next conversation-list refresh', async () => {
    const conv = await conversation()
    const held = holdRpc('session.create')
    const sending = transport.sendMessage(conv, 'Synthetic pending send.').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toContainEqual(expect.objectContaining({ method: 'session.create' }))
    deleteConversation(conv.id)
    held.resolve(binding)
    await sending
    await transport.listConversations()
    expect(isDeletedConversation('stored-runner')).toBe(true)
    expect(getState().conversations.filter(row => row.hermesSessionId === 'stored-runner')).toEqual([])
  })

  it.each([
    ['getMessages', 'resolve'], ['getMessages', 'reject'],
    ['loadOlderMessages', 'resolve'], ['loadOlderMessages', 'reject'],
  ] as const)('does not return or repopulate deleted history after %s %s', async (method, outcome) => {
    const history = { messages: Array.from({ length: 120 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user', text: `Synthetic row ${index}`, row_id: index + 1,
    })) }
    const previous = rpc
    rpc = (name, params) => name === 'session.history' ? history : previous(name, params)
    const conv = (await transport.listConversations()).find(row => row.agentId === 'profile:runner')!
    expect(await transport.getMessages(conv.id)).toHaveLength(50)
    const held = holdRpc('session.history')
    const loading = transport[method](conv.id)
    await vi.advanceTimersByTimeAsync(0)
    deleteConversation(conv.id)
    if (outcome === 'resolve') held.resolve(history)
    else held.reject(new Error('Synthetic late history failure'))
    expect(await loading).toEqual(method === 'getMessages' ? [] : false)
    expect(getState().messagesByThreadId[conv.id]).toBeUndefined()
  })

  it.each(['switch', 'hide'] as const)('preserves an explicit pending send after a normal chat %s', async action => {
    const conv = await conversation()
    const held = holdRpc('session.create')
    const sending = transport.sendMessage(conv, 'Synthetic background send.')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toContainEqual(expect.objectContaining({ method: 'session.create' }))
    const other = createConversation({ type: 'agent', agentId: 'profile:backend-eng' })
    if (action === 'hide') hideConversation(conv.id)
    held.resolve(binding)
    await sending
    expect(calls.filter(call => call.method === 'prompt.submit')).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ session_id: 'runtime-runner', profile: 'runner', text: 'Synthetic background send.' }) }),
    ])
    expect(getState().selectedConversationId).toBe(other.id)
    expect(getMessagesForConversation(conv.id).find(message => message.role === 'user')?.content).toBe('Synthetic background send.')
  })
})

describe('local stream idle watchdog', () => {
  it.each(['working', 'starting', 'waiting'])('does not interrupt a quiet turn the backend reports as %s', async (status) => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Wait for a quiet synthetic backend')
    event('message.delta', { text: 'Partial synthetic reply.' }, 1)
    const previous = rpc
    rpc = (method, params) => method === 'session.active_list'
      ? { sessions: [{ id: 'runtime-runner', status }] } : previous(method, params)

    await vi.advanceTimersByTimeAsync(360_001)
    flushMessagePatches()
    const reply = getMessagesForConversation(conv.id).find((message) => message.role === 'agent')!
    expect(reply).toMatchObject({ streaming: true, content: 'Partial synthetic reply.' })
    expect(getState().turnsById[reply.turnId!].phase).not.toBe('failed')
    expect(calls.filter((call) => call.method === 'session.active_list')).toHaveLength(3)
    expect(calls.filter((call) => call.method === 'session.interrupt')).toEqual([])

    rpc = (method, params) => method === 'session.active_list'
      ? { sessions: [{ id: 'runtime-runner', status: 'idle' }] }
      : method === 'session.events.since' ? {
        epoch: 'fake-epoch-1', events: [{
          type: 'message.complete', session_id: 'runtime-runner', seq: 2,
          payload: { status: 'complete', text: 'Partial synthetic reply. Finished.' },
        }],
      } : previous(method, params)
    await vi.advanceTimersByTimeAsync(120_001)
    expect(getMessagesForConversation(conv.id).find((message) => message.id === reply.id)).toMatchObject({
      streaming: false, error: false, content: 'Partial synthetic reply. Finished.',
    })
    expect(getState().turnsById[reply.turnId!].phase).toBe('done')
    expect(calls.filter((call) => call.method === 'session.interrupt')).toEqual([])
  })

  it.each([
    ['message.start', {}],
    ['message.delta', { text: 'Still writing. ' }],
    ['message.interim', { text: 'Still working. ' }],
    ['reasoning.delta', { text: 'Still thinking. ' }],
    ['thinking.delta', { text: 'Still thinking. ' }],
    ['status.update', { text: 'Working on the fixture.' }],
    ['todo.updated', { todos: [], revision: 1 }],
    ['session.usage', { cost_usd: 0.001 }],
  ])('keeps a long turn alive while %s updates arrive', async (type, payload) => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'A synthetic long-running turn')
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(90_000)
      event(type as string, payload)
    }
    flushMessagePatches()
    const reply = getMessagesForConversation(conv.id).find((message) => message.role === 'agent')!
    expect(reply).toMatchObject({ streaming: true })
    expect(getState().turnsById[reply.turnId!].phase).not.toBe('failed')
    expect(calls.filter((call) => call.method === 'session.interrupt')).toEqual([])

    event('message.complete', { status: 'complete', text: 'Finished the synthetic long turn.' })
    await vi.advanceTimersByTimeAsync(120_001)
    expect(getState().turnsById[reply.turnId!].phase).toBe('done')
    expect(calls.filter((call) => call.method === 'session.interrupt')).toEqual([])
  })

  it('waits for a running tool instead of cancelling it at the stream idle deadline', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Wait for a synthetic long-running tool')
    event('tool.start', { tool_id: 'long-tool', name: 'terminal' })
    await vi.advanceTimersByTimeAsync(360_001)
    expect(getMessagesForConversation(conv.id).find((message) => message.role === 'agent')).toMatchObject({ streaming: true })
    expect(calls.filter((call) => call.method === 'session.interrupt')).toEqual([])
    event('tool.complete', { tool_id: 'long-tool', name: 'terminal', result: { ok: true } })
    event('message.complete', { status: 'complete', text: 'The synthetic tool finished.' })
    expect(Object.values(getState().turnsById).at(-1)?.phase).toBe('done')
  })

  it('settles a running tool that has been silent past the ceiling', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Wait for a synthetic tool whose serve went away')
    event('tool.start', { tool_id: 'lost-tool', name: 'terminal' })
    await vi.advanceTimersByTimeAsync(28 * 60_000)
    expect(getMessagesForConversation(conv.id).find((message) => message.role === 'agent')).toMatchObject({ streaming: true })
    expect(calls.filter((call) => call.method === 'session.interrupt')).toEqual([])
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    flushMessagePatches()
    expect(getMessagesForConversation(conv.id).find((message) => message.role === 'agent')).toMatchObject({ streaming: false })
    expect(calls.filter((call) => call.method === 'session.interrupt')).toHaveLength(1)
  })

  it('restarts the running-tool ceiling whenever the stream shows activity', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Wait for a synthetic tool that keeps reporting')
    event('tool.start', { tool_id: 'busy-tool', name: 'terminal' })
    for (let minute = 0; minute < 40; minute += 10) {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      event('status.update', { text: 'Still running the fixture tool.' })
    }
    expect(getMessagesForConversation(conv.id).find((message) => message.role === 'agent')).toMatchObject({ streaming: true })
    expect(calls.filter((call) => call.method === 'session.interrupt')).toEqual([])
  })

  it('does not time out a background profile waiting on its own approval', async () => {
    await transport.listAgents()
    const first = createConversation({ type: 'agent', agentId: 'profile:runner' })
    const second = createConversation({ type: 'agent', agentId: 'profile:backend-eng' })
    await Promise.all([transport.sendMessage(first, 'Runner fixture'), transport.sendMessage(second, 'Backend fixture')])
    const request = lines(requestFixture)[0]
    push(request)
    push({ ...request, id: 'srq-backend-approval', params: { ...request.params, session_id: 'runtime-backend-eng' } })
    expect(getPendingToolPermission()?.conversationId).toBe(second.id)
    await vi.advanceTimersByTimeAsync(360_001)
    for (const conv of [first, second])
      expect(getMessagesForConversation(conv.id).find((message) => message.role === 'agent')?.streaming).toBe(true)
    expect(calls.filter((call) => call.method === 'session.interrupt')).toEqual([])
    expect(responses).toEqual([])
  })

  it.each(['', 'Partial synthetic reply.'])('settles a truly silent turn as a retryable failure without losing %j', async (partial) => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'A synthetic silent turn')
    if (partial) event('message.delta', { text: partial })
    event('status.update', { text: 'Working on the fixture.' })
    await vi.advanceTimersByTimeAsync(120_001)
    flushMessagePatches()
    const reply = getMessagesForConversation(conv.id).find((message) => message.role === 'agent')!
    expect(reply).toMatchObject({ streaming: false, error: true })
    expect(partial ? reply.errorNote : reply.content).toMatch(/timed out.*without updates/i)
    if (partial) expect(reply.content).toBe(partial)
    expect(reply.content).not.toMatch(/overloaded/i)
    expect(getState().turnsById[reply.turnId!]).toMatchObject({ phase: 'failed', finishedAt: expect.any(String) })
    expect(getHydrateStatus().localSessions[conv.id]?.status).toBe('')
    expect(calls.filter((call) => call.method === 'session.interrupt')).toEqual([
      expect.objectContaining({ params: { session_id: 'runtime-runner', profile: 'runner' } }),
    ])

    event('thinking.delta', { text: 'The synthetic runtime is interrupting.' })
    event('status.update', { text: 'Interrupting the synthetic runtime.' })
    event('message.complete', { status: 'interrupted', text: 'Interrupted.' })
    expect(getMessagesForConversation(conv.id).filter((message) => message.role === 'agent')).toHaveLength(1)
    expect(getState().turnsById[reply.turnId!].phase).toBe('failed')
    expect(getMessagesForConversation(conv.id).find((message) => message.id === reply.id)?.content).toBe(reply.content)
  })

  it('does not let duplicate events or another profile keep a silent turn alive', async () => {
    await transport.listAgents()
    const first = createConversation({ type: 'agent', agentId: 'profile:runner' })
    const second = createConversation({ type: 'agent', agentId: 'profile:backend-eng' })
    await Promise.all([transport.sendMessage(first, 'Runner fixture'), transport.sendMessage(second, 'Backend fixture')])
    await vi.advanceTimersByTimeAsync(30_000)
    event('reasoning.delta', { text: 'Thinking.' }, 1)
    await vi.advanceTimersByTimeAsync(60_000)
    event('reasoning.delta', { text: 'Duplicate thinking.' }, 1)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(getMessagesForConversation(first.id).find((message) => message.role === 'agent')?.streaming).toBe(true)
    expect(getMessagesForConversation(second.id).find((message) => message.role === 'agent')).toMatchObject({ streaming: false, error: true })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getMessagesForConversation(first.id).find((message) => message.role === 'agent')).toMatchObject({ streaming: false, error: true })
    expect(calls.filter((call) => call.method === 'session.interrupt')).toHaveLength(2)
  })

  it('keeps an interrupted reply and marks its turn and unfinished tools failed', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'A synthetic interrupted turn')
    event('message.delta', { text: 'Partial synthetic reply.' })
    event('tool.start', { tool_id: 'interrupted-tool', name: 'terminal' })
    event('message.complete', { status: 'interrupted', text: 'Partial synthetic reply.' })
    flushMessagePatches()
    const reply = getMessagesForConversation(conv.id).find((message) => message.role === 'agent')!
    expect(reply).toMatchObject({
      content: 'Partial synthetic reply.', streaming: false, error: true,
      errorNote: expect.stringMatching(/interrupted/i),
      toolEvents: [expect.objectContaining({ status: 'failed' })],
    })
    expect(getState().turnsById[reply.turnId!].phase).toBe('failed')
    await vi.advanceTimersByTimeAsync(120_001)
    expect(calls.filter((call) => call.method === 'session.interrupt')).toEqual([])
  })
})

describe('local profile roster and conversations', () => {
  it('supplies model, display name, avatar metadata and the upstream orchestrator role', async () => {
    const previous = rpc
    rpc = (method, params) => method === 'profiles.list' ? { profiles: [{
      name: 'runner', path: '/fake/runner', role: 'orchestrator', model: 'fixture-model', provider: 'fixture',
      ui_meta: { display_name: 'Fixture coordinator', avatar: '/fake/avatar.png', accent_color: '#a7ceff' },
    }] } : previous(method, params)
    expect(await transport.listAgents()).toEqual([expect.objectContaining({
      name: 'Fixture coordinator', model: 'fixture-model', provider: 'fixture', avatar: '/fake/avatar.png',
      role: 'orchestrator', ui_meta: { display_name: 'Fixture coordinator', avatar: '/fake/avatar.png', accent_color: '#a7ceff' },
    })])
  })
  it('hides scratch/hidden profiles, uses display names and SOUL, orders pins then activity', async () => {
    prefs = { pinnedOrder: ['profile:default'], hidden: ['backend-eng'] }
    const agents = await transport.listAgents()
    expect(agents.map((a) => a.id)).toEqual(['profile:default', 'profile:runner'])
    expect(agents[1]).toMatchObject({ name: 'The Runner', hermesProfile: 'runner', persona: { description: 'Reads local fixtures.' } })
    prefs = { showScratch: true }
    expect((await transport.listAgents()).map((a) => a.id)).toEqual(['profile:session-scratch', 'profile:runner', 'profile:backend-eng', 'profile:default'])
  })

  it('falls back to local profiles REST when profiles.list is unavailable', async () => {
    const previous = rpc
    rpc = (method, params) => {
      if (method === 'profiles.list') throw { code: -32601, message: 'Unsupported method' }
      return previous(method, params)
    }
    expect(await transport.listAgents()).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:19120/api/profiles', expect.objectContaining({ credentials: 'omit' }))
  })

  it('defaults to desktop sessions and supports CLI/cron without cross-profile collisions', async () => {
    let conversations = await transport.listConversations()
    expect(conversations).toHaveLength(3)
    expect(conversations.every((c) => c.source === 'desktop' && c.agentId === `profile:${c.sessionId?.replace('stored-', '')}`)).toBe(true)
    expect(calls.filter((c) => c.method === 'session.list').map((c) => c.params)).toEqual([
      { profile: 'runner', limit: 50 }, { profile: 'backend-eng', limit: 50 }, { profile: 'default', limit: 50 },
    ])
    conversations = await transport.listConversations({ includeCli: true, includeCron: true })
    expect(conversations).toHaveLength(9)
    conversations = await transport.listConversations()
    expect(conversations).toHaveLength(3)
  })

  it('hide removes only the roster row and persists the preference, not a profile DELETE', async () => {
    await transport.listAgents()
    await transport.removeAgent('profile:runner')
    expect(prefs.hidden).toEqual(['runner'])
    expect((await transport.listAgents()).some((a) => a.id === 'profile:runner')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(calls.some((c) => c.method?.includes('delete'))).toBe(false)
  })

  it('creates a profile and writes its SOUL through local REST', async () => {
    const agent = await transport.createAgent({ name: 'Fixture Bot', personality: 'Synthetic local personality.' })
    expect(agent).toMatchObject({ id: 'profile:fixture-bot', name: 'Fixture Bot' })
    expect(calls.find((c) => c.method === 'profiles.create')?.params).toEqual({ name: 'fixture-bot', description: '' })
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:19120/api/profiles/fixture-bot/soul', expect.objectContaining({ method: 'PUT', body: expect.stringContaining('Synthetic local personality.') }))
  })

  it('selection marks read using profile-scoped PATCH and clears badges', async () => {
    const conversations = await transport.listConversations()
    const selected = conversations[0]!
    setState((state) => ({ conversations: state.conversations.map((c) => c.id === selected.id ? { ...c, hasUnread: true, unreadCount: 2 } : c) }))
    selectConversation(selected.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19120/api/sessions/stored-runner?profile=runner',
      expect.objectContaining({ method: 'PATCH', body: expect.stringContaining('"unread":false') }),
    )
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')!
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toMatchObject({
      unread: false, profile: 'runner', request_id: expect.any(String), expected_revision: 1, expected_generation: 0,
    })
    expect(getState().conversations.find((c) => c.id === selected.id)?.unreadCount).toBe(0)
  })

  it('marks colliding stored session IDs read in the JSON-body owner, without changing sibling profiles', async () => {
    const previous = rpc
    rpc = (method, params) => method === 'session.list'
      ? { sessions: [{ id: 'shared-stored-id', title: 'Synthetic shared ID', source: 'desktop', started_at: 6 }] }
      : previous(method, params)
    const conversations = await transport.listConversations()
    const reads = new Set<string>()
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const profile = body.profile ?? 'default'
      reads.add(profile)
      return new Response(JSON.stringify({ ok: true, unread: false }), {
        headers: { 'Content-Type': 'application/json' },
      })
    })
    for (const profile of ['runner', 'backend-eng', 'runner', 'default']) {
      reads.clear()
      const target = conversations.find(row => row.agentId === `profile:${profile}`)!
      setState(state => ({ conversations: state.conversations.map(row => ({ ...row, hasUnread: true, unreadCount: 2 })) }))
      await transport.markRead(target.id)
      expect([...reads]).toEqual([profile])
      expect(getState().conversations.filter(row => row.id !== target.id).every(row => row.hasUnread && row.unreadCount === 2)).toBe(true)
      expect(getState().conversations.find(row => row.id === target.id)?.unreadCount).toBe(0)
    }
  })

  it('keeps unread badges when a profile-scoped read acknowledgement fails and permits a later retry', async () => {
    const conversations = await transport.listConversations()
    const target = conversations.find(row => row.agentId === 'profile:backend-eng')!
    setState(state => ({ conversations: state.conversations.map(row => ({ ...row, hasUnread: true, unreadCount: 2 })) }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Serve request unavailable' }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    }))

    await expect(transport.markRead(target.id)).rejects.toThrow('Serve request unavailable')
    const [, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ unread: false, profile: 'backend-eng' })
    expect(getState().conversations.every(row => row.hasUnread && row.unreadCount === 2)).toBe(true)

    await transport.markRead(target.id)
    expect(getState().conversations.find(row => row.id === target.id)?.unreadCount).toBe(0)
    expect(getState().conversations.filter(row => row.id !== target.id).every(row => row.hasUnread && row.unreadCount === 2)).toBe(true)
  })

  it('uses REST activity and read metadata omitted from the RPC summary', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const profile = new URL(url).searchParams.get('profile')
      return new Response(JSON.stringify({ sessions: [{ id: `stored-${profile}`, last_active: 20, last_read_at: 10, unread_count: 2 }] }), { headers: { 'Content-Type': 'application/json' } })
    })
    const rows = await transport.listConversations()
    expect(rows.every((row) => row.unread && row.unreadCount === 2 && row.lastActivityAt === new Date(20_000).toISOString())).toBe(true)
    expect(getState().agents.every((agent) => agent.unreadCount === 2)).toBe(true)
    await transport.markRead(rows[0]!.id)
    expect(getState().agents.find((a) => a.id === rows[0]!.agentId)?.unreadCount).toBe(0)
  })

  it('restores a hidden profile when the live preference getter changes', async () => {
    await transport.listAgents()
    await transport.removeAgent('profile:runner')
    prefs = { hidden: [] }
    expect((await transport.listAgents()).some((a) => a.id === 'profile:runner')).toBe(true)
  })
})

describe('local send, history, events, and questions', () => {
  it.each([true, false])('reloads saved deferred GENUI after switching conversations without another prompt or leaking it to another profile (projected args: %s)', async withArgs => {
    const conversations = await transport.listConversations()
    const owner = conversations.find(row => row.agentId === 'profile:runner')!
    const other = conversations.find(row => row.agentId === 'profile:backend-eng')!
    const name = 'mcp__hermes_desk__render_ui', id = 'deferred-render'
    const spec = { version: 1, components: [{ type: 'stat', title: 'Saved card', value: '12' }] }
    const genuiOccurrence = '11111111-1111-4111-8111-111111111111'
    const args = { calls: [{ name, arguments: spec }] }
    const previous = rpc
    rpc = (method, params) => method === 'session.history' && params.profile === 'runner'
      ? { messages: [
        { role: 'user', row_id: 1, text: 'Show data' },
        { role: 'tool', name: 'tool_call', tool_call_id: id, ...(withArgs ? { args } : {}) },
        { role: 'assistant', row_id: 4, text: 'Done' },
      ] } : previous(method, params)
    fetchMock.mockImplementation(async (url: string) => {
      if (!url.includes('/export?')) return new Response(JSON.stringify({ ok: true }))
      expect(new URL(url).pathname).toBe('/api/sessions/stored-runner/export')
      expect(new URL(url).searchParams.get('profile')).toBe('runner')
      return new Response(JSON.stringify({ messages: [
        { role: 'user', id: 1, content: 'Show data' },
        { role: 'assistant', id: 2, tool_calls: [{ id, function: { name: 'tool_call', arguments: JSON.stringify(args) } }] },
        { role: 'tool', id: 3, tool_call_id: id, tool_name: name,
          content: JSON.stringify({ genui: spec, genuiOccurrence }) },
        { role: 'assistant', id: 4, content: 'Done' },
      ] }))
    })
    for (let i = 0; i < 2; i++) {
      selectConversation(other.id)
      const otherMessages = await transport.getMessages(other.id)
      expect(otherMessages.flatMap(message => message.toolEvents ?? []).filter(tool => tool.genui)).toEqual([])
      selectConversation(owner.id)
      const messages = await transport.getMessages(owner.id)
      expect(messages.flatMap(message => message.toolEvents ?? []).filter(tool => tool.genui)).toEqual([
        expect.objectContaining({ tool: name, toolCallId: id, genui: spec, genuiOccurrence }),
      ])
      const reply = messages.find(message => message.role === 'agent')!
      for (const skin of ['classic', 'messenger'] as const) {
        expect(renderToStaticMarkup(createElement(MessageBody, {
          content: reply.content, variant: 'markdown', skin, toolEvents: reply.toolEvents,
          genuiScope: `${owner.id}:profile:runner`,
        }))).toContain('data-genui-type="stat"')
      }
    }
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('/export?'))).toHaveLength(2)
    expect(calls.some(call => call.method === 'prompt.submit')).toBe(false)
  })

  it('keeps full completed Generated UI on the owning live DM and restores it from paired raw history', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Fixture Generated UI')
    const spec = { version: 1, components: [{ type: 'table', title: 'Estimate', columns: ['Task'],
      rows: Array.from({ length: 10 }, (_, i) => [`Task ${i}: ${'data '.repeat(20)}`]) }] }
    const name = 'mcp_hermes-desk_render_ui', tool_id = 'fixture-widget'
    event('tool.start', { name, tool_id, args: spec })
    flushMessagePatches()
    expect(getMessagesForConversation(conv.id).find(m => m.role === 'agent')!.toolEvents![0].genui).toBeUndefined()
    event('tool.complete', { name, tool_id, result: JSON.stringify({ genui: spec }) })
    event('tool.complete', { name, tool_id, result: JSON.stringify({ genui: spec }) })
    event('message.complete', { text: '' })
    flushMessagePatches()
    const reply = getMessagesForConversation(conv.id).find(m => m.role === 'agent')!
    expect(reply.toolEvents).toHaveLength(1)
    expect(reply.toolEvents![0].genui).toEqual(spec)
    const history = localHistoryMessages('stored-runner', conv.id, 'runner', [
      { role: 'assistant', tool_calls: [{ id: tool_id, function: { name, arguments: JSON.stringify(spec) } }] },
      { role: 'tool', tool_call_id: tool_id, content: JSON.stringify({ genui: spec }) },
    ])
    expect(history[0].toolEvents![0].genui).toEqual(spec)
    for (const skin of ['classic', 'messenger'] as const) {
      expect(renderToStaticMarkup(createElement(MessageBody, { content: '', variant: 'markdown', skin,
        toolEvents: reply.toolEvents, genuiScope: `${conv.id}:profile:runner` }))).toContain('data-genui-type="table"')
    }
  })

  it.each([
    [{ error: null, exit_code: 0 }, 'completed'], [{ error: null, exit_code: 1 }, 'completed'],
    [{ error: false }, 'completed'], [{ error: '' }, 'completed'],
    [{ is_error: true }, 'failed'], [{ error: 'Fixture error' }, 'failed'],
    [{ error: { message: 'Fixture error' } }, 'failed'], [{ status: 'error' }, 'failed'],
  ] as const)('uses the same tool status for live and history payload %j', async (result, status) => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Fixture')
    event('tool.start', { name: 'terminal', tool_id: 't1', args: { command: 'git log -5' } })
    event('tool.complete', { name: 'terminal', tool_id: 't1', result, duration_s: 0.4, summary: 'Ran git log -5' })
    flushMessagePatches()
    const live = getMessagesForConversation(conv.id).find(message => message.role === 'agent')!.toolEvents![0]!
    const history = localHistoryMessages('fake-stored', conv.id, 'runner', [
      { role: 'assistant', row_id: 1, tool_calls: [{ id: 't1', type: 'function', function: { name: 'terminal', arguments: '{"command":"git log -5"}' } }] },
      { role: 'tool', row_id: 2, tool_call_id: 't1', content: JSON.stringify(result), duration_s: 0.4, summary: 'Ran git log -5' },
      { role: 'assistant', row_id: 3, content: 'Done' },
    ])
    expect(live).toMatchObject({ status, durationMs: 400, summary: 'Ran git log -5' })
    expect(history).toHaveLength(1)
    expect(history[0]!.toolEvents![0]).toMatchObject(live)
  })

  it('groups intermediate history into one reasoning/tools/answer bubble identical to the settled live turn', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Fixture')
    event('reasoning.delta', { text: 'Check fixtures.' })
    event('tool.start', { name: 'terminal', tool_id: 't1', args: { command: 'git log -5' } })
    event('tool.complete', { name: 'terminal', tool_id: 't1', result: { error: null, exit_code: 1 }, duration_s: 0.4 })
    event('message.delta', { text: 'Done.' })
    event('message.complete', { text: 'Done.' })
    flushMessagePatches()
    const live = getMessagesForConversation(conv.id).find(message => message.role === 'agent')!
    const history = localHistoryMessages('fake-stored', conv.id, 'runner', [
      { role: 'user', row_id: 1, content: 'Fixture' },
      { role: 'assistant', row_id: 2, reasoning: 'Check fixtures.', display_metadata: { turn_id: 'turn-a' },
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'terminal', arguments: '{"command":"git log -5"}' } }] },
      { role: 'tool', row_id: 3, tool_call_id: 't1', content: '{"error":null,"exit_code":1}', duration_s: 0.4 },
      { role: 'assistant', row_id: 4, text: '', display_metadata: { turn_id: 'turn-b' } },
      { role: 'assistant', row_id: 5, text: 'Done.' },
    ])
    expect(history).toHaveLength(2)
    expect(history[1]).toMatchObject({ content: live.content, reasoning: live.reasoning, hermesRowId: 5, toolEvents: live.toolEvents })
    const markup = (message: typeof live) => renderToStaticMarkup(createElement(MessageBody, {
      variant: 'plain', skin: 'messenger', content: message.content, reasoning: message.reasoning, toolEvents: message.toolEvents,
    }))
    expect(markup(history[1]!)).toBe(markup(live))
    expect(markup(live).indexOf('messenger-thinking')).toBeLessThan(markup(live).indexOf('tool-chip-row'))
  })

  it('branches the selected durable row using upstream count and keeps the parent unchanged', async () => {
    const previous = rpc
    rpc = (method, params) => method === 'session.branch' ? {
      session_id: 'runtime-child', stored_session_id: 'stored-child', info: { profile_name: 'runner' },
      messages: [{ role: 'user', text: 'Hello', row_id: 1 }, { role: 'assistant', text: 'Hi', row_id: 2 }],
    } : previous(method, params)
    const parent = (await transport.listConversations()).find(c => c.agentId === 'profile:runner')!
    const messages = await transport.getMessages(parent.id)
    const child = await transport.branchConversation(parent.id, messages[1])
    expect(calls.find(call => call.method === 'session.branch')?.params).toEqual({
      session_id: 'runtime-runner', profile: 'runner', count: 2, idempotency_key: expect.stringMatching(/^branch_/),
    })
    expect(child).toMatchObject({ hermesSessionId: 'stored-child', target: parent.target })
    expect(getMessagesForConversation(parent.id)).toEqual(messages)
    expect(getMessagesForConversation(child.id).map(message => message.content)).toEqual(['Hello', 'Hi'])
    await transport.sendMessage(child, 'Continue branch')
    expect(calls.filter(call => call.method === 'prompt.submit').at(-1)?.params).toMatchObject({ session_id: 'runtime-child', profile: 'runner' })
  })

  it('surfaces a lease conflict and creates a stored-parent branch without stealing or resuming the parent', async () => {
    const previous = rpc
    rpc = (method, params) => {
      if (method === 'session.resume') throw { code: 4001, message: 'Session lease held by Hermes.app' }
      if (method === 'session.branch_stored') return { session_id: 'runtime-child', stored_session_id: 'stored-child', info: { profile_name: 'runner' } }
      return previous(method, params)
    }
    const events: LocalTransportEvent[] = []
    transport.subscribeLocal(event => events.push(event))
    const parent = (await transport.listConversations()).find(c => c.agentId === 'profile:runner')!
    await transport.getMessages(parent.id)
    expect(events).toContainEqual({ type: 'lease', conversationId: parent.id, held: true })
    const child = await transport.branchConversation(parent.id)
    expect(calls.find(call => call.method === 'session.branch_stored')?.params).toEqual({
      parent_session_id: 'stored-runner', profile: 'runner', source: 'desktop', idempotency_key: expect.stringMatching(/^branch_/),
    })
    expect(calls.some(call => call.method === 'session.branch')).toBe(false)
    expect(child.hermesSessionId).toBe('stored-child')
  })
  it('counts only text-bearing user/assistant rows for a native branch cutoff', async () => {
    const previous = rpc
    rpc = (method, params) => method === 'session.history' ? { messages: [
      { role: 'user', text: 'Hello', row_id: 1 },
      { role: 'assistant', text: '', row_id: 2, tool_calls: [] },
      { role: 'tool', text: 'Tool output', row_id: 3 },
      { role: 'assistant', text: 'Hi', row_id: 4 },
      { role: 'user', text: 'Later question', row_id: 5 },
    ] } : method === 'session.branch' ? {
      session_id: 'runtime-child', stored_session_id: 'stored-child', info: { profile_name: 'runner' },
    } : previous(method, params)
    const parent = (await transport.listConversations()).find(c => c.agentId === 'profile:runner')!
    const messages = await transport.getMessages(parent.id)
    await transport.branchConversation(parent.id, messages.find(message => message.hermesRowId === 4))
    expect(calls.find(call => call.method === 'session.branch')?.params?.count).toBe(2)
  })
  it('coalesces rapid branch requests and blocks blind retries after a lost acknowledgment', async () => {
    const previous = rpc
    let release!: () => void
    rpc = async (method, params) => {
      if (method === 'session.branch') {
        await new Promise<void>(resolve => { release = resolve })
        closeSocket()
        return {}
      }
      return previous(method, params)
    }
    const parent = (await transport.listConversations()).find(c => c.agentId === 'profile:runner')!
    await transport.getMessages(parent.id)
    const first = transport.branchConversation(parent.id)
    const second = transport.branchConversation(parent.id)
    const rejected = Promise.allSettled([first, second])
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    expect((await rejected).every(result => result.status === 'rejected')).toBe(true)
    await expect(transport.branchConversation(parent.id)).rejects.toThrow('Check Chats')
    expect(calls.filter(call => call.method === 'session.branch')).toHaveLength(1)
  })

  it('merges direct and nested usage updates without dropping session totals', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Fixture')
    event('session.usage', { usage: { input_tokens: 100 } })
    event('session.usage', { output_tokens: 20, cost_usd: 0.01 })
    expect(getHydrateStatus().localSessions[conv.id]?.usage).toMatchObject({ input_tokens: 100, output_tokens: 20, cost_usd: 0.01 })
  })
  it('creates the first desktop session and submits to its runtime id, without a model override', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Read this', { attachments: [{ name: 'notes.md', path: '/fake/notes.md', kind: 'file' }] })
    expect(calls.find((c) => c.method === 'session.create')?.params).toEqual({
      profile: 'runner', source: 'desktop', title: 'Read this', follow_profile_config: true,
    })
    expect(calls.find((c) => c.method === 'prompt.submit')?.params).toMatchObject({ session_id: 'runtime-runner', profile: 'runner', surface: 'desktop', text: expect.stringContaining('/fake/notes.md') })
    expect(getState().conversations.find((c) => c.id === conv.id)?.hermesSessionId).toBe('stored-runner')
  })

  it.each(['file', 'image'] as const)('retries the original uploaded %s without losing its path or duplicating the user row', async kind => {
    const previous = rpc
    let first = true
    rpc = (method, params) => {
      if (method === 'prompt.submit' && first) { first = false; throw new Error('Synthetic submission failure') }
      return previous(method, params)
    }
    const conv = await conversation()
    const attachment = { name: kind === 'file' ? 'notes.md' : 'image (82).png',
      path: kind === 'file' ? '/fake/runner/notes.md' : '/fake/runner/image (82).png', kind, size: 7 }
    await expect(transport.sendMessage(conv, 'Read the fixture.', { attachments: [attachment] })).rejects.toThrow()
    const user = getMessagesForConversation(conv.id).find(message => message.role === 'user')!
    expect(user.attachments).toEqual([expect.objectContaining(attachment)])
    expect(await transport.retryTurn(conv.id)).toBe(true)
    const submits = calls.filter(call => call.method === 'prompt.submit')
    expect(submits).toHaveLength(2)
    expect(submits[1].params).toEqual(submits[0].params)
    expect(submits[1].params?.text).toContain(attachment.path)
    expect(submits[1].params).toMatchObject({ profile: 'runner', session_id: 'runtime-runner', surface: 'desktop' })
    expect(getMessagesForConversation(conv.id).filter(message => message.role === 'user')).toEqual([user])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fences retry after a dropped submission response until completion is authoritative', async () => {
    const previous = rpc
    rpc = (method, params) => {
      if (method === 'prompt.submit') {
        closeSocket()
        return new Promise(() => {})
      }
      return previous(method, params)
    }
    const conv = await conversation()
    await expect(transport.sendMessage(conv, 'Possibly accepted fixture')).rejects.toMatchObject({ status: 'uncertain' })
    expect(await transport.retryTurn(conv.id)).toBe(false)
    expect(calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
    rpc = previous
    await transport.retryConnection()
    event('message.complete', { status: 'completed', text: 'Authoritative fixture completion' }, 500)
    await vi.advanceTimersByTimeAsync(0)
    expect(await transport.retryTurn(conv.id)).toBe(true)
  })

  it('retries the original reply context instead of sending an unqualified answer', async () => {
    const previous = rpc
    let first = true
    rpc = (method, params) => {
      if (method === 'prompt.submit' && first) { first = false; throw new Error('Synthetic submission failure') }
      return previous(method, params)
    }
    const conv = await conversation()
    const replyTo = { id: 'fixture-quoted', role: 'agent' as const, snippet: 'Use the blue fixture.' }
    await expect(transport.sendMessage(conv, 'Use that one.', { replyTo })).rejects.toThrow()
    expect(await transport.retryTurn(conv.id)).toBe(true)
    const submits = calls.filter(call => call.method === 'prompt.submit')
    expect(submits[1].params).toEqual(submits[0].params)
    expect(submits[1].params?.text).toContain('[The user is replying to your message: "Use the blue fixture."]')
    expect(getMessagesForConversation(conv.id).filter(message => message.role === 'user')).toHaveLength(1)
  })

  it('preserves combined attachment and quote metadata through a failed retry and another explicit attempt', async () => {
    const previous = rpc
    let failures = 2
    rpc = (method, params) => {
      if (method === 'prompt.submit' && failures-- > 0) throw new Error('Synthetic repeated submission failure')
      return previous(method, params)
    }
    const conv = await conversation()
    const attachment = { name: 'fixture.csv', path: '/fake/runner/fixture.csv', kind: 'file' as const }
    const replyTo = { id: 'fixture-root', role: 'user' as const, snippet: 'Compare these local fixtures.' }
    await expect(transport.sendMessage(conv, 'Compare it.', { attachments: [attachment], replyTo })).rejects.toThrow()
    const user = getMessagesForConversation(conv.id).find(message => message.role === 'user')!
    await expect(transport.retryTurn(conv.id)).rejects.toThrow()
    expect(await transport.retryTurn(conv.id)).toBe(true)
    const submits = calls.filter(call => call.method === 'prompt.submit')
    expect(submits).toHaveLength(3)
    for (const submit of submits) expect(submit.params).toEqual(submits[0].params)
    expect(submits[2].params?.text).toContain(attachment.path)
    expect(submits[2].params?.text).toContain('[The user is replying to their own message:')
    expect(getMessagesForConversation(conv.id).filter(message => message.role === 'user')).toEqual([user])
    expect(user).toMatchObject({ replyTo, attachments: [expect.objectContaining(attachment)] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps plain-text retry unchanged and ignores attachment chips with no usable path', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Plain fixture request.')
    event('message.complete', { status: 'error', text: 'Synthetic failed reply.' })
    const user = getMessagesForConversation(conv.id).find(message => message.role === 'user')!
    patchMessage(conv.id, user.id, { attachments: [
      { id: 'pathless', name: 'Unavailable fixture', kind: 'file' },
      { id: 'blank', name: 'Blank fixture', kind: 'file', path: '   ' },
    ] })
    flushMessagePatches()
    expect(await transport.retryTurn(conv.id)).toBe(true)
    expect(calls.filter(call => call.method === 'prompt.submit').at(-1)?.params?.text).toBe('Plain fixture request.')
    expect(getMessagesForConversation(conv.id).filter(message => message.role === 'user')).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retains attachment and reply context recovered from stored history when retrying', async () => {
    const originalText = '[The user is replying to your message: "Use the blue fixture."]\n\nRead the fixture.\n\nAttached files (saved on your computer):\n• /fake/runner/notes.md'
    const previous = rpc
    rpc = (method, params) => method === 'session.history' ? { messages: [
      { role: 'user', text: originalText, row_id: 1, timestamp: 1 },
      { role: 'assistant', text: 'Synthetic failed reply.', status: 'error', row_id: 2, timestamp: 2 },
    ] } : previous(method, params)
    const conv = (await transport.listConversations()).find(row => row.agentId === 'profile:runner')!
    await transport.getMessages(conv.id)
    expect(await transport.retryTurn(conv.id)).toBe(true)
    expect(calls.filter(call => call.method === 'prompt.submit').at(-1)?.params).toMatchObject({
      session_id: 'runtime-runner', profile: 'runner', surface: 'desktop', text: originalText,
    })
    expect(getMessagesForConversation(conv.id).filter(message => message.role === 'user')).toHaveLength(1)
  })

  it('does not duplicate a recovered file note when its attachment chip is also retained', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Read the fixture.', {
      attachments: [{ name: 'notes.md', path: '/fake/runner/notes.md', kind: 'file' }],
    })
    const originalText = calls.find(call => call.method === 'prompt.submit')!.params!.text as string
    const user = getMessagesForConversation(conv.id).find(message => message.role === 'user')!
    patchMessage(conv.id, user.id, { content: originalText })
    event('message.complete', { status: 'error', text: 'Synthetic failed reply.' })
    flushMessagePatches()
    expect(await transport.retryTurn(conv.id)).toBe(true)
    const retried = calls.filter(call => call.method === 'prompt.submit').at(-1)!.params!.text as string
    expect(retried).toBe(originalText)
    expect(retried.split('/fake/runner/notes.md')).toHaveLength(2)
    expect(getMessagesForConversation(conv.id).filter(message => message.role === 'user')).toHaveLength(1)
  })

  it('retries the requested profile metadata while another profile is selected and streaming', async () => {
    const previous = rpc
    let first = true
    rpc = (method, params) => {
      if (method === 'prompt.submit' && first) { first = false; throw new Error('Synthetic submission failure') }
      return previous(method, params)
    }
    const original = await conversation()
    await expect(transport.sendMessage(original, 'Runner fixture.', {
      attachments: [{ name: 'runner.md', path: '/fake/runner/runner.md', kind: 'file' }],
      replyTo: { id: 'runner-quoted', role: 'agent', snippet: 'Runner context.' },
    })).rejects.toThrow()
    const other = createConversation({ type: 'agent', agentId: 'profile:backend-eng' })
    await transport.sendMessage(other, 'Backend fixture.', {
      attachments: [{ name: 'backend.md', path: '/fake/backend/backend.md', kind: 'file' }],
    })
    expect(getState().selectedConversationId).toBe(other.id)
    expect(await transport.retryTurn(original.id)).toBe(true)
    const submits = calls.filter(call => call.method === 'prompt.submit')
    expect(submits.at(-1)?.params).toEqual(submits[0].params)
    expect(submits.at(-1)?.params?.profile).toBe('runner')
    expect(submits.at(-1)?.params?.text).not.toContain('/fake/backend/')
    for (const conv of [original, other])
      expect(getMessagesForConversation(conv.id).filter(message => message.role === 'user')).toHaveLength(1)
  })

  it('resumes stored sessions with their profile before history and send', async () => {
    const conv = (await transport.listConversations()).find((c) => c.agentId === 'profile:runner')!
    const messages = await transport.getMessages(conv.id)
    expect(messages.map((m) => m.content)).toEqual(['Hello', 'Hi'])
    expect(messages[1]).toMatchObject({ threadId: conv.id, hermesRowId: 2, reasoning: 'Synthetic reasoning' })
    await transport.sendMessage(conv, 'Continue')
    expect(calls.filter((c) => c.method === 'session.resume')).toHaveLength(1)
    expect(calls.find((c) => c.method === 'session.resume')?.params).toEqual({
      session_id: 'stored-runner', profile: 'runner', omit_messages: true,
    })
    expect(calls.find((c) => c.method === 'session.history')?.params).toEqual({ session_id: 'runtime-runner', profile: 'runner' })
    expect(calls.some((c) => c.method === 'session.create')).toBe(false)
  })

  it('pages full-contract history locally, with no unsupported limit or before keys', async () => {
    const previous = rpc
    rpc = (method, params) => method === 'session.history'
      ? { count: 125, messages: Array.from({ length: 125 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `row ${i}`, row_id: i + 1 })) }
      : previous(method, params)
    const conv = (await transport.listConversations())[0]!
    expect(await transport.getMessages(conv.id)).toHaveLength(50)
    expect(getHydrateStatus().historyPaging[conv.id]?.hasMore).toBe(true)
    expect(await transport.loadOlderMessages(conv.id)).toBe(true)
    expect(getMessagesForConversation(conv.id)).toHaveLength(100)
    expect(await transport.loadOlderMessages(conv.id)).toBe(true)
    expect(getMessagesForConversation(conv.id)).toHaveLength(125)
    expect(getHydrateStatus().historyPaging[conv.id]?.hasMore).toBe(false)
    expect(new Set(getMessagesForConversation(conv.id).map((m) => m.id)).size).toBe(125)
    for (const call of calls.filter((c) => c.method === 'session.history')) expect(Object.keys(call.params!)).toEqual(['session_id', 'profile'])
  })

  it('maps synthetic stream frames to message, turn, status, todo, usage, and title; ignores browser commands', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    const events: LocalTransportEvent[] = []
    transport.subscribeLocal((ev) => events.push(ev))
    for (const frame of lines(streamFixture)) push(frame)
    flushMessagePatches()
    const reply = getMessagesForConversation(conv.id).find((m) => m.role === 'agent')!
    expect(reply).toMatchObject({ content: 'Hello there.', reasoning: 'Checking the local fixture.', streaming: false })
    expect(reply.toolEvents).toContainEqual(expect.objectContaining({ toolCallId: 'tool-fixture', status: 'completed', summary: 'Read the fixture' }))
    expect(events.some((ev) => ev.type === 'status')).toBe(true)
    expect(events.some((ev) => ev.type === 'todo')).toBe(true)
    expect(events.some((ev) => ev.type === 'usage')).toBe(true)
    expect(events.some((ev) => ev.type === 'turn' && ev.turn.phase === 'done')).toBe(true)
    expect(getHydrateStatus().localSessions[conv.id]).toMatchObject({ todos: [expect.any(Object)], usage: { cost_usd: 0.001 } })
    expect(getState().conversations.find((c) => c.id === conv.id)?.title).toBe('Local notes')
    expect(JSON.stringify(events)).not.toContain('cmd-fixture')
  })

  it.each(['once', 'deny'] as const)('round-trips the %s approval using the original server request id', async (choice) => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    push(lines(requestFixture)[0])
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-approval', status: 'pending' })
    await transport.respondPermission(conv.id, choice)
    expect(responses).toContainEqual({ jsonrpc: '2.0', id: 'srq-approval', result: { choice } })
    expect(getPendingToolPermission()).toBeNull()
  })
  it.each(['session', 'always'] as const)('does not offer or forward the %s standing approval', async choice => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    push(lines(requestFixture)[0])
    expect(getPendingToolPermission()?.choices).toEqual(['once', 'deny'])
    await expect(transport.respondPermission(conv.id, choice)).rejects.toThrow('not allowed')
    expect(responses.some(frame => frame.id === 'srq-approval')).toBe(false)
  })

  it('renders clarify through the existing question card and declines secure prompts without renderer inputs', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    const events: LocalTransportEvent[] = []
    transport.subscribeLocal((ev) => events.push(ev))
    for (const frame of lines(requestFixture).slice(1)) push(frame)
    expect(events).toContainEqual(expect.objectContaining({ type: 'clarify', conversationId: conv.id }))
    expect(getAgentPrompts().map((p) => p.kind)).toEqual(['clarify'])
    await answerAgentPrompt('srq-clarify', { kind: 'clarify', answers: [{ qid: 'destination', answer: 'Inbox' }] })
    expect(responses).toContainEqual({ jsonrpc: '2.0', id: 'srq-clarify', result: { answers: { destination: 'Inbox' } } })
    for (const id of ['srq-secret', 'srq-sudo']) expect(responses).toContainEqual(expect.objectContaining({ id, error: { code: -32001, message: expect.stringContaining('main process') } }))
    expect(JSON.stringify(getState())).not.toContain('FAKE_FIXTURE_KEY')
  })

  it('routes stop/steer and skills to the selected profile', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    expect(await transport.stopTurn(conv.id)).toBe(true)
    expect(await transport.steer(conv.id, 'Check the other fixture')).toBe(true)
    expect(await transport.listSkills()).toEqual([{ name: 'read-notes', category: 'coding' }, { name: 'fixture-tool', category: 'local' }])
    expect(calls.find((c) => c.method === 'session.interrupt')?.params).toEqual({ session_id: 'runtime-runner', profile: 'runner' })
    expect(calls.find((c) => c.method === 'session.steer')?.params).toEqual({ session_id: 'runtime-runner', profile: 'runner', text: 'Check the other fixture' })
    expect(calls.find((c) => c.method === 'skills.manage')?.params).toEqual({ profile: 'runner', action: 'list' })
  })

  it('debounces session changes into one conversation refresh', async () => {
    await transport.listConversations()
    const before = calls.filter((c) => c.method === 'session.list').length
    event('sessions.changed', {})
    event('sessions.changed', {})
    await vi.advanceTimersByTimeAsync(499)
    expect(calls.filter((c) => c.method === 'session.list')).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.filter((c) => c.method === 'session.list')).toHaveLength(before + 3)
  })

  it('streams two profiles concurrently without crosstalk', async () => {
    await transport.listAgents()
    const a = createConversation({ type: 'agent', agentId: 'profile:runner' })
    const b = createConversation({ type: 'agent', agentId: 'profile:backend-eng' })
    await Promise.all([transport.sendMessage(a, 'A'), transport.sendMessage(b, 'B')])
    push({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: 'runtime-runner', seq: 1, payload: { text: 'Runner answer' } } })
    push({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: 'runtime-backend-eng', seq: 1, payload: { text: 'Backend answer' } } })
    flushMessagePatches()
    expect(getMessagesForConversation(a.id).find((m) => m.role === 'agent')?.content).toBe('Runner answer')
    expect(getMessagesForConversation(b.id).find((m) => m.role === 'agent')?.content).toBe('Backend answer')
  })

  it('a typed clarify answer goes to the server request instead of opening a new turn', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    push(lines(requestFixture)[1])
    await transport.sendMessage(conv, 'Inbox')
    expect(responses).toContainEqual({ jsonrpc: '2.0', id: 'srq-clarify', result: { answers: { destination: 'Inbox' } } })
    expect(calls.filter((c) => c.method === 'prompt.submit')).toHaveLength(1)
    expect(getMessagesForConversation(conv.id).filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['Hello', 'Inbox'])
  })

  it('failed submissions surface an error without mock or hosted fallback', async () => {
    const previous = rpc
    rpc = (method, params) => {
      if (method === 'prompt.submit') throw { code: 5000, message: 'Synthetic submit failure' }
      return previous(method, params)
    }
    const conv = await conversation()
    await expect(transport.sendMessage(conv, 'Hello')).rejects.toThrow('Synthetic submit failure')
    expect(getMessagesForConversation(conv.id).find((m) => m.role === 'agent')).toMatchObject({ error: true, streaming: false })
    expect(calls.filter((c) => c.method === 'prompt.submit')).toHaveLength(1)
  })

  it('cancels an approval card when the server withdraws the request', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    push(lines(requestFixture)[0])
    event('request.cancel', { id: 'srq-approval', method: 'approval', reason: 'Synthetic cancellation' })
    expect(getPendingToolPermission()).toBeNull()
    await transport.respondPermission(conv.id, 'once')
    expect(responses).toEqual([])
  })

  it('retains a failed approval when the main relay refuses its answer and allows explicit retry', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    const request = lines(requestFixture)[0]
    push(request)
    vi.spyOn(window.nubAgent!.serveSocket!, 'send').mockResolvedValueOnce({ ok: false })
    const outcome = await transport.respondPermission(conv.id, 'once').then(() => 'sent', () => 'failed')
    expect(outcome).toBe('failed')
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-approval', status: 'failed' })
    expect(responses).toEqual([])
    expect(getHydrateStatus().readOnly).toBe(true)
    const previous = rpc
    rpc = (method, params) => method === 'session.events.since'
      ? { events: [], latest_seq: 0, truncated: false, epoch: 'fake-epoch-1', open_requests: [request] }
      : previous(method, params)
    await transport.retryConnection()
    await vi.advanceTimersByTimeAsync(0)
    await transport.respondPermission(conv.id, 'deny')
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 'srq-approval', result: { choice: 'deny' } }])
    expect(getPendingToolPermission()).toBeNull()
  })

  it('retains a failed question when the main relay refuses its answer and allows explicit retry', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    const request = lines(requestFixture)[1]
    push(request)
    vi.spyOn(window.nubAgent!.serveSocket!, 'send').mockResolvedValueOnce({ ok: false })
    expect(await answerAgentPrompt('srq-clarify', { kind: 'clarify', cancel: true })).toBe(false)
    expect(getAgentPrompts()).toContainEqual(expect.objectContaining({ requestId: 'srq-clarify', status: 'failed' }))
    expect(responses).toEqual([])
    const previous = rpc
    rpc = (method, params) => method === 'session.events.since'
      ? { events: [], latest_seq: 0, truncated: false, epoch: 'fake-epoch-1', open_requests: [request] }
      : previous(method, params)
    await transport.retryConnection()
    await vi.advanceTimersByTimeAsync(0)
    expect(await answerAgentPrompt('srq-clarify', { kind: 'clarify', cancel: true })).toBe(true)
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 'srq-clarify', result: {} }])
    expect(getAgentPrompts()).toEqual([])
  })

  it('keeps an approval submitting until main confirms the send', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    push(lines(requestFixture)[0])
    let finish!: (result: { ok: boolean }) => void
    vi.spyOn(window.nubAgent!.serveSocket!, 'send').mockImplementationOnce((_id, text) => {
      responses.push(JSON.parse(text))
      return new Promise((resolve) => { finish = resolve })
    })
    const answer = transport.respondPermission(conv.id, 'once')
    await vi.advanceTimersByTimeAsync(0)
    const beforeConfirmation = getPendingToolPermission()
    finish({ ok: true })
    await answer
    expect(beforeConfirmation).toMatchObject({ id: 'srq-approval', status: 'submitting' })
    expect(getPendingToolPermission()).toBeNull()
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 'srq-approval', result: { choice: 'once' } }])
  })

  it('keeps a replacement approval when an older relay confirmation arrives', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    const request = lines(requestFixture)[0]
    push(request)
    let finish!: (result: { ok: boolean }) => void
    vi.spyOn(window.nubAgent!.serveSocket!, 'send').mockImplementationOnce((_id, text) => {
      responses.push(JSON.parse(text))
      return new Promise((resolve) => { finish = resolve })
    })
    const answer = transport.respondPermission(conv.id, 'once')
    await vi.advanceTimersByTimeAsync(0)
    event('request.cancel', { id: 'srq-approval', method: 'approval' })
    push({ ...request, id: 'srq-replacement' })
    finish({ ok: true })
    await answer
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-replacement', status: 'pending' })
    await transport.respondPermission(conv.id, 'deny')
    expect(responses).toEqual([
      { jsonrpc: '2.0', id: 'srq-approval', result: { choice: 'once' } },
      { jsonrpc: '2.0', id: 'srq-replacement', result: { choice: 'deny' } },
    ])
  })

  it.each([true, false])('keeps a replayed question when the old relay send finishes with ok=%s', async (ok) => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    const request = lines(requestFixture)[1]
    push(request)
    let finish!: (result: { ok: boolean }) => void
    vi.spyOn(window.nubAgent!.serveSocket!, 'send').mockImplementationOnce((_id, text) => {
      responses.push(JSON.parse(text))
      return new Promise((resolve) => { finish = resolve })
    })
    const answer = answerAgentPrompt('srq-clarify', { kind: 'clarify', cancel: true })
    await vi.advanceTimersByTimeAsync(0)
    push({ ...request, params: { ...request.params,
      questions: [{ qid: 'destination', question: 'Where should the newer fixture go?', choices: [] }] } })
    finish({ ok })
    expect(await answer).toBe(ok)
    expect(getAgentPrompts()).toContainEqual(expect.objectContaining({
      requestId: 'srq-clarify', status: 'pending',
      questions: [expect.objectContaining({ question: 'Where should the newer fixture go?' })],
    }))
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 'srq-clarify', result: {} }])
  })

  it('does not answer an approval cancelled while its response awaits the client', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    push(lines(requestFixture)[0])
    const answer = transport.respondPermission(conv.id, 'once')
    expect(getPendingToolPermission()?.status).toBe('submitting')
    event('request.cancel', { id: 'srq-approval', method: 'approval' })
    await answer
    expect(responses).toEqual([])
    expect(getPendingToolPermission()).toBeNull()
  })

  it('preserves a replacement approval while an earlier response awaits the client', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    const request = lines(requestFixture)[0]
    push(request)
    const answer = transport.respondPermission(conv.id, 'once')
    event('request.cancel', { id: 'srq-approval', method: 'approval' })
    push({ ...request, id: 'srq-replacement' })
    await answer
    expect(responses).toEqual([])
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-replacement', status: 'pending' })
    await transport.respondPermission(conv.id, 'deny')
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 'srq-replacement', result: { choice: 'deny' } }])
    expect(getPendingToolPermission()).toBeNull()
  })

  it('sends only one answer while the same approval is submitting', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    push(lines(requestFixture)[0])
    const first = transport.respondPermission(conv.id, 'once')
    const repeated = transport.respondPermission(conv.id, 'deny')
    await Promise.all([first, repeated])
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 'srq-approval', result: { choice: 'once' } }])
    expect(getPendingToolPermission()).toBeNull()
  })

  it('requires a fresh answer when replay replaces an approval with the same id', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    const request = lines(requestFixture)[0]
    push(request)
    const answer = transport.respondPermission(conv.id, 'once')
    push({ ...request, params: { ...request.params, command: 'touch /fake/replayed-note.txt' } })
    await answer
    expect(responses).toEqual([])
    expect(getPendingToolPermission()).toMatchObject({
      id: 'srq-approval', command: 'touch /fake/replayed-note.txt', status: 'pending',
    })
    await transport.respondPermission(conv.id, 'deny')
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 'srq-approval', result: { choice: 'deny' } }])
  })

  it('allows an explicit retry after the current approval response fails and reconnects', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    const request = lines(requestFixture)[0]
    push(request)
    const answer = transport.respondPermission(conv.id, 'once')
    closeSocket()
    await expect(answer).rejects.toThrow('gateway not connected')
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-approval', status: 'failed' })
    expect(responses).toEqual([])
    const previous = rpc
    rpc = (method, params) => method === 'session.events.since'
      ? { events: [], latest_seq: 0, truncated: false, epoch: 'fake-epoch-1', open_requests: [request] }
      : previous(method, params)
    await transport.retryConnection()
    await vi.advanceTimersByTimeAsync(0)
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-approval', status: 'pending' })
    await transport.respondPermission(conv.id, 'once')
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 'srq-approval', result: { choice: 'once' } }])
    expect(getPendingToolPermission()).toBeNull()
  })

  it('keeps another profile approval when a background request is cancelled', async () => {
    const a = await conversation()
    const b = createConversation({ type: 'agent', agentId: 'profile:backend-eng' })
    await Promise.all([transport.sendMessage(a, 'A'), transport.sendMessage(b, 'B')])
    const request = lines(requestFixture)[0]
    push(request)
    push({ ...request, id: 'srq-backend', params: { ...request.params, session_id: 'runtime-backend-eng' } })
    event('request.cancel', { id: 'srq-approval', method: 'approval' })
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-backend', conversationId: b.id, status: 'pending' })
    await transport.respondPermission(a.id, 'once')
    expect(responses).toEqual([])
    await transport.respondPermission(b.id, 'once')
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 'srq-backend', result: { choice: 'once' } }])
  })

  it('does not replace a foreground approval when a background response starts', async () => {
    const a = await conversation()
    const b = createConversation({ type: 'agent', agentId: 'profile:backend-eng' })
    await Promise.all([transport.sendMessage(a, 'A'), transport.sendMessage(b, 'B')])
    const request = lines(requestFixture)[0]
    push(request)
    push({ ...request, id: 'srq-backend', params: { ...request.params, session_id: 'runtime-backend-eng' } })
    const answer = transport.respondPermission(a.id, 'deny')
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-backend', conversationId: b.id, status: 'pending' })
    await answer
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 'srq-approval', result: { choice: 'deny' } }])
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-backend', conversationId: b.id, status: 'pending' })
  })

  it('keeps another profile approval when an earlier response finishes', async () => {
    const a = await conversation()
    const b = createConversation({ type: 'agent', agentId: 'profile:backend-eng' })
    await Promise.all([transport.sendMessage(a, 'A'), transport.sendMessage(b, 'B')])
    const request = lines(requestFixture)[0]
    push(request)
    const answer = transport.respondPermission(a.id, 'once')
    push({ ...request, id: 'srq-backend', params: { ...request.params, session_id: 'runtime-backend-eng' } })
    await answer
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 'srq-approval', result: { choice: 'once' } }])
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-backend', conversationId: b.id, status: 'pending' })
    await transport.respondPermission(b.id, 'deny')
    expect(responses).toContainEqual({ jsonrpc: '2.0', id: 'srq-backend', result: { choice: 'deny' } })
  })

  it('keeps another profile approval when an earlier response fails', async () => {
    const a = await conversation()
    const b = createConversation({ type: 'agent', agentId: 'profile:backend-eng' })
    await Promise.all([transport.sendMessage(a, 'A'), transport.sendMessage(b, 'B')])
    const request = lines(requestFixture)[0]
    push(request)
    const answer = transport.respondPermission(a.id, 'once')
    push({ ...request, id: 'srq-backend', params: { ...request.params, session_id: 'runtime-backend-eng' } })
    closeSocket()
    await expect(answer).rejects.toThrow('gateway not connected')
    expect(responses).toEqual([])
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-backend', conversationId: b.id, status: 'pending' })
  })
})

describe('serve resilience', () => {
  it.each([false, true])('removes an expired approval after reconnect when replay truncated is %s', async (truncated) => {
    const previous = rpc
    rpc = (method, params) => method === 'session.events.since'
      ? { events: [], latest_seq: 10, truncated, epoch: 'fake-epoch-1', open_requests: [] }
      : previous(method, params)
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    push(lines(requestFixture)[0])
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    expect(getPendingToolPermission()).toBeNull()
    await transport.respondPermission(conv.id, 'once')
    expect(responses).toEqual([])
  })

  it('removes an expired clarify question after reconnect without sending a stale answer', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    push(lines(requestFixture)[1])
    expect(getAgentPrompts()).toHaveLength(1)
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    expect(getAgentPrompts()).toEqual([])
    expect(await answerAgentPrompt('srq-clarify', { kind: 'clarify', answers: [{ qid: 'destination', answer: 'Inbox' }] })).toBe(false)
    expect(responses).toEqual([])
  })

  it('reconciles each profile independently and retains another profile still-open approval', async () => {
    const a = await conversation()
    const b = createConversation({ type: 'agent', agentId: 'profile:backend-eng' })
    await Promise.all([transport.sendMessage(a, 'A'), transport.sendMessage(b, 'B')])
    const request = lines(requestFixture)[0]
    const backendRequest = { ...request, id: 'srq-backend', params: { ...request.params, session_id: 'runtime-backend-eng' } }
    push(request)
    push(backendRequest)
    const previous = rpc
    rpc = (method, params) => method === 'session.events.since'
      ? { events: [], latest_seq: 0, truncated: false, epoch: 'fake-epoch-1',
        open_requests: params.profile === 'backend-eng' ? [backendRequest] : [] }
      : previous(method, params)
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-backend', conversationId: b.id, status: 'pending' })
    await transport.respondPermission(a.id, 'once')
    expect(responses).toEqual([])
    await transport.respondPermission(b.id, 'deny')
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 'srq-backend', result: { choice: 'deny' } }])
  })

  it.each([undefined, null])('does not infer cancellation when replay omits its open-request snapshot (%s)', async (openRequests) => {
    const previous = rpc
    rpc = (method, params) => method === 'session.events.since'
      ? { events: [], latest_seq: 0, truncated: false, epoch: 'fake-epoch-1', open_requests: openRequests }
      : previous(method, params)
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    push(lines(requestFixture)[0])
    push(lines(requestFixture)[1])
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-approval', status: 'pending' })
    expect(getAgentPrompts()).toHaveLength(1)
    await transport.respondPermission(conv.id, 'deny')
    expect(await answerAgentPrompt('srq-clarify', { kind: 'clarify', cancel: true })).toBe(true)
    expect(responses).toEqual([
      { jsonrpc: '2.0', id: 'srq-approval', result: { choice: 'deny' } },
      { jsonrpc: '2.0', id: 'srq-clarify', result: {} },
    ])
  })

  it.each(['srq-live', 'srq-approval'])('preserves an approval arriving while a replay snapshot is pending (%s)', async (id) => {
    const previous = rpc
    let finishReplay!: (result: unknown) => void
    rpc = (method, params) => method === 'session.events.since'
      ? new Promise((resolve) => { finishReplay = resolve })
      : previous(method, params)
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    const request = lines(requestFixture)[0]
    push(request)
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    push({ ...request, id, params: { ...request.params, command: 'touch /fake/new-request.txt' } })
    finishReplay({ events: [], latest_seq: 0, truncated: false, epoch: 'fake-epoch-1', open_requests: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(getPendingToolPermission()).toMatchObject({ id, command: 'touch /fake/new-request.txt', status: 'pending' })
    await transport.respondPermission(conv.id, 'once')
    expect(responses).toEqual([{ jsonrpc: '2.0', id, result: { choice: 'once' } }])
  })

  it.each(['srq-live-clarify', 'srq-clarify'])('preserves a question arriving while a replay snapshot is pending (%s)', async (id) => {
    const previous = rpc
    let finishReplay!: (result: unknown) => void
    rpc = (method, params) => method === 'session.events.since'
      ? new Promise((resolve) => { finishReplay = resolve })
      : previous(method, params)
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    const request = lines(requestFixture)[1]
    push(request)
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    push({ ...request, id })
    finishReplay({ events: [], latest_seq: 0, truncated: false, epoch: 'fake-epoch-1', open_requests: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(getAgentPrompts()).toContainEqual(expect.objectContaining({ requestId: id, status: 'pending' }))
    expect(await answerAgentPrompt(id, { kind: 'clarify', cancel: true })).toBe(true)
    expect(responses).toEqual([{ jsonrpc: '2.0', id, result: {} }])
  })

  it.each(['approval', 'clarify'] as const)('does not revive an answered %s from an older replay snapshot', async (method) => {
    const previous = rpc
    let finishReplay!: (result: unknown) => void
    rpc = (name, params) => name === 'session.events.since'
      ? new Promise((resolve) => { finishReplay = resolve })
      : previous(name, params)
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    const request = lines(requestFixture)[method === 'approval' ? 0 : 1]
    push(request)
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    if (method === 'approval') await transport.respondPermission(conv.id, 'deny')
    else expect(await answerAgentPrompt('srq-clarify', { kind: 'clarify', cancel: true })).toBe(true)
    finishReplay({ events: [], latest_seq: 0, truncated: false, epoch: 'fake-epoch-1', open_requests: [request] })
    await vi.advanceTimersByTimeAsync(0)
    expect(getPendingToolPermission()).toBeNull()
    expect(getAgentPrompts()).toEqual([])
    expect(responses).toEqual([{ jsonrpc: '2.0', id: request.id, result: method === 'approval' ? { choice: 'deny' } : {} }])
  })

  it('does not overwrite a newer live approval with the older snapshot copy of its id', async () => {
    const previous = rpc
    let finishReplay!: (result: unknown) => void
    rpc = (method, params) => method === 'session.events.since'
      ? new Promise((resolve) => { finishReplay = resolve })
      : previous(method, params)
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    const request = lines(requestFixture)[0]
    push(request)
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    push({ ...request, params: { ...request.params, command: 'touch /fake/new-request.txt' } })
    finishReplay({ events: [], latest_seq: 0, truncated: false, epoch: 'fake-epoch-1', open_requests: [request] })
    await vi.advanceTimersByTimeAsync(0)
    expect(getPendingToolPermission()).toMatchObject({
      id: request.id, command: 'touch /fake/new-request.txt', status: 'pending',
    })
    expect(responses).toEqual([])
  })

  it('keeps legacy questions that are not part of the server-request snapshot', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    event('clarify.request', { request_id: 'legacy-question', question: 'Where should this legacy fixture go?' })
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    expect(getAgentPrompts()).toContainEqual(expect.objectContaining({ requestId: 'legacy-question', status: 'pending' }))
    expect(await answerAgentPrompt('legacy-question', { kind: 'clarify', cancel: true })).toBe(true)
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'clarify.respond', params: { request_id: 'legacy-question', answer: '' },
    }))
  })

  it('does not infer cancellation when the authoritative replay read fails', async () => {
    const previous = rpc
    rpc = (method, params) => {
      if (method === 'session.events.since') throw new Error('Synthetic replay read failure')
      return previous(method, params)
    }
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    push(lines(requestFixture)[0])
    push(lines(requestFixture)[1])
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-approval', status: 'pending' })
    expect(getAgentPrompts()).toContainEqual(expect.objectContaining({ requestId: 'srq-clarify', status: 'pending' }))
    expect(responses).toEqual([])
  })

  it('reconciles requests from the previous runtime when reconnect remints the session id', async () => {
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    push(lines(requestFixture)[0])
    push(lines(requestFixture)[1])
    const previous = rpc
    rpc = (method, params) => method === 'session.resume'
      ? { session_id: 'runtime-runner-new', stored_session_id: 'stored-runner', info: { profile_name: 'runner' } }
      : previous(method, params)
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls.find((call) => call.method === 'session.events.since')?.params).toMatchObject({
      session_id: 'runtime-runner-new', profile: 'runner',
    })
    expect(getPendingToolPermission()).toBeNull()
    expect(getAgentPrompts()).toEqual([])
    expect(responses).toEqual([])
  })

  it('retains still-open approval and clarify cards replayed after reconnect', async () => {
    const previous = rpc
    rpc = (method, params) => method === 'session.events.since'
      ? { events: [], latest_seq: 0, truncated: false, epoch: 'fake-epoch-1', open_requests: lines(requestFixture).slice(0, 2) }
      : previous(method, params)
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    push(lines(requestFixture)[0])
    push(lines(requestFixture)[1])
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    expect(getPendingToolPermission()).toMatchObject({ id: 'srq-approval', status: 'pending' })
    expect(getAgentPrompts()).toHaveLength(1)
    await transport.respondPermission(conv.id, 'deny')
    expect(await answerAgentPrompt('srq-clarify', { kind: 'clarify', cancel: true })).toBe(true)
    expect(responses).toEqual([
      { jsonrpc: '2.0', id: 'srq-approval', result: { choice: 'deny' } },
      { jsonrpc: '2.0', id: 'srq-clarify', result: {} },
    ])
  })

  it('reattaches and replays open sessions after reconnect, without duplicate deltas', async () => {
    const previous = rpc
    rpc = (method, params) => method === 'session.events.since'
      ? { events: lines(replayFixture), latest_seq: 3, truncated: false, epoch: 'fake-epoch-1', open_requests: [] }
      : previous(method, params)
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    event('message.delta', { text: 'Hello ' }, 1)
    closeSocket()
    expect(getHydrateStatus().readOnly).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls.find((c) => c.method === 'session.events.since')?.params).toEqual({ session_id: 'runtime-runner', profile: 'runner', last_seen: 1 })
    expect(calls.filter((c) => c.method === 'session.resume')).toHaveLength(1)
    expect(getMessagesForConversation(conv.id).find((m) => m.role === 'agent')).toMatchObject({ content: 'Hello world', streaming: false })
    event('message.delta', { text: 'world' }, 2)
    expect(getMessagesForConversation(conv.id).filter((m) => m.role === 'agent')).toHaveLength(1)
    expect(getHydrateStatus().readOnly).toBe(false)
  })

  it('retains cached transcripts and refuses writes while serve is unavailable', async () => {
    const conv = (await transport.listConversations())[0]!
    const cached = await transport.getMessages(conv.id)
    connected = false
    closeSocket()
    expect(await transport.getMessages(conv.id)).toEqual(cached)
    await expect(transport.sendMessage(conv, 'Offline text')).rejects.toThrow()
    expect(getHydrateStatus()).toMatchObject({ readOnly: true, serveConnection: 'offline', serveError: expect.stringContaining('offline') })
    expect(getMessagesForConversation(conv.id).map((m) => m.content)).not.toContain('Offline text')
  })

  it('advertises server-request support and never opens a renderer WebSocket', async () => {
    await transport.listAgents()
    expect(calls).toContainEqual(expect.objectContaining({ method: 'client.capabilities', params: { server_requests: true } }))
    expect(WebSocket).not.toHaveBeenCalled()
    expect(responses.every((frame) => !JSON.stringify(frame).includes('token'))).toBe(true)
  })

  it('refreshes authoritative history when replay has been truncated', async () => {
    const previous = rpc
    rpc = (method, params) => method === 'session.events.since'
      ? { events: [], latest_seq: 10, truncated: true, epoch: 'fake-epoch-1', open_requests: [] }
      : previous(method, params)
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    event('message.delta', { text: 'Old partial' }, 1)
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    expect(getMessagesForConversation(conv.id).map((m) => m.content)).toEqual(['Hello', 'Hi'])
    expect(calls.some((c) => c.method === 'session.history')).toBe(true)
  })

  it('buffers live frames during replay so a newer sequence cannot erase missing deltas', async () => {
    const previous = rpc
    let finishReplay!: (result: unknown) => void
    rpc = (method, params) => method === 'session.events.since'
      ? new Promise((resolve) => { finishReplay = resolve })
      : previous(method, params)
    const conv = await conversation()
    await transport.sendMessage(conv, 'Hello')
    event('message.delta', { text: 'Hello ' }, 1)
    closeSocket()
    await vi.advanceTimersByTimeAsync(1000)
    event('message.delta', { text: '!' }, 3)
    finishReplay({
      events: [{ type: 'message.delta', session_id: 'runtime-runner', seq: 2, payload: { text: 'world' } }],
      latest_seq: 2, truncated: false, epoch: 'fake-epoch-1', open_requests: [],
    })
    await vi.advanceTimersByTimeAsync(0)
    flushMessagePatches()
    expect(getMessagesForConversation(conv.id).find((m) => m.role === 'agent')?.content).toBe('Hello world!')
  })
})

describe('local transport recovery and streaming cost', () => {
  const runnerChat = async () => {
    const target = (await transport.listConversations()).find((row) => row.agentId === 'profile:runner')!
    await transport.getMessages(target.id)
    return target
  }

  it('keeps streamed deltas off the structural store snapshot', async () => {
    const target = await runnerChat()
    await transport.sendMessage(target, 'go')
    event('message.delta', { text: 'First ' })
    flushMessagePatches()
    let structural = 0
    let last = getStructuralState()
    const off = subscribe(() => {
      const next = getStructuralState()
      if (next !== last) structural += 1
      last = next
    })
    for (let i = 0; i < 20; i++) event('message.delta', { text: 'tok ' })
    flushMessagePatches()
    off()
    expect(structural).toBeLessThanOrEqual(1)
    expect(getMessagesForConversation(target.id).findLast((m) => m.role === 'agent')?.content).toBe(`First ${'tok '.repeat(20)}`)
  })

  it('lets the user lift an uncertain-send guard after checking the transcript', async () => {
    const target = await runnerChat()
    const previous = rpc
    rpc = (method, params) => method === 'prompt.submit' ? new Promise(() => {}) : previous(method, params)
    const first = transport.sendMessage(target, 'go').catch((error) => error)
    await vi.advanceTimersByTimeAsync(10)
    closeSocket()
    expect((await first as { status?: string }).status).toBe('uncertain')
    rpc = previous
    await vi.advanceTimersByTimeAsync(5000)
    expect((await transport.sendMessage(target, 'again').catch((error) => error) as { status?: string }).status).toBe('uncertain')
    transport.acknowledgeUncertain(target.id)
    await expect(transport.sendMessage(target, 'checked, send again')).resolves.toMatchObject({ turnId: expect.any(String) })
  })

  it('recovers every other chat when one session cannot be resumed', async () => {
    const rows = await transport.listConversations()
    await transport.getMessages(rows.find((row) => row.agentId === 'profile:default')!.id)
    await transport.getMessages(rows.find((row) => row.agentId === 'profile:runner')!.id)
    const previous = rpc
    rpc = (method, params) => {
      if (method === 'session.resume' && params.profile === 'default') {
        throw Object.assign(new Error('session lease held by another app'), { code: -32000 })
      }
      return previous(method, params)
    }
    calls.length = 0
    closeSocket()
    await vi.advanceTimersByTimeAsync(5000)
    const resumed = calls.filter((call) => call.method === 'session.resume').map((call) => call.params?.profile)
    expect(resumed).toContain('default')
    expect(resumed).toContain('runner')
    expect(calls.some((call) => call.method === 'session.events.since' && call.params?.profile === 'runner')).toBe(true)
  })

  it('reconnects only chats with live work, not every chat with cached messages', async () => {
    const rows = await transport.listConversations()
    const runner = rows.find((row) => row.agentId === 'profile:runner')!
    const cached = rows.find((row) => row.agentId === 'profile:backend-eng')!
    await transport.getMessages(runner.id)
    setState((state) => ({ messagesByThreadId: { ...state.messagesByThreadId, [cached.id]: [
      { id: 'cached-1', threadId: cached.id, role: 'agent', content: 'From the persisted cache', createdAt: '2026-10-01T00:00:00Z' },
    ] } }))
    calls.length = 0
    closeSocket()
    await vi.advanceTimersByTimeAsync(5000)
    const resumed = calls.filter((call) => call.method === 'session.resume').map((call) => call.params?.profile)
    expect(resumed).toContain('runner')
    expect(resumed).not.toContain('backend-eng')
    // Opening the cached chat still binds it on demand.
    await transport.getMessages(cached.id)
    expect(calls.some((call) => call.method === 'session.resume' && call.params?.profile === 'backend-eng')).toBe(true)
  })

  it('settles a spawned helper when its reply completes, and revives it on a follow-up', async () => {
    const target = await runnerChat()
    const previous = rpc
    rpc = (method, params) => method === 'session.create' && params.parent_session_id
      ? { session_id: 'helper-rt', stored_session_id: 'helper-st' } : previous(method, params)
    const conversation = getState().conversations.find((c) => c.id === target.id)!
    const run = await transport.spawnSubagentInto(conversation, 'custom', 'Summarize the fixture')
    const helperEvent = (type: string, payload: unknown, seq: number) =>
      push({ jsonrpc: '2.0', method: 'event', params: { type, payload, session_id: 'helper-rt', seq } })
    helperEvent('message.delta', { text: 'Fixture summary' }, 1)
    expect(getState().subagentsById[run.id]?.status).toBe('running')
    helperEvent('message.complete', { text: 'Fixture summary', status: 'complete' }, 2)
    expect(getState().subagentsById[run.id]).toMatchObject({
      status: 'completed', result: { summary: 'Fixture summary' }, finishedAt: expect.any(String),
    })
    helperEvent('message.delta', { text: 'Follow-up' }, 3)
    expect(getState().subagentsById[run.id]).toMatchObject({ status: 'running', finishedAt: undefined })
    helperEvent('message.complete', { text: '', status: 'error', error: 'Fixture failure' }, 4)
    expect(getState().subagentsById[run.id]).toMatchObject({ status: 'failed', error: 'Fixture failure' })
  })

  it('keeps the other profiles when one profile fails to list', async () => {
    const before = await transport.listConversations()
    const cachedDefault = before.filter((row) => row.agentId === 'profile:default').map((row) => row.id)
    expect(cachedDefault.length).toBeGreaterThan(0)
    const previous = rpc
    rpc = (method, params) => {
      if (method === 'session.list' && params.profile === 'default') throw Object.assign(new Error('fixture profile broken'), { code: -32000 })
      if (method === 'session.list' && params.profile === 'runner') {
        return { sessions: [{ id: 'stored-runner-new', title: 'Fresh runner chat', source: 'desktop', started_at: 8 }] }
      }
      return previous(method, params)
    }
    const after = await transport.listConversations()
    expect(after.some((row) => row.title === 'Fresh runner chat')).toBe(true)
    for (const id of cachedDefault) expect(after.some((row) => row.id === id)).toBe(true)
  })
})

describe('in-app model switching', () => {
  it('lists the profile models before a session exists, then the live session models', async () => {
    const target = await conversation()
    const previous = rpc
    rpc = (method, params) => method === 'model.options'
      ? { model: 'glm-5.3', provider: 'zai', providers: [{ slug: 'zai', name: 'Z.ai', models: ['glm-5.3', 'glm-5.4'], is_current: true }] }
      : previous(method, params)
    expect(await transport.modelOptions(target.id)).toEqual({ model: 'glm-5.3', provider: 'zai', providers: [{
      slug: 'zai', name: 'Z.ai', models: ['glm-5.3', 'glm-5.4'], featured: [], unavailable: [], current: true, authenticated: null, warning: undefined,
    }] })
    expect(calls.at(-1)).toMatchObject({ method: 'model.options', params: { profile: 'runner' } })
    expect(calls.at(-1)?.params).not.toHaveProperty('session_id')
    await transport.sendMessage(target, 'bind first')
    await transport.modelOptions(target.id)
    expect(calls.at(-1)).toMatchObject({ method: 'model.options', params: { profile: 'runner', session_id: 'runtime-runner' } })
  })

  it('switches this chat on its live session and shows the new route', async () => {
    const target = await conversation()
    const previous = rpc
    rpc = (method, params) => method === 'config.set' ? { key: 'model', value: 'glm-5.4', scope: 'session' } : previous(method, params)
    expect(await transport.switchModel(target.id, { model: 'glm-5.4', provider: 'zai', scope: 'session' }))
      .toEqual({ status: 'switched', scope: 'session', warning: undefined })
    expect(calls.find((call) => call.method === 'config.set')?.params).toEqual({
      profile: 'runner', session_id: 'runtime-runner', key: 'model', value: 'glm-5.4 --provider zai --session',
    })
    expect(getHydrateStatus().localSessions[target.id]?.modelRoute).toEqual({ model: 'glm-5.4', provider: 'zai' })
    expect(getState().agents.find((agent) => agent.id === 'profile:runner')).not.toHaveProperty('model', 'glm-5.4')
  })

  it('passes on the expensive-model question, resends only after consent, and reports a deferred switch', async () => {
    const target = await conversation()
    const previous = rpc
    rpc = (method, params) => method === 'config.set'
      ? params.confirm_expensive_model
        ? { key: 'model', value: 'opus', deferred: true, warning: 'Applies after this turn.' }
        : { key: 'model', confirm_required: true, confirm_message: 'Opus costs $75/M output. Switch?' }
      : previous(method, params)
    const choice = { model: 'opus', provider: 'anthropic', scope: 'global' as const }
    expect(await transport.switchModel(target.id, choice)).toEqual({ status: 'confirm', message: 'Opus costs $75/M output. Switch?' })
    expect(getHydrateStatus().localSessions[target.id]?.modelRoute?.model).not.toBe('opus')
    expect(await transport.switchModel(target.id, { ...choice, confirmExpensive: true }))
      .toEqual({ status: 'deferred', scope: 'global', warning: 'Applies after this turn.' })
    expect(calls.filter((call) => call.method === 'config.set').map((call) => call.params)).toEqual([
      { profile: 'runner', session_id: 'runtime-runner', key: 'model', value: 'opus --provider anthropic --global' },
      { profile: 'runner', session_id: 'runtime-runner', key: 'model', value: 'opus --provider anthropic --global', confirm_expensive_model: true },
    ])
    expect(getHydrateStatus().localSessions[target.id]?.modelRoute?.model).not.toBe('opus')
  })

  it('refuses rooms and values main would reject without contacting Hermes', async () => {
    const target = await conversation()
    const before = calls.length
    await expect(transport.switchModel(target.id, { model: '--once', provider: 'zai', scope: 'session' })).rejects.toThrow('Choose a model')
    await expect(transport.switchModel(target.id, { model: 'glm', provider: 'z ai', scope: 'session' })).rejects.toThrow('Choose a model')
    expect(calls.slice(before).some((call) => call.method === 'config.set')).toBe(false)
  })
})
