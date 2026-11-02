'use strict'

// Only fake local corpus pages run here. No main app, Hermes, real profile,
// visible window, keyboard/mouse input, screenshot persistence, or TCP port.
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createCdpExecutor } = require('../../../electron/local/workspace/cdp-exec.cjs')
const redactor = require('../../../electron/local/workspace/redactor.cjs')
const approvedValues = require('../../../electron/local/workspace/approved-values.cjs')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-redaction-pixels-'))
app.setPath('userData', directory)
app.setPath('sessionData', directory)
let window, executor
const deadline = setTimeout(() => app.exit(1), 25_000)

function assert(value, message) { if (!value) throw new Error(message) }
function blackRect(bitmap, width, height, rect, inset = 0, label = 'dynamic field', tolerance = 0) {
  const left = Math.max(0, Math.ceil(rect.x) + inset)
  const top = Math.max(0, Math.ceil(rect.y) + inset)
  const right = Math.min(width, Math.floor(rect.x + rect.width) - inset)
  const bottom = Math.min(height, Math.floor(rect.y + rect.height) - inset)
  assert(right > left && bottom > top, 'Empty corpus rectangle')
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * width + x) * 4
      assert(bitmap[offset] <= tolerance && bitmap[offset + 1] <= tolerance && bitmap[offset + 2] <= tolerance &&
        bitmap[offset + 3] === 255, `Sensitive corpus pixels were not solid black: ${label} (${x},${y}; ${width}x${height})`)
    }
  }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const { substituteFixtures, fixtures } = await import(pathToFileURL(path.resolve(__dirname,
    '../../../electron/local/workspace/redactor-fixtures.mjs')).href)
  const corpus = path.resolve(__dirname, '../../fixtures/redaction-corpus')
  const manifest = JSON.parse(substituteFixtures(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'), { json: true }))
  window = new BrowserWindow({ show: false, focusable: false, width: 1200, height: 900,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false, webSecurity: true } })
  const wc = window.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  wc.session.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: !details.url.startsWith('file:') && details.url !== 'about:blank',
  }))
  const tab = { id: 't_corpus', laneId: 'profile:fake', webContents: wc, ensureLive: async () => wc }
  const lanes = { getTab: id => id === tab.id ? tab : null, listTabs: () => [tab],
    isPaused: () => false, setTabState() {}, isVisibleTab: () => false }
  let masked
  const images = {
    createFromBuffer: nativeImage.createFromBuffer,
    createFromBitmap(bitmap, size) {
      masked = { bitmap: Buffer.from(bitmap), ...size }
      return nativeImage.createFromBitmap(bitmap, size)
    },
  }
  let paintHook = async () => {}
  executor = createCdpExecutor({ lanes, redactor, nativeImage: images,
    overlay: { send() {}, waitFrame: () => paintHook() }, securePrompt: {} })
  const pages = []
  let rectangles = 0
  for (const page of manifest.pages) {
    const html = substituteFixtures(fs.readFileSync(path.join(corpus, page.file), 'utf8'))
    const file = path.join(directory, page.file)
    fs.writeFileSync(file, html)
    await window.loadFile(file)
    // Model-approved fills populate this main-only registry. AX returns bullets
    // for password fields, so arbitrary unapproved user-password echoes cannot
    // be learned from AX. That limitation is a separate owner acceptance item,
    // not hidden by remembering the entire corpus's token/card/OTP values.
    if (page.file === 'login.html') approvedValues.remember(wc, fixtures.FAKE_PASSWORD)
    if (page.file === 'signup.html') approvedValues.remember(wc, fixtures.FAKE_SIGNUP)
    await wc.insertCSS('body{font:14px Arial;background:#fff;color:#111;padding:16px} ' +
      'form{display:flex;flex-direction:column;align-items:flex-start;gap:6px}' +
      'input{height:30px;width:420px;background:#ffc;color:#111} pre{white-space:pre-wrap}' +
      '[contenteditable]{min-height:30px;min-width:420px;background:#ffc}')
    await wc.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const expected = page.expectedNodes.filter(node => node.sensitive)
    const rects = await wc.executeJavaScript(`(${nodes => nodes.map(node => {
      const element = document.querySelector('[data-ref="' + node.ref + '"]')
      if (!element) throw new Error('Missing expected corpus node')
      const range = document.createRange()
      range.selectNodeContents(element)
      const rect = node.role === 'textbox' ? element.getBoundingClientRect() : range.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })})(${JSON.stringify(expected)})`)
    const raw = await wc.capturePage(undefined, { stayHidden: true })
    const snapshot = await executor.run(tab, 'browser_snapshot')
    for (const secret of page.secrets) assert(!snapshot.snapshot.includes(secret), `Corpus text leaked: ${page.file}`)
    const result = await executor.run(tab, 'browser_screenshot')
    assert(masked && !window.isVisible(), 'Corpus capture must remain hidden')
    const decoded = nativeImage.createFromBuffer(Buffer.from(result.screenshot.split(',')[1], 'base64'))
    const size = decoded.getSize()
    for (const [index, rect] of rects.entries()) {
      // Assert the complete main-only bitmap mask exactly. For lossy JPEG,
      // use an interior farther than one 8px DCT block from the mask boundary.
      blackRect(masked.bitmap, masked.width, masked.height, rect, 0, `${page.file}/${expected[index].ref}/bitmap`)
      if (rect.width > 24 && rect.height > 24) blackRect(decoded.toBitmap(), size.width, size.height, rect, 10,
        `${page.file}/${expected[index].ref}/jpeg`, 3)
      rectangles++
    }
    if (page.benign) assert(raw.toBitmap().equals(masked.bitmap), 'Benign corpus pixels were masked')
    pages.push(page.file)
  }
  // Move a real sensitive field during the actual overlay wait. The second
  // geometry sample must mask its captured location, not merely the old one.
  await window.loadFile(path.join(directory, 'login.html'))
  await wc.insertCSS('input{width:400px;height:40px}')
  paintHook = () => wc.executeJavaScript(`document.querySelector('[data-ref="e5"]').style.cssText =
    'position:fixed;left:500px;top:400px;width:400px;height:40px';
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await executor.run(tab, 'browser_screenshot')
  blackRect(masked.bitmap, masked.width, masked.height, { x: 502, y: 402, width: 396, height: 36 })
  // A mutation during capture is refused even if geometry would later match.
  paintHook = async () => {}
  const capture = wc.capturePage.bind(wc)
  wc.capturePage = async (...args) => {
    await wc.executeJavaScript(`document.querySelector('[data-ref="e5"]').value = 'FAKE changed during capture'`)
    return capture(...args)
  }
  let blocked = false
  try { await executor.run(tab, 'browser_screenshot') } catch (error) { blocked = error.code === 'blocked_by_policy' }
  assert(blocked, 'Changed corpus content must fail closed')
  console.log(JSON.stringify({ pages, rectangles, solidBlack: true, hidden: true, movedFieldMasked: true, mutationBlocked: true }))
}).catch(error => {
  console.log(JSON.stringify({ error: error.message }))
  process.exitCode = 1
}).finally(() => {
  clearTimeout(deadline)
  executor?.dispose()
  window?.destroy()
  app.quit()
})
app.on('quit', () => fs.rmSync(directory, { recursive: true, force: true }))
