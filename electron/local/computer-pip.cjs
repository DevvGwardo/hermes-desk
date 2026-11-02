'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const hudState = require('../hud-state.cjs')

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_IMAGE_CHARS = 4 * 1024 * 1024
const DEFAULT_BOUNDS = { width: 420, height: 320 }
const STATE_FILE = 'computer-pip-state.json'
const OWN_ERROR = Symbol('computer-pip-error')
const fail = (code, message) => Object.assign(new Error(message), { code, [OWN_ERROR]: true })
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id)
const colorValue = (color) => /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#8bb8e8'

function computerRequest(requestPath, endpoint) {
  if (typeof requestPath !== 'string' || requestPath.length > 8192 || /[\x00-\x1f\x7f\\#]/.test(requestPath)) {
    return Promise.reject(new Error('Invalid Computer request'))
  }
  const url = new URL(requestPath, 'http://127.0.0.1')
  const keys = [...url.searchParams.keys()]
  const profile = url.searchParams.get('profile')
  const media = url.pathname === '/api/media'
  if (!requestPath.startsWith('/api/') || !['/api/media', '/api/tools/computer-use/status'].includes(url.pathname) ||
      !PROFILE_RE.test(profile || '') || keys.length !== (media ? 2 : 1) ||
      keys.some((key) => !['profile', ...(media ? ['path'] : [])].includes(key))) {
    return Promise.reject(new Error('Invalid Computer request'))
  }
  const imagePath = url.searchParams.get('path')
  if (media && (!path.isAbsolute(imagePath || '') || imagePath.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(imagePath) || !/^computer_use_[a-z0-9_-]+\.(?:png|jpe?g)$/i.test(path.basename(imagePath)))) {
    return Promise.reject(new Error('Invalid Computer media path'))
  }
  // Hermes still enforces profile-scoped media roots. This never reads a file.
  return require('../serve-auth.cjs').requestOwnedJson(`${url.pathname}${url.search}`,
    { ...endpoint, maxBytes: media ? 5 * 1024 * 1024 : 64 * 1024 })
}

function imageDataUrl(value) {
  return typeof value === 'string' && value.length <= MAX_IMAGE_CHARS &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null
}

function jsonResult(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : {}
  if (value.length > MAX_IMAGE_CHARS) return {}
  try { return JSON.parse(value) } catch { return {} }
}

/** Only documented computer_use result fields; never scrape prose or a cache directory. */
function captureSource(value) {
  const result = jsonResult(value)
  if (!result || result.error || result.ok === false || result.isError === true) return null
  const structured = result.structuredContent || {}
  const meta = result.meta || structured
  let dataUrl = imageDataUrl(result.data_url)
  for (const part of Array.isArray(result.content) ? result.content : []) {
    if (dataUrl) break
    if (part.type === 'image_url') dataUrl = imageDataUrl(part.image_url?.url)
    if (part.type === 'image') dataUrl = imageDataUrl(`data:${part.mimeType};base64,${part.data}`)
  }
  const b64 = result.images?.[0] || structured.screenshot_png_b64 || structured.png_b64
  const mime = result.image_mime_types?.[0] || structured.screenshot_mime_type ||
    structured.mime_type || (typeof b64 === 'string' && b64.startsWith('/9j/') ? 'image/jpeg' : 'image/png')
  if (!dataUrl && typeof b64 === 'string') dataUrl = imageDataUrl(`data:${mime};base64,${b64}`)
  const mediaPath = meta.screenshot_path || result.screenshot_path
  const validPath = typeof mediaPath === 'string' && mediaPath.length <= 4096 &&
    !/[\x00-\x1f\x7f]/.test(mediaPath) && path.isAbsolute(mediaPath) &&
    /^computer_use_[a-z0-9_-]+\.(?:png|jpe?g)$/i.test(path.basename(mediaPath))
  if (!dataUrl && !validPath) return null
  const width = meta.width || result.width
  const height = meta.height || result.height
  return { dataUrl, mediaPath: validPath ? mediaPath : null,
    width: Number.isFinite(width) && width > 0 && width <= 32768 ? width : null,
    height: Number.isFinite(height) && height > 0 && height <= 32768 ? height : null,
    boundsScale: Number.isFinite(meta.bounds_scale || result.bounds_scale) &&
      (meta.bounds_scale || result.bounds_scale) > 0 ? meta.bounds_scale || result.bounds_scale : 1 }
}

function parsePipState(raw) {
  const geometry = hudState.parseHudState(raw)
  let data
  try { data = JSON.parse(raw) } catch { return { expanded: null, docked: false } }
  return { expanded: geometry?.expanded || null, docked: data?.version === 1 && data?.docked === true }
}

/**
 * CONTRACT: ctx.computerRequest(path) is an authenticated, main-only JSON GET
 * helper for /api/tools/computer-use/status and /api/media. No token enters PiP.
 * ctx.getComputerSession(profile) returns {runtimeId, agentName?, color?}, or null.
 * Without a selector, only an unambiguous single live session is eligible.
 */
function registerComputerPip(ctx) {
  const { serveClient, getMainWindow, BrowserWindow } = ctx
  const screen = ctx.screen || require('electron').screen
  const clipboard = ctx.clipboard || require('electron').clipboard
  const deps = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync,
    now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout, ...ctx.computerDeps }
  const statePath = path.join(ctx.userDataDir, STATE_FILE)
  let saved
  try { saved = parsePipState(deps.readFileSync(statePath, 'utf8')) } catch {
    saved = { expanded: null, docked: false }
  }
  let state = { open: false, mode: 'idle', docked: saved.docked,
    source: 'completed-capture', readiness: 'unknown' }
  let win = null
  let ready = false
  let disposed = false
  let epoch = 0
  let pollTimer = null
  let saveTimer = null
  let controlPending = false
  let pastePending = false
  let selection = null
  let frame = null
  const captures = new Map()
  const points = new Map()
  const completedSequences = new Map()
  const channels = []
  const hardenedSessions = new WeakSet()

  function send(channel, payload) {
    const main = getMainWindow()
    if (main && !main.isDestroyed()) main.webContents.send(channel, payload)
    if (ready && win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  function emit() { ctx.onState?.({ ...state }); send('hd:computer:state', { ...state }) }
  function current(token, id) {
    return !disposed && state.open && epoch === token && selection?.runtimeId === id
  }
  function publishFrame() {
    send('hd:computer:frame', frame || { dataUrl: '', ts: 0 })
  }
  function save() {
    deps.clearTimer(saveTimer)
    saveTimer = null
    if (win && !win.isDestroyed()) saved.expanded = win.getBounds()
    saved.docked = state.docked
    try {
      // Geometry/preferences only. No captures, clipboard, session ids or secrets.
      deps.writeFileSync(statePath, JSON.stringify({ version: 1, expanded: saved.expanded,
        docked: saved.docked }), 'utf8')
    } catch { /* Read-only userData must not break the preview. */ }
  }
  function scheduleSave() {
    deps.clearTimer(saveTimer)
    saveTimer = deps.setTimer(save, 500)
    saveTimer?.unref?.()
  }

  function createWindow() {
    if (win && !win.isDestroyed()) { win.showInactive(); return }
    const bounds = hudState.clampHudBounds(saved.expanded, screen, DEFAULT_BOUNDS)
    const background = !(ctx.app?.isPackaged ?? ctx.isPackaged ?? true) && ctx.e2eBackground === true
    if (background) {
      const displays = screen.getAllDisplays?.() || []
      bounds.x = Math.min(0, ...displays.map((display) => display.bounds.x)) - Math.max(2000, (bounds.width || DEFAULT_BOUNDS.width) + 100)
      bounds.y = (displays[0]?.bounds.y || 0) + 100
    }
    const pip = new BrowserWindow({
      ...bounds, minWidth: 280, minHeight: 220, title: 'Hermes Desk · Computer',
      ...(background ? { focusable: false } : {}),
      backgroundColor: '#00000000', transparent: true, frame: false, hasShadow: false,
      roundedCorners: true, alwaysOnTop: true, visibleOnAllWorkspaces: true,
      skipTaskbar: true, resizable: true, show: false,
      webPreferences: {
        preload: path.join(__dirname, 'pip-preload.cjs'),
        partition: 'hermesdesk-computer-pip',
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: true, webviewTag: false, webSecurity: true,
        allowRunningInsecureContent: false, experimentalFeatures: false,
      },
    })
    if (background) pip.setOpacity(0)
    win = pip
    ready = false
    const wc = pip.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    for (const name of ['will-attach-webview', 'will-navigate', 'will-redirect', 'will-frame-navigate']) {
      wc.on(name, (event) => event.preventDefault())
    }
    const ses = wc.session
    const pageUrl = pathToFileURL(path.join(__dirname, 'pip.html')).href
    if (!hardenedSessions.has(ses)) {
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
      ses.setPermissionCheckHandler(() => false)
      ses.on('will-download', (event) => event.preventDefault())
      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        callback({ cancel: details.url !== pageUrl && !imageDataUrl(details.url) })
      })
      hardenedSessions.add(ses)
    }
    pip.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    pip.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver')
    // Electron 37's webContents-scoped handlers run before ipcMain. The static
    // PiP is NOT added to assertMainSender's broad app/HUD allowlist.
    for (const [name, handler] of Object.entries({
      takeControl, paste, close: (options) => options?.dock === true ? dock() : close(),
    })) {
      wc.ipc.handle(`hd:computer:${name}`, (event, ...args) => {
        if (disposed || win !== pip || event.sender !== wc || event.senderFrame !== wc.mainFrame ||
            wc.getURL() !== pageUrl || args.length > (name === 'close' ? 1 : 0)) {
          throw fail('sender_rejected', 'Computer PiP sender rejected')
        }
        if (name === 'close' && args[0] !== undefined &&
            (!args[0] || args[0].dock !== true || Object.keys(args[0]).length !== 1)) {
          throw fail('bad_args', 'Invalid Computer PiP arguments')
        }
        return handler(...args)
      })
    }
    wc.on('did-finish-load', () => {
      if (win !== pip || disposed) return
      ready = true
      emit()
      publishFrame()
    })
    pip.once('ready-to-show', () => { if (win === pip && state.open) pip.showInactive() })
    pip.on('move', scheduleSave)
    pip.on('resize', scheduleSave)
    pip.on('close', save)
    pip.on('closed', () => {
      if (win !== pip) return
      win = null
      ready = false
      deps.clearTimer(saveTimer)
      saveTimer = null
      if (state.open && !state.docked) close()
    })
    void pip.loadFile(path.join(__dirname, 'pip.html')).catch(() => {
      if (win === pip) { close(); }
    })
  }

  async function resolveSelection(profile) {
    if (ctx.getComputerSession) {
      const selected = await ctx.getComputerSession(profile)
      return selected && validId(selected.runtimeId) ? selected : null
    }
    const result = await serveClient.call('session.active_list', { profile })
    const sessions = result?.sessions
    return Array.isArray(sessions) && sessions.length === 1 && validId(sessions[0].id)
      ? { runtimeId: sessions[0].id } : null
  }

  function select(next) {
    if (next && next.runtimeId === selection?.runtimeId) { selection = next; return }
    selection = next
    frame = null
    state = { ...state, mode: 'watching', lastAction: undefined, captureTs: undefined,
      sessionId: next?.runtimeId, agentName: next?.agentName || state.profile,
      agentColor: colorValue(next?.color),
      detail: next ? undefined : 'No unambiguous active session for this profile.' }
    publishFrame()
    emit()
    if (next) {
      const cached = captures.get(next.runtimeId)
      if (cached) void showCapture(cached, epoch)
    }
  }

  async function showCapture(entry, token) {
    const id = selection?.runtimeId
    if (!id || entry.sessionId !== id || !current(token, id)) return
    try {
      let dataUrl = entry.source.dataUrl
      if (!dataUrl) {
        if (!ctx.computerRequest) throw fail('unavailable', 'Media reader unavailable')
        const result = await ctx.computerRequest(`/api/media?${new URLSearchParams({
          path: entry.source.mediaPath, profile: state.profile,
        })}`)
        dataUrl = imageDataUrl(result?.data_url)
      }
      if (!dataUrl) throw fail('blocked_by_policy', 'Invalid capture image')
      if (!current(token, id) || captures.get(id) !== entry) return
      frame = { dataUrl, ts: entry.ts, sessionId: id, profile: state.profile,
        width: entry.source.width, height: entry.source.height }
      const point = points.get(id)
      state = { ...state, captureTs: entry.ts, detail: undefined,
        lastAction: point && entry.source.width && entry.source.height ? {
          x: point.x / entry.source.boundsScale, y: point.y / entry.source.boundsScale,
          color: state.agentColor, width: entry.source.width, height: entry.source.height,
        } : undefined }
      publishFrame()
      emit()
    } catch {
      if (!current(token, id) || captures.get(id) !== entry) return
      state = { ...state, detail: 'Completed capture could not be loaded. Hermes may refuse images outside this profile’s media roots. Try a new capture in this agent’s session.' }
      emit()
    }
  }

  async function observe(name, event) {
    if (disposed || !validId(event?.session_id)) return
    const id = event.session_id
    const payload = event.payload || {}
    const token = epoch
    if (state.open && ctx.getComputerSession) {
      // Re-evaluate the selected chat before accepting a same-profile event.
      try {
        const next = await resolveSelection(state.profile)
        if (state.open && !disposed && epoch === token) select(next)
      } catch {
        if (state.open && !disposed && epoch === token) select(null)
      }
    }
    if (disposed) return
    if (name !== 'tool.complete' || payload.name !== 'computer_use') return
    const result = jsonResult(payload.result)
    if (result?.error || result?.ok === false || result?.isError === true) return
    if (Number.isInteger(event.seq)) {
      if (event.seq <= (completedSequences.get(id) ?? -1)) return
      completedSequences.delete(id)
      completedSequences.set(id, event.seq)
      if (completedSequences.size > 8) completedSequences.delete(completedSequences.keys().next().value)
    }
    const coordinate = payload.args?.to_coordinate || payload.args?.coordinate
    if (Array.isArray(coordinate) && coordinate.length === 2 && coordinate.every(Number.isFinite)) {
      points.delete(id)
      points.set(id, { x: coordinate[0], y: coordinate[1] })
      if (points.size > 8) points.delete(points.keys().next().value)
      const previousCapture = captures.get(id)
      if (current(token, id) && frame && previousCapture?.source.width && previousCapture.source.height) {
        state = { ...state, lastAction: {
          x: coordinate[0] / previousCapture.source.boundsScale,
          y: coordinate[1] / previousCapture.source.boundsScale,
          color: state.agentColor, width: previousCapture.source.width, height: previousCapture.source.height,
        } }
        emit()
      }
    }
    const source = captureSource(payload.result)
    if (!source) return
    const previous = captures.get(id)
    if (Number.isInteger(event.seq) && Number.isInteger(previous?.seq) && event.seq <= previous.seq) return
    // Preserve arrival time across replay. Hermes's event envelope has no timestamp.
    const entry = { source, sessionId: id, seq: event.seq, ts: deps.now() }
    captures.delete(id)
    captures.set(id, entry)
    if (captures.size > 8) captures.delete(captures.keys().next().value)
    if (current(token, id)) void showCapture(entry, token)
  }

  async function poll(token) {
    if (disposed || !state.open || token !== epoch) return
    try {
      const next = await resolveSelection(state.profile)
      if (token !== epoch || !state.open || disposed) return
      select(next)
      if (!ctx.computerRequest) throw fail('unavailable', 'Readiness reader unavailable')
      const result = await ctx.computerRequest(`/api/tools/computer-use/status?${new URLSearchParams({
        profile: state.profile,
      })}`)
      if (token !== epoch || !state.open || disposed) return
      state = { ...state, readiness: result?.ready === true ? 'ready' :
        result?.ready === false || result?.installed === false || result?.platform_supported === false ? 'unavailable' : 'unknown',
        permissions: {
          accessibility: typeof result?.accessibility === 'boolean' ? result.accessibility : null,
          screenRecording: typeof result?.screen_recording === 'boolean' ? result.screen_recording : null,
        } }
      emit()
    } catch {
      if (token === epoch && state.open && !disposed) {
        state = { ...state, readiness: 'unknown' }
        emit()
      }
    } finally {
      if (token === epoch && state.open && !disposed) {
        pollTimer = deps.setTimer(() => { pollTimer = null; void poll(token) }, 5000)
        pollTimer?.unref?.()
      }
    }
  }

  async function open(profile, options) {
    if (disposed || typeof profile !== 'string' || !PROFILE_RE.test(profile) ||
        (options !== undefined && (!options || typeof options.docked !== 'boolean' ||
          Object.keys(options).length !== 1))) throw fail('bad_args', 'Invalid Computer PiP profile or options')
    if (state.open && state.profile === profile) {
      state = { ...state, docked: options?.docked ?? state.docked }
      save()
      if (state.docked) {
        if (win && !win.isDestroyed()) win.close()
      } else createWindow()
      emit()
      publishFrame()
      return
    }
    const token = ++epoch
    deps.clearTimer(pollTimer)
    pollTimer = null
    selection = null
    frame = null
    state = { open: true, profile, mode: 'watching', source: 'completed-capture',
      docked: options?.docked ?? saved.docked, readiness: 'unknown' }
    publishFrame()
    emit()
    if (state.docked) {
      if (win && !win.isDestroyed()) win.close()
    } else createWindow()
    save()
    try {
      const next = await resolveSelection(profile)
      if (epoch !== token || disposed || !state.open) return
      select(next)
    } catch {
      if (epoch === token) { state = { ...state, detail: 'Active session is unavailable.' }; emit() }
    }
    if (epoch === token && state.open && !disposed) void poll(token)
  }

  function close() {
    epoch++
    deps.clearTimer(pollTimer)
    pollTimer = null
    save()
    state = { ...state, open: false, mode: 'idle', lastAction: undefined, captureTs: undefined }
    selection = null
    frame = null
    publishFrame()
    emit()
    if (win && !win.isDestroyed()) win.close()
  }

  function dock() {
    if (!state.open || disposed) return
    state = { ...state, docked: true }
    save()
    if (win && !win.isDestroyed()) win.close()
    emit()
  }

  async function takeControl() {
    if (!state.open || !selection || disposed) throw fail('unavailable', 'No active computer session')
    if (controlPending) throw fail('busy', 'Take control is already pending')
    controlPending = true
    const token = epoch
    const id = selection.runtimeId
    try {
      const next = await resolveSelection(state.profile)
      if (!current(token, id) || next?.runtimeId !== id) {
        if (current(token, id)) select(next)
        throw fail('unavailable', 'The active computer session changed')
      }
      const result = await serveClient.call('session.interrupt', { session_id: id, profile: state.profile })
      if (result?.status !== 'interrupted' && result?.status !== 'not_interrupted') {
        throw fail('unavailable', 'Session interruption was not acknowledged')
      }
      if (ctx.getComputerSession) {
        const next = await resolveSelection(state.profile)
        if (current(token, id) && next?.runtimeId !== id) select(next)
      }
      if (!current(token, id)) return
      // CONTRACT: no Mac CUA pause/stop RPC exists. Do not call display.* (Linux)
      // or claim an in-flight native operation has been synchronously cancelled.
      state = { ...state, mode: 'user-control',
        detail: 'Turn interrupted. An in-flight native action may still finish; this is a capture preview.' }
      emit()
    } catch (error) {
      throw error?.[OWN_ERROR] ? error : fail('unavailable', 'Unable to interrupt the computer-use turn')
    } finally { controlPending = false }
  }

  function ask(options) {
    const parent = win && !win.isDestroyed() ? win : getMainWindow()
    return parent ? ctx.dialog.showMessageBox(parent, options) : ctx.dialog.showMessageBox(options)
  }

  async function paste() {
    if (!state.open || !selection || disposed || state.mode === 'user-control') {
      throw fail('unavailable', 'No agent-controlled computer session')
    }
    if (pastePending) throw fail('busy', 'Paste is already pending')
    pastePending = true
    const token = epoch
    const id = selection.runtimeId
    const profile = state.profile
    let text = ''
    let secretValue = ''
    try {
      text = clipboard.readText()
      if (!text || text.length > 8192) throw fail('bad_args', 'Clipboard text is empty or too long')
      let redactor = ctx.redactor
      if (!redactor) {
        try { redactor = require('./workspace/redactor.cjs') } catch {
          throw fail('blocked_by_policy', 'Secret detector unavailable; nothing was pasted')
        }
      }
      const secret = redactor.looksLikeSecret(text)
      if (typeof secret !== 'boolean') throw fail('blocked_by_policy', 'Secret detection failed')
      const { response } = await ask({
        type: 'question', title: 'Hermes Desk',
        message: secret ? 'Fill as secret?' : `Paste clipboard text for ${state.agentName || profile}?`,
        detail: secret ? 'The clipboard may contain a secret. Never send it to the agent.' :
          'This sends the text to the agent as a steer, not a direct computer-use action. The agent may act on it.',
        buttons: ['Cancel', secret ? 'Fill as secret' : 'Send paste instruction'],
        defaultId: 0, cancelId: 0, noLink: true,
      })
      if (response !== 1 || !current(token, id) || state.mode === 'user-control') return
      const next = await resolveSelection(profile)
      if (!current(token, id) || next?.runtimeId !== id) return
      if (secret) {
        // Only a target-bound, main-only direct fill may receive a secure value.
        // Installed Hermes has no such method. Never substitute a model steer.
        if (!ctx.securePrompt || !ctx.getComputerTarget || !ctx.fillComputerSecret) {
          throw fail('blocked_by_policy', 'Secure computer fill is unavailable. Paste the secret yourself after Take control.')
        }
        const target = await ctx.getComputerTarget({ profile, sessionId: id })
        if (!target?.id || !/^https?:\/\//.test(target.origin || '')) {
          throw fail('blocked_by_policy', 'No origin-bound computer field')
        }
        const result = await ctx.securePrompt.requestFill({ agentName: state.agentName || profile,
          fieldLabel: 'Focused computer field', origin: target.origin })
        if (!result?.ok || typeof result.value !== 'string') return
        secretValue = result.value
        const latest = await ctx.getComputerTarget({ profile, sessionId: id })
        const selected = await resolveSelection(profile)
        if (!current(token, id) || state.mode === 'user-control' || selected?.runtimeId !== id ||
            latest?.id !== target.id || latest?.origin !== target.origin) return
        await ctx.fillComputerSecret({ profile, sessionId: id, targetId: target.id,
          origin: target.origin, value: secretValue })
        return
      }
      // No tool.invoke / computer_use.type RPC exists in the installed catalog.
      const result = await serveClient.call('session.steer', { session_id: id, profile,
        text: `[Computer] Paste this into the focused field: ${text}` })
      if (result?.status !== 'queued' && result?.status !== 'redirected') {
        throw fail('unavailable', 'Paste instruction was not accepted')
      }
    } catch (error) {
      // Detector/driver/backend exceptions can contain clipboard or secure values.
      const safeError = error?.[OWN_ERROR] ? error : fail('blocked_by_policy', 'Paste could not be completed safely')
      if (current(token, id)) { state = { ...state, detail: safeError.message }; emit() }
      throw safeError
    } finally {
      text = ''
      secretValue = ''
      pastePending = false
    }
  }

  for (const [name, handler] of Object.entries({ open, close, takeControl, paste })) {
    const channel = `hd:computer:${name}`
    ctx.ipcHandle(channel, (event, ...args) => {
      ctx.assertMainSender(event)
      if (event.sender !== getMainWindow()?.webContents) throw fail('sender_rejected', 'Computer sender rejected')
      if (disposed || args.length > (name === 'open' ? 2 : 0)) throw fail('bad_args', 'Invalid Computer PiP arguments')
      return handler(...args)
    })
    channels.push(channel)
  }
  const unsubscribe = serveClient.onEvent((name, event) => {
    void observe(name, event).catch(() => {})
  })
  return {
    open, close, status: () => ({ ...state }),
    dispose() {
      if (disposed) return
      close()
      disposed = true
      unsubscribe()
      deps.clearTimer(saveTimer)
      saveTimer = null
      captures.clear()
      points.clear()
      completedSequences.clear()
      for (const channel of channels) ctx.ipcMain?.removeHandler(channel)
    },
  }
}

module.exports = { registerComputerPip, captureSource, parsePipState, imageDataUrl, STATE_FILE, computerRequest }
