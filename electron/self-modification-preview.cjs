'use strict'

const path = require('node:path')
const { identity } = require('./self-modification-schema.cjs')
const SCHEME = 'hd-candidate'
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; media-src 'self' blob:; connect-src 'none'; worker-src 'none'; frame-src 'none'; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'"
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm' }

/** A renderer-only display, not a candidate main process or activation build.
 * No preload, bridge, Node, live session, external navigation or networking. */
async function openRendererPreview({ id, readAsset, signal, onFailure, onClosed }) {
  if (!identity(id) || signal?.aborted) throw new Error('Invalid renderer preview intent')
  const { BrowserWindow, session } = require('electron')
  const isolated = session.fromPartition(`hd-candidate-${id}`, { cache: false })
  const origin = `${SCHEME}://candidate`
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.setDevicePermissionHandler(() => false)
  isolated.on('will-download', event => event.preventDefault())
  const win = new BrowserWindow({
    width: 1100, height: 760, show: false, title: 'Isolated renderer preview · not app health',
    webPreferences: { partition: `hd-candidate-${id}`, sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webviewTag: false, devTools: false, navigateOnDragDrop: false, safeDialogs: true },
  })
  // Set the policy after creation listeners, and before the first load. Only
  // this fresh session is affected, never the working app's network policy.
  isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !details.url.startsWith(origin + '/') })
  })
  let closed = false, timer
  const close = () => { if (!win.isDestroyed()) win.destroy() }
  const failed = () => {
    if (closed) return
    try { onFailure() } finally { close() }
  }
  win.setMenu(null)
  win.webContents.setAudioMuted(true)
  win.webContents.on('page-title-updated', event => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate'])
    win.webContents.on(event, (navigation, url) => {
      const target = typeof url === 'string' ? url : url?.url
      if (target !== origin + '/index.html') navigation.preventDefault()
    })
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  win.webContents.on('render-process-gone', failed)
  isolated.protocol.handle(SCHEME, request => {
    try {
      const url = new URL(request.url)
      if (url.protocol !== SCHEME + ':' || url.hostname !== 'candidate' || url.port || url.username || url.password ||
          request.method !== 'GET') throw new Error('Preview route refused')
      const name = decodeURIComponent(url.pathname.slice(1))
      return new Response(readAsset(name), { headers: { 'Content-Type': types[path.extname(name)] || 'application/octet-stream',
        'Content-Security-Policy': CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
    } catch {
      failed()
      return new Response('Preview asset refused', { status: 403 })
    }
  })
  win.once('closed', () => {
    closed = true; clearTimeout(timer)
    signal?.removeEventListener('abort', close)
    isolated.protocol.unhandle(SCHEME)
    try { onClosed() } catch { /* Failed journal acknowledgment does not keep a window alive. */ }
    void isolated.clearStorageData()
  })
  signal?.addEventListener('abort', close, { once: true })
  timer = setTimeout(close, 120000)
  try {
    await win.loadURL(origin + '/index.html')
    if (signal?.aborted || win.isDestroyed()) throw new Error('Preview closed before renderer readiness')
    win.show()
    return { close }
  } catch (error) { close(); throw error }
}

module.exports = { openRendererPreview, CSP, SCHEME }
