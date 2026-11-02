import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const serveAuth = require('./serve-auth.cjs')
const {
  SERVE_SOCKET_EVENT,
  serveBaseUrl,
  readServeToken,
  cachedServeToken,
  serveConfigForRenderer,
  shouldAttachServeToken,
  withServeToken,
  installServeAuth,
  sanitizeSocketQuery,
  createServeSocketBroker,
} = serveAuth

const BASE = 'http://127.0.0.1:9119'

describe('#161: serve token resolution (main only)', () => {
  it('env wins, then the token file, else none', async () => {
    const readFile = vi.fn(async () => 'from-file\n')
    expect(await readServeToken({ env: { HERMES_DASHBOARD_SESSION_TOKEN: 'from-env' }, readFile })).toEqual({
      token: 'from-env',
      source: 'env',
    })
    expect(readFile).not.toHaveBeenCalled()
    expect(await readServeToken({ env: { HERMES_SERVE_TOKEN_FILE: '/x/serve.token' }, readFile })).toEqual({
      token: 'from-file',
      source: 'file',
    })
    expect(readFile).toHaveBeenCalledWith('/x/serve.token', 'utf8')
    const missing = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    expect(await readServeToken({ env: { HERMES_HOME: '/h' }, readFile: missing })).toEqual({ token: '', source: 'none' })
    expect(missing).toHaveBeenCalledWith('/h/serve.token', 'utf8')
  })

  it('caches the token briefly, then re-reads (rotation)', async () => {
    let t = 0
    const read = vi.fn(async () => ({ token: `tok-${read.mock.calls.length}`, source: 'file' }))
    const get = cachedServeToken({ read, now: () => t, ttlMs: 1000 })
    expect((await get()).token).toBe('tok-1')
    t = 500
    expect((await get()).token).toBe('tok-1')
    t = 1500
    expect((await get()).token).toBe('tok-2')
  })

  it('serve base URL is normalized to an http(s) origin; junk falls back', () => {
    expect(serveBaseUrl({})).toBe(BASE)
    expect(serveBaseUrl({ HERMES_SERVE_URL: 'http://localhost:9000/some/path/' })).toBe('http://localhost:9000')
    expect(serveBaseUrl({ HERMES_SERVE_URL: 'javascript:alert(1)' })).toBe(BASE)
    expect(serveBaseUrl({ HERMES_SERVE_URL: 'not a url' })).toBe(BASE)
  })
})

describe('#161: maia:serveConfig answers presence only', () => {
  it('never carries the token or the token file path', () => {
    const cfg = serveConfigForRenderer(
      { token: 'super-secret', source: 'file' },
      { HERMES_HOME: '/h', HERMES_SERVE_TOKEN_FILE: '/secret/place/serve.token' },
    )
    expect(cfg).toEqual({ present: true, baseUrl: BASE, tokenSource: 'file', hermesHome: '/h' })
    expect(JSON.stringify(cfg)).not.toContain('super-secret')
    expect(JSON.stringify(cfg)).not.toContain('/secret/place')
  })

  it('absent token → present:false with a hint', () => {
    const cfg = serveConfigForRenderer({ token: '', source: 'none' }, { HERMES_HOME: '/h' })
    expect(cfg.present).toBe(false)
    expect(cfg.tokenSource).toBe('none')
    expect(cfg.error).toMatch(/no serve token/)
    expect(cfg).not.toHaveProperty('token')
  })
})

describe('#161: REST header injection gate', () => {
  const mainFrame = { name: 'main' }
  const wc = { id: 7, mainFrame, isDestroyed: () => false }
  const ok = { url: `${BASE}/api/skills`, webContentsId: 7, frame: mainFrame, resourceType: 'xhr' }

  it('attaches only for fetch/XHR from an app window top frame to the serve origin', () => {
    expect(shouldAttachServeToken(ok, { baseUrl: BASE, trustedWebContents: [wc] })).toBe(true)
    // The HUD window is trusted too (same app code, same assertMainSender gate).
    const hudFrame = { name: 'hud' }
    const hud = { id: 9, mainFrame: hudFrame, isDestroyed: () => false }
    expect(
      shouldAttachServeToken({ ...ok, webContentsId: 9, frame: hudFrame }, { baseUrl: BASE, trustedWebContents: [wc, hud] }),
    ).toBe(true)
  })

  it.each([
    ['a sub-frame (nub-vm preview iframe)', { frame: { name: 'child' } }],
    ['no frame (main-process / service request)', { frame: null }],
    ['another window', { webContentsId: 8 }],
    ['a navigation', { resourceType: 'mainFrame' }],
    ['an image load', { resourceType: 'image' }],
    ['a different port', { url: 'http://127.0.0.1:9120/api/skills' }],
    ['a look-alike host', { url: 'http://127.0.0.1.evil.example/api/skills' }],
  ])('refuses %s', (_label, patch) => {
    expect(shouldAttachServeToken({ ...ok, ...patch }, { baseUrl: BASE, trustedWebContents: [wc] })).toBe(false)
  })

  it('refuses when the main window is gone', () => {
    expect(shouldAttachServeToken(ok, { baseUrl: BASE, trustedWebContents: [] })).toBe(false)
    expect(
      shouldAttachServeToken(ok, { baseUrl: BASE, trustedWebContents: [{ ...wc, isDestroyed: () => true }] }),
    ).toBe(false)
  })

  it('HD-08: authenticates only permitted REST methods/routes, never effective config or secrets', async () => {
    for (const route of ['/api/config', '/api/env', '/api/env/reveal', '/api/config/raw',
      '/api/mcp/servers', '/api/tools/toolsets/terminal/config', '/api/memory/providers/fake/config',
      '/api/credentials/reveal', '/api/not-registered', '/api/skills?reveal=1']) {
      expect(shouldAttachServeToken({ ...ok, url: `${BASE}${route}`, method: 'GET' },
        { baseUrl: BASE, trustedWebContents: [wc] })).toBe(false)
    }
    expect(shouldAttachServeToken({ ...ok, method: 'DELETE' }, { baseUrl: BASE, trustedWebContents: [wc] })).toBe(false)
    expect(shouldAttachServeToken({ ...ok, method: 'GET' }, { baseUrl: BASE, trustedWebContents: [wc] })).toBe(true)
    let listener
    const getToken = vi.fn(async () => ({ token: 'OBVIOUSLY_FAKE_MAIN_TOKEN' }))
    installServeAuth({ webRequest: { onBeforeSendHeaders: (_filter, handler) => { listener = handler } } }, {
      baseUrl: BASE, getToken, getTrustedWebContents: () => [wc],
    })
    const result = await new Promise((resolve) => listener({ ...ok, url: `${BASE}/api/env/reveal` }, resolve))
    expect(result).toEqual({})
    expect(getToken).not.toHaveBeenCalled()
  })

  it('replaces any renderer-supplied variant of the header', () => {
    const next = withServeToken({ 'x-hermes-session-token': 'forged', 'x-hermes-desk-renderer': 'forged', Accept: '*/*' }, 'real')
    expect(next).toEqual({ Accept: '*/*', 'X-Hermes-Session-Token': 'real' })
  })

  it('installServeAuth scopes the listener to the serve origin and injects from main', async () => {
    let filter
    let listener
    const ses = { webRequest: { onBeforeSendHeaders: (f, l) => ((filter = f), (listener = l)) } }
    installServeAuth(ses, {
      baseUrl: BASE,
      getToken: async () => ({ token: 'main-only' }),
      getTrustedWebContents: () => [wc],
    })
    expect(filter).toEqual({ urls: [`${BASE}/*`] })

    const injected = await new Promise((resolve) => listener({ ...ok, requestHeaders: {} }, resolve))
    expect(injected).toEqual({ requestHeaders: { 'X-Hermes-Session-Token': 'main-only', 'X-Hermes-Desk-Renderer': '7' } })

    const untouched = await new Promise((resolve) =>
      listener({ ...ok, frame: { name: 'child' }, requestHeaders: {} }, resolve),
    )
    expect(untouched).toEqual({})
  })

  it('re-checks the window after the async token read and never leaves a request hanging', async () => {
    let listener
    const ses = { webRequest: { onBeforeSendHeaders: (_f, l) => (listener = l) } }
    let trusted = [wc]
    let resolveToken
    installServeAuth(ses, {
      baseUrl: BASE,
      getToken: () => new Promise((resolve) => { resolveToken = resolve }),
      getTrustedWebContents: () => trusted,
    })
    const pending = new Promise((resolve) => listener({ ...ok, requestHeaders: {} }, resolve))
    trusted = [] // the window closed while the token was loading
    resolveToken({ token: 'main-only' })
    expect(await pending).toEqual({})

    installServeAuth(ses, {
      baseUrl: BASE,
      getToken: async () => { throw new Error('unreadable token file') },
      getTrustedWebContents: () => [wc],
    })
    expect(await new Promise((resolve) => listener({ ...ok, requestHeaders: {} }, resolve))).toEqual({})
  })

  it('labels the renderer only with a positive integer sender id', () => {
    for (const id of [0, -1, 1.5, NaN, '7', undefined]) {
      expect(withServeToken({}, 'real', id)).toEqual({ 'X-Hermes-Session-Token': 'real' })
    }
  })
})

/** WebSocket double: records the URL, lets the test drive events. */
class FakeWs {
  static last = null
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.closed = null
    this.handlers = {}
    FakeWs.last = this
  }
  addEventListener(type, fn) {
    ;(this.handlers[type] ||= []).push(fn)
  }
  emit(type, ev = {}) {
    if (type === 'open') this.readyState = 1
    for (const fn of this.handlers[type] || []) fn(ev)
  }
  send(data) {
    this.sent.push(data)
  }
  close(code, reason) {
    this.closed = { code, reason }
  }
}

function fakeSender() {
  const events = []
  const once = {}
  return {
    events,
    send: (channel, ev) => events.push({ channel, ev }),
    isDestroyed: () => false,
    once: (name, fn) => (once[name] = fn),
    destroy: () => once.destroyed?.(),
  }
}

describe('#161: serve WebSocket relay', () => {
  const broker = () =>
    createServeSocketBroker({ baseUrl: BASE, getToken: async () => ({ token: 'ws-secret' }), WebSocketImpl: FakeWs })

  it('opens the token-bearing URL in main; the renderer only sees frames', async () => {
    const b = broker()
    const sender = fakeSender()
    const res = await b.open(sender, { id: 'sock_12345', path: '/api/plugins/kanban/events', query: { since: '4' } })
    expect(res).toEqual({ ok: true })
    const url = new URL(FakeWs.last.url)
    expect(url.origin).toBe('ws://127.0.0.1:9119')
    expect(url.pathname).toBe('/api/plugins/kanban/events')
    expect(url.searchParams.get('since')).toBe('4')
    expect(url.searchParams.get('token')).toBe('ws-secret')

    FakeWs.last.emit('open')
    FakeWs.last.emit('message', { data: '{"events":[]}' })
    FakeWs.last.emit('error', { message: `failed ${FakeWs.last.url}` })
    FakeWs.last.emit('close', { code: 1000, reason: 'bye' })
    expect(sender.events.map((e) => e.ev.type)).toEqual(['open', 'message', 'error', 'close'])
    expect(sender.events.every((e) => e.channel === SERVE_SOCKET_EVENT && e.ev.id === 'sock_12345')).toBe(true)
    expect(JSON.stringify(sender.events)).not.toContain('ws-secret')
    expect(b.size()).toBe(0)
  })

  it('refuses paths outside the serve socket allowlist', async () => {
    const b = broker()
    await expect(b.open(fakeSender(), { id: 'sock_12345', path: '/api/files/download' })).rejects.toThrow(/path not allowed/)
    await expect(b.open(fakeSender(), { id: 'sock_12345', path: '/api/ws/../env' })).rejects.toThrow(/path not allowed/)
  })

  it('drops renderer-supplied credentials and odd query keys', () => {
    const qs = sanitizeSocketQuery({ token: 'forged', ticket: 't', since: '1', 'Bad-Key': 'x', board: 'b', n: 5 })
    expect(Object.fromEntries(qs)).toEqual({ since: '1', board: 'b' })
  })

  it('send/close only reach sockets the same sender owns', async () => {
    const b = broker()
    const owner = fakeSender()
    const other = fakeSender()
    await b.open(owner, { id: 'sock_owned1', path: '/api/ws' })
    const ws = FakeWs.last
    expect(b.send(owner, { id: 'sock_owned1', data: 'x' })).toEqual({ ok: false, error: 'socket not open' })
    ws.emit('open')
    expect(b.send(other, { id: 'sock_owned1', data: 'x' }).ok).toBe(false)
    expect(b.send(owner, { id: 'sock_owned1', data: 'hello' })).toEqual({ ok: true })
    expect(ws.sent).toEqual(['hello'])
    b.close(other, { id: 'sock_owned1' })
    expect(ws.closed).toBeNull()
    b.close(owner, { id: 'sock_owned1', code: 1, reason: 'r' })
    expect(ws.closed).toEqual({ code: undefined, reason: undefined })
  })

  it('caps sockets per sender and closes them when the sender dies', async () => {
    const b = createServeSocketBroker({
      baseUrl: BASE,
      getToken: async () => ({ token: 't' }),
      WebSocketImpl: FakeWs,
      maxPerSender: 1,
    })
    const sender = fakeSender()
    await b.open(sender, { id: 'sock_aaaaaa', path: '/api/ws' })
    const first = FakeWs.last
    expect(await b.open(sender, { id: 'sock_bbbbbb', path: '/api/ws' })).toEqual({
      ok: false,
      error: 'too many serve sockets',
    })
    sender.destroy()
    expect(first.closed).not.toBeNull()
    expect(b.size()).toBe(0)
  })

  it('reports no-token without opening anything', async () => {
    const b = createServeSocketBroker({ baseUrl: BASE, getToken: async () => ({ token: '' }), WebSocketImpl: FakeWs })
    FakeWs.last = null
    expect(await b.open(fakeSender(), { id: 'sock_12345', path: '/api/ws' })).toEqual({ ok: false, error: 'no serve token' })
    expect(FakeWs.last).toBeNull()
  })

  it('HD-11: reserves capacity and IDs synchronously across delayed concurrent admissions', async () => {
    let resolveToken
    const token = new Promise((resolve) => { resolveToken = resolve })
    const constructed = []
    class Socket extends FakeWs { constructor(url) { super(url); constructed.push(this) } }
    const b = createServeSocketBroker({ baseUrl: BASE, getToken: () => token, WebSocketImpl: Socket, maxPerSender: 2 })
    const sender = fakeSender()
    const admissions = Array.from({ length: 12 }, (_, i) => b.open(sender, { id: `socket_${String(i).padStart(8, '0')}`, path: '/api/ws' }))
    expect(b.size()).toBe(2)
    await expect(b.open(sender, { id: 'socket_00000000', path: '/api/ws' })).rejects.toThrow('id in use')
    resolveToken({ token: 'OBVIOUSLY_FAKE_TOKEN' })
    const results = await Promise.all(admissions)
    expect(results.filter((result) => result.ok)).toHaveLength(2)
    expect(constructed).toHaveLength(2)
    sender.destroy()
    expect(b.size()).toBe(0)
  })

  it('HD-11: releases pending slots on close, sender death, token failure and constructor failure', async () => {
    let release
    const getToken = vi.fn(() => new Promise((resolve) => { release = resolve }))
    FakeWs.last = null
    const b = createServeSocketBroker({ baseUrl: BASE, getToken, WebSocketImpl: FakeWs, maxPerSender: 1 })
    const sender = fakeSender()
    let opening = b.open(sender, { id: 'socket_pending', path: '/api/ws' })
    b.close(sender, { id: 'socket_pending' })
    release({ token: 'OBVIOUSLY_FAKE_TOKEN' })
    expect((await opening).ok).toBe(false)
    expect(b.size()).toBe(0)
    opening = b.open(sender, { id: 'socket_pending', path: '/api/ws' })
    sender.destroy()
    release({ token: 'OBVIOUSLY_FAKE_TOKEN' })
    expect((await opening).ok).toBe(false)
    expect(FakeWs.last).toBeNull()
    expect(b.size()).toBe(0)
    const alive = fakeSender()
    getToken.mockRejectedValueOnce(new Error('OBVIOUSLY_FAKE_TOKEN'))
    expect((await b.open(alive, { id: 'socket_failure', path: '/api/ws' })).ok).toBe(false)
    expect(b.size()).toBe(0)
    const constructed = vi.fn()
    const failed = createServeSocketBroker({ baseUrl: BASE, getToken: async () => ({ token: 'fake' }),
      WebSocketImpl: class { constructor() { constructed(); throw new Error('OBVIOUSLY_FAKE_TOKEN') } } })
    expect((await failed.open(alive, { id: 'socket_failure', path: '/api/ws' })).ok).toBe(false)
    expect(constructed).toHaveBeenCalledOnce()
    expect(failed.size()).toBe(0)
  })

  it('validates socket ids, query values, frame sizes, close codes and close reasons', async () => {
    const b = broker()
    for (const id of ['short', 'sock/../../x', 'sock 12345', 'x'.repeat(65)]) {
      await expect(b.open(fakeSender(), { id, path: '/api/ws' })).rejects.toThrow(/invalid id/)
    }
    expect(Object.fromEntries(sanitizeSocketQuery({ since: 'x'.repeat(257), board: 'b' }))).toEqual({ board: 'b' })
    const sender = fakeSender()
    await b.open(sender, { id: 'sock_frames', path: '/api/ws' })
    const ws = FakeWs.last
    ws.emit('open')
    expect(b.send(sender, { id: 'sock_frames', data: 'x'.repeat(4 * 1024 * 1024 + 1) }))
      .toEqual({ ok: false, error: 'invalid frame' })
    expect(ws.sent).toEqual([])
    for (const code of [1001, 2999, 5000]) {
      b.close(sender, { id: 'sock_frames', code })
      expect(ws.closed).toEqual({ code: undefined, reason: undefined })
    }
    b.close(sender, { id: 'sock_frames', code: 4001, reason: 'r'.repeat(500) })
    expect(ws.closed).toEqual({ code: 4001, reason: 'r'.repeat(120) })
  })

  it('uses wss for https serve and never forwards to a released socket or a destroyed sender', async () => {
    const secure = createServeSocketBroker({ baseUrl: 'https://serve.example', getToken: async () => ({ token: 'fake' }),
      WebSocketImpl: FakeWs })
    await secure.open(fakeSender(), { id: 'sock_secure', path: '/api/ws' })
    expect(new URL(FakeWs.last.url).protocol).toBe('wss:')

    const b = broker()
    expect(await b.open({ ...fakeSender(), isDestroyed: () => true }, { id: 'sock_dead1', path: '/api/ws' }))
      .toEqual({ ok: false, error: 'sender destroyed' })

    const released = fakeSender()
    await b.open(released, { id: 'sock_late1', path: '/api/ws' })
    const lateWs = FakeWs.last
    b.closeAllFor(released)
    lateWs.emit('message', { data: 'late' })
    expect(released.events).toEqual([])

    let gone = false
    const fragile = { ...fakeSender(), isDestroyed: () => gone }
    await b.open(fragile, { id: 'sock_fragile', path: '/api/ws' })
    const ws = FakeWs.last
    ws.emit('open')
    gone = true
    ws.emit('message', { data: 'after destroy' })
    expect(fragile.events.map((e) => e.ev.type)).toEqual(['open'])
  })
})
