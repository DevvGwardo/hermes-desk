import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { requestOwnedJson, verifiedWebSocket, createServeRestProxy, SERVE_TOKEN_HEADER } = require('./serve-auth.cjs')
const { computerRequest } = require('./local/computer-pip.cjs')
const { verifySpawnedPeer } = require('./local/hermes-host.cjs')
const { wsServer: WebSocketServer } = require('playwright-core/lib/utilsBundle')
const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })

async function httpFixture(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  return `http://127.0.0.1:${server.address().port}`
}
const auth = { token: 'OBVIOUSLY_FAKE_PEER_TOKEN', source: 'env' }

describe('bounded main-only time zone write', () => {
  it('verifies the connected peer before sending the token or narrowly scoped PUT body', async () => {
    let authorize
    const received = []
    const baseUrl = await httpFixture((req, res) => {
      let text = ''
      req.on('data', chunk => { text += chunk })
      req.on('end', () => {
        received.push({ method: req.method, path: req.url, token: req.headers[SERVE_TOKEN_HEADER.toLowerCase()],
          body: JSON.parse(text) })
        res.setHeader('content-type', 'application/json')
        res.end('{"ok":true}')
      })
    })
    const write = requestOwnedJson('/api/config?profile=alpha', { baseUrl, auth,
      verifyPeer: () => new Promise(resolve => { authorize = resolve }),
      timezonePatch: { profile: 'alpha', timezone: 'Europe/London' } })
    await vi.waitFor(() => expect(authorize).toBeTypeOf('function'))
    expect(received).toEqual([])
    authorize(true)
    await expect(write).resolves.toEqual({ ok: true })
    expect(received).toEqual([{ method: 'PUT', path: '/api/config?profile=alpha', token: auth.token,
      body: { profile: 'alpha', config: { timezone: 'Europe/London' } } }])
    await expect(requestOwnedJson('/api/config?profile=alpha', { baseUrl, auth, verifyPeer: async () => false,
      timezonePatch: { profile: 'alpha', timezone: 'UTC' } })).rejects.toThrow('unavailable')
    expect(received).toHaveLength(1)
  })
  it('rejects other routes, profile mismatch, extra config keys and invalid zones before connecting', async () => {
    const received = vi.fn()
    const baseUrl = await httpFixture(received)
    const verifyPeer = vi.fn(async () => true)
    for (const [route, patch] of [
      ['/api/env', { profile: 'alpha', timezone: 'UTC' }],
      ['/api/config?profile=beta', { profile: 'alpha', timezone: 'UTC' }],
      ['/api/config?profile=alpha', { profile: 'alpha', timezone: 'Invalid/Zone' }],
      ['/api/config?profile=alpha', { profile: 'alpha', timezone: 'UTC', config: {} }],
    ]) await expect(requestOwnedJson(route, { baseUrl, auth, verifyPeer, timezonePatch: patch })).rejects.toThrow('unavailable')
    expect(verifyPeer).not.toHaveBeenCalled()
    expect(received).not.toHaveBeenCalled()
  })
})

describe('authenticated bounded main-only Computer GET', () => {
  it('verifies the connected peer before writing headers, retains server media-root refusal and bounds responses', async () => {
    let authorize, responseKind = 'ok'
    const requests = []
    const baseUrl = await httpFixture((req, res) => {
      requests.push({ url: req.url, token: req.headers['x-hermes-session-token'] })
      if (responseKind === 'root-denied') { res.writeHead(403); res.end('media root refused'); return }
      if (responseKind === 'redirect') { res.writeHead(302, { Location: 'https://example.invalid' }); res.end(); return }
      res.setHeader('content-type', 'application/json')
      res.end(responseKind === 'large' ? JSON.stringify({ data: 'x'.repeat(70000) }) : '{"ready":true}')
    })
    const request = computerRequest('/api/tools/computer-use/status?profile=alpha', {
      baseUrl, auth, verifyPeer: () => new Promise((resolve) => { authorize = resolve }),
    })
    await vi.waitFor(() => expect(authorize).toBeTypeOf('function'))
    expect(requests).toEqual([])
    authorize(true)
    await expect(request).resolves.toEqual({ ready: true })
    expect(requests).toEqual([{ url: '/api/tools/computer-use/status?profile=alpha', token: auth.token }])
    const endpoint = { baseUrl, auth, verifyPeer: async () => true }
    responseKind = 'root-denied'
    await expect(computerRequest('/api/media?profile=alpha&path=%2Foutside%2Fcomputer_use_fake.png', endpoint)).rejects.toThrow('unavailable')
    responseKind = 'redirect'
    await expect(computerRequest('/api/tools/computer-use/status?profile=alpha', endpoint)).rejects.toThrow('unavailable')
    responseKind = 'large'
    await expect(computerRequest('/api/tools/computer-use/status?profile=alpha', endpoint)).rejects.toThrow('unavailable')
    const before = requests.length
    for (const path of ['/api/env/reveal?profile=alpha', '/api/media?profile=alpha&path=%2Foutside%2Fsecrets.txt',
      '/api/media?profile=alpha&path=relative%2Fcomputer_use_fake.png', '/api/tools/computer-use/status?profile=alpha&reveal=true',
      'https://example.invalid/api/media', '/api/tools/computer-use/status?profile=../escape']) {
      await expect(computerRequest(path, endpoint)).rejects.toThrow('Invalid Computer')
    }
    expect(requests).toHaveLength(before)
  })

  it('HD-10: the OS verifies a real spawned process group, not a successful JSON response', async () => {
    const child = spawn(process.execPath, ['-e', `
      require('node:http').createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ authenticated: req.headers['x-hermes-session-token'] === 'OBVIOUSLY_FAKE_PEER_TOKEN' }));
      }).listen(0, '127.0.0.1', function () { console.log(this.address().port) });
    `], { detached: true, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] })
    cleanups.push(async () => {
      if (child.exitCode != null) return
      const exited = once(child, 'exit')
      process.kill(-child.pid, 'SIGTERM')
      await exited
    })
    const [data] = await once(child.stdout, 'data')
    const baseUrl = `http://127.0.0.1:${Number(data.toString().trim())}`
    await expect(requestOwnedJson('/api/status', { baseUrl, auth,
      verifyPeer: (peer) => verifySpawnedPeer(peer, child) })).resolves.toEqual({ authenticated: true })
    await expect(requestOwnedJson('/api/status', { baseUrl, auth,
      verifyPeer: (peer) => verifySpawnedPeer(peer, { pid: child.pid + 1 }) })).rejects.toThrow('unavailable')
    await expect(requestOwnedJson('/api/status', { baseUrl, auth })).rejects.toThrow('unavailable')
  })

  it('waits for the spawned server to accept the same TCP peer before sending HTTP credentials', async () => {
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const server = require('node:http').createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ authenticated: req.headers['x-hermes-session-token'] === 'OBVIOUSLY_FAKE_PEER_TOKEN' }));
        server.close();
      });
      server.listen(0, '127.0.0.1', function () {
        console.log(this.address().port);
        fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      });
    `], { detached: true, env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] })
    cleanups.push(async () => {
      if (child.exitCode != null) return
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    })
    const [data] = await once(child.stdout, 'data')
    const baseUrl = `http://127.0.0.1:${Number(data.toString().trim())}`
    const exec = promisify(execFile)
    let samples = 0
    await expect(requestOwnedJson('/api/status', { baseUrl, auth,
      verifyPeer: peer => verifySpawnedPeer(peer, child, { run: async (...args) => {
        try { return await exec(...args) } finally {
          // Take the first real OS sample before the listening server accepts.
          if (args[0] === '/usr/sbin/lsof' && ++samples === 1) child.stdin.write('accept\n')
        }
      } }),
    })).resolves.toEqual({ authenticated: true })
    expect(samples).toBeGreaterThan(1)
  })
})

describe('app-owned renderer REST endpoint', () => {
  it.each([false, true])('requires native consent (%s) for HTTP mutations before connecting upstream', async approved => {
    const received = vi.fn()
    const baseUrl = await httpFixture((req, res) => {
      received(req.url)
      res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}')
    })
    const verifyPeer = vi.fn(async () => true)
    const confirmMutation = vi.fn(async () => approved)
    const proxy = await createServeRestProxy({ baseUrl, auth, verifyPeer, confirmMutation })
    cleanups.push(() => proxy.close())
    const request = await fetch(`${proxy.baseUrl}/api/cron/jobs`, { method: 'POST',
      headers: { [SERVE_TOKEN_HEADER]: proxy.auth.token, 'X-Hermes-Desk-Renderer': '7' },
      body: '{"name":"synthetic","prompt":"synthetic"}' })
    expect(request.status).toBe(approved ? 200 : 403)
    expect(confirmMutation).toHaveBeenCalledWith({ senderId: 7, method: 'POST', path: '/api/cron/jobs',
      body: '{"name":"synthetic","prompt":"synthetic"}' })
    expect(verifyPeer).toHaveBeenCalledTimes(approved ? 1 : 0)
    expect(received).toHaveBeenCalledTimes(approved ? 1 : 0)
  })
  it('forwards an exact unread receipt without a prompt and still asks for any other session change', async () => {
    const received = vi.fn()
    const baseUrl = await httpFixture((req, res) => {
      received(req.url)
      res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}')
    })
    const confirmMutation = vi.fn(async () => false)
    const proxy = await createServeRestProxy({ baseUrl, auth, verifyPeer: async () => true, confirmMutation })
    cleanups.push(() => proxy.close())
    const patch = (path, body) => fetch(`${proxy.baseUrl}${path}`, { method: 'PATCH',
      headers: { [SERVE_TOKEN_HEADER]: proxy.auth.token, 'X-Hermes-Desk-Renderer': '7' }, body: JSON.stringify(body) })
    const receipt = await patch('/api/sessions/s1?profile=default',
      { unread: false, profile: 'default', client_request_id: 'synthetic-request' })
    expect(receipt.status).toBe(200)
    expect(confirmMutation).not.toHaveBeenCalled()
    expect(received).toHaveBeenCalledWith('/api/sessions/s1?profile=default')
    for (const [path, body] of [
      ['/api/sessions/s1?profile=default', { unread: false, profile: 'default', title: 'renamed' }],
      ['/api/sessions/s1?profile=default', { unread: true, profile: 'default' }],
      ['/api/sessions/s1?profile=default', { unread: false, profile: 'other' }],
      ['/api/sessions/s1?profile=default&extra=1', { unread: false }],
    ]) expect((await patch(path, body)).status).toBe(403)
    expect(confirmMutation).toHaveBeenCalledTimes(4)
    expect(received).toHaveBeenCalledTimes(1)
  })
  it('forwards only the exact low-risk shapes without a prompt; settings, schedules, bulk work and deletes still ask', async () => {
    const received = vi.fn()
    const baseUrl = await httpFixture((req, res) => {
      received(`${req.method} ${req.url}`)
      res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}')
    })
    const confirmMutation = vi.fn(async () => false)
    const proxy = await createServeRestProxy({ baseUrl, auth, verifyPeer: async () => true, confirmMutation })
    cleanups.push(() => proxy.close())
    const send = (method, path, body) => fetch(`${proxy.baseUrl}${path}`, { method,
      headers: { [SERVE_TOKEN_HEADER]: proxy.auth.token, 'X-Hermes-Desk-Renderer': '7' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((res) => res.status)
    const id = { client_request_id: 'synthetic-request' }
    const free = [
      ['PATCH', '/api/sessions/s1', { title: 'Renamed', ...id }],
      ['PATCH', '/api/sessions/s1?profile=scout', { unread: false, profile: 'scout' }],
      ['PATCH', '/api/sessions/s1?profile=scout', { unread: false, profile: 'scout', request_id: 'synthetic-id', expected_revision: 3, expected_generation: 0 }],
      ['PATCH', '/api/sessions/s1', { title: 'Renamed', request_id: 'synthetic-id', expected_revision: 3, expected_generation: 1 }],
      ['POST', '/api/cron/jobs/j1/pause?profile=scout', id],
      ['POST', '/api/cron/jobs/j1/trigger', id],
      ['POST', '/api/memory/pending/m1/reject', {}],
      ['POST', '/api/plugins/kanban/boards/ops/switch', undefined],
      ['POST', '/api/plugins/kanban/tasks/t1/comments?board=ops', { body: 'Looks good' }],
      ['PATCH', '/api/plugins/kanban/tasks/t1', { status: 'done', assignee: null, ...id }],
      ['POST', '/api/plugins/kanban/tasks', { title: 'Synthetic task', body: 'Do it', parents: ['t0'], triage: true }],
    ]
    for (const [method, path, body] of free) expect(await send(method, path, body)).toBe(200)
    expect(confirmMutation).not.toHaveBeenCalled()
    expect(received).toHaveBeenCalledTimes(free.length)
    const asks = [
      ['PATCH', '/api/sessions/s1', { title: '   ' }],
      ['PATCH', '/api/sessions/s1', { title: 'Renamed', unread: false }],
      ['PATCH', '/api/sessions/s1', { title: 'Renamed', pinned: true }],
      ['PATCH', '/api/sessions/s1', { title: 'Renamed', expected_revision: -1 }],
      ['PATCH', '/api/sessions/s1', { unread: false, expected_generation: '0' }],
      ['DELETE', '/api/sessions/s1', undefined],
      ['POST', '/api/cron/jobs/j1/resume', id],
      ['POST', '/api/cron/jobs/j1/pause', { schedule: '* * * * *' }],
      ['POST', '/api/cron/jobs/j1/pause', []],
      ['POST', '/api/cron/jobs/j1/pause', null],
      ['POST', '/api/cron/jobs/j1/trigger', { client_request_id: 42 }],
      ['POST', '/api/cron/jobs/j1/trigger', { client_request_id: 'x'.repeat(129) }],
      ['POST', '/api/plugins/kanban/tasks', { title: 'Synthetic task', parents: 't0' }],
      ['POST', '/api/plugins/kanban/tasks', { title: 'Synthetic task', parents: Array(65).fill('t0') }],
      ['POST', '/api/plugins/kanban/tasks', { title: 'Synthetic task', triage: 'yes' }],
      ['POST', '/api/cron/jobs', { name: 'synthetic', prompt: 'synthetic' }],
      ['POST', '/api/memory/pending/m1/approve', {}],
      ['POST', '/api/plugins/kanban/dispatch?max=8', undefined],
      ['PATCH', '/api/plugins/kanban/tasks/t1', { status: 'done', workspace: '/tmp' }],
      ['PATCH', '/api/plugins/kanban/tasks/t1?board=ops&max=2', { status: 'done' }],
      ['POST', '/api/plugins/kanban/tasks', { body: 'no title' }],
      ['POST', '/api/plugins/kanban/tasks/t1/comments', { body: 42 }],
      ['PUT', '/api/profiles/scout/soul', { content: 'synthetic' }],
      ['PUT', '/api/tools/toolsets/web', { enabled: true }],
    ]
    for (const [method, path, body] of asks) expect(await send(method, path, body)).toBe(403)
    expect(confirmMutation).toHaveBeenCalledTimes(asks.length)
    expect(received).toHaveBeenCalledTimes(free.length)
  })
  it('HD-08/10: uses a separate local credential and verifies every backend connection before sending the serve token', async () => {
    const received = []
    const baseUrl = await httpFixture((req, res) => {
      received.push({ path: req.url, token: req.headers[SERVE_TOKEN_HEADER.toLowerCase()] })
      res.setHeader('Content-Type', 'application/json')
      res.end('{"profiles":[{"name":"alpha"}]}')
    })
    let authorize
    const proxy = await createServeRestProxy({ baseUrl, auth,
      verifyPeer: () => new Promise((resolve) => { authorize = resolve }) })
    cleanups.push(() => proxy.close())
    expect(proxy.auth.token).not.toBe(auth.token)
    const request = fetch(`${proxy.baseUrl}/api/profiles`, {
      headers: { [SERVE_TOKEN_HEADER]: proxy.auth.token },
    })
    await vi.waitFor(() => expect(authorize).toBeTypeOf('function'))
    expect(received).toEqual([])
    authorize(true)
    expect(await (await request).json()).toEqual({ profiles: [{ name: 'alpha' }] })
    expect(received).toEqual([{ path: '/api/profiles', token: auth.token }])
    for (const route of ['/api/config', '/api/env/reveal', '/api/mcp/servers', '/api/skills?reveal=true']) {
      expect((await fetch(`${proxy.baseUrl}${route}`, {
        headers: { [SERVE_TOKEN_HEADER]: proxy.auth.token },
      })).status).toBe(403)
    }
    expect((await fetch(`${proxy.baseUrl}/api/profiles`)).status).toBe(403)
    expect(received).toHaveLength(1)
    authorize = undefined
    const refused = fetch(`${proxy.baseUrl}/api/profiles`, {
      headers: { [SERVE_TOKEN_HEADER]: proxy.auth.token },
    })
    await vi.waitFor(() => expect(authorize).toBeTypeOf('function'))
    authorize(false)
    expect((await refused).status).toBe(502)
    expect(received).toHaveLength(1)
  })
})

describe('verified serve WebSocket upgrades', () => {
  it('HD-10: verifies before token-bearing upgrade, supports fragments/ping and refuses an impostor on reconnect', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(wss, 'listening')
    cleanups.push(async () => {
      for (const peer of wss.clients) peer.terminate()
      await new Promise((resolve) => wss.close(resolve))
    })
    const connections = []
    wss.on('connection', (peer, req) => { connections.push({ peer, url: req.url }) })
    let authorize
    const Socket = verifiedWebSocket(() => new Promise((resolve) => { authorize = resolve }))
    const url = `ws://127.0.0.1:${wss.address().port}/api/ws?token=${auth.token}`
    const socket = new Socket(url)
    const errors = vi.fn()
    socket.addEventListener('error', errors)
    cleanups.push(() => socket.close())
    await vi.waitFor(() => expect(authorize).toBeTypeOf('function'))
    expect(connections).toEqual([])
    authorize(true)
    await once(socket, 'open')
    expect(connections[0].url).toContain(auth.token)
    const message = vi.fn()
    socket.addEventListener('message', message)
    connections[0].peer.send('{"fake":', { fin: false })
    connections[0].peer.ping('probe')
    const pong = once(connections[0].peer, 'pong')
    connections[0].peer.send('true}', { fin: true })
    await pong
    await vi.waitFor(() => expect(message).toHaveBeenCalledWith({ data: '{"fake":true}' }))
    const inbound = once(connections[0].peer, 'message')
    socket.send('{"request":"fake"}')
    expect((await inbound)[0].toString()).toBe('{"request":"fake"}')
    socket.close()
    authorize = undefined
    const denied = new Socket(url)
    denied.addEventListener('error', errors)
    cleanups.push(() => denied.close())
    await vi.waitFor(() => expect(authorize).toBeTypeOf('function'))
    const closed = new Promise((resolve) => denied.once('close', resolve))
    // Wait for the new connection's verifier, not the old callback.
    await vi.waitFor(() => expect(denied.readyState).toBe(0))
    authorize(false)
    await closed
    expect(connections).toHaveLength(1)
    expect(errors).toHaveBeenCalled()
  })
})
