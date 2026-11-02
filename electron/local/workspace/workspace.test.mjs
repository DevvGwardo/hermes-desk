import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { registerWorkspace } = require('./index.cjs')
const { createLanes } = require('./lanes.cjs')
const { createUrlPolicy } = require('./url-policy.cjs')
const { createViews, validOverlayMessage } = require('./views.cjs')
const { createPersistence } = require('./persist.cjs')
const disposals = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
  vi.useRealTimers()
})

function temporary() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-workspace-test-')))
  disposals.push(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

let nextContents = 1
class Contents extends EventEmitter {
  constructor() {
    super()
    this.id = nextContents++
    this.destroyed = false
    this.url = ''
    this.send = vi.fn()
    this.focus = vi.fn()
    this.loadURL = vi.fn(async (url) => { this.url = url })
    this.loadFile = vi.fn(async () => {})
    this.executeJavaScript = vi.fn(async () => {})
    this.close = vi.fn(() => { this.destroyed = true })
    this.reload = vi.fn()
    this.setWebRTCIPHandlingPolicy = vi.fn()
    this.navigationHistory = { canGoBack: vi.fn(() => false), canGoForward: vi.fn(() => false),
      goBack: vi.fn(), goForward: vi.fn() }
    this.debugger = { attach: vi.fn() }
  }
  isDestroyed() { return this.destroyed }
  getURL() { return this.url }
  setWindowOpenHandler(fn) { this.openHandler = fn }
}

function electronMocks({ nativeClickThrough = false } = {}) {
  const constructed = []
  class View extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.webContents = new Contents()
      this.setVisible = vi.fn((value) => { this.visible = value })
      this.setBounds = vi.fn((value) => { this.bounds = value })
      this.setBackgroundColor = vi.fn()
      constructed.push(this)
    }
  }
  if (nativeClickThrough) View.prototype.setIgnoreMouseEvents = vi.fn()
  class Window extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.webContents = new Contents()
      this.visible = true
      this.contentView = { children: [], addChildView: vi.fn((view) => { this.contentView.children.push(view) }),
        removeChildView: vi.fn((view) => {
          this.contentView.children = this.contentView.children.filter((child) => child !== view)
        }) }
      this.setIgnoreMouseEvents = vi.fn()
      this.setBounds = vi.fn()
      this.showInactive = vi.fn(() => { this.visible = true })
      this.hide = vi.fn(() => { this.visible = false })
      this.destroy = vi.fn(() => { this.destroyed = true; this.webContents.destroyed = true })
      constructed.push(this)
    }
    isDestroyed() { return this.destroyed === true }
    isVisible() { return this.visible }
    isMinimized() { return false }
    getContentBounds() { return { x: 50, y: 60, width: 1000, height: 800 } }
  }
  const main = new Window({})
  main.webContents.url = 'http://localhost:5173/'
  const partitions = new Map()
  const session = { fromPartition(id) {
    if (!partitions.has(id)) {
      const ses = new EventEmitter()
      ses.setPermissionRequestHandler = vi.fn((handler) => { ses.requestPermission = handler })
      ses.setPermissionCheckHandler = vi.fn((handler) => { ses.checkPermission = handler })
      ses.setDevicePermissionHandler = vi.fn((handler) => { ses.checkDevice = handler })
      ses.setProxy = vi.fn(async () => {})
      ses.closeAllConnections = vi.fn(async () => {})
      ses.webRequest = { onBeforeRequest: vi.fn((filter, handler) => { ses.beforeRequest = handler || null }) }
      partitions.set(id, ses)
    }
    return partitions.get(id)
  } }
  return { WebContentsView: View, BrowserWindow: Window, main, session, constructed, partitions }
}

function fixture(options = {}) {
  const mocks = electronMocks(options)
  const handlers = new Map()
  const serveClient = { call: vi.fn(async () => ({})) }
  let statusListener
  const bridge = { registerForSession: vi.fn(async () => {}), detach: vi.fn(),
    cancelLane: vi.fn(), dispose: vi.fn(), status: () => 'ready',
    onStatus: vi.fn((cb) => { statusListener = cb; return vi.fn() }) }
  const registerSpy = bridge.registerForSession
  const egress = options.egress || { ready: vi.fn(async () => ({
    mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:12345', proxyBypassRules: '<-loopback>',
  })), dispose: vi.fn(async () => {}) }
  const ctx = { ...mocks, getMainWindow: () => mocks.main, userDataDir: options.userDataDir || temporary(),
    homeDir: temporary(), serveClient, servePorts: [9120], hermesHost: { status: () => ({ serve: { port: 9121 } }) },
    assertMainSender: (event) => {
      if (event.sender !== mocks.main.webContents) throw new Error('IPC sender rejected')
    },
    ipcHandle: (name, handler) => { handlers.set(name, handler) },
    ipcMain: { removeHandler: vi.fn((name) => handlers.delete(name)) },
    ...(options.withBridge ? { workspaceConfig: { nativeControllerEnabled: true }, workspaceModules: { redactor: {},
      securePrompt: { createSecurePrompt: () => ({}) },
      controllerBridge: { createControllerBridge: () => bridge } } } : {}),
    ...options.ctx,
  }
  ctx.workspaceModules = { egressProxy: { createEgressProxy: () => egress }, ...ctx.workspaceModules }
  const ws = registerWorkspace(ctx)
  disposals.push(() => ws.dispose())
  const invoke = (name, ...args) => handlers.get(`hd:ws:${name}`)({ sender: mocks.main.webContents }, ...args)
  return { ...mocks, ctx, ws, handlers, invoke, serveClient, bridge, registerSpy, egress,
    changeStatus: (status) => statusListener(status) }
}

describe('agent session network isolation', () => {
  it('gates views, subresources, WebSockets and background requests until proxy setup finishes', async () => {
    let releaseProxy
    let releaseConfig
    const config = { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:12345', proxyBypassRules: '<-loopback>' }
    const egress = { ready: vi.fn(() => new Promise((resolve) => { releaseProxy = () => resolve(config) })),
      dispose: vi.fn(async () => {}) }
    const { ws, invoke, partitions } = fixture({ egress })
    ws.lanes.ensureLane('profile:scout')
    const ses = partitions.get('persist:ws-agent-scout')
    ses.setProxy.mockImplementation(() => new Promise((resolve) => { releaseConfig = resolve }))
    const opening = invoke('openTab', 'profile:scout')
    const callbacks = []
    for (const [url, resourceType] of [
      ['https://public.test/', 'mainFrame'], ['http://public.test/icon', 'image'],
      ['ws://public.test/socket', 'webSocket'], ['wss://public.test/socket', 'webSocket'],
      ['https://public.test/worker', 'xhr'],
    ]) {
      const cb = vi.fn()
      callbacks.push(cb)
      ses.beforeRequest({ url, resourceType, webContentsId: -1 }, cb)
    }
    await vi.waitFor(() => expect(egress.ready).toHaveBeenCalledOnce())
    expect(ses.setProxy).not.toHaveBeenCalled()
    expect(callbacks.every((cb) => cb.mock.calls.length === 0)).toBe(true)
    releaseProxy()
    await vi.waitFor(() => expect(ses.setProxy).toHaveBeenCalledWith(config))
    expect(callbacks.every((cb) => cb.mock.calls.length === 0)).toBe(true)
    releaseConfig()
    const id = await opening
    expect(callbacks.every((cb) => cb.mock.calls.length === 1 && cb.mock.calls[0][0].cancel === false)).toBe(true)
    expect(ses.closeAllConnections).toHaveBeenCalledTimes(2)
    expect(ses.closeAllConnections.mock.invocationCallOrder[0]).toBeLessThan(ses.setProxy.mock.invocationCallOrder[0])
    expect(ses.setProxy.mock.invocationCallOrder[0]).toBeLessThan(ses.closeAllConnections.mock.invocationCallOrder[1])
    const wc = ws.lanes.getTab(id).webContents
    expect(wc.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
    expect(wc.setWebRTCIPHandlingPolicy.mock.invocationCallOrder[0]).toBeLessThan(wc.loadURL.mock.invocationCallOrder[0])
  })

  it.each(['setProxy', 'closeAllConnections'])('fails closed when %s fails and never removes the network deny gate', async (method) => {
    const { ws, invoke, partitions } = fixture()
    ws.lanes.ensureLane('profile:scout')
    const ses = partitions.get('persist:ws-agent-scout')
    ses[method].mockRejectedValue(new Error('synthetic proxy failure'))
    await expect(invoke('openTab', 'profile:scout', 'https://public.test/')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    const cb = vi.fn()
    for (const url of ['https://public.test/', 'http://localhost/', 'wss://public.test/socket']) {
      ses.beforeRequest({ url, resourceType: 'xhr', webContentsId: -1 }, cb)
      expect(cb).toHaveBeenLastCalledWith({ cancel: true })
    }
    await expect(invoke('openTab', 'profile:scout')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(ws.lanes.listTabs('profile:scout')).toHaveLength(0)
    const mine = await invoke('openTab', 'you', 'http://127.0.0.1:9119/')
    expect(ws.lanes.getTab(mine).webContents.getURL()).toBe('http://127.0.0.1:9119/')
    expect(partitions.get('persist:ws-user').setProxy).not.toHaveBeenCalled()
  })

  it('fails closed on proxy listener startup failure without calling setProxy', async () => {
    const egress = { ready: vi.fn(async () => { throw new Error('listener failed') }), dispose: vi.fn(async () => {}) }
    const { invoke, partitions } = fixture({ egress })
    await expect(invoke('openTab', 'profile:scout')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    const ses = partitions.get('persist:ws-agent-scout')
    expect(ses.setProxy).not.toHaveBeenCalled()
    const cb = vi.fn()
    ses.beforeRequest({ url: 'https://public.test/', resourceType: 'xhr', webContentsId: -1 }, cb)
    expect(cb).toHaveBeenCalledWith({ cancel: true })
  })

  it('bounds setup wait and does not recover to direct networking after late proxy readiness', async () => {
    vi.useFakeTimers()
    let release
    const egress = { ready: vi.fn(() => new Promise((resolve) => { release = resolve })), dispose: vi.fn(async () => {}) }
    const { ws, partitions } = fixture({ egress })
    ws.lanes.ensureLane('profile:scout')
    const ses = partitions.get('persist:ws-agent-scout')
    const cb = vi.fn()
    ses.beforeRequest({ url: 'https://public.test/', resourceType: 'xhr', webContentsId: -1 }, cb)
    await vi.advanceTimersByTimeAsync(10000)
    expect(cb).toHaveBeenCalledExactlyOnceWith({ cancel: true })
    release({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:12345', proxyBypassRules: '<-loopback>' })
    await vi.advanceTimersByTimeAsync(1)
    expect(ses.setProxy).not.toHaveBeenCalled()
    ses.beforeRequest({ url: 'https://public.test/', resourceType: 'xhr', webContentsId: -1 }, cb)
    expect(cb).toHaveBeenLastCalledWith({ cancel: true })
  })

  it('bounds pending network callbacks and cancels them exactly once during shutdown', async () => {
    const egress = { ready: vi.fn(() => new Promise(() => {})), dispose: vi.fn(async () => {}) }
    const { ws, partitions } = fixture({ egress })
    ws.lanes.ensureLane('profile:scout')
    const ses = partitions.get('persist:ws-agent-scout')
    const callbacks = Array.from({ length: 129 }, () => vi.fn())
    for (const cb of callbacks) ses.beforeRequest({ url: 'https://public.test/', resourceType: 'xhr', webContentsId: -1 }, cb)
    expect(callbacks[0]).not.toHaveBeenCalled()
    expect(callbacks[128]).toHaveBeenCalledExactlyOnceWith({ cancel: true })
    await Promise.resolve()
    await ws.dispose()
    expect(callbacks.every((cb) => cb.mock.calls.length === 1 && cb.mock.calls[0][0].cancel === true)).toBe(true)
    expect(egress.dispose).toHaveBeenCalledOnce()
    expect(ses.beforeRequest).toBeTypeOf('function')
    const postShutdown = vi.fn()
    ses.beforeRequest({ url: 'https://public.test/', resourceType: 'xhr', webContentsId: -1 }, postShutdown)
    expect(postShutdown).toHaveBeenCalledExactlyOnceWith({ cancel: true })
  })

  it('enforces redirects, subresources and no-WebContents background requests after readiness', async () => {
    const { invoke, ws, partitions } = fixture()
    const id = await invoke('openTab', 'profile:scout')
    const ses = partitions.get('persist:ws-agent-scout')
    for (const resourceType of ['mainFrame', 'subFrame', 'image', 'xhr', 'webSocket']) {
      for (const url of ['http://127.1/', 'http://169.254.169.254/', 'http://192.168.0.1/',
        'http://[::ffff:127.0.0.1]/', 'ws://localhost/', 'wss://[::1]/', 'ftp://public.test/file']) {
        const cb = vi.fn()
        ses.beforeRequest({ url, resourceType, webContentsId: -1 }, cb)
        expect(cb).toHaveBeenCalledExactlyOnceWith({ cancel: true })
      }
    }
    const cb = vi.fn()
    ses.beforeRequest({ url: 'https://public.test/', resourceType: 'mainFrame',
      webContentsId: ws.lanes.getTab(id).webContents.id }, cb)
    expect(cb).toHaveBeenCalledWith({ cancel: false })
  })

  it('shares one bounded proxy for agent partitions and leaves the user partition unchanged', async () => {
    const { invoke, ws, partitions, egress } = fixture()
    const mine = await invoke('openTab', 'you', 'http://192.168.0.1:8080/')
    await invoke('openTab', 'profile:scout')
    await invoke('openTab', 'profile:other')
    for (const profile of ['scout', 'other']) {
      expect(partitions.get(`persist:ws-agent-${profile}`).setProxy).toHaveBeenCalledExactlyOnceWith({
        mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:12345', proxyBypassRules: '<-loopback>',
      })
    }
    const user = partitions.get('persist:ws-user')
    expect(user.setProxy).not.toHaveBeenCalled()
    expect(user.closeAllConnections).not.toHaveBeenCalled()
    expect(ws.lanes.getTab(mine).webContents.setWebRTCIPHandlingPolicy).not.toHaveBeenCalled()
    const cb = vi.fn()
    user.beforeRequest({ url: 'http://127.0.0.1:9119/', resourceType: 'xhr', webContentsId: -1 }, cb)
    expect(cb).toHaveBeenCalledWith({ cancel: false })
    await ws.dispose()
    expect(egress.dispose).toHaveBeenCalledOnce()
    expect(user.closeAllConnections).not.toHaveBeenCalled()
    expect(user.beforeRequest).toBeNull()
  })

  it('does not revive legacy restored shared-login views in the unproxied user partition', async () => {
    const directory = temporary()
    const first = fixture({ userDataDir: directory })
    const id = await first.invoke('openTab', 'profile:scout', 'https://public.test/')
    await first.ws.dispose()
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8'))
    saved.lanes.find((lane) => lane.id === 'profile:scout').tabs[0].sharedLogin = true
    fs.writeFileSync(path.join(directory, 'workspace.json'), JSON.stringify(saved))
    const second = fixture({ userDataDir: directory })
    const tab = second.ws.lanes.getTab(id)
    expect(tab).toMatchObject({ sharedLogin: true, partition: 'persist:ws-user', discarded: true })
    await expect(tab.ensureLive()).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(tab.webContents).toBeNull()
    expect(second.partitions.get('persist:ws-user').setProxy).not.toHaveBeenCalled()
  })
})

describe('workspace lanes and views', () => {
  it('rejects untrusted or malformed reader requests before accessing the tab debugger', async () => {
    const { invoke, handlers, ws } = fixture()
    const id = await invoke('openTab', 'profile:scout')
    const wc = ws.lanes.getTab(id).webContents
    const read = handlers.get('hd:ws:readerPreview')
    expect(() => read({ sender: new Contents() }, id)).toThrow('IPC sender rejected')
    for (const args of [[], [null], ['../private'], [id, 'extra'], ['t_missing']]) {
      expect(() => invoke('readerPreview', ...args)).toThrow()
    }
    expect(wc.debugger.attach).not.toHaveBeenCalled()
  })

  it('uses live agent display names and orb colours from the registerWorkspace context', async () => {
    let name = 'Alan Hermes'
    const { invoke, ws } = fixture({ ctx: { getAgentMeta: profile =>
      ({ name: profile === 'alan' ? name : 'Scout', color: '#44bd9a' }) } })
    await invoke('openTab', 'profile:alan')
    expect(invoke('list')).toMatchObject({ control: { agentName: 'Alan Hermes', agentColor: '#44bd9a' } })
    expect(ws.parts.getAgentMeta('alan')).toEqual({ name, color: '#44bd9a' })
    name = 'Renamed Alan'
    expect(invoke('list').control.agentName).toBe('Renamed Alan')
  })

  it('forwards native tab shell shortcuts once, ignores other keys, repeats, and agent input', async () => {
    const { invoke, ws, main } = fixture()
    const id = await invoke('openTab', 'profile:scout')
    const wc = ws.lanes.getTab(id).webContents
    const { dispatch } = require('./agent-input.cjs')
    for (const [key, shift] of [['1', false], ['9', false], ['t', false], ['T', true]]) {
      const event = { preventDefault: vi.fn(function () { this.defaultPrevented = true }) }
      wc.emit('before-input-event', event, { type: 'keyDown', key, code: key.toLowerCase() === 't' ? 'KeyT' : `Digit${key}`, meta: true, shift })
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    for (const input of [{ key: '2', shift: true }, { key: 't', isAutoRepeat: true },
      { key: 'x' }, { key: 't', alt: true }, { key: 't', meta: false }]) {
      wc.emit('before-input-event', { preventDefault: vi.fn() }, { type: 'keyDown', meta: true, ...input })
    }
    await dispatch(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 't', modifiers: 4 }, async () =>
      wc.emit('before-input-event', {}, { type: 'keyDown', key: 't', meta: true }))
    expect(main.webContents.send.mock.calls.filter(([channel]) => channel === 'hd:ws:shortcut')).toHaveLength(4)
    expect(main.webContents.send).toHaveBeenCalledWith('hd:ws:shortcut', {
      key: 't', code: 'KeyT', metaKey: true, ctrlKey: false, shiftKey: true,
    })
  })

  it('forwards address shortcuts and focuses only the main renderer, never agent-generated input', async () => {
    const { invoke, ws, main } = fixture()
    const id = await invoke('openTab', 'profile:scout')
    const wc = ws.lanes.getTab(id).webContents
    const { dispatch } = require('./agent-input.cjs')
    for (const modifier of [{ meta: true }, { control: true }]) {
      const event = { preventDefault: vi.fn() }
      wc.emit('before-input-event', event, { type: 'keyDown', key: 'l', ...modifier })
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    expect(main.webContents.focus).toHaveBeenCalledTimes(2)
    expect(main.webContents.send).toHaveBeenCalledWith('hd:ws:shortcut', {
      key: 'l', code: 'KeyL', metaKey: false, ctrlKey: true, shiftKey: false,
    })
    for (const input of [{ shift: true }, { alt: true }, { isAutoRepeat: true }, { type: 'keyUp' }]) {
      wc.emit('before-input-event', { preventDefault: vi.fn() }, { type: 'keyDown', key: 'l', meta: true, ...input })
    }
    await dispatch(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'l', modifiers: 4 }, async () =>
      wc.emit('before-input-event', {}, { type: 'keyDown', key: 'l', meta: true }))
    expect(main.webContents.focus).toHaveBeenCalledTimes(2)
    expect(wc.focus).not.toHaveBeenCalled()
    expect(main.webContents.send.mock.calls.filter(([channel]) => channel === 'hd:ws:shortcut')).toHaveLength(2)
  })

  it('rejects background and stale overlay paint and clear messages', async () => {
    const { invoke, ws, constructed } = fixture({ nativeClickThrough: true })
    const first = await invoke('openTab', 'you')
    const second = await invoke('openTab', 'you')
    invoke('setBounds', { x: 0, y: 0, width: 600, height: 400 })
    await ws.views.overlay.waitFrame(second)
    const wc = constructed[1].webContents
    wc.executeJavaScript.mockClear()
    ws.views.overlay.send({ type: 'masks', tabId: first, rects: [] })
    ws.views.overlay.send({ type: 'clear', tabId: first })
    ws.views.overlay.send({ type: 'cursor', tabId: second, x: 1, y: 1, phase: 'move', color: '#123456', label: 'Second' })
    ws.views.compose(first)
    await ws.views.overlay.waitFrame(first)
    expect(wc.executeJavaScript.mock.calls.some(([code]) => code.includes('"type":"cursor"'))).toBe(false)
    expect(wc.executeJavaScript).toHaveBeenCalledWith(`window.hermesWorkspaceOverlay.receive({"type":"activate","tabId":"${first}"})`)
  })
  it('initializes an empty live document and revives an empty crashed tab before use', async () => {
    const { ws, invoke } = fixture()
    const id = await invoke('openTab', 'profile:scout')
    const tab = ws.lanes.getTab(id)
    const old = tab.webContents
    expect(old.loadURL).toHaveBeenCalledExactlyOnceWith('about:blank')
    expect(old.getURL()).toBe('about:blank')
    old.emit('render-process-gone', {}, { reason: 'crashed' })
    const revived = await tab.ensureLive()
    expect(revived).not.toBe(old)
    expect(revived.getURL()).toBe('about:blank')
    await invoke('navigate', id, 'https://fixture.invalid/')
    expect(revived.getURL()).toBe('https://fixture.invalid/')
    await expect(invoke('navigate', id, 'about:blank')).rejects.toMatchObject({ code: 'blocked_by_policy' })
  })

  it('awaits initial document readiness before admitting a CDP command', async () => {
    let ready
    let created
    const lanes = createLanes({ urlPolicy: createUrlPolicy(), destroyView: vi.fn(),
      createView: (tab) => {
        created = new Contents()
        tab.liveReady = new Promise((resolve) => { ready = resolve })
        return created
      } })
    disposals.push(() => lanes.dispose())
    let admitted = false
    const opening = lanes.openTab('profile:scout').then((tab) => { admitted = true; return tab })
    await Promise.resolve()
    expect(admitted).toBe(false)
    created.url = 'about:blank'
    ready()
    const tab = await opening
    expect(await tab.ensureLive()).toBe(created)
    expect(admitted).toBe(true)
  })

  it('consumes live getAppConfig limits, named search engines and per-profile URL rules', async () => {
    const config = { workspace: { maxTabsPerAgent: 1, maxLiveViews: 2, searchEngine: 'bing',
      profiles: { scout: { allow: ['allowed.invalid'], deny: ['denied.allowed.invalid'] } } } }
    const { ws, invoke, partitions } = fixture({ ctx: { getAppConfig: () => config } })
    const scout = await invoke('openTab', 'profile:scout', 'https://allowed.invalid/')
    await expect(invoke('openTab', 'profile:scout')).rejects.toMatchObject({ code: 'tab_limit' })
    await expect(invoke('navigate', scout, 'https://denied.allowed.invalid/')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    await expect(invoke('navigate', scout, 'https://other.invalid/')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    const mine = await invoke('openTab', 'you')
    await invoke('navigate', mine, 'fake search')
    expect(ws.lanes.getTab(mine).webContents.getURL()).toBe('https://www.bing.com/search?q=fake%20search')
    config.workspace.searchEngine = 'duckduckgo'
    await invoke('navigate', mine, 'another query')
    expect(ws.lanes.getTab(mine).webContents.getURL()).toBe('https://duckduckgo.com/?q=another%20query')
    config.workspace.profiles.scout.deny = ['allowed.invalid']
    const callback = vi.fn()
    partitions.get('persist:ws-agent-scout').beforeRequest({ url: 'https://allowed.invalid/resource',
      resourceType: 'xhr', webContentsId: ws.lanes.getTab(scout).webContents.id }, callback)
    expect(callback).toHaveBeenCalledWith({ cancel: true })
    await invoke('openTab', 'you')
    expect(ws.lanes.allLanes().flatMap((lane) => ws.lanes.listTabs(lane.id)).filter((tab) => !tab.discarded)).toHaveLength(2)
  })

  it('fails soft before creating audit files, views, or handlers when context is incomplete', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mocks = electronMocks()
    const ipcHandle = vi.fn()
    const ctx = { ...mocks, getMainWindow: () => mocks.main, ipcHandle, assertMainSender: vi.fn(),
      ipcMain: { removeHandler: vi.fn() } }
    expect(registerWorkspace(ctx)).toBeNull()
    expect(registerWorkspace({ ...ctx, userDataDir: 'relative-data' })).toBeNull()
    expect(mocks.partitions.size).toBe(0)
    expect(mocks.constructed).toHaveLength(1)
    expect(ipcHandle).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('context is incomplete'))
  })

  it('creates isolated partitions, hardened views, and exact state summaries', async () => {
    const { ws, invoke, main, constructed } = fixture()
    const mine = await invoke('openTab', 'you', 'https://example.test/')
    const theirs = await invoke('openTab', 'profile:scout', 'https://example.test/')
    expect(ws.lanes.getTab(mine).partition).toBe('persist:ws-user')
    expect(ws.lanes.getTab(theirs).partition).toBe('persist:ws-agent-scout')
    expect(ws.lanes.ensureLane('you')).toMatchObject({ kind: 'user', paused: false })
    expect(ws.lanes.ensureLane('profile:scout')).toMatchObject({ kind: 'agent', profile: 'scout' })
    const state = invoke('list')
    expect(Object.keys(state).sort()).toEqual(['activeTabId', 'control', 'controller', 'focusedLaneId', 'lanes'])
    expect(state).toMatchObject({ activeTabId: theirs, focusedLaneId: 'profile:scout', controller: 'off',
      control: { laneId: 'profile:scout', owner: 'agent', paused: false } })
    expect(state.lanes[1].tabs[0]).toEqual({
      id: theirs, laneId: 'profile:scout', url: 'https://example.test/', title: '',
      state: 'idle', controller: 'agent', createdBy: 'user', sharedLogin: false,
      discarded: false, active: true, canGoBack: false, canGoForward: false,
    })
    for (const item of constructed.slice(1)) {
      expect(item.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false })
      expect(item.options.webPreferences).not.toHaveProperty('preload')
      expect(item.webContents.debugger.attach).not.toHaveBeenCalled()
    }
    expect(main.webContents.debugger.attach).not.toHaveBeenCalled()
  })

  it('mounts only the visible tab, applies bounds, and hides all child views', async () => {
    const { invoke, ws, main, constructed } = fixture()
    const first = await invoke('openTab', 'you')
    const second = await invoke('openTab', 'you')
    expect(main.contentView.children).toEqual([])
    invoke('setBounds', { x: 1.2, y: 2.7, width: 600.4, height: 400 })
    expect(main.contentView.children).toEqual([ws.views.get(second)])
    expect(ws.views.get(second).bounds).toEqual({ x: 1, y: 3, width: 600, height: 400 })
    const overlay = constructed[1]
    expect(overlay.options).toMatchObject({ transparent: true, focusable: false, frame: false })
    expect(overlay.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
    expect(overlay.setBounds).toHaveBeenCalledWith({ x: 51, y: 63, width: 600, height: 400 })
    await invoke('activate', first)
    expect(main.contentView.children).toEqual([ws.views.get(first)])
    invoke('setVisible', false)
    expect(main.contentView.children).toEqual([])
    expect(overlay.visible).toBe(false)
    invoke('setVisible', true)
    expect(main.contentView.children).toEqual([ws.views.get(first)])
    invoke('setBounds', null)
    expect(main.contentView.children).toEqual([])
  })

  it('uses an input-ignoring overlay view when the runtime supports it', async () => {
    const { ws, invoke, main, constructed } = fixture({ nativeClickThrough: true })
    const id = await invoke('openTab', 'you')
    invoke('setBounds', { x: 0, y: 0, width: 600, height: 400 })
    const overlay = constructed[1]
    expect(main.contentView.children).toEqual([ws.views.get(id), overlay])
    expect(overlay.setBackgroundColor).toHaveBeenCalledWith('#00000000')
    await ws.views.overlay.send({ type: 'cursor', tabId: id, x: 25, y: 32, phase: 'press', color: '#8b9cff', label: 'Scout' })
    await ws.views.overlay.waitFrame()
    expect(overlay.webContents.executeJavaScript).toHaveBeenCalledWith(
      `window.hermesWorkspaceOverlay.receive({"type":"cursor","tabId":"${id}","x":25,"y":32,"phase":"press","color":"#8b9cff","label":"Scout"})`)
    expect(overlay.webContents.debugger.attach).not.toHaveBeenCalled()
  })

  it('caps agent lanes at eight tabs and caps live views under concurrent admission', async () => {
    const { invoke, ws } = fixture()
    await Promise.all(Array.from({ length: 8 }, () => invoke('openTab', 'profile:scout')))
    await expect(invoke('openTab', 'profile:scout')).rejects.toMatchObject({ code: 'tab_limit' })
    await Promise.all(Array.from({ length: 25 }, () => invoke('openTab', 'you')))
    const all = ws.lanes.allLanes().flatMap((lane) => ws.lanes.listTabs(lane.id))
    expect(all.filter((tab) => !tab.discarded)).toHaveLength(20)
    expect(all.filter((tab) => tab.discarded)).toHaveLength(13)
    const discarded = all.find((tab) => tab.discarded)
    expect(discarded.webContents).toBeNull()
    await invoke('activate', discarded.id)
    expect(discarded.discarded).toBe(false)
    expect(all.filter((tab) => !tab.discarded)).toHaveLength(20)
  })

  it('discards LRU background tabs, keeps metadata, and protects the visible tab', async () => {
    const { invoke, ws } = fixture()
    const visible = await invoke('openTab', 'you', 'https://visible.test/')
    invoke('setBounds', { x: 0, y: 0, width: 600, height: 400 })
    const firstBackground = await ws.lanes.openTab('profile:a', 'https://first.test/', { createdBy: 'agent' })
    firstBackground.title = 'First'
    const oldContents = firstBackground.webContents
    for (let i = 0; i < 19; i++) await ws.lanes.openTab(`profile:agent-${i}`, undefined, { createdBy: 'agent' })
    expect(oldContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    expect(firstBackground).toMatchObject({ url: 'https://first.test/', title: 'First', discarded: true, webContents: null })
    expect(ws.lanes.getTab(visible).discarded).toBe(false)
    expect(ws.lanes.focusedLaneId).toBe('you')
    await ws.lanes.activateTab(ws.lanes.getActiveTab('profile:agent-2').id, { steal: false })
    expect(ws.lanes.focusedLaneId).toBe('you')
  })

  it('never discards busy views when all twenty are pinned', async () => {
    const { invoke, ws } = fixture()
    for (let i = 0; i < 20; i++) {
      const id = await invoke('openTab', 'you')
      ws.lanes.setTabState(id, 'agent-acting')
    }
    await expect(invoke('openTab', 'you')).rejects.toMatchObject({ code: 'view_limit' })
    expect(ws.lanes.listTabs('you')).toHaveLength(20)
  })

  it('restores isolated tabs discarded and lazily reloads behind their agent proxy', async () => {
    const directory = temporary()
    const first = fixture({ userDataDir: directory })
    const id = await first.invoke('openTab', 'profile:scout', 'https://example.test/path?token=obviously-fake#obviously-fake')
    first.ws.dispose()
    const raw = fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8')
    expect(raw).not.toContain('obviously-fake')
    const second = fixture({ userDataDir: directory })
    const restored = second.ws.lanes.getTab(id)
    expect(restored).toMatchObject({ discarded: true, webContents: null, sharedLogin: false,
      partition: 'persist:ws-agent-scout', laneId: 'profile:scout', url: 'https://example.test/path' })
    expect(second.ws.lanes.installId).toBe(first.ws.lanes.installId)
    await second.invoke('focusLane', 'profile:scout')
    expect(restored.discarded).toBe(false)
    expect(restored.webContents.loadURL).toHaveBeenCalledWith('https://example.test/path')
  })

  it('blocks shared-login handoff rather than proxying the user session or leaving direct agent egress', async () => {
    const { invoke, ws, serveClient, partitions } = fixture()
    const id = await invoke('openTab', 'you', 'https://example.test/')
    const contents = ws.lanes.getTab(id).webContents
    await expect(invoke('giveToAgent', id, 'scout', 'Read this')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(() => ws.lanes.moveTab(id, 'profile:scout')).toThrow('isolated network partition')
    expect(serveClient.call).not.toHaveBeenCalled()
    expect(ws.lanes.getTab(id)).toMatchObject({ laneId: 'you', sharedLogin: false,
      controller: 'user', partition: 'persist:ws-user', webContents: contents })
    expect(partitions.get('persist:ws-user').setProxy).not.toHaveBeenCalled()
    expect(ws.lanes.focusedLaneId).toBe('you')
  })

  it('blocks sharing a control-plane tab and never overflows a full agent lane on handoff', async () => {
    const { invoke, ws } = fixture()
    const blocked = await invoke('openTab', 'you', 'http://127.0.0.1:9119/')
    await expect(invoke('giveToAgent', blocked, 'scout')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(ws.lanes.getTab(blocked).laneId).toBe('you')
    const id = await invoke('openTab', 'you', 'https://example.test/')
    for (let i = 0; i < 8; i++) await invoke('openTab', 'profile:scout')
    await expect(invoke('giveToAgent', id, 'scout')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(ws.lanes.listTabs('profile:scout')).toHaveLength(8)
    expect(ws.lanes.getTab(id).sharedLogin).toBe(false)
  })

  it('updates metadata/loading, prevents webviews/navigation, and opens popups in-lane', async () => {
    const { invoke, ws } = fixture()
    const id = await invoke('openTab', 'profile:scout', 'https://example.test/')
    const entry = ws.lanes.getTab(id)
    const contents = entry.webContents
    contents.emit('did-start-loading')
    expect(entry.state).toBe('loading')
    contents.emit('page-title-updated', {}, 'Example')
    contents.emit('page-favicon-updated', {}, ['file:///bad', 'https://example.test/icon.png'])
    contents.emit('did-navigate', {}, 'https://example.test/next')
    contents.emit('did-stop-loading')
    expect(entry).toMatchObject({ state: 'idle', title: 'Example', url: 'https://example.test/next',
      favicon: 'https://example.test/icon.png' })
    const event = { preventDefault: vi.fn() }
    contents.emit('will-attach-webview', event)
    contents.emit('will-navigate', event, 'http://127.0.0.1:8642/')
    contents.emit('will-redirect', event, 'file:///private')
    expect(event.preventDefault).toHaveBeenCalledTimes(3)
    expect(contents.openHandler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    expect(contents.openHandler({ url: 'https://example.test/popup' })).toEqual({ action: 'deny' })
    await Promise.resolve()
    await Promise.resolve()
    expect(ws.lanes.listTabs('profile:scout')).toHaveLength(2)
  })

  it('does not let a background popup steal the visible lane and closes crashed views', async () => {
    const { invoke, ws } = fixture()
    const agent = await invoke('openTab', 'profile:scout', 'https://example.test/')
    const mine = await invoke('openTab', 'you')
    const contents = ws.lanes.getTab(agent).webContents
    contents.openHandler({ url: 'https://example.test/popup' })
    await Promise.resolve()
    await Promise.resolve()
    expect(ws.lanes.focusedLaneId).toBe('you')
    expect(invoke('list').activeTabId).toBe(mine)
    contents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(contents.close).toHaveBeenCalledOnce()
    expect(ws.lanes.getTab(agent)).toMatchObject({ discarded: true, webContents: null })
    await invoke('activate', agent)
    expect(ws.lanes.getTab(agent).webContents).not.toBe(contents)
    expect(ws.lanes.getTab(agent).discarded).toBe(false)
  })

  it('fails closed for legacy shared-login requests without proxying the user partition', async () => {
    const { invoke, ws, partitions } = fixture()
    const id = await invoke('openTab', 'you', 'https://example.test/')
    // Model an old shared-login tab; new handoffs are rejected above.
    ws.lanes.ensureLane('profile:scout')
    Object.assign(ws.lanes.getTab(id), { laneId: 'profile:scout', controller: 'agent', sharedLogin: true })
    const ses = partitions.get('persist:ws-user')
    const callback = vi.fn()
    for (const url of ['http://localhost:9121/api', 'http://[::1]:8642/api', 'http://127.0.0.1:5173/',
      'ws://localhost:9119/api/ws', 'wss://127.0.0.1:9120/api/ws']) {
      ses.beforeRequest({ url, resourceType: 'xhr', webContentsId: ws.lanes.getTab(id).webContents.id }, callback)
      expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    }
    ses.beforeRequest({ url: 'http://192.168.1.10:80/', resourceType: 'xhr',
      webContentsId: ws.lanes.getTab(id).webContents.id }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    // Requests without a webContents (service workers) use the strictest lane sharing the session.
    ses.beforeRequest({ url: 'http://localhost:9119/', resourceType: 'xhr', webContentsId: -1 }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    expect(ses.setProxy).not.toHaveBeenCalled()
  })

  it('denies every partition permission request/check/device access', async () => {
    const { invoke, partitions } = fixture()
    await invoke('openTab', 'profile:scout')
    for (const ses of partitions.values()) {
      for (const permission of ['media', 'geolocation', 'notifications', 'midi', 'hid', 'serial', 'usb']) {
        const cb = vi.fn()
        ses.requestPermission(null, permission, cb, {})
        expect(cb).toHaveBeenCalledWith(false)
        expect(ses.checkPermission(null, permission)).toBe(false)
        expect(ses.checkDevice({ deviceType: permission })).toBe(false)
      }
    }
  })

  it('coalesces state events and disposes handlers, live views, and bridge once', async () => {
    vi.useFakeTimers()
    const { invoke, ws, main, handlers, bridge } = fixture({ withBridge: true })
    await invoke('openTab', 'you')
    for (let i = 0; i < 10; i++) ws.lanes.changed()
    expect(main.webContents.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(17)
    expect(main.webContents.send).toHaveBeenCalledTimes(1)
    expect(main.webContents.send.mock.calls[0][0]).toBe('hd:ws:state')
    ws.dispose()
    ws.dispose()
    expect(handlers.size).toBe(0)
    expect(bridge.dispose).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(main.webContents.send).toHaveBeenCalledTimes(1)
  })
})

describe('IPC validation', () => {
  it.each([
    ['setBounds', undefined], ['setBounds', { x: NaN, y: 0, width: 1, height: 2 }],
    ['setBounds', { x: -1, y: 0, width: 1, height: 2 }], ['setBounds', []],
    ['setVisible', 1], ['setVisible', 'true'], ['openTab', '../scout'],
    ['openTab', 'profile:UPPER'], ['openTab', 'profile:scout', null],
    ['openTab', 'you', ''], ['activate', 't_BAD'], ['closeTab', '../t_1'],
    ['focusLane', 'profile:'], ['resumeAgent', '../scout'], ['back', 'a'],
    ['forward', {}], ['reload', 1], ['list', 'extra'], ['takeControl', '../t_1'],
    ['takeControl', 't_1', 'extra'],
  ])('rejects malformed %s arguments', async (method, ...args) => {
    const { invoke } = fixture()
    await expect(Promise.resolve().then(() => invoke(method, ...args))).rejects.toThrow()
  })

  it('rejects untrusted senders, missing tabs, extra args, scripts, and unknown schemes', async () => {
    const { invoke, handlers } = fixture()
    expect(() => handlers.get('hd:ws:list')({ sender: new Contents() })).toThrow('IPC sender rejected')
    expect(() => invoke('activate', 't_123')).toThrow('Tab not found')
    const id = await invoke('openTab', 'profile:scout')
    await expect(invoke('giveToAgent', id, '../scout')).rejects.toThrow('Invalid profile')
    await expect(invoke('giveToAgent', id, 'scout', {})).rejects.toThrow('Invalid instruction')
    for (const url of ['javascript:alert(1)', 'file:///private', 'http://localhost:9120/']) {
      await expect(invoke('navigate', id, url)).rejects.toMatchObject({ code: 'blocked_by_policy' })
    }
    expect(() => invoke('navigate', id, 'https://example.test/', 'extra')).toThrow('Invalid workspace arguments')
    expect(() => invoke('copySignIn', 'file:///private', 'you', 'profile:scout')).toThrow()
    expect(() => invoke('copySignIn', 'https://example.test/path', 'you', 'profile:scout')).toThrow('origin')
    await expect(invoke('copySignIn', 'https://example.test', 'you', 'profile:scout')).rejects.toMatchObject({ code: 'blocked_by_policy' })
  })

  it('searches ordinary text with the configured engine and navigates history safely', async () => {
    const { invoke, ws } = fixture({ ctx: { workspaceConfig: { searchEngine: 'https://search.test/?q={query}' } } })
    const id = await invoke('openTab', 'you')
    await invoke('navigate', id, 'two words & more')
    const contents = ws.lanes.getTab(id).webContents
    expect(contents.loadURL).toHaveBeenCalledWith('https://search.test/?q=two%20words%20%26%20more')
    contents.navigationHistory.canGoBack.mockReturnValue(true)
    contents.navigationHistory.canGoForward.mockReturnValue(true)
    await invoke('back', id)
    await invoke('forward', id)
    await invoke('reload', id)
    expect(contents.navigationHistory.goBack).toHaveBeenCalledOnce()
    expect(contents.navigationHistory.goForward).toHaveBeenCalledOnce()
    expect(contents.reload).toHaveBeenCalledOnce()
  })
})

describe('takeover and controller wiring', () => {
  it('gives the toolbar takeover the same lane-scoped pause and cancellation as native input', async () => {
    const { invoke, ws, bridge, handlers } = fixture({ withBridge: true })
    const user = await invoke('openTab', 'you')
    const controlled = await invoke('openTab', 'profile:scout', 'https://example.test/')
    const before = ws.lanes.getTab(controlled)
    expect(() => handlers.get('hd:ws:takeControl')({ sender: new Contents() }, controlled)).toThrow('IPC sender rejected')
    expect(() => invoke('takeControl', user)).toThrow('Only agent-controlled tabs')
    invoke('takeControl', controlled)
    invoke('takeControl', controlled)
    expect(ws.lanes.isPaused('profile:scout')).toBe(true)
    expect(before.state).toBe('user-paused')
    expect(before.laneId).toBe('profile:scout')
    expect(before.partition).toBe('persist:ws-agent-scout')
    expect(bridge.cancelLane).toHaveBeenCalledExactlyOnceWith('profile:scout', 'user_took_control')
    await invoke('resumeAgent', 'profile:scout')
    expect(ws.lanes.isPaused('profile:scout')).toBe(false)
  })
  it('keeps the native path off by default and tears it down permanently when MCP claims ownership', async () => {
    const off = fixture({ withBridge: true, ctx: { workspaceConfig: {} } })
    await off.invoke('registerSession', { profile: 'scout', storedId: 'fake-stored', runtimeId: 'fake-runtime' })
    expect(off.ws.bridge).toBeNull()
    expect(off.registerSpy).not.toHaveBeenCalled()
    const enabled = fixture({ withBridge: true })
    await enabled.ws.lanes.registerForSession('fake-runtime', 'scout')
    expect(enabled.registerSpy).toHaveBeenCalledOnce()
    enabled.ws.setControllerStatus('ready')
    expect(enabled.ws.bridge).toBeNull()
    expect(enabled.bridge.dispose).toHaveBeenCalledOnce()
    await enabled.ws.lanes.registerForSession('fake-next', 'scout')
    expect(enabled.registerSpy).toHaveBeenCalledOnce()
    enabled.ws.setControllerStatus('off')
    expect(enabled.ws.bridge).toBeNull()
  })
  it('exposes the shared MCP parts even when the native controller cannot initialize', () => {
    const redactor = { scrubText: (text) => text }
    const { ws, ctx } = fixture({ ctx: { workspaceModules: {
      redactor, securePrompt: require('./secure-prompt.cjs'),
      controllerBridge: { createControllerBridge: () => { throw new Error('fake native failure') } },
    } } })
    expect(Object.keys(ws.parts).sort()).toEqual(['audit', 'getAgentMeta', 'lanes', 'overlay', 'redactor', 'securePrompt', 'urlPolicy'])
    expect(ws.parts.lanes).toBe(ws.lanes)
    expect(ws.parts.overlay).toBe(ws.views.overlay)
    expect(ws.parts.redactor).toBe(redactor)
    expect(ws.parts.securePrompt.requestFill).toBeTypeOf('function')
    expect(ws.parts.securePrompt.requestServer).toBeTypeOf('function')
    expect(ws.parts.audit.log).toBeTypeOf('function')
    expect(ws.bridge).toBeNull()
    ctx.hermesHost.status = () => ({ serve: { port: 9135 } })
    expect(ws.parts.urlPolicy.check('http://127.0.0.1:9135/', { laneKind: 'agent' }).ok).toBe(false)
    expect(ws.parts.urlPolicy.check('https://example.invalid/', { laneKind: 'agent' }).ok).toBe(true)
  })

  it('uses validated IPC registrations for MCP steering and refuses unsafe shared-partition handoff', async () => {
    const { ws, invoke, serveClient, registerSpy, changeStatus, main } = fixture({ withBridge: true })
    serveClient.assertRendererSession = vi.fn()
    ws.setControllerStatus('ready')
    const registration = { profile: 'scout', storedId: 'fake-stored', runtimeId: 'fake-runtime' }
    expect(ws.getSessionForProfile('scout')).toBeNull()
    await invoke('registerSession', registration)
    expect(serveClient.assertRendererSession).toHaveBeenCalledWith(registration, main.webContents)
    expect(ws.getSessionForProfile('scout')).toBe('fake-runtime')
    expect(ws.getSessionForProfile('alan')).toBeNull()
    expect(ws.getSessionForProfile('../bad')).toBeNull()
    expect(registerSpy).not.toHaveBeenCalled()
    changeStatus('error')
    expect(invoke('list').controller).toBe('ready')
    serveClient.assertRendererSession.mockImplementationOnce(() => { throw new Error('foreign socket') })
    expect(() => invoke('registerSession', { ...registration, runtimeId: 'fake-foreign' })).toThrow()
    expect(ws.getSessionForProfile('scout')).toBe('fake-runtime')
    await invoke('registerSession', { ...registration, runtimeId: 'fake-new-runtime' })
    const mine = await invoke('openTab', 'you', 'https://example.test/')
    await expect(invoke('giveToAgent', mine, 'scout', 'Read this')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    const id = await invoke('openTab', 'profile:scout', 'https://example.test/')
    expect(registerSpy).not.toHaveBeenCalled()
    expect(serveClient.call).not.toHaveBeenCalled()
    const { createDispatch } = require('../mcp/dispatch.cjs')
    const dispatch = createDispatch({ ...ws.parts, serveClient, getSessionForProfile: ws.getSessionForProfile,
      getConfig: () => ({ workspace: { enabledProfiles: ['scout'] } }),
      createExecutor: () => ({ run: vi.fn(), dispose: vi.fn() }) })
    disposals.push(() => { void dispatch.dispose() })
    ws.lanes.getTab(id).webContents.emit('before-input-event', {}, { type: 'keyDown' })
    ws.lanes.getTab(id).webContents.emit('before-input-event', {}, { type: 'keyUp' })
    await Promise.resolve()
    expect(serveClient.call.mock.calls.filter(([method]) => method === 'session.steer')).toHaveLength(1)
    expect(serveClient.call).toHaveBeenLastCalledWith('session.steer', {
      session_id: 'fake-new-runtime', text: `[Workspace] User took control of tab ${id}; wait for them to hand it back.`,
    })
    ws.setControllerStatus('error')
    expect(invoke('list').controller).toBe('error')
    ws.dispose()
    expect(ws.getSessionForProfile('scout')).toBeNull()
  })

  it('keeps MCP session lookup available without a native controller bridge', async () => {
    const { ws, invoke } = fixture()
    ws.setControllerStatus('off')
    await invoke('registerSession', { profile: 'scout', storedId: 'fake-stored', runtimeId: 'fake-runtime' })
    expect(ws.bridge).toBeNull()
    expect(ws.getSessionForProfile('scout')).toBe('fake-runtime')
  })

  it('registers only validated renderer sessions and retains the runtime id when upstream rejects control', async () => {
    const assertRendererSession = vi.fn()
    const f = fixture({ withBridge: true })
    f.serveClient.assertRendererSession = assertRendererSession
    const registration = { profile: 'scout', storedId: 'fake-stored', runtimeId: 'fake-runtime' }
    await f.invoke('registerSession', registration)
    expect(assertRendererSession).toHaveBeenCalledWith(registration, f.main.webContents)
    expect(f.registerSpy).toHaveBeenCalledWith('fake-runtime', 'scout')
    for (const invalid of [null, [], { ...registration, profile: '../bad' },
      { ...registration, runtimeId: '' }, { ...registration, storedId: 'bad\nid' }, { ...registration, forged: true }]) {
      expect(() => f.invoke('registerSession', invalid)).toThrow('Invalid session')
    }
    assertRendererSession.mockImplementationOnce(() => { throw new Error('foreign socket') })
    expect(() => f.invoke('registerSession', registration)).toThrow('foreign socket')
    f.registerSpy.mockRejectedValueOnce(new Error('upstream rejection'))
    await expect(f.invoke('registerSession', { ...registration, runtimeId: 'fake-new-runtime' })).rejects.toThrow()
    const id = await f.invoke('openTab', 'profile:scout')
    f.ws.lanes.getTab(id).webContents.emit('before-input-event', {}, { type: 'keyDown' })
    expect(f.serveClient.call).toHaveBeenCalledWith('session.steer', expect.objectContaining({ session_id: 'fake-new-runtime' }))
  })
  it.each(['key', 'mouse', 'wheel', 'viewMouse', 'viewWheel'])('pauses once on real %s input and resumes the known session', async (kind) => {
    const { invoke, ws, bridge, serveClient } = fixture({ withBridge: true })
    await ws.lanes.registerForSession('fake-session-scout', 'scout')
    const id = await invoke('openTab', 'profile:scout')
    const second = await invoke('openTab', 'profile:scout')
    const tab = ws.lanes.getTab(id)
    const userInput = vi.fn()
    ws.lanes.on('user-input', userInput)
    ws.lanes.setTabState(id, 'agent-acting')
    if (kind === 'key') tab.webContents.emit('before-input-event', {}, { type: 'keyDown', key: 'a' })
    if (kind === 'mouse') tab.webContents.emit('before-mouse-event', {}, { type: 'mouseDown' })
    if (kind === 'wheel') tab.webContents.emit('before-mouse-event', {}, { type: 'mouseWheel' })
    if (kind === 'viewMouse') ws.views.get(id).emit('mouseDown')
    if (kind === 'viewWheel') ws.views.get(id).emit('wheel')
    tab.webContents.emit('before-input-event', {}, { type: 'keyDown', key: 'b' })
    expect(ws.lanes.isPaused('profile:scout')).toBe(true)
    expect(ws.lanes.getTab(second).state).toBe('user-paused')
    expect(userInput).toHaveBeenCalledExactlyOnceWith({ laneId: 'profile:scout', tabId: id })
    expect(bridge.cancelLane).toHaveBeenCalledExactlyOnceWith('profile:scout', 'user_took_control')
    expect(serveClient.call).toHaveBeenCalledWith('session.steer', { session_id: 'fake-session-scout',
      text: `[Workspace] User took control of tab ${id}; wait for them to hand it back.` })
    ws.lanes.setTabState(id, 'idle')
    expect(tab.state).toBe('user-paused')
    await invoke('resumeAgent', 'profile:scout')
    expect(tab.state).toBe('idle')
    expect(ws.lanes.isPaused('profile:scout')).toBe(false)
    expect(serveClient.call).toHaveBeenLastCalledWith('session.steer',
      { session_id: 'fake-session-scout', text: '[Workspace] Control returned.' })
  })

  it('ignores movement/user-controlled tabs and never guesses a missing session', async () => {
    const { ws, invoke, bridge, serveClient } = fixture({ withBridge: true })
    const mine = await invoke('openTab', 'you')
    ws.lanes.getTab(mine).webContents.emit('before-input-event', {}, { type: 'keyDown' })
    const agent = await invoke('openTab', 'profile:scout')
    ws.lanes.getTab(agent).webContents.emit('before-mouse-event', {}, { type: 'mouseMove' })
    expect(bridge.cancelLane).not.toHaveBeenCalled()
    ws.lanes.getTab(agent).webContents.emit('before-input-event', {}, { type: 'keyDown' })
    expect(bridge.cancelLane).toHaveBeenCalledOnce()
    expect(serveClient.call).not.toHaveBeenCalled()
    await invoke('resumeAgent', 'profile:scout')
    expect(serveClient.call).not.toHaveBeenCalled()
  })

  it('tracks the last registration, drops detached sessions, and never posts denied handoffs', async () => {
    const { ws, invoke, serveClient, bridge, registerSpy, changeStatus } = fixture({ withBridge: true })
    await ws.lanes.registerForSession('fake-old', 'scout')
    await ws.lanes.registerForSession('fake-current', 'scout')
    const id = await invoke('openTab', 'you', 'https://example.test/')
    await expect(invoke('giveToAgent', id, 'scout', 'Read the page')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(registerSpy).toHaveBeenLastCalledWith('fake-current', 'scout')
    expect(serveClient.call).not.toHaveBeenCalled()
    bridge.detach('fake-current')
    serveClient.call.mockClear()
    ws.lanes.getTab(id).webContents.emit('before-input-event', {}, { type: 'keyDown' })
    expect(serveClient.call).not.toHaveBeenCalled()
    changeStatus('mismatch')
    expect(invoke('list').controller).toBe('mismatch')
  })

  it('cancels an agent command on close and does not retain input listeners', async () => {
    const { invoke, ws, bridge } = fixture({ withBridge: true })
    const id = await invoke('openTab', 'profile:scout')
    const contents = ws.lanes.getTab(id).webContents
    invoke('closeTab', id)
    expect(bridge.cancelLane).toHaveBeenCalledExactlyOnceWith('profile:scout', 'tab_closed')
    expect(contents.listenerCount('before-input-event')).toBe(0)
    expect(contents.listenerCount('before-mouse-event')).toBe(0)
    expect(contents.close).toHaveBeenCalledOnce()
  })
})

describe('persistence and overlay fail closed', () => {
  it('ignores malformed, over-limit, duplicate, or unsafe persisted entries', () => {
    const directory = temporary()
    fs.writeFileSync(path.join(directory, 'workspace.json'), JSON.stringify({ version: 1, lanes: [
      { id: '../bad', tabs: [] }, { id: 'you', activeTabId: 't_bad',
        tabs: [{ id: 't_1', url: 'https://example.test/?secret=obviously-fake', title: 'Title' },
          { id: 't_1', url: 'https://duplicate.test/' }, { id: 't_2', url: 'file:///bad' }] },
      { id: 'profile:scout', tabs: Array.from({ length: 20 }, (_, i) => ({ id: `t_a${i}`, url: '' })) },
    ] }))
    const persistence = createPersistence({ userDataDir: directory })
    const restored = persistence.load()
    expect(restored.lanes.map((lane) => lane.id)).toEqual(['you', 'profile:scout'])
    expect(restored.lanes[0]).toEqual({ id: 'you', activeTabId: 't_1',
      tabs: [{ id: 't_1', url: 'https://example.test/', title: 'Title', sharedLogin: false, createdBy: 'user' }] })
    expect(restored.lanes[1].tabs).toHaveLength(8)
    fs.writeFileSync(path.join(directory, 'workspace.json'), 'not json')
    expect(persistence.load()).toBeNull()
  })

  it('does not forward arbitrary overlay scripts/invalid rectangles', () => {
    expect(validOverlayMessage({ type: 'script', source: 'bad' })).toBeNull()
    expect(validOverlayMessage({ type: 'cursor', x: Infinity, y: 0 })).toBeNull()
    expect(validOverlayMessage({ type: 'masks', rects: [{ x: 0, y: 0, width: -1, height: 1 }] })).toBeNull()
    expect(validOverlayMessage({ type: 'clear', source: 'bad' })).toEqual({ type: 'clear' })
  })

  it('refuses screenshot synchronization when no safe overlay is available', async () => {
    const mocks = electronMocks()
    const views = createViews({ ...mocks, BrowserWindow: null, getMainWindow: () => mocks.main,
      getLanes: () => null, urlPolicy: createUrlPolicy(), audit: { log: vi.fn() } })
    disposals.push(() => views.dispose())
    await expect(views.overlay.waitFrame()).rejects.toThrow('Overlay unavailable')
  })

  it('refuses malformed direct lane/tab calls outside IPC too', async () => {
    const lanes = createLanes({ urlPolicy: createUrlPolicy(), createView: () => new Contents(), destroyView: vi.fn() })
    disposals.push(() => lanes.dispose())
    expect(() => lanes.ensureLane('../bad')).toThrow('laneId')
    await expect(lanes.openTab('you', undefined, { createdBy: 'unknown' })).rejects.toThrow('creator')
    expect(() => lanes.setTabState('t_123', 'unknown')).toThrow('state')
    expect(() => lanes.closeTab('invalid')).toThrow('tabId')
  })
})
