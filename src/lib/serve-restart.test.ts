import { afterEach, describe, expect, it, vi } from 'vitest'
import { openServeSocket, SOCKET_CLOSED, SOCKET_OPEN } from './serve-bridge'
import { HermesServeClient } from './hermes-serve'
import type { HostStatus } from './desktop-bridge'
afterEach(() => { delete window.nubAgent })
describe('endpoint changes through the main-only socket relay', () => {
  it('closes the old socket on restart and reconnects the same client against the fresh endpoint without a token or native socket', async () => {
    let port = 9188
    const hostListeners = new Set<(status: HostStatus) => void>()
    const listeners = new Set<(event: { id: string; type: 'open' | 'close' }) => void>()
    const endpoints: number[] = []
    const relay = {
      open: vi.fn(async (_args: { id: string; path: string }) => { endpoints.push(port); return { ok: true } }),
      onEvent: (callback: (event: { id: string; type: 'open' | 'close' }) => void) => {
        listeners.add(callback); return () => listeners.delete(callback)
      },
      send: vi.fn(async () => ({ ok: true })), close: vi.fn(async () => ({ ok: true })),
    }
    window.nubAgent = { serveSocket: relay, serveConfig: vi.fn(async () => ({
      present: true, baseUrl: `http://127.0.0.1:${port}`, tokenSource: 'file',
    })), host: { onStatus: (callback: (status: HostStatus) => void) => {
      hostListeners.add(callback); return () => hostListeners.delete(callback)
    } } } as unknown as Window['nubAgent']
    const client = new HermesServeClient({ baseUrl: 'http://127.0.0.1:9188', token: '' })
    const pushOpen = () => { for (const callback of listeners) callback({ id: relay.open.mock.calls.at(-1)![0].id, type: 'open' }) }
    let connect = client.connect()
    await vi.waitFor(() => expect(endpoints).toEqual([9188]))
    pushOpen(); await connect
    const restarting = { serve: { state: 'starting' }, gateway: { state: 'up' }, controller: 'ready' } as HostStatus
    for (const callback of [...hostListeners]) callback(restarting)
    expect(client.connectionState).toBe('closed')
    port = 9189
    connect = client.connect()
    await vi.waitFor(() => expect(endpoints).toEqual([9188, 9189]))
    pushOpen(); await connect
    for (const callback of [...hostListeners]) callback({ ...restarting, serve: { state: 'up', port } })
    expect(client.connectionState).toBe('open')
    expect(JSON.stringify(relay.open.mock.calls)).not.toContain('token')
    client.close()
  })
  it('ignores late events after the host invalidates a pending connection', async () => {
    const events: Array<(event: { id: string; type: 'open' }) => void> = []
    let changed: (status: HostStatus) => void = () => {}
    const open = vi.fn(async (_args: { id: string }) => ({ ok: true }))
    window.nubAgent = { serveSocket: { open, send: async () => ({ ok: true }), close: async () => ({ ok: true }),
      onEvent: (cb: typeof events[number]) => { events.push(cb); return () => {} } },
      host: { onStatus: (cb: typeof changed) => { changed = cb; return () => {} } },
    } as unknown as Window['nubAgent']
    const socket = openServeSocket({ baseUrl: 'http://127.0.0.1:9188', token: '' }, '/api/ws')
    await vi.waitFor(() => expect(open).toHaveBeenCalled())
    expect(socket.readyState).not.toBe(SOCKET_OPEN)
    changed({ serve: { state: 'down' } } as HostStatus)
    events[0]({ id: open.mock.calls[0][0].id, type: 'open' })
    expect(socket.readyState).toBe(SOCKET_CLOSED)
  })
})
