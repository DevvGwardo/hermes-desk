import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
const require = createRequire(import.meta.url)
const { createControllerBridge } = require('./controller-bridge.cjs')

describe('honest upstream controller failures', () => {
  it('never registers or heartbeats without the single default-off configuration flag', async () => {
    const serveClient = { connected: true, call: vi.fn(), onEvent: () => vi.fn(), onConnection: () => vi.fn() }
    const bridge = createControllerBridge({ serveClient, lanes: { ensureLane: vi.fn() }, installId: 'fake-install' })
    await expect(bridge.registerForSession('fake-runtime', 'scout')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(bridge.status()).toBe('off')
    expect(serveClient.call).not.toHaveBeenCalled()
    await bridge.dispose()
  })
  it('finishes failed registration in error with a precise safe detail and no identity workaround', async () => {
    const serveClient = { connected: true, call: vi.fn(async () => {
      throw Object.assign(new Error('browser.controller.register requires an authenticated non-internal identity OBVIOUSLY_FAKE_SECRET'), { code: 4403 })
    }), onEvent: () => vi.fn(), onConnection: () => vi.fn() }
    const bridge = createControllerBridge({ serveClient, lanes: { ensureLane: vi.fn() }, installId: 'fake-install',
      getWorkspaceConfig: () => ({ nativeControllerEnabled: true }) })
    const status = vi.fn()
    bridge.onStatus(status)
    await expect(bridge.registerForSession('fake-runtime', 'scout')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(bridge.status()).toBe('error')
    expect(bridge.detail()).toContain('4403')
    expect(bridge.detail()).toContain('Upstream authentication')
    expect(bridge.detail()).not.toContain('OBVIOUSLY_FAKE_SECRET')
    expect(status).toHaveBeenLastCalledWith('error', bridge.detail())
    expect(serveClient.call).toHaveBeenCalledOnce()
    expect(serveClient.call.mock.calls[0][1]).not.toHaveProperty('principal_id')
    await bridge.dispose()
  })
  it('fails offline registration rather than reporting a successful or endless connecting state', async () => {
    const serveClient = { connected: false, call: vi.fn(), onEvent: () => vi.fn(), onConnection: () => vi.fn() }
    const bridge = createControllerBridge({ serveClient, lanes: { ensureLane: vi.fn() }, installId: 'fake-install',
      getWorkspaceConfig: () => ({ nativeControllerEnabled: true }) })
    await expect(bridge.registerForSession('fake-runtime', 'scout')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(bridge.status()).toBe('error')
    expect(bridge.detail()).toContain('connected renderer socket')
    expect(serveClient.call).not.toHaveBeenCalled()
    await bridge.dispose()
  })
})
