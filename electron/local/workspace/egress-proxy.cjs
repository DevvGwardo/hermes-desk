'use strict'

const http = require('node:http')
const net = require('node:net')
const dns = require('node:dns').promises
const { Transform } = require('node:stream')
const { isPublicAddress, isPublicHostname } = require('./url-policy.cjs')

const DEFAULT_LIMITS = Object.freeze({
  clients: 64, sockets: 128, requests: 32, dns: 16, answers: 16,
  headerBytes: 16384, bodyBytes: 16 * 1024 * 1024, responseBytes: 64 * 1024 * 1024,
  tunnelBytes: 64 * 1024 * 1024, headBytes: 65536,
  dnsMs: 3000, connectMs: 5000, idleMs: 15000, lifetimeMs: 120000,
})
const HOP = new Set(['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization'])

function cleanHeaders(headers) {
  const remove = new Set([...HOP, ...String(headers.connection || '').toLowerCase().split(',').map((v) => v.trim())])
  const result = Object.create(null)
  for (const [name, value] of Object.entries(headers)) {
    if (!remove.has(name.toLowerCase()) && !name.toLowerCase().startsWith('proxy-')) result[name] = value
  }
  return result
}

function targetUrl(raw, tunnel = false, upgrade = false) {
  if (typeof raw !== 'string' || raw.length > 16384 || /[\s\\\u0000-\u001f\u007f]/.test(raw)) throw new Error('Invalid target')
  if (tunnel && !/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):443$/i.test(raw)) throw new Error('Invalid CONNECT authority')
  if (!tunnel && !/^(?:http|ws):\/\//i.test(raw)) throw new Error('Invalid proxy target')
  const url = new URL(tunnel ? `https://${raw}/` : raw)
  if (url.username || url.password || url.hash || url.port ||
      (!tunnel && url.protocol !== 'http:' && !(upgrade && url.protocol === 'ws:')) ||
      !isPublicHostname(url.hostname)) throw new Error('Forbidden target')
  return { url, host: url.hostname.replace(/^\[|\]$/g, ''), port: tunnel ? 443 : 80 }
}

// main-owned only. Injection is for synthetic resolver/dial tests, never IPC.
function createEgressProxy({ lookup = dns.lookup.bind(dns), connect = net.connect, limits = {} } = {}) {
  const budget = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(limits)) {
    if (key in budget && Number.isSafeInteger(value) && value > 0 && value <= budget[key]) budget[key] = value
  }
  let closed = false
  let starting
  let rejectStart
  let closing
  const listenAbort = new AbortController()
  let active = 0
  let resolving = 0
  const sockets = new Set()
  const operations = new Set()
  const dnsCancellations = new Set()
  const server = http.createServer({ maxHeaderSize: budget.headerBytes, insecureHTTPParser: false }, (req, res) => {
    void forward(req, res, null, null)
  })
  server.maxConnections = budget.clients
  server.maxHeadersCount = 64
  server.headersTimeout = budget.idleMs
  server.requestTimeout = budget.lifetimeMs
  server.keepAliveTimeout = 1
  server.maxRequestsPerSocket = 1
  // Do not queue an unbounded series of 503 responses behind an in-flight
  // request when a client pipelines thousands of tiny requests.
  server.on('dropRequest', (_req, socket) => socket.destroy())
  server.on('connection', (socket) => {
    if (!track(socket)) return
    socket.setTimeout(budget.idleMs, () => socket.destroy())
    const timer = setTimeout(() => socket.destroy(), budget.lifetimeMs)
    timer.unref?.()
    socket.once('close', () => clearTimeout(timer))
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('connect', (req, socket, head) => { void tunnel(req, socket, head) })
  server.on('upgrade', (req, socket, head) => { void forward(req, null, socket, head) })
  server.on('error', () => { if (server.listening) void dispose() })

  function track(socket) {
    socket.on('error', () => {})
    if (closed || sockets.size >= budget.sockets) { socket.destroy(); return false }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    return true
  }

  function operation(client, res) {
    if (closed || active >= budget.requests) throw new Error('Proxy busy')
    active++
    let ended = false
    const resources = new Set()
    const finish = () => {
      if (ended) return
      ended = true
      active--
      clearTimeout(timer)
      operations.delete(fail)
      client.removeListener('close', fail)
      for (const resource of resources) resource.destroy()
    }
    const fail = () => { finish(); client.destroy() }
    const timer = setTimeout(fail, budget.lifetimeMs)
    timer.unref?.()
    client.once('close', fail)
    if (res) {
      res.once('finish', finish)
      res.once('error', fail)
    }
    operations.add(fail)
    return { finish, fail, resources, alive: () => !closed && !ended && !client.destroyed }
  }

  function reject(res, socket) {
    if (res && !res.headersSent && !res.destroyed) {
      res.writeHead(403, { Connection: 'close', 'Content-Length': '0' })
      res.end()
    } else if (res) {
      socket?.destroy()
    } else if (socket && !socket.destroyed) {
      // Never echo attacker-controlled URLs, headers or resolver errors.
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    }
  }

  async function resolve(host) {
    if (net.isIP(host)) {
      if (!isPublicAddress(host)) throw new Error('Forbidden address')
      return { address: host, family: net.isIP(host) }
    }
    if (closed || resolving >= budget.dns) throw new Error('DNS busy')
    resolving++
    // Do not release a DNS slot on timeout: OS lookup is not cancellable. A
    // stalled resolver therefore exhausts a bounded pool, rather than spawning
    // unlimited background jobs.
    const result = Promise.resolve().then(() => lookup(host, { all: true, verbatim: true }))
      .finally(() => { resolving-- })
    let timer
    let cancel
    try {
      const answers = await Promise.race([result, new Promise((_, reject) => {
        cancel = () => reject(new Error('Proxy disposed'))
        dnsCancellations.add(cancel)
        timer = setTimeout(() => reject(new Error('DNS timeout')), budget.dnsMs)
      })])
      if (closed || !Array.isArray(answers) || !answers.length || answers.length > budget.answers ||
          answers.some((entry) => !entry || !isPublicAddress(entry.address) ||
            net.isIP(entry.address) !== entry.family)) throw new Error('Forbidden DNS answer')
      return answers[0]
    } finally { clearTimeout(timer); dnsCancellations.delete(cancel) }
  }

  function dial(address, port, op) {
    if (!op.alive() || sockets.size >= budget.sockets) throw new Error('Proxy closed or busy')
    // Crucial: no hostname reaches the OS dialer. DNS rebinding cannot change
    // the destination between validation and connection, even on reconnect.
    const socket = connect({ host: address.address, family: address.family, port })
    if (!track(socket)) throw new Error('Socket budget')
    op.resources.add(socket)
    const timer = setTimeout(() => socket.destroy(new Error('Connect timeout')), budget.connectMs)
    socket.once('connect', () => clearTimeout(timer))
    socket.once('close', () => clearTimeout(timer))
    socket.setTimeout(budget.idleMs, () => socket.destroy())
    return socket
  }

  function limiter(maximum, op) {
    let bytes = 0
    const stream = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length
      if (bytes > maximum) done(new Error('Byte budget exceeded'))
      else done(null, chunk)
    } })
    stream.on('error', op.fail)
    op.resources.add(stream)
    return stream
  }

  function bridge(client, upstream, head, upstreamHead, op) {
    if (head.length > Math.min(budget.headBytes, budget.tunnelBytes) ||
        upstreamHead.length > Math.min(budget.headBytes, budget.tunnelBytes)) throw new Error('Head budget')
    if (head.length) upstream.write(head)
    if (upstreamHead.length) client.write(upstreamHead)
    client.pipe(limiter(budget.tunnelBytes - head.length, op)).pipe(upstream)
    upstream.pipe(limiter(budget.tunnelBytes - upstreamHead.length, op)).pipe(client)
    upstream.once('close', (hadError) => {
      // A graceful end already pipes FIN to the client; let its pending writes
      // drain instead of truncating the last tunnel/WS frame with destroy().
      if (hadError || !upstream.readableEnded) op.fail()
    })
    upstream.once('error', op.fail)
    client.once('end', () => upstream.end())
  }

  async function tunnel(req, client, head) {
    let op
    client.pause()
    try {
      if (head.length > Math.min(budget.headBytes, budget.tunnelBytes) ||
          req.headers['transfer-encoding'] || req.headers['content-length']) throw new Error('Invalid tunnel')
      const target = targetUrl(req.url, true)
      op = operation(client)
      const address = await resolve(target.host)
      const upstream = dial(address, target.port, op)
      upstream.once('error', op.fail)
      upstream.once('connect', () => {
        if (!op.alive()) return
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        bridge(client, upstream, head, Buffer.alloc(0), op)
        client.resume()
      })
    } catch { reject(null, client); op?.finish() }
  }

  async function forward(req, res, upgradeClient, head) {
    const client = upgradeClient || req.socket
    let op
    req.pause()
    if (upgradeClient) client.pause()
    try {
      const upgrade = Boolean(upgradeClient)
      const target = targetUrl(req.url, false, upgrade)
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method) ||
          (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) ||
            Number(req.headers['content-length']) > budget.bodyBytes)) ||
          (upgrade && (req.method !== 'GET' || head.length > budget.headBytes ||
            req.headers.upgrade?.toLowerCase() !== 'websocket' ||
            !String(req.headers.connection).toLowerCase().split(',').some((v) => v.trim() === 'upgrade') ||
            req.headers['content-length'] || req.headers['transfer-encoding']))) throw new Error('Invalid request')
      op = operation(client, res)
      const address = await resolve(target.host)
      if (!op.alive()) return
      const headers = cleanHeaders(req.headers)
      headers.host = target.url.host
      headers.connection = upgrade ? 'Upgrade' : 'close'
      if (upgrade) headers.upgrade = 'websocket'
      const agent = new http.Agent({ keepAlive: false, maxSockets: 1 })
      agent.createConnection = () => dial(address, target.port, op)
      const upstream = http.request({ hostname: target.host, port: target.port,
        method: req.method, path: target.url.pathname + target.url.search, headers, agent,
        maxHeaderSize: budget.headerBytes, insecureHTTPParser: false })
      op.resources.add(upstream)
      upstream.on('error', () => {
        if (!op.alive()) return
        reject(res, client)
        op.finish()
      })
      upstream.on('response', (response) => {
        if (upgrade) { response.destroy(); reject(null, client); op.finish(); return }
        const headers = cleanHeaders(response.headers)
        headers.connection = 'close'
        res.writeHead(response.statusCode, headers)
        response.on('error', op.fail)
        response.pipe(limiter(budget.responseBytes, op)).pipe(res)
      })
      upstream.on('upgrade', (response, socket, upstreamHead) => {
        try {
          if (!upgrade || response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'websocket') throw new Error('Invalid upgrade')
          const headers = cleanHeaders(response.headers)
          headers.connection = 'Upgrade'
          headers.upgrade = 'websocket'
          client.write('HTTP/1.1 101 Switching Protocols\r\n' +
            Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value])
              .map((entry) => `${name}: ${entry}\r\n`)).join('') + '\r\n')
          bridge(client, socket, head, upstreamHead, op)
          client.resume()
        } catch { op.fail() }
      })
      req.on('error', op.fail)
      req.pipe(limiter(budget.bodyBytes, op)).pipe(upstream)
      req.resume()
    } catch { reject(res, client); op?.finish() }
  }

  function ready() {
    if (closed) return Promise.reject(new Error('Proxy disposed'))
    if (!starting) starting = new Promise((resolve, reject) => {
      rejectStart = reject
      const failed = () => reject(new Error('Proxy startup failed'))
      server.once('error', failed)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true, signal: listenAbort.signal }, () => {
        server.removeListener('error', failed)
        if (closed) { reject(new Error('Proxy disposed')); return }
        resolve({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${server.address().port}`,
          proxyBypassRules: '<-loopback>' })
      })
    })
    return starting
  }

  function dispose() {
    if (closing) return closing
    closed = true
    rejectStart?.(new Error('Proxy disposed'))
    for (const cancel of dnsCancellations) cancel()
    for (const fail of operations) fail()
    for (const socket of sockets) socket.destroy()
    closing = new Promise((resolve) => {
      // Abort also cancels host-resolution/listen work not yet bound.
      server.close(() => resolve())
      listenAbort.abort()
    })
    return closing
  }
  return { ready, dispose }
}

module.exports = { createEgressProxy, isPublicAddress, targetUrl, DEFAULT_LIMITS }
