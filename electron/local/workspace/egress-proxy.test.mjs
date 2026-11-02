import { createRequire } from 'node:module'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createEgressProxy, targetUrl } = require('./egress-proxy.cjs')
const cleanup = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
const publicAnswer = () => [{ address: '8.8.8.8', family: 4 }]

async function listen(server) {
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy()
    server.close(resolve)
  }))
  return server.address().port
}

async function fixture({ lookup = vi.fn(async () => publicAnswer()), limits, handler, tunnel = false, dial } = {}) {
  const seen = []
  const server = tunnel ? net.createServer((socket) => socket.on('data', (chunk) => socket.write(chunk))) :
    http.createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers, method: req.method })
      if (handler) return handler(req, res)
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'X-Fixture': 'local', 'Proxy-Authenticate': 'never-forward',
          Connection: 'close, x-private-hop', 'X-Private-Hop': 'strip' })
        res.end('synthetic response')
      })
    })
  const targetPort = await listen(server)
  // Never dial the synthetic public address. Assert it, then route exclusively
  // to a fixture listener on loopback.
  const connect = vi.fn(dial || (() => net.connect({ host: '127.0.0.1', port: targetPort,
    family: 4 })))
  const proxy = createEgressProxy({ lookup, connect, limits })
  cleanup.push(() => proxy.dispose())
  const config = await proxy.ready()
  const port = Number(new URL(config.proxyRules).port)
  return { proxy, port, config, lookup, connect, seen, server }
}

function request(port, url = 'http://public.test/path?x=1', options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: options.method || 'GET',
      path: url, headers: options.headers || {}, agent: false }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

function raw(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let result = ''
    socket.on('data', (chunk) => { result += chunk })
    socket.on('error', reject)
    socket.on('end', () => resolve(result))
    socket.on('connect', () => socket.write(text))
  })
}

describe('connection-time agent egress proxy (synthetic local fixtures only)', () => {
  it('pins the validated address and strips proxy/hop headers without losing origin Host', async () => {
    const f = await fixture()
    expect(f.config).toMatchObject({ mode: 'fixed_servers', proxyBypassRules: '<-loopback>' })
    expect(f.config.proxyRules).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await request(f.port, undefined, { headers: {
      Host: 'wrong-origin.test', 'Proxy-Authorization': 'never-forward',
      'Proxy-Custom': 'never-forward', Connection: 'x-hop', 'X-Hop': 'never-forward',
      Authorization: 'origin-only', 'X-End-To-End': 'keep',
    } })
    expect(response.status).toBe(200)
    expect(response.body).toBe('synthetic response')
    expect(f.lookup).toHaveBeenCalledExactlyOnceWith('public.test', { all: true, verbatim: true })
    expect(f.connect).toHaveBeenCalledExactlyOnceWith({ host: '8.8.8.8', family: 4, port: 80 })
    expect(f.seen[0]).toMatchObject({ url: '/path?x=1', headers: {
      host: 'public.test', authorization: 'origin-only', 'x-end-to-end': 'keep',
    } })
    for (const key of ['proxy-authorization', 'proxy-custom', 'x-hop']) expect(f.seen[0].headers[key]).toBeUndefined()
    expect(response.headers['proxy-authenticate']).toBeUndefined()
    expect(response.headers['x-private-hop']).toBeUndefined()
  })

  it.each([
    ['DNS alias to loopback', [{ address: '127.0.0.1', family: 4 }]],
    ['metadata', [{ address: '169.254.169.254', family: 4 }]],
    ['private', [{ address: '192.168.1.2', family: 4 }]],
    ['IPv6 loopback', [{ address: '::1', family: 6 }]],
    ['IPv6 ULA', [{ address: 'fd00::1', family: 6 }]],
    ['IPv6 linklocal', [{ address: 'fe80::1', family: 6 }]],
    ['mapped alias', [{ address: '::ffff:127.0.0.1', family: 6 }]],
    ['mixed v4 answers', [...publicAnswer(), { address: '10.1.2.3', family: 4 }]],
    ['mixed A/AAAA', [...publicAnswer(), { address: '::1', family: 6 }]],
    ['wrong family', [{ address: '8.8.8.8', family: 6 }]],
    ['empty answers', []],
    ['too many answers', Array.from({ length: 17 }, () => publicAnswer()[0])],
    ['non-literal answer', [{ address: 'another.test', family: 4 }]],
  ])('rejects %s without dialing', async (_description, answers) => {
    const f = await fixture({ lookup: vi.fn(async () => answers) })
    expect((await request(f.port)).status).toBe(403)
    expect(await raw(f.port, 'CONNECT alias.test:443 HTTP/1.1\r\nHost: alias.test:443\r\n\r\n')).toContain('403 Forbidden')
    expect(f.connect).not.toHaveBeenCalled()
  })

  it('re-resolves every connection and denies a public-to-private DNS rebind', async () => {
    const lookup = vi.fn().mockResolvedValueOnce(publicAnswer())
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const f = await fixture({ lookup })
    expect((await request(f.port)).status).toBe(200)
    expect((await request(f.port)).status).toBe(403)
    expect(f.connect).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('does not follow redirects itself; redirect targets get their own enforced connection', async () => {
    const lookup = vi.fn(async (host) => host === 'public.test' ? publicAnswer() :
      [{ address: '169.254.169.254', family: 4 }])
    const f = await fixture({ lookup, handler: (_req, res) => {
      res.writeHead(302, { Location: 'http://metadata-alias.test/latest/meta-data/' })
      res.end()
    } })
    const redirect = await request(f.port)
    expect(redirect.status).toBe(302)
    expect((await request(f.port, redirect.headers.location)).status).toBe(403)
    expect(f.connect).toHaveBeenCalledTimes(1)
  })

  it.each(['http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:8.8.8.8]/',
    'http://[64:ff9b::a00:1]/', 'http://[fc00::1]/', 'http://169.254.169.254/',
    'http://100.100.100.200/', 'http://0/', 'http://224.0.0.1/',
    'http://user:password@public.test/', 'http://public.test:22/', 'http://public.test:443/',
    'https://public.test/', 'ftp://public.test/', '/relative', 'http://public.test/#fragment'])(
    'rejects literal/credential/scheme/port target %s before DNS', async (url) => {
      const f = await fixture()
      expect((await request(f.port, url)).status).toBe(403)
      expect(f.lookup).not.toHaveBeenCalled()
      expect(f.connect).not.toHaveBeenCalled()
    })

  it.each(['127.1:443', '[::1]:443', '[::ffff:127.0.0.1]:443', '169.254.169.254:443',
    'public.test:22', 'public.test:80', 'public.test:8443', 'public.test:0443',
    'public.test', 'user@public.test:443', 'public.test:443/path', 'public.test:443?query'])(
    'denies malformed/private/non-HTTPS CONNECT %s', async (authority) => {
      const f = await fixture()
      expect(await raw(f.port, `CONNECT ${authority} HTTP/1.1\r\nHost: ignored.test\r\n\r\n`)).toContain('403 Forbidden')
      expect(f.connect).not.toHaveBeenCalled()
    })

  it('carries HTTPS/WSS CONNECT bytes only after a public-address dial and disposes tunnels', async () => {
    const f = await fixture({ tunnel: true })
    const client = net.connect({ host: '127.0.0.1', port: f.port })
    client.on('error', () => {})
    await once(client, 'connect')
    client.write('CONNECT secure.test:443 HTTP/1.1\r\nHost: secure.test:443\r\nProxy-Authorization: never-forward\r\n\r\n')
    expect(String((await once(client, 'data'))[0])).toBe('HTTP/1.1 200 Connection Established\r\n\r\n')
    client.write('opaque HTTPS or WSS bytes')
    expect(String((await once(client, 'data'))[0])).toBe('opaque HTTPS or WSS bytes')
    expect(f.connect).toHaveBeenCalledExactlyOnceWith({ host: '8.8.8.8', port: 443, family: 4 })
    const closed = once(client, 'close')
    await f.proxy.dispose()
    await closed
    await expect(f.proxy.ready()).rejects.toThrow('disposed')
    await expect(request(f.port)).rejects.toThrow()
  })

  it('enforces the same pinned destination for WebSocket upgrade and bidirectional bytes', async () => {
    const f = await fixture()
    let headers
    f.server.on('upgrade', (req, socket) => {
      headers = req.headers
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      socket.on('data', (chunk) => socket.write(chunk))
    })
    const client = net.connect({ host: '127.0.0.1', port: f.port })
    client.on('error', () => {})
    await once(client, 'connect')
    client.write('GET ws://public.test/socket HTTP/1.1\r\nHost: public.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nProxy-Authorization: never-forward\r\n\r\n')
    expect(String((await once(client, 'data'))[0])).toContain('101 Switching Protocols')
    client.write('websocket frame fixture')
    expect(String((await once(client, 'data'))[0])).toBe('websocket frame fixture')
    expect(headers.host).toBe('public.test')
    expect(headers['proxy-authorization']).toBeUndefined()
    expect(f.connect).toHaveBeenCalledWith({ host: '8.8.8.8', port: 80, family: 4 })
    client.destroy()
  })

  it('allows global IPv6 literals without DNS and uses the literal family for dialing', async () => {
    const f = await fixture()
    expect((await request(f.port, 'http://[2606:4700:4700::1111]/')).status).toBe(200)
    expect(f.lookup).not.toHaveBeenCalled()
    expect(f.connect).toHaveBeenCalledWith({ host: '2606:4700:4700::1111', family: 6, port: 80 })
    expect(f.seen[0].headers.host).toBe('[2606:4700:4700::1111]')
  })

  it('bounds stalled DNS and fails closed without spawning more resolver jobs', async () => {
    const lookup = vi.fn(() => new Promise(() => {}))
    const f = await fixture({ lookup, limits: { dns: 1, dnsMs: 25 } })
    expect((await request(f.port)).status).toBe(403)
    expect((await request(f.port)).status).toBe(403)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(f.connect).not.toHaveBeenCalled()
  })

  it('bounds concurrent requests while DNS is pending', async () => {
    let release
    const lookup = vi.fn(() => new Promise((resolve) => { release = resolve }))
    const f = await fixture({ lookup, limits: { requests: 1 } })
    const pending = request(f.port)
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce())
    expect((await request(f.port)).status).toBe(403)
    release(publicAnswer())
    expect((await pending).status).toBe(200)
  })

  it('rejects oversized bodies and disallowed methods before DNS', async () => {
    const f = await fixture({ limits: { bodyBytes: 4 } })
    expect((await request(f.port, undefined, { method: 'POST', body: '12345',
      headers: { 'Content-Length': '5' } })).status).toBe(403)
    expect((await request(f.port, undefined, { method: 'TRACE' })).status).toBe(403)
    expect(f.lookup).not.toHaveBeenCalled()
  })

  it('enforces the socket budget before allocating any upstream socket', async () => {
    const f = await fixture({ limits: { sockets: 1 } })
    expect((await request(f.port)).status).toBe(403)
    expect(f.connect).not.toHaveBeenCalled()
  })

  it('drops pipelined requests instead of accumulating queued responses', async () => {
    const f = await fixture()
    const first = 'GET http://public.test/ HTTP/1.1\r\nHost: public.test\r\n\r\n'
    const response = await raw(f.port, first.repeat(100))
    expect(response).not.toContain('200 OK')
  })

  it('denies WebSocket upgrades whose hostname resolves to a private address', async () => {
    const f = await fixture({ lookup: vi.fn(async () => [{ address: '10.0.0.1', family: 4 }]) })
    expect(await raw(f.port, 'GET ws://alias.test/socket HTTP/1.1\r\nHost: alias.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'))
      .toContain('403 Forbidden')
    expect(f.connect).not.toHaveBeenCalled()
  })

  it('caps response bytes and destroys the connection instead of buffering indefinitely', async () => {
    const f = await fixture({ limits: { responseBytes: 4 } })
    await expect(request(f.port)).rejects.toThrow()
  })

  it('caps chunked upload bytes even when Content-Length is absent', async () => {
    const f = await fixture({ limits: { bodyBytes: 4 } })
    await expect(request(f.port, undefined, { method: 'POST', body: '12345',
      headers: { 'Transfer-Encoding': 'chunked' } })).rejects.toThrow()
  })

  it('bounds raw request headers before resolving or dialing', async () => {
    const f = await fixture({ limits: { headerBytes: 128 } })
    await expect(request(f.port, undefined, { headers: { 'X-Oversized': 'x'.repeat(512) } })).rejects.toThrow()
    expect(f.lookup).not.toHaveBeenCalled()
    expect(f.connect).not.toHaveBeenCalled()
  })

  it('denies oversized early CONNECT bytes before allocating DNS work', async () => {
    const f = await fixture({ limits: { headBytes: 4 } })
    expect(await raw(f.port, 'CONNECT public.test:443 HTTP/1.1\r\nHost: public.test\r\n\r\n12345')).toContain('403 Forbidden')
    expect(f.lookup).not.toHaveBeenCalled()
  })

  it('bounds tunnel bytes and closes both ends on overflow', async () => {
    const f = await fixture({ tunnel: true, limits: { tunnelBytes: 4 } })
    const client = net.connect({ host: '127.0.0.1', port: f.port })
    client.on('error', () => {})
    await once(client, 'connect')
    client.write('CONNECT public.test:443 HTTP/1.1\r\nHost: public.test\r\n\r\n')
    expect(String((await once(client, 'data'))[0])).toContain('200 Connection Established')
    const closed = once(client, 'close')
    client.write('12345')
    await closed
  })

  it('bounds stalled CONNECT dials without acknowledging a tunnel', async () => {
    const f = await fixture({ limits: { connectMs: 25 }, dial: () => new net.Socket() })
    expect(await raw(f.port, 'CONNECT public.test:443 HTTP/1.1\r\nHost: public.test\r\n\r\n')).not.toContain('200 Connection Established')
    expect(f.connect).toHaveBeenCalledOnce()
  })

  it('closes idle established tunnels at the configured lifetime', async () => {
    const f = await fixture({ tunnel: true, limits: { lifetimeMs: 100 } })
    const client = net.connect({ host: '127.0.0.1', port: f.port })
    client.on('error', () => {})
    await once(client, 'connect')
    client.write('CONNECT public.test:443 HTTP/1.1\r\nHost: public.test\r\n\r\n')
    expect(String((await once(client, 'data'))[0])).toContain('200 Connection Established')
    await once(client, 'close')
  })

  it('does not truncate buffered tunnel bytes on graceful upstream shutdown', async () => {
    const f = await fixture({ tunnel: true })
    const payload = Buffer.alloc(512 * 1024, 97)
    f.server.removeAllListeners('connection')
    f.server.on('connection', (socket) => {
      socket.on('error', () => {})
      socket.end(payload)
    })
    const client = net.connect({ host: '127.0.0.1', port: f.port })
    client.on('error', () => {})
    let received = Buffer.alloc(0)
    client.on('data', (chunk) => { received = Buffer.concat([received, chunk]) })
    await once(client, 'connect')
    client.write('CONNECT public.test:443 HTTP/1.1\r\nHost: public.test\r\n\r\n')
    await once(client, 'end')
    const separator = received.indexOf('\r\n\r\n')
    expect(separator).toBeGreaterThan(0)
    expect(received.subarray(separator + 4)).toEqual(payload)
    client.destroy()
  })

  it('aborts pending listen and DNS setup during disposal without any late dial', async () => {
    const unopened = createEgressProxy({ lookup: vi.fn(async () => publicAnswer()), connect: vi.fn() })
    const starting = unopened.ready()
    const failed = expect(starting).rejects.toThrow('disposed')
    await unopened.dispose()
    await failed
    let release
    const f = await fixture({ lookup: vi.fn(() => new Promise((resolve) => { release = resolve })) })
    const pending = request(f.port).catch(() => null)
    await vi.waitFor(() => expect(f.lookup).toHaveBeenCalledOnce())
    await f.proxy.dispose()
    await pending
    release(publicAnswer())
    await Promise.resolve()
    expect(f.connect).not.toHaveBeenCalled()
    expect(f.proxy.dispose()).toBe(f.proxy.dispose())
  })

  it('rejects parser ambiguities, whitespace, credentials and backslashes', () => {
    for (const target of ['http://public.test\\@127.0.0.1/', 'http://public.test/\r\nX: y',
      ' http://public.test/', 'http://public.test/%0a#fragment']) {
      expect(() => targetUrl(target)).toThrow()
    }
  })
})
