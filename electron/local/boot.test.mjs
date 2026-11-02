import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const boot = require('./boot.cjs')

describe('foundation boot seam', () => {
  it('continues without workspace, gates host IPC and cleans up on quit', async () => {
    const handlers = new Map()
    const app = new EventEmitter()
    app.exit = vi.fn()
    const send = vi.fn()
    const client = { setEndpoint() {}, stop() {}, onConnection() {} }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = {
      app, getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }),
      ipcHandle: (channel, handler) => handlers.set(channel, handler),
      hermesHome: '/tmp/obviously-fake-unused-home',
      isPackaged: false,
      hostDeps: {
        env: {}, readToken: async () => ({ token: 'obviously-fake-token', source: 'env' }),
        probeServe: async () => ({ version: 'fake-version' }),
        discoverHermes: () => { throw new Error('No CLI in this fixture') },
        createServeClient: () => client,
        createGatewayClient: () => ({ health: async () => ({ state: 'down' }) }),
      },
    }
    const result = boot(ctx)
    await result.ready
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Workspace is not installed'))
    expect([...handlers.keys()]).toEqual(['hd:attachments:pickAndUpload', 'hd:host:status', 'hd:host:restartServe', 'hd:host:getConfig',
      'hd:host:sidebarActivity', 'hd:host:secretsMetadata', 'hd:host:revokeOrigin', 'hd:host:setProfileSoul',
      'hd:host:setConfig', 'hd:host:auditTail', 'hd:host:enableBrowserControl', 'hd:host:disableBrowserControl',
      'hd:ws:stopAll', 'hd:ws:registerSession'])
    expect(handlers.get('hd:host:status')()).toMatchObject({ serve: { state: 'down' } })
    expect(handlers.get('hd:host:enableBrowserControl')({}, ['fake-profile'])).toMatchObject({ ok: false, profiles: ['fake-profile'] })
    expect(() => handlers.get('hd:host:enableBrowserControl')({}, ['../escape'])).toThrow()
    // No userDataDir: the optional settings producer remains unavailable.
    expect(handlers.get('hd:host:getConfig')({})).toBeNull()
    expect(handlers.get('hd:host:auditTail')({}, 10)).toEqual([])
    expect(() => handlers.get('hd:host:setConfig')({}, {})).toThrow('not available')
    expect(() => handlers.get('hd:ws:registerSession')({}, {})).toThrow('unavailable')
    await expect(handlers.get('hd:ws:stopAll')({})).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledWith('hd:host:status-changed', expect.objectContaining({ controller: 'off' }))
    const preventDefault = vi.fn()
    app.emit('before-quit', { preventDefault })
    await vi.waitFor(() => expect(app.exit).toHaveBeenCalledWith(0))
    expect(preventDefault).toHaveBeenCalled()
  })

  it('keeps native controller status secondary when MCP is unavailable and disposes the workspace before serve', async () => {
    const app = new EventEmitter()
    app.exit = vi.fn()
    const offController = vi.fn()
    const onControllerStatus = vi.fn(() => offController)
    let finishDispose
    const dispose = vi.fn(() => new Promise((resolve) => { finishDispose = resolve }))
    const client = {}
    const host = {
      getServeClient: () => client, status: () => ({}), start: async () => {}, stop: vi.fn(async () => {}),
      onStatus: () => vi.fn(), setControllerStatus: vi.fn(),
    }
    const registerWorkspace = vi.fn(() => ({ dispose, bridge: {
      onStatus: onControllerStatus,
    } }))
    const offJournal = vi.fn()
    const registerRoomJournal = vi.fn(() => offJournal)
    const module = { exports: {} }
    runInNewContext(readFileSync(require.resolve('./boot.cjs'), 'utf8'), {
      module, console: { warn: vi.fn() }, require: (name) => name === './hermes-host.cjs'
        ? { createHermesHost: () => host } : name === './room-journal.cjs'
          ? { registerRoomJournal } : name === '../hud-activity-relay.cjs'
          ? require('../hud-activity-relay.cjs') : { registerWorkspace },
    })
    const ctx = { app, ipcMain: { on: vi.fn() }, ipcHandle: vi.fn(), getMainWindow: () => null, WebContentsView: class {}, userDataDir: '/tmp/fake-user-data' }
    const result = module.exports(ctx)
    await result.ready
    expect(registerWorkspace).toHaveBeenCalledWith({ ...ctx, ipcHandle: expect.any(Function), secretsOp: undefined,
      serveClient: client, hermesHost: host, getAppConfig: expect.any(Function), getAgentMeta: expect.any(Function) })
    expect(host.setControllerStatus).toHaveBeenCalledWith('off', 'Workspace MCP is unavailable; agent browsing is off.')
    expect(onControllerStatus).not.toHaveBeenCalled()
    app.emit('before-quit', { preventDefault() {} })
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    expect(registerRoomJournal).toHaveBeenCalledWith(ctx)
    expect(offJournal).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
    finishDispose()
    await vi.waitFor(() => expect(app.exit).toHaveBeenCalledWith(0))
    expect(dispose).toHaveBeenCalledOnce()
    expect(offController).not.toHaveBeenCalled()
    expect(host.stop).toHaveBeenCalledOnce()
    app.emit('will-quit')
    expect(offJournal).toHaveBeenCalledOnce()
  })

  it('wires optional config/PiP, hard stops known turns, and only pauses from the tray', async () => {
    const app = new EventEmitter()
    app.exit = vi.fn()
    app.getPath = vi.fn(() => '/tmp/fake-user-data')
    const window = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    const handlers = new Map()
    const lanes = new EventEmitter()
    lanes.allLanes = () => [{ id: 'you', kind: 'user' }, { id: 'profile:scout', kind: 'agent', profile: 'scout' }]
    lanes.listTabs = () => []
    lanes.focusedLaneId = 'profile:scout'
    lanes.ensureLane = () => lanes.allLanes()[1]
    lanes.pauseLane = vi.fn()
    const bridge = { cancelLane: vi.fn(), status: () => 'error', detail: () => 'Upstream blocked',
      onStatus: () => vi.fn() }
    const ws = { lanes, bridge, dispose: vi.fn() }
    const client = { call: vi.fn(async () => ({})), getActiveTurns: () => [
      { session_id: 'runtime-a', profile: 'scout' }, { session_id: 'runtime-b', profile: 'alan' }],
    setSecureRequestHandler: vi.fn(() => vi.fn()) }
    const host = { getServeClient: () => client, status: () => ({}), start: async () => {}, stop: vi.fn(),
      onStatus: () => vi.fn(), setControllerStatus: vi.fn() }
    const config = { getConfig: vi.fn(() => ({ serve: { port: 9128 } })), setConfig: vi.fn(),
      auditTail: vi.fn(() => []), enableBrowserControl: vi.fn(), disableBrowserControl: vi.fn() }
    const computer = { open: vi.fn(), close: vi.fn(), dispose: vi.fn() }
    const createHostConfig = vi.fn(() => config)
    const registerComputerPip = vi.fn(() => computer)
    const registerWorkspace = vi.fn(() => ws)
    const prompt = { requestServer: vi.fn(() => ({ value: 'OBVIOUSLY_FAKE_SECRET' })) }
    const module = { exports: {} }
    const modules = {
      './hermes-host.cjs': { createHermesHost: () => host },
      './workspace/index.cjs': { registerWorkspace },
      './workspace/secure-prompt.cjs': { createSecurePrompt: () => prompt },
      './host-config.cjs': { createHostConfig }, './computer-pip.cjs': { registerComputerPip },
    }
    runInNewContext(readFileSync(require.resolve('./boot.cjs'), 'utf8'), {
      module, console, require: (name) => modules[name] || require(name),
    })
    const ctx = { app, getMainWindow: () => window, hermesHome: '/tmp/fake-hermes-home',
      assertMainSender: (event) => { if (event.sender !== window.webContents) throw new Error('rejected') },
      ipcHandle: (channel, handler) => handlers.set(channel, handler), onWorkspaceActivity: vi.fn(), onTrayChanged: vi.fn() }
    const result = module.exports(ctx)
    const invoke = (channel, ...args) => handlers.get(channel)({ sender: window.webContents }, ...args)
    expect(registerWorkspace.mock.calls[0][0].userDataDir).toBe('/tmp/fake-user-data')
    expect(createHostConfig).toHaveBeenCalledWith(expect.objectContaining({ serveClient: client, hermesHome: ctx.hermesHome }))
    expect(registerComputerPip).toHaveBeenCalledWith(expect.objectContaining({ serveClient: client, hermesHost: host }))
    expect(host.setControllerStatus).toHaveBeenCalledWith('off', 'Workspace MCP is unavailable; agent browsing is off.')
    expect(invoke('hd:host:getConfig')).toEqual({ serve: { port: 9128 } })
    invoke('hd:host:setConfig', { serve: { port: 9129 } })
    expect(config.setConfig).toHaveBeenCalledWith({ serve: { port: 9129 } })
    invoke('hd:host:auditTail', 25)
    expect(config.auditTail).toHaveBeenCalledWith(25)
    invoke('hd:host:enableBrowserControl', ['scout', 'scout'])
    expect(config.enableBrowserControl).toHaveBeenCalledWith(['scout'])
    invoke('hd:host:disableBrowserControl', ['scout', 'scout'])
    expect(config.disableBrowserControl).toHaveBeenCalledWith(['scout'])
    expect(() => invoke('hd:host:disableBrowserControl', ['../escape'])).toThrow()
    expect(() => invoke('hd:host:auditTail', -1)).toThrow()
    expect(() => invoke('hd:host:setConfig', [])).toThrow()
    expect(() => handlers.get('hd:host:getConfig')({ sender: {} })).toThrow()
    expect(() => invoke('hd:ws:stopAll', false)).toThrow()
    await result.stopAll({ interrupt: false })
    expect(client.call).not.toHaveBeenCalled()
    expect(lanes.pauseLane.mock.calls).toEqual([['you'], ['profile:scout']])
    expect(bridge.cancelLane).toHaveBeenCalledWith('profile:scout', 'user_took_control')
    await invoke('hd:ws:stopAll')
    expect(client.call.mock.calls).toEqual([
      ['session.interrupt', { session_id: 'runtime-a', profile: 'scout' }],
      ['session.interrupt', { session_id: 'runtime-b', profile: 'alan' }],
    ])
    await result.toggleComputer()
    expect(computer.open).toHaveBeenCalledWith('scout')
    await result.toggleComputer()
    expect(computer.close).toHaveBeenCalledOnce()
    expect(result.isComputerOpen()).toBe(false)
    expect(client.setSecureRequestHandler.mock.calls[0][0]('secret', {}, {})).toEqual({ value: 'OBVIOUSLY_FAKE_SECRET' })
    lanes.emit('changed')
    expect(ctx.onWorkspaceActivity).toHaveBeenCalledTimes(2)
    app.emit('before-quit', { preventDefault() {} })
    await vi.waitFor(() => expect(app.exit).toHaveBeenCalledWith(0))
    expect(computer.dispose).toHaveBeenCalledOnce()
    expect(ws.dispose).toHaveBeenCalledOnce()
    expect(lanes.listenerCount('changed')).toBe(0)
  })

  it('wires MCP parts and live config/session lookup, mirrors socket readiness, and awaits MCP disposal before serve', async () => {
    const app = new EventEmitter()
    app.exit = vi.fn()
    app.getAppPath = () => '/tmp/fake-app'
    const main = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    const handlers = new Map(), sessions = new Map(), listeners = new Set(), order = []
    const client = {}
    const hostState = { controller: 'off', controllerDetail: '' }
    const host = { getServeClient: () => client, status: () => ({ ...hostState }),
      start: async () => { for (const cb of listeners) cb(host.status()) },
      stop: vi.fn(async () => { order.push('serve') }),
      onStatus: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
      setControllerStatus: vi.fn((controller, controllerDetail) => {
        Object.assign(hostState, { controller, controllerDetail })
        for (const cb of listeners) cb(host.status())
      }) }
    const lanes = new EventEmitter()
    lanes.allLanes = () => [{ id: 'profile:scout', profile: 'scout', kind: 'agent' }]
    lanes.listTabs = () => []
    lanes.pauseLane = vi.fn()
    lanes.getActiveTab = () => ({ id: 't_fake' })
    const cancelMcpLane = vi.fn()
    const takeover = vi.fn()
    lanes.on('user-input', takeover)
    const parts = { lanes, overlay: {}, urlPolicy: {}, redactor: {}, securePrompt: {}, audit: {} }
    const native = { status: () => 'error', detail: () => 'Upstream authentication is blocked',
      onStatus: vi.fn(), cancelLane: vi.fn() }
    const workspace = { parts, lanes, bridge: native, setControllerStatus: vi.fn(),
      getSessionForProfile: (profile) => sessions.get(profile) || null,
      dispose: vi.fn(() => { order.push('workspace') }) }
    let mcpStatus = { state: 'ready', detail: 'Workspace MCP socket listening', socketPath: '/tmp/fake-mcp.sock' }
    let mcpListener, release
    const offMcp = vi.fn()
    const mcp = { cancelLane: cancelMcpLane,
      status: () => mcpStatus, onStatus: vi.fn((cb) => { mcpListener = cb; return offMcp }),
      dispose: vi.fn(() => new Promise((resolve) => {
        order.push('mcp')
        release = resolve
      })) }
    const registerMcp = vi.fn(() => mcp)
    let settings = { workspace: { enabledProfiles: ['scout'] } }
    const config = { getConfig: async () => settings, getAppConfig: () => settings }
    const modules = {
      './hermes-host.cjs': { createHermesHost: () => host },
      './workspace/secure-prompt.cjs': { createSecurePrompt: () => ({}) },
      './host-config.cjs': { createHostConfig: () => config },
      './mcp/index.cjs': { registerMcp },
      './workspace/index.cjs': { registerWorkspace: (ctx) => {
        ctx.ipcHandle('hd:ws:registerSession', (_event, registration) => sessions.set(registration.profile, registration.runtimeId))
        return workspace
      } },
    }
    const module = { exports: {} }
    runInNewContext(readFileSync(require.resolve('./boot.cjs'), 'utf8'), {
      module, console: { warn: vi.fn() }, require: (name) => modules[name] || require(name),
    })
    const ctx = { app, isPackaged: false, userDataDir: '/tmp/fake-data', getMainWindow: () => main,
      ipcHandle: (name, handler) => handlers.set(name, handler) }
    const result = module.exports(ctx)
    await result.ready
    const mcpContext = registerMcp.mock.calls[0][0]
    expect(mcpContext).toMatchObject({ ...parts, userDataDir: ctx.userDataDir,
      appPath: '/tmp/fake-app', isPackaged: false, serveClient: client })
    for (const [key, value] of Object.entries(parts)) expect(mcpContext[key]).toBe(value)
    expect(mcpContext.getConfig()).toBe(settings)
    settings = { workspace: { enabledProfiles: ['scout', 'alan'] } }
    expect(mcpContext.getConfig()).toBe(settings)
    expect(mcpContext.getSessionForProfile('scout')).toBeNull()
    handlers.get('hd:ws:registerSession')({}, { profile: 'scout', storedId: 'fake-stored', runtimeId: 'fake-runtime' })
    expect(mcpContext.getSessionForProfile('scout')).toBe('fake-runtime')
    expect(mcpContext.getSessionForProfile('alan')).toBeNull()
    expect(handlers.get('hd:host:status')({})).toMatchObject({ controller: 'ready', controllerDetail: mcpStatus.detail })
    expect(main.webContents.send).toHaveBeenCalledWith('hd:host:status-changed',
      expect.objectContaining({ controller: 'ready', controllerDetail: mcpStatus.detail }))
    expect(native.onStatus).not.toHaveBeenCalled()
    expect(workspace.setControllerStatus).toHaveBeenCalledWith('ready')
    mcpStatus = { ...mcpStatus, state: 'error', detail: 'Workspace MCP listener stopped' }
    mcpListener(mcpStatus)
    expect(handlers.get('hd:host:status')({})).toMatchObject({ controller: 'error', controllerDetail: mcpStatus.detail })
    expect(workspace.setControllerStatus).toHaveBeenLastCalledWith('error')
    expect(result.mcp).toBe(mcp)
    await result.stopAll({ interrupt: false })
    expect(cancelMcpLane).toHaveBeenCalledWith('profile:scout', 'user_took_control')
    expect(takeover).not.toHaveBeenCalled()
    app.emit('before-quit', { preventDefault() {} })
    await vi.waitFor(() => expect(mcp.dispose).toHaveBeenCalledOnce())
    expect(order).toEqual(['mcp'])
    expect(host.stop).not.toHaveBeenCalled()
    expect(workspace.dispose).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(app.exit).toHaveBeenCalledWith(0))
    expect(order).toEqual(['mcp', 'workspace', 'serve'])
    expect(offMcp).toHaveBeenCalledOnce()
  })

  it('fails closed on MCP startup errors and denies profiles when settings are unavailable', async () => {
    const app = new EventEmitter()
    app.exit = vi.fn()
    const host = { getServeClient: () => ({}), status: () => ({}), start: async () => {}, stop: vi.fn(),
      onStatus: () => vi.fn(), setControllerStatus: vi.fn() }
    const lanes = new EventEmitter()
    lanes.allLanes = () => []
    const parts = { lanes, overlay: {}, urlPolicy: {}, redactor: {}, securePrompt: {}, audit: {} }
    const ws = { parts, lanes, getSessionForProfile: () => null, setControllerStatus: vi.fn(), dispose: vi.fn() }
    const registerMcp = vi.fn((ctx) => {
      expect(ctx.getConfig()).toMatchObject({ workspace: { enabledProfiles: [] } })
      throw new Error('OBVIOUSLY_FAKE_SECRET')
    })
    const warn = vi.fn()
    const modules = {
      './hermes-host.cjs': { createHermesHost: () => host },
      './workspace/index.cjs': { registerWorkspace: () => ws },
      './workspace/secure-prompt.cjs': { createSecurePrompt: () => ({}) },
      './mcp/index.cjs': { registerMcp },
    }
    const module = { exports: {} }
    runInNewContext(readFileSync(require.resolve('./boot.cjs'), 'utf8'), {
      module, console: { warn }, require: (name) => modules[name] || require(name),
    })
    const result = module.exports({ app, userDataDir: '/tmp/fake-data', getMainWindow: () => null, ipcHandle: vi.fn() })
    await result.ready
    expect(registerMcp).toHaveBeenCalledOnce()
    expect(result.mcp).toBeNull()
    expect(host.setControllerStatus).toHaveBeenCalledWith('error', 'Workspace MCP could not start; agent browsing is unavailable.')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('OBVIOUSLY_FAKE_SECRET')
    app.emit('before-quit', { preventDefault() {} })
    await vi.waitFor(() => expect(app.exit).toHaveBeenCalledWith(0))
  })
})
