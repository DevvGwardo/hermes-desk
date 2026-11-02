'use strict'

// Opt-in local probe, launched only by hermes-desk-electron.test.ts. It uses an
// isolated userData directory and an ephemeral loopback fixture, never Hermes.
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createUrlPolicy } = require('../../../electron/local/workspace/url-policy.cjs')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-redteam-electron-'))
app.setPath('userData', directory)
app.setPath('sessionData', directory)
let window
let server
const deadline = setTimeout(() => {
  console.log(JSON.stringify({ error: 'local probe timeout' }))
  app.exit(1)
}, 15_000)

app.whenReady().then(async () => {
  app.dock?.hide()
  let reached = false
  server = http.createServer((_request, response) => {
    reached = true
    response.end('<!doctype html><title>Inert loopback fixture</title>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = `http://0.0.0.0:${port}/`
  const verdict = createUrlPolicy({ servePorts: [port] }).check(url, { laneKind: 'agent' })
  window = new BrowserWindow({ show: false, focusable: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    webSecurity: true, allowRunningInsecureContent: false,
  } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (verdict.ok) await window.loadURL(url)
  console.log(JSON.stringify({
    policyAllowed: verdict.ok, loopbackFixtureReached: reached,
    loadedFixture: window.webContents.getTitle() === 'Inert loopback fixture',
  }))
}).catch(() => {
  console.log(JSON.stringify({ error: 'local probe failed' }))
  process.exitCode = 1
}).finally(async () => {
  clearTimeout(deadline)
  window?.destroy()
  if (server?.listening) await new Promise((resolve) => server.close(resolve))
  app.quit()
})

app.on('quit', () => {
  // Only this probe's freshly created temporary directory is removed.
  fs.rmSync(directory, { recursive: true, force: true })
})
