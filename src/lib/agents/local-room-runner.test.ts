import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { LocalRoomRunner, type RoomRepository, type RoomClock, type RoomServeIO } from './local-room-runner'
import type { Conversation } from './types'
import { mergeRoomFeed } from './rooms'
import { ServeRpcError } from '../hermes-serve'
const { rendererRpcAllowed } = createRequire(import.meta.url)('../../../electron/local/serve-client.cjs')

async function nativeRepositoryFixture(holdResume = false, refuseFirstBinding = true) {
  vi.resetModules()
  window.localStorage.clear()
  let revision = 0
  let value: string | null = null
  let failedBindingWrite = false
  const native = {
    read: vi.fn(() => ({ ok: true, revision, value })),
    save: vi.fn((expected: number, next: string) => {
      if (refuseFirstBinding && !failedBindingWrite && JSON.parse(next).conversations.some((c: Conversation) =>
        c.localRoom?.bindings['profile:alpha'])) {
        failedBindingWrite = true
        return { ok: false }
      }
      if (expected !== revision) return { ok: false }
      value = next
      return { ok: true, revision: ++revision }
    }),
  }
  Object.assign(window, { nubAgent: { roomJournal: native } })
  const store = await import('./store')
  const persist = await import('./persist')
  const { createRoomRepository } = await import('./local-room-repository')
  const conversation: Conversation = {
    id: 'native-reentrant-room', target: { type: 'group', groupId: 'native-reentrant-group' },
    title: 'Synthetic native room', createdAt: new Date(12345).toISOString(), lastUsedAt: new Date(12345).toISOString(),
  }
  store.setState({
    agents: [{ id: 'profile:alpha', hermesProfile: 'alpha', name: 'alpha', status: 'running',
      region: 'local', summary: '', createdAt: conversation.createdAt }],
    groups: [{ id: 'native-reentrant-group', name: conversation.title, memberAgentIds: ['profile:alpha'],
      primaryAgentId: 'profile:alpha', createdAt: conversation.createdAt }],
    conversations: [conversation], selectedConversationId: conversation.id,
  })
  let tick = () => {}
  let finishResume!: () => void
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const io: RoomServeIO = {
    request: async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      const binding = { session_id: 'native-runtime-alpha', stored_session_id: 'native-stored-alpha',
        info: { profile_name: 'alpha' } }
      if (method === 'session.create') return binding as T
      if (method === 'session.resume') {
        if (holdResume) return await new Promise<unknown>(resolve => { finishResume = () => resolve(binding) }) as T
        return binding as T
      }
      if (method === 'prompt.submit') {
        const journal = store.getState().conversations[0]!.localRoom!
        expect(persist.isRoomJournalPersisted(conversation.id, journal)).toBe(true)
        return { status: 'streaming' } as T
      }
      if (method === 'session.events.since') return { events: [], latest_seq: 0 } as T
      if (method === 'session.active_list') return { sessions: [{ id: binding.session_id, status: 'working' }] } as T
      return { status: 'interrupted' } as T
    },
    emit: vi.fn(), dispatchRequest: vi.fn(), clearSessionRequests: vi.fn(), captureSessionRequests: () => vi.fn(),
  }
  const runner = new LocalRoomRunner(io, createRoomRepository(), {
    now: () => 12345, defer: callback => queueMicrotask(callback),
    every: callback => { tick = callback; return () => {} },
  })
  const internals = runner as unknown as {
    starting: Map<string, unknown>; bindingInflight: Map<string, unknown>;
    dispatchPaused: Set<string>; recovered: Set<string>; interruptInflight: Map<string, unknown>
  }
  return {
    runner, conversation, store, calls, native, internals, io, persist,
    failedBindingWrite: () => failedBindingWrite,
    tick: () => tick(), finishResume: () => finishResume(),
    drain: async () => { for (let i = 0; i < 100; i++) await Promise.resolve() },
    cleanup: () => {
      runner.dispose()
      persist.cancelPendingPersist()
      delete (window as unknown as { nubAgent?: unknown }).nubAgent
      window.localStorage.clear()
      vi.resetModules()
    },
  }
}

function holdInterrupts(f: Awaited<ReturnType<typeof nativeRepositoryFixture>>, onRequest?: () => void) {
  const request = f.io.request
  const pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = []
  f.io.request = <T>(method: string, params: Record<string, unknown>) => {
    const recorded = request<T>(method, params)
    if (method !== 'session.interrupt') return recorded
    const result = new Promise<unknown>((resolve, reject) => { pending.push({ resolve, reject }) })
    onRequest?.()
    return result as Promise<T>
  }
  return {
    settle: (outcome: 'accepted' | 'refused' | 'rejected') => {
      for (const held of pending.splice(0)) {
        if (outcome === 'rejected') held.reject(new Error('Synthetic interruption disconnected'))
        else held.resolve({ status: outcome === 'accepted' ? 'interrupted' : 'not_interrupted' })
      }
    },
  }
}

function fixture(durable = true, chief = false) {
  const conversation: Conversation = {
    id: 'headless-room', target: { type: 'group', groupId: 'group' },
    title: 'Room', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
  }
  let exists = true
  let profiles = ['alpha', 'beta']
  let listener = () => {}
  const queued: (() => void)[] = []
  const release = vi.fn()
  const cancelTimer = vi.fn()
  let tick = () => {}
  const checkpoints: string[] = []
  const repository: RoomRepository = {
    read: () => exists ? { conversation, definition: {
      name: 'Room', members: profiles.map(profile => ({
        id: `profile:${profile}`, profile, name: profile,
        ...(chief && profile === 'alpha' ? { role: 'orchestrator' as const } : {}),
      })),
    } } : null,
    list: () => exists ? [conversation] : [],
    subscribe: callback => { listener = callback; return release },
    publish: room => { conversation.localRoom = room.state; return [] },
    captureTranscript: () => vi.fn(),
    checkpoint: room => { checkpoints.push(JSON.stringify(room?.state)); return durable },
    retire: vi.fn(),
    disable: vi.fn(),
  }
  const clock: RoomClock = {
    now: () => 12345, defer: callback => { queued.push(callback) },
    every: callback => { tick = callback; return cancelTimer },
  }
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const io: RoomServeIO = {
    request: async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'prompt.submit') expect(checkpoints.some(c =>
        c && JSON.parse(c).turns.some((t: { submittedText?: string }) => t.submittedText === params.text))).toBe(true)
      return (method === 'session.create' || method === 'session.resume'
        ? { session_id: `runtime:${params.profile}`, stored_session_id: `stored:${params.profile}` }
        : { status: method === 'session.interrupt' ? 'interrupted' : 'streaming' }) as T
    },
    emit: vi.fn(), dispatchRequest: vi.fn(), clearSessionRequests: vi.fn(),
    captureSessionRequests: () => vi.fn(),
  }
  const runner = new LocalRoomRunner(io, repository, clock)
  return { runner, conversation, repository, calls, release, cancelTimer, io, clock,
    tick: () => tick(),
    setMembers: (value: string[]) => { profiles = value; listener() },
    setDurable: (value: boolean) => { durable = value },
    remove: () => { exists = false; listener() },
    pump: async () => {
      while (queued.length) queued.shift()!()
      for (let i = 0; i < 12; i++) await Promise.resolve()
    } }
}

describe('room execution through injected adapters', () => {
  it.each(['get', 'budget', 'stop', 'retry', 'dispose'] as const)(
    'keeps replacement-owned persisted results and requests untouched by a retired %s control',
    async operation => {
      const f = await nativeRepositoryFixture(false, false)
      let replacement: LocalRoomRunner | undefined
      try {
        await f.runner.send(f.conversation, '@alpha original owner')
        await f.drain()
        const retiredRoom = f.runner.get(f.conversation.id)
        f.runner.dispose()
        const { createRoomRepository } = await import('./local-room-repository')
        replacement = new LocalRoomRunner(f.io, createRoomRepository(), {
          now: () => 12345, defer: callback => queueMicrotask(callback), every: () => () => {},
        })
        await replacement.recover(f.conversation.id, true)
        replacement.handleEvent({ type: 'tool.complete', session_id: 'native-runtime-alpha', seq: 1, payload: {
          name: 'render_ui', tool_id: 'replacement-widget', result: {
            genuiOccurrence: '33333333-3333-4333-8333-333333333333',
            genui: { version: 1, components: [{ type: 'stat', title: 'Current owner', value: '1' }] },
          },
        } })
        replacement.handleEvent({ type: 'message.complete', session_id: 'native-runtime-alpha', seq: 2,
          payload: { text: 'Replacement-owned result' } })
        await replacement.send(f.conversation, '@alpha replacement work remains active')
        await f.drain()
        const before = structuredClone(f.store.getState().conversations[0]!.localRoom!)
        const oldState = structuredClone(retiredRoom.state), oldMembers = [...retiredRoom.members]
        const durable = f.native.read().value, callCount = f.calls.length
        expect(before.messages.at(-2)?.toolEvents?.[0]?.genui).toBeDefined()
        expect(before.turns.at(-1)?.status).toBe('running')
        expect(f.persist.isRoomJournalPersisted(f.conversation.id, f.store.getState().conversations[0]!.localRoom!)).toBe(true)
        f.native.save.mockClear()
        vi.mocked(f.io.clearSessionRequests).mockClear()
        const outcome = await (async () => {
          if (operation === 'get') return f.runner.get(f.conversation.id)
          if (operation === 'budget') return f.runner.setTokenBudget(f.conversation.id, 17)
          if (operation === 'stop') return f.runner.stop(f.conversation.id)
          if (operation === 'retry') return f.runner.retry(f.conversation.id)
          return f.runner.dispose()
        })().then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
        expect(f.calls.slice(callCount)).toEqual([])
        expect(f.io.clearSessionRequests).not.toHaveBeenCalled()
        expect(f.native.save).not.toHaveBeenCalled()
        expect(f.native.read().value).toBe(durable)
        expect(f.store.getState().conversations[0]!.localRoom).toEqual(before)
        expect(retiredRoom.state).toEqual(oldState)
        expect(retiredRoom.members).toEqual(oldMembers)
        if (operation === 'dispose') expect(outcome).toEqual({ ok: true, value: undefined })
        else {
          expect(outcome.ok).toBe(false)
          if (!outcome.ok) expect(outcome.error).toBeInstanceOf(Error)
        }
      } finally { replacement?.dispose(); f.cleanup() }
    },
  )

  it('still persists a live owner budget change without altering its accepted result', async () => {
    const f = await nativeRepositoryFixture(false, false)
    try {
      await f.runner.send(f.conversation, '@alpha live budget fixture')
      await f.drain()
      f.runner.handleEvent({ type: 'message.complete', session_id: 'native-runtime-alpha', seq: 1,
        payload: { text: 'Accepted live result' } })
      const messages = structuredClone(f.store.getState().conversations[0]!.localRoom!.messages)
      expect(await f.runner.setTokenBudget(f.conversation.id, 17)).toBe(true)
      const current = f.store.getState().conversations[0]!.localRoom!
      expect(current.tokenBudget).toBe(17)
      expect(current.messages).toEqual(messages)
      expect(f.persist.isRoomJournalPersisted(f.conversation.id, current)).toBe(true)
    } finally { f.cleanup() }
  })

  it('keeps reused provider IDs in separate durable room occurrences through live/final/checkpoint projections', async () => {
    const f = fixture()
    let now = 12345
    f.clock.now = () => now
    let restored: LocalRoomRunner | undefined
    const tokens = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    try {
      for (const [i, genuiOccurrence] of tokens.entries()) {
        now += 1000
        await f.runner.send(f.conversation, '@alpha same data')
        await f.pump()
        f.runner.handleEvent({ type: 'tool.complete', session_id: 'runtime:alpha', seq: 2 * i + 1, payload: {
          name: 'render_ui', tool_id: 'reused', result: { genuiOccurrence,
            genui: { version: 1, components: [{ type: 'checklist', title: 'Same data', items: [{ id: 'review', label: 'Review' }] }] } },
        } })
        const live = mergeRoomFeed([], f.runner.get(f.conversation.id).feed(), { conversationId: f.conversation.id }).messages
        expect(live.filter(message => message.role === 'agent').map(message => message.toolEvents![0].genuiOccurrence))
          .toEqual(tokens.slice(0, i + 1))
        f.runner.handleEvent({ type: 'message.complete', session_id: 'runtime:alpha', seq: 2 * i + 2, payload: { text: '' } })
      }
      const saved = JSON.parse(JSON.stringify(f.conversation.localRoom!))
      f.runner.dispose()
      f.conversation.localRoom = saved
      restored = new LocalRoomRunner(f.io, f.repository, f.clock)
      const projected = mergeRoomFeed([], restored.get(f.conversation.id).feed(), { conversationId: f.conversation.id }).messages
        .filter(message => message.role === 'agent')
      expect(projected.map(message => message.toolEvents![0].genuiOccurrence)).toEqual(tokens)
      expect(projected.map(message => message.toolEvents![0].toolCallId)).toEqual(['reused', 'reused'])
      expect(f.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(2)
    } finally { restored?.dispose(); f.runner.dispose() }
  })
  it.each(['success', 'failed', 'cancelled', 'malformed', 'pending', 'terminal-error', 'closed'])('recovers preceding render completion before terminal after disconnect: %s', async outcome => {
    const f = fixture()
    let restored: LocalRoomRunner | undefined
    try {
      await f.runner.send(f.conversation, '@alpha show data')
      await f.pump()
      expect(f.conversation.localRoom!.turns[0]).toMatchObject({ status: 'running' })
      expect(f.conversation.localRoom!.turns[0].toolEvents).toBeUndefined()
      f.runner.dispose()
      const request = f.io.request
      f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
        if (method === 'session.events.since') return { latest_seq: 5, events: [
          { type: 'tool.complete', session_id: 'foreign', seq: 1, payload: { name: 'render_ui', tool_id: 'foreign', result: { genui: { version: 1, components: [{ type: 'stat', title: 'Foreign', value: '0' }] } } } },
          { type: 'tool.complete', session_id: 'runtime:alpha', seq: 2, payload: {
            name: 'mcp__hermes_desk__render_ui', tool_id: 'reused',
            result: { genui: { version: 1, components: [{ type: outcome === 'malformed' ? 'html' : 'stat', title: 'Estimate', value: '12' }] },
              genuiOccurrence: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              ...(outcome === 'pending' ? { status: 'pending' } : {}),
              ...(outcome === 'failed' ? { isError: true } : {}) },
          } },
          ...(outcome === 'closed' ? [{ type: 'session.closed', session_id: 'runtime:alpha', seq: 3, payload: {} }] : []),
          { type: 'message.complete', session_id: 'runtime:alpha', seq: 4,
            payload: { text: 'Successful estimate', ...(outcome === 'cancelled' ? { status: 'interrupted' } : {}),
              ...(outcome === 'terminal-error' ? { status: 'error' } : {}) } },
          { type: 'tool.complete', session_id: 'runtime:alpha', seq: 5, payload: {
            name: 'render_ui', tool_id: 'too-late', result: { genui: { version: 1, components: [{ type: 'stat', title: 'Late', value: '99' }] } },
          } },
        ] } as T
        return request<T>(method, params)
      }
      restored = new LocalRoomRunner(f.io, f.repository, f.clock)
      await restored.recover(f.conversation.id, true)
      const messages = f.conversation.localRoom!.messages.filter(message => message.speakerKind === 'agent')
      const cancelled = ['cancelled', 'terminal-error', 'closed'].includes(outcome)
      expect(messages).toHaveLength(cancelled ? 0 : 1)
      if (!cancelled) {
        expect(messages[0].text).toBe('Successful estimate')
        expect(messages[0].toolEvents ?? []).toHaveLength(outcome === 'success' ? 1 : 0)
        if (outcome === 'success') {
          expect(messages[0].toolEvents![0]).toMatchObject({ toolCallId: 'reused', genuiOccurrence: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
          expect(JSON.parse(JSON.stringify(f.conversation.localRoom)).messages.find((message: { toolEvents?: unknown }) => message.toolEvents)?.toolEvents)
            .toEqual(messages[0].toolEvents)
        }
      }
      expect(f.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
      await restored.recover(f.conversation.id, true)
      expect(f.conversation.localRoom!.messages.filter(message => message.speakerKind === 'agent')).toEqual(messages)
    } finally { restored?.dispose(); f.runner.dispose() }
  })
  it('retains completed data-only tool output for the owning member, checkpoints it and ignores failed, repeated and cancelled output', async () => {
    const f = fixture()
    try {
      await f.runner.send(f.conversation, '@alpha show data')
      await f.pump()
      const payload = { name: 'mcp_hermes-desk_render_ui', tool_id: 'widget-1', result: {
        genui: { version: 1, components: [{ type: 'stat', title: 'Agent estimate', value: '12' }] },
      } }
      f.runner.handleEvent({ type: 'tool.complete', session_id: 'not-this-room', seq: 1, payload })
      expect(f.runner.get(f.conversation.id).state.turns[0].toolEvents).toBeUndefined()
      f.runner.handleEvent({ type: 'tool.complete', session_id: 'runtime:alpha', seq: 1, payload })
      f.runner.handleEvent({ type: 'tool.complete', session_id: 'runtime:alpha', seq: 2, payload })
      f.runner.handleEvent({ type: 'tool.complete', session_id: 'runtime:alpha', seq: 3,
        payload: { ...payload, tool_id: 'failed', result: { ...payload.result, isError: true } } })
      f.runner.handleEvent({ type: 'message.complete', session_id: 'runtime:alpha', seq: 4, payload: { text: '' } })
      const room = f.runner.get(f.conversation.id)
      expect(room.state.messages.at(-1)).toMatchObject({ speakerId: 'profile:alpha', text: '', toolEvents: [{
        toolCallId: 'widget-1', status: 'completed', genui: payload.result.genui,
      }] })
      const saved = JSON.parse(JSON.stringify(room.state))
      expect(saved.turns[0].status).toBe('sent')
      expect(saved.messages.at(-1).toolEvents).toHaveLength(1)
      await f.runner.send(f.conversation, '@beta show data')
      await f.pump()
      await f.runner.stop(f.conversation.id)
      f.runner.handleEvent({ type: 'tool.complete', session_id: 'runtime:beta', seq: 1, payload })
      expect(room.state.messages.filter(m => m.speakerId === 'profile:beta')).toEqual([])
    } finally { f.runner.dispose() }
  })

  it('retains desktop capabilities but resumes read-only without a second recovery driver', async () => {
    const f = fixture()
    try {
      f.runner.setEpoch('one')
      await f.runner.send(f.conversation, '@alpha investigate')
      await f.pump()
      expect(f.calls.find(c => c.method === 'session.create')?.params).toMatchObject({
        source: 'desktop', follow_profile_config: true,
      })
      f.runner.setEpoch('two')
      await f.runner.recover(f.conversation.id, true)
      const resume = f.calls.find(c => c.method === 'session.resume')?.params
      expect(resume).toMatchObject({ lazy: true, omit_messages: true })
      expect(resume).not.toHaveProperty('follow_profile_config')
      expect(resume).not.toHaveProperty('source')
      expect(rendererRpcAllowed({ jsonrpc: '2.0', id: 1, method: 'session.resume', params: resume })).toBe(true)
      expect(f.io.clearSessionRequests).toHaveBeenCalledWith('runtime:alpha', f.conversation.id)
    } finally { f.runner.dispose() }
  })

  it.each(['current', 'superseded', 'disposed'] as const)(
    'fences an epoch transition when request cleanup synchronously leaves its owner %s',
    async ownership => {
      const f = fixture()
      let disposed = false
      try {
        f.runner.setEpoch('initial')
        await f.runner.send(f.conversation, '@alpha epoch transition fixture')
        await f.runner.send(f.conversation, '@beta epoch transition fixture')
        await f.pump()
        const room = f.runner.get(f.conversation.id)
        let retirementState: string | undefined, reentered = false
        vi.mocked(f.io.clearSessionRequests).mockImplementation(() => {
          if (reentered) return
          reentered = true
          if (ownership === 'superseded') f.runner.setEpoch('newest')
          if (ownership === 'disposed') {
            disposed = true
            f.runner.dispose()
            retirementState = JSON.stringify(room.state)
          }
        })
        f.runner.setEpoch('intermediate')
        if (ownership === 'disposed') {
          expect(JSON.stringify(room.state)).toBe(retirementState)
          expect(f.release).toHaveBeenCalledOnce()
          expect(f.cancelTimer).toHaveBeenCalledOnce()
        } else {
          expect(Object.values(room.state.bindings).map(binding => binding.epoch))
            .toEqual(Array(2).fill(ownership === 'superseded' ? 'newest' : 'intermediate'))
          expect(Object.values(f.conversation.localRoom!.bindings).map(binding => binding.epoch))
            .toEqual(Object.values(room.state.bindings).map(binding => binding.epoch))
        }
        expect(f.io.clearSessionRequests).toHaveBeenCalledTimes(ownership === 'current' ? 2 : 3)
        await f.pump()
        expect(f.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(2)
        expect(room.state.turns.every(turn => turn.status === 'running' && !!turn.submittedText)).toBe(true)
      } finally { if (!disposed) f.runner.dispose() }
    },
  )

  it('stops an older epoch before touching another room when publication synchronously replaces it', async () => {
    const f = fixture()
    try {
      f.runner.setEpoch('initial')
      await f.runner.send(f.conversation, '@alpha epoch publication fixture')
      await f.pump()
      const first = f.runner.get(f.conversation.id)
      const other = { ...f.conversation, id: 'other-epoch-room', localRoom: undefined } as Conversation
      const read = f.repository.read, publish = f.repository.publish
      f.repository.read = id => {
        const record = read(id)
        return record && id === other.id ? { ...record, conversation: other } : record
      }
      f.repository.list = () => [f.conversation, other]
      const second = f.runner.get(other.id)
      second.setBinding('profile:alpha', {
        ...first.state.bindings['profile:alpha'], runtimeId: 'other-runtime', storedId: 'other-stored',
      })
      let reentered = false
      f.repository.publish = (room, settled) => {
        const events = room === second ? (other.localRoom = room.state, []) : publish(room, settled)
        if (!reentered && room === first && room.state.bindings['profile:alpha'].epoch === 'intermediate') {
          reentered = true
          f.runner.setEpoch('newest')
        }
        return events
      }
      f.runner.setEpoch('intermediate')
      expect(first.state.bindings['profile:alpha'].epoch).toBe('newest')
      expect(second.state.bindings['profile:alpha'].epoch).toBe('newest')
      expect(other.localRoom!.bindings['profile:alpha'].epoch).toBe('newest')
      expect(vi.mocked(f.io.clearSessionRequests).mock.calls.filter(([session]) => session === 'other-runtime')).toHaveLength(1)
      expect(f.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
    } finally { f.runner.dispose() }
  })

  it('runs independent member sessions only after durable intent, without the app store', async () => {
    const f = fixture()
    try {
      await f.runner.send(f.conversation, '@alpha investigate')
      await f.runner.send(f.conversation, '@beta investigate')
      await f.pump()
      expect(f.calls.filter(c => c.method === 'session.create').map(c => c.params.profile)).toEqual(['alpha', 'beta'])
      expect(f.calls.filter(c => c.method === 'prompt.submit').map(c => c.params.session_id)).toEqual(['runtime:alpha', 'runtime:beta'])
      expect(f.runner.get(f.conversation.id).state.turns.map(t => t.status)).toEqual(['running', 'running'])
      expect(f.runner.get(f.conversation.id).state.turns.every(t => t.lastContactAt === 12345)).toBe(true)
      expect(f.runner.get(f.conversation.id).state.turns.every(t => t.startedAt === new Date(12345).toISOString())).toBe(true)
    } finally { f.runner.dispose() }
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.cancelTimer).toHaveBeenCalledOnce()
  })

  it('rolls back an unsaved human message without creating a session', async () => {
    const f = fixture(false)
    try {
      await expect(f.runner.send(f.conversation, '@alpha investigate')).rejects.toThrow('Could not save')
      await f.pump()
      expect(f.runner.get(f.conversation.id).state.messages).toEqual([])
      expect(f.calls).toEqual([])
    } finally { f.runner.dispose() }
  })

  it.each(['delegation', 'wrap'] as const)('keeps unsaved generated %s queued until explicit durable recovery', async path => {
    const f = fixture(true, true)
    try {
      f.runner.setEpoch('one')
      await f.runner.send(f.conversation, 'Investigate the fixture', { echoId: 'durable-root' })
      await f.pump()
      f.runner.handleEvent({
        type: 'message.complete', session_id: 'runtime:alpha', seq: 1,
        payload: { text: '@beta investigate the specialist fixture' },
      })
      if (path === 'wrap') {
        await f.pump()
        f.runner.setEpoch('two')
      }
      f.setDurable(false)
      if (path === 'wrap') f.runner.handleEvent({
        type: 'message.complete', session_id: 'runtime:beta', seq: 1,
        payload: { text: 'Specialist result' },
      })
      const callsBefore = f.calls.length
      await f.pump()
      expect(f.calls.slice(callsBefore)).toEqual([])
      const room = f.runner.get(f.conversation.id)
      const pending = room.state.turns.at(-1)!
      expect(pending).toMatchObject({ status: 'queued', kind: path === 'wrap' ? 'wrap' : 'reply' })
      expect(room.state.turns.slice(0, -1).every(t => t.status === 'sent')).toBe(true)
      expect(room.state.messages.filter(m => m.speakerKind === 'human')).toHaveLength(1)
      const before = structuredClone(room.state)
      f.setDurable(true)
      f.tick()
      await f.pump()
      expect(f.calls.slice(callsBefore)).toEqual([])
      await f.runner.recover(f.conversation.id, true)
      await f.pump()
      await f.runner.recover(f.conversation.id, true)
      await f.pump()
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(path === 'wrap' ? 3 : 2)
      expect(room.state.turns.at(-1)).toMatchObject({
        id: pending.id, rootId: pending.rootId, triggerId: pending.triggerId, memberId: pending.memberId, status: 'running',
      })
      expect(room.state.messages).toEqual(before.messages)
      expect(room.state.bindings['profile:alpha']?.storedId).toBe('stored:alpha')
    } finally { f.runner.dispose() }
  })

  it('refuses delegation after an unsaved completion without losing the accepted request or result', async () => {
    const f = fixture()
    try {
      await f.runner.send(f.conversation, '@alpha initial fixture')
      await f.pump()
      f.setDurable(false)
      f.runner.handleEvent({
        type: 'message.complete', session_id: 'runtime:alpha', seq: 1,
        payload: { text: '@beta execute the next fixture stage' },
      })
      await f.pump()
      const room = f.runner.get(f.conversation.id)
      expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(1)
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
      expect(room.state.turns.map(t => t.status)).toEqual(['sent', 'queued'])
      expect(room.state.messages.map(m => m.speakerKind)).toEqual(['human', 'agent'])
      const pending = room.state.turns[1]!
      f.setDurable(true)
      await f.runner.send(f.conversation, '@alpha independent fixture')
      await f.pump()
      expect(f.calls.filter(c => c.method === 'prompt.submit' && c.params.profile === 'beta')).toHaveLength(1)
      expect(room.state.turns[1]).toMatchObject({ id: pending.id, rootId: pending.rootId, status: 'running' })
      expect(room.state.messages.filter(m => m.speakerKind === 'human')).toHaveLength(2)
    } finally { f.runner.dispose() }
  })

  it.each(['binding', 'submission'] as const)('retains an unsubmitted turn after a failed %s checkpoint without completing or duplicating it', async stage => {
    const f = fixture()
    try {
      const checkpoint = f.repository.checkpoint
      let fail = true
      f.repository.checkpoint = room => {
        const binding = room?.state.bindings['profile:alpha']
        if (fail && binding && (stage === 'binding' || room?.state.turns.some(t => t.submittedText))) return false
        return checkpoint(room)
      }
      await f.runner.send(f.conversation, '@alpha retained fixture')
      await f.pump()
      const room = f.runner.get(f.conversation.id)
      const turn = room.state.turns[0]!
      expect(turn).toMatchObject({ status: 'queued' })
      expect(turn.submittedText).toBeUndefined()
      expect(turn.attempts).toBeUndefined()
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(0)
      expect(room.state.bindings['profile:alpha']).toMatchObject({ storedId: 'stored:alpha', runtimeId: 'runtime:alpha' })
      fail = false
      const request = f.io.request
      f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
        const value = await request<T>(method, params)
        if (method === 'session.resume') return { session_id: 'runtime:alpha', stored_session_id: 'stored:alpha' } as T
        return value
      }
      await f.runner.recover(f.conversation.id, true)
      await f.pump()
      expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(1)
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
      expect(room.state.turns[0]).toMatchObject({ id: turn.id, rootId: turn.rootId, status: 'running' })
      expect(room.state.turns[0]?.attempts).toBeUndefined()
      expect(room.state.messages.filter(m => m.speakerKind === 'human')).toHaveLength(1)
    } finally { f.runner.dispose() }
  })

  it('does not retry refused scheduling on a liveness timer for another active member', async () => {
    const f = fixture()
    try {
      f.setMembers(['alpha', 'beta', 'gamma'])
      await f.runner.send(f.conversation, '@alpha initial fixture')
      await f.runner.send(f.conversation, '@gamma independently active fixture')
      await f.pump()
      const request = f.io.request
      f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
        const result = await request<T>(method, params)
        if (method === 'session.events.since') return { events: [], latest_seq: 0 } as T
        if (method === 'session.active_list') return { sessions: [{ id: 'runtime:gamma', status: 'working' }] } as T
        return result
      }
      f.setDurable(false)
      f.runner.handleEvent({
        type: 'message.complete', session_id: 'runtime:alpha', seq: 1,
        payload: { text: '@beta execute the next fixture stage' },
      })
      await f.pump()
      f.setDurable(true)
      f.tick()
      await f.pump()
      expect(f.calls.filter(c => c.method === 'session.events.since')).toHaveLength(1)
      expect(f.calls.filter(c => c.method === 'session.create' && c.params.profile === 'beta')).toEqual([])
      await f.runner.recover(f.conversation.id, true)
      await f.pump()
      expect(f.calls.filter(c => c.method === 'prompt.submit' && c.params.profile === 'beta')).toHaveLength(1)
    } finally { f.runner.dispose() }
  })

  it('holds a sibling binding callback after a parallel dispatch checkpoint failed', async () => {
    const f = fixture()
    try {
      f.setMembers(['alpha', 'beta', 'gamma'])
      await f.runner.send(f.conversation, '@alpha initial fixture')
      await f.pump()
      let failed = false
      const checkpoint = f.repository.checkpoint
      f.repository.checkpoint = room => {
        if (!failed && room?.state.bindings['profile:beta']) {
          failed = true
          return false
        }
        return checkpoint(room)
      }
      f.runner.handleEvent({
        type: 'message.complete', session_id: 'runtime:alpha', seq: 1,
        payload: { text: '@beta investigate the first fixture. @gamma investigate the second fixture.' },
      })
      await f.pump()
      expect(failed).toBe(true)
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
      const room = f.runner.get(f.conversation.id)
      expect(room.state.turns.map(t => t.status)).toEqual(['sent', 'queued', 'queued'])
      await f.runner.recover(f.conversation.id, true)
      await f.pump()
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(3)
      expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(3)
    } finally { f.runner.dispose() }
  })

  it.each(['claim', 'submission'] as const)('respects synchronous Stop during the %s checkpoint', async stage => {
    const f = fixture()
    let stopped = false
    const checkpoint = f.repository.checkpoint
    f.repository.checkpoint = room => {
      if (!stopped && room?.state.turns.some(t => t.status === 'running' &&
        (stage === 'claim' || !!t.submittedText))) {
        stopped = true
        void f.runner.stop(f.conversation.id)
      }
      return checkpoint(room)
    }
    try {
      await f.runner.send(f.conversation, '@alpha cancel at the durable boundary')
      await f.pump()
      expect(stopped).toBe(true)
      expect(f.runner.get(f.conversation.id).state.turns[0]?.status).toBe('cancelled')
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toEqual([])
      if (stage === 'claim') expect(f.calls.filter(c => c.method === 'session.create')).toEqual([])
    } finally { f.runner.dispose() }
  })

  it('does not cache an attachment binding as durable after its checkpoint fails', async () => {
    const f = fixture()
    const request = f.io.request
    f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
      const result = await request<T>(method, params)
      if (method === 'session.create') f.setDurable(false)
      return result
    }
    try {
      await expect(f.runner.attachmentSession(f.conversation.id)).rejects.toThrow(/persist/)
      await expect(f.runner.attachmentSession(f.conversation.id)).rejects.toThrow(/persist/)
      expect(f.calls.filter(c => ['session.create', 'session.resume'].includes(c.method))).toHaveLength(1)
    } finally { f.runner.dispose() }
  })

  it.each(['current', 'adopted', 'usage', 'superseded', 'disposed', 'closed', 'rebound', 'reordered'] as const)(
    'retains cached attachment authority only when its await owner remains %s',
    async ownership => {
      const f = fixture()
      let disposed = false
      try {
        if (ownership !== 'adopted') f.runner.setEpoch('first')
        const binding = await f.runner.attachmentSession(f.conversation.id)
        const before = f.calls.length
        const pending = f.runner.attachmentSession(f.conversation.id).then(
          value => ({ ok: true as const, value }), error => ({ ok: false as const, error }),
        )
        if (ownership === 'superseded') f.runner.setEpoch('second')
        if (ownership === 'adopted') f.runner.setEpoch('first')
        if (ownership === 'disposed') { disposed = true; f.runner.dispose() }
        if (ownership === 'closed' || ownership === 'usage') f.runner.handleEvent({
          type: ownership === 'closed' ? 'session.closed' : 'session.usage', session_id: binding.runtimeId,
          seq: 1, payload: {},
        })
        if (ownership === 'rebound') f.runner.get(f.conversation.id).setBinding('profile:alpha', {
          ...binding, runtimeId: 'replacement-runtime',
        })
        if (ownership === 'reordered') f.setMembers(['beta', 'alpha'])
        const result = await pending
        if (['disposed', 'superseded', 'closed', 'rebound', 'reordered'].includes(ownership)) {
          expect(result.ok).toBe(false)
          if (!result.ok) expect(result.error).toBeInstanceOf(Error)
        } else {
          expect(result).toEqual({ ok: true, value: binding })
        }
        expect(f.calls.slice(before)).toEqual([])
        expect(f.calls.filter(call => call.method === 'session.create')).toHaveLength(1)
        expect(f.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(0)
      } finally { if (!disposed) f.runner.dispose() }
    },
  )

  it('rejects an already disposed attachment caller before stale membership reconciliation can checkpoint', async () => {
    const f = fixture()
    try {
      await f.runner.attachmentSession(f.conversation.id)
      const room = f.runner.get(f.conversation.id), before = structuredClone(room.state)
      const members = [...room.members]
      f.runner.dispose()
      f.setMembers(['beta'])
      const read = vi.spyOn(f.repository, 'read'), checkpoint = vi.spyOn(f.repository, 'checkpoint')
      await expect(f.runner.attachmentSession(f.conversation.id)).rejects.toThrow()
      expect(checkpoint).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      expect(room.state).toEqual(before)
      expect(room.members).toEqual(members)
    } finally { f.runner.dispose() }
  })

  it.each([false, true])('recovers a saved unsubmitted claim with an existing binding=%s exactly once', async bound => {
    const f = fixture()
    let restored: LocalRoomRunner | undefined
    try {
      if (bound) await f.runner.attachmentSession(f.conversation.id)
      await f.runner.send(f.conversation, '@alpha durable unsubmitted claim')
      const room = f.runner.get(f.conversation.id)
      const claimed = room.takeReady()[0]!
      f.runner.publish(room)
      expect(f.repository.checkpoint(room)).toBe(true)
      f.runner.dispose()
      const request = f.io.request
      f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
        const value = await request<T>(method, params)
        if (method === 'session.resume') return { session_id: 'runtime:alpha', stored_session_id: 'stored:alpha' } as T
        if (method === 'session.events.since') return { events: [], latest_seq: 0 } as T
        if (method === 'session.active_list') return { sessions: [{ id: 'runtime:alpha', status: 'working' }] } as T
        return value
      }
      restored = new LocalRoomRunner(f.io, f.repository, f.clock)
      await restored.recover(f.conversation.id)
      await f.pump()
      await restored.recover(f.conversation.id, true)
      await f.pump()
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
      expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(1)
      expect(restored.get(f.conversation.id).state.turns[0]).toMatchObject({
        id: claimed.id, rootId: claimed.rootId, status: 'running',
      })
      expect(restored.get(f.conversation.id).state.turns[0]?.attempts).toBeUndefined()
      expect(restored.get(f.conversation.id).state.messages.filter(m => m.speakerKind === 'human')).toHaveLength(1)
    } finally { restored?.dispose(); f.runner.dispose() }
  })

  it('an explicit recovery joining a liveness replay still resumes durably paused work', async () => {
    const f = fixture()
    try {
      f.setMembers(['alpha', 'beta', 'gamma'])
      await f.runner.send(f.conversation, '@alpha initial fixture')
      await f.runner.send(f.conversation, '@gamma independently active fixture')
      await f.pump()
      f.setDurable(false)
      f.runner.handleEvent({
        type: 'message.complete', session_id: 'runtime:alpha', seq: 1,
        payload: { text: '@beta execute the next fixture stage' },
      })
      await f.pump()
      f.setDurable(true)
      const request = f.io.request
      let finishReplay!: (value: unknown) => void
      f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
        const result = await request<T>(method, params)
        if (method === 'session.events.since')
          return await new Promise<unknown>(resolve => { finishReplay = resolve }) as T
        if (method === 'session.active_list') return { sessions: [{ id: 'runtime:gamma', status: 'working' }] } as T
        return result
      }
      f.tick()
      await f.pump()
      const explicit = f.runner.recover(f.conversation.id, true)
      finishReplay({ events: [], latest_seq: 0 })
      await explicit
      await f.pump()
      expect(f.calls.filter(c => c.method === 'prompt.submit' && c.params.profile === 'beta')).toHaveLength(1)
      expect(f.calls.filter(c => c.method === 'session.events.since')).toHaveLength(1)
    } finally { f.runner.dispose() }
  })

  it.each(['stop', 'membership'] as const)('never reverses local %s cancellation when its checkpoint fails', async action => {
    const f = fixture()
    try {
      await f.runner.send(f.conversation, '@alpha cancelled fixture')
      await f.pump()
      f.setDurable(false)
      if (action === 'stop') expect(await f.runner.stop(f.conversation.id)).toBe(true)
      else f.setMembers(['beta'])
      const room = f.runner.get(f.conversation.id)
      expect(room.state.turns[0]?.status).toBe('cancelled')
      expect(room.state.bindings['profile:alpha']?.blocked).toBe(true)
      f.runner.handleEvent({
        type: 'message.complete', session_id: 'runtime:alpha', seq: 1,
        payload: { text: 'Cancelled late result' },
      })
      f.setDurable(true)
      await f.runner.recover(f.conversation.id, true)
      await f.pump()
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
      expect(room.state.turns[0]?.status).toBe('cancelled')
      expect(room.state.messages.some(m => m.text === 'Cancelled late result')).toBe(false)
    } finally { f.runner.dispose() }
  })

  it.each(['member removed', 'epoch replaced', 'current membership'] as const)(
    'does not retarget an attachment-bearing pending send during recovery with %s',
    async ownership => {
      const f = fixture()
      let finishReplay!: () => void, held = false
      try {
        f.runner.setEpoch('send-initial')
        await f.runner.send(f.conversation, '@alpha original active work')
        for (let i = 0; i < 3; i++) await f.pump()
        const request = f.io.request
        f.io.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
          const response = request<T>(method, params)
          if (method === 'session.events.since' && !held) {
            held = true
            return new Promise<T>((resolve, reject) => { finishReplay = () => void response.then(resolve, reject) })
          }
          return response
        }
        f.runner.setEpoch('send-recovery')
        const pending = f.runner.send(f.conversation, '@alpha intended attachment recipient', {
          attachments: [{ name: 'synthetic-note.txt', path: '/fixture/upload/synthetic-note.txt', size: 1, kind: 'file' }],
        }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
        for (let i = 0; i < 3; i++) await f.pump()
        expect(held).toBe(true)
        if (ownership === 'member removed') f.setMembers(['beta'])
        else {
          if (ownership === 'epoch replaced') f.runner.setEpoch('send-replacement')
          f.runner.handleEvent({ type: 'message.complete', session_id: 'runtime:alpha', seq: 1,
            payload: { text: 'Original active work settled' } })
        }
        finishReplay()
        const result = await pending
        for (let i = 0; i < 3; i++) await f.pump()
        if (ownership !== 'current membership') {
          expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
          expect(f.runner.get(f.conversation.id).state.messages.filter(m => m.speakerKind === 'human')).toHaveLength(1)
          expect(result.ok).toBe(false)
          if (!result.ok) expect(result.error).toBeInstanceOf(Error)
        } else {
          expect(result.ok).toBe(true)
          expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(2)
          expect(f.calls.filter(c => c.method === 'prompt.submit').at(-1)?.params).toMatchObject({ profile: 'alpha' })
          expect(f.calls.filter(c => c.method === 'prompt.submit').at(-1)?.params.text)
            .toContain('/fixture/upload/synthetic-note.txt')
        }
      } finally { f.runner.dispose() }
    },
  )

  it('rejects an unsaved retry and preserves the original attempt until storage recovers', async () => {
    const f = fixture()
    try {
      await f.runner.send(f.conversation, '@alpha investigate')
      await f.pump()
      f.runner.handleEvent({
        type: 'message.complete', session_id: 'runtime:alpha',
        payload: { status: 'error', error: 'Model unavailable' },
      })
      await f.pump()
      const before = f.runner.get(f.conversation.id).state
      expect(before.turns[0]?.status).toBe('error')
      f.setDurable(false)

      expect(await f.runner.retry(f.conversation.id)).toBe(false)
      await f.pump()
      expect(f.runner.get(f.conversation.id).state).toEqual(before)
      expect(f.conversation.localRoom).toEqual(before)
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)

      f.setDurable(true)
      expect(await f.runner.retry(f.conversation.id)).toBe(true)
      await f.pump()
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(2)
      expect(f.runner.get(f.conversation.id).state.turns[0]).toMatchObject({
        id: before.turns[0]!.id, status: 'running',
        attempts: [{ status: 'error', error: 'Model unavailable' }],
      })
    } finally { f.runner.dispose() }
  })
  it.each(['stale replay result', 'stale replay rejection', 'current root'] as const)(
    'keeps an explicit retry scoped to its original human request after a delayed %s',
    async outcome => {
      const f = fixture()
      const request = f.io.request
      let holdReplay = true, held = false, finishReplay!: () => void
      f.io.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        const response = request<T>(method, params)
        if (holdReplay && method === 'session.events.since' && params.profile === 'beta') {
          held = true
          return new Promise<T>((resolve, reject) => {
            finishReplay = () => outcome === 'stale replay rejection'
              ? reject(new Error('Old recovery failed after replacement'))
              : void response.then(resolve, reject)
          })
        }
        return response
      }
      try {
        f.runner.setEpoch('retry-initial-epoch')
        await f.runner.send(f.conversation, '@alpha @beta original retry target')
        for (let i = 0; i < 3; i++) await f.pump()
        expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
        f.runner.handleEvent({ type: 'message.complete', session_id: 'runtime:alpha', seq: 1,
          payload: { error: 'Original retryable failure' } })
        for (let i = 0; i < 3; i++) await f.pump()
        expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(2)
        const room = f.runner.get(f.conversation.id), originalRoot = room.state.messages[0]!.id
        const retry = f.runner.retry(f.conversation.id)
        await f.pump()
        expect(held).toBe(true)
        holdReplay = false
        if (outcome !== 'current root') f.runner.setEpoch('newer-retry-epoch')
        f.runner.handleEvent({ type: 'message.complete', session_id: 'runtime:beta', seq: 1,
          payload: { text: 'Original peer settled' } })
        if (outcome !== 'current root') {
          await f.runner.send(f.conversation, '@alpha newer request must not be retried')
          await f.pump()
          f.runner.handleEvent({ type: 'message.complete', session_id: 'runtime:alpha', seq: 1,
            payload: { error: 'Newer independently retryable failure' } })
        }
        const before = structuredClone(room.state), submissions = f.calls.filter(c => c.method === 'prompt.submit').length
        finishReplay()
        const retried = await retry
        await f.pump()
        if (outcome === 'current root') {
          expect(retried).toBe(true)
          expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(submissions + 1)
          expect(room.state.turns.find(t => t.memberId === 'profile:alpha')).toMatchObject({
            rootId: originalRoot, status: 'running', attempts: [{ status: 'error', error: 'Original retryable failure' }],
          })
        } else {
          expect(f.calls.filter(c => c.method === 'prompt.submit').slice(submissions)).toEqual([])
          expect(retried).toBe(false)
          expect(room.state).toEqual(before)
          expect(f.conversation.localRoom).toEqual(before)
        }
      } finally { f.runner.dispose() }
    },
  )

  it('retires removed rooms and fences their late events', async () => {
    const f = fixture()
    try {
      await f.runner.send(f.conversation, '@alpha investigate')
      await f.pump()
      f.remove()
      expect(f.repository.retire).toHaveBeenCalledWith(f.conversation.id, 'stored:alpha')
      expect(f.repository.disable).toHaveBeenCalledWith(f.conversation.id)
      expect(f.runner.handleEvent({ type: 'message.complete', session_id: 'runtime:alpha', payload: { text: 'late' } })).toBe(true)
      expect(f.calls.filter(c => c.method === 'session.interrupt')).toHaveLength(1)
    } finally { f.runner.dispose() }
  })

  it.each(['deleted', 'orphaned'] as const)('recovers a valid room after a %s room in the reconnect snapshot', async state => {
    const f = fixture()
    try {
      await f.runner.send(f.conversation, '@alpha investigate')
      await f.pump()
      const stale: Conversation = {
        ...f.conversation, id: 'stale-room',
        localRoom: { ...f.conversation.localRoom!, conversationId: 'stale-room', bindings: {} },
      }
      const read = f.repository.read
      f.repository.list = () => [stale, f.conversation]
      f.repository.read = id => id === stale.id
        ? state === 'deleted' ? null : { conversation: stale, definition: null }
        : read(id)
      const request = f.io.request
      f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
        await request(method, params)
        if (method === 'session.resume') return {
          session_id: 'runtime:alpha', stored_session_id: 'stored:alpha',
        } as T
        if (method === 'session.events.since') return {
          latest_seq: 1, events: [{
            type: 'message.complete', session_id: 'runtime:alpha', seq: 1,
            payload: { text: 'Recovered answer' },
          }],
        } as T
        return { status: 'streaming' } as T
      }

      await expect(f.runner.recoverAll(true)).resolves.toBeUndefined()
      await f.pump()
      expect(f.runner.get(f.conversation.id).state.turns[0]?.status).toBe('sent')
      expect(f.runner.get(f.conversation.id).state.messages.at(-1)?.text).toBe('Recovered answer')
      expect(f.calls.filter(c => c.method === 'session.resume')).toHaveLength(1)
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
    } finally { f.runner.dispose() }
  })

  it('keeps orphaned saved sessions internal but refuses their request and member ownership', async () => {
    const f = fixture()
    let restored: LocalRoomRunner | undefined
    try {
      await f.runner.send(f.conversation, '@alpha investigate')
      await f.pump()
      f.runner.dispose()
      f.repository.read = () => ({ conversation: f.conversation, definition: null })
      restored = new LocalRoomRunner(f.io, f.repository, f.clock)
      expect(restored.conversationForSession('runtime:alpha')?.id).toBe(f.conversation.id)
      expect(restored.isInternalSession('alpha', 'stored:alpha')).toBe(true)
      expect(restored.sessionAcceptsRequests('runtime:alpha')).toBe(false)
      expect(restored.memberForSession('runtime:alpha')).toBeUndefined()
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
    } finally { restored?.dispose(); f.runner.dispose() }
  })

  it.each(['message.delta', 'message.complete', 'session.usage', 'session.closed'])('consumes late %s for an unopened orphaned room without changing its journal', async type => {
    const f = fixture()
    let restored: LocalRoomRunner | undefined
    try {
      await f.runner.send(f.conversation, '@alpha investigate')
      await f.pump()
      f.runner.dispose()
      const before = structuredClone(f.conversation.localRoom)
      f.repository.read = () => ({ conversation: f.conversation, definition: null })
      restored = new LocalRoomRunner(f.io, f.repository, f.clock)
      expect(restored.handleEvent({
        type, session_id: 'runtime:alpha', seq: 2,
        payload: { text: 'Orphan late output', usage: { input: 10, output: 10, total: 20 } },
      })).toBe(true)
      await f.pump()
      expect(f.conversation.localRoom).toEqual(before)
      expect(f.calls.filter(c => c.method !== 'session.create' && c.method !== 'prompt.submit')).toEqual([])
    } finally { restored?.dispose(); f.runner.dispose() }
  })

  it.each(['queued', 'running'] as const)('cancels restored %s work for a departed member without blocking a remaining member', async status => {
    const f = fixture()
    let restored: LocalRoomRunner | undefined
    try {
      await f.runner.send(f.conversation, '@alpha investigate')
      if (status === 'running') await f.pump()
      const rootId = f.conversation.localRoom!.turns[0]!.rootId
      f.runner.dispose()
      f.setMembers(['beta'])
      restored = new LocalRoomRunner(f.io, f.repository, f.clock)

      const room = restored.get(f.conversation.id)
      expect(room.state.turns[0]?.status).toBe('cancelled')
      // Only the departed member's turn ends; its request is not cancelled for the rest of the room.
      expect(room.state.cancelledRoots).not.toContain(rootId)
      expect(f.conversation.localRoom?.turns[0]?.status).toBe('cancelled')
      if (status === 'running') {
        expect(room.state.bindings['profile:alpha']?.blocked).toBe(true)
        expect(f.calls.filter(c => c.method === 'session.interrupt').map(c => c.params.profile)).toEqual(['alpha'])
        restored.handleEvent({
          type: 'message.complete', session_id: 'runtime:alpha', seq: 1,
          payload: { text: 'Departed member late answer' },
        })
      }

      await restored.send(f.conversation, '@beta independent task')
      await f.pump()
      expect(room.state.messages.some(m => m.text === 'Departed member late answer')).toBe(false)
      expect(room.state.turns.at(-1)).toMatchObject({ memberId: 'profile:beta', status: 'running' })
      expect(f.calls.filter(c => c.method === 'prompt.submit' && c.params.profile === 'beta')).toHaveLength(1)
      expect(f.calls.filter(c => c.method === 'prompt.submit' && c.params.profile === 'alpha'))
        .toHaveLength(status === 'running' ? 1 : 0)
    } finally { restored?.dispose(); f.runner.dispose() }
  })

  it.each(['session.usage', 'message.complete'] as const)('keeps late %s usage on the stopped root instead of pausing the next request', async type => {
    const f = fixture()
    const usage = (total: number) => ({ input: total / 2, output: total / 2, total })
    try {
      await f.runner.setTokenBudget(f.conversation.id, 50)
      await f.runner.send(f.conversation, '@alpha old task')
      await f.pump()
      f.runner.handleEvent({
        type: 'session.usage', session_id: 'runtime:alpha', seq: 1,
        payload: { usage: usage(20) },
      })
      expect(await f.runner.stop(f.conversation.id)).toBe(true)
      await f.runner.send(f.conversation, '@alpha @beta fresh task')
      await f.pump()
      const late = {
        type, session_id: 'runtime:alpha', seq: 2,
        payload: { usage: usage(100), text: 'Stopped task late answer' },
      }
      f.runner.handleEvent(late)
      f.runner.handleEvent(late)
      if (type === 'session.usage') f.runner.handleEvent({
        ...late, type: 'message.complete', seq: 3,
      })
      await f.pump()
      const room = f.runner.get(f.conversation.id)
      expect(room.state.turns[0]).toMatchObject({ status: 'cancelled', usage: usage(100) })
      expect(room.state.messages.some(m => m.text === 'Stopped task late answer')).toBe(false)
      expect(room.state.bindings['profile:alpha']?.lastUsage).toEqual(usage(100))
      expect(f.calls.filter(c => c.method === 'prompt.submit' && c.params.profile === 'alpha')).toHaveLength(2)

      f.runner.handleEvent({
        type: 'message.complete', session_id: 'runtime:alpha', seq: 4,
        payload: { usage: usage(120), text: 'Fresh answer' },
      })
      await f.pump()
      expect(room.state.turns[1]?.usage).toEqual(usage(20))
      expect(room.budgetPaused(room.state.turns[1]!.rootId)).toBe(false)
      expect(f.calls.filter(c => c.method === 'prompt.submit' && c.params.profile === 'beta')).toHaveLength(1)
    } finally { f.runner.dispose() }
  })

  it.each(['rejected', 'buffered-completion'] as const)('a disposed runner cannot act on a replacement owner after its replay is %s', async outcome => {
    const f = fixture()
    let replacement: LocalRoomRunner | undefined
    let oldDisposed = false
    try {
      await f.runner.send(f.conversation, '@alpha active fixture task')
      await f.pump()
      f.clock.now = () => 12345 + 9 * 60_000
      const request = f.io.request
      let resolve!: (value: unknown) => void
      let reject!: (error: Error) => void
      f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
        await request(method, params)
        return await new Promise<unknown>((yes, no) => { resolve = yes; reject = no }) as T
      }
      const pending = f.runner.recover(f.conversation.id, true)
      await f.pump()
      expect(f.calls.at(-1)?.method).toBe('session.events.since')
      if (outcome === 'buffered-completion') f.runner.handleEvent({
        type: 'message.complete', session_id: 'runtime:alpha', seq: 2,
        payload: { text: 'Obsolete buffered reply' },
      })
      f.runner.dispose()
      oldDisposed = true
      f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
        const value = await request(method, params)
        if (method === 'session.resume') return {
          session_id: 'runtime:alpha', stored_session_id: 'stored:alpha',
        } as T
        if (method === 'session.events.since') return { events: [], latest_seq: 0 } as T
        if (method === 'session.active_list') return {
          sessions: [{ id: 'runtime:alpha', status: 'working' }],
        } as T
        return value as T
      }
      replacement = new LocalRoomRunner(f.io, f.repository, f.clock)
      await replacement.recover(f.conversation.id, true)
      const before = structuredClone(f.conversation.localRoom)
      const callCount = f.calls.length
      vi.mocked(f.io.clearSessionRequests).mockClear()

      if (outcome === 'rejected') reject(new Error('Fixture replay disconnected'))
      else resolve({ events: [], latest_seq: 0 })
      await pending
      await f.runner.recover(f.conversation.id, true)
      await f.pump()
      expect(f.calls.slice(callCount)).toEqual([])
      expect(f.io.clearSessionRequests).not.toHaveBeenCalled()
      expect(f.conversation.localRoom).toEqual(before)
      expect(f.conversation.localRoom?.turns[0]?.status).toBe('running')
      replacement.handleEvent({
        type: 'message.complete', session_id: 'runtime:alpha', seq: 3,
        payload: { text: 'Replacement owner reply' },
      })
      expect(f.conversation.localRoom?.turns[0]?.status).toBe('sent')
      expect(f.conversation.localRoom?.messages.at(-1)?.text).toBe('Replacement owner reply')
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
    } finally {
      replacement?.dispose()
      if (!oldDisposed) f.runner.dispose()
    }
  })

  it.each(['refused', 'disconnected'] as const)('ignores a disposed submission owner after its RPC is %s', async outcome => {
    const f = fixture()
    let replacement: LocalRoomRunner | undefined
    let oldDisposed = false
    const request = f.io.request
    let reject!: (error: Error) => void
    f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
      const value = await request<T>(method, params)
      if (method === 'prompt.submit') return await new Promise<unknown>((_, no) => { reject = no }) as T
      if (method === 'session.events.since') return { events: [], latest_seq: 0 } as T
      if (method === 'session.active_list') return { sessions: [{ id: 'runtime:alpha', status: 'working' }] } as T
      return value
    }
    try {
      await f.runner.send(f.conversation, '@alpha submission ownership fixture')
      await f.pump()
      const oldRoom = f.runner.get(f.conversation.id)
      expect(oldRoom.state.turns[0]).toMatchObject({ status: 'running', submittedText: expect.any(String) })
      f.runner.dispose()
      oldDisposed = true
      replacement = new LocalRoomRunner(f.io, f.repository, f.clock)
      await replacement.recover(f.conversation.id, true)
      replacement.handleEvent({
        type: 'message.complete', session_id: 'runtime:alpha', seq: 1,
        payload: { text: 'Replacement submission owner reply' },
      })
      const before = structuredClone(f.conversation.localRoom)
      const oldState = structuredClone(oldRoom.state)
      const checkpoint = vi.spyOn(f.repository, 'checkpoint')
      vi.mocked(f.io.clearSessionRequests).mockClear()
      reject(new Error(outcome === 'refused' ? 'Fixture submission refused' : 'Fixture submission disconnected'))
      await f.pump()
      expect(oldRoom.state).toEqual(oldState)
      expect(checkpoint).not.toHaveBeenCalled()
      expect(f.io.clearSessionRequests).not.toHaveBeenCalled()
      expect(f.conversation.localRoom).toEqual(before)
      expect(f.conversation.localRoom?.turns[0]?.status).toBe('sent')
      expect(f.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
    } finally {
      replacement?.dispose()
      if (!oldDisposed) f.runner.dispose()
    }
  })

  it.each(['refused', 'disconnected'] as const)('still handles a current submission RPC that is %s', async outcome => {
    const f = fixture()
    const request = f.io.request
    let reject!: (error: Error) => void
    f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
      const value = await request<T>(method, params)
      if (method === 'prompt.submit') return await new Promise<unknown>((_, no) => { reject = no }) as T
      return value
    }
    try {
      await f.runner.send(f.conversation, '@alpha current submission fixture')
      await f.pump()
      reject(new Error(outcome === 'refused' ? 'Fixture submission refused' : 'Fixture submission disconnected'))
      await f.pump()
      const room = f.runner.get(f.conversation.id)
      if (outcome === 'refused') expect(room.state.turns[0]).toMatchObject({
        status: 'error', error: 'Fixture submission refused',
      })
      else {
        expect(room.state.turns[0]).toMatchObject({ status: 'running', activity: 'reconciling submission' })
        expect(room.state.bindings['profile:alpha']).toMatchObject({ blocked: true })
      }
      expect(f.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
    } finally { f.runner.dispose() }
  })

  it('does not start replay when disposal wins the cached-binding await', async () => {
    const f = fixture()
    try {
      await f.runner.send(f.conversation, '@alpha active fixture task')
      await f.pump()
      const callCount = f.calls.length
      const pending = f.runner.recover(f.conversation.id, true)
      f.runner.dispose()
      await pending
      expect(f.calls.slice(callCount)).toEqual([])
    } finally { f.runner.dispose() }
  })

  it.each(['attachment', 'recovery'] as const)('starts independent %s binding recovery when an old epoch resume still waits', async mode => {
    const f = fixture()
    const request = f.io.request
    let release!: (value: unknown) => void
    let held = false
    let old: Promise<unknown> | undefined
    let fresh: Promise<unknown> | undefined
    let freshOutcome: unknown
    f.runner.setEpoch('first')
    try {
      await f.runner.send(f.conversation, '@alpha epoch binding fixture')
      await f.pump()
      f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
        await request<T>(method, params)
        if (method === 'session.resume') {
          if (!held) {
            held = true
            return await new Promise<unknown>(yes => { release = yes }) as T
          }
          return { session_id: 'current-runtime', stored_session_id: 'stored:alpha', info: { profile_name: 'alpha' } } as T
        }
        if (method === 'session.events.since') return { events: [], latest_seq: 0, epoch: 'current' } as T
        if (method === 'session.active_list') return { sessions: [{ id: 'current-runtime', status: 'working' }] } as T
        return { status: 'streaming' } as T
      }
      const invoke = () => mode === 'attachment' ? f.runner.attachmentSession(f.conversation.id) :
        f.runner.recover(f.conversation.id, true)
      f.runner.setEpoch('retired')
      old = invoke().then(value => ({ ok: true, value }), error => ({ ok: false, error }))
      await f.pump()
      expect(held).toBe(true)
      f.runner.setEpoch('current')
      fresh = invoke().then(value => { freshOutcome = { ok: true, value } },
        error => { freshOutcome = { ok: false, error } })
      await f.pump()
      expect(freshOutcome).toMatchObject({ ok: true })
      expect(f.calls.filter(call => call.method === 'session.resume')).toHaveLength(2)
      const binding = f.runner.get(f.conversation.id).state.bindings['profile:alpha']
      expect(binding).toMatchObject({ runtimeId: 'current-runtime', storedId: 'stored:alpha', epoch: 'current', lastSeen: 0 })
      const before = structuredClone(f.conversation.localRoom)
      vi.mocked(f.io.dispatchRequest).mockClear()
      vi.mocked(f.repository.retire).mockClear()
      release({
        session_id: 'retired-runtime', stored_session_id: 'stored:alpha', info: { profile_name: 'alpha' },
        open_requests: [{ id: 'retired-question', method: 'question', params: {} }],
      })
      await old
      await f.pump()
      expect(f.conversation.localRoom).toEqual(before)
      expect(f.io.dispatchRequest).not.toHaveBeenCalled()
      expect(f.repository.retire).not.toHaveBeenCalled()
      expect(f.calls.filter(call => call.method === 'session.events.since' &&
        call.params.session_id === 'retired-runtime')).toHaveLength(0)
      expect(f.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
    } finally {
      release?.({ session_id: 'retired-runtime', stored_session_id: 'stored:alpha' })
      await Promise.allSettled([old, fresh].filter(promise => promise !== undefined))
      f.runner.dispose()
    }
  })

  it.each([false, true])('handles epoch adoption versus replacement during an unsubmitted session creation: replacement=%s', async replacement => {
    const f = fixture()
    const request = f.io.request
    let release!: (value: unknown) => void
    let held = false
    if (replacement) f.runner.setEpoch('retired')
    f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
      const value = await request<T>(method, params)
      if (method === 'session.create') {
        if (!held) {
          held = true
          return await new Promise<unknown>(yes => { release = yes }) as T
        }
        return { session_id: 'current-runtime', stored_session_id: 'current-stored' } as T
      }
      return value
    }
    try {
      await f.runner.send(f.conversation, '@alpha unsubmitted epoch fixture')
      await f.pump()
      expect(held).toBe(true)
      f.runner.setEpoch('current')
      if (replacement) {
        await f.runner.recover(f.conversation.id, true)
        await f.pump()
        expect(f.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
        expect(f.calls.find(call => call.method === 'prompt.submit')?.params.session_id).toBe('current-runtime')
      } else expect(f.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(0)
      release({ session_id: 'retired-runtime', stored_session_id: 'retired-stored' })
      await f.pump()
      expect(f.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
      expect(f.conversation.localRoom?.bindings['profile:alpha']).toMatchObject({
        runtimeId: replacement ? 'current-runtime' : 'retired-runtime', epoch: 'current',
      })
      if (replacement) expect(f.repository.retire).toHaveBeenCalledExactlyOnceWith('retired-stored', 'retired-stored')
      else expect(f.repository.retire).not.toHaveBeenCalled()
    } finally {
      release?.({ session_id: 'retired-runtime', stored_session_id: 'retired-stored' })
      await f.pump()
      f.runner.dispose()
    }
  })

  it('still retires an unowned newly created session returned after disposal', async () => {
    const f = fixture()
    const request = f.io.request
    let resolve!: (value: unknown) => void
    f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
      const value = await request<T>(method, params)
      if (method === 'session.create') return await new Promise<unknown>(yes => { resolve = yes }) as T
      return value
    }
    await f.runner.send(f.conversation, '@alpha orphan binding fixture')
    await f.pump()
    f.runner.dispose()
    vi.mocked(f.repository.retire).mockClear()
    resolve({ session_id: 'orphan-runtime', stored_session_id: 'orphan-stored' })
    await f.pump()
    expect(f.repository.retire).toHaveBeenCalledExactlyOnceWith('orphan-stored', 'orphan-stored')
    expect(f.conversation.localRoom?.bindings['profile:alpha']).toBeUndefined()
    expect(f.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(0)
  })

  it('still retires a deleted room session returned by a late resume', async () => {
    const f = fixture()
    let pending: Promise<void> | undefined
    const request = f.io.request
    let resolve!: (value: unknown) => void
    f.runner.setEpoch('old')
    try {
      await f.runner.send(f.conversation, '@alpha deleted resume fixture')
      await f.pump()
      f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
        const value = await request<T>(method, params)
        if (method === 'session.resume') return await new Promise<unknown>(yes => { resolve = yes }) as T
        return value
      }
      f.runner.setEpoch('new')
      pending = f.runner.recover(f.conversation.id, true)
      await f.pump()
      f.remove()
      vi.mocked(f.repository.retire).mockClear()
      resolve({ session_id: 'runtime:alpha', stored_session_id: 'stored:alpha' })
      await pending
      expect(f.repository.retire).toHaveBeenCalledExactlyOnceWith(f.conversation.id, 'stored:alpha')
      expect(f.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
    } finally { f.runner.dispose() }
  })

  it.each([false, true])('retries Stop for a quarantined backend run with newer queued work=%s', async queued => {
    const f = fixture()
    const request = f.io.request
    let accepted = false
    f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
      const value = await request(method, params)
      return (method === 'session.interrupt'
        ? { status: accepted ? 'interrupted' : 'not_interrupted' } : value) as T
    }
    try {
      await f.runner.send(f.conversation, '@alpha original task')
      await f.pump()
      expect(await f.runner.stop(f.conversation.id)).toBe(false)
      if (queued) {
        await f.runner.send(f.conversation, '@alpha queued after refusal')
        await f.pump()
      }
      accepted = true
      expect(await f.runner.stop(f.conversation.id)).toBe(true)
      expect(f.calls.filter(c => c.method === 'session.interrupt').map(c => c.params.session_id))
        .toEqual(['runtime:alpha', 'runtime:alpha'])
      const room = f.runner.get(f.conversation.id)
      expect(room.state.turns.every(t => t.status === 'cancelled')).toBe(true)
      expect(room.state.bindings['profile:alpha']?.blocked).toBe(true)
      f.runner.handleEvent({
        type: 'message.complete', session_id: 'runtime:alpha', seq: 1,
        payload: { text: 'Late stopped reply' },
      })
      await f.pump()
      expect(room.state.bindings['profile:alpha']?.blocked).toBe(false)
      expect(room.state.messages.some(m => m.text === 'Late stopped reply')).toBe(false)
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
      expect(await f.runner.stop(f.conversation.id)).toBe(false)
      expect(f.calls.filter(c => c.method === 'session.interrupt')).toHaveLength(2)
    } finally { f.runner.dispose() }
  })

  it('stops an unsent claim without quarantining its member session', async () => {
    const f = fixture()
    try {
      await f.runner.send(f.conversation, '@alpha first')
      await f.pump()
      f.runner.handleEvent({ type: 'message.complete', session_id: 'runtime:alpha', seq: 1, payload: { text: 'Done' } })
      await f.pump()
      await f.runner.recoverAll(true)
      const request = f.io.request
      let releaseResume = () => {}
      f.io.request = async <T,>(method: string, params: Record<string, unknown>) => {
        if (method === 'session.resume') await new Promise<void>(resolve => { releaseResume = resolve })
        return request<T>(method, params)
      }
      await f.runner.send(f.conversation, '@alpha second')
      await f.pump()
      const room = f.runner.get(f.conversation.id)
      expect(room.state.turns.at(-1)?.status).toBe('running')
      expect(room.state.turns.at(-1)?.submittedText).toBeUndefined()
      const stopping = f.runner.stop(f.conversation.id)
      releaseResume()
      await f.pump()
      expect(await stopping).toBe(true)
      expect(room.state.bindings['profile:alpha']?.blocked).toBeFalsy()
      expect(f.calls.filter(c => c.method === 'session.interrupt')).toEqual([])
      await f.runner.send(f.conversation, '@alpha third')
      await f.pump()
      // Dispatches at once, not after the 30s liveness reconciliation.
      expect(room.state.turns.at(-1)).toMatchObject({ status: 'running' })
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(2)
    } finally { f.runner.dispose() }
  })

  it('lets the Chief wrap after a running specialist is removed from the room', async () => {
    const f = fixture(true, true)
    try {
      await f.runner.send(f.conversation, 'Plan the release')
      await f.pump()
      f.runner.handleEvent({ type: 'message.complete', session_id: 'runtime:alpha', seq: 1, payload: { text: '@beta check the tests.' } })
      await f.pump()
      expect(f.calls.filter(c => c.method === 'prompt.submit').map(c => c.params.profile)).toEqual(['alpha', 'beta'])
      f.setMembers(['alpha'])
      await f.pump()
      const room = f.runner.get(f.conversation.id)
      expect(room.state.cancelledRoots).toEqual([])
      expect(room.state.turns.find(t => t.memberId === 'profile:beta')).toMatchObject({ status: 'cancelled', error: 'Room member removed' })
      expect(room.state.bindings['profile:beta']?.blocked).toBe(true)
      expect(f.calls.filter(c => c.method === 'session.interrupt').map(c => c.params.profile)).toEqual(['beta'])
      expect(room.state.turns.at(-1)).toMatchObject({ memberId: 'profile:alpha', kind: 'wrap', status: 'running' })
      expect(f.calls.filter(c => c.method === 'prompt.submit').map(c => c.params.profile)).toEqual(['alpha', 'beta', 'alpha'])
    } finally { f.runner.dispose() }
  })

  it('replaces a saved member session that Hermes no longer has (4007) in the same bind', async () => {
    const f = fixture()
    try {
      await f.runner.send(f.conversation, '@alpha first')
      await f.pump()
      f.runner.handleEvent({ type: 'message.complete', session_id: 'runtime:alpha', seq: 1, payload: { text: 'Done' } })
      await f.pump()
      await f.runner.recoverAll(true)
      const request = f.io.request
      f.io.request = async <T,>(method: string, params: Record<string, unknown>) => {
        if (method === 'session.resume') { f.calls.push({ method, params }); throw new ServeRpcError('session not found', 4007) }
        return request<T>(method, params)
      }
      const before = f.calls.length
      await f.runner.send(f.conversation, '@alpha second')
      await f.pump()
      const room = f.runner.get(f.conversation.id)
      expect(f.calls.slice(before).map(c => c.method)).toEqual(['session.resume', 'session.create', 'prompt.submit'])
      expect(room.state.turns.at(-1)).toMatchObject({ status: 'running' })
      expect(room.state.cursors['profile:alpha']).toBe(0)
      // The fresh session gets the room backlog it never saw.
      expect(String(f.calls.at(-1)!.params.text)).toContain('@alpha first')
    } finally { f.runner.dispose() }
  })

  it('settles a submitted turn as non-retryable when its session is gone (4007) on recovery', async () => {
    const f = fixture()
    try {
      await f.runner.send(f.conversation, '@alpha first')
      await f.pump()
      const request = f.io.request
      f.io.request = async <T,>(method: string, params: Record<string, unknown>) => {
        if (method === 'session.resume') { f.calls.push({ method, params }); throw new ServeRpcError('session not found', 4007) }
        return request<T>(method, params)
      }
      await f.runner.recoverAll(true)
      await f.pump()
      const room = f.runner.get(f.conversation.id)
      expect(room.state.turns[0]).toMatchObject({ status: 'error', retryable: false })
      expect(room.state.bindings['profile:alpha']).toBeUndefined()
      expect(f.calls.filter(c => c.method === 'session.resume')).toHaveLength(1)
      expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(1)
      await f.runner.send(f.conversation, '@alpha second')
      await f.pump()
      expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(2)
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(2)
    } finally { f.runner.dispose() }
  })

  it('journals session.usage only when it pauses the request budget', async () => {
    const f = fixture()
    try {
      await f.runner.setTokenBudget(f.conversation.id, 100)
      await f.runner.send(f.conversation, '@alpha task')
      await f.pump()
      const checkpoint = vi.spyOn(f.repository, 'checkpoint')
      const usage = (seq: number, total: number) => f.runner.handleEvent({
        type: 'session.usage', session_id: 'runtime:alpha', seq, payload: { usage: { input: total / 2, output: total / 2, total } },
      })
      usage(1, 10); usage(2, 40)
      expect(checkpoint).not.toHaveBeenCalled()
      expect(f.runner.get(f.conversation.id).state.turns[0]?.usage?.total).toBe(40)
      usage(3, 120)
      expect(checkpoint).toHaveBeenCalledTimes(1)
      usage(4, 140)
      expect(checkpoint).toHaveBeenCalledTimes(1)
    } finally { f.runner.dispose() }
  })
})

describe('reentrant room dispatch through real store and native persistence', () => {
  it('does not tombstone a replacement owner when a disposed session resume succeeds late', async () => {
    const f = await nativeRepositoryFixture(false, false)
    let replacement: LocalRoomRunner | undefined
    const { createRoomRepository } = await import('./local-room-repository')
    const { isDeletedConversation } = await import('./tombstones')
    const request = f.io.request
    let resolve!: (value: unknown) => void
    let held = false
    f.io.request = async <T>(method: string, params: Record<string, unknown>) => {
      const value = await request<T>(method, params)
      if (method === 'session.resume' && !held) {
        held = true
        return await new Promise<unknown>(yes => { resolve = yes }) as T
      }
      return value
    }
    f.runner.setEpoch('old')
    try {
      await f.runner.send(f.conversation, '@alpha replacement binding fixture')
      await f.drain()
      f.runner.setEpoch('new')
      const pending = f.runner.recover(f.conversation.id, true)
      await f.drain()
      expect(held).toBe(true)
      f.runner.dispose()
      replacement = new LocalRoomRunner(f.io, createRoomRepository(), {
        now: () => 12345, defer: callback => queueMicrotask(callback), every: () => () => {},
      })
      replacement.setEpoch('new')
      await replacement.recover(f.conversation.id, true)
      replacement.handleEvent({
        type: 'tool.complete', session_id: 'native-runtime-alpha', seq: 1, payload: {
          name: 'render_ui', tool_id: 'replacement-data', result: {
            genuiOccurrence: '11111111-1111-4111-8111-111111111111',
            genui: { version: 1, components: [{ type: 'stat', title: 'Recovered', value: '1' }] },
          },
        },
      })
      replacement.handleEvent({
        type: 'message.complete', session_id: 'native-runtime-alpha', seq: 2,
        payload: { text: 'Replacement binding owner reply' },
      })
      const before = f.native.read()
      expect(isDeletedConversation('native-stored-alpha')).toBe(false)
      resolve({ session_id: 'native-runtime-alpha', stored_session_id: 'native-stored-alpha', info: { profile_name: 'alpha' } })
      await pending
      await f.drain()
      expect(isDeletedConversation('native-stored-alpha')).toBe(false)
      expect(isDeletedConversation(f.conversation.id)).toBe(false)
      expect(f.native.read()).toEqual(before)
      const saved = JSON.parse(f.native.read().value!).conversations[0].localRoom
      expect(saved.turns[0].status).toBe('sent')
      expect(saved.messages.at(-1).toolEvents[0].genuiOccurrence).toBe('11111111-1111-4111-8111-111111111111')
      expect(f.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(1)
    } finally { replacement?.dispose(); f.cleanup() }
  })

  it.each(['accepted', 'refused', 'rejected'] as const)('coalesces membership interruption with nested and concurrent Stop until its %s acknowledgment settles', async outcome => {
    const f = await nativeRepositoryFixture(false, false)
    const { HermesServeTransport } = await import('./hermes-transport')
    const metadata = new HermesServeTransport()
    const held = holdInterrupts(f)
    let removed = false
    let stopped = false
    let notifications = 0
    let nested: Promise<boolean> | undefined
    let unsubscribe = () => {}
    try {
      await f.runner.send(f.conversation, '@alpha synthetic nested Stop', { echoId: 'native-interrupt-root' })
      await f.drain()
      const room = f.runner.get(f.conversation.id)
      const turnId = room.state.turns[0]!.id
      unsubscribe = f.store.subscribe(() => {
        notifications++
        const turn = f.store.getState().conversations[0]?.localRoom?.turns[0]
        if (!removed && turn?.partialText) {
          removed = true
          void metadata.setGroupMembers('native-reentrant-group', [])
        } else if (removed && !stopped && turn?.status === 'cancelled') {
          stopped = true
          nested = f.runner.stop(f.conversation.id)
        }
      })
      f.runner.handleEvent({
        type: 'message.delta', session_id: 'native-runtime-alpha', seq: 1,
        payload: { text: 'Synthetic interrupted partial' },
      })
      await f.drain()
      const chainInterrupts = f.calls.filter(c => c.method === 'session.interrupt').length
      const concurrent = f.runner.stop(f.conversation.id)
      let settled = false
      void concurrent.then(() => { settled = true })
      await f.drain()
      const settledBeforeAcknowledgment = settled
      const ownersWhilePending = f.internals.interruptInflight?.size ?? 0
      console.info('Native nested Stop pending evidence', JSON.stringify({
        outcome, chainInterrupts, methods: f.calls.map(c => c.method), notifications,
        settled, ownersWhilePending, status: room.state.turns[0]?.status,
      }))
      held.settle(outcome)
      const answers = await Promise.all([nested, concurrent])
      await f.drain()
      expect(chainInterrupts).toBe(1)
      expect(f.calls.filter(c => c.method === 'session.interrupt')).toHaveLength(1)
      expect(removed && stopped).toBe(true)
      expect(settledBeforeAcknowledgment).toBe(false)
      expect(settled).toBe(true)
      expect(ownersWhilePending).toBe(1)
      expect(answers).toEqual([outcome === 'accepted', outcome === 'accepted'])
      expect(f.internals.interruptInflight.size).toBe(0)
      expect(notifications).toBeLessThan(20)
      expect(room.state.turns).toHaveLength(1)
      expect(room.state.turns[0]).toMatchObject({ id: turnId, rootId: 'native-interrupt-root', status: 'cancelled' })
      expect(room.state.turns[0]?.attempts).toBeUndefined()
      expect(room.state.messages.filter(m => m.speakerKind === 'human')).toHaveLength(1)
      expect(room.state.bindings['profile:alpha']).toMatchObject({ blocked: true, storedId: 'native-stored-alpha' })
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
      expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(1)
      if (outcome !== 'accepted') {
        const retry = f.runner.stop(f.conversation.id)
        await f.drain()
        expect(f.calls.filter(c => c.method === 'session.interrupt')).toHaveLength(2)
        held.settle('accepted')
        expect(await retry).toBe(true)
        expect(f.internals.interruptInflight.size).toBe(0)
      }
      expect(room.state.bindings['profile:alpha']?.blocked).toBe(true)
      f.runner.handleEvent({
        type: 'message.complete', session_id: 'native-runtime-alpha', seq: 2,
        payload: { text: 'Interrupted late result' },
      })
      await f.drain()
      expect(room.state.bindings['profile:alpha']?.blocked).toBe(false)
      expect(room.state.turns[0]?.status).toBe('cancelled')
      expect(room.state.messages.some(m => m.text === 'Interrupted late result')).toBe(false)
      expect(await f.runner.stop(f.conversation.id)).toBe(false)
    } finally { unsubscribe(); held.settle('refused'); f.cleanup() }
  })

  it.each(['disposed', 'epoch replaced'] as const)(
    'does not issue a Stop interrupt after request cleanup synchronously makes its owner %s',
    async change => {
      const f = await nativeRepositoryFixture(false, false)
      try {
        f.runner.setEpoch('stop-original-epoch')
        await f.runner.send(f.conversation, '@alpha original Stop owner')
        await f.drain()
        let changed = false
        vi.mocked(f.io.clearSessionRequests).mockImplementation(() => {
          if (changed) return
          changed = true
          if (change === 'disposed') f.runner.dispose()
          else f.runner.setEpoch('stop-replacement-epoch')
        })
        const stopped = await f.runner.stop(f.conversation.id)
        await f.drain()
        expect(changed).toBe(true)
        expect(f.calls.filter(c => c.method === 'session.interrupt')).toEqual([])
        expect(stopped).toBe(false)
        expect(f.internals.interruptInflight.size).toBe(0)
      } finally { f.cleanup() }
    },
  )

  it.each(['disposed', 'epoch replaced'] as const)(
    'does not quarantine later member requests after earlier cleanup makes its owner %s',
    async change => {
      const f = fixture()
      try {
        f.runner.setEpoch('quarantine-original')
        await f.runner.send(f.conversation, '@alpha first active request')
        await f.runner.send(f.conversation, '@beta second active request')
        for (let i = 0; i < 3; i++) await f.pump()
        const room = f.runner.get(f.conversation.id)
        expect(room.state.turns.filter(t => t.status === 'running')).toHaveLength(2)
        let changed = false, clearsAfterReentry = 0, betaAfterReentry: unknown
        vi.mocked(f.io.clearSessionRequests).mockImplementation(() => {
          if (changed) return
          changed = true
          if (change === 'disposed') f.runner.dispose()
          else f.runner.setEpoch('quarantine-replacement')
          clearsAfterReentry = vi.mocked(f.io.clearSessionRequests).mock.calls.length
          betaAfterReentry = structuredClone(room.state.bindings['profile:beta'])
        })
        expect(await f.runner.stop(f.conversation.id)).toBe(false)
        expect(changed).toBe(true)
        expect(f.io.clearSessionRequests).toHaveBeenCalledTimes(clearsAfterReentry)
        expect(room.state.bindings['profile:beta']).toEqual(betaAfterReentry)
        expect(f.calls.filter(c => c.method === 'session.interrupt')).toEqual([])
      } finally { f.runner.dispose() }
    },
  )

  it.each(['accepted', 'refused', 'rejected'] as const)(
    'does not accept or publish an old epoch interruption %s over replacement-owned GenUI and durable results',
    async outcome => {
      const f = await nativeRepositoryFixture(false, false)
      const held = holdInterrupts(f)
      try {
        f.runner.setEpoch('interrupt-original-epoch')
        await f.runner.send(f.conversation, '@alpha interrupted original owner')
        await f.drain()
        const pending = f.runner.stop(f.conversation.id)
        await f.drain()
        expect(f.internals.interruptInflight.size).toBe(1)
        f.runner.setEpoch('interrupt-replacement-epoch')
        f.runner.handleEvent({ type: 'message.complete', session_id: 'native-runtime-alpha', seq: 1,
          payload: { text: 'Old cancelled execution settled' } })
        await f.runner.send(f.conversation, '@alpha replacement-owned result')
        await f.drain()
        f.runner.handleEvent({ type: 'tool.complete', session_id: 'native-runtime-alpha', seq: 2, payload: {
          name: 'render_ui', tool_id: 'interrupt-replacement-widget', result: {
            genuiOccurrence: '44444444-4444-4444-8444-444444444444',
            genui: { version: 1, components: [{ type: 'stat', title: 'Replacement result', value: '1' }] },
          },
        } })
        f.runner.handleEvent({ type: 'message.complete', session_id: 'native-runtime-alpha', seq: 3,
          payload: { text: 'Replacement result accepted' } })
        const current = f.store.getState().conversations[0]!.localRoom!
        expect(current.messages.at(-1)?.toolEvents?.[0]?.genui).toBeDefined()
        expect(current.turns.at(-1)?.status).toBe('sent')
        expect(f.persist.isRoomJournalPersisted(f.conversation.id, current)).toBe(true)
        const before = structuredClone(current), durable = f.native.read().value
        f.native.save.mockClear()
        vi.mocked(f.io.emit).mockClear()
        held.settle(outcome)
        const stopped = await pending
        await f.drain()
        expect(f.store.getState().conversations[0]!.localRoom).toEqual(before)
        expect(f.io.emit).not.toHaveBeenCalled()
        f.persist.persistPendingNow()
        expect(f.persist.isRoomJournalPersisted(f.conversation.id, f.store.getState().conversations[0]!.localRoom!)).toBe(true)
        expect(f.native.read().value).toBe(durable)
        expect(f.native.save).not.toHaveBeenCalled()
        expect(stopped).toBe(false)
        expect(f.internals.interruptInflight.size).toBe(0)
        expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(2)
      } finally { held.settle('refused'); f.cleanup() }
    },
  )

  it.each(['member removal', 'room deletion'] as const)(
    'does not carry a retired %s cleanup interrupt into the replacement epoch',
    async removal => {
      const f = await nativeRepositoryFixture(false, false)
      try {
        f.runner.setEpoch('removal-original')
        await f.runner.send(f.conversation, '@alpha pending removed owner')
        await f.drain()
        let replaced = false
        vi.mocked(f.io.clearSessionRequests).mockImplementation(() => {
          if (replaced) return
          replaced = true
          f.runner.setEpoch('removal-replacement')
        })
        if (removal === 'room deletion') f.store.deleteConversation(f.conversation.id)
        else f.store.setState({ groups: f.store.getState().groups.map(group => ({
          ...group, memberAgentIds: [],
        })) })
        await f.drain()
        expect(replaced).toBe(true)
        expect(f.calls.filter(c => c.method === 'session.interrupt')).toEqual([])
        expect(f.internals.interruptInflight.size).toBe(0)
      } finally { f.cleanup() }
    },
  )

  it('reserves interruption ownership before synchronous I/O can reenter Stop', async () => {
    const f = await nativeRepositoryFixture(false, false)
    let reentered = false
    let nested: Promise<boolean> | undefined
    const held = holdInterrupts(f, () => {
      if (reentered) return
      reentered = true
      nested = f.runner.stop(f.conversation.id)
    })
    try {
      await f.runner.send(f.conversation, '@alpha synthetic interrupt ownership')
      await f.drain()
      const original = f.runner.stop(f.conversation.id)
      await f.drain()
      console.info('Native synchronous interrupt ownership evidence', JSON.stringify({
        methods: f.calls.map(c => c.method), owners: f.internals.interruptInflight?.size ?? 0,
      }))
      held.settle('refused')
      const answers = await Promise.all([original, nested])
      expect(f.calls.filter(c => c.method === 'session.interrupt')).toHaveLength(1)
      expect(answers).toEqual([false, false])
      expect(f.internals.interruptInflight.size).toBe(0)
      expect(f.runner.get(f.conversation.id).state.bindings['profile:alpha']?.blocked).toBe(true)
    } finally { held.settle('refused'); f.cleanup() }
  })

  it('releases interruption ownership after disposal without publishing a stale refused acknowledgment', async () => {
    const f = await nativeRepositoryFixture(false, false)
    const held = holdInterrupts(f)
    try {
      await f.runner.send(f.conversation, '@alpha synthetic disposed interruption')
      await f.drain()
      const pending = f.runner.stop(f.conversation.id)
      await f.drain()
      const before = structuredClone(f.store.getState().conversations[0]!.localRoom)
      f.runner.dispose()
      vi.mocked(f.io.emit).mockClear()
      vi.mocked(f.io.clearSessionRequests).mockClear()
      const calls = f.calls.length
      held.settle('rejected')
      expect(await pending).toBe(false)
      await f.drain()
      expect(f.calls.slice(calls)).toEqual([])
      expect(f.io.emit).not.toHaveBeenCalled()
      expect(f.io.clearSessionRequests).not.toHaveBeenCalled()
      expect(f.store.getState().conversations[0]?.localRoom).toEqual(before)
      expect(f.internals.interruptInflight?.size ?? 0).toBe(0)
    } finally { held.settle('refused'); f.cleanup() }
  })

  it('does not share an older interrupted execution acknowledgment with new work on the same session', async () => {
    const f = await nativeRepositoryFixture(false, false)
    const held = holdInterrupts(f)
    try {
      await f.runner.send(f.conversation, '@alpha old interrupt owner', { echoId: 'old-interrupt-owner' })
      await f.drain()
      const original = f.runner.stop(f.conversation.id)
      await f.drain()
      f.runner.handleEvent({
        type: 'message.complete', session_id: 'native-runtime-alpha', seq: 1,
        payload: { text: 'Old stopped completion' },
      })
      await f.runner.send(f.conversation, '@alpha new interrupt owner', { echoId: 'new-interrupt-owner' })
      await f.drain()
      const current = f.runner.stop(f.conversation.id)
      await f.drain()
      const requests = f.calls.filter(c => c.method === 'session.interrupt').length
      const owners = f.internals.interruptInflight.size
      console.info('Native distinct interruption owner evidence', JSON.stringify({
        requests, owners, methods: f.calls.map(c => c.method),
      }))
      held.settle('accepted')
      expect(await Promise.all([original, current])).toEqual([true, true])
      expect(requests).toBe(2)
      expect(owners).toBe(2)
      expect(f.internals.interruptInflight.size).toBe(0)
      const room = f.runner.get(f.conversation.id)
      expect(room.state.turns.map(t => ({ rootId: t.rootId, status: t.status }))).toEqual([
        { rootId: 'old-interrupt-owner', status: 'cancelled' },
        { rootId: 'new-interrupt-owner', status: 'cancelled' },
      ])
      expect(room.state.bindings['profile:alpha']?.blocked).toBe(true)
      expect(room.state.messages.filter(m => m.speakerKind === 'human')).toHaveLength(2)
      expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(1)
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(2)
    } finally { held.settle('refused'); f.cleanup() }
  })

  it.each(['claim', 'binding', 'partial'] as const)('reconciles public membership removal during %s publication before further dispatch or stale output', async timing => {
    const f = await nativeRepositoryFixture(false, false)
    const { HermesServeTransport } = await import('./hermes-transport')
    const metadata = new HermesServeTransport()
    const room = f.runner.get(f.conversation.id)
    let changed = false
    let change: Promise<unknown> | undefined
    let turnId: string | undefined
    const unsubscribe = f.store.subscribe(() => {
      const journal = f.store.getState().conversations[0]?.localRoom
      const turn = journal?.turns[0]
      if (changed || turn?.status !== 'running' ||
        (timing === 'binding' && !journal?.bindings['profile:alpha']) ||
        (timing === 'partial' && !turn.partialText)) return
      changed = true
      turnId = turn.id
      change = metadata.setGroupMembers('native-reentrant-group', [])
    })
    try {
      await f.runner.send(f.conversation, '@alpha synthetic membership fixture', { echoId: 'native-member-root' })
      await f.drain()
      if (timing === 'partial') {
        vi.mocked(f.io.emit).mockClear()
        f.runner.handleEvent({
          type: 'message.delta', session_id: 'native-runtime-alpha', seq: 1,
          payload: { text: 'Synthetic removed-member partial' },
        })
        await f.drain()
      }
      await change
      console.info('Native publication membership evidence', JSON.stringify({
        timing, methods: f.calls.map(c => c.method),
        roster: f.store.getState().groups[0]?.memberAgentIds, engineMembers: room.members.map(m => m.id),
        status: room.state.turns[0]?.status,
      }))
      expect(changed).toBe(true)
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(timing === 'partial' ? 1 : 0)
      expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(timing === 'claim' ? 0 : 1)
      expect(f.calls.filter(c => c.method === 'session.resume')).toEqual([])
      expect(room.members).toEqual([])
      expect(f.store.getState().groups[0]?.memberAgentIds).toEqual([])
      expect(room.state.turns).toHaveLength(1)
      expect(room.state.turns[0]).toMatchObject({ id: turnId, rootId: 'native-member-root', status: 'cancelled', error: 'Room member removed' })
      expect(room.state.turns[0]?.attempts).toBeUndefined()
      expect(room.state.cancelledRoots).not.toContain('native-member-root')
      expect(room.state.messages.filter(m => m.speakerKind === 'human')).toHaveLength(1)
      expect(f.persist.isRoomJournalPersisted(f.conversation.id, room.state)).toBe(true)
      expect(f.native.save.mock.results.every(r => r.value?.ok === true)).toBe(true)
      // Only a submitted prompt needs quarantine; an unsent claim is just dropped.
      if (timing === 'partial') {
        expect(room.state.bindings['profile:alpha']).toMatchObject({ blocked: true, storedId: 'native-stored-alpha' })
        expect(f.io.clearSessionRequests).toHaveBeenCalledTimes(1)
      } else if (timing === 'binding') {
        expect(room.state.bindings['profile:alpha']).toMatchObject({ storedId: 'native-stored-alpha' })
        expect(room.state.bindings['profile:alpha']?.blocked).toBeFalsy()
      }
      expect(f.calls.filter(c => c.method === 'session.interrupt')).toHaveLength(timing === 'partial' ? 1 : 0)
      expect(vi.mocked(f.io.emit).mock.calls.some(([event]) =>
        event.type === 'message' && event.message.content === 'Synthetic removed-member partial')).toBe(false)
      const before = f.calls.length
      f.tick()
      await f.drain()
      expect(f.calls.slice(before).some(c => ['session.create', 'session.resume', 'prompt.submit', 'session.interrupt'].includes(c.method))).toBe(false)
      expect(f.runner.sessionAcceptsRequests('native-runtime-alpha')).toBe(false)
      f.runner.handleEvent({
        type: 'message.complete', session_id: 'native-runtime-alpha', seq: 2,
        payload: { text: 'Removed member late result' },
      })
      await f.drain()
      expect(room.state.turns[0]?.status).toBe('cancelled')
      expect(room.state.messages.some(m => m.text === 'Removed member late result')).toBe(false)
      expect(f.internals.starting.size).toBe(0)
      expect(f.internals.bindingInflight.size).toBe(0)
    } finally { unsubscribe(); f.cleanup() }
  })

  it.each(['claim', 'binding', 'completion'] as const)('reconciles public room deletion during %s publication without resurrecting or emitting deleted output', async timing => {
    const f = await nativeRepositoryFixture(false, false)
    const room = f.runner.get(f.conversation.id)
    let deleted = false
    const unsubscribe = f.store.subscribe(() => {
      const journal = f.store.getState().conversations[0]?.localRoom
      const turn = journal?.turns[0]
      if (deleted || !turn ||
        (timing !== 'completion' && turn.status !== 'running') ||
        (timing === 'binding' && !journal?.bindings['profile:alpha']) ||
        (timing === 'completion' && turn.status !== 'sent')) return
      deleted = true
      f.store.deleteConversation(f.conversation.id)
    })
    try {
      await f.runner.send(f.conversation, '@alpha synthetic deletion fixture', { echoId: 'native-deleted-root' })
      await f.drain()
      if (timing === 'completion') {
        vi.mocked(f.io.emit).mockClear()
        f.runner.handleEvent({
          type: 'message.complete', session_id: 'native-runtime-alpha', seq: 1,
          payload: { text: 'Synthetic deleted-room result' },
        })
        await f.drain()
      }
      console.info('Native publication deletion evidence', JSON.stringify({
        timing, methods: f.calls.map(c => c.method), status: room.state.turns[0]?.status,
        conversations: f.store.getState().conversations.length,
        emitsDeletedResult: vi.mocked(f.io.emit).mock.calls.some(([event]) =>
          event.type === 'message' && event.message.content === 'Synthetic deleted-room result'),
      }))
      expect(deleted).toBe(true)
      expect(room.state.turns[0]?.status).toBe(timing === 'completion' ? 'sent' : 'cancelled')
      expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(timing === 'claim' ? 0 : 1)
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(timing === 'completion' ? 1 : 0)
      expect(f.calls.filter(c => c.method === 'session.interrupt')).toHaveLength(timing === 'binding' ? 1 : 0)
      expect(f.store.getState().conversations).toEqual([])
      expect(JSON.parse(f.native.read().value!).conversations).toEqual([])
      expect(vi.mocked(f.io.emit).mock.calls.some(([event]) =>
        event.type === 'message' && event.message.content === 'Synthetic deleted-room result')).toBe(false)
      if (timing !== 'claim') {
        // Completion clears its requests before publication; deletion then retires the session.
        expect(f.io.clearSessionRequests).toHaveBeenCalledTimes(timing === 'completion' ? 2 : 1)
        expect(f.runner.handleEvent({
          type: 'message.complete', session_id: 'native-runtime-alpha', seq: 2, payload: { text: 'Deleted late result' },
        })).toBe(true)
      }
      const before = f.calls.length
      f.tick()
      await f.drain()
      expect(f.calls.slice(before)).toEqual([])
      expect(room.state.messages.filter(m => m.speakerKind === 'human')).toHaveLength(1)
      expect(room.state.turns).toHaveLength(1)
      expect(room.state.turns[0]?.rootId).toBe('native-deleted-root')
      expect(room.state.turns[0]?.attempts).toBeUndefined()
    } finally { unsubscribe(); f.cleanup() }
  })

  it('drains deletion triggered by the nested membership-cancellation publication without duplicate interruption', async () => {
    const f = await nativeRepositoryFixture(false, false)
    const { HermesServeTransport } = await import('./hermes-transport')
    const metadata = new HermesServeTransport()
    const room = f.runner.get(f.conversation.id)
    let removed = false
    let deleted = false
    let notifications = 0
    const unsubscribe = f.store.subscribe(() => {
      notifications++
      const journal = f.store.getState().conversations[0]?.localRoom
      if (!removed && journal?.bindings['profile:alpha']) {
        removed = true
        void metadata.setGroupMembers('native-reentrant-group', [])
      } else if (removed && !deleted && journal?.turns[0]?.status === 'cancelled') {
        deleted = true
        f.store.deleteConversation(f.conversation.id)
      }
    })
    try {
      await f.runner.send(f.conversation, '@alpha synthetic nested removal', { echoId: 'native-nested-root' })
      await f.drain()
      console.info('Native nested membership-deletion evidence', JSON.stringify({
        removed, deleted, notifications, methods: f.calls.map(c => c.method), status: room.state.turns[0]?.status,
      }))
      expect(removed).toBe(true)
      expect(deleted).toBe(true)
      expect(notifications).toBeLessThan(20)
      expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(1)
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toEqual([])
      // The removed claim was never submitted, so neither removal nor deletion interrupts.
      expect(f.calls.filter(c => c.method === 'session.interrupt')).toHaveLength(0)
      expect(room.state.turns[0]).toMatchObject({ rootId: 'native-nested-root', status: 'cancelled' })
      expect(room.state.messages.filter(m => m.speakerKind === 'human')).toHaveLength(1)
      expect(f.store.getState().conversations).toEqual([])
      expect(JSON.parse(f.native.read().value!).conversations).toEqual([])
      expect(f.runner.handleEvent({
        type: 'message.complete', session_id: 'native-runtime-alpha', seq: 1, payload: { text: 'Nested deleted late result' },
      })).toBe(true)
      const before = f.calls.length
      f.tick()
      await f.drain()
      expect(f.calls.slice(before)).toEqual([])
    } finally { unsubscribe(); f.cleanup() }
  })

  it('does not let an obsolete dispatch cleanup release a reclaimed claim during a held resume', async () => {
    const f = await nativeRepositoryFixture(true)
    let recovered = false
    let recovery: Promise<void> | undefined
    const unsubscribe = f.store.subscribe(() => {
      const turn = f.store.getState().conversations[0]?.localRoom?.turns[0]
      if (recovered || !f.failedBindingWrite() || turn?.status !== 'queued') return
      recovered = true
      recovery = f.runner.recover(f.conversation.id, true)
    })
    try {
      await f.runner.send(f.conversation, '@alpha synthetic reclaim fixture', { echoId: 'native-reclaim-root' })
      await f.drain()
      const turn = f.runner.get(f.conversation.id).state.turns[0]!
      const beforeTimer = {
        methods: f.calls.map(c => c.method), status: turn.status,
        starting: f.internals.starting.size, bindingInflight: f.internals.bindingInflight.size,
      }
      f.tick()
      await f.drain()
      f.finishResume()
      await recovery
      await f.drain()
      const journal = f.runner.get(f.conversation.id).state
      const submitted = f.calls.filter(c => c.method === 'prompt.submit')
      console.info('Native reclaimed-dispatch evidence', JSON.stringify({
        beforeTimer, methods: f.calls.map(c => c.method), submissions: submitted.length,
        humans: journal.messages.filter(m => m.speakerKind === 'human').length, turns: journal.turns.length,
      }))
      expect(submitted).toHaveLength(1)
      expect(beforeTimer).toMatchObject({ status: 'running', starting: 1, bindingInflight: 1 })
      expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(1)
      expect(f.calls.filter(c => c.method === 'session.resume')).toHaveLength(1)
      expect(submitted[0]?.params).toMatchObject({ profile: 'alpha', session_id: 'native-runtime-alpha' })
      expect(journal.messages.filter(m => m.speakerKind === 'human')).toHaveLength(1)
      expect(journal.turns).toHaveLength(1)
      expect(journal.turns[0]).toMatchObject({ id: turn.id, rootId: 'native-reclaim-root', status: 'running' })
      expect(journal.turns[0]?.attempts).toBeUndefined()
      expect(journal.bindings['profile:alpha']?.storedId).toBe('native-stored-alpha')
      expect(f.native.save.mock.results.filter(r => r.value?.ok === false)).toHaveLength(1)
      expect(f.internals.starting.size).toBe(0)
      expect(f.internals.bindingInflight.size).toBe(0)
    } finally { unsubscribe(); f.cleanup() }
  })

  it('retains an explicit recovery wake until a refused binding claim becomes queued', async () => {
    const f = await nativeRepositoryFixture()
    let scheduled = false
    let recovery: Promise<void> | undefined
    const unsubscribe = f.store.subscribe(() => {
      if (scheduled || !f.store.getState().conversations[0]?.localRoom?.bindings['profile:alpha']) return
      scheduled = true
      queueMicrotask(() => { recovery = f.runner.recover(f.conversation.id, true) })
    })
    try {
      await f.runner.send(f.conversation, '@alpha synthetic recovery wake', { echoId: 'native-wake-root' })
      await f.drain()
      await recovery
      await f.runner.recover(f.conversation.id)
      await f.drain()
      const journal = f.runner.get(f.conversation.id).state
      const submitted = f.calls.filter(c => c.method === 'prompt.submit')
      console.info('Native recovery-wake evidence', JSON.stringify({
        methods: f.calls.map(c => c.method), submissions: submitted.length, status: journal.turns[0]?.status,
        dispatchPaused: f.internals.dispatchPaused.size, recovered: f.internals.recovered.has(f.conversation.id),
        humans: journal.messages.filter(m => m.speakerKind === 'human').length, turns: journal.turns.length,
      }))
      expect(submitted).toHaveLength(1)
      expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(1)
      expect(f.calls.filter(c => c.method === 'session.resume')).toHaveLength(1)
      expect(journal.turns).toHaveLength(1)
      expect(journal.turns[0]).toMatchObject({ rootId: 'native-wake-root', status: 'running' })
      expect(journal.turns[0]?.attempts).toBeUndefined()
      expect(journal.messages.filter(m => m.speakerKind === 'human')).toHaveLength(1)
      expect(journal.bindings['profile:alpha']?.storedId).toBe('native-stored-alpha')
      expect(f.native.save.mock.results.filter(r => r.value?.ok === false)).toHaveLength(1)
      f.tick()
      await f.drain()
      expect(f.calls.filter(c => c.method === 'prompt.submit')).toHaveLength(1)
    } finally { unsubscribe(); f.cleanup() }
  })
})
