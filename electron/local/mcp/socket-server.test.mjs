import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSocketServer } from './socket-server.cjs'
import { listTools } from './tools.cjs'
import { errorContent } from './dispatch.cjs'

const cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(options = {}) {
  const userDataDir = await fs.mkdtemp('/tmp/hd-mcp-')
  cleanups.push(() => fs.rm(userDataDir, { recursive: true, force: true }))
  const dispatch = {
    gate: vi.fn((profile) => {
      if (profile !== 'alpha') throw Object.assign(new Error('Disabled fake profile'), { code: 'not_enabled' })
    }),
    listTools,
    call: vi.fn(async (params) => params.profile === 'alpha' ?
      { content: [{ type: 'text', text: 'fixture result' }] } : errorContent('not_enabled')),
    rejectCall: vi.fn((_params, code) => errorContent(code)),
    cancel: vi.fn(),
  }
  const server = createSocketServer({ userDataDir, dispatch, appVersion: 'fixture-version',
    verifyToken: (profile, token) => token === `obviously-fake-${profile}`, ...options })
  cleanups.push(server.dispose)
  return { server, userDataDir, dispatch }
}

async function clientFor(socketPath) {
  const client = net.createConnection(socketPath)
  const messages = []
  const waiters = []
  let pending = ''
  const closed = new Promise((resolve) => client.once('close', resolve))
  client.on('error', () => {})
  client.on('data', (data) => {
    pending += data.toString()
    let end
    while ((end = pending.indexOf('\n')) >= 0) {
      const message = JSON.parse(pending.slice(0, end))
      pending = pending.slice(end + 1)
      if (waiters.length) waiters.shift()(message)
      else messages.push(message)
    }
  })
  await once(client, 'connect')
  cleanups.push(() => client.destroy())
  return {
    client, closed,
    next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiters.push(resolve)),
    send: (frame) => client.write(`${JSON.stringify(frame)}\n`),
  }
}

const hello = (id = 1, profile = 'alpha') =>
  ({ id, method: 'hello', params: { profile, token: `obviously-fake-${profile}`, shimVersion: '1.0.0', pid: 123 } })
async function admit(c) {
  c.send(hello('admission'))
  expect((await c.next()).result.protocol).toBe(1)
}
const call = (id = 2, profile = 'alpha', callId = `call-${id}`) =>
  ({ id, method: 'tools/call', params: { profile, name: 'browser_back', arguments: {}, callId } })

describe('MCP Unix socket server', () => {
  it('creates the private directory/socket and speaks the hello, list, and call protocol', async () => {
    const f = await fixture()
    await f.server.start()
    expect((await fs.stat(path.dirname(f.server.socketPath))).mode & 0o777).toBe(0o700)
    expect((await fs.stat(f.server.socketPath)).mode & 0o777).toBe(0o600)
    const c = await clientFor(f.server.socketPath)
    c.send(hello())
    expect(await c.next()).toEqual({ id: 1, result: { protocol: 1, appVersion: 'fixture-version' } })
    c.send({ id: 'list', method: 'tools/list', params: { profile: 'alpha' } })
    expect(await c.next()).toEqual({ id: 'list', result: { tools: listTools() } })
    c.send(call())
    expect(await c.next()).toEqual({ id: 2, result: { content: [{ type: 'text', text: 'fixture result' }] } })
    expect(f.dispatch.call).toHaveBeenCalledWith(call().params, { owner: expect.any(Object), signal: expect.any(AbortSignal) })
    await f.server.dispose()
    await expect(fs.lstat(f.server.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reassembles fragmented UTF-8 and processes multiple NDJSON lines in one chunk', async () => {
    const f = await fixture()
    await f.server.start()
    const c = await clientFor(f.server.socketPath)
    await admit(c)
    const frame = Buffer.from(`${JSON.stringify({ ...call(), params: { ...call().params, arguments: { text: 'fixture-é' } } })}\n`)
    const split = frame.indexOf(Buffer.from('é')) + 1
    c.client.write(frame.subarray(0, split))
    c.client.write(Buffer.concat([frame.subarray(split), Buffer.from(`${JSON.stringify(call(3))}\n`)]))
    const results = [await c.next(), await c.next()]
    expect(results.map((frame) => frame.id).sort()).toEqual([2, 3])
    expect(f.dispatch.call.mock.calls[0][0].arguments.text).toBe('fixture-é')
  })

  it('reports malformed JSON and invalid UTF-8 without echoing raw input and stays usable', async () => {
    const f = await fixture()
    await f.server.start()
    const c = await clientFor(f.server.socketPath)
    c.client.write('OBVIOUSLY_FAKE_SECRET not-json\n[]\n')
    c.client.write(Buffer.from([0xff, 10]))
    for (let i = 0; i < 3; i++) {
      const response = await c.next()
      expect(response).toEqual({ id: null, error: { code: 'bad_args', message: 'Malformed NDJSON frame' } })
      expect(JSON.stringify(response)).not.toContain('OBVIOUSLY_FAKE_SECRET')
    }
    c.send(hello())
    expect((await c.next()).result.protocol).toBe(1)
  })

  it.each([false, true])('disconnects an oversized line (terminated: %s)', async (terminated) => {
    const f = await fixture({ maxLineBytes: 512 })
    await f.server.start()
    const c = await clientFor(f.server.socketPath)
    c.client.write('x'.repeat(300))
    c.client.write('x'.repeat(300) + (terminated ? '\n' : ''))
    await c.closed
    expect(f.dispatch.call).not.toHaveBeenCalled()
  })

  it('enforces the in-flight cap without preventing cancel notifications', async () => {
    const f = await fixture({ maxInFlight: 1 })
    const pending = deferred()
    const entered = deferred()
    f.dispatch.call.mockImplementationOnce(async () => { entered.resolve(); await pending.promise; return { content: [] } })
    await f.server.start()
    const c = await clientFor(f.server.socketPath)
    await admit(c)
    c.send(call(1))
    await entered.promise
    c.send(call(2))
    expect(await c.next()).toMatchObject({ id: 2, result: { isError: true, content: [{ text: expect.stringMatching(/^resource_limit:/) }] } })
    c.send({ method: 'cancel', params: { profile: 'alpha', callId: 'call-1' } })
    await vi.waitFor(() => expect(f.dispatch.cancel).toHaveBeenCalledWith('call-1', {
      owner: f.dispatch.call.mock.calls[0][1].owner,
    }))
    pending.resolve()
    expect(await c.next()).toEqual({ id: 1, result: { content: [] } })
  })

  it('returns typed tool failures as content, never JSON-RPC errors', async () => {
    const f = await fixture()
    await f.server.start()
    const c = await clientFor(f.server.socketPath)
    await admit(c)
    f.dispatch.call.mockResolvedValueOnce(errorContent('not_enabled'))
    c.send(call(1))
    const response = await c.next()
    expect(response).toMatchObject({ id: 1, result: { isError: true, content: [{ text: expect.stringMatching(/^not_enabled:/) }] } })
    expect(response.error).toBeUndefined()
    const disabled = await clientFor(f.server.socketPath)
    disabled.send(hello(2, 'disabled'))
    expect(await disabled.next()).toMatchObject({ id: 2, error: { code: 'not_enabled' } })
  })

  it('pins a connection to its first profile and rejects attempts to switch profiles', async () => {
    const f = await fixture()
    f.dispatch.gate.mockImplementation(() => {})
    await f.server.start()
    const c = await clientFor(f.server.socketPath)
    c.send(hello())
    await c.next()
    c.send(call(2, 'beta'))
    expect((await c.next()).result.content[0].text).toMatch(/^blocked_by_policy:/)
    expect(f.dispatch.call).not.toHaveBeenCalled()
  })

  it('rejects duplicate outstanding IDs and invalid hello identity', async () => {
    const f = await fixture()
    const pending = deferred()
    const entered = deferred()
    f.dispatch.call.mockImplementationOnce(async () => { entered.resolve(); await pending.promise; return { content: [] } })
    await f.server.start()
    const c = await clientFor(f.server.socketPath)
    c.send({ ...hello(), params: { ...hello().params, pid: -1 } })
    expect((await c.next()).error.code).toBe('bad_args')
    await admit(c)
    c.send(call(2))
    await entered.promise
    c.send(call(2))
    expect((await c.next()).error.message).toContain('Duplicate')
    pending.resolve()
    await c.next()
  })

  it('aborts the connection signal when a client disconnects', async () => {
    const f = await fixture()
    await f.server.start()
    const c = await clientFor(f.server.socketPath)
    await admit(c)
    c.send(call())
    await c.next()
    const signal = f.dispatch.call.mock.calls[0][1].signal
    c.client.destroy()
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
  })

  it('refuses a live listener without unlinking or changing its socket', async () => {
    const f = await fixture()
    await fs.mkdir(path.dirname(f.server.socketPath))
    const live = net.createServer((client) => client.destroy())
    await new Promise((resolve) => live.listen(f.server.socketPath, resolve))
    cleanups.push(() => new Promise((resolve) => live.close(resolve)))
    const before = await fs.lstat(f.server.socketPath)
    await expect(f.server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    const after = await fs.lstat(f.server.socketPath)
    expect(after.ino).toBe(before.ino)
    await f.server.dispose()
    expect((await fs.lstat(f.server.socketPath)).ino).toBe(before.ino)
  })

  it('replaces a real stale Unix socket only after its listener is gone', async () => {
    const f = await fixture()
    await fs.mkdir(path.dirname(f.server.socketPath))
    const child = spawn(process.execPath, ['-e',
      'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("READY\\n"))',
      f.server.socketPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    await once(child.stdout, 'data')
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    expect((await fs.lstat(f.server.socketPath)).isSocket()).toBe(true)
    await f.server.start()
    const c = await clientFor(f.server.socketPath)
    c.send(hello())
    expect((await c.next()).result.protocol).toBe(1)
    expect((await fs.stat(f.server.socketPath)).mode & 0o777).toBe(0o600)
  })

  it('refuses non-socket paths and symlink directories without modifying their contents', async () => {
    const f = await fixture()
    await fs.mkdir(path.dirname(f.server.socketPath))
    await fs.writeFile(f.server.socketPath, 'owned fixture file')
    await expect(f.server.start()).rejects.toMatchObject({ code: 'blocked_by_policy' })
    await f.server.dispose()
    expect(await fs.readFile(f.server.socketPath, 'utf8')).toBe('owned fixture file')
    const second = await fixture()
    await fs.symlink(path.dirname(f.server.socketPath), path.dirname(second.server.socketPath))
    await expect(second.server.start()).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(await fs.readFile(f.server.socketPath, 'utf8')).toBe('owned fixture file')
  })

  it('can be disposed while starting without leaving a listening socket', async () => {
    const f = await fixture()
    const starting = f.server.start()
    const rejected = expect(starting).rejects.toMatchObject({ code: 'app_unavailable' })
    await f.server.dispose()
    await rejected
    await expect(fs.lstat(f.server.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('HD-06 rejects unauthenticated calls, list and cancel without selecting a lane', async () => {
    const f = await fixture()
    await f.server.start()
    const c = await clientFor(f.server.socketPath)
    c.send(call())
    expect((await c.next()).result.content[0].text).toMatch(/^blocked_by_policy:/)
    c.send({ id: 3, method: 'tools/list', params: { profile: 'alpha' } })
    expect((await c.next()).error.code).toBe('blocked_by_policy')
    c.send({ method: 'cancel', params: { profile: 'alpha', callId: 'call-2' } })
    expect((await c.next()).error.code).toBe('blocked_by_policy')
    expect(f.dispatch.call).not.toHaveBeenCalled()
    expect(f.dispatch.cancel).not.toHaveBeenCalled()
    expect(f.dispatch.gate).not.toHaveBeenCalled()
  })

  it('HD-06 rejects missing/wrong and cross-profile tokens, including on fresh connections', async () => {
    const f = await fixture()
    f.dispatch.gate.mockImplementation(() => {})
    await f.server.start()
    for (const [profile, token] of [['alpha', undefined], ['alpha', 'wrong'], ['beta', 'obviously-fake-alpha']]) {
      const c = await clientFor(f.server.socketPath)
      c.send({ ...hello(), params: { ...hello().params, profile, token } })
      const response = await c.next()
      expect(response.error.code).toBe('blocked_by_policy')
      expect(JSON.stringify(response)).not.toContain('obviously-fake')
      c.send(call(2, profile))
      expect((await c.next()).result.isError).toBe(true)
    }
    expect(f.dispatch.call).not.toHaveBeenCalled()
  })

  it('HD-06 rechecks credentials after rotation and refuses repeat hello/profile-changing cancels', async () => {
    let valid = true
    const f = await fixture({ verifyToken: () => valid })
    await f.server.start()
    const c = await clientFor(f.server.socketPath)
    await admit(c)
    c.send(hello(2))
    expect((await c.next()).error.code).toBe('blocked_by_policy')
    c.send({ method: 'cancel', params: { profile: 'beta', callId: 'call-2' } })
    expect((await c.next()).error.code).toBe('blocked_by_policy')
    valid = false
    c.send(call(3))
    expect((await c.next()).result.content[0].text).toMatch(/^blocked_by_policy:/)
    expect(f.dispatch.call).not.toHaveBeenCalled()
    expect(f.dispatch.cancel).not.toHaveBeenCalled()
  })

  it('HD-07 bounds connections across clients and releases slots on close', async () => {
    const f = await fixture({ maxConnections: 2 })
    await f.server.start()
    const first = await clientFor(f.server.socketPath)
    const second = await clientFor(f.server.socketPath)
    await admit(first)
    await admit(second)
    const excess = await clientFor(f.server.socketPath)
    expect((await excess.next()).error.code).toBe('resource_limit')
    await excess.closed
    first.client.destroy()
    await first.closed
    // Admission after the server observes EOF must regain the released slot.
    await vi.waitFor(async () => {
      const replacement = await clientFor(f.server.socketPath)
      replacement.send(hello())
      const result = await replacement.next()
      replacement.client.destroy()
      expect(result.result?.protocol).toBe(1)
    })
  })

  it('HD-07 bounds aggregate input capacity and releases partial buffers on close', async () => {
    const f = await fixture({ maxLineBytes: 128, maxTotalBufferedBytes: 256 })
    await f.server.start()
    const first = await clientFor(f.server.socketPath)
    const second = await clientFor(f.server.socketPath)
    first.client.write('x')
    second.client.write('x')
    const third = await clientFor(f.server.socketPath)
    third.client.write('x')
    expect((await third.next()).error.code).toBe('resource_limit')
    await third.closed
    first.client.destroy()
    second.client.destroy()
    await Promise.all([first.closed, second.closed])
    const replacement = await clientFor(f.server.socketPath)
    await admit(replacement)
  })

  it('HD-07 enforces aggregate in-flight requests while cancellation stays available', async () => {
    const f = await fixture({ maxTotalInFlight: 2 })
    const pending = deferred()
    const entered = deferred()
    f.dispatch.call.mockImplementation(async () => {
      if (f.dispatch.call.mock.calls.length === 2) entered.resolve()
      await pending.promise
      return { content: [] }
    })
    await f.server.start()
    const first = await clientFor(f.server.socketPath)
    const second = await clientFor(f.server.socketPath)
    await admit(first)
    await admit(second)
    first.send(call(1))
    second.send(call(1))
    await entered.promise
    second.send(call(2))
    expect((await second.next()).result.content[0].text).toMatch(/^resource_limit:/)
    second.send({ method: 'cancel', params: { profile: 'alpha', callId: 'call-1' } })
    await vi.waitFor(() => expect(f.dispatch.cancel).toHaveBeenCalledOnce())
    pending.resolve()
    await first.next()
    await second.next()
    second.send(call(3))
    expect((await second.next()).result.isError).toBeUndefined()
  })

  it('HD-07 bounds replies with the shared buffer budget', async () => {
    const f = await fixture({ maxTotalBufferedBytes: 512 })
    await f.server.start()
    const c = await clientFor(f.server.socketPath)
    await admit(c)
    f.dispatch.call.mockResolvedValueOnce({ content: [{ type: 'text', text: 'x'.repeat(600) }] })
    c.send(call())
    expect((await c.next()).error.code).toBe('resource_limit')
    await c.closed
  })

  it('HD-07 accounts for one clients partial input when admitting another clients output', async () => {
    const f = await fixture({ maxTotalBufferedBytes: 8192 })
    await f.server.start()
    const partial = await clientFor(f.server.socketPath)
    partial.client.write('{')
    const caller = await clientFor(f.server.socketPath)
    await admit(caller)
    f.dispatch.call.mockResolvedValueOnce({ content: [{ type: 'text', text: 'x'.repeat(5000) }] })
    caller.send(call())
    expect((await caller.next()).error.code).toBe('resource_limit')
    await caller.closed
  })

  it.each(['partial', 'idle'])('HD-07 expires %s connections with a typed deadline', async (kind) => {
    const f = await fixture({ partialFrameTimeoutMs: 50, idleTimeoutMs: kind === 'idle' ? 50 : 1000 })
    await f.server.start()
    const c = await clientFor(f.server.socketPath)
    if (kind === 'partial') c.client.write('{')
    expect((await c.next()).error.code).toBe('timeout')
    await c.closed
  })
})
