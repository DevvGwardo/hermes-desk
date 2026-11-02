'use strict'

// Loaded only by Playwright into the disposable E2E main process, after boot.
// Observers call the original methods. Only native dialogs and the documented
// secrets-op dependency seam are stubbed; no policy/input/result is bypassed.
module.exports = function observe({ root, repo }) {
  const { dialog, webContents } = require('electron')
  const fs = require('node:fs')
  const path = require('node:path')
  const { spawnSync } = require('node:child_process')
  const boot = globalThis.__hermesDeskE2E
  const evidence = globalThis.__bpWorkspace = {
    dialogs: [], commands: [], fills: [], overlays: [], steers: [], downloads: [],
    answer: 1, raceOrigin: null, secretDeps: false,
  }
  dialog.showMessageBox = async (...args) => {
    const options = args.at(-1)
    const allowed = /browse|browsing|Copy sign-in|Clear browser data|wants to fill|Choose a 1Password item/.test(options.message)
    const response = allowed ? evidence.answer : 0
    evidence.dialogs.push({ title: options.title, message: options.message,
      detail: options.detail, buttons: options.buttons, defaultId: options.defaultId, response, at: Date.now() })
    if (evidence.raceOrigin && /wants to fill/.test(options.message)) {
      const tab = boot.ws.lanes.getActiveTab('profile:alpha')
      await tab.webContents.loadURL(evidence.raceOrigin)
      evidence.raceOrigin = null
    }
    return { response, checkboxChecked: false }
  }
  const call = boot.serveClient.call.bind(boot.serveClient)
  boot.serveClient.call = (method, params) => {
    if (method === 'session.steer') evidence.steers.push({ ...params, at: Date.now() })
    return call(method, params)
  }
  const overlay = boot.ws.parts.overlay
  const send = overlay.send.bind(overlay)
  overlay.send = msg => { evidence.overlays.push({ ...msg, at: Date.now() }); return send(msg) }
  const watch = wc => {
    const command = wc.debugger.sendCommand.bind(wc.debugger)
    wc.debugger.sendCommand = async (method, params, ...rest) => {
      const at = Date.now()
      if (method.startsWith('Input.')) evidence.commands.push({ wc: wc.id, method, params, at })
      const result = await command(method, params, ...rest)
      if (method === 'Runtime.callFunctionOn' && params.functionDeclaration?.includes('function(origin, text)')) {
        evidence.fills.push({ wc: wc.id, at, inserted: result.result?.value === true,
          exception: Boolean(result.exceptionDetails) })
      }
      return result
    }
  }
  for (const wc of webContents.getAllWebContents()) watch(wc)
  require('electron').app.on('web-contents-created', (_event, wc) => watch(wc))
  boot.ws.lanes.on('changed', () => {
    for (const lane of boot.ws.lanes.allLanes()) {
      const ses = require('electron').session.fromPartition(lane.partition)
      if (ses.__bpWatching) continue
      ses.__bpWatching = true
      ses.on('will-download', (_event, item) => {
        const entry = { lane: lane.id, filename: item.getFilename(), total: item.getTotalBytes(),
          at: Date.now(), cancelled: item.getState() === 'cancelled' }
        evidence.downloads.push(entry)
        item.on('done', (_event, state) => { entry.state = state })
      })
    }
  })
  const op = require(path.join(repo, 'electron/secrets-op.cjs'))
  // Production refuses PATH/unverified binaries by design. Check that refusal
  // separately, then exercise a fake CLI through its supported I/O seam.
  evidence.opPathRefusal = op.verifyOpBinary(path.join(root, 'bin/op'))
  evidence.installFakeOp = () => {
    const deps = {
      existsSync: candidate => candidate === '/usr/local/bin/op',
      runCodesign: () => ({ stderr: 'TeamIdentifier=2BUA8C4S2C' }),
      runOp: (_bin, args) => spawnSync(path.join(root, 'bin/op'), args, { encoding: 'utf8', env: { PATH: process.env.PATH } }),
    }
    const list = op.listSecrets, resolve = op.resolveForFill
    op.listSecrets = () => list(deps)
    op.resolveForFill = ref => resolve(ref, deps)
    evidence.secretDeps = true
  }
  fs.writeFileSync(path.join(root, 'bin/op'), `#!/bin/sh
case "$1" in
  item) printf '%s' '[{"id":"fakeItem","title":"Blueprint fake login","vault":{"id":"fakeVault"}}]' ;;
  read) printf '%s' 'bpw-FAKE-vault-fill-never-use' ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 })
  return { observed: true }
}
