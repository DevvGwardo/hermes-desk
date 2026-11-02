import { createRequire } from 'node:module'
import { EventEmitter, once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
// ws is not installed separately; Playwright includes the same ws server.
const { wsServer: WebSocketServer } = require('playwright-core/lib/utilsBundle')
const { createServeClient, loopbackBaseUrl } = require('./serve-client.cjs')
const { createServeSocketBroker } = require('../serve-auth.cjs')
const { createSecurePrompt } = require('./workspace/secure-prompt.cjs')
const cleanups = []
afterEach(async () => {
  vi.useRealTimers()
  while (cleanups.length) await cleanups.pop()()
})

async function server() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(wss, 'listening')
  const received = []
  const peers = []
  wss.on('connection', (ws, req) => {
    peers.push({ ws, url: req.url })
    ws.on('message', (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        const frame = JSON.parse(line)
        received.push({ ws, frame })
        if (frame.id === 'renderer-replay') continue
        if (frame.id != null && frame.method) {
          const reply = frame.method === 'fail'
            ? { error: { code: 4006, message: 'session_id required' } }
            : { result: ['session.create', 'session.resume'].includes(frame.method)
              ? { session_id: 'fake-session', stored_session_id: 'fake-stored-session' }
              : frame.method === 'session.events.since'
                ? { events: [{ type: 'message.delta', session_id: 'fake-session', seq: 8, payload: { text: 'replayed' } }],
                  latest_seq: 8, truncated: false }
                : { accepted: true } }
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...reply }) + '\n')
        }
      }
    })
  })
  cleanups.push(async () => {
    for (const ws of wss.clients) ws.terminate()
    await new Promise((resolve) => wss.close(resolve))
  })
  return { wss, received, peers, baseUrl: `http://127.0.0.1:${wss.address().port}` }
}

async function clientFor(s, opts = {}) {
  const client = createServeClient(opts)
  cleanups.push(() => client.stop())
  client.setEndpoint(s.baseUrl, { token: 'obviously-fake-serve-token', source: 'env' })
  await vi.waitFor(() => expect(client.connected).toBe(true))
  return client
}

async function rendererClient(options = {}) {
  const client = createServeClient(options)
  cleanups.push(() => client.stop())
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
  let proxy
  const sent = []
  const send = vi.fn((_sender, { data }) => { sent.push(JSON.parse(data)); return { ok: true } })
  const broker = client.bindRendererBroker({
    open: async (value) => { proxy = value; return { ok: true } },
    send, close() {}, closeAllFor() {},
  })
  const id = 'renderer_lifecycle'
  await broker.open(sender, { id, path: '/api/ws' })
  proxy.send('maia:serveSocketEvent', { id, type: 'open' })
  const receive = (frame) => proxy.send('maia:serveSocketEvent',
    { id, type: 'message', data: JSON.stringify({ jsonrpc: '2.0', ...frame }) })
  const request = (requestId, method, params) => broker.send(sender, { id,
    data: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) })
  request('initial-resume', 'session.resume', { session_id: 'fake-stored', profile: 'scout' })
  receive({ id: 'initial-resume', result: { session_id: 'fake-runtime', stored_session_id: 'fake-stored' } })
  return { client, send, sent, receive, request, sender, broker, id }
}

describe('native tool approval boundary', () => {
  it('rejects bulk, standing and foreign-session decisions before forwarding', async () => {
    const { request, sent } = await rendererClient()
    const count = sent.length
    for (const params of [
      { session_id: 'fake-runtime', choice: 'once', all: true },
      { session_id: 'fake-runtime', choice: 'once', all: 'true' },
      { session_id: 'fake-runtime', choice: 'always' },
      { session_id: 'fake-runtime', choice: 'session' },
      { session_id: 'foreign', choice: 'once' },
      { session_id: 'fake-runtime', profile: 'other', choice: 'once' },
    ]) expect(await request('synthetic-decision', 'approval.respond', params)).toMatchObject({ ok: false })
    expect(sent).toHaveLength(count)
  })
  it.each([false, true])('requires native consent (%s) using main-fetched pending details', async approved => {
    const approveRendererAction = vi.fn(async () => approved)
    const { request, receive, sent, sender } = await rendererClient({ approveRendererAction })
    const pending = request('synthetic-decision', 'approval.respond', { session_id: 'fake-runtime', choice: 'once' })
    await vi.waitFor(() => expect(sent.some(frame => frame.method === 'approval.pending')).toBe(true))
    const query = sent.find(frame => frame.method === 'approval.pending')
    const snapshot = { approvals: [{ command: 'echo synthetic', request_id: 'synthetic-one' }] }
    receive({ id: query.id, result: snapshot })
    if (approved) {
      await vi.waitFor(() => expect(sent.filter(frame => frame.method === 'approval.pending')).toHaveLength(2))
      receive({ id: sent.filter(frame => frame.method === 'approval.pending')[1].id, result: snapshot })
    }
    expect(await pending).toMatchObject({ ok: approved })
    expect(approveRendererAction).toHaveBeenCalledWith(sender, expect.objectContaining({
      sessionId: 'fake-runtime', choice: 'once', detail: expect.stringContaining('echo synthetic'),
    }))
    expect(sent.some(frame => frame.method === 'approval.respond')).toBe(approved)
  })
  it('does not permit the raw JSON-RPC response path to skip native consent', async () => {
    const approveRendererAction = vi.fn(async () => false)
    const { broker, id, sender, receive, sent } = await rendererClient({ approveRendererAction })
    receive({ id: 'server-approval', method: 'approval', params: { session_id: 'fake-runtime', command: 'echo synthetic' } })
    expect(await broker.send(sender, { id, data: JSON.stringify({
      jsonrpc: '2.0', id: 'server-approval', result: { choice: 'once' },
    }) })).toMatchObject({ ok: false })
    expect(approveRendererAction).toHaveBeenCalledOnce()
    expect(sent.some(frame => frame.id === 'server-approval')).toBe(false)
  })
  it('revokes an approved response when its renderer goes away during confirmation', async () => {
    let answer
    const approveRendererAction = vi.fn(() => new Promise(resolve => { answer = resolve }))
    const { request, receive, sent, sender } = await rendererClient({ approveRendererAction })
    const pending = request('synthetic-decision', 'approval.respond', { session_id: 'fake-runtime', choice: 'once' })
    await vi.waitFor(() => expect(sent.some(frame => frame.method === 'approval.pending')).toBe(true))
    receive({ id: sent.find(frame => frame.method === 'approval.pending').id,
      result: { approvals: [{ request_id: 'synthetic-one', command: 'echo synthetic' }] } })
    await vi.waitFor(() => expect(approveRendererAction).toHaveBeenCalledOnce())
    sender.emit('destroyed')
    answer(true)
    expect(await pending).toMatchObject({ ok: false })
    expect(sent.some(frame => frame.method === 'approval.respond')).toBe(false)
  })
  it('binds legacy approval to one unchanged request rather than approving the next command', async () => {
    const { request, receive, sent } = await rendererClient({ approveRendererAction: async () => true })
    const pending = request('synthetic-decision', 'approval.respond', { session_id: 'fake-runtime', choice: 'once' })
    await vi.waitFor(() => expect(sent.some(frame => frame.method === 'approval.pending')).toBe(true))
    receive({ id: sent.find(frame => frame.method === 'approval.pending').id,
      result: { approvals: [{ request_id: 'synthetic-one', command: 'echo synthetic' }] } })
    await vi.waitFor(() => expect(sent.filter(frame => frame.method === 'approval.pending')).toHaveLength(2))
    receive({ id: sent.filter(frame => frame.method === 'approval.pending')[1].id,
      result: { approvals: [{ request_id: 'synthetic-two', command: 'different synthetic command' }] } })
    expect(await pending).toMatchObject({ ok: false, error: 'pending approval changed' })
    expect(sent.some(frame => frame.method === 'approval.respond')).toBe(false)
  })
  it('invalidates a direct server approval while the native dialog is pending', async () => {
    let answer
    const approveRendererAction = vi.fn(() => new Promise(resolve => { answer = resolve }))
    const { broker, id, sender, receive, sent } = await rendererClient({ approveRendererAction })
    receive({ id: 'server-approval', method: 'approval', params: { session_id: 'fake-runtime', command: 'echo synthetic' } })
    const pending = broker.send(sender, { id, data: JSON.stringify({
      jsonrpc: '2.0', id: 'server-approval', result: { choice: 'once' },
    }) })
    await vi.waitFor(() => expect(approveRendererAction).toHaveBeenCalledOnce())
    receive({ method: 'event', params: { type: 'request.cancel', payload: { id: 'server-approval' } } })
    answer(true)
    expect(await pending).toMatchObject({ ok: false })
    expect(sent.some(frame => frame.id === 'server-approval')).toBe(false)
  })
})

describe('main-process serve JSON-RPC', () => {
  it.each(['subagent.list', 'subagent.tail', 'subagent.interrupt', 'subagent.steer'])(
    'requires the original renderer and explicit profile session for %s', async method => {
      const { request } = await rendererClient()
      const params = { session_id: 'fake-runtime', profile: 'scout',
        ...(method !== 'subagent.list' ? { subagent_id: 'child-1' } : {}),
        ...(method === 'subagent.steer' ? { text: 'Local fixture steer' } : {}) }
      expect(request('valid', method, params).ok).toBe(true)
      expect(request('foreign', method, { ...params, session_id: 'foreign' }).ok).toBe(false)
      expect(request('profile', method, { ...params, profile: 'other' }).ok).toBe(false)
      expect(request('unscoped', method, { ...params, session_id: undefined }).ok).toBe(false)
      expect(request('path', method, { ...params, path: '/private/transcript' }).ok).toBe(false)
      expect(request('global', 'delegation.status', {}).ok).toBe(false)
    })
  it('bounds delegation metadata/tails and never forwards internal ownership or runtime data', async () => {
    const { request, receive, sender } = await rendererClient()
    const params = { session_id: 'fake-runtime', profile: 'scout' }
    request('roster', 'subagent.list', params)
    receive({ id: 'roster', result: { subagents: [{ subagent_id: 'child-1', goal: 'Fixture goal',
      status: 'running', owner_session_id: 'FAKE_PRIVATE', agent: { config: 'FAKE_PRIVATE' },
      transcript_path: 'FAKE_PRIVATE' }], delegations: [], callbacks: 'FAKE_PRIVATE' } })
    const data = sender.send.mock.calls.at(-1)[1].data
    expect(data).toContain('Fixture goal')
    expect(data).not.toContain('FAKE_PRIVATE')
    request('tail', 'subagent.tail', { ...params, subagent_id: 'child-1' })
    receive({ id: 'tail', result: { available: true, text: 'x'.repeat(20000), truncated: true, path: 'FAKE_PRIVATE' } })
    const tail = JSON.parse(sender.send.mock.calls.at(-1)[1].data).result
    expect(tail.text.length).toBe(16384)
    expect(tail.path).toBeUndefined()
    expect(request('empty', 'subagent.interrupt', { ...params, subagent_id: '' }).ok).toBe(false)
    expect(request('long', 'subagent.steer', { ...params, subagent_id: 'child-1', text: 'x'.repeat(16385) }).ok).toBe(false)
  })
  it('forwards an over-4 MiB history reply the socket accepted instead of dropping it', async () => {
    const { request, receive, sender } = await rendererClient()
    request('history-large', 'session.history', { session_id: 'fake-runtime', profile: 'scout' })
    // The default profile's "Retry previous request" transcript measured
    // 4,284,253 bytes on the wire: a legitimate reply inside serve-auth's
    // 16 MiB inbound allowance. A 4 MiB dispatch bound would silently drop
    // it, hanging the renderer call until its timeout (stuck chat intro).
    const messages = Array.from({ length: 300 }, (_, index) => ({
      role: index % 2 === 0 ? 'assistant' : 'tool', content: 'x'.repeat(14_000),
    }))
    receive({ id: 'history-large', result: { messages } })
    const data = sender.send.mock.calls.at(-1)[1].data
    expect(data.length).toBeGreaterThan(4 * 1024 * 1024)
    const reply = JSON.parse(data)
    expect(reply.id).toBe('history-large')
    expect(reply.result.messages).toHaveLength(300)
  })
  it('limits native context inspection to an owned session/profile and forwards only scalar manifest metadata', async () => {
    const { request, receive, sender } = await rendererClient()
    expect(request('context-wrong-profile', 'session.context_breakdown', { session_id: 'fake-runtime', profile: 'other' }).ok).toBe(false)
    expect(request('context-foreign', 'session.context_breakdown', { session_id: 'foreign-runtime', profile: 'scout' }).ok).toBe(false)
    expect(request('context-no-profile', 'session.context_breakdown', { session_id: 'fake-runtime' }).ok).toBe(false)
    expect(request('context-no-session', 'session.context_breakdown', { profile: 'scout' }).ok).toBe(false)
    expect(request('context-extra', 'session.context_breakdown', { session_id: 'fake-runtime', profile: 'scout', path: '/private/file' }).ok).toBe(false)
    expect(request('context-valid', 'session.context_breakdown', { session_id: 'fake-runtime', profile: 'scout' }).ok).toBe(true)
    receive({ id: 'context-valid', result: {
      context_max: 32000, context_used: 800, context_estimated: true, context_source: 'local_estimate',
      categories: [{ id: 'rules', label: 'Instructions', tokens: 200, content: 'FAKE_PRIVATE_BODY' }],
      context_files: [{ label: 'SOUL.md', path: '/fixture/scout/SOUL.md', est_tokens: 50, loaded: true, status: 'loaded',
        content: 'FAKE_PRIVATE_BODY', config: { api_key: 'FAKE_PRIVATE_BODY' } }],
      effective_config: { key: 'FAKE_PRIVATE_BODY' }, env: { key: 'FAKE_PRIVATE_BODY' },
    } })
    const reply = sender.send.mock.calls.at(-1)[1].data
    expect(reply).toContain('/fixture/scout/SOUL.md')
    expect(reply).not.toContain('FAKE_PRIVATE_BODY')
  })
  it.each(['session.branch', 'session.branch_stored'])('binds the returned child from %s to its renderer without moving parent authority', async method => {
    const { client, request, receive } = await rendererClient()
    const params = method === 'session.branch'
      ? { profile: 'scout', session_id: 'fake-runtime', count: 2, idempotency_key: 'branch_receipt' }
      : { profile: 'scout', parent_session_id: 'fake-stored', source: 'desktop', idempotency_key: 'branch_receipt' }
    expect(request('branch-child', method, params).ok).toBe(true)
    receive({ id: 'branch-child', result: { session_id: 'child-runtime', stored_session_id: 'child-stored',
      info: { profile_name: 'scout' } } })
    receive({ method: 'event', params: { type: 'message.start', session_id: 'child-runtime' } })
    expect(client.getActiveTurns()).toContainEqual({ session_id: 'child-runtime', profile: 'scout' })
    receive({ method: 'event', params: { type: 'message.start', session_id: 'fake-runtime' } })
    expect(client.getActiveTurns()).toContainEqual({ session_id: 'fake-runtime', profile: 'scout' })
  })
  it('uses loopback /api/ws with main-held auth and matches calls and RPC errors', async () => {
    const s = await server()
    const client = await clientFor(s)
    expect(s.peers[0].url).toBe('/api/ws?token=obviously-fake-serve-token')
    await expect(client.call('profiles.list', {})).resolves.toEqual({ accepted: true })
    await expect(client.call('fail', {})).rejects.toMatchObject({ code: 4006, message: 'session_id required' })
    expect(s.received[0].frame).toMatchObject({ jsonrpc: '2.0', method: 'profiles.list' })
  })

  it('dispatches batched notifications, server requests and client notifications', async () => {
    const s = await server()
    const client = await clientFor(s)
    const event = vi.fn()
    const handler = vi.fn(async (params) => ({ choice: params.choice }))
    const unsub = client.onEvent(event)
    const off = client.onRequest('approval', handler)
    s.peers[0].ws.send([
      { jsonrpc: '2.0', method: 'event', params: { type: 'tool.start', session_id: 'fake-session', payload: {} } },
      { jsonrpc: '2.0', id: 'srq-1', method: 'approval', params: { choice: 'deny' } },
    ].map(JSON.stringify).join('\n') + '\n')
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith({ choice: 'deny' }))
    await vi.waitFor(() => expect(s.received.some((r) => r.frame.id === 'srq-1' && r.frame.result?.choice === 'deny')).toBe(true))
    expect(event).toHaveBeenCalledWith('tool.start', { type: 'tool.start', session_id: 'fake-session', payload: {} })
    client.notify('client.notice', { value: 1 })
    await vi.waitFor(() => expect(s.received.some((r) => r.frame.method === 'client.notice' && !r.frame.id)).toBe(true))
    unsub(); off()
  })

  it('reconnects after disconnect and rejects in-flight calls rather than replaying mutations', async () => {
    const s = await server()
    const client = await clientFor(s, { setTimer: (cb) => setTimeout(cb, 20) })
    const connection = vi.fn()
    client.onConnection(connection)
    s.peers[0].ws.close()
    await vi.waitFor(() => expect(s.peers.length).toBe(2))
    await vi.waitFor(() => expect(client.connected).toBe(true))
    expect(connection).toHaveBeenCalledWith(false)
    expect(connection).toHaveBeenCalledWith(true)
    await expect(client.call('profiles.list')).resolves.toEqual({ accepted: true })
  })

  it('routes controller calls on the renderer session socket and hides main responses', async () => {
    const s = await server()
    const client = await clientFor(s)
    const broker = client.bindRendererBroker(createServeSocketBroker({
      baseUrl: s.baseUrl, getToken: async () => ({ token: 'obviously-fake-serve-token' }),
    }))
    const sender = new EventEmitter()
    sender.isDestroyed = () => false
    sender.send = vi.fn()
    await broker.open(sender, { id: 'renderer_123', path: '/api/ws' })
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith('maia:serveSocketEvent',
      expect.objectContaining({ type: 'open' })))
    broker.send(sender, { id: 'renderer_123', data: JSON.stringify({
      jsonrpc: '2.0', id: 'renderer-call', method: 'session.create', params: { profile: 'fake-profile' },
    }) })
    await vi.waitFor(() => expect(sender.send.mock.calls.some(([, e]) => e.data?.includes('renderer-call'))).toBe(true))
    await client.call('browser.controller.register', { session_id: 'fake-session', controller_id: 'fake-controller' })
    const rendererWs = s.received.find((r) => r.frame.id === 'renderer-call').ws
    expect(s.received.find((r) => r.frame.method === 'browser.controller.register').ws).toBe(rendererWs)
    expect(sender.send.mock.calls.some(([, e]) => e.data?.includes('hd_main_'))).toBe(false)
    expect(() => client.assertRendererSession({ profile: 'fake-profile', storedId: 'fake-stored-session',
      runtimeId: 'fake-session' }, sender)).not.toThrow()
    expect(() => client.assertRendererSession({ profile: 'other-profile', storedId: 'fake-stored-session',
      runtimeId: 'fake-session' }, sender)).toThrow()
    expect(() => client.assertRendererSession({ profile: 'fake-profile', storedId: 'fake-session',
      runtimeId: 'fake-stored-session' }, sender)).toThrow()
    expect(() => client.assertRendererSession({ profile: 'fake-profile', storedId: 'fake-stored-session',
      runtimeId: 'fake-session' }, {})).toThrow()
    rendererWs.send(JSON.stringify({ jsonrpc: '2.0', method: 'event',
      params: { type: 'message.start', session_id: 'fake-session' } }))
    await vi.waitFor(() => expect(client.getActiveTurns()).toEqual([{ session_id: 'fake-session', profile: 'fake-profile' }]))
    await client.call('session.interrupt', client.getActiveTurns()[0])
    expect(s.received.find((r) => r.frame.method === 'session.interrupt').ws).toBe(rendererWs)
    rendererWs.send(JSON.stringify({ jsonrpc: '2.0', method: 'event',
      params: { type: 'message.complete', session_id: 'fake-session', payload: {} } }))
    await vi.waitFor(() => expect(client.getActiveTurns()).toEqual([]))
    await expect(client.call('browser.controller.result', { session_id: 'other-session' }))
      .rejects.toMatchObject({ code: 'disconnected' })
    sender.emit('destroyed')
    await vi.waitFor(() => expect(client.call('browser.controller.register', { session_id: 'fake-session' }))
      .rejects.toMatchObject({ code: 'disconnected' }))
  })

  it('delivers shared-session reply frames to every renderer while notifying main subscribers once', async () => {
    const client = createServeClient()
    cleanups.push(() => client.stop())
    const observed = vi.fn()
    client.onEvent(observed)
    const proxies = new Map()
    const broker = client.bindRendererBroker({
      open: async (proxy, { id }) => { proxies.set(id, proxy); return { ok: true } },
      send: () => ({ ok: true }), close() {}, closeAllFor() {},
    })
    const renderers = []
    for (const id of ['renderer_main', 'renderer_hud']) {
      const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
      await broker.open(sender, { id, path: '/api/ws' })
      const receive = (frame) => proxies.get(id).send('maia:serveSocketEvent',
        { id, type: 'message', data: JSON.stringify({ jsonrpc: '2.0', ...frame }) })
      proxies.get(id).send('maia:serveSocketEvent', { id, type: 'open' })
      expect(broker.send(sender, { id, data: JSON.stringify({ jsonrpc: '2.0', id: 'resume',
        method: 'session.resume', params: { session_id: 'fake-stored', profile: 'scout' } }) }).ok).toBe(true)
      receive({ id: 'resume', result: { session_id: 'fake-runtime', stored_session_id: 'fake-stored' } })
      renderers.push({ sender, receive })
    }
    const parts = [
      '**Palette (sample', '):**\n', '- teal and ', 'gold,',
      '\n\n| Toggle | State |\n| --- | --- |\n| Sparks ', '| off ', '|\n', '\n- ready',
    ]
    const events = [
      { type: 'message.start', payload: {} },
      ...parts.map(text => ({ type: 'message.delta', payload: { text } })),
      { type: 'message.complete', payload: { text: parts.join(''), status: 'complete' } },
    ].map((event, index) => ({ ...event, session_id: 'fake-runtime', seq: index + 1 }))
    for (const event of events) {
      // Fanout delivery order can differ per token. The HUD must not consume
      // a token (or the completion) on behalf of the main window.
      const first = event.seq % 2
      renderers[first].receive({ method: 'event', params: event })
      renderers[1 - first].receive({ method: 'event', params: event })
    }
    for (const { sender } of renderers) {
      const delivered = sender.send.mock.calls.flatMap(([, event]) =>
        (event.data || '').split('\n').filter(Boolean).map(JSON.parse))
        .filter(frame => frame.method === 'event').map(frame => frame.params)
      expect(delivered).toEqual(events)
      expect(delivered.filter(event => event.type === 'message.delta')
        .map(event => event.payload.text).join('')).toBe(parts.join(''))
    }
    expect(observed.mock.calls.map(([, event]) => event)).toEqual(events)
    expect(client.getActiveTurns()).toEqual([])
    expect(broker.send(renderers[0].sender, { id: 'renderer_main', data: JSON.stringify({
      jsonrpc: '2.0', id: 'follow-up', method: 'prompt.submit',
      params: { session_id: 'fake-runtime', profile: 'scout', text: 'A new synthetic turn' },
    }) }).ok).toBe(true)
    renderers[1].receive({ method: 'event', params: events.at(-1) })
    expect(client.getActiveTurns()).toEqual([{ session_id: 'fake-runtime', profile: 'scout' }])
    expect(observed.mock.calls.map(([, event]) => event)).toEqual(events)
  })

  it('answers real secret/sudo/vault request shapes natively on the originating socket, including replay', async () => {
    const s = await server()
    const client = await clientFor(s)
    const dialog = { showMessageBox: vi.fn(async () => ({ response: 2 })) }
    const prompt = createSecurePrompt({ dialog, getMainWindow: () => null,
      secureInput: vi.fn(async () => ({ ok: true, value: 'OBVIOUSLY_FAKE_CREDENTIAL' })) })
    client.setSecureRequestHandler((method, params, context) => prompt.requestServer(method, params, context))
    const broker = client.bindRendererBroker(createServeSocketBroker({
      baseUrl: s.baseUrl, getToken: async () => ({ token: 'obviously-fake-serve-token' }),
    }))
    const sender = new EventEmitter()
    sender.isDestroyed = () => false
    sender.send = vi.fn()
    await broker.open(sender, { id: 'renderer_secure', path: '/api/ws' })
    await vi.waitFor(() => expect(sender.send.mock.calls.some(([, e]) => e.type === 'open')).toBe(true))
    broker.send(sender, { id: 'renderer_secure', data: JSON.stringify({
      jsonrpc: '2.0', id: 'secure-create', method: 'session.create', params: { profile: 'fake-profile' },
    }) })
    await vi.waitFor(() => expect(s.received.some((r) => r.frame.id === 'secure-create')).toBe(true))
    const ws = s.received.find((r) => r.frame.id === 'secure-create').ws
    const questions = [
      { id: 'secure-secret', method: 'secret', params: { session_id: 'fake-session', env_var: 'FAKE_API_KEY', prompt: 'Fake setup' } },
      { id: 'secure-sudo', method: 'sudo', params: { session_id: 'fake-session', command: 'fake-command' } },
      { id: 'secure-vault', method: 'vault.unlock_prompt', params: { session_id: 'fake-session', backend: 'fake', display_name: 'Fake vault' } },
      { id: 'secure-code', method: 'vault.code', params: { session_id: 'fake-session', site: null, hint: null } },
      { id: 'secure-unknown', method: 'vault.future_method', params: { session_id: 'fake-session' } },
    ]
    ws.send(questions.map((request) => JSON.stringify({ jsonrpc: '2.0', ...request })).join('\n'))
    await vi.waitFor(() => expect(s.received.filter((r) => questions.some((q) => q.id === r.frame.id))).toHaveLength(5))
    for (const question of questions) {
      const response = s.received.find((r) => r.frame.id === question.id)
      expect(response.ws).toBe(ws)
      expect(response.frame.result).toEqual({ value: question.method === 'vault.future_method' ? '' : 'OBVIOUSLY_FAKE_CREDENTIAL' })
    }
    const replayQuestion = { id: 'secure-replay-question', method: 'secret',
      params: { session_id: 'fake-session', env_var: 'FAKE_REPLAY_KEY', prompt: 'Fake setup' } }
    const approval = { id: 'approval-replay', method: 'approval', params: { session_id: 'fake-session', choices: ['deny'] } }
    expect(broker.send(sender, { id: 'renderer_secure', data: JSON.stringify({ jsonrpc: '2.0', id: 'renderer-replay',
      method: 'session.events.since', params: { session_id: 'fake-session', last_seen: 0 } }) }).ok).toBe(true)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'renderer-replay',
      result: { open_requests: [replayQuestion, approval, questions[0]], events: [] } }))
    await vi.waitFor(() => expect(s.received.some((r) => r.frame.id === replayQuestion.id)).toBe(true))
    const frames = sender.send.mock.calls.flatMap(([, e]) => (e.data || '').split('\n').filter(Boolean).map(JSON.parse))
    expect(frames.find((frame) => frame.id === 'renderer-replay').result.open_requests).toEqual([approval])
    expect(frames.some((frame) => questions.some((q) => q.id === frame.id))).toBe(false)
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('OBVIOUSLY_FAKE_CREDENTIAL')
    expect(JSON.stringify(dialog.showMessageBox.mock.calls)).not.toContain('OBVIOUSLY_FAKE_CREDENTIAL')
    expect(s.received.filter((r) => r.frame.id === 'secure-secret')).toHaveLength(1)
  })

  it('cancels a main-only secret prompt when withdrawn and declines if no handler is installed', async () => {
    const client = createServeClient()
    cleanups.push(() => client.stop())
    const sender = new EventEmitter()
    sender.isDestroyed = () => false
    sender.send = vi.fn()
    const sent = []
    let proxy, release, signal
    const broker = client.bindRendererBroker({
      open: async (value) => { proxy = value; return { ok: true } },
      send: (_sender, payload) => { sent.push(JSON.parse(payload.data)); return { ok: true } },
      close() {}, closeAllFor() {},
    })
    await broker.open(sender, { id: 'renderer_cancel', path: '/api/ws' })
    proxy.send('maia:serveSocketEvent', { id: 'renderer_cancel', type: 'open' })
    const receive = (frame) => proxy.send('maia:serveSocketEvent',
      { id: 'renderer_cancel', type: 'message', data: JSON.stringify({ jsonrpc: '2.0', ...frame }) })
    receive({ id: 'secure-default-deny', method: 'vault.unknown', params: {} })
    await vi.waitFor(() => expect(sent).toContainEqual({ jsonrpc: '2.0', id: 'secure-default-deny', result: { value: '' } }))
    client.setSecureRequestHandler((_method, _params, context) => {
      signal = context.signal
      return new Promise((resolve) => { release = resolve })
    })
    receive({ id: 'secure-cancelled', method: 'secret', params: {} })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    receive({ method: 'event', params: { type: 'request.cancel', payload: { id: 'secure-cancelled' } } })
    expect(signal.aborted).toBe(true)
    release({ value: 'OBVIOUSLY_FAKE_CANCELLED_SECRET' })
    await Promise.resolve(); await Promise.resolve()
    expect(sent.some((frame) => frame.id === 'secure-cancelled')).toBe(false)
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('OBVIOUSLY_FAKE_CANCELLED_SECRET')
  })

  it('does not connect to hosted, credential-bearing or non-origin endpoints', () => {
    for (const url of ['https://example.invalid', 'http://localhost:9119', 'http://127.0.0.1:9119/path',
      'http://fake:password@127.0.0.1:9119', 'http://127.0.0.1:9119?token=fake']) {
      expect(() => loopbackBaseUrl(url)).toThrow()
    }
    expect(loopbackBaseUrl('http://127.0.0.1:9120')).toBe('http://127.0.0.1:9120')
  })

  it('restores main-owned sessions and replays missed events using the actual last_seen watermark', async () => {
    const s = await server()
    const client = await clientFor(s, { setTimer: (cb) => setTimeout(cb, 20) })
    const event = vi.fn()
    client.onEvent(event)
    await client.call('session.create', { profile: 'fake-profile' })
    s.peers[0].ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: {
      type: 'message.delta', session_id: 'fake-session', seq: 7, payload: { text: 'before disconnect' },
    } }))
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith('message.delta', expect.objectContaining({ seq: 7 })))
    s.peers[0].ws.close()
    await vi.waitFor(() => expect(s.received.some((r) => r.frame.method === 'session.events.since')).toBe(true))
    expect(s.received.find((r) => r.frame.method === 'session.resume').frame.params).toEqual({
      session_id: 'fake-stored-session', profile: 'fake-profile', omit_messages: true,
    })
    expect(s.received.find((r) => r.frame.method === 'session.events.since').frame.params).toEqual({
      session_id: 'fake-session', profile: 'fake-profile', last_seen: 7,
    })
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith('message.delta', expect.objectContaining({ seq: 8 })))
  })

  it('filters mixed broker frames so main request ids never reach the renderer', async () => {
    const client = createServeClient()
    const sender = new EventEmitter()
    sender.isDestroyed = () => false
    sender.send = vi.fn()
    let proxy
    const broker = client.bindRendererBroker({
      open: async (value) => { proxy = value; return { ok: true } },
      send: (_sender, { data }) => {
        const frame = JSON.parse(data)
        if (frame.method === 'browser.controller.register') {
          proxy.send('maia:serveSocketEvent', { id: 'renderer_mix', type: 'message', data:
            JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { accepted: true } }) + '\n' +
            JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'status.update', payload: {} } }) })
        }
        return { ok: true }
      },
      close: vi.fn(), closeAllFor: vi.fn(),
    })
    cleanups.push(() => client.stop())
    await broker.open(sender, { id: 'renderer_mix', path: '/api/ws' })
    proxy.send('maia:serveSocketEvent', { id: 'renderer_mix', type: 'open' })
    broker.send(sender, { id: 'renderer_mix', data: JSON.stringify({
      jsonrpc: '2.0', id: 'renderer-create', method: 'session.create', params: {},
    }) })
    proxy.send('maia:serveSocketEvent', { id: 'renderer_mix', type: 'message', data: JSON.stringify({
      jsonrpc: '2.0', id: 'renderer-create', result: { session_id: 'fake-session' },
    }) })
    await expect(client.call('browser.controller.register', { session_id: 'fake-session' }))
      .resolves.toEqual({ accepted: true })
    expect(sender.send.mock.calls.some(([, e]) => e.data?.includes('hd_main_'))).toBe(false)
    expect(sender.send.mock.calls.some(([, e]) => e.data?.includes('status.update'))).toBe(true)
  })

  it('backs off from 1s to 30s, rejects pending calls on disconnect, and cancels retries', async () => {
    vi.useFakeTimers()
    const peers = []
    class FakeSocket extends EventEmitter {
      constructor() { super(); this.readyState = 0; peers.push(this) }
      addEventListener(name, cb) { this.on(name, cb) }
      send() {}
      close() { this.readyState = 3; this.emit('close') }
    }
    const client = createServeClient({ WebSocketImpl: FakeSocket })
    cleanups.push(() => client.stop())
    client.setEndpoint('http://127.0.0.1:9128', { token: 'obviously-fake-token', source: 'env' })
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = peers.length
      peers.at(-1).close()
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(peers).toHaveLength(count)
      await vi.advanceTimersByTimeAsync(1)
      expect(peers).toHaveLength(count + 1)
    }
    peers.at(-1).readyState = 1
    peers.at(-1).emit('open')
    const pending = client.call('fake-mutation')
    const rejected = expect(pending).rejects.toMatchObject({ code: 'disconnected' })
    peers.at(-1).close()
    await rejected
    const count = peers.length
    client.stop()
    await vi.advanceTimersByTimeAsync(60000)
    expect(peers).toHaveLength(count)
  })

  it('tracks submitted/resumed turns without reviving completed turns from late replies or old replay events', async () => {
    const client = createServeClient()
    cleanups.push(() => client.stop())
    const sender = new EventEmitter()
    sender.isDestroyed = () => false
    sender.send = vi.fn()
    let proxy
    const broker = client.bindRendererBroker({
      open: async (value) => { proxy = value; return { ok: true } },
      send: () => ({ ok: true }), close() {}, closeAllFor() {},
    })
    await broker.open(sender, { id: 'renderer_turns', path: '/api/ws' })
    proxy.send('maia:serveSocketEvent', { id: 'renderer_turns', type: 'open' })
    const receive = (frame) => proxy.send('maia:serveSocketEvent',
      { id: 'renderer_turns', type: 'message', data: JSON.stringify({ jsonrpc: '2.0', ...frame }) })
    const call = (id, method, params) => broker.send(sender, { id: 'renderer_turns',
      data: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    call('resume', 'session.resume', { session_id: 'fake-stored', profile: 'scout' })
    receive({ method: 'event', params: { type: 'message.start', session_id: 'fake-runtime', seq: 1 } })
    receive({ id: 'resume', result: { session_id: 'fake-runtime', stored_session_id: 'fake-stored', running: true } })
    expect(client.getActiveTurns()).toEqual([{ session_id: 'fake-runtime', profile: 'scout' }])
    receive({ method: 'event', params: { type: 'message.complete', session_id: 'fake-runtime', seq: 2 } })
    expect(client.getActiveTurns()).toEqual([])
    receive({ method: 'event', params: { type: 'message.start', session_id: 'fake-runtime', seq: 1 } })
    expect(client.getActiveTurns()).toEqual([])
    call('submit', 'prompt.submit', { session_id: 'fake-runtime', profile: 'scout', text: 'Fake prompt' })
    expect(client.getActiveTurns()).toHaveLength(1)
    receive({ method: 'event', params: { type: 'message.complete', session_id: 'fake-runtime', seq: 3 } })
    receive({ id: 'submit', result: { status: 'streaming' } })
    expect(client.getActiveTurns()).toEqual([])
    call('failed', 'prompt.submit', { session_id: 'fake-runtime', profile: 'scout' })
    receive({ id: 'failed', error: { code: 1, message: 'fake rejection' } })
    expect(client.getActiveTurns()).toEqual([])
  })

  it.each(['main', 'renderer'])('does not revive a settled turn from a late %s resume or replace a newer submitted turn', async (owner) => {
    const { client, sent, receive, request } = await rendererClient()
    const params = { session_id: 'fake-runtime', profile: 'scout' }
    const resume = () => {
      const pending = owner === 'main' ? client.call('session.resume', params) : null
      if (owner === 'renderer') expect(request(`resume-${sent.length}`, 'session.resume', params).ok).toBe(true)
      return { pending, id: sent.at(-1).id }
    }
    const first = resume()
    receive({ method: 'event', params: { type: 'message.start', session_id: params.session_id, seq: 1 } })
    receive({ method: 'event', params: { type: 'message.complete', session_id: params.session_id, seq: 2 } })
    receive({ id: first.id, result: { session_id: params.session_id, running: true } })
    await first.pending
    expect(client.getActiveTurns()).toEqual([])

    const second = resume()
    expect(request('new-prompt', 'prompt.submit', { ...params, text: 'A newer fake prompt' }).ok).toBe(true)
    receive({ id: second.id, result: { session_id: params.session_id, inflight: {} } })
    await second.pending
    expect(client.getActiveTurns()).toEqual([params])
    receive({ id: 'new-prompt', error: { code: 1, message: 'Fake submission rejected' } })
    expect(client.getActiveTurns()).toEqual([])

    const third = resume()
    const remintedId = 'fake-reminted-runtime'
    receive({ method: 'event', params: { type: 'message.complete', session_id: remintedId, seq: 2 } })
    receive({ id: third.id, result: { session_id: remintedId, stored_session_id: 'fake-stored', running: true } })
    await third.pending
    receive({ method: 'event', params: { type: 'message.start', session_id: remintedId, seq: 1 } })
    expect(client.getActiveTurns()).toEqual([])
  })

  it('removes a main-owned prompt that could not be sent without cancelling an already running turn', async () => {
    const { client, send, receive } = await rendererClient()
    const params = { session_id: 'fake-runtime', profile: 'scout', text: 'Fake unsent prompt' }
    send.mockReturnValueOnce({ ok: false })
    await expect(client.call('prompt.submit', params)).rejects.toMatchObject({ code: 'disconnected' })
    expect(client.getActiveTurns()).toEqual([])
    receive({ method: 'event', params: { type: 'message.start', session_id: params.session_id, seq: 1 } })
    send.mockReturnValueOnce({ ok: false })
    await expect(client.call('prompt.submit', params)).rejects.toMatchObject({ code: 'disconnected' })
    expect(client.getActiveTurns()).toEqual([{ session_id: params.session_id, profile: 'scout' }])
  })

  it('replays reconnects on the new runtime id while resuming with the stored id', async () => {
    const client = createServeClient()
    cleanups.push(() => client.stop())
    const sender = new EventEmitter()
    sender.isDestroyed = () => false
    sender.send = vi.fn()
    const proxies = new Map(), sent = []
    const broker = client.bindRendererBroker({
      open: async (value, { id }) => { proxies.set(id, value); return { ok: true } },
      send: (_sender, { id, data }) => {
        const frame = JSON.parse(data)
        sent.push(frame)
        if (frame.method === 'session.events.since') proxies.get(id).send('maia:serveSocketEvent',
          { id, type: 'message', data: JSON.stringify({ jsonrpc: '2.0', id: frame.id,
            result: { events: [], latest_seq: 5, open_requests: [] } }) })
        return { ok: true }
      }, close() {}, closeAllFor() {},
    })
    const receive = (id, frame) => proxies.get(id).send('maia:serveSocketEvent',
      { id, type: 'message', data: JSON.stringify({ jsonrpc: '2.0', ...frame }) })
    await broker.open(sender, { id: 'renderer_old', path: '/api/ws' })
    proxies.get('renderer_old').send('maia:serveSocketEvent', { id: 'renderer_old', type: 'open' })
    broker.send(sender, { id: 'renderer_old', data: JSON.stringify({ jsonrpc: '2.0', id: 'old',
      method: 'session.resume', params: { profile: 'scout', session_id: 'fake-stored' } }) })
    receive('renderer_old', { id: 'old', result: { session_id: 'fake-old-runtime', stored_session_id: 'fake-stored' } })
    receive('renderer_old', { method: 'event', params: { type: 'message.delta', session_id: 'fake-old-runtime', seq: 5 } })
    proxies.get('renderer_old').send('maia:serveSocketEvent', { id: 'renderer_old', type: 'close' })
    await broker.open(sender, { id: 'renderer_new', path: '/api/ws' })
    proxies.get('renderer_new').send('maia:serveSocketEvent', { id: 'renderer_new', type: 'open' })
    broker.send(sender, { id: 'renderer_new', data: JSON.stringify({ jsonrpc: '2.0', id: 'new',
      method: 'session.resume', params: { profile: 'scout', session_id: 'fake-stored' } }) })
    receive('renderer_new', { id: 'new', result: { session_id: 'fake-new-runtime', stored_session_id: 'fake-stored' } })
    await vi.waitFor(() => expect(sent.some((frame) => frame.method === 'session.events.since')).toBe(true))
    expect(sent.find((frame) => frame.method === 'session.events.since').params).toEqual({
      session_id: 'fake-new-runtime', profile: 'scout', last_seen: 5,
    })
    expect(() => client.assertRendererSession({ profile: 'scout', storedId: 'fake-stored',
      runtimeId: 'fake-new-runtime' }, sender)).not.toThrow()
    expect(() => client.assertRendererSession({ profile: 'scout', storedId: 'fake-stored',
      runtimeId: 'fake-old-runtime' }, sender)).toThrow()
  })

  it('HD-08: denies full config, credential/controller RPCs and parameter smuggling atomically', async () => {
    const client = createServeClient()
    cleanups.push(() => client.stop())
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
    let proxy
    const send = vi.fn(() => ({ ok: true }))
    const broker = client.bindRendererBroker({
      open: async (value) => { proxy = value; return { ok: true } }, send, close() {}, closeAllFor() {},
    })
    await broker.open(sender, { id: 'renderer_policy', path: '/api/ws' })
    proxy.send('maia:serveSocketEvent', { id: 'renderer_policy', type: 'open' })
    const frame = (method, params = {}) => ({ jsonrpc: '2.0', id: `test-${method}`, method, params })
    for (const denied of [
      frame('config.get', { key: 'full' }), frame('config.get', { key: 'provider' }),
      frame('config.get', { key: 'theme', reveal: true }), frame('config.set', { key: 'approvals.mode', value: 'off' }),
      frame('vault.reveal'), frame('browser.controller.result'), frame('command.dispatch', { name: 'config', arg: 'full' }),
      frame('profiles.configure', { name: 'alpha', ui_meta: { display_name: 'Alpha' }, env: { KEY: 'fake' } }),
      frame('profiles.configure', { name: 'alpha', ui_meta: { env: 'fake' } }),
      { ...frame('profiles.list'), id: 'hd_main_spoof' },
      { jsonrpc: '2.0', id: 'unrequested-response', result: { value: 'fake' } },
    ]) {
      expect(broker.send(sender, { id: 'renderer_policy', data: JSON.stringify(denied) }).ok).toBe(false)
    }
    expect(broker.send(sender, { id: 'renderer_policy',
      data: [frame('profiles.list'), frame('config.get', { key: 'full' })].map(JSON.stringify).join('\n') }).ok).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(broker.send(sender, { id: 'renderer_policy', data: JSON.stringify(frame('profiles.list', { include_sessions: true })) }).ok).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(broker.send(sender, { id: 'renderer_policy', data: JSON.stringify(frame('profiles.list')) }).ok).toBe(false)
  })

  it('HD-08: projects allowed config metadata and drops private/unsolicited results while main retains authority', async () => {
    const s = await server()
    const client = await clientFor(s)
    // Main-only callers can still request effective configuration.
    await expect(client.call('config.get', { key: 'full', profile: 'alpha' })).resolves.toEqual({ accepted: true })
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
    let proxy
    const broker = client.bindRendererBroker({
      open: async (value) => { proxy = value; return { ok: true } },
      send: () => ({ ok: true }), close() {}, closeAllFor() {},
    })
    await broker.open(sender, { id: 'renderer_project', path: '/api/ws' })
    proxy.send('maia:serveSocketEvent', { id: 'renderer_project', type: 'open' })
    const request = (id, method, params) => broker.send(sender, { id: 'renderer_project',
      data: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    const receive = (id, result) => proxy.send('maia:serveSocketEvent', { id: 'renderer_project', type: 'message',
      data: JSON.stringify({ jsonrpc: '2.0', id, result }) })
    expect(request('metadata', 'config.get', { profile: 'alpha', key: 'approvals.mode' }).ok).toBe(true)
    receive('metadata', { value: 'manual', config: { token: 'OBVIOUSLY_FAKE_CONFIG_SECRET' }, env: { KEY: 'fake' } })
    expect(request('profiles', 'profiles.list', {}).ok).toBe(true)
    receive('profiles', { profiles: [{ name: 'alpha', ui_meta: { display_name: 'Alpha' },
      effective_config: { token: 'OBVIOUSLY_FAKE_CONFIG_SECRET' }, env: { KEY: 'fake' } }] })
    receive('unsolicited', { config: { arbitrary_field: 'OBVIOUSLY_FAKE_CONFIG_SECRET' } })
    const frames = sender.send.mock.calls.flatMap(([, event]) => (event.data || '').split('\n').filter(Boolean).map(JSON.parse))
    expect(frames.find((frame) => frame.id === 'metadata').result).toEqual({ value: 'manual' })
    expect(frames.find((frame) => frame.id === 'profiles').result).toEqual({
      profiles: [{ name: 'alpha', ui_meta: { display_name: 'Alpha' } }],
    })
    expect(frames.some((frame) => frame.id === 'unsolicited')).toBe(false)
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('OBVIOUSLY_FAKE_CONFIG_SECRET')
  })
})

describe('in-app model switching boundary', () => {
  const owned = { session_id: 'fake-runtime', profile: 'scout' }
  it('forwards only an explicit model, provider and scope for an owned session', async () => {
    const { request, sent } = await rendererClient()
    const count = sent.length
    for (const params of [
      { ...owned, key: 'model', value: 'gpt-5.5 --provider openrouter' },
      { ...owned, key: 'model', value: 'gpt-5.5 --provider openrouter --once' },
      { ...owned, key: 'model', value: 'gpt-5.5 --provider openrouter --global --session' },
      { ...owned, key: 'model', value: '--global --provider openrouter --session' },
      { ...owned, key: 'model', value: 'gpt 5.5 --provider openrouter --session' },
      { ...owned, key: 'model', value: 'gpt-5.5 --provider open router --session' },
      { ...owned, key: 'model', value: 'gpt-5.5 --provider openrouter --session --reasoning high' },
      { ...owned, key: 'yolo', value: 'on' },
      { ...owned, key: 'model', value: 'gpt-5.5 --provider openrouter --session', confirm_expensive_model: 'yes' },
      { ...owned, key: 'model', value: 'gpt-5.5 --provider openrouter --session', scope: 'global' },
      { session_id: 'foreign', profile: 'scout', key: 'model', value: 'gpt-5.5 --provider openrouter --session' },
      { session_id: 'fake-runtime', profile: 'other', key: 'model', value: 'gpt-5.5 --provider openrouter --session' },
      { profile: 'scout', key: 'model', value: 'gpt-5.5 --provider openrouter --session' },
    ]) expect(await request('switch', 'config.set', params)).toMatchObject({ ok: false })
    expect(await request('foreign-options', 'model.options', { session_id: 'foreign', profile: 'scout' })).toMatchObject({ ok: false })
    expect(await request('bad-refresh', 'model.options', { profile: 'scout', refresh: 'yes' })).toMatchObject({ ok: false })
    expect(sent).toHaveLength(count)
    expect(await request('ok', 'config.set', { ...owned, key: 'model',
      value: 'anthropic/claude-opus-5.5 --provider custom:bullinf --session', confirm_expensive_model: true })).toMatchObject({ ok: true })
    expect(await request('profile-options', 'model.options', { profile: 'scout' })).toMatchObject({ ok: true })
    expect(sent).toHaveLength(count + 2)
  })
  it.each([false, true])('asks natively (%s) before a pick becomes the profile default', async approved => {
    const approveModelDefault = vi.fn(async () => approved)
    const { request, sent, sender } = await rendererClient({ approveModelDefault })
    const count = sent.length
    expect(await request('default', 'config.set', { ...owned, key: 'model', value: 'glm-5.3 --provider zai --global' }))
      .toMatchObject({ ok: approved })
    expect(approveModelDefault).toHaveBeenCalledWith(sender, { profile: 'scout', model: 'glm-5.3', provider: 'zai' })
    expect(sent).toHaveLength(count + (approved ? 1 : 0))
  })
  it('returns only picker fields from model.options and config.set', async () => {
    const { request, receive, sender } = await rendererClient()
    request('options', 'model.options', { profile: 'scout' })
    receive({ id: 'options', result: { model: 'glm-5.3', provider: 'zai', providers: [
      { slug: 'zai', name: 'Z.ai', models: ['glm-5.3', 42], is_current: true, authenticated: true,
        api_url: 'https://FAKE_PRIVATE.invalid', key_env: 'FAKE_PRIVATE_KEY', pricing: { 'glm-5.3': { input: 'FAKE_PRIVATE' } } },
      { name: 'no slug' },
    ], config: 'FAKE_PRIVATE' } })
    const options = JSON.parse(sender.send.mock.calls.at(-1)[1].data).result
    expect(options).toEqual({ model: 'glm-5.3', provider: 'zai', providers: [{ slug: 'zai', name: 'Z.ai', models: ['glm-5.3'],
      featured_models: [], unavailable_models: [], is_current: true, authenticated: true }] })
    request('set', 'config.set', { ...owned, key: 'model', value: 'glm-5.3 --provider zai --session' })
    receive({ id: 'set', result: { key: 'model', value: 'glm-5.3', confirm_required: false, scope: 'session',
      info: { api_key: 'FAKE_PRIVATE' } } })
    expect(JSON.parse(sender.send.mock.calls.at(-1)[1].data).result).toEqual({ key: 'model', value: 'glm-5.3', confirm_required: false, scope: 'session' })
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('FAKE_PRIVATE')
  })
})
