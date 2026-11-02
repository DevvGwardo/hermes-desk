'use strict'

// This is a fixture adapter, NOT a VM security boundary or native Electron.
// Kernel confinement, no-fork and an independent deadline are imposed outside.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { METHODS } = require('./self-modification-authority.cjs')
const [source, home] = process.argv.slice(2)
const send = process.stdout.write.bind(process.stdout)
process.stdout.write = () => true // Dependency logging cannot become observations.
const handlers = new Map(), windows = [], navigations = {}
const quiet = () => {}
let ctx, main, permissionRequest, permissionCheck
const ses = { webRequest: { onBeforeSendHeaders: quiet },
  setPermissionRequestHandler: fn => { permissionRequest = fn },
  setPermissionCheckHandler: fn => { permissionCheck = fn } }
const app = new EventEmitter()
Object.assign(app, { isPackaged: true, requestSingleInstanceLock: () => true, whenReady: async () => {},
  getPath: () => path.join(home, 'userData'), getVersion: () => 'fixture', quit: quiet, exit: quiet, focus: quiet,
  dock: { hide: quiet, setIcon: quiet, bounce: quiet } })
class BrowserWindow extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.webContents = new EventEmitter()
    Object.assign(this.webContents, { id: windows.length + 1, mainFrame: {}, session: ses,
      isDestroyed: () => false, getURL: () => new URL('file://' + path.join(source, 'dist/index.html')).href,
      setWindowOpenHandler: fn => { this.popup = fn }, setBackgroundThrottling: quiet, send: quiet })
    Object.assign(this, { isDestroyed: () => false, loadFile: quiet, loadURL: quiet, show: quiet,
      showInactive: quiet, focus: quiet, setOpacity: quiet, setFocusable: quiet,
      isVisible: () => true, isFocused: () => false, isMinimized: () => false })
    main = this; windows.push(this); app.emit('browser-window-created', {}, this)
  }
  static getAllWindows() { return windows }
  static fromWebContents(contents) { return windows.find(win => win.webContents === contents) || null }
}
const electron = { app, BrowserWindow, WebContentsView: class {},
  Menu: { buildFromTemplate: items => ({ items }), setApplicationMenu: quiet },
  shell: { openExternal: quiet }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  dialog: { showMessageBox: async () => ({ response: 1 }) }, screen: {},
  globalShortcut: { register: () => true }, systemPreferences: {}, Tray: class {},
  nativeImage: {}, nativeTheme: new EventEmitter(), desktopCapturer: {}, session: { defaultSession: ses },
  clipboard: { writeText: quiet }, Notification: class { static isSupported() { return true } show() {} },
  protocol: { registerSchemesAsPrivileged: quiet, handle: quiet } }
const originalLoad = Module._load
Module._load = function(name, ...args) { return name === 'electron' ? electron : originalLoad.call(this, name, ...args) }
const fakeProcess = new EventEmitter()
Object.assign(fakeProcess, { platform: 'darwin', argv: [], env: { NUB_SMOKE: '1' },
  stdout: new EventEmitter(), stderr: new EventEmitter() })
const trustedRequire = Module.createRequire(__filename)
const media = { open: quiet, release: quiet, releaseOwner: quiet, clear: quiet, response: quiet }
fs.mkdirSync(path.join(home, 'userData'), { mode: 0o700 })
vm.runInNewContext(fs.readFileSync(path.join(source, 'electron/main.cjs'), 'utf8'), {
  __dirname: path.join(source, 'electron'), process: fakeProcess, URL, Buffer,
  setTimeout: () => 1, clearTimeout: quiet, console: { log: quiet, warn: quiet, error: quiet },
  require(name) {
    if (name === 'electron') return electron
    if (name === './media-protocol.cjs') return { createMediaProtocol: () => media }
    if (name === './plugin-host.cjs') return { registerPluginHostIpc: quiet }
    if (name === './local/boot.cjs') return value => {
      ctx = value
      value.ipcHandle('hd:host:status', () => ({ fixture: true }))
      return { ready: Promise.resolve() }
    }
    if (Module.builtinModules.includes(name) || Module.builtinModules.includes(name.replace(/^node:/, '')))
      return trustedRequire(name)
    const target = typeof name === 'string' && name.startsWith('./') ? path.resolve(__dirname, name) : ''
    if (!target.startsWith(__dirname + path.sep)) throw new Error('Unsupported fixture dependency')
    // Trusted fixture dependencies, not candidate dependency qualification.
    return trustedRequire(target)
  },
}, { timeout: 1500, filename: 'candidate-main.cjs' })

async function observations() {
  for (let i = 0; i < 20 && !ctx; i++) await new Promise(resolve => setTimeout(resolve, 10))
  if (!ctx || !main) throw new Error('Candidate did not initialize fixture host/window')
  const mainEvent = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  const foreign = { sender: new EventEmitter(), senderFrame: {} }
  const subframe = { ...mainEvent, senderFrame: {} }
  async function allowed(channel, event, ...args) {
    try {
      const handler = handlers.get(channel)
      if (!handler) return false
      const result = await handler(event, ...args)
      return result?.ok !== false
    } catch { return false }
  }
  const host = { main: await allowed('hd:host:status', mainEvent), foreign: await allowed('hd:host:status', foreign) }
  const changes = {}
  for (const [name, event] of Object.entries({ main: mainEvent, foreign, subframe }))
    changes[name] = await allowed('hd:changes:list', event)
  for (const [name, event] of [['navigate', 'will-navigate'], ['redirect', 'will-redirect']]) {
    let denied = false
    main.webContents.emit(event, { preventDefault: () => { denied = true } }, 'https://fixture.invalid/escape')
    navigations[name] = denied
  }
  navigations.popup = main.popup?.({ url: 'https://fixture.invalid/popup' })?.action === 'deny'
  let request = null
  permissionRequest?.(main.webContents, 'clipboard-read', value => { request = value }, {})
  const permissions = { request, check: permissionCheck?.(main.webContents, 'clipboard-read', '', {}) ?? null }
  let api, calls = []
  vm.runInNewContext(fs.readFileSync(path.join(source, 'electron/preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value } },
      ipcRenderer: { invoke: async (channel, ...args) => { calls.push({ channel, args }) } } }),
    process: { platform: 'darwin', versions: {} }, URL, Uint8Array, ArrayBuffer,
  }, { timeout: 1500, filename: 'candidate-preload.cjs' })
  const preload = {}
  for (const [name, args] of Object.entries(METHODS)) {
    calls = []
    await api?.changes?.[name]?.(...args)
    preload[name] = calls.length === 1 ? calls[0] : null
  }
  for (const name of Object.keys(api?.changes || {})) if (!Object.hasOwn(METHODS, name)) preload[name] = null
  const preferences = main.options.webPreferences
  return { preferences: { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation,
    nodeIntegration: preferences.nodeIntegration, preload: preferences.preload === path.join(source, 'electron/preload.cjs') ?
      'preload.cjs' : 'wrong-preload' },
    host, changes, navigation: navigations, permissions, preload }
}
observations().then(trace => {
  send(JSON.stringify(trace))
  process.exit(0)
}, () => process.exit(1))
