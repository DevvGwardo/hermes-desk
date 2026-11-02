import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HermesServeClient, approvalModeToCommand } from '../hermes-serve'

type WsHandler = (ev: { data?: string }) => void
type WsOpenHandler = () => void
type WsCloseHandler = () => void

/** Minimal WebSocket double capturing sent frames. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  readyState = 0
  sendFrames: string[] = []
  messageHandlers: WsHandler[] = []
  openHandlers: WsOpenHandler[] = []
  closeHandlers: WsCloseHandler[] = []
  closeCalls = 0
  static OPEN = 1

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(ev: string, fn: unknown): void {
    if (ev === 'message') this.messageHandlers.push(fn as WsHandler)
    else if (ev === 'open') this.openHandlers.push(fn as WsOpenHandler)
    else if (ev === 'close') this.closeHandlers.push(fn as WsCloseHandler)
  }

  removeEventListener(): void {
    /* no-op */
  }

  send(raw: string): void {
    this.sendFrames.push(raw)
  }

  close(): void {
    this.closeCalls += 1
    this.readyState = 3
  }

  // test helpers
  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    for (const h of this.openHandlers) h()
  }

  emitMessage(raw: string): void {
    for (const h of this.messageHandlers) h({ data: raw })
  }

  emitClose(): void {
    for (const h of this.closeHandlers) h()
  }

  lastSent(): Record<string, unknown> | null {
    const raw = this.sendFrames.at(-1)
    if (!raw) return null
    return JSON.parse(raw) as Record<string, unknown>
  }
}

let socket: FakeWebSocket

beforeEach(() => {
  FakeWebSocket.instances = []
  socket = null as unknown as FakeWebSocket
  vi.stubGlobal('WebSocket', class extends FakeWebSocket {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function connectClient(): Promise<HermesServeClient> {
  const client = new HermesServeClient({ baseUrl: 'http://127.0.0.1:9119', token: 'secret-token' })
  const p = client.connect()
  socket = FakeWebSocket.instances[0]!
  socket.emitOpen()
  await p
  return client
}

describe('HermesServeClient wire protocol', () => {
  it('connects to /api/ws with the token query param', async () => {
    await connectClient()
    expect(socket.url).toContain('/api/ws')
    expect(socket.url).toContain('token=secret-token')
  })

  it('sends newline-delimited JSON-RPC frames', async () => {
    const client = await connectClient()
    const p = client.request('session.list', { limit: 5 })
    const frame = socket.lastSent()!
    expect(frame.jsonrpc).toBe('2.0')
    expect(frame.method).toBe('session.list')
    expect(frame.params).toEqual({ limit: 5 })
    expect(typeof frame.id).toBe('string')
    // respond
    socket.emitMessage(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { sessions: [] } }))
    await expect(p).resolves.toEqual({ sessions: [] })
  })

  it('confirms a native server-request send without requiring a relay acknowledgement', async () => {
    const client = await connectClient()
    await expect(client.respond('srq-native-fixture', { choice: 'deny' })).resolves.toBeUndefined()
    expect(socket.lastSent()).toEqual({ jsonrpc: '2.0', id: 'srq-native-fixture', result: { choice: 'deny' } })
    client.close()
  })

  it('rejects on RPC error envelope', async () => {
    const client = await connectClient()
    const p = client.request('session.resume', { session_id: 'nope' })
    const frame = socket.lastSent()!
    socket.emitMessage(
      JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: 4007, message: 'session not found' } }),
    )
    await expect(p).rejects.toThrow('session not found')
  })

  it('routes gateway events to typed handlers', async () => {
    const client = await connectClient()
    const deltas: string[] = []
    const tools: string[] = []
    client.on('message.delta', (ev) => {
      deltas.push((ev.payload as { text: string }).text)
    })
    client.on('tool.start', (ev) => {
      tools.push((ev.payload as { name: string }).name)
    })
    socket.emitMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'message.delta', session_id: 's1', payload: { text: 'hello' } },
      }),
    )
    socket.emitMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'tool.start', session_id: 's1', payload: { name: 'bash', tool_id: 't1' } },
      }),
    )
    expect(deltas).toEqual(['hello'])
    expect(tools).toEqual(['bash'])
  })

  it('routes gateway.ready and session.info through onAny', async () => {
    const client = await connectClient()
    const types: string[] = []
    client.onAny((ev) => {
      types.push(ev.type)
    })
    socket.emitMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } }),
    )
    socket.emitMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'session.info', session_id: 's1', payload: { model: 'deepseek' } },
      }),
    )
    expect(types).toContain('gateway.ready')
    expect(types).toContain('session.info')
  })

  it('rejects pending calls when the socket closes', async () => {
    const client = await connectClient()
    const p = client.request('prompt.submit', { session_id: 's1', text: 'hi' })
    socket.emitClose()
    await expect(p).rejects.toThrow('WebSocket closed')
  })

  it('times out a request with no response (fake timers, seeded 20ms)', async () => {
    vi.useFakeTimers()
    try {
      const client = new HermesServeClient({
        baseUrl: 'http://127.0.0.1:9119',
        token: 't',
        requestTimeoutMs: 20,
      })
      const p = client.connect()
      socket = FakeWebSocket.instances[0]!
      socket.emitOpen()
      await p
      const req = client.request('session.list')
      const assertion = expect(req).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(20)
      await assertion
      client.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes subagent.start events', async () => {
    const client = await connectClient()
    const seen: string[] = []
    client.on('subagent.start', (ev) => {
      seen.push((ev.payload as { subagent_id: string }).subagent_id)
    })
    socket.emitMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          type: 'subagent.start',
          session_id: 'parent',
          payload: { subagent_id: 'sa_1', goal: 'flights', child_session_id: 'child' },
        },
      }),
    )
    expect(seen).toEqual(['sa_1'])
  })

  it('calls subagent.interrupt and subagent.steer RPCs', async () => {
    const client = await connectClient()
    const interrupt = client.request('subagent.interrupt', { subagent_id: 'sa_1' })
    expect(socket.lastSent()?.method).toBe('subagent.interrupt')
    socket.emitMessage(
      JSON.stringify({ jsonrpc: '2.0', id: socket.lastSent()!.id, result: { found: true, subagent_id: 'sa_1' } }),
    )
    await expect(interrupt).resolves.toEqual({ found: true, subagent_id: 'sa_1' })

    const steer = client.request('subagent.steer', {
      subagent_id: 'sa_1',
      text: 'also Saturday',
      session_id: 'parent',
    })
    expect(socket.lastSent()?.method).toBe('subagent.steer')
    socket.emitMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: socket.lastSent()!.id,
        result: { status: 'queued', subagent_id: 'sa_1' },
      }),
    )
    await expect(steer).resolves.toEqual({ status: 'queued', subagent_id: 'sa_1' })
  })
})

describe('approvalModeToCommand', () => {
  it('maps Settings pills onto Hermes /approvals', () => {
    expect(approvalModeToCommand('ask')).toEqual({ name: 'approvals', arg: 'manual' })
    expect(approvalModeToCommand('smart')).toEqual({ name: 'approvals', arg: 'smart' })
    expect(approvalModeToCommand('yolo')).toEqual({ name: 'approvals', arg: 'off' })
  })
})

describe('HermesServeClient frame robustness', () => {
  it('ignores malformed frames without dropping the connection', async () => {
    const client = await connectClient()
    socket.emitMessage('this is not json{{{')
    socket.emitMessage(JSON.stringify({ bogus: true }))
    // A well-formed request/response still round-trips afterwards.
    const p = client.request('session.list', { limit: 1 })
    const frame = socket.lastSent()!
    socket.emitMessage(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { sessions: [] } }))
    await expect(p).resolves.toEqual({ sessions: [] })
    client.close()
  })

  it('ignores a response for an unknown id (stale/duplicate frame)', async () => {
    const client = await connectClient()
    socket.emitMessage(JSON.stringify({ jsonrpc: '2.0', id: 'w9999', result: { sessions: [] } }))
    const p = client.request('session.list')
    const frame = socket.lastSent()!
    socket.emitMessage(
      JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { sessions: ['s1'] } }),
    )
    await expect(p).resolves.toEqual({ sessions: ['s1'] })
    client.close()
  })

  it('never leaks the token into error surfaces (redacted)', async () => {
    const secret = 'super-secret-token-xyz'
    const client = new HermesServeClient({
      baseUrl: 'http://127.0.0.1:9119',
      token: secret,
      requestTimeoutMs: 20,
    })
    const p = client.connect()
    socket = FakeWebSocket.instances[0]!
    socket.emitOpen()
    await p
    const req = client.request('session.list')
    const assertion = expect(req).rejects.toSatisfy(
      (err: Error) => !String(err?.message).includes(secret),
      'timeout error must not contain the token',
    )
    await new Promise((r) => setTimeout(r, 40))
    await assertion
    client.close()
  })

  it('assigns deterministic sequential ids (no Date.now randomness)', async () => {
    const client = await connectClient()
    client.request('a.first').catch(() => {})
    client.request('a.second').catch(() => {})
    const ids = socket.sendFrames.map((raw) => (JSON.parse(raw) as { id: string }).id)
    expect(ids).toEqual(['w1', 'w2'])
    client.close()
  })
})
