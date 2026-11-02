import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalGatewayConnection } from './local-gateway-connection'

const fixture = vi.hoisted(() => ({
  clients: [] as { connectionState: string; connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>;
    state: (value: string) => void }[],
  resolve: vi.fn(),
}))
vi.mock('../hermes-serve', () => ({
  resolveServeConnection: fixture.resolve,
  HermesServeClient: class {
    connectionState = 'closed'
    state = (_: string) => {}
    connect = vi.fn(async () => { await Promise.resolve(); this.connectionState = 'open'; this.state('open') })
    close = vi.fn()
    constructor() { fixture.clients.push(this) }
    onAny() { return vi.fn() }
    onRequest() { return vi.fn() }
    onState(callback: (value: string) => void) { this.state = callback; return vi.fn() }
  },
}))

afterEach(() => { fixture.clients.length = 0; fixture.resolve.mockReset(); vi.useRealTimers() })

function callbacks() {
  return { event: vi.fn(), request: vi.fn(), connection: vi.fn(), reconnect: vi.fn(async () => {}) }
}

describe('local gateway connection', () => {
  it('shares a pending connection and replays only on a subsequent open', async () => {
    const hooks = callbacks()
    const gateway = new LocalGatewayConnection({ baseUrl: 'http://127.0.0.1:9120' }, hooks)
    try {
      const first = gateway.ensureClient()
      expect(gateway.ensureClient()).toBe(first)
      await first
      expect(hooks.reconnect).not.toHaveBeenCalled()
      expect(gateway.readOnly).toBe(false)
      fixture.clients[0]!.state('open')
      expect(hooks.reconnect).toHaveBeenCalledOnce()
    } finally { gateway.dispose() }
    expect(fixture.clients[0]!.close).toHaveBeenCalledOnce()
  })

  it('rejects non-loopback hosts before constructing a client', async () => {
    vi.useFakeTimers()
    const gateway = new LocalGatewayConnection({ baseUrl: 'https://example.com' }, callbacks())
    try {
      await expect(gateway.ensureClient()).rejects.toThrow('offline')
      expect(fixture.clients).toEqual([])
    } finally { gateway.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fences late configuration resolution after disposal', async () => {
    let resolve!: (value: unknown) => void
    fixture.resolve.mockReturnValue(new Promise(r => { resolve = r }))
    const gateway = new LocalGatewayConnection({}, callbacks())
    const connecting = gateway.ensureClient()
    gateway.dispose()
    resolve({ baseUrl: 'http://127.0.0.1:9120', token: '' })
    await expect(connecting).rejects.toThrow('disposed')
    expect(fixture.clients).toEqual([])
    await expect(gateway.ensureClient()).rejects.toThrow('disposed')
  })
})
