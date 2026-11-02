import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

async function loadMain({ isPackaged = true, env = {}, hudActions } = {}) {
  const handlers = new Map()
  const windows = []
  const media = {
    open: vi.fn(async () => 'hd-media://fixture/media'), release: vi.fn(),
    releaseOwner: vi.fn(), clear: vi.fn(), response: vi.fn(),
  }
  const fsAccess = require('./fs-access.cjs').createFsAccess({ home: '/synthetic-home', defaultRoot: '/synthetic-home/workspace' })
  fsAccess.ensure = vi.fn(async () => fsAccess.root())
  let ctx
  let win
  const ses = {
    webRequest: { onBeforeSendHeaders: vi.fn() },
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
  }
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.webContents = new EventEmitter()
      Object.assign(this.webContents, {
        session: ses, mainFrame: {}, id: 1, isDestroyed: () => false,
        setWindowOpenHandler: vi.fn(), setBackgroundThrottling: vi.fn(), send: vi.fn(),
      })
      Object.assign(this, {
        isDestroyed: () => false, loadFile: vi.fn(), loadURL: vi.fn(), show: vi.fn(), showInactive: vi.fn(), focus: vi.fn(),
        setOpacity: vi.fn(), setFocusable: vi.fn(),
        isVisible: () => true, isFocused: () => false, isMinimized: () => false,
      })
      win = this
      windows.push(this)
      app.emit('browser-window-created', {}, this)
    }
    static getAllWindows() { return win ? [win] : [] }
    static fromWebContents(sender) { return sender === win?.webContents ? win : null }
  }
  const app = new EventEmitter()
  Object.assign(app, { isPackaged, requestSingleInstanceLock: () => true,
    whenReady: async () => {}, getPath: () => '/obviously-fake-user-data', getVersion: () => '0.1.0',
    quit: vi.fn(), exit: vi.fn(), focus: vi.fn(),
    dock: { hide: vi.fn(), setIcon: vi.fn(), bounce: vi.fn() } })
  const electron = {
    app, BrowserWindow, WebContentsView: class {},
    Menu: { buildFromTemplate: (template) => ({ items: template }), setApplicationMenu: vi.fn() },
    shell: { openExternal: vi.fn(async () => {}) },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
    screen: {}, globalShortcut: { register: () => true },
    systemPreferences: {}, Tray: class {}, nativeImage: {}, nativeTheme: new EventEmitter(),
    desktopCapturer: {}, session: { defaultSession: ses }, clipboard: { writeText: vi.fn() },
    Notification: class { static isSupported() { return true } show() {} },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  }
  const fakeProcess = new EventEmitter()
  Object.assign(fakeProcess, { platform: 'darwin', argv: [], env: { NUB_SMOKE: '1', ...env },
    stdout: new EventEmitter(), stderr: new EventEmitter() })
  runInNewContext(readFileSync(require.resolve('./main.cjs'), 'utf8'), {
    __dirname: fileURLToPath(new URL('./', import.meta.url)),
    require(name) {
      if (name === 'electron') return electron
      if (hudActions && name === './hud-action-consent.cjs') return {
        createHudActionConsent: options => require(name).createHudActionConsent({ ...options, run: hudActions.run }),
      }
      if (hudActions && name === './screen-act.cjs') return {
        ...require(name), actStatus: () => ({ trusted: true, platform: 'darwin' }),
      }
      if (hudActions && name === 'child_process') return { ...require(name), execFile: hudActions.execFile }
      if (name === './media-protocol.cjs') return { createMediaProtocol: () => media }
      if (name === './fs-access.cjs') return { createFsAccess: () => fsAccess }
      if (name === './plugin-host.cjs') return { registerPluginHostIpc: () => {} }
      if (name === './local/boot.cjs') return (value) => {
        ctx = value
        value.ipcHandle('hd:host:status', () => ({ serve: { state: 'down' } }))
        return { ready: Promise.resolve() }
      }
      return require(name)
    },
    process: fakeProcess, URL, Buffer, setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })
  await vi.waitFor(() => expect(ctx).toBeTruthy())
  return { ctx, win, windows, handlers, electron, ses, media }
}

describe('Electron foundation wiring', () => {
  it.each([false, true])('dispatches HUD typing only after native permission (%s) and target revalidation', async approved => {
    const run = vi.fn(async () => ({ stdout: '424242, org.synthetic.Editor\n' }))
    const execFile = vi.fn((_bin, _args, _options, done) => done(null, '', ''))
    const { win, windows, handlers, electron } = await loadMain({ hudActions: { run, execFile } })
    electron.dialog.showMessageBox.mockResolvedValue({ response: approved ? 1 : 0 })
    await handlers.get('maia:hud:open')({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
    const hud = windows.at(-1)
    const result = await handlers.get('maia:hud:typeText')({
      sender: hud.webContents, senderFrame: hud.webContents.mainFrame,
    }, { text: 'Synthetic text\nwith an escaped newline' })
    expect(result).toMatchObject({ ok: approved })
    expect(execFile).toHaveBeenCalledTimes(approved ? 1 : 0)
    if (approved) {
      expect(run).toHaveBeenCalledTimes(4)
      expect(execFile.mock.calls[0][2]).toMatchObject({ timeout: 5000, shell: false })
      expect(electron.dialog.showMessageBox.mock.calls[0][1].detail).toContain('\\n')
    }
  })
  it('revokes the pending workspace chooser on navigation and refuses simultaneous choosers', async () => {
    const { win, handlers, electron } = await loadMain()
    let answer
    electron.dialog.showOpenDialog = vi.fn(() => new Promise(resolve => { answer = resolve }))
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    const pending = handlers.get('maia:fs:chooseRoot')(event)
    expect(await handlers.get('maia:fs:chooseRoot')(event)).toMatchObject({ ok: false })
    win.webContents.emit('did-start-navigation', {}, 'synthetic', false, true)
    answer({ canceled: false, filePaths: ['/synthetic-home/selected'] })
    expect(await pending).toMatchObject({ ok: false })
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledOnce()
  })
  it('rejects legacy host capabilities from the HUD and all subframes', async () => {
    const { win, windows, handlers } = await loadMain()
    const main = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    await handlers.get('maia:hud:open')(main)
    const hud = windows.at(-1)
    expect(hud.options.webPreferences.preload).toMatch(/hud-preload\.cjs$/)
    for (const event of [{ sender: hud.webContents, senderFrame: hud.webContents.mainFrame },
      { sender: win.webContents, senderFrame: {} }]) {
      for (const channel of ['maia:hermes', 'maia:kanban', 'maia:task',
        'maia:secretsCopy', 'maia:secretsCreate', 'maia:secretsUpdateValue']) {
        expect(() => handlers.get(channel)(event, 'synthetic', [])).toThrow('IPC sender rejected')
      }
    }
    for (const file of ['/synthetic-home/.hermes/serve.token', '/synthetic-home/.ssh/id_rsa',
      '/synthetic-home/Library/settings.json']) {
      expect(await handlers.get('maia:hermes')(main, 'fs', ['read-text', file])).toMatchObject({ ok: false })
      await expect(handlers.get('maia:hermes')(main, 'fs', ['write-text', file, 'synthetic'])).rejects.toThrow()
    }
  })
  it('requires native consent before all supported legacy CLI mutations', async () => {
    const { win, handlers, electron } = await loadMain()
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    for (const [kind, args] of [
      ['mcp', ['add', 'synthetic', '--command', '/bin/echo']],
      ['cron', ['create', '--name', 'synthetic', '--prompt', 'synthetic', '--schedule', '0 9 * * *']],
      ['kanban', ['dispatch', '--max', '1']],
    ]) expect(await handlers.get('maia:hermes')(event, kind, args)).toMatchObject({ ok: false, error: 'cancelled' })
    expect(await handlers.get('maia:task')(event, ['add', 'Synthetic task'])).toMatchObject({ ok: false, error: 'cancelled' })
    expect(await handlers.get('maia:secretsCopy')(event, 'op://synthetic/item/password')).toMatchObject({ ok: false, error: 'cancelled' })
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(5)
  })
  it('issues media capabilities only to the main top frame and revokes them on navigation, crash and close', async () => {
    const { win, windows, handlers, media } = await loadMain()
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    await handlers.get('maia:hud:open')(event)
    const hud = windows.at(-1)
    for (const bad of [{ sender: {} }, { sender: win.webContents, senderFrame: {} },
      { sender: hud.webContents, senderFrame: hud.webContents.mainFrame }]) {
      for (const method of ['open', 'release']) expect(() =>
        handlers.get(`hd:media:${method}`)(bad, '/fake/clip.mp4')).toThrow('IPC sender rejected')
      for (const method of ['pickMedia', 'saveAs', 'releaseImport']) expect(() =>
        handlers.get(`hd:files:${method}`)(bad, '/fake/clip.mp4')).toThrow('IPC sender rejected')
    }
    expect(() => handlers.get('hd:files:pickMedia')(event, '/fake/clip.mp4')).toThrow('Invalid file request')
    expect(() => handlers.get('hd:files:saveAs')(event, '/fake/clip.mp4', '/fake/destination')).toThrow('Invalid file request')
    for (const value of [null, {}, 'x'.repeat(4097)]) expect(() =>
      handlers.get('hd:media:open')(event, value)).toThrow('Invalid media request')
    expect(media.open).not.toHaveBeenCalled()
    const url = await handlers.get('hd:media:open')(event, '/fake/clip.mp4')
    expect(media.open).toHaveBeenCalledExactlyOnceWith('/fake/clip.mp4', win.webContents.id)
    await handlers.get('hd:media:release')(event, url)
    expect(media.release).toHaveBeenCalledExactlyOnceWith(url, win.webContents.id)
    win.webContents.emit('did-start-navigation', {}, 'file:///fake', true, true)
    win.webContents.emit('did-start-navigation', {}, 'file:///fake', false, false)
    expect(media.releaseOwner).not.toHaveBeenCalled()
    win.webContents.emit('did-start-navigation', {}, 'file:///fake', false, true)
    win.webContents.emit('render-process-gone', {}, { reason: 'fixture-crash' })
    win.webContents.emit('destroyed')
    expect(media.releaseOwner.mock.calls).toEqual([[1], [1], [1]])
  })
  it('refuses main-window and HUD-subframe senders for HUD movement and OS input', async () => {
    const { win, handlers, electron, windows } = await loadMain()
    const mainEvent = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    await handlers.get('maia:hud:open')(mainEvent)
    const hud = windows.at(-1)
    expect(hud).not.toBe(win)
    for (const event of [mainEvent]) {
      for (const channel of ['moveTo', 'clickAt', 'typeText']) {
        expect(await handlers.get(`maia:hud:${channel}`)(event, { x: 10, y: 20, text: 'Fake text' }))
          .toMatchObject({ ok: false, error: 'IPC sender rejected' })
      }
    }
    for (const channel of ['moveTo', 'clickAt', 'typeText']) {
      expect(() => handlers.get(`maia:hud:${channel}`)({ sender: hud.webContents, senderFrame: {} }, {}))
        .toThrow('IPC sender rejected')
    }
    expect(electron.systemPreferences).toEqual({})
  })

  it('rejects oversized HUD typing before checking accessibility or spawning input', async () => {
    const { win, handlers, windows } = await loadMain()
    await handlers.get('maia:hud:open')({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
    const hud = windows.at(-1)
    const event = { sender: hud.webContents, senderFrame: hud.webContents.mainFrame }
    expect(await handlers.get('maia:hud:typeText')(event, { text: 'x'.repeat(4097) }))
      .toMatchObject({ ok: false, error: 'text-too-large' })
    expect(await handlers.get('maia:hud:typeText')(event, { text: 'x'.repeat(4096) }))
      .toMatchObject({ ok: false, error: 'accessibility-not-trusted' })
  })

  it('blocks redirect destinations off the app shell in both preload-bearing windows', async () => {
    const { win, handlers, windows } = await loadMain()
    await handlers.get('maia:hud:open')({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
    for (const target of [win, windows.at(-1)]) {
      const preventDefault = vi.fn()
      target.webContents.emit('will-redirect', { preventDefault }, 'https://example.invalid/redirected')
      expect(preventDefault).toHaveBeenCalledOnce()
    }
    const preventDefault = vi.fn()
    const appUrl = new URL('../dist/index.html', import.meta.url).href
    win.webContents.emit('will-redirect', { preventDefault }, appUrl)
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('writes plain text only from the main window top frame without granting browser permissions', async () => {
    const { handlers, win, electron, ses } = await loadMain()
    const write = handlers.get('hd:clipboard:writeText')
    expect(write).toBeTypeOf('function')
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    await write(event, 'Obviously fake chat text\nsecond line')
    expect(electron.clipboard.writeText).toHaveBeenCalledExactlyOnceWith('Obviously fake chat text\nsecond line')
    const request = ses.setPermissionRequestHandler.mock.calls[0][0]
    const check = ses.setPermissionCheckHandler.mock.calls[0][0]
    const verdict = vi.fn()
    request(win.webContents, 'clipboard-sanitized-write', verdict, {})
    expect(verdict).toHaveBeenCalledWith(false)
    expect(check(win.webContents, 'clipboard-read', '', {})).toBe(false)
  })

  it('rejects foreign senders, subframes, invalid text and clipboard failures without exposing text', async () => {
    const { handlers, win, electron } = await loadMain()
    const write = handlers.get('hd:clipboard:writeText')
    expect(write).toBeTypeOf('function')
    for (const event of [{ sender: {} }, { sender: win.webContents },
      { sender: win.webContents, senderFrame: {} }]) {
      expect(() => write(event, 'Obviously fake text')).toThrow('IPC sender rejected')
    }
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    for (const text of [null, {}, 42, 'x'.repeat(1_000_001)]) {
      expect(() => write(event, text)).toThrow('Invalid clipboard text')
    }
    expect(electron.clipboard.writeText).not.toHaveBeenCalled()
    electron.clipboard.writeText.mockImplementationOnce(() => { throw new Error('Private fixture detail') })
    expect(() => write(event, 'Obviously fake text')).toThrow('Clipboard unavailable')
  })

  it('registers scoped avatars without bypassing CSP and returns the guarded default Files root', async () => {
    const { electron, handlers, win } = await loadMain()
    expect(electron.protocol.registerSchemesAsPrivileged).toHaveBeenCalledExactlyOnceWith([
      { scheme: 'hd-candidate', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
      { scheme: 'hd-avatar', privileges: { standard: true, secure: true } },
      { scheme: 'hd-media', privileges: { standard: true, secure: true, stream: true } },
    ])
    expect(electron.protocol.handle).toHaveBeenCalledWith('hd-media', expect.any(Function))
    expect(electron.protocol.handle).toHaveBeenCalledWith('hd-avatar', expect.any(Function))
    const sender = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    expect(await handlers.get('maia:hermes')(sender, 'fs', ['defaultRoot'])).toEqual({
      ok: true, data: '/synthetic-home/workspace',
    })
    await expect(handlers.get('maia:hermes')(sender, 'fs', ['defaultRoot', '/fake/path'])).rejects.toThrow('Invalid filesystem operation')
  })

  it('boots once with a main window, all contract dependencies, and hardened file-loaded preferences', async () => {
    const { ctx, win, electron } = await loadMain()
    expect(ctx.getMainWindow()).toBe(win)
    for (const key of ['app', 'ipcMain', 'BrowserWindow', 'WebContentsView', 'session', 'dialog', 'shell']) {
      expect(ctx[key]).toBe(electron[key])
    }
    expect(ctx.userDataDir).toBe('/obviously-fake-user-data')
    expect(ctx).toHaveProperty('secretsOp')
    expect(ctx).toHaveProperty('notify')
    expect(win.options).toMatchObject({ title: 'Hermes Desk', webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
    } })
    expect(win.loadURL).not.toHaveBeenCalled()
    expect(win.loadFile).toHaveBeenCalledWith(expect.stringMatching(/dist\/index\.html$/))
  })

  it('rejects untrusted senders and returns token presence without exposing host credentials', async () => {
    const { ctx, win, handlers, ses } = await loadMain()
    expect(() => handlers.get('hd:host:status')({ sender: {} })).toThrow('IPC sender rejected')
    expect(handlers.get('hd:host:status')({ sender: win.webContents, senderFrame: win.webContents.mainFrame })).toEqual({ serve: { state: 'down' } })
    await ctx.serveAuth.setEndpoint({ baseUrl: 'http://127.0.0.1:9133',
      auth: { token: 'obviously-fake-launch-token', source: 'env' },
      verifyPeer: async () => false,
      client: { bindRendererBroker: (broker) => broker },
    })
    const config = await handlers.get('maia:serveConfig')({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
    expect(config).toMatchObject({ baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), present: true })
    expect(config.baseUrl).not.toBe('http://127.0.0.1:9133')
    expect(JSON.stringify(config)).not.toContain('obviously-fake-launch-token')
    expect(ses.webRequest.onBeforeSendHeaders).toHaveBeenLastCalledWith({
      urls: [`${config.baseUrl}/*`],
    }, expect.any(Function))
    const inject = ses.webRequest.onBeforeSendHeaders.mock.calls.at(-1)[1]
    const headers = await new Promise((resolve) => inject({
      url: `${config.baseUrl}/api/status`, method: 'GET', resourceType: 'xhr', webContentsId: win.webContents.id,
      frame: win.webContents.mainFrame, requestHeaders: {},
    }, resolve))
    expect(headers.requestHeaders['X-Hermes-Session-Token']).toBeTypeOf('string')
    expect(headers.requestHeaders['X-Hermes-Session-Token']).not.toBe('obviously-fake-launch-token')
    ctx.serveAuth.clearEndpoint()
    expect(await handlers.get('maia:serveConfig')({ sender: win.webContents, senderFrame: win.webContents.mainFrame })).toMatchObject({ present: false })
    expect([...handlers.keys()].some((key) => /^maia:(?:nub|update)/.test(key))).toBe(false)
  })

  it('requires confirmation for external links, including former platform allowlisted hosts', async () => {
    const { win, handlers, electron } = await loadMain()
    const sender = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    for (const channel of ['maia:openExternal', 'maia:openHttps']) {
      expect(await handlers.get(channel)(sender, 'https://www.maiavm.com/')).toMatchObject({ ok: false })
      expect(electron.shell.openExternal).not.toHaveBeenCalled()
      await expect(handlers.get(channel)(sender, 'https://fake:password@example.invalid')).rejects.toThrow('Invalid URL')
    }
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    expect(await handlers.get('maia:openHttps')(sender, 'https://example.invalid/')).toEqual({ ok: true })
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.invalid/')
  })

  it('HD-09: popup links use the same default-deny native confirmation before opening', async () => {
    const { win, electron } = await loadMain()
    const popup = win.webContents.setWindowOpenHandler.mock.calls[0][0]
    let answer
    electron.dialog.showMessageBox.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    expect(popup({ url: 'https://example.invalid/popup' })).toEqual({ action: 'deny' })
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(win, expect.objectContaining({
      defaultId: 1, cancelId: 1, detail: 'https://example.invalid/popup',
    }))
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
    answer({ response: 1 })
    await Promise.resolve()
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
    popup({ url: 'https://example.invalid/approved' })
    answer({ response: 0 })
    await vi.waitFor(() => expect(electron.shell.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.invalid/approved'))
    const count = electron.dialog.showMessageBox.mock.calls.length
    for (const url of ['http://example.invalid/', 'javascript:alert(1)', 'https://fake:password@example.invalid/']) popup({ url })
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(count)
  })

  it('keeps unpackaged background E2E windows off-screen and never focuses or bounces the app', async () => {
    const { ctx, win, electron, handlers } = await loadMain({
      isPackaged: false, env: { HERMES_DESK_E2E_BACKGROUND: '1' },
    })
    expect(ctx.e2eBackground).toBe(true)
    expect(win.options).toMatchObject({ x: -2000, y: 100, focusable: false, show: false })
    win.emit('ready-to-show')
    electron.app.emit('second-instance')
    expect(win.showInactive).toHaveBeenCalledTimes(2)
    expect(win.show).not.toHaveBeenCalled()
    expect(win.focus).not.toHaveBeenCalled()
    expect(win.setOpacity).toHaveBeenCalledWith(0)
    expect(win.setFocusable).toHaveBeenCalledWith(false)
    expect(electron.app.focus).not.toHaveBeenCalled()
    expect(electron.app.dock.hide).toHaveBeenCalledOnce()
    expect(electron.app.dock.bounce).not.toHaveBeenCalled()
    await handlers.get('maia:notify')({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, { title: 'Fake E2E', body: 'Fake completion' })
    expect(electron.app.dock.bounce).not.toHaveBeenCalled()
  })

  it('packaged builds ignore background E2E flags', async () => {
    const { ctx, win, electron } = await loadMain({
      isPackaged: true, env: { HERMES_DESK_E2E_BACKGROUND: '1', HERMES_DESK_E2E: '1' },
    })
    expect(ctx.e2eBackground).toBe(false)
    expect(win.options).not.toHaveProperty('x')
    expect(win.options).not.toHaveProperty('focusable')
    win.emit('ready-to-show')
    expect(win.show).toHaveBeenCalledOnce()
    expect(win.showInactive).not.toHaveBeenCalled()
    expect(win.setOpacity).not.toHaveBeenCalled()
    expect(win.setFocusable).not.toHaveBeenCalled()
    expect(electron.app.dock.hide).not.toHaveBeenCalled()
    expect(win.loadFile).toHaveBeenCalled()
  })
})
