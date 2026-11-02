import { afterEach, describe, expect, it, vi } from 'vitest'
import { openServeSocket, serveBridgeConnection, serveTokenHeader, SOCKET_CLOSED, SOCKET_OPEN } from '../serve-bridge'
import { HermesServeClient } from '../hermes-serve'
import { kanbanServeEvents } from '../kanban-serve'
import type { HostStatus } from '../desktop-bridge'

type RelayEvent = { id: string; type: 'open' | 'message' | 'error' | 'close'; data?: string; code?: number; reason?: string }

/** Stub of preload's serveSocket relay: records calls, lets tests push events. */
function stubRelay(openResult: { ok: boolean; error?: string } = { ok: true },
  baseUrl = 'http://127.0.0.1:9119/') {
  const listeners = new Set<(ev: RelayEvent) => void>()
  const relay = {
    open: vi.fn(async (_p: { id: string; path: string; query?: Record<string, string> }) => openResult),
    send: vi.fn(async () => ({ ok: true })),
    close: vi.fn(async () => ({ ok: true })),
    onEvent: vi.fn((cb: (ev: RelayEvent) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }),
  }
  const push = (ev: Omit<RelayEvent, 'id'>, id = relay.open.mock.calls.at(-1)![0].id) => {
    for (const l of [...listeners]) l({ id, ...ev })
  }
  ;(window as unknown as { nubAgent: unknown }).nubAgent = {
    serveConfig: async () => ({ present: true, baseUrl, tokenSource: 'file' }),
    serveSocket: relay,
  }
  return { relay, push, listeners }
}

function stubHostStatus() {
  const listeners = new Set<(status: HostStatus) => void>()
  ;(window as unknown as { nubAgent: { host: unknown } }).nubAgent.host = {
    onStatus: (callback: (status: HostStatus) => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  }
  return {
    listeners,
    push(state: HostStatus['serve']['state'], port = 9119) {
      const status: HostStatus = { gateway: { state: 'up' }, serve: { state, port }, controller: 'off' }
      for (const callback of [...listeners]) callback(status)
    },
  }
}

afterEach(() => {
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
  vi.unstubAllGlobals()
})

describe('serve-bridge (#161: token stays in main)', () => {
  it('bridge connections carry no token and send no auth header', async () => {
    stubRelay()
    expect(await serveBridgeConnection()).toEqual({ baseUrl: 'http://127.0.0.1:9119', token: '' })
    expect(serveTokenHeader('')).toEqual({})
    expect(serveTokenHeader('explicit')).toEqual({ 'X-Hermes-Session-Token': 'explicit' })
  })

  it('absent serve → null', async () => {
    ;(window as unknown as { nubAgent: unknown }).nubAgent = {
      serveConfig: async () => ({ present: false, baseUrl: 'http://127.0.0.1:9119', tokenSource: 'none' }),
    }
    expect(await serveBridgeConnection()).toBeNull()
  })

  it('relays through main without any token in the request', async () => {
    const native = vi.fn()
    vi.stubGlobal('WebSocket', native)
    const { relay, push } = stubRelay()
    const sock = openServeSocket({ baseUrl: 'http://127.0.0.1:9119', token: '' }, '/api/ws', { since: '3' })
    expect(native).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(relay.open).toHaveBeenCalled())
    // Subscribed before open was requested.
    expect(relay.onEvent.mock.invocationCallOrder[0]).toBeLessThan(relay.open.mock.invocationCallOrder[0])
    const payload = relay.open.mock.calls[0][0]
    expect(payload.path).toBe('/api/ws')
    expect(payload.query).toEqual({ since: '3' })
    expect(JSON.stringify(payload)).not.toMatch(/token/i)

    const seen: string[] = []
    sock.addEventListener('open', () => seen.push('open'))
    sock.addEventListener('message', (ev) => seen.push(`msg:${(ev as MessageEvent).data}`))
    sock.addEventListener('close', () => seen.push('close'))
    push({ type: 'open' })
    expect(sock.readyState).toBe(SOCKET_OPEN)
    sock.send('frame')
    expect(relay.send).toHaveBeenCalledWith(payload.id, 'frame')
    push({ type: 'message', data: 'hi' })
    push({ type: 'message', data: 'other' }, 'someone-else')
    push({ type: 'close', code: 1000 })
    expect(seen).toEqual(['open', 'msg:hi', 'close'])
    expect(sock.readyState).toBe(SOCKET_CLOSED)
  })

  it('a refused open surfaces as error + close', async () => {
    stubRelay({ ok: false, error: 'no serve token' })
    const sock = openServeSocket({ baseUrl: 'http://127.0.0.1:9119', token: '' }, '/api/ws')
    const seen: string[] = []
    sock.addEventListener('error', () => seen.push('error'))
    sock.addEventListener('close', () => seen.push('close'))
    await vi.waitFor(() => expect(seen).toEqual(['error', 'close']))
  })

  it('keeps a healthy relay open when REST uses a separate local proxy port', async () => {
    const { relay, push } = stubRelay(undefined, 'http://127.0.0.1:43210/')
    const host = stubHostStatus()
    const sock = openServeSocket({ baseUrl: 'http://127.0.0.1:43210', token: '' }, '/api/ws')
    await vi.waitFor(() => expect(relay.open).toHaveBeenCalled())
    push({ type: 'open' })
    for (let poll = 0; poll < 3; poll += 1) host.push('up')
    await Promise.resolve()
    expect(sock.readyState).toBe(SOCKET_OPEN)
    expect(relay.close).not.toHaveBeenCalled()
    expect(host.listeners.size).toBe(1)
    push({ type: 'close', code: 1012 })
    expect(host.listeners.size).toBe(0)
  })

  it('still closes for an actual host outage and releases its status listener', async () => {
    const { relay, push } = stubRelay(undefined, 'http://127.0.0.1:43210/')
    const host = stubHostStatus()
    const sock = openServeSocket({ baseUrl: 'http://127.0.0.1:43210', token: '' }, '/api/ws')
    await vi.waitFor(() => expect(relay.open).toHaveBeenCalled())
    push({ type: 'open' })
    host.push('down')
    await vi.waitFor(() => expect(relay.close).toHaveBeenCalled())
    expect(sock.readyState).toBe(SOCKET_CLOSED)
    expect(host.listeners.size).toBe(0)
  })

  it('an explicit token still uses a native socket with ?token=', () => {
    const urls: string[] = []
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url: string) {
          urls.push(url)
        }
      },
    )
    stubRelay()
    openServeSocket({ baseUrl: 'http://127.0.0.1:9119', token: 'explicit' }, '/api/ws')
    expect(urls[0]).toBe('ws://127.0.0.1:9119/api/ws?token=explicit')
  })

  it('HermesServeClient on a bridge connection connects through the relay', async () => {
    const { relay, push } = stubRelay()
    const client = new HermesServeClient({ baseUrl: 'http://127.0.0.1:9119', token: '' })
    const connected = client.connect()
    await vi.waitFor(() => expect(relay.open).toHaveBeenCalled())
    push({ type: 'open' })
    await connected
    expect(client.connectionState).toBe('open')
    void client.request('session.list', {}).catch(() => {})
    const frame = JSON.parse((relay.send.mock.calls[0] as unknown as [string, string])[1])
    expect(frame.method).toBe('session.list')
    client.close()
  })

  it.each(['refused', 'rejected'] as const)('rejects a server-request answer when the main relay send is %s', async (failure) => {
    const { relay, push, listeners } = stubRelay()
    const client = new HermesServeClient({ baseUrl: 'http://127.0.0.1:9119', token: '' })
    const connected = client.connect()
    await vi.waitFor(() => expect(relay.open).toHaveBeenCalled())
    push({ type: 'open' })
    await connected
    if (failure === 'refused') relay.send.mockResolvedValueOnce({ ok: false })
    else relay.send.mockRejectedValueOnce(new Error('Synthetic private relay detail'))
    const outcome = await Promise.resolve().then(() => client.respond('srq-fake', { choice: 'deny' }))
      .then(() => 'sent', (error: Error) => error.message)
    expect(outcome).toBe('Hermes relay send failed')
    expect(client.connectionState).toBe('closed')
    expect(listeners.size).toBe(0)
    client.close()
  })

  it('waits for main relay confirmation before resolving a server-request answer', async () => {
    const { relay, push } = stubRelay()
    const client = new HermesServeClient({ baseUrl: 'http://127.0.0.1:9119', token: '' })
    const connected = client.connect()
    await vi.waitFor(() => expect(relay.open).toHaveBeenCalled())
    push({ type: 'open' })
    await connected
    let finish!: (result: { ok: boolean }) => void
    relay.send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    let settled = false
    const answer = Promise.resolve(client.respond('srq-fake', { choice: 'deny' })).then(() => { settled = true })
    await Promise.resolve()
    const settledBeforeConfirmation = settled
    finish({ ok: true })
    await answer
    expect(settledBeforeConfirmation).toBe(false)
    expect(settled).toBe(true)
    client.close()
  })

  it('rejects an RPC when the relay refuses the send without an unhandled rejection', async () => {
    const { relay, push, listeners } = stubRelay()
    const client = new HermesServeClient({ baseUrl: 'http://127.0.0.1:9119', token: '' })
    const connected = client.connect()
    await vi.waitFor(() => expect(relay.open).toHaveBeenCalled())
    push({ type: 'open' })
    await connected
    relay.send.mockResolvedValueOnce({ ok: false })
    await expect(client.request('session.list')).rejects.toThrow('WebSocket closed')
    expect(client.connectionState).toBe('closed')
    expect(listeners.size).toBe(0)
    client.close()
  })

  it('consumes a refused policy-denial response while closing the failed relay', async () => {
    const { relay, push, listeners } = stubRelay()
    const client = new HermesServeClient({ baseUrl: 'http://127.0.0.1:9119', token: '' })
    const connected = client.connect()
    await vi.waitFor(() => expect(relay.open).toHaveBeenCalled())
    push({ type: 'open' })
    await connected
    relay.send.mockResolvedValueOnce({ ok: false })
    client.dispatchRequest({ id: 'srq-fake', method: 'unsupported-fixture', params: {} })
    await vi.waitFor(() => expect(client.connectionState).toBe('closed'))
    expect(listeners.size).toBe(0)
    client.close()
  })

  it('kanban event tail rides the relay with only since/board', async () => {
    const { relay, push } = stubRelay()
    const batches: number[] = []
    const stop = kanbanServeEvents(
      { baseUrl: 'http://127.0.0.1:9119', token: '' },
      (_events, cursor) => batches.push(cursor),
      undefined,
      { since: 9, board: 'ops' },
    )
    await vi.waitFor(() => expect(relay.open).toHaveBeenCalled())
    expect(relay.open.mock.calls[0][0]).toMatchObject({ path: '/api/plugins/kanban/events', query: { since: '9', board: 'ops' } })
    push({ type: 'message', data: JSON.stringify({ events: [], cursor: 12 }) })
    expect(batches).toEqual([12])
    stop()
  })
})
