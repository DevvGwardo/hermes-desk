'use strict'

/**
 * Hermes serve session token — kept in the main process (#161).
 *
 * The renderer used to receive the raw dashboard session token from
 * `maia:serveConfig` and attach it itself (X-Hermes-Session-Token header,
 * `?token=` on WebSockets). Any script running in the renderer could read
 * it. Now:
 *
 *   - `maia:serveConfig` answers presence only ({ present, baseUrl,
 *     tokenSource: 'env' | 'file' | 'none', hermesHome }).
 *   - REST: main injects a separate local-proxy credential into top-frame
 *     app XHR. The app-owned proxy verifies the connected serve process
 *     before sending the real token. Chromium never sends that token.
 *   - WebSockets: the serve WS gate only accepts `?token=` (headers are
 *     ignored) and Electron's webRequest cannot rewrite a WS URL, so main
 *     opens the socket itself and relays frames over IPC
 *     (createServeSocketBroker). Only the two known serve socket paths are
 *     reachable.
 *
 * Pure Node — electron objects are passed in — unit-testable like bin-guard.
 */

const os = require('os')
const path = require('path')
const { promises: fsp } = require('fs')
const http = require('node:http')
const net = require('node:net')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { canonicalApiPath, isDashboardRouteAllowed } = require('./dashboard-routes.cjs')

const SERVE_TOKEN_HEADER = 'X-Hermes-Session-Token'
const SERVE_RENDERER_HEADER = 'X-Hermes-Desk-Renderer'
const DEFAULT_SERVE_URL = 'http://127.0.0.1:9119'
/** Token file re-read at most this often (it can be rotated under us). */
const TOKEN_CACHE_MS = 5000
/** The only serve WebSocket endpoints the renderer can reach via main. */
const SERVE_SOCKET_PATHS = new Set(['/api/ws', '/api/plugins/kanban/events'])
const SERVE_SOCKET_EVENT = 'maia:serveSocketEvent'
const MAX_SOCKETS_PER_SENDER = 8
const MAX_FRAME_CHARS = 4 * 1024 * 1024
// Transcript history includes compression ancestors and can legitimately exceed
// the outbound RPC ceiling. Keep a separate, bounded inbound allowance so a
// large history response does not close the socket and trigger reconnect loops.
const MAX_INBOUND_FRAME_CHARS = 16 * 1024 * 1024
const SOCKET_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const QUERY_KEY_RE = /^[a-z_]{1,32}$/
/** Credentials are main's job — a renderer-supplied one is dropped. */
const RESERVED_QUERY_KEYS = new Set(['token', 'ticket'])
const SERVE_FAILURE_HEADER = 'X-Hermes-Serve-Failure'

/** @param {NodeJS.ProcessEnv} [env] */
function hermesHome(env = process.env) {
  return env.HERMES_HOME || path.join(os.homedir(), '.hermes')
}

function ownedAgent(url, verifyPeer) {
  const agent = new http.Agent({ keepAlive: false })
  agent.createConnection = (_options, done) => {
    const peer = net.connect({ host: '127.0.0.1', port: Number(url.port || 80) })
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      if (error) peer.destroy()
      done(error, error ? undefined : peer)
    }
    peer.once('error', () => finish(new Error('Serve peer unavailable')))
    const unverified = () => Object.assign(new Error('Serve peer not verified'), { code: 'HERMES_PEER_UNVERIFIED' })
    peer.once('close', () => finish(unverified()))
    const timer = setTimeout(() => finish(Object.assign(new Error('Serve peer verification timed out'),
      { code: 'HERMES_PEER_TIMEOUT' })), 2500)
    timer.unref?.()
    peer.once('connect', () => {
      Promise.resolve().then(() => verifyPeer(peer)).then((ok) => {
        finish(ok && !peer.destroyed ? null : unverified())
      }, () => finish(unverified())).finally(() => clearTimeout(timer))
    })
    peer.once('close', () => clearTimeout(timer))
    // Returning a socket here would send headers before verification.
  }
  return agent
}

/**
 * Serve base URL (HERMES_SERVE_URL → loopback default), normalized to an
 * http(s) origin with no trailing slash. Junk falls back to the default.
 * @param {NodeJS.ProcessEnv} [env]
 */
function serveBaseUrl(env = process.env) {
  const raw = env.HERMES_SERVE_URL || DEFAULT_SERVE_URL
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULT_SERVE_URL
    return `${u.protocol}//${u.host}`
  } catch {
    return DEFAULT_SERVE_URL
  }
}

/**
 * Token source precedence:
 *   1. HERMES_DASHBOARD_SESSION_TOKEN env (set by the launcher / deployed VM)
 *   2. HERMES_SERVE_TOKEN_FILE env → file contents (trimmed)
 *   3. ~/.hermes/serve.token file if present (dev convenience)
 * @returns {Promise<{ token: string, source: 'env' | 'file' | 'none' }>}
 */
async function readServeToken({ env = process.env, readFile = fsp.readFile } = {}) {
  const fromEnv = env.HERMES_DASHBOARD_SESSION_TOKEN || ''
  if (fromEnv) return { token: fromEnv, source: 'env' }
  const tokenFile = env.HERMES_SERVE_TOKEN_FILE || path.join(hermesHome(env), 'serve.token')
  try {
    const token = String(await readFile(tokenFile, 'utf8')).trim()
    if (token) return { token, source: 'file' }
  } catch {
    /* no token file — caller decides fallback */
  }
  return { token: '', source: 'none' }
}

/** Memoize readServeToken for TOKEN_CACHE_MS (per-request file reads are wasteful). */
function cachedServeToken({ read = readServeToken, now = Date.now, ttlMs = TOKEN_CACHE_MS } = {}) {
  let cached = null
  let at = 0
  return async function getServeToken() {
    if (cached && now() - at < ttlMs) return cached
    cached = await read()
    at = now()
    return cached
  }
}

/**
 * What the renderer may learn: presence, never the token or its file path.
 * @param {{ token: string, source: string }} auth
 */
function serveConfigForRenderer(auth, env = process.env) {
  const present = Boolean(auth && auth.token)
  return {
    present,
    baseUrl: serveBaseUrl(env),
    tokenSource: present ? auth.source : 'none',
    hermesHome: hermesHome(env),
    ...(present
      ? {}
      : { error: 'no serve token (set HERMES_DASHBOARD_SESSION_TOKEN or write ~/.hermes/serve.token)' }),
  }
}

/** webRequest URL filter for the serve origin. */
function serveRequestFilter(baseUrl) {
  return { urls: [`${new URL(baseUrl).origin}/*`] }
}

/**
 * Header injection gate: same origin as serve, fetch/XHR only, from the TOP
 * frame of one of the app's own windows (main window, HUD). Anything else
 * (sub-frames such as nub-vm previews, other webContents, main-process net
 * requests, navigations, images) is left untouched.
 * @param {{ baseUrl: string, trustedWebContents: any[] }} opts
 */
function rendererRestAllowed(method, raw) {
  try {
    const url = new URL(raw)
    const pathname = canonicalApiPath(url.pathname)
    if (!pathname || /^\/api\/(?:config|env|mcp|messaging|pairing)(?:\/|$)/.test(pathname) ||
        /^\/api\/memory\/providers\//.test(pathname) ||
        /^\/api\/tools\/toolsets\/[^/]+\/(?:config|env)$/.test(pathname)) return false
    if ([...url.searchParams.keys()].some((key) => /^(?:token|ticket|reveal|raw|secret|credentials)$/i.test(key))) return false
    return isDashboardRouteAllowed(method, `${url.pathname}${url.search}`)
  } catch { return false }
}

function shouldAttachServeToken(details, { baseUrl, trustedWebContents }) {
  if (!details || !Array.isArray(trustedWebContents)) return false
  const wc = trustedWebContents.find((w) => w && w.id === details.webContentsId)
  if (!wc) return false
  if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return false
  if (!details.frame || details.frame !== wc.mainFrame) return false
  if (details.resourceType !== 'xhr') return false
  try {
    return new URL(details.url).origin === new URL(baseUrl).origin &&
      rendererRestAllowed(details.method || 'GET', details.url)
  } catch {
    return false
  }
}

/**
 * Changes that skip the native confirm. The renderer can already prompt an
 * agent without one (prompt.submit), so the confirm guards what goes beyond
 * that: settings, secrets, schedules, access, bulk dispatch and deletion.
 * These rows are reversible, reduce activity, or are no stronger than a
 * prompt. Only the exact shape qualifies; anything extra still asks.
 */
const text = (max) => (value) => typeof value === 'string' && value.length <= max
const optionalText = (max) => (value) => value === null || text(max)(value)
const counter = (value) => Number.isSafeInteger(value) && value >= 0
// Hermes fences session edits with the revision the client read (mutation-snapshot).
const SESSION_IDENTITY = { request_id: text(128), expected_revision: counter, expected_generation: counter }
const CONFIRM_FREE = [
  // Opening a chat clears its unread flag.
  { method: 'PATCH', path: /^\/api\/sessions\/[^/]+$/, query: ['profile'], required: ['unread'],
    body: { unread: (value) => value === false, profile: text(64), ...SESSION_IDENTITY } },
  // Renaming a chat.
  { method: 'PATCH', path: /^\/api\/sessions\/[^/]+$/, query: ['profile'], required: ['title'],
    body: { title: (value) => text(200)(value) && value.trim().length > 0, profile: text(64), ...SESSION_IDENTITY } },
  // Pausing a routine stops future runs; Run now is the same as sending its prompt.
  { method: 'POST', path: /^\/api\/cron\/jobs\/[^/]+\/(?:pause|trigger)$/, query: ['profile'], body: {} },
  // Rejecting a proposed memory edit writes nothing.
  { method: 'POST', path: /^\/api\/memory\/pending\/[^/]+\/reject$/, query: [], body: {} },
  // Task board: viewing another board, comments, and editing or adding single tasks.
  { method: 'POST', path: /^\/api\/plugins\/kanban\/boards\/[^/]+\/switch$/, query: [], body: {} },
  { method: 'POST', path: /^\/api\/plugins\/kanban\/tasks\/[^/]+\/comments$/, query: ['board'], required: ['body'],
    body: { body: text(16384) } },
  { method: 'PATCH', path: /^\/api\/plugins\/kanban\/tasks\/[^/]+$/, query: ['board'],
    body: { status: text(64), assignee: optionalText(128), priority: optionalText(64), title: text(1024),
      body: optionalText(65536), result: optionalText(65536) } },
  { method: 'POST', path: /^\/api\/plugins\/kanban\/tasks$/, query: ['board'], required: ['title'],
    body: { title: text(1024), body: optionalText(65536), assignee: optionalText(128), priority: optionalText(64),
      tenant: optionalText(128), triage: (value) => typeof value === 'boolean',
      parents: (value) => Array.isArray(value) && value.length <= 64 && value.every(text(256)) } },
]

function skipsConfirm(method, url, body) {
  const pathname = canonicalApiPath(url.pathname) || ''
  const rules = CONFIRM_FREE.filter((rule) => rule.method === method && rule.path.test(pathname))
  if (!rules.length) return false
  let parsed = {}
  if (body.length) {
    try { parsed = JSON.parse(body.toString('utf8')) } catch { return false }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const keys = Object.keys(parsed).filter((key) => key !== 'client_request_id')
  if ('client_request_id' in parsed && !text(128)(parsed.client_request_id)) return false
  return rules.some((rule) => [...url.searchParams.keys()].every((key) => rule.query.includes(key)) &&
    keys.every((key) => Object.hasOwn(rule.body, key) && rule.body[key](parsed[key])) &&
    (rule.required || []).every((key) => key in parsed) &&
    (!('profile' in parsed) || !url.searchParams.has('profile') || parsed.profile === url.searchParams.get('profile')))
}

/** Chromium cannot verify its TCP peer, so its REST endpoint is app-owned. */
async function createServeRestProxy({ baseUrl, auth, verifyPeer, confirmMutation = async () => false } = {}) {
  const base = new URL(baseUrl)
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash || !auth?.token || typeof verifyPeer !== 'function') {
    throw new Error('Serve REST endpoint unavailable')
  }
  const token = crypto.randomBytes(32).toString('hex')
  const active = new Set()
  const server = http.createServer((request, response) => {
    // file:// ("null") and ephemeral dev origins share this broker. CORS is
    // not authorization: only trusted top-frame XHR gets the injected bearer,
    // and the bearer/route checks below run before any upstream request.
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Expose-Headers', SERVE_FAILURE_HEADER)
    const supplied = request.headers[SERVE_TOKEN_HEADER.toLowerCase()]
    const authorized = typeof supplied === 'string' && Buffer.byteLength(supplied) === Buffer.byteLength(token) &&
      crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    const refuse = (status, category = 'forbidden') => {
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(status, { 'Content-Type': 'application/json', [SERVE_FAILURE_HEADER]: category })
        response.end('{"error":"Serve request unavailable"}')
      }
      request.resume()
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      response.end()
      return
    }
    if (!authorized || !request.url.startsWith('/api/') ||
        /[\x00-\x1f\x7f\\#]/.test(request.url) ||
        !rendererRestAllowed(request.method, new URL(request.url, base).href)) return refuse(403)
    if (active.size >= 16) return refuse(503, 'busy')
    const operation = { stop: () => {} }
    active.add(operation)
    let upstream, agent, bytes = 0
    const chunks = []
    const finish = () => {
      clearTimeout(timer)
      active.delete(operation)
      upstream?.destroy()
      agent?.destroy()
    }
    const fail = (category = 'upstream-unavailable') => {
      if (!active.has(operation)) return
      refuse(502, category)
      finish()
    }
    const timer = setTimeout(() => fail('timeout'), 30000)
    timer.unref?.()
    operation.stop = () => { response.destroy(); finish() }
    response.once('close', finish)
    request.once('error', () => fail())
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) fail('request-too-large')
      else chunks.push(chunk)
    })
    request.once('end', async () => {
      if (!active.has(operation)) return
      const url = new URL(request.url, base)
      const body = Buffer.concat(chunks)
      if (!['GET', 'HEAD'].includes(request.method) && !skipsConfirm(request.method, url, body)) {
        let approved = false
        try {
          const senderId = Number(request.headers[SERVE_RENDERER_HEADER.toLowerCase()])
          if (Number.isSafeInteger(senderId) && senderId > 0 && body.length <= 8000) {
            approved = await confirmMutation({ senderId, method: request.method,
              path: `${url.pathname}${url.search}`, body: body.toString('utf8') })
          }
        } catch { /* Native permission failures never forward a mutation. */ }
        if (!active.has(operation)) return
        if (!approved) { refuse(403); finish(); return }
      }
      agent = ownedAgent(url, verifyPeer)
      upstream = http.request(url, { method: request.method, agent, headers: {
        [SERVE_TOKEN_HEADER]: auth.token, Accept: 'application/json', 'Content-Type': 'application/json',
      } }, (reply) => {
        if (reply.statusCode === 204) {
          response.writeHead(204); response.end(); finish(); return
        }
        if (reply.statusCode < 200 || reply.statusCode >= 300) return fail('upstream-http')
        if (!/application\/json|\+json/.test(reply.headers['content-type'] || '')) return fail('invalid-response')
        const result = []
        let length = 0
        reply.on('data', (chunk) => {
          length += chunk.length
          if (length > 5 * 1024 * 1024) fail('response-too-large')
          else result.push(chunk)
        })
        reply.once('error', () => fail())
        reply.once('end', () => {
          if (!active.has(operation)) return
          try {
            const data = JSON.parse(Buffer.concat(result).toString('utf8'))
            response.writeHead(reply.statusCode, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify(data))
            finish()
          } catch { fail('invalid-response') }
        })
      })
      upstream.once('error', (error) => fail(error.code === 'HERMES_PEER_UNVERIFIED' ? 'peer-unverified'
        : error.code === 'HERMES_PEER_TIMEOUT' ? 'timeout' : 'upstream-unavailable'))
      upstream.end(body)
    })
  })
  server.headersTimeout = 5000
  server.requestTimeout = 30000
  server.maxConnections = 32
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    auth: { token, source: 'env' },
    close() {
      for (const operation of active) operation.stop()
      server.closeAllConnections()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Connect first and authenticate the connected peer out-of-band before HTTP
 * writes any credential bytes. No pooled sockets, redirects or unbounded JSON.
 */
function requestOwnedJson(requestPath, {
  baseUrl, auth, verifyPeer, maxBytes = 5 * 1024 * 1024, timeoutMs = 5000, timezonePatch,
} = {}) {
  return new Promise((resolve, reject) => {
    let url, body
    try {
      const base = new URL(baseUrl)
      if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password ||
          base.pathname !== '/' || base.search || base.hash || !auth?.token || typeof verifyPeer !== 'function' ||
          typeof requestPath !== 'string' || !requestPath.startsWith('/api/') || requestPath.startsWith('//') ||
          /[\x00-\x1f\x7f\\#]/.test(requestPath)) throw new Error('Invalid serve request')
      url = new URL(requestPath, base)
      if (url.origin !== base.origin) throw new Error('Invalid serve request')
      // The only main-only mutation here is one profile's validated time zone.
      // No renderer route, arbitrary config object, or credential export.
      if (timezonePatch !== undefined) {
        const { profile, timezone } = timezonePatch || {}
        if (Object.keys(timezonePatch || {}).sort().join(',') !== 'profile,timezone' ||
            typeof profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile) ||
            typeof timezone !== 'string' || !timezone || timezone.length > 100 ||
            requestPath !== `/api/config?${new URLSearchParams({ profile })}`) throw new Error('Invalid time zone write')
        new Intl.DateTimeFormat('en', { timeZone: timezone })
        body = JSON.stringify({ profile, config: { timezone } })
      }
    } catch { reject(new Error('Serve request unavailable')); return }
    const agent = ownedAgent(url, verifyPeer)
    const timer = setTimeout(() => request.destroy(new Error('Serve request timed out')), timeoutMs)
    timer.unref?.()
    const request = http.request(url, { agent, method: body ? 'PUT' : 'GET', headers: {
      [SERVE_TOKEN_HEADER]: auth.token, Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    } }, (response) => {
      const length = Number(response.headers['content-length'])
      if (response.statusCode !== 200 || !/application\/json|\+json/.test(response.headers['content-type'] || '') ||
          (Number.isFinite(length) && length > maxBytes)) {
        request.destroy(new Error('Serve response refused'))
        return
      }
      const chunks = []
      let bytes = 0
      response.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > maxBytes) request.destroy(new Error('Serve response too large'))
        else chunks.push(chunk)
      })
      response.once('error', () => request.destroy(new Error('Serve response unavailable')))
      response.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch {
          reject(new Error('Invalid serve response'))
        }
        cleanup()
      })
    })
    function cleanup() { clearTimeout(timer); agent.destroy() }
    request.once('error', () => { cleanup(); reject(new Error('Serve request unavailable')) })
    request.end(body)
  })
}

/**
 * Small RFC 6455 text client for serve's NDJSON sockets. The upgrade goes over
 * the verified connection too, including every reconnect. No compression.
 */
function verifiedWebSocket(verifyPeer) {
  return class VerifiedWebSocket extends EventEmitter {
    constructor(raw) {
      super()
      this.readyState = 0
      this.buffer = Buffer.alloc(0)
      this.chunks = []; this.chunkBytes = 0; this.needBytes = 0
      this.fragments = []
      this.fragmentBytes = 0
      this.fragmentOpcode = 0
      const url = new URL(raw)
      if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
          !SERVE_SOCKET_PATHS.has(url.pathname) || typeof verifyPeer !== 'function') throw new Error('Invalid serve socket')
      url.protocol = 'http:'
      const key = crypto.randomBytes(16).toString('base64')
      this.agent = ownedAgent(url, verifyPeer)
      const request = this.request = http.get(url, { agent: this.agent, headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
      } })
      const fail = () => {
        if (this.readyState === 3) return
        this.emit('error', {})
        this.close()
      }
      this.timer = setTimeout(fail, 5000)
      this.timer.unref?.()
      request.once('error', fail)
      request.once('response', (response) => { response.resume(); fail() })
      request.once('upgrade', (response, peer, head) => {
        const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
        if (this.readyState !== 0 || response.statusCode !== 101 ||
            response.headers['sec-websocket-accept'] !== accept ||
            response.headers['sec-websocket-extensions'] || response.headers['sec-websocket-protocol']) {
          peer.destroy(); fail(); return
        }
        clearTimeout(this.timer)
        this.peer = peer
        this.readyState = 1
        peer.on('data', (data) => { try { this.receive(data) } catch { fail() } })
        peer.once('error', fail)
        peer.once('close', () => this.close())
        this.emit('open', {})
        if (head.length) { try { this.receive(head) } catch { fail() } }
      })
    }
    addEventListener(name, callback) { this.on(name, callback) }
    writeFrame(opcode, data) {
      if (!this.peer || this.peer.destroyed) throw new Error('Serve socket closed')
      if (data.length > MAX_FRAME_CHARS) throw new Error('Serve frame too large')
      const size = data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10
      const header = Buffer.alloc(size + 4)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | (size === 2 ? data.length : size === 4 ? 126 : 127)
      if (size === 4) header.writeUInt16BE(data.length, 2)
      if (size === 10) header.writeBigUInt64BE(BigInt(data.length), 2)
      const mask = crypto.randomBytes(4)
      mask.copy(header, size)
      const payload = Buffer.from(data)
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      this.peer.write(Buffer.concat([header, payload]))
    }
    send(data) {
      if (this.readyState !== 1 || typeof data !== 'string') throw new Error('Serve socket not open')
      this.writeFrame(1, Buffer.from(data))
    }
    receive(data) {
      // A large frame (history, replay) arrives in many chunks: join them once
      // it is complete, not on every chunk, which copied the frame quadratically.
      this.chunks.push(data)
      this.chunkBytes += data.length
      const total = this.buffer.length + this.chunkBytes
      if (total > MAX_INBOUND_FRAME_CHARS + 65536) throw new Error('Serve frame too large')
      if (total < this.needBytes) return
      this.buffer = Buffer.concat([this.buffer, ...this.chunks], total)
      this.chunks = []; this.chunkBytes = 0; this.needBytes = 0
      while (this.buffer.length >= 2 && this.readyState === 1) {
        const first = this.buffer[0], opcode = first & 15, final = Boolean(first & 0x80)
        if ((first & 0x70) || (this.buffer[1] & 0x80)) throw new Error('Invalid serve frame')
        let length = this.buffer[1] & 127, offset = 2
        if (length === 126) {
          if (this.buffer.length < 4) { this.needBytes = 4; return }
          length = this.buffer.readUInt16BE(2); offset = 4
        } else if (length === 127) {
          if (this.buffer.length < 10) { this.needBytes = 10; return }
          const large = this.buffer.readBigUInt64BE(2)
          if (large > BigInt(MAX_INBOUND_FRAME_CHARS)) throw new Error('Serve frame too large')
          length = Number(large); offset = 10
        }
        if (length > MAX_INBOUND_FRAME_CHARS || (opcode >= 8 && (!final || length > 125))) throw new Error('Invalid serve frame')
        if (this.buffer.length < offset + length) { this.needBytes = offset + length; return }
        const payload = this.buffer.subarray(offset, offset + length)
        this.buffer = this.buffer.subarray(offset + length)
        if (opcode === 8) { this.close(); return }
        if (opcode === 9) { this.writeFrame(10, payload); continue }
        if (opcode === 10) continue
        if (![0, 1, 2].includes(opcode) || (opcode === 0 ? !this.fragmentOpcode : this.fragmentOpcode)) {
          throw new Error('Invalid serve continuation')
        }
        if (opcode !== 0) this.fragmentOpcode = opcode
        this.fragmentBytes += length
        if (this.fragmentBytes > MAX_INBOUND_FRAME_CHARS) throw new Error('Serve message too large')
        this.fragments.push(payload)
        if (!final) continue
        const message = Buffer.concat(this.fragments)
        const type = this.fragmentOpcode
        this.fragments = []; this.fragmentBytes = 0; this.fragmentOpcode = 0
        this.emit('message', { data: type === 1 ? new TextDecoder('utf-8', { fatal: true }).decode(message) : message })
      }
    }
    close() {
      if (this.readyState === 3) return
      this.readyState = 3
      clearTimeout(this.timer)
      this.request.destroy()
      this.peer?.destroy()
      this.agent.destroy()
      this.buffer = Buffer.alloc(0)
      this.chunks = []; this.chunkBytes = 0; this.needBytes = 0
      this.fragments = []
      this.emit('close', { code: 1000, reason: '' })
    }
  }
}

/** Replace any case-variant of the session header with main's value. */
function withServeToken(requestHeaders, token, senderId) {
  const next = {}
  for (const [k, v] of Object.entries(requestHeaders || {})) {
    if (![SERVE_TOKEN_HEADER.toLowerCase(), SERVE_RENDERER_HEADER.toLowerCase()].includes(k.toLowerCase())) next[k] = v
  }
  next[SERVE_TOKEN_HEADER] = token
  if (Number.isSafeInteger(senderId) && senderId > 0) next[SERVE_RENDERER_HEADER] = String(senderId)
  return next
}

/**
 * Install the REST header injector on an Electron session.
 * @param {Electron.Session} ses
 * @param {{ baseUrl: string, getToken: Function, getTrustedWebContents: () => any[] }} opts
 */
function installServeAuth(ses, { baseUrl, getToken, getTrustedWebContents }) {
  ses.webRequest.onBeforeSendHeaders(serveRequestFilter(baseUrl), (details, callback) => {
    if (!shouldAttachServeToken(details, { baseUrl, trustedWebContents: getTrustedWebContents() })) {
      callback({})
      return
    }
    getToken().then(
      ({ token }) => {
        callback(token && shouldAttachServeToken(details, { baseUrl, trustedWebContents: getTrustedWebContents() })
          ? { requestHeaders: withServeToken(details.requestHeaders, token, details.webContentsId) } : {})
      },
      () => callback({}),
    )
  })
}

/**
 * Renderer-supplied socket query → URLSearchParams. Short lowercase keys,
 * short string values, no credentials.
 */
function sanitizeSocketQuery(query) {
  const qs = new URLSearchParams()
  if (!query || typeof query !== 'object' || Array.isArray(query)) return qs
  for (const [k, v] of Object.entries(query)) {
    if (!QUERY_KEY_RE.test(k) || RESERVED_QUERY_KEYS.has(k)) continue
    if (typeof v !== 'string' || v.length > 256) continue
    qs.set(k, v)
  }
  return qs
}

/** WebSocket.close() only accepts 1000 or 3000–4999; anything else → default. */
function safeCloseCode(code) {
  return Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999)) ? code : undefined
}

/**
 * Main-side WebSocket relay for serve. The renderer picks the socket id (so
 * it can subscribe before any event can arrive), main owns the socket and
 * the token-bearing URL; events go back as { id, type, data?, code?, reason? }
 * on SERVE_SOCKET_EVENT. Error events never carry a message (a socket error
 * string can echo the token-bearing URL).
 */
function createServeSocketBroker({
  baseUrl,
  getToken,
  WebSocketImpl = globalThis.WebSocket,
  maxPerSender = MAX_SOCKETS_PER_SENDER,
} = {}) {
  /** Includes pending reservations, not just connected sockets. */
  const sockets = new Map()
  const watchedSenders = new WeakSet()

  const countFor = (sender) => {
    let n = 0
    for (const s of sockets.values()) if (s.sender === sender) n += 1
    return n
  }

  const closeAllFor = (sender) => {
    for (const [id, s] of sockets) {
      if (s.sender !== sender) continue
      sockets.delete(id)
      try {
        s.ws?.close()
      } catch {
        /* already closing */
      }
    }
  }

  const owned = (sender, id) => {
    const s = typeof id === 'string' ? sockets.get(id) : undefined
    return s && s.sender === sender ? s : null
  }

  async function open(sender, payload) {
    const id = payload && payload.id
    const socketPath = payload && payload.path
    if (typeof id !== 'string' || !SOCKET_ID_RE.test(id)) throw new Error('serveSocket: invalid id')
    if (sockets.has(id)) throw new Error('serveSocket: id in use')
    if (typeof socketPath !== 'string' || !SERVE_SOCKET_PATHS.has(socketPath)) {
      throw new Error('serveSocket: path not allowed')
    }
    if (countFor(sender) >= maxPerSender) return { ok: false, error: 'too many serve sockets' }
    if (sender.isDestroyed?.()) return { ok: false, error: 'sender destroyed' }
    if (typeof WebSocketImpl !== 'function') return { ok: false, error: 'WebSocket unavailable' }
    const entry = { ws: null, sender }
    sockets.set(id, entry)
    if (!watchedSenders.has(sender) && typeof sender.once === 'function') {
      watchedSenders.add(sender)
      sender.once('destroyed', () => closeAllFor(sender))
    }
    const release = () => { if (sockets.get(id) === entry) sockets.delete(id) }

    let ws
    try {
      const { token } = await getToken()
      if (sockets.get(id) !== entry || sender.isDestroyed?.()) {
        release()
        return { ok: false, error: 'socket admission cancelled' }
      }
      if (!token) { release(); return { ok: false, error: 'no serve token' } }
      const base = new URL(baseUrl)
      const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:'
      const qs = sanitizeSocketQuery(payload.query)
      qs.set('token', token)
      ws = new WebSocketImpl(`${scheme}//${base.host}${socketPath}?${qs.toString()}`)
    } catch {
      release()
      return { ok: false, error: 'serve socket failed to open' }
    }
    entry.ws = ws

    const emit = (ev) => {
      if (sockets.get(id) !== entry && ev.type !== 'close') return
      if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return
      sender.send(SERVE_SOCKET_EVENT, { id, ...ev })
    }
    ws.addEventListener('open', () => emit({ type: 'open' }))
    ws.addEventListener('message', (msg) => {
      const data = typeof msg.data === 'string' ? msg.data : Buffer.from(msg.data).toString('utf8')
      emit({ type: 'message', data })
    })
    ws.addEventListener('error', () => emit({ type: 'error' }))
    ws.addEventListener('close', (ev) => {
      if (sockets.get(id) !== entry) return
      emit({ type: 'close', code: ev && ev.code, reason: ev && typeof ev.reason === 'string' ? ev.reason : '' })
      release()
    })
    return { ok: true }
  }

  function send(sender, payload) {
    const s = owned(sender, payload && payload.id)
    if (!s) return { ok: false, error: 'unknown socket' }
    const data = payload.data
    if (typeof data !== 'string' || data.length > MAX_FRAME_CHARS) {
      return { ok: false, error: 'invalid frame' }
    }
    if (s.ws?.readyState !== 1) return { ok: false, error: 'socket not open' }
    s.ws.send(data)
    return { ok: true }
  }

  function close(sender, payload) {
    const s = owned(sender, payload && payload.id)
    if (!s) return { ok: true }
    if (!s.ws) { sockets.delete(payload.id); return { ok: true } }
    const code = safeCloseCode(payload.code)
    const reason = typeof payload.reason === 'string' ? payload.reason.slice(0, 120) : undefined
    try {
      if (code !== undefined) s.ws.close(code, reason)
      else s.ws.close()
    } catch {
      /* already closing */
    }
    return { ok: true }
  }

  return { open, send, close, closeAllFor, size: () => sockets.size }
}

module.exports = {
  SERVE_TOKEN_HEADER,
  DEFAULT_SERVE_URL,
  SERVE_SOCKET_PATHS,
  SERVE_SOCKET_EVENT,
  hermesHome,
  serveBaseUrl,
  readServeToken,
  cachedServeToken,
  serveConfigForRenderer,
  serveRequestFilter,
  shouldAttachServeToken,
  withServeToken,
  installServeAuth,
  createServeRestProxy,
  requestOwnedJson,
  verifiedWebSocket,
  sanitizeSocketQuery,
  createServeSocketBroker,
}
