import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { registerComputerPip, captureSource, parsePipState, imageDataUrl, STATE_FILE } = require('./computer-pip.cjs')
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz8AAAAASUVORK5CYII='
const roots = []
const instances = []
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'hermes-desk-pip-'))
  roots.push(root)
  const handlers = new Map()
  const events = new Set()
  const windows = []
  let selected = { runtimeId: 'runtime-fake-alan', agentName: 'Alan', color: '#aa55cc' }
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.bounds = { x: 50, y: 60, width: options.width, height: options.height, ...options }
      this.destroyed = false
      const wc = new EventEmitter()
      wc.mainFrame = {}
      wc.url = ''
      wc.send = vi.fn()
      wc.getURL = () => wc.url
      wc.setWindowOpenHandler = vi.fn()
      wc.handlers = new Map()
      wc.ipc = { handle: (name, callback) => wc.handlers.set(name, callback) }
      const session = new EventEmitter()
      session.setPermissionRequestHandler = vi.fn()
      session.setPermissionCheckHandler = vi.fn()
      session.webRequest = { onBeforeRequest: vi.fn() }
      wc.session = session
      this.webContents = wc
      this.showInactive = vi.fn()
      this.setOpacity = vi.fn()
      this.setAlwaysOnTop = vi.fn()
      this.setVisibleOnAllWorkspaces = vi.fn()
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    getBounds() {
      const { x, y, width, height } = this.bounds
      return { x, y, width, height }
    }
    loadFile(file) {
      this.webContents.url = pathToFileURL(file).href
      this.webContents.emit('did-finish-load')
      this.emit('ready-to-show')
      return Promise.resolve()
    }
    close() { this.emit('close'); this.destroyed = true; this.emit('closed') }
  }
  const main = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const ctx = {
    userDataDir: root, BrowserWindow: FakeWindow, getMainWindow: () => main,
    ipcHandle: (channel, handler) => handlers.set(channel, handler),
    ipcMain: { removeHandler: vi.fn((channel) => handlers.delete(channel)) },
    assertMainSender: (event) => {
      if (event.sender !== main.webContents) throw new Error('Fake sender rejected')
    },
    getComputerSession: vi.fn(() => selected),
    computerRequest: vi.fn(async () => ({ ready: true, accessibility: true, screen_recording: false })),
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1400, height: 900 } }) },
    clipboard: { readText: vi.fn(() => 'obviously fake ordinary text') },
    redactor: { looksLikeSecret: vi.fn(() => false) },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
    serveClient: {
      call: vi.fn(async (method) => method === 'session.interrupt' ? { status: 'interrupted' } :
        method === 'session.active_list' ? { sessions: [{ id: 'runtime-fake-alan' }] } : { status: 'queued' }),
      onEvent: (cb) => { events.add(cb); return () => events.delete(cb) },
    },
    ...extra,
  }
  const pip = registerComputerPip(ctx)
  instances.push(pip)
  const emit = (name, payload, sessionId = 'runtime-fake-alan', seq = 10) => {
    for (const cb of events) cb(name, { type: name, session_id: sessionId, payload, seq })
  }
  const complete = (result = { _multimodal: true, content: [{ type: 'image_url', image_url: { url: image } }],
    meta: { width: 100, height: 80 } }, args = {}, sessionId, seq) =>
    emit('tool.complete', { tool_id: 'fake-tool-1', name: 'computer_use', result, args }, sessionId, seq)
  const frames = () => main.webContents.send.mock.calls.filter(([name, value]) =>
    name === 'hd:computer:frame' && value.dataUrl).map(([, value]) => value)
  const states = () => main.webContents.send.mock.calls.filter(([name]) => name === 'hd:computer:state').map(([, value]) => value)
  const invoke = (name, ...args) => handlers.get(`hd:computer:${name}`)({ sender: main.webContents }, ...args)
  return { ctx, pip, main, root, windows, handlers, events, emit, complete, frames, states, invoke,
    select: (value) => { selected = value } }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-06T14:00:00Z')) })
afterEach(() => {
  for (const pip of instances.splice(0)) pip.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

describe('completed capture source', () => {
  it('accepts the real multimodal, MCP and structured result shapes without treating readiness as a frame', () => {
    const inline = { _multimodal: true, content: [{ type: 'image_url', image_url: { url: image } }],
      meta: { width: 100, height: 80, bounds_scale: 2 } }
    expect(captureSource(JSON.stringify(inline))).toMatchObject({ dataUrl: image, width: 100, height: 80, boundsScale: 2 })
    const b64 = image.split(',')[1]
    expect(captureSource({ images: [b64], image_mime_types: ['image/png'] })?.dataUrl).toBe(image)
    expect(captureSource({ structuredContent: { screenshot_png_b64: b64, screenshot_mime_type: 'image/png' } })?.dataUrl).toBe(image)
    expect(captureSource({ content: [{ type: 'image', data: b64, mimeType: 'image/png' }] })?.dataUrl).toBe(image)
    const fixturePath = new URL('../../tests/fixtures/serve-ws/phase0-computer-status.jsonl', import.meta.url)
    const status = JSON.parse(readFileSync(fixturePath, 'utf8')).response.body
    expect(captureSource(status)).toBeNull()
  })

  it('accepts only named completed media paths and bounded raster data URLs', () => {
    expect(captureSource({ screenshot_path: '/fake/profile/cache/images/computer_use_fake.jpg' })?.mediaPath)
      .toBe('/fake/profile/cache/images/computer_use_fake.jpg')
    for (const value of ['https://example.invalid/capture.jpg', 'file:///fake/private.png',
      'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,a'.repeat(4 * 1024 * 1024)]) {
      expect(imageDataUrl(value)).toBeNull()
    }
    for (const result of [{ screenshot_path: '/fake/.env' }, { screenshot_path: 'computer_use_fake.png' },
      { error: 'fake-error', data_url: image }, { ok: false, data_url: image }, '{not-json']) {
      expect(captureSource(result)).toBeNull()
    }
  })
})

describe('Computer PiP host', () => {
  it('notifies host/tray state when a floating window is closed natively', async () => {
    const onState = vi.fn()
    const f = fixture({ onState })
    await f.invoke('open', 'alan', { docked: false })
    expect(f.pip.status().open).toBe(true)
    f.windows[0].close()
    expect(f.pip.status().open).toBe(false)
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }))
  })
  it('keeps named-profile media scoped and explains a media-root refusal without a filesystem fallback', async () => {
    const f = fixture()
    await f.invoke('open', 'alan', { docked: true })
    f.ctx.computerRequest.mockRejectedValueOnce(new Error('fake media-root refusal'))
    f.complete({ screenshot_path: '/fake/alan/cache/images/computer_use_fake.png' })
    await flush()
    expect(f.ctx.computerRequest).toHaveBeenCalledWith(expect.stringContaining('profile=alan'))
    expect(f.states().at(-1).detail).toContain('this profile’s media roots')
    expect(f.frames()).toEqual([])
  })
  it.each([false, true])('only places floating E2E previews off-screen when unpackaged (packaged=%s)', async (isPackaged) => {
    const f = fixture({ app: { isPackaged }, e2eBackground: true })
    await f.invoke('open', 'alan', { docked: false })
    const win = f.windows[0]
    if (isPackaged) {
      expect(win.options).not.toHaveProperty('focusable')
      expect(win.options).not.toHaveProperty('x')
      expect(win.setOpacity).not.toHaveBeenCalled()
    } else {
      expect(win.options).toMatchObject({ x: -2000, y: 100, focusable: false })
      expect(win.setOpacity).toHaveBeenCalledWith(0)
    }
    expect(win.showInactive).toHaveBeenCalled()
  })

  it('registers only allowlisted, main-sender-checked handlers and validates arguments', async () => {
    const f = fixture()
    expect([...f.handlers.keys()].sort()).toEqual(['hd:computer:close', 'hd:computer:open', 'hd:computer:paste', 'hd:computer:takeControl'])
    expect(() => f.handlers.get('hd:computer:open')({ sender: {} }, 'alan')).toThrow('Fake sender rejected')
    for (const value of ['../alan', 'profile:alan', '', 'Alan', 'a'.repeat(65)]) {
      await expect(f.invoke('open', value)).rejects.toMatchObject({ code: 'bad_args' })
    }
    await expect(f.invoke('open', 'alan', { docked: true, arbitrary: true })).rejects.toMatchObject({ code: 'bad_args' })
    expect(() => f.invoke('paste', 'FAKE_SECRET_RENDERER_TEXT')).toThrow('Invalid Computer PiP arguments')
    expect(f.windows).toHaveLength(0)
  })

  it('uses hardened HUD options, only scoped PiP IPC, and denies navigation, network, permissions and downloads', async () => {
    const f = fixture()
    await f.invoke('open', 'alan')
    const w = f.windows[0]
    expect(w.options).toMatchObject({ frame: false, alwaysOnTop: true, transparent: true, roundedCorners: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false,
        webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false } })
    expect(w.options.webPreferences.preload).toBe(fileURLToPath(new URL('./pip-preload.cjs', import.meta.url)))
    expect(w.webContents.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://example.invalid' })).toEqual({ action: 'deny' })
    for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview']) {
      const event = { preventDefault: vi.fn() }
      w.webContents.emit(name, event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    const callback = vi.fn()
    w.webContents.session.setPermissionRequestHandler.mock.calls[0][0]({}, 'media', callback)
    expect(callback).toHaveBeenCalledWith(false)
    expect(w.webContents.session.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false)
    const download = { preventDefault: vi.fn() }
    w.webContents.session.emit('will-download', download)
    expect(download.preventDefault).toHaveBeenCalledOnce()
    const network = w.webContents.session.webRequest.onBeforeRequest.mock.calls[0][1]
    for (const url of ['http://127.0.0.1:9119/api/status', 'https://example.invalid', 'file:///fake/private.txt']) {
      network({ url }, callback)
      expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    }
    network({ url: w.webContents.getURL() }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: false })
    expect([...w.webContents.handlers.keys()].sort()).toEqual(['hd:computer:close', 'hd:computer:paste', 'hd:computer:takeControl'])
    const control = w.webContents.handlers.get('hd:computer:takeControl')
    expect(() => control({ sender: w.webContents, senderFrame: {} })).toThrow('Computer PiP sender rejected')
    await control({ sender: w.webContents, senderFrame: w.webContents.mainFrame })
    expect(f.states().at(-1).mode).toBe('user-control')
    expect(w.showInactive).toHaveBeenCalled()
  })

  it('shows only completed computer_use images for the selected runtime session and overlays its point', async () => {
    const f = fixture()
    await f.pip.open('alan')
    f.emit('tool.start', { name: 'computer_use', result: { data_url: image } })
    f.emit('tool.complete', { name: 'browser_screenshot', result: { data_url: image } })
    f.complete(undefined, {}, 'runtime-fake-scout')
    await flush()
    expect(f.frames()).toHaveLength(0)
    f.complete(undefined, { coordinate: [25, 20] })
    await flush()
    expect(f.frames().at(-1)).toMatchObject({ dataUrl: image, profile: 'alan', sessionId: 'runtime-fake-alan', ts: Date.now() })
    expect(f.states().at(-1)).toMatchObject({ source: 'completed-capture', mode: 'watching',
      lastAction: { x: 25, y: 20, color: '#aa55cc', width: 100, height: 80 } })
    f.complete({ ok: true, action: 'click' }, { coordinate: [50, 40] }, undefined, 11)
    await flush()
    expect(f.states().at(-1).lastAction).toMatchObject({ x: 50, y: 40 })
    f.complete(undefined, { coordinate: [1, 1] }, undefined, 10)
    await flush()
    expect(f.frames()).toHaveLength(1)
    expect(f.states().at(-1).lastAction).toMatchObject({ x: 50, y: 40 })
  })

  it('polls readiness no faster than every five seconds, never uses status images, and stops on close/dispose', async () => {
    const f = fixture({ computerRequest: vi.fn(async () => ({ ready: true, data_url: image })) })
    await f.pip.open('alan')
    await flush()
    expect(f.ctx.computerRequest).toHaveBeenCalledExactlyOnceWith('/api/tools/computer-use/status?profile=alan')
    expect(f.frames()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(4999)
    expect(f.ctx.computerRequest).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.ctx.computerRequest).toHaveBeenCalledTimes(2)
    f.pip.close()
    await vi.advanceTimersByTimeAsync(20000)
    expect(f.ctx.computerRequest).toHaveBeenCalledTimes(2)
    f.pip.dispose()
    expect(f.events.size).toBe(0)
    expect(f.handlers.size).toBe(0)
  })

  it('loads authenticated media references, rejects bad image replies and drops stale async loads', async () => {
    const media = deferred()
    const f = fixture({ computerRequest: vi.fn((url) => url.startsWith('/api/media?') ? media.promise : Promise.resolve({ ready: true })) })
    await f.pip.open('alan')
    f.complete({ screenshot_path: '/fake/alan/cache/images/computer_use_fake.png', width: 100, height: 80 })
    await flush()
    expect(f.ctx.computerRequest).toHaveBeenCalledWith('/api/media?path=%2Ffake%2Falan%2Fcache%2Fimages%2Fcomputer_use_fake.png&profile=alan')
    f.complete(undefined, {}, undefined, 11)
    await flush()
    media.resolve({ data_url: 'data:image/svg+xml;base64,PHN2Zz4=' })
    await flush()
    expect(f.frames()).toHaveLength(1)
    expect(f.frames()[0].dataUrl).toBe(image)
    expect(f.states().at(-1).detail).toBeUndefined()
  })

  it('clears another session or profile preview before switching and does not guess among multiple sessions', async () => {
    const f = fixture()
    await f.pip.open('alan')
    f.complete()
    await flush()
    f.select({ runtimeId: 'runtime-fake-alan-new' })
    f.emit('session.info', {})
    await flush()
    expect(f.states().at(-1).sessionId).toBe('runtime-fake-alan-new')
    expect(f.main.webContents.send).toHaveBeenCalledWith('hd:computer:frame', { dataUrl: '', ts: 0 })
    f.complete(undefined, {}, 'runtime-fake-alan-new')
    await flush()
    f.select({ runtimeId: 'runtime-fake-scout', agentName: 'Scout' })
    await f.pip.open('scout', { docked: true })
    expect(f.states().at(-1)).toMatchObject({ profile: 'scout', sessionId: 'runtime-fake-scout', mode: 'watching' })
    const ambiguous = fixture({ getComputerSession: undefined })
    ambiguous.ctx.serveClient.call.mockResolvedValue({ sessions: [{ id: 'fake-a' }, { id: 'fake-b' }] })
    await ambiguous.pip.open('alan', { docked: true })
    expect(ambiguous.states().at(-1).sessionId).toBeUndefined()
    await expect(ambiguous.invoke('takeControl')).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('uses an unambiguous active-list runtime id when no selector is available', async () => {
    const f = fixture({ getComputerSession: undefined })
    await f.pip.open('alan', { docked: true })
    expect(f.ctx.serveClient.call).toHaveBeenCalledWith('session.active_list', { profile: 'alan' })
    expect(f.states().at(-1).sessionId).toBe('runtime-fake-alan')
  })

  it('interrupts only the selected session, does not invent a CUA stop RPC, and fails honestly', async () => {
    const f = fixture()
    await f.pip.open('alan', { docked: true })
    f.ctx.serveClient.call.mockRejectedValue(new Error('fake error with FAKE_SENSITIVE_CONTENT'))
    await expect(f.invoke('takeControl')).rejects.toThrow('Unable to interrupt')
    expect(f.states().at(-1).mode).toBe('watching')
    f.ctx.serveClient.call.mockResolvedValue({ status: 'not_interrupted' })
    await f.invoke('takeControl')
    expect(f.ctx.serveClient.call).toHaveBeenLastCalledWith('session.interrupt', { session_id: 'runtime-fake-alan', profile: 'alan' })
    expect(f.states().at(-1)).toMatchObject({ mode: 'user-control' })
    expect(f.states().at(-1).detail).toContain('in-flight native action')
    expect(f.ctx.serveClient.call.mock.calls.some(([name]) => name.startsWith('computer_use') || name.startsWith('display.'))).toBe(false)
  })

  it('keeps user-control when floating or docking and never sends paste while it is user-controlled', async () => {
    const f = fixture()
    await f.pip.open('alan', { docked: true })
    await f.invoke('takeControl')
    await f.pip.open('alan', { docked: false })
    expect(f.states().at(-1)).toMatchObject({ mode: 'user-control', docked: false })
    await expect(f.invoke('paste')).rejects.toMatchObject({ code: 'unavailable' })
    expect(f.ctx.clipboard.readText).not.toHaveBeenCalled()
    const wc = f.windows[0].webContents
    await wc.handlers.get('hd:computer:close')({ sender: wc, senderFrame: wc.mainFrame }, { dock: true })
    expect(f.states().at(-1)).toMatchObject({ mode: 'user-control', docked: true })
  })

  it('does not interrupt a newly selected session under stale controls or publish late media after close', async () => {
    const media = deferred()
    const f = fixture({ computerRequest: vi.fn((url) => url.startsWith('/api/media?') ? media.promise : Promise.resolve({ ready: true })) })
    await f.pip.open('alan', { docked: true })
    f.select({ runtimeId: 'runtime-fake-new' })
    await expect(f.invoke('takeControl')).rejects.toMatchObject({ code: 'unavailable' })
    expect(f.ctx.serveClient.call).not.toHaveBeenCalled()
    f.complete({ screenshot_path: '/fake/alan/cache/images/computer_use_fake.png' }, {}, 'runtime-fake-new')
    await flush()
    f.pip.close()
    media.resolve({ data_url: image })
    await flush()
    expect(f.frames()).toHaveLength(0)
    expect(f.states().at(-1).open).toBe(false)
  })

  it('keeps the receipt time when reopening an observed capture and ignores repeated completed events', async () => {
    const f = fixture()
    f.complete()
    await flush()
    const ts = Date.now()
    await vi.advanceTimersByTimeAsync(12000)
    await f.pip.open('alan', { docked: true })
    await flush()
    expect(f.frames().at(-1).ts).toBe(ts)
    f.complete()
    await flush()
    expect(f.frames().at(-1).ts).toBe(ts)
  })

  it('persists only HUD-pattern geometry and dock preference, clamps offscreen bounds, and restores them', async () => {
    const f = fixture()
    await f.pip.open('alan')
    f.complete()
    await flush()
    f.windows[0].bounds = { x: 200, y: 240, width: 500, height: 360 }
    f.windows[0].emit('move')
    await vi.advanceTimersByTimeAsync(500)
    expect(JSON.parse(readFileSync(path.join(f.root, STATE_FILE), 'utf8'))).toEqual({
      version: 1, expanded: { x: 200, y: 240, width: 500, height: 360 }, docked: false,
    })
    const wc = f.windows[0].webContents
    await wc.handlers.get('hd:computer:close')({ sender: wc, senderFrame: wc.mainFrame }, { dock: true })
    expect(f.states().at(-1)).toMatchObject({ open: true, docked: true })
    expect(f.windows[0].isDestroyed()).toBe(true)
    f.pip.dispose()
    const restored = registerComputerPip(f.ctx)
    instances.push(restored)
    await restored.open('alan')
    expect(f.windows).toHaveLength(1)
    await restored.open('alan', { docked: false })
    expect(f.windows[1].getBounds()).toEqual({ x: 200, y: 240, width: 500, height: 360 })
    const raw = readFileSync(path.join(f.root, STATE_FILE), 'utf8')
    expect(raw).not.toContain('runtime-fake-alan')
    expect(raw).not.toContain(image)
    expect(parsePipState('{broken')).toEqual({ expanded: null, docked: false })
    expect(parsePipState(JSON.stringify({ x: 5, y: 5, width: 300, height: 250 })).expanded).toEqual({ x: 5, y: 5, width: 300, height: 250 })
    restored.dispose()
    writeFileSync(path.join(f.root, STATE_FILE), JSON.stringify({ version: 1, docked: false,
      expanded: { x: 99999, y: 99999, width: 500, height: 360 } }))
    const offscreen = registerComputerPip(f.ctx)
    instances.push(offscreen)
    await offscreen.open('alan')
    expect(f.windows[2].getBounds()).toMatchObject({ width: 420, height: 320 })
  })
})

describe('Computer PiP paste safety', () => {
  it('confirms ordinary clipboard text in main and sends only the documented steer fallback', async () => {
    const f = fixture()
    await f.pip.open('alan', { docked: true })
    await f.invoke('paste')
    expect(f.ctx.redactor.looksLikeSecret).toHaveBeenCalledWith('obviously fake ordinary text')
    expect(f.ctx.dialog.showMessageBox.mock.calls[0][1].detail).not.toContain('obviously fake ordinary text')
    expect(f.ctx.serveClient.call).toHaveBeenLastCalledWith('session.steer', {
      session_id: 'runtime-fake-alan', profile: 'alan',
      text: '[Computer] Paste this into the focused field: obviously fake ordinary text',
    })
    expect(JSON.stringify(f.main.webContents.send.mock.calls)).not.toContain('obviously fake ordinary text')
  })

  it('sends nothing after cancel, a session switch, or taking control during consent', async () => {
    const f = fixture()
    await f.pip.open('alan', { docked: true })
    f.ctx.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    await f.invoke('paste')
    expect(f.ctx.serveClient.call).not.toHaveBeenCalled()
    const consent = deferred()
    f.ctx.dialog.showMessageBox.mockReturnValue(consent.promise)
    const pasting = f.invoke('paste')
    await flush()
    f.select({ runtimeId: 'runtime-fake-new' })
    consent.resolve({ response: 1 })
    await pasting
    expect(f.ctx.serveClient.call).not.toHaveBeenCalled()
    f.select({ runtimeId: 'runtime-fake-alan' })
    const otherConsent = deferred()
    f.ctx.dialog.showMessageBox.mockReturnValue(otherConsent.promise)
    const second = f.invoke('paste')
    await flush()
    await f.invoke('takeControl')
    otherConsent.resolve({ response: 1 })
    await second
    expect(f.ctx.serveClient.call.mock.calls.map(([name]) => name)).toEqual(['session.interrupt'])
  })

  it('never sends secret clipboard text via steer, and fails closed without a direct secure fill path', async () => {
    const f = fixture()
    await f.pip.open('alan', { docked: true })
    f.ctx.clipboard.readText.mockReturnValue('FAKE_CLIPBOARD_SECRET_DO_NOT_USE')
    f.ctx.redactor.looksLikeSecret.mockReturnValue(true)
    await expect(f.invoke('paste')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(f.ctx.dialog.showMessageBox.mock.calls[0][1].message).toBe('Fill as secret?')
    expect(f.ctx.serveClient.call).not.toHaveBeenCalled()
    expect(JSON.stringify(f.main.webContents.send.mock.calls)).not.toContain('FAKE_CLIPBOARD_SECRET_DO_NOT_USE')
  })

  it('routes secure-prompt values only to a main-only, origin-bound fill and drops a changed target', async () => {
    const securePrompt = { requestFill: vi.fn(async () => ({ ok: true, value: 'FAKE_SECURE_PROMPT_VALUE_DO_NOT_USE' })) }
    const target = { id: 'fake-field-1', origin: 'https://example.invalid' }
    const f = fixture({ securePrompt, getComputerTarget: vi.fn(async () => target), fillComputerSecret: vi.fn(async () => {}) })
    await f.pip.open('alan', { docked: true })
    f.ctx.redactor.looksLikeSecret.mockReturnValue(true)
    await f.invoke('paste')
    expect(securePrompt.requestFill).toHaveBeenCalledWith({
      agentName: 'Alan', fieldLabel: 'Focused computer field', origin: 'https://example.invalid',
    })
    expect(f.ctx.fillComputerSecret).toHaveBeenCalledWith({
      profile: 'alan', sessionId: 'runtime-fake-alan', targetId: 'fake-field-1', origin: 'https://example.invalid',
      value: 'FAKE_SECURE_PROMPT_VALUE_DO_NOT_USE',
    })
    expect(f.ctx.serveClient.call).not.toHaveBeenCalled()
    expect(JSON.stringify(f.main.webContents.send.mock.calls)).not.toContain('FAKE_SECURE_PROMPT_VALUE_DO_NOT_USE')
    f.ctx.fillComputerSecret.mockClear()
    f.ctx.getComputerTarget.mockResolvedValueOnce(target).mockResolvedValueOnce({ ...target, origin: 'https://changed.invalid' })
    await f.invoke('paste')
    expect(f.ctx.fillComputerSecret).not.toHaveBeenCalled()
  })

  it('blocks missing, throwing or malformed detectors without exposing their exception contents', async () => {
    const f = fixture()
    await f.pip.open('alan', { docked: true })
    f.ctx.redactor.looksLikeSecret.mockImplementation(() => {
      throw Object.assign(new Error('FAKE_SECRET_IN_ERROR'), { code: 'blocked_by_policy' })
    })
    await expect(f.invoke('paste')).rejects.toThrow('Paste could not be completed safely')
    expect(JSON.stringify(f.main.webContents.send.mock.calls)).not.toContain('FAKE_SECRET_IN_ERROR')
    f.ctx.redactor.looksLikeSecret.mockReturnValue(undefined)
    await expect(f.invoke('paste')).rejects.toThrow('Secret detection failed')
    f.ctx.redactor = {}
    await expect(f.invoke('paste')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(f.ctx.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(f.ctx.serveClient.call).not.toHaveBeenCalled()
  })
})
