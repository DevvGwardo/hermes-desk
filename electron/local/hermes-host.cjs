'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')
const { promisify } = require('node:util')
const binGuard = require('../bin-guard.cjs')
const agentEnv = require('../agent-env.cjs')
const serveAuth = require('../serve-auth.cjs')
const { createServeClient, loopbackBaseUrl } = require('./serve-client.cjs')
const { createGatewayClient } = require('./gateway-client.cjs')
const { computerStatus } = require('./computer-status.cjs')
const { scrubText } = require('./workspace/redactor.cjs')

function discoverHermes(home) {
  const pinned = path.join(home, 'hermes-agent', 'venv', 'bin', 'hermes')
  let candidate = pinned
  try { fs.accessSync(candidate, fs.constants.X_OK) } catch {
    // Finder launches do not inherit the user's shell-expanded PATH.
    const result = binGuard.resolveTrustedBin('hermes', {
      extraDirs: [path.join(os.homedir(), '.local', 'bin')],
    })
    if (!result.ok) throw new Error('Hermes CLI not found')
    candidate = result.bin
  }
  const real = fs.realpathSync(candidate)
  if (!binGuard.verifyAndLogBin(real, 'hermes serve').ok) throw new Error('Hermes binary is not trusted')
  return real
}

function resolveHermesHome(ctx = {}, env = process.env) {
  const packaged = ctx.app?.isPackaged ?? ctx.isPackaged ?? true
  const override = !packaged && (env.HERMES_DESK_HERMES_HOME || ctx.hermesHome)
  if (!override) return path.join(os.homedir(), '.hermes')
  if (typeof override !== 'string' || !path.isAbsolute(override) || /[\x00-\x1f]/.test(override)) {
    throw new Error('Expected an absolute development Hermes home')
  }
  return path.resolve(override)
}

async function freeServePort(start = 9120, { exact = false } = {}) {
  if (!Number.isInteger(start) || start < 1024 || start > 65535 || [8642, 9119].includes(start)) {
    throw new Error('Invalid serve port')
  }
  for (let port = start; port <= Math.min(65535, exact ? start : start + 100); port++) {
    if ([8642, 9119].includes(port)) continue
    const free = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error('No free Hermes serve port')
}

/** Verify the server end of this exact TCP connection, not a racy port probe. */
async function verifySpawnedPeer(peer, child, { run = promisify(execFile), uid = process.getuid?.() } = {}) {
  if (!child || !Number.isInteger(child.pid) || child.exitCode != null || child.signalCode != null ||
      peer?.remoteAddress !== '127.0.0.1' || !peer.localPort || !peer.remotePort) return false
  for (let attempt = 0; attempt < 3; attempt++) {
    if (peer.destroyed || child.exitCode != null || child.signalCode != null) return false
    try {
      let stdout
      try {
        ({ stdout } = await run('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${peer.remotePort}`,
          '-sTCP:ESTABLISHED', '-Fpun'], { timeout: 1500, maxBuffer: 256 * 1024 }))
      } catch (error) {
        if (error.code !== 1) return false
        stdout = error.stdout ?? ''
      }
      const target = `127.0.0.1:${peer.remotePort}->127.0.0.1:${peer.localPort}`
      let pid, owner
      const candidates = new Set()
      for (const line of stdout.split('\n')) {
        if (line.startsWith('p')) { pid = Number(line.slice(1)); owner = undefined }
        if (line.startsWith('u')) owner = Number(line.slice(1))
        if (line === `n${target}` && Number.isInteger(pid)) {
          if (owner !== uid) return false
          candidates.add(pid)
        }
      }
      if (!candidates.size && attempt < 2) {
        // connect can precede accept: the server has no inspectable fd yet.
        await new Promise(resolve => setTimeout(resolve, 25))
        continue
      }
      if (candidates.size !== 1 || peer.destroyed) return false
      const { stdout: group } = await run('/bin/ps', ['-p', String([...candidates][0]), '-o', 'pgid=,uid='],
        { timeout: 1500, maxBuffer: 4096 })
      const [pgid, processUid] = group.trim().split(/\s+/).map(Number)
      return pgid === child.pid && processUid === uid && !peer.destroyed &&
        child.exitCode == null && child.signalCode == null
    } catch { return false }
  }
  return false
}

async function probeServe(baseUrl, token, verifyPeer) {
  if (!token) return null
  try {
    const data = await serveAuth.requestOwnedJson('/api/status', {
      baseUrl: loopbackBaseUrl(baseUrl), auth: { token }, verifyPeer,
      maxBytes: 64 * 1024, timeoutMs: 2500,
    })
    return { version: typeof data?.version === 'string' ? data.version.slice(0, 100) : undefined }
  } catch { return null }
}

function createHermesHost(ctx = {}) {
  const deps = {
    env: process.env, discoverHermes, freeServePort, probeServe, verifySpawnedPeer, spawn,
    randomToken: () => crypto.randomBytes(32).toString('hex'),
    setTimer: setTimeout, clearTimer: clearTimeout,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    kill(child, signal) {
      try { process.kill(-child.pid, signal) } catch { child.kill(signal) }
    },
    createServeClient, createGatewayClient,
    ...ctx.hostDeps,
  }
  const home = resolveHermesHome(ctx, deps.env)
  // The isolated E2E app must not even probe the user's gateway.
  const isolatedTest = !(ctx.app?.isPackaged ?? ctx.isPackaged ?? true) &&
    deps.env.HERMES_DESK_E2E === '1'
  const verifyPeer = (peer) => running && child ? deps.verifySpawnedPeer(peer, child) : false
  const client = deps.createServeClient({ WebSocketImpl: serveAuth.verifiedWebSocket(verifyPeer),
    approveRendererAction: ctx.approveRendererAction, approveModelDefault: ctx.approveModelDefault })
  const gateway = deps.createGatewayClient()
  const listeners = new Set()
  let state = { gateway: { state: 'unknown', url: 'http://127.0.0.1:8642' },
    serve: { state: 'down', stderrTail: [] }, controller: 'off', computerUse: 'unknown',
    installation: { home, homeExists: fs.existsSync(home), binary: null, detected: false } }
  let running = false
  let generation = 0
  let child = null
  let retryTimer = null
  let healthTimer = null
  let computerTimer = null
  let computerEpoch = 0
  let retryMs = 1000
  let activeToken = ''
  let activeUrl = null
  let starting = null
  let restarting = null
  let stopping = Promise.resolve()
  let stderrBuffer = ''
  let stderrPemLabel = null
  let stderrDiscardLine = false

  function status() { return structuredClone(state) }
  function emit() { for (const cb of listeners) cb(status()) }
  function setServe(patch) {
    const previous = state.serve.state
    state.serve = { ...state.serve, ...patch }
    if (previous !== state.serve.state) {
      deps.clearTimer(computerTimer)
      computerTimer = null
      computerEpoch++
      state.computerUse = 'unknown'
      state.computerUseDetail = state.serve.state === 'up'
        ? 'Checking computer-use readiness.'
        : 'Computer-use readiness is unavailable while Hermes is disconnected.'
      if (state.serve.state === 'up') void refreshComputer(computerEpoch)
    }
    emit()
  }
  async function refreshComputer(epoch) {
    if (!running || epoch !== computerEpoch || state.serve.state !== 'up') return
    if (isolatedTest || !ctx.serveAuth?.computerRequest) {
      state.computerUseDetail = isolatedTest ? 'Computer-use probe disabled for isolated E2E.'
        : 'Computer-use readiness reader is unavailable.'
      return
    }
    let next
    try {
      // Machine readiness must not depend on an open preview or live chat.
      next = computerStatus(await ctx.serveAuth.computerRequest('/api/tools/computer-use/status?profile=default'))
    } catch {
      next = computerStatus(null)
    }
    if (!running || epoch !== computerEpoch || state.serve.state !== 'up') return
    Object.assign(state, next)
    emit()
    computerTimer = deps.setTimer(() => { computerTimer = null; void refreshComputer(epoch) }, 15000)
    computerTimer?.unref?.()
  }
  function safeLine(line) {
    let value = line
    if (stderrPemLabel) {
      const end = `-----END ${stderrPemLabel}-----`
      const index = value.indexOf(end)
      if (index === -1) return '[secret]'
      value = '[secret]' + value.slice(index + end.length)
      stderrPemLabel = null
    }
    for (const begin of value.matchAll(/-----BEGIN ([A-Z0-9][A-Z0-9 ]*)-----/g)) {
      if (!value.slice(begin.index).includes(`-----END ${begin[1]}-----`)) {
        stderrPemLabel = begin[1]
        break
      }
    }
    if (value.length > 8192) return '[oversized stderr line omitted]'
    for (const token of [activeToken, deps.env.HERMES_DASHBOARD_SESSION_TOKEN]) {
      if (token) value = value.split(token).join('[secret]')
    }
    return scrubText(value).replace(/([?&]token=)[^&\s]+/gi, '$1[secret]')
      .replace(/\b(?:sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|xox[bpas]-[A-Za-z0-9-]+)/g, '[secret]')
      .replace(/(bearer\s+)\S+/gi, '$1[secret]')
      .replace(/((?:token|password|passwd|passphrase|api[_-]?key|secret|authorization)(?:\s*["'])?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;}]+)/gi, '$1[secret]').slice(0, 2000)
  }
  function recordStderr(chunk, flush = false) {
    const lines = (stderrBuffer + (chunk || '')).split(/\r?\n/)
    stderrBuffer = flush ? '' : lines.pop()
    // Never publish a detached continuation after truncating a credential line.
    if (stderrDiscardLine) {
      if (!lines.length) { stderrBuffer = ''; return }
      lines.shift()
      stderrDiscardLine = false
    }
    if (stderrBuffer.length > 8192) {
      lines.push(stderrBuffer)
      stderrBuffer = ''
      stderrDiscardLine = true
    }
    state.serve.stderrTail = [...state.serve.stderrTail, ...lines.filter(Boolean).map(safeLine)].slice(-50)
    emit()
  }

  async function endpoint(url, auth, proc, epoch) {
    await ctx.serveAuth?.setEndpoint?.({ baseUrl: url, auth, client, verifyPeer })
    if (!running || child !== proc || epoch !== generation) return false
    activeUrl = url
    activeToken = auth.token
    client.setEndpoint(url, auth)
    return true
  }
  async function refreshGateway(epoch) {
    const health = isolatedTest ? { state: 'unknown', detail: 'Gateway probe disabled for isolated E2E' }
      : await gateway.health().catch(() => ({ state: 'down', detail: 'Gateway unavailable' }))
    if (!running || epoch !== generation) return
    state.gateway = health
    emit()
    healthTimer = deps.setTimer(() => { healthTimer = null; void refreshGateway(epoch) }, 30000)
    healthTimer?.unref?.()
  }
  function scheduleRestart(epoch) {
    if (!running || epoch !== generation || retryTimer) return
    retryTimer = deps.setTimer(() => {
      retryTimer = null
      void launch(epoch)
    }, retryMs)
    retryTimer?.unref?.()
    retryMs = Math.min(30000, retryMs * 2)
  }

  async function launch(epoch) {
    try {
      setServe({ state: 'starting', detail: undefined })
      const settings = ctx.getAppConfig?.()?.serve || { mode: 'auto', port: 9120 }
      if (!['auto', 'attach', 'spawn'].includes(settings.mode)) throw new Error('Invalid serve mode')
      if (settings.mode === 'attach') {
        // CONTRACT: installed Hermes has no server-auth challenge. A pinned
        // bearer authenticates us, not the peer. Never disclose it to a listener.
        setServe({ state: 'down', detail: 'External serve attachment cannot be authenticated. Choose auto or spawn.',
          url: undefined, port: settings.port, mode: undefined })
        return
      }
      let bin
      try {
        bin = deps.discoverHermes(home)
        state.installation = { home, homeExists: fs.existsSync(home), binary: bin, detected: true }
      } catch {
        state.installation = { home, homeExists: fs.existsSync(home), binary: null, detected: false }
        throw new Error('Hermes CLI not found')
      }
      const port = await deps.freeServePort(settings.port, { exact: settings.mode === 'spawn' })
      if (!running || epoch !== generation) return
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || [8642, 9119].includes(port)) throw new Error('Invalid serve port')
      activeToken = deps.randomToken()
      const url = `http://127.0.0.1:${port}`
      // Recheck the resolved executable at every spawn, including restarts.
      if (!ctx.hostDeps?.discoverHermes && !binGuard.inspectBinTrust(bin).ok) throw new Error('Hermes binary is not trusted')
      const proc = deps.spawn(bin, ['serve', '--host', '127.0.0.1', '--port', String(port)], {
        // Hermes uses its existing Desktop ownership marker to bypass the
        // machine singleton; otherwise it can refuse our explicitly chosen port.
        // A managed backend must leave interrupted update tails to the CLI,
        // rather than rebuilding Hermes on every restart until readiness times out.
        env: { ...agentEnv.scrubAgentEnv(deps.env), HERMES_HOME: home, HERMES_DESKTOP: '1',
          // Lazy-only recovery skips session.create's approval-bridge bootstrap.
          // Match Hermes's existing gateway prompt mode before any tool can run.
          HERMES_GATEWAY_SESSION: '1', HERMES_EXEC_ASK: '1', HERMES_INTERACTIVE: '1',
          HERMES_SUPERVISED_CHILD: '1',
          HERMES_DASHBOARD_SESSION_TOKEN: activeToken },
        shell: false, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
      })
      child = proc
      stderrBuffer = ''
      stderrPemLabel = null
      stderrDiscardLine = false
      setServe({ state: 'starting', url, port, mode: 'spawned', version: undefined })
      const startedAt = Date.now()
      const failed = () => {
        if (child !== proc) return
        child = null
        recordStderr('', true)
        client.stop()
        ctx.serveAuth?.clearEndpoint?.()
        if (!running || epoch !== generation) return
        setServe({ state: 'down', detail: 'Hermes serve exited; retrying' })
        if (Date.now() - startedAt >= 30000) retryMs = 1000
        scheduleRestart(epoch)
      }
      proc.stderr?.on('data', (data) => {
        if (child === proc) recordStderr(data.toString('utf8'))
      })
      proc.once('error', failed)
      proc.once('exit', failed)
      // Large plugin/MCP inventories can take well over ten seconds before the
      // HTTP listener exists; cold boots have been measured at 90-130s. Killing
      // a healthy slow boot at a tighter bound than the boot takes just
      // restarts an equally slow one, so the window is ten minutes: long
      // enough for a real boot, still bounded so a wedged backend cycles.
      for (let attempt = 0; attempt < 2400 && child === proc && running && epoch === generation; attempt++) {
        const info = await deps.probeServe(url, activeToken, verifyPeer)
        if (child !== proc || !running || epoch !== generation) return
        if (info) {
          if (!await endpoint(url, { token: activeToken, source: 'env' }, proc, epoch)) return
          setServe({ state: 'up', detail: undefined, ...info })
          return
        }
        await deps.sleep(250)
      }
      if (child === proc && running && epoch === generation) {
        setServe({ state: 'down', detail: 'Hermes serve did not become ready' })
        deps.kill(proc, 'SIGTERM')
        const timer = deps.setTimer(() => {
          if (child === proc) deps.kill(proc, 'SIGKILL')
        }, 2000)
        timer?.unref?.()
      }
    } catch {
      if (!running || epoch !== generation) return
      setServe({ state: 'down', detail: 'Unable to start Hermes serve; check the Hermes installation' })
      scheduleRestart(epoch)
    }
  }

  client.onConnection((up) => {
    if (!running || !activeUrl) return
    if (!up && state.serve.state === 'up') setServe({ state: 'down', detail: 'Hermes serve disconnected' })
    else if (up) setServe({ state: 'up', detail: undefined })
  })

  async function start() {
    await stopping
    if (running) return starting
    running = true
    const epoch = ++generation
    void refreshGateway(epoch)
    starting = launch(epoch)
    await starting
  }

  function stop() {
    running = false
    generation++
    deps.clearTimer(retryTimer)
    deps.clearTimer(healthTimer)
    retryTimer = healthTimer = null
    client.stop()
    ctx.serveAuth?.clearEndpoint?.()
    const proc = child
    child = null
    recordStderr('', true)
    activeToken = ''
    activeUrl = null
    setServe({ state: 'down', detail: undefined })
    stopping = proc ? new Promise((resolve) => {
      let timer
      const done = () => { deps.clearTimer(timer); resolve() }
      proc.once('exit', done)
      timer = deps.setTimer(() => { deps.kill(proc, 'SIGKILL'); resolve() }, 2000)
      timer?.unref?.()
      deps.kill(proc, 'SIGTERM')
    }) : Promise.resolve()
    return stopping
  }

  return {
    start, stop, status,
    restartServe() {
      if (restarting) return restarting
      restarting = (async () => {
        await stop()
        retryMs = 1000
        await start()
      })().finally(() => { restarting = null })
      return restarting
    },
    onStatus(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    getServeClient: () => client,
    setControllerStatus(controller, detail) {
      if (!['off', 'connecting', 'ready', 'error', 'mismatch'].includes(controller)) return
      state.controller = controller
      state.controllerDetail = typeof detail === 'string' ? detail.slice(0, 2000) : undefined
      emit()
    },
  }
}

module.exports = { createHermesHost, discoverHermes, freeServePort, probeServe, resolveHermesHome, verifySpawnedPeer }
