import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

describe('development Hermes home boot wiring', () => {
  it.each([false, true])('uses one home for settings, with packaged=%s', async isPackaged => {
    const app = Object.assign(new EventEmitter(), { isPackaged })
    const home = '/tmp/obviously-fake-isolated-hermes'
    const createHostConfig = vi.fn(() => ({ getConfig: () => ({ workspace: { enabledProfiles: [] } }) }))
    const client = { setSecureRequestHandler: () => () => {} }
    const host = { getServeClient: () => client, onStatus: () => () => {},
      setControllerStatus() {}, start: async () => {} }
    const module = { exports: {} }
    vm.runInNewContext(readFileSync(new URL('./boot.cjs', import.meta.url), 'utf8'), {
      module, console: { warn() {} }, require(name) {
        if (name === './hermes-host.cjs') return { createHermesHost: () => host }
        if (name === './host-config.cjs') return { createHostConfig }
        if (name === '../hud-activity-relay.cjs') return { workspaceActivity: () => null }
        if (name.startsWith('node:')) return require(name)
        throw new Error('Optional producer unavailable in the boot fixture')
      },
    })
    await module.exports({ app, userDataDir: '/tmp/obviously-fake-data',
      hostDeps: { env: { HERMES_DESK_HERMES_HOME: home } },
      getMainWindow: () => null, ipcHandle() {} }).ready
    expect(createHostConfig.mock.calls[0][0].hermesHome).toBe(isPackaged ? path.join(os.homedir(), '.hermes') : home)
  })
})
