import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const assert = require('node:assert/strict')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { once } = require('node:events')
const { app, BrowserWindow, WebContentsView, session, nativeImage } = require('electron')
const { createCdpExecutor } = require('./cdp-exec.cjs')
const redactor = require('./redactor.cjs')
const root = process.argv[2]
if (!root || !path.isAbsolute(root)) throw new Error('Temporary home required')
app.setPath('userData', path.join(root, 'userData'))
app.setPath('sessionData', path.join(root, 'sessionData'))
app.setPath('logs', path.join(root, 'logs'))
app.on('window-all-closed', () => {})

async function probe() {
  await app.whenReady()
  let requests = 0
  const server = http.createServer((request, response) => {
    requests++
    response.setHeader('Content-Type', 'text/html')
    if (request.url === '/frame') {
      response.end('<!doctype html><input id="foreign" aria-label="Foreign password" type="password">')
      return
    }
    response.end(`<!doctype html><html><head><title>Native fixture</title>
      <style>body{background:white}#field{position:absolute;left:80px;top:80px;width:180px;height:40px;background:red}
      #echo{position:absolute;left:80px;top:150px}button{position:absolute;left:80px;top:220px}</style></head><body>
      <form id="login"><input type="email" value="fake@example.invalid">
      <label for="plain">Password</label><input id="plain" type="text"></form>
      <input id="field" aria-label="Fixture field"><div id="echo"></div>
      <button onclick="window.clicks=(window.clicks||0)+1">Record click</button>
      <script>document.querySelector('#plain').value='obviously fake form value';
      document.querySelector('#field').oninput=e=>{
        document.querySelector('#echo').textContent=e.target.value;document.title=e.target.value
      }</script></body></html>`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  assert(![8642, 9119].includes(port))
  const url = 'http://public.test/'
  // Fixture-only resolver/dial substitution. Chromium still uses the real
  // production proxy, but no synthetic public IP is ever actually contacted.
  const proxyModule = require('./egress-proxy.cjs')
  const createProxy = proxyModule.createEgressProxy
  proxyModule.createEgressProxy = () => createProxy({
    lookup: async host => {
      assert(['public.test', 'frames.test'].includes(host))
      return [{ address: '8.8.8.8', family: 4 }]
    },
    connect: options => {
      assert.deepEqual(options, { host: '8.8.8.8', family: 4, port: 80 })
      return net.connect({ host: '127.0.0.1', port })
    },
  })
  const { registerWorkspace } = require('./index.cjs')
  proxyModule.createEgressProxy = createProxy
  const main = new BrowserWindow({ width: 800, height: 600, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  let ws
  let executor
  let protectedPort = false
  const result = { nativeWorkspace: true }
  try {
    await main.loadURL('about:blank')
    const handlers = new Map()
    ws = registerWorkspace({ userDataDir: path.join(root, 'userData'), homeDir: root,
      getMainWindow: () => main, BrowserWindow, WebContentsView, session,
      // Fixture-only native consent adapter, using exclusively temp partitions.
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      ipcHandle: (channel, handler) => handlers.set(channel, handler),
      assertMainSender: () => {}, ipcMain: { removeHandler: channel => handlers.delete(channel) },
      hermesHost: { status: () => ({ serve: { port: protectedPort ? port : null } }) } })
    const tab = await ws.lanes.openTab('profile:fixture', undefined, { createdBy: 'agent' })
    assert.equal(tab.webContents.getURL(), 'about:blank')
    ws.views.setBounds({ x: 0, y: 0, width: 640, height: 480 })
    await ws.lanes.focusLane(tab.laneId)
    main.show()
    const overlay = { send: () => {}, waitFrame: async () => {} }
    const approved = 'obviously fake native approved value'
    let prompts = 0
    const securePrompt = { requestFill: async () => { prompts++; return { ok: true, value: approved } },
      confirmAction: async () => ({ ok: false }) }
    executor = createCdpExecutor({ ...ws.parts, nativeImage, redactor, overlay, securePrompt })
    await executor.run(tab, 'browser_navigate', { url })
    tab.webContents.setBackgroundThrottling(false)
    await tab.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await new Promise((resolve) => setTimeout(resolve, 500))
    result.blankNavigation = tab.webContents.getURL() === url
    let snapshot = await executor.run(tab, 'browser_snapshot')
    assert(!snapshot.snapshot.includes('obviously fake form value'))
    result.formContext = true
    const ref = (name) => snapshot.snapshot.split('\n').find((line) => line.includes(`"${name}"`))?.match(/ref=(e\d+)/)?.[1]
    await executor.run(tab, 'browser_click', { ref: ref('Record click') })
    assert.equal(await tab.webContents.executeJavaScript('window.clicks'), 1)
    assert.equal(ws.lanes.isPaused(tab.laneId), false)
    result.agentClick = true
    await executor.run(tab, 'browser_type', { ref: ref('Fixture field'), text: '{{secret:Fixture}}' })
    assert.equal(await tab.webContents.executeJavaScript("document.querySelector('#field').value"), approved)
    snapshot = await executor.run(tab, 'browser_snapshot')
    assert(!JSON.stringify(snapshot).includes(approved))
    result.approvedEcho = true
    await tab.webContents.executeJavaScript("document.title='Native fixture'")
    overlay.waitFrame = async () => {
      await tab.webContents.executeJavaScript("document.querySelector('#field').style.left='340px'; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
      // The fixture changes layout before capture. Drain its queued CDP
      // invalidation events before testing the stable bitmap path.
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const image = await executor.run(tab, 'browser_screenshot', {}, { signal: AbortSignal.timeout(8000) })
    const decoded = nativeImage.createFromDataURL(image.screenshot)
    const size = decoded.getSize()
    const pixels = decoded.toBitmap()
    const x = Math.floor(400 * size.width / 640)
    const y = Math.floor(100 * size.height / 480)
    const pixel = [...pixels.subarray((y * size.width + x) * 4, (y * size.width + x) * 4 + 3)]
    assert(pixel.every((value) => value < 20), 'Sensitive pixels must be black')
    const publicPixel = [...pixels.subarray((400 * size.width + 600) * 4, (400 * size.width + 600) * 4 + 3)]
    assert(publicPixel.every((value) => value > 220), 'Public pixels should remain visible')
    result.nativeMasks = true
    const original = tab.webContents.debugger.sendCommand.bind(tab.webContents.debugger)
    const { root: document } = await original('DOM.getDocument', { depth: -1 })
    function field(node) {
      if ((node.attributes || []).includes('field')) return node.nodeId
      for (const child of node.children || []) {
        const id = field(child)
        if (id) return id
      }
    }
    const fieldId = field(document)
    assert(fieldId)
    const capture = tab.webContents.capturePage.bind(tab.webContents)
    tab.webContents.capturePage = async (...args) => {
      await original('DOM.setAttributeValue', { nodeId: fieldId, name: 'style', value: 'left:420px' })
      return capture(...args)
    }
    // Native layout changes during a capture must be refused, never composited
    // with the stale rectangles. This is a fixture intervention, not production.
    await assert.rejects(executor.run(tab, 'browser_screenshot'), { code: 'blocked_by_policy' })
    tab.webContents.capturePage = capture
    result.changedGeometryBlocked = true
    tab.webContents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 })
    tab.webContents.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(ws.lanes.isPaused(tab.laneId), true)
    await assert.rejects(executor.run(tab, 'browser_snapshot'), { code: 'user_took_control' })
    result.realTakeover = true
    ws.lanes.resumeLane(tab.laneId)
    // Dispose the view through the same crash/discard seam, then revive it.
    const previous = tab.webContents
    ws.views.destroy(tab)
    tab.webContents = null
    tab.discarded = true
    await executor.run(tab, 'browser_navigate', { url: `${url}revived` })
    assert.notEqual(tab.webContents, previous)
    result.revivedNavigation = tab.webContents.getURL() === `${url}revived`
    // Run adversarial focus/frame tests after the stable raster checks. Those
    // pages are intentionally mutated and screenshots may safely be refused.
    snapshot = await executor.run(tab, 'browser_snapshot')
    const crossOriginFrame = 'http://frames.test/frame'
    const countPrompts = prompts
    await tab.webContents.executeJavaScript(`new Promise(resolve=>{
      const frame=document.createElement('iframe'); frame.src=${JSON.stringify(crossOriginFrame)};
      frame.onload=()=>resolve(); document.body.append(frame);
    })`)
    await assert.rejects(executor.run(tab, 'browser_snapshot'), { code: 'blocked_by_policy' })
    await assert.rejects(executor.run(tab, 'browser_type', { ref: ref('Fixture field'), text: '{{secret:Fixture}}' }),
      error => ['blocked_by_policy', 'no_such_ref'].includes(error.code))
    assert.equal(prompts, countPrompts)
    result.crossOriginFramesBlocked = true
    await executor.run(tab, 'browser_navigate', { url })
    snapshot = await executor.run(tab, 'browser_snapshot')
    securePrompt.requestFill = async () => {
      await tab.webContents.executeJavaScript(`new Promise(resolve=>{
        const frame=document.createElement('iframe'); frame.src=${JSON.stringify(crossOriginFrame)};
        frame.onload=()=>resolve(); document.body.append(frame);
      })`)
      return { ok: true, value: approved }
    }
    await assert.rejects(executor.run(tab, 'browser_type', { ref: ref('Fixture field'), text: '{{secret:Fixture}}' }),
      { code: 'blocked_by_policy' })
    assert.equal(await tab.webContents.executeJavaScript("document.querySelector('#field').value"), '')
    result.frameDuringConsentBlocked = true
    await executor.run(tab, 'browser_navigate', { url })
    snapshot = await executor.run(tab, 'browser_snapshot')
    securePrompt.requestFill = async () => ({ ok: true, value: approved })
    // Force the hostile focus change at the native CDP boundary so the test
    // doesn't depend on macOS activation or whether Chromium restores focus.
    const nativeCommand = tab.webContents.debugger.sendCommand.bind(tab.webContents.debugger)
    tab.webContents.debugger.sendCommand = async (method, ...args) => {
      const response = await nativeCommand(method, ...args)
      if (method === 'DOM.focus') await tab.webContents.executeJavaScript("document.querySelector('#plain').focus(); void 0")
      return response
    }
    try {
      await assert.rejects(executor.run(tab, 'browser_type', { ref: ref('Fixture field'), text: '{{secret:Fixture}}' }),
        { code: 'blocked_by_policy' })
    } finally { tab.webContents.debugger.sendCommand = nativeCommand }
    assert.equal(await tab.webContents.executeJavaScript("document.querySelector('#field').value"), '')
    assert.equal(await tab.webContents.executeJavaScript("document.querySelector('#plain').value"), 'obviously fake form value')
    result.focusStealBlocked = true
    await executor.run(tab, 'browser_type', { ref: ref('Fixture field'), text: '{{secret:Fixture}}' })
    assert.equal(await tab.webContents.executeJavaScript("document.querySelector('#field').value"), approved)
    protectedPort = true
    const count = requests
    for (const host of ['0.0.0.0', '0', '0177.0.0.1', '[::]', '[::ffff:127.0.0.1]']) {
      await assert.rejects(executor.run(tab, 'browser_navigate', { url: `http://${host}:${port}/blocked` }),
        { code: 'blocked_by_policy' })
    }
    assert.equal(requests, count)
    result.localAliases = true
    const invoke = (name, ...args) => handlers.get(`hd:ws:${name}`)({ sender: main.webContents }, ...args)
    const userSession = session.fromPartition('persist:ws-user')
    await userSession.cookies.set({ url: 'https://signin.fixture.invalid/account', name: 'fake-login',
      value: 'obviously fake native cookie', path: '/account', secure: true, httpOnly: true })
    await userSession.cookies.set({ url: 'https://unrelated.fixture.invalid/', name: 'unrelated',
      value: 'obviously fake unrelated cookie' })
    await invoke('copySignIn', 'https://signin.fixture.invalid', 'you', 'profile:cookie-fixture')
    const copiedSession = session.fromPartition('persist:ws-agent-cookie-fixture')
    const copied = await copiedSession.cookies.get({})
    assert.equal(copied.length, 1)
    assert.equal(copied[0].value, 'obviously fake native cookie')
    assert.equal(copied[0].path, '/account')
    result.nativeCookieCopyScoped = true
    const borrowed = await ws.lanes.openTab('you')
    assert.throws(() => ws.lanes.moveTab(borrowed.id, 'profile:cookie-fixture'),
      { code: 'blocked_by_policy' })
    const own = await ws.lanes.openTab('profile:cookie-fixture')
    const foreignSession = session.fromPartition('persist:ws-agent-foreign')
    await foreignSession.cookies.set({ url: 'https://foreign.fixture.invalid/', name: 'foreign', value: 'obviously fake foreign' })
    await invoke('clearLaneData', 'profile:cookie-fixture')
    assert.equal(ws.lanes.getTab(own.id), null)
    assert.equal(ws.lanes.getTab(borrowed.id), borrowed)
    assert.equal((await copiedSession.cookies.get({})).length, 0)
    assert.equal((await userSession.cookies.get({})).length, 2)
    assert.equal((await foreignSession.cookies.get({})).length, 1)
    result.nativeLaneClearScoped = true
    console.log(JSON.stringify(result))
  } finally {
    executor?.dispose()
    await ws?.dispose()
    main.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

probe().then(() => app.exit(0), (error) => {
  console.error(error.code || error.name, error.stack)
  app.exit(1)
})
