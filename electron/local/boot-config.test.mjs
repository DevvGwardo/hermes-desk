import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const configModule = require('./host-config.cjs')
const { createDispatch } = require('./mcp/dispatch.cjs')
const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })

function fixture({ secretsOp, requestFill } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hd-boot-settings-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const userDataDir = path.join(root, 'app'), hermesHome = path.join(root, 'hermes')
  mkdirSync(userDataDir); mkdirSync(hermesHome)
  for (const profile of ['alpha', 'beta']) {
    const dir = path.join(hermesHome, 'profiles', profile)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'config.yaml'), 'model: fake-model\nmcp_servers: {}\n')
  }
  const app = Object.assign(new EventEmitter(), { isPackaged: false, exit: vi.fn() })
  const main = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const handlers = new Map(), sessions = new Map()
  const client = { setSecureRequestHandler: () => () => {}, hasSession: vi.fn(() => true),
    call: vi.fn(async () => ({ profiles: [] })) }
  let hostContext, workspaceContext, pipContext, mcpContext, attachmentContext, dispatch
  const host = { getServeClient: () => client, onStatus: () => () => {}, start: async () => {}, stop: async () => {},
    setControllerStatus() {} }
  const prompt = { requestFill: requestFill || vi.fn(async () => ({ ok: false })) }
  const lanes = Object.assign(new EventEmitter(), { allLanes: () => [] })
  const ws = { lanes, parts: { lanes, redactor: {}, securePrompt: {}, urlPolicy: {}, audit: {} },
    getSessionForProfile: (profile) => sessions.get(profile) || null, dispose: async () => {} }
  const mcp = {
    configEntryFor: vi.fn((profile) => ({
      command: process.execPath, args: ['/tmp/obviously-fake-shim.cjs', '--profile', profile, '--socket', path.join(root, 'fake.sock')],
      env: { ELECTRON_RUN_AS_NODE: '1' }, tools: {},
    })),
    status: () => ({ state: 'ready' }), onStatus: () => () => {}, dispose: async () => dispatch?.dispose(),
  }
  const modules = {
    './hermes-host.cjs': { createHermesHost: (ctx) => { hostContext = ctx; return host } },
    './host-config.cjs': configModule,
    './workspace/secure-prompt.cjs': { createSecurePrompt: () => prompt },
    './workspace/index.cjs': { registerWorkspace: (ctx) => {
      workspaceContext = ctx
      ctx.ipcHandle('hd:ws:registerSession', (_event, registration) => sessions.set(registration.profile, registration.runtimeId))
      return ws
    } },
    './mcp/index.cjs': { registerMcp: (ctx) => {
      mcpContext = ctx
      dispatch = createDispatch({ ...ctx, createExecutor: () => ({ dispose() {} }) })
      return mcp
    } },
    './computer-pip.cjs': { registerComputerPip: (ctx) => { pipContext = ctx; return { dispose: async () => {} } } },
    './attachments.cjs': { registerAttachments: (ctx) => { attachmentContext = ctx; return { dispose: async () => {} } } },
  }
  const module = { exports: {} }
  runInNewContext(readFileSync(require.resolve('./boot.cjs'), 'utf8'), { module, console, URL,
    require: (name) => modules[name] || require(name) })
  const computerRequest = vi.fn(async () => ({ ready: true }))
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) }
  const boot = module.exports({ app, hermesHome, userDataDir, dialog, secretsOp, getMainWindow: () => main,
    serveAuth: { computerRequest }, ipcHandle: (name, handler) => handlers.set(name, handler) })
  cleanups.push(async () => {
    app.emit('before-quit', { preventDefault() {} })
    await vi.waitFor(() => expect(app.exit).toHaveBeenCalled())
  })
  return { root, userDataDir, hermesHome, client, sessions, main, handlers, mcp, dispatch,
    hostContext, workspaceContext, pipContext, mcpContext, attachmentContext, boot, computerRequest, dialog, prompt }
}

describe('real settings factory boot wiring', () => {
  it('refuses a revoked pending fill before returning a value and records only successful one-time consent', async () => {
    let generation = 0, finish
    const requestFill = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const provider = { approvalGeneration: vi.fn(() => generation), recordOriginApproval: vi.fn() }
    const f = fixture({ secretsOp: provider, requestFill })
    const input = { origin: 'https://example.invalid', agentName: 'Fake agent', fieldLabel: 'Password' }
    const pending = f.prompt.requestFill(input)
    generation++
    finish({ ok: true, value: 'obviously-fake-fill' })
    expect(await pending).toEqual({ ok: false })
    expect(provider.recordOriginApproval).not.toHaveBeenCalled()
    requestFill.mockResolvedValueOnce({ ok: true, value: 'obviously-fake-fill' })
    expect(await f.prompt.requestFill(input)).toMatchObject({ ok: true })
    expect(provider.recordOriginApproval).toHaveBeenCalledExactlyOnceWith(input.origin)
  })

  it('supplies the same synchronous live settings reader to host/workspace/MCP with deny-all on corrupt settings', async () => {
    const f = fixture()
    expect(f.attachmentContext).toMatchObject({ serveClient: f.client, hermesHost: f.boot.hermesHost,
      ipcHandle: expect.any(Function), serveAuth: { computerRequest: f.computerRequest } })
    const readers = [f.hostContext.getAppConfig, f.workspaceContext.getAppConfig, f.mcpContext.getConfig]
    expect(new Set(readers).size).toBe(1)
    expect(readers[0]()).not.toHaveProperty('then')
    expect(() => f.dispatch.gate('alpha')).toThrow('not enabled')
    const file = path.join(f.userDataDir, 'settings.json')
    writeFileSync(file, JSON.stringify({ serve: { mode: 'spawn', port: 9188 },
      workspace: { enabledProfiles: ['alpha'], maxTabsPerAgent: 3, maxLiveViews: 7, searchEngine: 'bing',
        downloadsDir: path.join(f.root, 'downloads'), profiles: { alpha: { allow: ['example.invalid'], deny: ['blocked.invalid'] } } } }))
    for (const reader of readers) expect(reader()).toMatchObject({
      serve: { mode: 'spawn', port: 9188 }, workspace: { maxTabsPerAgent: 3, maxLiveViews: 7,
        enabledProfiles: ['alpha'], searchEngine: 'bing', profiles: { alpha: { deny: ['blocked.invalid'] } } },
    })
    expect(() => f.dispatch.gate('alpha')).not.toThrow()
    expect(() => f.dispatch.gate('beta')).toThrow('not enabled')
    writeFileSync(file, JSON.stringify({ workspace: { enabledProfiles: ['beta'] } }))
    expect(() => f.dispatch.gate('alpha')).toThrow('not enabled')
    expect(() => f.dispatch.gate('beta')).not.toThrow()
    writeFileSync(file, '{broken')
    for (const reader of readers) expect(reader().workspace.enabledProfiles).toEqual([])
    expect(() => f.dispatch.gate('beta')).toThrow('not enabled')
  })

  it('supplies real MCP entries for confirmed backed-up enable and symmetric disable, never automatically', async () => {
    const f = fixture()
    const config = path.join(f.hermesHome, 'profiles', 'alpha', 'config.yaml')
    const original = readFileSync(config, 'utf8')
    expect(f.mcp.configEntryFor).not.toHaveBeenCalled()
    const invoke = (method) => f.handlers.get(`hd:host:${method}`)({}, ['alpha'])
    const denied = await invoke('enableBrowserControl')
    expect(denied.cancelled).toBe(true)
    expect(readFileSync(config, 'utf8')).toBe(original)
    f.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    expect((await invoke('enableBrowserControl')).ok).toBe(true)
    expect(readFileSync(config, 'utf8')).toContain('hermes-desk')
    expect(readdirSync(path.dirname(config)).some((name) => name.startsWith('config.yaml.bak-hermesdesk-'))).toBe(true)
    expect(() => f.dispatch.gate('alpha')).not.toThrow()
    expect((await invoke('disableBrowserControl')).ok).toBe(true)
    expect(readFileSync(config, 'utf8')).not.toContain('hermes-desk')
    expect(() => f.dispatch.gate('alpha')).toThrow('not enabled')
  })

  it('selects only registered connected runtime sessions and forwards main-only Computer GETs', async () => {
    const f = fixture()
    expect(f.pipContext.getComputerSession('alpha')).toBeNull()
    f.handlers.get('hd:ws:registerSession')({}, { profile: 'alpha', storedId: 'stored-a', runtimeId: 'runtime-a' })
    expect(f.pipContext.getComputerSession('alpha')).toEqual({ runtimeId: 'runtime-a' })
    expect(f.pipContext.getComputerSession('beta')).toBeNull()
    f.client.hasSession.mockReturnValue(false)
    expect(f.pipContext.getComputerSession('alpha')).toBeNull()
    expect(f.client.hasSession).toHaveBeenCalledWith('runtime-a', 'alpha')
    await expect(f.pipContext.computerRequest('/api/tools/computer-use/status?profile=alpha')).resolves.toEqual({ ready: true })
    expect(f.computerRequest).toHaveBeenCalledWith('/api/tools/computer-use/status?profile=alpha')
  })
  it('supplies profile-scoped display metadata to workspace/MCP and keeps tray state in sync after native PiP close', async () => {
    const f = fixture()
    for (const profile of ['alpha', 'beta']) writeFileSync(path.join(f.hermesHome, 'profiles', profile, 'profile.yaml'),
      `ui_meta:\n  display_name: "${profile} display"\n  accent_color: "#abc"\n`)
    expect(f.workspaceContext.getAgentMeta).toBe(f.mcpContext.getAgentMeta)
    for (const profile of ['alpha', 'beta', 'alpha']) {
      expect(f.workspaceContext.getAgentMeta(profile)).toEqual({ name: `${profile} display`, color: '#aabbcc' })
    }
    f.pipContext.onState({ open: true })
    expect(f.boot.isComputerOpen()).toBe(true)
    f.pipContext.onState({ open: false })
    expect(f.boot.isComputerOpen()).toBe(false)
  })
})
