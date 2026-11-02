import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
const require = createRequire(import.meta.url)
const { app, BrowserWindow, session } = require('electron')
const { createEgressProxy } = require('./egress-proxy.cjs')
const root = process.argv[2]
if (!root || !path.isAbsolute(root)) throw new Error('Temporary home required')
app.setPath('userData', path.join(root, 'userData'))
app.setPath('sessionData', path.join(root, 'sessionData'))
app.setPath('logs', path.join(root, 'logs'))
app.commandLine.appendSwitch('disable-background-networking')
app.on('window-all-closed', () => {})
async function probe() {
await app.whenReady()
app.dock?.hide()
let hits = 0, rebinds = 0
const dials = []
const server = http.createServer((req, res) => {
  hits++
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: 'http://private.test/secret' }); res.end(); return
  }
  res.setHeader('Content-Type', 'text/html')
  res.end('<!doctype html><title>Synthetic egress</title><p>synthetic fixture only</p>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const proxy = createEgressProxy({
  lookup: async host => {
    if (host === 'private.test' || host === 'rebind.test' && ++rebinds > 1) return [{ address: '10.0.0.9', family: 4 }]
    if (host === 'mixed.test') return [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }]
    if (!['public.test', 'rebind.test'].includes(host)) throw new Error('Unexpected fixture hostname')
    return [{ address: '8.8.8.8', family: 4 }]
  },
  connect: options => {
    assert.deepEqual(options, { host: '8.8.8.8', family: 4, port: 80 })
    dials.push(options)
    // Fixture only: no public connection can be made by this dialer.
    return net.connect({ host: '127.0.0.1', port: server.address().port })
  },
})
const ses = session.fromPartition('synthetic-agent-egress')
const win = new BrowserWindow({ show: false, webPreferences: {
  session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
} })
win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
try {
  await ses.setProxy(await proxy.ready())
  await ses.closeAllConnections()
  await win.loadURL('http://public.test/public')
  assert.match(await win.webContents.executeJavaScript('document.body.textContent'), /synthetic fixture only/)
  assert(dials.length > 0)
  const before = hits
  for (const url of [
    'http://private.test/secret', 'http://mixed.test/secret',
    `http://127.0.0.1:${server.address().port}/secret`,
    'https://private.test/secret',
  ]) await win.loadURL(url).catch(() => {})
  assert.equal(hits, before, 'Forbidden destinations must never reach an upstream socket')
  await win.loadURL('http://public.test/redirect').catch(() => {})
  assert.equal(hits, before + 1, 'Redirect may reach only the public first hop')
  await win.loadURL('http://rebind.test/first')
  const afterFirst = hits
  await win.loadURL('http://rebind.test/second').catch(() => {})
  assert.equal(hits, afterFirst, 'A fresh connection must reject rebound private answers')
  await proxy.dispose()
  await ses.closeAllConnections()
  await assert.rejects(win.loadURL('http://public.test/offline'))
  assert.equal(hits, afterFirst, 'A failed proxy must never fall back to DIRECT')
  console.log(JSON.stringify({ nativeEgress: true, publicPinned: true, privateDenied: true,
    redirectDenied: true, rebindingDenied: true, noDirectFallback: true }))
} finally {
  win.destroy()
  await proxy.dispose()
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
  app.quit()
}
}
probe().catch(error => { console.error(error); app.exit(1) })
