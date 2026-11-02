import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createHermesHost } = require('./hermes-host.cjs')
const { computerStatus } = require('./computer-status.cjs')
const cleanups = []
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()()
  vi.useRealTimers()
})

function fixture(computerRequest = vi.fn(async () => ({ ready: true })), env = {}) {
  let connection
  const children = []
  const client = {
    setEndpoint: vi.fn(), stop: vi.fn(),
    onConnection: (callback) => { connection = callback },
  }
  const host = createHermesHost({
    isPackaged: false,
    serveAuth: { computerRequest, setEndpoint: vi.fn(), clearEndpoint: vi.fn() },
    hostDeps: {
      env, discoverHermes: () => '/fake/bin/hermes', freeServePort: async () => 9127,
      randomToken: () => 'obviously-fake-launch-token', probeServe: async () => ({ version: 'fake-version' }),
      createServeClient: () => client,
      createGatewayClient: () => ({ health: async () => ({ state: 'down' }) }),
      spawn: () => {
        const child = Object.assign(new EventEmitter(), { pid: 999999, stderr: new EventEmitter() })
        children.push(child)
        return child
      },
      kill: (child) => child.emit('exit', 0),
    },
  })
  cleanups.push(() => host.stop())
  return { host, computerRequest, children, connection: (up) => connection(up) }
}

describe('computer readiness mapping', () => {
  it.each([
    [{ ready: true }, 'available', 'ready'],
    [{ installed: false }, 'unavailable', 'not installed'],
    [{ platform_supported: false }, 'unavailable', 'not supported'],
    [{ ready: false, accessibility: false, screen_recording: true }, 'unavailable', 'Accessibility permission'],
    [{ ready: false, accessibility: true, screen_recording: false }, 'unavailable', 'Screen Recording permission'],
    [{ accessibility: false, screen_recording: false }, 'unavailable', 'Accessibility and Screen Recording'],
    [{ platform: 'linux', ready: false }, 'unavailable', 'not ready'],
    [{ platform: 'darwin', ready: false, accessibility: null, screen_recording: null }, 'unknown', 'unverified'],
    [{ platform: 'darwin', ready: false, accessibility: true, screen_recording: null }, 'unknown', 'unverified'],
    [{ error: 'obviously-fake-private-diagnostics' }, 'unknown', 'could not be verified'],
    [null, 'unknown', 'could not be verified'],
    [{}, 'unknown', 'could not be verified'],
  ])('maps %j to %s without publishing raw diagnostics', (result, computerUse, detail) => {
    const status = computerStatus(result)
    expect(status.computerUse).toBe(computerUse)
    expect(status.computerUseDetail).toContain(detail)
    expect(JSON.stringify(status)).not.toContain('obviously-fake-private-diagnostics')
  })
})

describe('host Computer connector', () => {
  it('checks readiness without opening a preview and refreshes permission changes', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const updates = []
    f.host.onStatus(status => updates.push(status))
    expect(f.host.status().computerUse).toBe('unknown')
    expect(f.computerRequest).not.toHaveBeenCalled()
    await f.host.start()
    await flush()
    expect(f.computerRequest).toHaveBeenCalledExactlyOnceWith('/api/tools/computer-use/status?profile=default')
    expect(f.host.status()).toMatchObject({ computerUse: 'available', computerUseDetail: 'Computer use is ready.' })
    expect(updates.at(-1).computerUse).toBe('available')
    f.computerRequest.mockResolvedValue({ ready: false, accessibility: true, screen_recording: false })
    await vi.advanceTimersByTimeAsync(14999)
    expect(f.computerRequest).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.computerRequest).toHaveBeenCalledTimes(2)
    expect(f.host.status()).toMatchObject({
      computerUse: 'unavailable', computerUseDetail: expect.stringContaining('Screen Recording'),
    })
    await f.host.stop()
    expect(f.host.status().computerUse).toBe('unknown')
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.computerRequest).toHaveBeenCalledTimes(2)
  })

  it('recovers from a failed readiness check without exposing errors', async () => {
    vi.useFakeTimers()
    const f = fixture(vi.fn().mockRejectedValueOnce(new Error('obviously-fake-private-error')).mockResolvedValue({ ready: true }))
    await f.host.start()
    await flush()
    expect(f.host.status().computerUse).toBe('unknown')
    expect(JSON.stringify(f.host.status())).not.toContain('obviously-fake-private-error')
    await vi.advanceTimersByTimeAsync(15000)
    expect(f.host.status().computerUse).toBe('available')
  })

  it('ignores a pending response after disconnect and rechecks immediately on reconnect', async () => {
    vi.useFakeTimers()
    let finish
    const f = fixture(vi.fn(() => new Promise(resolve => { finish = resolve })))
    await f.host.start()
    f.connection(false)
    f.computerRequest.mockResolvedValue({ ready: false, installed: false })
    f.connection(true)
    await flush()
    expect(f.host.status().computerUse).toBe('unavailable')
    finish({ ready: true })
    await flush()
    expect(f.host.status().computerUse).toBe('unavailable')
    expect(f.computerRequest).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(15000)
    expect(f.computerRequest).toHaveBeenCalledTimes(3)
  })

  it('ignores a previous backend response after restart', async () => {
    vi.useFakeTimers()
    let finish
    const f = fixture(vi.fn(() => new Promise(resolve => { finish = resolve })))
    await f.host.start()
    f.computerRequest.mockResolvedValue({ ready: false, installed: false })
    await f.host.restartServe()
    await flush()
    finish({ ready: true })
    await flush()
    expect(f.host.status().computerUse).toBe('unavailable')
    expect(f.children).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(15000)
    expect(f.computerRequest).toHaveBeenCalledTimes(3)
  })

  it('does not schedule polling or publish a late response after stop', async () => {
    vi.useFakeTimers()
    let finish
    const f = fixture(vi.fn(() => new Promise(resolve => { finish = resolve })))
    await f.host.start()
    await f.host.stop()
    finish({ ready: true })
    await flush()
    expect(f.host.status().computerUse).toBe('unknown')
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.computerRequest).toHaveBeenCalledTimes(1)
  })

  it('clears ready state after a crash and checks the replacement backend', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.host.start()
    await flush()
    expect(f.host.status().computerUse).toBe('available')
    f.children[0].emit('exit', 1)
    expect(f.host.status().computerUse).toBe('unknown')
    f.computerRequest.mockResolvedValue({ installed: false })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.host.status().computerUse).toBe('unavailable')
    expect(f.computerRequest).toHaveBeenCalledTimes(2)
  })

  it('does not probe the real computer driver during isolated E2E', async () => {
    vi.useFakeTimers()
    const f = fixture(vi.fn(), { HERMES_DESK_E2E: '1' })
    await f.host.start()
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.computerRequest).not.toHaveBeenCalled()
    expect(f.host.status()).toMatchObject({
      computerUse: 'unknown', computerUseDetail: expect.stringContaining('isolated E2E'),
    })
  })
})
