'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createDispatch } = require('./dispatch.cjs')
const { createSocketServer } = require('./socket-server.cjs')
const { PROFILE_RE } = require('./tools.cjs')
const { createProfileTokens, newToken } = require('./profile-tokens.cjs')

function electronBinary(appPath) {
  // In Electron main, require('electron') is the built-in API, not the npm
  // package's executable path. Resolve its package metadata explicitly.
  const packageDir = path.dirname(require.resolve('electron/package.json', { paths: [appPath] }))
  const relative = fs.readFileSync(path.join(packageDir, 'path.txt'), 'utf8').trim()
  const binary = path.resolve(packageDir, 'dist', relative)
  if (!relative || path.isAbsolute(relative) || !binary.startsWith(`${path.join(packageDir, 'dist')}${path.sep}`)) {
    throw new Error('Invalid Electron executable path')
  }
  return binary
}

function registerMcp(ctx) {
  const appPath = ctx.appPath || path.resolve(__dirname, '../../..')
  const appVersion = ctx.appVersion || require(path.join(appPath, 'package.json')).version
  const dispatch = createDispatch(ctx)
  const listeners = new Set()
  let disposed = false
  let closing
  let state = 'off'
  let detail = 'Starting Hermes Desk MCP'
  const tokens = createProfileTokens(path.join(ctx.userDataDir, 'mcp'))
  const socket = createSocketServer({ ...ctx, dispatch, appVersion, verifyToken: tokens.verify,
    onError: () => update('error', 'MCP socket unavailable') })

  function status() {
    return { state, detail, socketPath: socket.socketPath }
  }
  function update(next, message) {
    if (disposed && next !== 'off') return
    state = next
    detail = message
    for (const callback of listeners) callback(status())
  }
  const started = socket.start().then(
    () => update('ready', 'Hermes Desk MCP socket listening'),
    (error) => update('error', error?.code === 'EADDRINUSE' ?
      'Hermes Desk MCP socket could not start: another listener owns the path' :
      'Hermes Desk MCP socket could not start'),
  )

  return {
    status,
    cancelLane: dispatch.cancelLane,
    onStatus(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    configEntryFor(profile) {
      if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) throw new Error('Invalid Hermes profile')
      const shim = ctx.isPackaged ?
        path.join(ctx.resourcesPath || process.resourcesPath, 'app.asar.unpacked', 'electron/local/mcp/shim/hermes-desk-mcp.cjs') :
        path.join(appPath, 'electron/local/mcp/shim/hermes-desk-mcp.cjs')
      return {
        command: ctx.isPackaged ? process.execPath : electronBinary(appPath),
        args: [shim, '--profile', profile, '--socket', socket.socketPath],
        // This is a proposal only. The confirmed config-writer apply persists
        // authority; previews must not revoke a running profile's credential.
        env: { ELECTRON_RUN_AS_NODE: '1', HERMES_DESK_MCP_TOKEN: newToken() }, tools: {},
      }
    },
    dispose() {
      if (closing) return closing
      disposed = true
      closing = (async () => {
        await socket.dispose()
        await started
        await dispatch.dispose()
        update('off', 'Hermes Desk MCP stopped')
        listeners.clear()
      })()
      return closing
    },
  }
}

module.exports = { registerMcp, electronBinary }
