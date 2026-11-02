import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeToken, fixtures } from './workspace/redactor-fixtures.mjs'

const require = createRequire(import.meta.url)
const { createHermesHost, probeServe, verifySpawnedPeer } = require('./hermes-host.cjs')
const cleanups = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()()
  vi.useRealTimers()
})

function fixture(overrides = {}) {
  const children = []
  const client = { connected: false, setEndpoint: vi.fn(), stop: vi.fn(), onConnection: vi.fn() }
  const serveAuth = { setEndpoint: vi.fn(), clearEndpoint: vi.fn() }
  const deps = {
    env: { PATH: '/fake/bin', GITHUB_TOKEN: 'obviously-fake-github-token',
      HERMES_DASHBOARD_SESSION_TOKEN: 'obviously-fake-existing-token', HERMES_HOME: '/fake-wrong-home' },
    discoverHermes: vi.fn(() => '/fake/bin/hermes'),
    freeServePort: vi.fn(async () => 9127),
    readToken: vi.fn(async () => ({ token: 'obviously-fake-existing-token', source: 'env' })),
    randomToken: vi.fn(() => 'obviously-fake-launch-token'),
    probeServe: vi.fn(async (url, token) => token === 'obviously-fake-launch-token' ? { version: 'fake-v1' } : null),
    createServeClient: () => client,
    createGatewayClient: () => ({ health: async () => ({ state: 'down' }) }),
    sleep: async () => {},
    spawn: vi.fn(() => {
      const child = new EventEmitter()
      child.stderr = new EventEmitter()
      child.pid = 999999
      children.push(child)
      return child
    }),
    kill: vi.fn((child) => child.emit('exit', 0)),
    ...overrides,
  }
  const host = createHermesHost({ hostDeps: deps, serveAuth, getAppConfig: deps.getAppConfig })
  cleanups.push(() => host.stop())
  return { host, deps, client, serveAuth, children }
}

describe('Hermes host lifecycle', () => {
  it('spawns trusted Hermes on 9120+ with scrubbed env and an in-memory token', async () => {
    const { host, deps, serveAuth } = fixture()
    await host.start()
    expect(deps.spawn).toHaveBeenCalledWith('/fake/bin/hermes',
      ['serve', '--host', '127.0.0.1', '--port', '9127'], expect.objectContaining({
        shell: false, detached: true,
        env: { PATH: '/fake/bin', HERMES_HOME: expect.stringMatching(/\/\.hermes$/), HERMES_DESKTOP: '1',
          HERMES_GATEWAY_SESSION: '1', HERMES_EXEC_ASK: '1', HERMES_INTERACTIVE: '1',
          HERMES_SUPERVISED_CHILD: '1',
          HERMES_DASHBOARD_SESSION_TOKEN: 'obviously-fake-launch-token' },
      }))
    expect(serveAuth.setEndpoint).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'http://127.0.0.1:9127', auth: { token: 'obviously-fake-launch-token', source: 'env' },
    }))
    expect(host.status()).toMatchObject({ serve: { state: 'up', mode: 'spawned', port: 9127 }, controller: 'off' })
    expect(JSON.stringify(host.status())).not.toContain('obviously-fake')
  })

  it('allows a healthy backend with a slow plugin inventory to become ready', async () => {
    let probes = 0
    const probeServe = vi.fn(async () => ++probes >= 45 ? { version: 'slow-v1' } : null)
    const { host } = fixture({ probeServe })
    await host.start()
    expect(probeServe).toHaveBeenCalledTimes(45)
    expect(host.status().serve).toMatchObject({ state: 'up', version: 'slow-v1' })
  })

  it('marks every managed backend launch as supervised even when the parent disables the marker', async () => {
    const { host, deps } = fixture({ env: { HERMES_SUPERVISED_CHILD: 'false' } })
    await host.start()
    await host.restartServe()
    expect(deps.spawn).toHaveBeenCalledTimes(2)
    for (const [, , options] of deps.spawn.mock.calls) {
      expect(options.env.HERMES_SUPERVISED_CHILD).toBe('1')
    }
  })

  it('enables human approval routing at every owned launch before any session create, including lazy-only recovery', async () => {
    const { host, deps } = fixture({ env: {
      HERMES_GATEWAY_SESSION: '0', HERMES_EXEC_ASK: '0', HERMES_INTERACTIVE: '0',
    } })
    await host.start()
    await host.restartServe()
    expect(deps.spawn).toHaveBeenCalledTimes(2)
    for (const [, , options] of deps.spawn.mock.calls) expect(options.env).toMatchObject({
      HERMES_GATEWAY_SESSION: '1', HERMES_EXEC_ASK: '1', HERMES_INTERACTIVE: '1',
    })
    expect(deps.env.HERMES_EXEC_ASK).toBe('0')
  })

  it('refuses unverified external attachment without reading or sending a reusable token', async () => {
    const { host, deps } = fixture({ getAppConfig: () => ({ serve: { mode: 'attach', port: 9138 } }) })
    await host.start()
    expect(host.status().serve).toMatchObject({ state: 'down', port: 9138, detail: expect.stringContaining('cannot be authenticated') })
    expect(deps.spawn).not.toHaveBeenCalled()
    expect(deps.readToken).not.toHaveBeenCalled()
    expect(deps.probeServe).not.toHaveBeenCalled()
    await host.restartServe()
    await host.stop()
    expect(deps.kill).not.toHaveBeenCalled()
  })

  it('does not try attaching without a token or send one to a hosted URL', async () => {
    const { host, deps } = fixture({
      env: { HERMES_SERVE_URL: 'https://example.invalid' },
      readToken: async () => ({ token: '', source: 'none' }),
    })
    await host.start()
    expect(deps.probeServe.mock.calls.every(([url]) => url.startsWith('http://127.0.0.1:'))).toBe(true)
    expect(deps.probeServe).not.toHaveBeenCalledWith('https://example.invalid', expect.anything())
    expect(deps.spawn).toHaveBeenCalledTimes(1)
  })

  it('keeps a redacted 50-line stderr tail and returns independent status snapshots', async () => {
    const { host, children } = fixture()
    await host.start()
    children[0].stderr.emit('data', Buffer.from(Array.from({ length: 60 }, (_, i) =>
      `line ${i} token=obviously-fake-launch-token`).join('\n') + '\n'))
    const status = host.status()
    expect(status.serve.stderrTail).toHaveLength(50)
    expect(status.serve.stderrTail[0]).toBe('line 10 token=[secret]')
    expect(JSON.stringify(status)).not.toContain('obviously-fake')
    status.serve.stderrTail.length = 0
    expect(host.status().serve.stderrTail).toHaveLength(50)
  })

  it.each([
    ['AWS access key', fakeToken('aws')],
    ['unsigned JWT', fixtures.FAKE_UNSIGNED_JWT],
    ['quoted credential', ['password', JSON.stringify('FAKE quoted credential tail')].join('=')],
    ['single-quoted credential', ['authorization', "'FAKE quoted authorization tail'"].join('=')],
  ])('scrubs %s before status snapshots and broadcasts', async (_kind, value) => {
    const { host, children } = fixture()
    await host.start()
    const snapshots = []
    host.onStatus(status => snapshots.push(status))
    children[0].stderr.emit('data', Buffer.from(`Synthetic failure: ${value}\n`))
    const serialized = JSON.stringify([host.status(), ...snapshots])
    expect(serialized).not.toContain(value)
    expect(serialized).not.toContain('quoted credential tail')
    expect(serialized).not.toContain('quoted authorization tail')
    expect(host.status().serve.stderrTail.join('\n')).toContain('Synthetic failure:')
    expect(serialized).toContain('[secret]')
  })

  it('holds a chunk-split PEM body private and resumes useful stderr after its end', async () => {
    const { host, children } = fixture()
    await host.start()
    const snapshots = []
    host.onStatus(status => snapshots.push(status))
    const chunks = [
      `Synthetic before\n${fixtures.FAKE_RSA_BEGIN.slice(0, 13)}`,
      `${fixtures.FAKE_RSA_BEGIN.slice(13)}\nFAKE first key body\n`,
      'FAKE second key body\n',
      `${fixtures.FAKE_RSA_END}\nSynthetic after\n`,
    ]
    for (const chunk of chunks) children[0].stderr.emit('data', Buffer.from(chunk))
    const serialized = JSON.stringify([host.status(), ...snapshots])
    expect(serialized).not.toContain('FAKE first key body')
    expect(serialized).not.toContain('FAKE second key body')
    expect(serialized).not.toContain(fixtures.FAKE_RSA_BEGIN)
    expect(host.status().serve.stderrTail.join('\n')).toContain('Synthetic before')
    expect(host.status().serve.stderrTail.join('\n')).toContain('Synthetic after')
  })

  it('keeps an unterminated PEM private through stop and resets the guard on restart', async () => {
    const { host, children } = fixture()
    await host.start()
    children[0].stderr.emit('data', Buffer.from(`${fixtures.FAKE_PEM_BEGIN}\nFAKE truncated body`))
    await host.stop()
    expect(JSON.stringify(host.status())).not.toContain('FAKE truncated body')
    await host.start()
    children[1].stderr.emit('data', Buffer.from('Synthetic restarted host\n'))
    expect(host.status().serve.stderrTail.join('\n')).toContain('Synthetic restarted host')
  })

  it('does not leak the continuation of an overlong quoted credential line', async () => {
    const { host, children } = fixture()
    await host.start()
    const start = ['password', `"${'FAKE '.repeat(1700)}`].join('=')
    children[0].stderr.emit('data', Buffer.from(start))
    children[0].stderr.emit('data', Buffer.from('FAKE overflow credential tail"\nSynthetic recovered line\n'))
    const text = host.status().serve.stderrTail.join('\n')
    expect(text).not.toContain('overflow credential tail')
    expect(text).toContain('Synthetic recovered line')
  })

  it('restarts crashed children with 1s to 30s backoff, and cancels restart on stop', async () => {
    vi.useFakeTimers()
    const { host, deps, children } = fixture()
    await host.start()
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = children.length
      children.at(-1).emit('exit', 1)
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(children.length).toBe(count)
      await vi.advanceTimersByTimeAsync(1)
      expect(children.length).toBe(count + 1)
    }
    children.at(-1).emit('exit', 1)
    await host.stop()
    const count = deps.spawn.mock.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(deps.spawn).toHaveBeenCalledTimes(count)
  })

  it('single-flights start and does not spawn after a pending port lookup is stopped', async () => {
    let resolvePort
    const { host, deps } = fixture({ freeServePort: () => new Promise((resolve) => { resolvePort = resolve }) })
    const one = host.start()
    const two = host.start()
    await vi.waitFor(() => expect(resolvePort).toBeTypeOf('function'))
    await host.stop()
    resolvePort(9130)
    await Promise.all([one, two])
    expect(deps.spawn).not.toHaveBeenCalled()
  })

  it('kills a spawned child on stop and preserves diagnostics on startup failure', async () => {
    const { host, deps, children } = fixture()
    await host.start()
    await host.stop()
    expect(deps.kill).toHaveBeenCalledWith(children[0], 'SIGTERM')
    expect(host.status().serve.state).toBe('down')
    const broken = fixture({ discoverHermes: () => { throw new Error('fake failure') } })
    await broken.host.start()
    expect(broken.host.status().serve).toMatchObject({ state: 'down', detail: expect.stringContaining('Unable to start') })
  })

  it('rejects a non-loopback probe before performing any network request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(probeServe('https://example.invalid', 'obviously-fake-token')).resolves.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('checks actual authenticated HTTP status without following redirects', async () => {
    let redirect = false
    const server = createServer((req, res) => {
      expect(req.url).toBe('/api/status')
      if (redirect) { res.writeHead(302, { Location: 'https://example.invalid' }); res.end(); return }
      if (req.headers['x-hermes-session-token'] !== 'obviously-fake-accepted-token') {
        res.writeHead(401); res.end(); return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ version: 'fake-version' }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise((resolve) => server.close(resolve)))
    const url = `http://127.0.0.1:${server.address().port}`
    await expect(probeServe(url, 'obviously-fake-rejected-token', async () => true)).resolves.toBeNull()
    await expect(probeServe(url, 'obviously-fake-accepted-token', async () => true)).resolves.toEqual({ version: 'fake-version' })
    redirect = true
    await expect(probeServe(url, 'obviously-fake-accepted-token', async () => true)).resolves.toBeNull()
  })

  it('force-kills an unresponsive child after the shutdown deadline', async () => {
    vi.useFakeTimers()
    const { host, deps, children } = fixture({ kill: vi.fn() })
    await host.start()
    const stopped = host.stop()
    expect(deps.kill).toHaveBeenCalledWith(children[0], 'SIGTERM')
    await vi.advanceTimersByTimeAsync(2000)
    await stopped
    expect(deps.kill).toHaveBeenCalledWith(children[0], 'SIGKILL')
  })

  it('honors live persisted spawn mode/port on restart and auto port selection', async () => {
    let settings = { serve: { mode: 'spawn', port: 9188 } }
    const { host, deps } = fixture({ getAppConfig: () => settings, freeServePort: vi.fn(async (port) => port) })
    await host.start()
    expect(deps.freeServePort).toHaveBeenLastCalledWith(9188, { exact: true })
    expect(host.status().serve.port).toBe(9188)
    settings = { serve: { mode: 'auto', port: 9190 } }
    await host.restartServe()
    expect(deps.freeServePort).toHaveBeenLastCalledWith(9190, { exact: false })
    expect(host.status().serve.port).toBe(9190)
    expect(deps.readToken).not.toHaveBeenCalled()
  })

  it('HD-10: a port-handoff impostor receives no HTTP token and is never published', async () => {
    const requests = []
    const server = createServer((req, res) => { requests.push(req.headers); res.end('{"version":"impostor"}') })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise((resolve) => server.close(resolve)))
    const { host, client, serveAuth, deps } = fixture({
      freeServePort: async () => server.address().port,
      probeServe, verifySpawnedPeer: vi.fn(async () => false),
    })
    await host.start()
    expect(requests).toEqual([])
    expect(client.setEndpoint).not.toHaveBeenCalled()
    expect(serveAuth.setEndpoint).not.toHaveBeenCalled()
    expect(deps.verifySpawnedPeer).toHaveBeenCalled()
    expect(host.status().serve.state).toBe('down')
  })

  it('HD-10: exact-connection ownership rejects other UIDs, process groups and exited children', async () => {
    const peer = { remoteAddress: '127.0.0.1', remotePort: 9188, localPort: 54321 }
    const child = { pid: 1234 }
    const run = vi.fn(async (command) => ({ stdout: command.endsWith('lsof')
      ? 'p4567\nu501\nn127.0.0.1:9188->127.0.0.1:54321\n'
      : '1234 501\n' }))
    await expect(verifySpawnedPeer(peer, child, { run, uid: 501 })).resolves.toBe(true)
    await expect(verifySpawnedPeer(peer, child, { run, uid: 502 })).resolves.toBe(false)
    await expect(verifySpawnedPeer({ ...peer, localPort: 54322 }, child, { run, uid: 501 })).resolves.toBe(false)
    await expect(verifySpawnedPeer(peer, { pid: 1235 }, { run, uid: 501 })).resolves.toBe(false)
    await expect(verifySpawnedPeer(peer, { ...child, exitCode: 1 }, { run, uid: 501 })).resolves.toBe(false)
  })

  it('does not retry a foreign owner or group, and cannot authorize a peer closed during verification', async () => {
    const peer = { remoteAddress: '127.0.0.1', remotePort: 9188, localPort: 54321, destroyed: false }
    const child = { pid: 1234 }
    for (const [owner, group] of [[502, 1234], [501, 4321]]) {
      const run = vi.fn(async command => ({ stdout: command.endsWith('lsof')
        ? `p4567\nu${owner}\nn127.0.0.1:9188->127.0.0.1:54321\n`
        : `${group} ${owner}\n` }))
      await expect(verifySpawnedPeer(peer, child, { run, uid: 501 })).resolves.toBe(false)
      expect(run.mock.calls.filter(([command]) => command.endsWith('lsof'))).toHaveLength(1)
    }
    const run = vi.fn(async command => {
      if (command.endsWith('ps')) peer.destroyed = true
      return { stdout: command.endsWith('lsof')
        ? 'p4567\nu501\nn127.0.0.1:9188->127.0.0.1:54321\n' : '1234 501\n' }
    })
    await expect(verifySpawnedPeer(peer, child, { run, uid: 501 })).resolves.toBe(false)
  })
})
