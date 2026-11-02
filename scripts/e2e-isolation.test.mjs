import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isolatedEnvironment, sandboxPolicy } from '../tests/e2e/harness.mjs'

const require = createRequire(import.meta.url)
const { resolveHermesHome, createHermesHost } = require('../electron/local/hermes-host.cjs')

describe('E2E isolation hooks', () => {
  it('only honors absolute home overrides in an unpackaged app', () => {
    const env = { HERMES_DESK_HERMES_HOME: '/tmp/obviously-fake-hermes-home' }
    expect(resolveHermesHome({ app: { isPackaged: false } }, env)).toBe(env.HERMES_DESK_HERMES_HOME)
    expect(resolveHermesHome({ app: { isPackaged: true }, isPackaged: false }, env))
      .toBe(path.join(os.homedir(), '.hermes'))
    expect(resolveHermesHome({}, env)).toBe(path.join(os.homedir(), '.hermes'))
    expect(() => resolveHermesHome({ isPackaged: false }, { HERMES_DESK_HERMES_HOME: 'relative' }))
      .toThrow('absolute')
  })

  it('uses the override for spawn without reading external tokens, and disables only the test gateway probe', async () => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    const health = vi.fn(async () => ({ state: 'down' }))
    const spawn = vi.fn(() => child), readToken = vi.fn(async () => ({ token: '', source: 'none' }))
    const home = '/tmp/obviously-fake-e2e-home'
    const host = createHermesHost({ app: { isPackaged: false }, hostDeps: {
      env: { HERMES_DESK_HERMES_HOME: home, HERMES_DESK_E2E: '1', HERMES_DISABLE_LAZY_INSTALLS: '1' },
      createGatewayClient: () => ({ health }), createServeClient: () => ({
        onConnection() {}, setEndpoint() {}, stop() {},
      }),
      discoverHermes: () => '/fake/hermes', freeServePort: async () => 9128,
      randomToken: () => 'obviously-fake-e2e-token', readToken,
      probeServe: async () => ({}), spawn, kill: () => child.emit('exit'),
    } })
    try {
      await host.start()
      expect(readToken).not.toHaveBeenCalled()
      expect(spawn.mock.calls[0][2].env).toMatchObject({ HERMES_HOME: home, HERMES_DISABLE_LAZY_INSTALLS: '1',
        HERMES_DASHBOARD_SESSION_TOKEN: 'obviously-fake-e2e-token' })
      expect(health).not.toHaveBeenCalled()
    } finally { await host.stop() }
  })

  it('constructs an allowlisted environment and denies real state writes and reserved binds', () => {
    const env = isolatedEnvironment('/tmp/hd-fixture', '/Users/fake/.hermes/hermes-agent')
    expect(env.HOME).toBe('/tmp/hd-fixture')
    expect(env.HERMES_HOME).toBe(env.HERMES_DESK_HERMES_HOME)
    expect(env.HERMES_DISABLE_LAZY_INSTALLS).toBe('1')
    expect(Object.keys(env).some(key => /KEY|TOKEN|PASSWORD|AUTH_SOCK/.test(key))).toBe(false)
    const policy = sandboxPolicy(env.HOME, '/Users/fake/.hermes/hermes-agent')
    expect(policy).toContain('(deny file-write* (subpath "/Users/fake/.hermes"))')
    expect(policy).toContain('(deny network-outbound (remote ip "*:*"))')
    expect(policy).toContain('localhost:8642')
    expect(policy).toContain('localhost:9119')
  })
})
