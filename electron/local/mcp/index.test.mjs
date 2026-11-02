import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { EventEmitter, once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerMcp, electronBinary } from './index.cjs'
import { planEnable, apply } from './config-writer.cjs'
import { createProfileTokens } from './profile-tokens.cjs'
import { createHostConfig } from '../host-config.cjs'

const appPath = fileURLToPath(new URL('../../../', import.meta.url))
const cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(options = {}, provision = true) {
  const userDataDir = await fs.realpath(await fs.mkdtemp('/tmp/hd-mcp-main-'))
  cleanups.push(() => fs.rm(userDataDir, { recursive: true, force: true }))
  const lanes = new EventEmitter()
  const tab = { id: 't_1', laneId: 'profile:alpha', url: 'https://example.invalid', title: 'Fixture' }
  const wc = new EventEmitter()
  const debuggerApi = new EventEmitter()
  let attached = false
  debuggerApi.isAttached = () => attached
  debuggerApi.attach = vi.fn(() => { attached = true })
  debuggerApi.detach = vi.fn(() => { attached = false })
  debuggerApi.sendCommand = vi.fn(async (method) => {
    const replies = {
      'Accessibility.getFullAXTree': { nodes: [
        { nodeId: '1', backendDOMNodeId: 1, role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'OBVIOUSLY_FAKE_PASSWORD' } },
      ] },
      'DOM.getDocument': { root: { nodeName: 'HTML', backendNodeId: 100, children: [] } },
      'DOM.describeNode': { node: { nodeName: 'INPUT', attributes: ['type', 'password'] } },
      'DOM.getBoxModel': { model: { border: [0, 0, 1, 0, 1, 1, 0, 1] } },
      'Page.getLayoutMetrics': { cssLayoutViewport: { clientWidth: 2, clientHeight: 2 } },
      'Page.captureScreenshot': { data: Buffer.from('FAKE_RAW_PIXELS').toString('base64') },
    }
    return replies[method] || {}
  })
  Object.assign(wc, { debugger: debuggerApi, isDestroyed: () => false,
    getURL: () => tab.url, getTitle: () => tab.title, setBackgroundThrottling: vi.fn(),
    getBackgroundThrottling: () => true })
  tab.webContents = wc
  tab.ensureLive = async () => wc
  Object.assign(lanes, {
    ensureLane: () => ({ id: tab.laneId }), getActiveTab: () => tab,
    getTab: (id) => id === tab.id ? tab : null, listTabs: () => [tab],
    isPaused: () => false, setTabState: vi.fn(),
  })
  const redactor = {
    scrubText: (text) => text.replaceAll('OBVIOUSLY_FAKE_PASSWORD', '[secret]'),
    redactNodes: (nodes) => nodes.map((node) => ({ ...node, sensitive: true, value: undefined })),
    isSensitiveNode: () => true,
    renderSnapshot: (nodes) => nodes.map((node) => `[ref=${node.ref}] ${node.role} "${node.name}" (sensitive, value hidden)`).join('\n'),
  }
  const jpeg = Buffer.from('FAKE_MASKED_JPEG').toString('base64')
  const nativeImage = {
    createFromBuffer: () => ({ getSize: () => ({ width: 2, height: 2 }), toBitmap: () => Buffer.alloc(16, 255) }),
    createFromBitmap: () => ({ toJPEG: () => Buffer.from(jpeg, 'base64') }),
  }
  const audit = { log: vi.fn() }
  const mcp = registerMcp({ userDataDir, appPath, lanes, redactor, nativeImage, audit,
    urlPolicy: { check: (url) => ({ ok: true, url }) },
    overlay: { send: vi.fn(), waitFrame: async () => {} }, securePrompt: {},
    getConfig: () => ({ workspace: { enabledProfiles: ['alpha'] } }), ...options })
  cleanups.push(mcp.dispose)
  const hermesHome = path.join(userDataDir, 'fixture-hermes')
  await fs.mkdir(path.join(hermesHome, 'profiles/alpha'), { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(hermesHome, 'profiles/alpha/config.yaml'), 'model: obviously-fake\n')
  const entry = mcp.configEntryFor('alpha')
  if (provision) apply(planEnable({ hermesHome, profile: 'alpha', entry }))
  return { mcp, lanes, debuggerApi, audit, jpeg, userDataDir, hermesHome, token: entry.env.HERMES_DESK_MCP_TOKEN }
}

async function request(socketPath, frame, token) {
  const client = net.createConnection(socketPath)
  cleanups.push(() => client.destroy())
  await once(client, 'connect')
  const result = new Promise((resolve, reject) => {
    let line = ''
    client.on('error', reject)
    client.on('data', (data) => {
      line += data.toString()
      if (line.includes('\n')) {
        const reply = JSON.parse(line.slice(0, line.indexOf('\n')))
        line = line.slice(line.indexOf('\n') + 1)
        if (reply.id === 'admission' && reply.result) client.write(`${JSON.stringify(frame)}\n`)
        else {
          client.end()
          resolve(reply)
        }
      }
    })
  })
  client.write(`${JSON.stringify(token ? { id: 'admission', method: 'hello',
    params: { profile: frame.params.profile, token, pid: 123, shimVersion: '1.0.0' } } : frame)}\n`)
  return result
}

describe('MCP main registration', () => {
  it('cancels active lane work directly without steering, while physical takeover still steers', async () => {
    const serveClient = { call: vi.fn(async () => ({})) }
    const run = vi.fn((_tab, _name, _args, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const f = await fixture({ serveClient, getSessionForProfile: () => 'fake-runtime',
      createExecutor: () => ({ run, dispose: vi.fn() }) })
    await vi.waitFor(() => expect(f.mcp.status().state).toBe('ready'))
    const pending = request(f.mcp.status().socketPath, { id: 1, method: 'tools/call',
      params: { profile: 'alpha', name: 'browser_snapshot', arguments: {}, callId: 'stop-active' } }, f.token)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    f.mcp.cancelLane('profile:alpha', 'user_took_control')
    expect((await pending).result).toMatchObject({ isError: true,
      content: [{ type: 'text', text: expect.stringMatching(/^user_took_control:/) }] })
    expect(serveClient.call).not.toHaveBeenCalled()
    f.lanes.emit('user-input', { laneId: 'profile:alpha', tabId: 't_1' })
    await vi.waitFor(() => expect(serveClient.call).toHaveBeenCalledExactlyOnceWith('session.steer', {
      session_id: 'fake-runtime', text: expect.stringContaining('User took control of tab t_1'),
    }))
  })

  it('reports ready/off status and routes a real socket through the real CDP executor and redactor', async () => {
    const f = await fixture()
    const statuses = []
    const unsubscribe = f.mcp.onStatus((status) => statuses.push(status))
    if (f.mcp.status().state === 'ready') statuses.push(f.mcp.status())
    await vi.waitFor(() => expect(f.mcp.status().state).toBe('ready'))
    const call = (id, name) => ({ id, method: 'tools/call', params: { profile: 'alpha', name, arguments: {}, callId: `c-${id}` } })
    const snapshot = await request(f.mcp.status().socketPath, call(1, 'browser_snapshot'), f.token)
    expect(snapshot.result).toEqual({ content: [{ type: 'text', text: '[ref=e1] textbox "Password" (sensitive, value hidden)' }] })
    expect(JSON.stringify(snapshot)).not.toContain('OBVIOUSLY_FAKE_PASSWORD')
    const screenshot = await request(f.mcp.status().socketPath, call(2, 'browser_screenshot'), f.token)
    expect(screenshot.result).toEqual({ content: [{ type: 'image', data: f.jpeg, mimeType: 'image/jpeg' }] })
    expect(f.debuggerApi.attach).toHaveBeenCalledWith('1.3')
    expect(f.audit.log).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(f.audit.log.mock.calls)).not.toContain('Password')
    await f.mcp.dispose()
    expect(f.mcp.status().state).toBe('off')
    expect(statuses.map((status) => status.state)).toEqual(['ready', 'off'])
    expect(f.debuggerApi.detach).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('resolves the dev Electron package binary and points at the worker-owned shim', async () => {
    const f = await fixture()
    const entry = f.mcp.configEntryFor('alpha')
    expect(entry).toEqual({
      command: electronBinary(appPath),
      args: [path.join(appPath, 'electron/local/mcp/shim/hermes-desk-mcp.cjs'), '--profile', 'alpha', '--socket', f.mcp.status().socketPath],
      env: { ELECTRON_RUN_AS_NODE: '1', HERMES_DESK_MCP_TOKEN: expect.stringMatching(/^[a-f0-9]{64}$/) }, tools: {},
    })
    expect(path.isAbsolute(entry.command)).toBe(true)
    expect(entry.command).not.toBe(process.execPath)
    expect((await fs.stat(entry.command)).isFile()).toBe(true)
    expect(() => f.mcp.configEntryFor('../alpha')).toThrow('Invalid Hermes profile')
  })

  it('audits disabled-profile and malformed tool rejections before CDP execution', async () => {
    const f = await fixture()
    await vi.waitFor(() => expect(f.mcp.status().state).toBe('ready'))
    const blocked = await request(f.mcp.status().socketPath, { id: 1, method: 'tools/call',
      params: { profile: 'disabled', name: 'browser_back', arguments: {}, callId: 'disabled-call' } })
    expect(blocked.result.content[0].text).toMatch(/^blocked_by_policy:/)
    expect(f.audit.log).toHaveBeenCalledWith(expect.objectContaining({ agent: 'disabled', result: 'blocked_by_policy' }))
    const malformed = await request(f.mcp.status().socketPath, { id: 2, method: 'tools/call', params: null })
    expect(malformed.result.content[0].text).toMatch(/^bad_args:/)
    expect(f.audit.log).toHaveBeenCalledTimes(2)
    expect(f.debuggerApi.attach).not.toHaveBeenCalled()
  })

  it('uses the packaged executable with the unpacked shim path and empty tools map', async () => {
    const f = await fixture({ isPackaged: true, resourcesPath: '/tmp/fixture-Hermes-Desk.app/Contents/Resources' })
    expect(f.mcp.configEntryFor('alpha')).toEqual({
      command: process.execPath,
      args: ['/tmp/fixture-Hermes-Desk.app/Contents/Resources/app.asar.unpacked/electron/local/mcp/shim/hermes-desk-mcp.cjs',
        '--profile', 'alpha', '--socket', f.mcp.status().socketPath],
      env: { ELECTRON_RUN_AS_NODE: '1', HERMES_DESK_MCP_TOKEN: expect.stringMatching(/^[a-f0-9]{64}$/) }, tools: {},
    })
  })

  it('reports startup errors without removing a conflicting fixture file', async () => {
    const dir = await fs.mkdtemp('/tmp/hd-mcp-error-')
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
    await fs.mkdir(path.join(dir, 'mcp'))
    await fs.writeFile(path.join(dir, 'mcp/hermes-desk.sock'), 'fixture file')
    const f = await fixture({ userDataDir: dir }, false)
    await vi.waitFor(() => expect(f.mcp.status().state).toBe('error'))
    expect(f.mcp.status().detail).toContain('could not start')
    await f.mcp.dispose()
    expect(await fs.readFile(path.join(dir, 'mcp/hermes-desk.sock'), 'utf8')).toBe('fixture file')
  })

  it('allows immediate and repeated dispose without reporting ready after shutdown', async () => {
    const f = await fixture()
    const statuses = []
    f.mcp.onStatus((status) => statuses.push(status.state))
    const first = f.mcp.dispose()
    expect(f.mcp.dispose()).toBe(first)
    await first
    expect(statuses).toEqual(['off'])
    expect(f.lanes.listenerCount('user-input')).toBe(0)
    await expect(fs.lstat(f.mcp.status().socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('HD-06 confirms and backs up real host-config changes before granting, rotating or revoking token authority', async () => {
    let config
    const f = await fixture({ getConfig: () => config?.getAppConfig() }, false)
    await vi.waitFor(() => expect(f.mcp.status().state).toBe('ready'))
    const tokens = createProfileTokens(path.join(f.userDataDir, 'mcp'))
    const entries = []
    const dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) }
    config = createHostConfig({ userDataDir: f.userDataDir, hermesHome: f.hermesHome, dialog,
      getEntry: (profile) => {
        const entry = f.mcp.configEntryFor(profile)
        entries.push(entry)
        return entry
      } })
    const preview = await config.enableBrowserControl(['alpha'])
    expect(preview.cancelled).toBe(true)
    expect(tokens.verify('alpha', entries[0].env.HERMES_DESK_MCP_TOKEN)).toBe(false)
    expect(config.getAppConfig().workspace.enabledProfiles).toEqual([])
    dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const enabled = await config.enableBrowserControl(['alpha'])
    const first = entries[1].env.HERMES_DESK_MCP_TOKEN
    expect(enabled.ok).toBe(true)
    expect(enabled.backups).toHaveLength(1)
    expect(enabled.diff).not.toContain(first)
    expect(tokens.verify('alpha', first)).toBe(true)
    expect((await fs.stat(enabled.backupPath)).mode & 0o777).toBe(0o600)
    const call = { id: 1, method: 'tools/call', params: { profile: 'alpha',
      name: 'browser_snapshot', arguments: {}, callId: 'fixture-call' } }
    expect((await request(f.mcp.status().socketPath, call, first)).result.isError).toBeUndefined()
    const rotated = await config.enableBrowserControl(['alpha'])
    const second = entries[2].env.HERMES_DESK_MCP_TOKEN
    expect(rotated.ok).toBe(true)
    expect(second).not.toBe(first)
    expect(tokens.verify('alpha', first)).toBe(false)
    expect(tokens.verify('alpha', second)).toBe(true)
    expect((await request(f.mcp.status().socketPath, call, first)).error.code).toBe('blocked_by_policy')
    expect((await request(f.mcp.status().socketPath, call, second)).result.isError).toBeUndefined()
    expect((await config.disableBrowserControl(['alpha'])).ok).toBe(true)
    expect(tokens.verify('alpha', second)).toBe(false)
    expect(config.getAppConfig().workspace.enabledProfiles).toEqual([])
    expect(await fs.readFile(path.join(f.hermesHome, 'profiles/alpha/config.yaml'), 'utf8')).not.toContain(second)
  })
})
