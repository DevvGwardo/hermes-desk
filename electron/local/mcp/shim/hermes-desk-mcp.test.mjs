import { createRequire } from 'node:module'
import { PassThrough, Writable } from 'node:stream'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GENUI_INPUT_SCHEMA, parseGenUi } from '../genui.mjs'
import { ACTIONS } from '../../workspace/cdp-exec.cjs'
import { listBrowserTools, listTools } from '../tools.cjs'

const require = createRequire(import.meta.url)
const { createShim, parseArgs, validTools, validRenderUiArguments, TOOL_NAMES, FALLBACK_TOOLS } = require('./hermes-desk-mcp.cjs')
const shimPath = fileURLToPath(new URL('./hermes-desk-mcp.cjs', import.meta.url))
const cleanups = []
afterEach(async () => {
  vi.useRealTimers()
  while (cleanups.length) await cleanups.pop()()
})

async function root() {
  const directory = await mkdtemp('/tmp/hd-mcp-shim-')
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function fakeApp(socketPath, handle = () => ({ content: [{ type: 'text', text: 'fake browser result' }] }),
  tools = FALLBACK_TOOLS.map(tool => tool.name === 'render_ui' ? { ...tool, description: 'live schema' } : tool)) {
  const frames = [], sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = ''
    socket.on('data', data => {
      buffer += data
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        frames.push(frame)
        const result = frame.method === 'hello' ? { protocol: 1, appVersion: 'fake-v1' }
          : frame.method === 'tools/list' ? { tools }
            : handle(frame, socket)
        if (result && frame.id !== undefined) socket.write(JSON.stringify({ id: frame.id, ...(
          result.error ? { error: result.error } : { result }) }) + '\n')
      }
    })
  })
  server.listen(socketPath)
  await once(server, 'listening')
  const close = async () => {
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise(resolve => server.close(resolve))
  }
  cleanups.push(close)
  return { frames, sockets, close }
}

function peer(socketPath, options = {}) {
  const input = new PassThrough(), output = new PassThrough(), stderr = new PassThrough()
  const frames = []
  let buffer = '', diagnostics = ''
  output.on('data', data => {
    buffer += data
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buffer.slice(0, newline)))
      buffer = buffer.slice(newline + 1)
    }
  })
  stderr.on('data', data => { diagnostics += data })
  const shim = createShim({ profile: 'spike-alpha', socketPath, input, output, stderr, ...options })
  cleanups.push(() => shim.close())
  return {
    frames, input,
    send(method, id, params = {}) {
      input.write(JSON.stringify({ jsonrpc: '2.0', method, ...(id === undefined ? {} : { id }), params }) + '\n')
    },
    async reply(id) {
      await vi.waitFor(() => expect(frames.some(frame => frame.id === id)).toBe(true))
      return frames.find(frame => frame.id === id)
    },
    diagnostics: () => diagnostics,
  }
}

describe('dependency-free stdio MCP shim', () => {
  it('pins every standalone browser definition and rejects any mutation of its schema or definition', () => {
    expect(FALLBACK_TOOLS.filter(tool => tool.name !== 'render_ui')).toEqual(listBrowserTools())
    for (const browser of listBrowserTools()) {
      for (const mutate of [
        tool => { tool.inputSchema = { type: 'object', properties: {}, additionalProperties: true } },
        tool => { tool.description = 'untrusted mutation' },
        tool => { tool.unknown = true },
        tool => { tool.inputSchema.properties.evaluate = { type: 'string' } },
      ]) {
        const changed = structuredClone(FALLBACK_TOOLS)
        mutate(changed.find(tool => tool.name === browser.name))
        expect(validTools(changed), browser.name).toBe(false)
      }
    }
  })
  it('rejects catalog additions, duplicates, removals and a relaxed render schema', () => {
    expect(validTools(FALLBACK_TOOLS)).toBe(true)
    expect(validTools([...FALLBACK_TOOLS, { name: 'browser_evaluate', inputSchema: {} }])).toBe(false)
    expect(validTools(FALLBACK_TOOLS.slice(1))).toBe(false)
    expect(validTools([...FALLBACK_TOOLS.slice(0, -1), FALLBACK_TOOLS[0]])).toBe(false)
    expect(validTools(FALLBACK_TOOLS.map(t => t.name === 'render_ui' ? { ...t, inputSchema: { type: 'object', additionalProperties: true } } : t))).toBe(false)
  })

  it('pins standalone render argument validation to the shared contract for every bounded data type', () => {
    const handbook = { type: 'handbook', title: 'Pressure loop', paragraphs: ['The circuit is sealed.'],
      subtitle: 'SYSTEMS DATA', columns: ['Station', 'Value'], rows: [['S-1', 14.7]],
      notice: { level: 'WARNING', text: 'Vent before opening.' } }
    const good = { version: 1, components: [
      { type: 'stat', title: 'Estimate', value: '12', detail: 'Agent data' },
      { type: 'table', title: 'Queue', columns: ['A', 'B'], rows: [['Review', 3]] },
      { type: 'bar_chart', title: 'Work', items: [{ label: 'Review', value: 3 }] },
      { type: 'checklist', title: 'Next', items: [{ id: 'review', label: 'Review', checked: false }] },
      handbook,
    ] }
    const corpus = [good, {}, null, [], { ...good, extra: 'unknown' },
      ...[0, 5].map(n => ({ ...good, components: Array(n).fill(good.components[0]) })),
      ...['<script>', 'javascript:alert(1)', 'https://evil.invalid', 'a'.repeat(81), '\u202e', '\u0085', '\u061c',
        '\u200b', '\u200f', '\u2028', '\u2029', '\u2060', '\ufeff', 'Profile: alpha', 'Metadata: 3'].map(value => ({
        version: 1, components: [{ type: 'stat', title: 'Bad', value }],
      })),
      { version: 1, components: [{ type: 'bar_chart', title: 'Bad', items: [{ label: 'A', value: Infinity }] }] },
      { version: 1, components: [{ ...handbook, columns: ['Station'] }] },
      { version: 1, components: [{ ...handbook, rows: [['S-1']] }] },
      { version: 1, components: [{ ...handbook, columns: ['Station'], rows: [['S-1', 'extra']] }] },
      { version: 1, components: [{ ...handbook, notice: { level: 'danger', text: 'Unbounded.' } }] },
    ]
    for (const args of corpus) expect(validRenderUiArguments(args)).toBe(parseGenUi(args) !== null)
  })

  it('preserves exactly ten browser actions and adds only the strictly bounded render_ui catalog', async () => {
    const client = peer(path.join(await root(), 'missing.sock'))
    client.send('tools/list', 101)
    const tools = (await client.reply(101)).result.tools
    expect(tools.map(t => t.name).sort()).toEqual([...ACTIONS, 'render_ui'].sort())
    expect(tools.filter(t => t.name !== 'render_ui').map(t => t.name).sort()).toEqual([...ACTIONS].sort())
    expect(tools.find(t => t.name === 'render_ui').inputSchema).toEqual(GENUI_INPUT_SCHEMA)
  })

  it('forwards only valid data to the authenticated profile socket and retains full structured output', async () => {
    const socketPath = path.join(await root(), 'app.sock')
    const args = { version: 1, components: [{ type: 'stat', title: 'Estimate', value: '12' }] }
    const result = { content: [{ type: 'text', text: JSON.stringify({ genui: args }) }], structuredContent: { genui: args }, isError: false }
    const app = await fakeApp(socketPath, () => result)
    const client = peer(socketPath, { token: 'obviously-fake-profile-token' })
    client.send('tools/call', 102, { name: 'render_ui', arguments: args })
    expect((await client.reply(102)).result).toEqual(result)
    expect(app.frames[0]).toMatchObject({ method: 'hello', params: {
      profile: 'spike-alpha', token: 'obviously-fake-profile-token',
    } })
    expect(app.frames[1]).toMatchObject({ method: 'tools/call', params: { profile: 'spike-alpha', name: 'render_ui', arguments: args } })
    for (const [index, bad] of [
      { ...args, onclick: 'fetch()' }, { version: 1, components: [{ type: 'html', html: '<script>bad</script>' }] },
      { version: 1, components: [{ type: 'stat', title: 'Bad', value: 'https://evil.invalid' }] },
      { version: 1, components: [{ type: 'table', title: 'Ragged', columns: ['A'], rows: [['a', 'b']] }] },
      { version: 1, components: [{ type: 'checklist', title: 'Duplicate', items: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }] },
    ].entries()) {
      expect(parseGenUi(bad)).toBeNull()
      client.send('tools/call', 110 + index, { name: 'render_ui', arguments: bad })
      expect((await client.reply(110 + index)).result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^bad_args:/) }] })
    }
    expect(app.frames.filter(frame => frame.method === 'tools/call')).toHaveLength(1)
  })

  it.each(['2025-06-18', '2025-03-26', '2024-11-05', '2025-11-25'])(
    'negotiates %s offline without connecting until tools are requested', async version => {
      const socketPath = path.join(await root(), 'app.sock')
      const app = await fakeApp(socketPath)
      const client = peer(socketPath)
      client.send('initialize', 1, { protocolVersion: version, capabilities: {}, clientInfo: { name: 'fake', version: '1' } })
      const reply = await client.reply(1)
      expect(reply.result.protocolVersion).toBe(version === '2025-11-25' ? '2025-06-18' : version)
      expect(reply.result.capabilities.tools).toEqual({ listChanged: false })
      client.send('notifications/initialized')
      client.send('ping', 2)
      expect((await client.reply(2)).result).toEqual({})
      expect(app.frames).toEqual([])
    })

  it('lists all tools offline and returns model-visible app_unavailable errors', async () => {
    const client = peer(path.join(await root(), 'missing.sock'))
    client.send('tools/list', 1)
    expect((await client.reply(1)).result.tools.map(tool => tool.name)).toEqual(TOOL_NAMES)
    client.send('tools/call', 2, { name: 'browser_snapshot' })
    expect((await client.reply(2)).result).toEqual({
      content: [{ type: 'text', text: 'app_unavailable: Hermes Desk is not running' }], isError: true,
    })
    expect(client.diagnostics()).toBe('')
  })

  it('sends hello first, forwards exact arguments, images and profile-scoped live schemas', async () => {
    const socketPath = path.join(await root(), 'app.sock')
    const result = { content: [{ type: 'text', text: 'fake image' }, { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }] }
    const app = await fakeApp(socketPath, () => result)
    const client = peer(socketPath)
    client.send('tools/list', 1)
    const live = (await client.reply(1)).result.tools
    expect(live.filter(tool => tool.name !== 'render_ui')).toEqual(listBrowserTools())
    expect(live.find(tool => tool.name === 'render_ui').description).toBe('live schema')
    client.send('tools/call', 'call', { name: 'browser_type', arguments: { ref: '@e2', text: 'obviously-fake-input' } })
    expect((await client.reply('call')).result).toEqual(result)
    expect(app.frames[0]).toMatchObject({ method: 'hello', params: { profile: 'spike-alpha', pid: process.pid, shimVersion: '1.0.0' } })
    expect(app.frames[1]).toMatchObject({ method: 'tools/list', params: { profile: 'spike-alpha' } })
    expect(app.frames[2]).toMatchObject({ method: 'tools/call', params: {
      profile: 'spike-alpha', name: 'browser_type', arguments: { ref: '@e2', text: 'obviously-fake-input' },
      callId: expect.stringMatching(/^hd:/),
    } })
  })

  it('discards an authenticated live catalog with a changed browser schema, without widening dispatch', async () => {
    const socketPath = path.join(await root(), 'app.sock')
    const changed = structuredClone(FALLBACK_TOOLS)
    changed.find(tool => tool.name === 'browser_navigate').inputSchema = { type: 'object', additionalProperties: true }
    const app = await fakeApp(socketPath, undefined, changed)
    const client = peer(socketPath)
    client.send('tools/list', 1)
    expect((await client.reply(1)).result.tools).toEqual(listTools())
    expect(app.frames[0].method).toBe('hello')
    client.send('tools/call', 2, { name: 'browser_evaluate', arguments: { script: 'untrusted' } })
    expect((await client.reply(2)).result.isError).toBe(true)
    expect(app.frames.filter(frame => frame.method === 'tools/call')).toEqual([])
  })

  it('routes concurrent out-of-order replies by call id and converts typed socket errors', async () => {
    const socketPath = path.join(await root(), 'app.sock')
    let first
    const app = await fakeApp(socketPath, (frame, socket) => {
      if (frame.params.name === 'browser_click') { first = { frame, socket }; return }
      first.socket.write(JSON.stringify({ id: first.frame.id, error: { code: 'user_took_control', message: 'User took control' } }) + '\n')
      return { content: [{ type: 'text', text: 'second finished first' }] }
    })
    const client = peer(socketPath)
    client.send('tools/call', 1, { name: 'browser_click', arguments: { ref: '@e1' } })
    await vi.waitFor(() => expect(first).toBeDefined())
    client.send('tools/call', '1', { name: 'browser_tabs' })
    expect((await client.reply('1')).result.content[0].text).toBe('second finished first')
    expect((await client.reply(1)).result).toMatchObject({ isError: true, content: [{ text: 'user_took_control: User took control' }] })
    const calls = app.frames.filter(frame => frame.method === 'tools/call')
    expect(new Set(calls.map(frame => frame.params.callId)).size).toBe(2)
  })

  it('forwards cancellation and ignores late responses without breaking later calls', async () => {
    const socketPath = path.join(await root(), 'app.sock')
    const app = await fakeApp(socketPath, frame => frame.method === 'cancel' ? undefined
      : frame.params.name === 'browser_click' ? undefined : { content: [{ type: 'text', text: 'still works' }] })
    const client = peer(socketPath)
    client.send('tools/call', 5, { name: 'browser_click', arguments: { ref: '@e1' } })
    await vi.waitFor(() => expect(app.frames.some(frame => frame.method === 'tools/call')).toBe(true))
    const call = app.frames.find(frame => frame.method === 'tools/call')
    client.send('notifications/cancelled', undefined, { requestId: 5, reason: 'stop' })
    expect((await client.reply(5)).result.isError).toBe(true)
    await vi.waitFor(() => expect(app.frames.at(-1)).toEqual({ method: 'cancel',
      params: { profile: 'spike-alpha', callId: call.params.callId } }))
    for (const socket of app.sockets) socket.write(JSON.stringify({ id: call.id, result: { content: [] } }) + '\n')
    client.send('tools/call', 6, { name: 'browser_tabs' })
    expect((await client.reply(6)).result.content[0].text).toBe('still works')
    expect(client.frames.filter(frame => frame.id === 5)).toHaveLength(1)
  })

  it('bounds every tool call to 90 seconds and cancels timed-out app work', async () => {
    const socketPath = path.join(await root(), 'app.sock')
    const app = await fakeApp(socketPath, () => undefined)
    const client = peer(socketPath)
    client.send('tools/list', 1)
    await client.reply(1)
    vi.useFakeTimers()
    client.send('tools/call', 2, { name: 'browser_snapshot' })
    await vi.waitFor(() => expect(app.frames.some(frame => frame.method === 'tools/call')).toBe(true))
    await vi.advanceTimersByTimeAsync(90000)
    expect(client.frames.find(frame => frame.id === 2).result).toMatchObject({
      isError: true, content: [{ text: 'timeout: Hermes Desk tool call exceeded 90 seconds' }],
    })
    vi.useRealTimers()
    await vi.waitFor(() => expect(app.frames.some(frame => frame.method === 'cancel')).toBe(true))
  })

  it('reconnects after app restart, never replays in-flight actions', async () => {
    const socketPath = path.join(await root(), 'app.sock')
    const app = await fakeApp(socketPath, () => undefined)
    const client = peer(socketPath)
    client.send('tools/call', 1, { name: 'browser_click', arguments: { ref: '@e1' } })
    await vi.waitFor(() => expect(app.frames.some(frame => frame.method === 'tools/call')).toBe(true))
    await app.close()
    expect((await client.reply(1)).result.content[0].text).toBe('app_unavailable: Hermes Desk is not running')
    const restarted = await fakeApp(socketPath)
    client.send('tools/call', 2, { name: 'browser_tabs' })
    expect((await client.reply(2)).result.isError).not.toBe(true)
    expect(restarted.frames.map(frame => frame.method)).toEqual(['hello', 'tools/call'])
  })

  it('cancels during hello without dispatching the action', async () => {
    const socketPath = path.join(await root(), 'app.sock')
    const sockets = []
    const server = net.createServer(socket => { sockets.push(socket); socket.on('error', () => {}) })
    server.listen(socketPath)
    await once(server, 'listening')
    cleanups.push(async () => { sockets.forEach(socket => socket.destroy()); await new Promise(resolve => server.close(resolve)) })
    const client = peer(socketPath)
    client.send('tools/call', 1, { name: 'browser_click' })
    client.send('notifications/cancelled', undefined, { requestId: 1 })
    expect((await client.reply(1)).result.content[0].text).toMatch(/^cancelled:/)
    expect(client.frames.filter(frame => frame.id === 1)).toHaveLength(1)
  })

  it('returns protocol errors only for malformed frames and unknown methods', async () => {
    const client = peer(path.join(await root(), 'missing.sock'))
    client.input.write('{broken\n')
    expect((await client.reply(null)).error.code).toBe(-32700)
    client.send('does/not/exist', 2)
    expect((await client.reply(2)).error.code).toBe(-32601)
    client.send('tools/call', 3, { name: 'browser_evaluate' })
    expect((await client.reply(3)).result.isError).toBe(true)
    client.send('tools/call', 4, { name: 'browser_snapshot', arguments: [] })
    expect((await client.reply(4)).result.content[0].text).toMatch(/^bad_args:/)
  })

  it('rejects invalid CLI profiles and nonabsolute sockets', () => {
    expect(parseArgs(['--profile', 'default', '--socket', '/tmp/fake.sock'])).toEqual({ profile: 'default', socketPath: '/tmp/fake.sock' })
    expect(() => parseArgs(['--bad', 'value'])).toThrow('Usage')
    expect(() => createShim({ profile: '../default', socketPath: '/tmp/fake' })).toThrow()
    expect(() => createShim({ profile: 'default', socketPath: 'relative' })).toThrow()
  })

  it.each(['node', 'electron'])('runs standalone under %s with protocol-only stdout and clean EOF shutdown', async runtime => {
    const directory = await root()
    const copied = path.join(directory, 'hermes-desk-mcp.cjs')
    await copyFile(shimPath, copied)
    const executable = runtime === 'electron' ? require('electron') : process.execPath
    const child = spawn(executable, [copied, '--profile', 'default', '--socket', path.join(directory, 'missing.sock')],
      { env: { PATH: '/usr/bin:/bin', HOME: directory, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    cleanups.push(() => { if (child.exitCode === null) child.kill('SIGTERM') })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
    await vi.waitFor(() => expect(stdout.trim().split('\n')).toHaveLength(2))
    const exited = once(child, 'exit')
    child.stdin.end()
    expect((await exited)[0]).toBe(0)
    expect(stdout.trim().split('\n').map(line => JSON.parse(line).jsonrpc)).toEqual(['2.0', '2.0'])
    const standalone = JSON.parse(stdout.trim().split('\n')[1]).result.tools
    expect(standalone.map(tool => tool.name)).toEqual(TOOL_NAMES)
    expect(standalone.filter(tool => tool.name !== 'render_ui')).toEqual(listBrowserTools())
    expect(JSON.parse(stdout.trim().split('\n')[1]).result.tools.find(tool => tool.name === 'render_ui').inputSchema).toEqual(GENUI_INPUT_SCHEMA)
    expect(stderr).toBe('')
  })

  it('uses the sibling tools catalog when present at runtime', async () => {
    const directory = await root()
    const shimDir = path.join(directory, 'shim')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(shimDir)
    await copyFile(shimPath, path.join(shimDir, 'hermes-desk-mcp.cjs'))
    await writeFile(path.join(directory, 'tools.cjs'), `module.exports = { TOOLS: ${JSON.stringify(FALLBACK_TOOLS.map(tool => ({
      ...tool, description: tool.name === 'render_ui' ? 'bundled catalog' : tool.description,
    })))} }\n`)
    const catalog = require(path.join(shimDir, 'hermes-desk-mcp.cjs')).loadTools()
    expect(catalog.filter(tool => tool.name !== 'render_ui')).toEqual(listBrowserTools())
    expect(catalog.find(tool => tool.name === 'render_ui').description).toBe('bundled catalog')
  })

  it('HD-06 forwards the environment token only on hello, never in MCP output or diagnostics', async () => {
    const token = 'b'.repeat(64)
    vi.stubEnv('HERMES_DESK_MCP_TOKEN', token)
    try {
      const socketPath = path.join(await root(), 'app.sock')
      const app = await fakeApp(socketPath)
      const client = peer(socketPath)
      client.send('tools/list', 1)
      await client.reply(1)
      client.send('tools/call', 2, { name: 'browser_tabs' })
      await client.reply(2)
      expect(app.frames[0].params.token).toBe(token)
      expect(app.frames.slice(1).every(frame => !Object.hasOwn(frame.params, 'token'))).toBe(true)
      expect(JSON.stringify(client.frames)).not.toContain(token)
      expect(client.diagnostics()).not.toContain(token)
    } finally { vi.unstubAllEnvs() }
  })

  it('HD-07 preserves typed aggregate admission errors as tool content, retaining offline discovery', async () => {
    const socketPath = path.join(await root(), 'app.sock')
    const server = net.createServer(socket => {
      socket.on('error', () => {})
      socket.end(JSON.stringify({ id: null, error: { code: 'resource_limit', message: 'Connection limit reached' } }) + '\n')
      socket.once('finish', () => socket.destroy())
    })
    await new Promise(resolve => server.listen(socketPath, resolve))
    cleanups.push(() => new Promise(resolve => server.close(resolve)))
    const client = peer(socketPath)
    client.send('tools/call', 1, { name: 'browser_tabs' })
    expect((await client.reply(1)).result).toEqual({
      isError: true, content: [{ type: 'text', text: 'resource_limit: Hermes Desk MCP resource limit reached' }],
    })
    client.send('tools/list', 2)
    expect((await client.reply(2)).result.tools.map(tool => tool.name)).toEqual(TOOL_NAMES)
  })

  it('J3 bounds stdin frames and partial lifetimes without echoing rejected content', async () => {
    const socketPath = path.join(await root(), 'missing.sock')
    const large = peer(socketPath, { maxFrameBytes: 256 })
    large.input.write('OBVIOUSLY_FAKE_SECRET'.repeat(50))
    expect((await large.reply(null)).error.message).toBe('MCP frame limit reached')
    large.send('ping', 1)
    expect(large.frames.some(frame => frame.id === 1)).toBe(false)
    const partial = peer(socketPath, { partialFrameTimeoutMs: 10 })
    partial.input.write('{"jsonrpc":')
    expect((await partial.reply(null)).error.message).toBe('Incomplete MCP frame timed out')
    expect(JSON.stringify(large.frames)).not.toContain('OBVIOUSLY_FAKE_SECRET')
    const invalid = peer(socketPath)
    invalid.input.write(Buffer.from([0xff, 10]))
    expect((await invalid.reply(null)).error.code).toBe(-32700)
    const batch = peer(socketPath, { maxFrameBytes: 256, maxRequests: 1 })
    batch.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'.repeat(10))
    expect((await batch.reply(null)).error.message).toBe('MCP input batch limit reached')
  })

  it('J3 bounds pending discovery and calls while keeping cancellation available under pressure', async () => {
    const socketPath = path.join(await root(), 'app.sock')
    const app = await fakeApp(socketPath, () => undefined)
    const client = peer(socketPath, { maxRequests: 1 })
    client.send('tools/call', 1, { name: 'browser_snapshot' })
    await vi.waitFor(() => expect(app.frames.some(frame => frame.method === 'tools/call')).toBe(true))
    client.send('tools/list', 2)
    expect((await client.reply(2)).error.code).toBe(-32000)
    client.send('tools/call', 3, { name: 'browser_tabs' })
    expect((await client.reply(3)).result.content[0].text).toMatch(/^resource_limit:/)
    client.send('notifications/cancelled', undefined, { requestId: 1 })
    expect((await client.reply(1)).result.content[0].text).toMatch(/^cancelled:/)
    expect(app.frames.filter(frame => frame.method === 'tools/call')).toHaveLength(1)
  })

  it('J3 respects stdout backpressure and closes rather than buffering unlimited replies', async () => {
    const input = new PassThrough()
    const writes = []
    const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
      writes.push({ chunk: chunk.toString(), callback })
    } })
    const shim = createShim({ profile: 'default', socketPath: path.join(await root(), 'missing.sock'),
      input, output, maxOutputBytes: 80 })
    cleanups.push(() => shim.close())
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
    expect(input.isPaused()).toBe(true)
    writes[0].callback()
    await vi.waitFor(() => expect(input.isPaused()).toBe(false))
    // A single delivered chunk may exceed the output budget despite pause.
    input.write([2, 3, 4, 5].map(id => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })).join('\n') + '\n')
    expect(output.writableLength).toBeLessThanOrEqual(80)
    expect(input.isPaused()).toBe(true)
    writes.at(-1).callback()
  })
  it('J3 reserves request IDs and capacity for discovery while hello is stalled', async () => {
    const socketPath = path.join(await root(), 'app.sock')
    const sockets = new Set()
    const server = net.createServer(socket => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise(resolve => server.listen(socketPath, resolve))
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    })
    const client = peer(socketPath, { maxRequests: 2 })
    client.send('tools/list', 1)
    client.send('tools/list', 2)
    client.send('tools/list', 1)
    expect((await client.reply(1)).error.code).toBe(-32600)
    client.send('tools/list', 3)
    expect((await client.reply(3)).error.code).toBe(-32000)
  })
})
