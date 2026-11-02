'use strict'

const net = require('node:net')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')

const SHIM_VERSION = '1.0.0'
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const BROWSER_TOOL_NAMES = [
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press',
  'browser_scroll', 'browser_screenshot', 'browser_back', 'browser_tabs', 'browser_tab_activate',
]
const TOOL_NAMES = [...BROWSER_TOOL_NAMES, 'render_ui']
// This file alone is asar-unpacked and may run under system Node. Keep the
// fallback data contract inline; parity tests pin it to the shared app parser.
const textSchema = maxLength => ({ type: 'string', minLength: 1, maxLength })
const objectSchema = (properties, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, properties, required,
})
const arraySchema = (items, maxItems, minItems = 1) => ({ type: 'array', items, minItems, maxItems })
const titleSchema = textSchema(80)
// A cell holds a data value, not prose. Shared by table rows and handbook data rows.
const cellSchema = { oneOf: [textSchema(160), { type: 'number', minimum: -1e12, maximum: 1e12 }] }
const RENDER_UI_SCHEMA = objectSchema({
  version: { const: 1 },
  components: arraySchema({ oneOf: [
    objectSchema({ type: { const: 'stat' }, title: titleSchema, value: textSchema(80), detail: textSchema(160) }, ['type', 'title', 'value']),
    objectSchema({ type: { const: 'table' }, title: titleSchema, columns: arraySchema(textSchema(60), 6),
      rows: arraySchema(arraySchema(cellSchema, 6), 20, 0) }),
    objectSchema({ type: { const: 'bar_chart' }, title: titleSchema, items: arraySchema(objectSchema({
      label: textSchema(80), value: { type: 'number', minimum: 0, maximum: 1_000_000_000_000 },
    }), 12), unit: textSchema(40) }, ['type', 'title', 'items']),
    objectSchema({ type: { const: 'checklist' }, title: titleSchema, items: arraySchema(objectSchema({
      id: { ...textSchema(40), pattern: '^[a-zA-Z0-9_-]+$' }, label: textSchema(160), checked: { type: 'boolean' },
    }, ['id', 'label']), 20) }),
    // An Apollo-era paperwork page, as data. Mirrors the shared app parser: paragraphs are
    // numbered by the renderer; nothing here carries styling.
    objectSchema({ type: { const: 'handbook' }, title: titleSchema, subtitle: textSchema(120),
      paragraphs: arraySchema(textSchema(400), 8),
      columns: arraySchema(textSchema(40), 4), rows: arraySchema(arraySchema(cellSchema, 4), 12, 0),
      notice: objectSchema({ level: { oneOf: [{ const: 'NOTE' }, { const: 'CAUTION' }, { const: 'WARNING' }] },
        text: textSchema(300) }),
    }, ['type', 'title', 'paragraphs']),
  ] }, 4),
})
// Exact original browser contract. Standalone Node cannot import the app's
// Electron/ESM catalog; tests pin every definition, not just the ten names.
const LANE_NOTICE = 'Acts in your own isolated browser lane in Hermes Desk. The user can take over at any time. Secrets must be typed as {{secret:<label>}} placeholders, never literal credentials.'
const definitions = [
  ['browser_navigate', 'Navigate to a URL. Returns the page URL and title; use browser_snapshot for element refs.', {
    url: { type: 'string', description: "The URL to navigate to (e.g., 'https://example.com')" },
  }, ['url']],
  ['browser_snapshot', 'Get a redacted accessibility snapshot of the current page, with element refs such as @e1 for clicking and typing.', {
    full: { type: 'boolean', description: 'Request complete page content rather than the compact interactive view.', default: false },
  }, []],
  ['browser_click', 'Click an element identified by its ref from browser_snapshot.', {
    ref: { type: 'string', description: "The element reference from the snapshot (e.g., '@e5', '@e12')" },
  }, ['ref']],
  ['browser_type', 'Type into an input identified by its snapshot ref. Use a secret placeholder for sensitive fields; the value stays in the app.', {
    ref: { type: 'string', description: "The element reference from the snapshot (e.g., '@e3')" },
    text: { type: 'string', description: 'The text to type into the field' },
  }, ['ref', 'text']],
  ['browser_press', 'Press a keyboard key, for example Enter, Tab, Escape, or ArrowDown.', {
    key: { type: 'string', description: "Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown')" },
  }, ['key']],
  ['browser_scroll', 'Scroll the current page to reveal more content.', {
    direction: { type: 'string', enum: ['up', 'down'], description: 'Direction to scroll' },
  }, ['direction']],
  ['browser_screenshot', 'Capture a redacted JPEG of the current viewport. Sensitive fields are masked before the image leaves the app.', {}, []],
  ['browser_back', 'Navigate back to the previous page in browser history.', {}, []],
  ['browser_tabs', 'List only your lane’s tabs, with their IDs, URLs, titles, and active state.', {}, []],
  ['browser_tab_activate', 'Activate a tab in your own lane without stealing the user’s visible browser focus.', {
    id: { type: 'string', description: 'The tab ID returned by browser_tabs' },
  }, ['id']],
]
const browserTools = definitions.map(([name, description, properties, required]) => ({
  name, description: `${description} ${LANE_NOTICE}`,
  inputSchema: { type: 'object', properties, required },
}))
const FALLBACK_TOOLS = [...browserTools, {
  name: 'render_ui',
  description: 'Display bounded Generated UI: agent-provided, unverified data only. Stat, table, bar_chart or checklist; no HTML, CSS, JavaScript, URLs or actions. Local checklist notes are never sent to the agent. Requires an explicitly enabled profile and a running Hermes Desk; user stop/takeover applies.',
  inputSchema: RENDER_UI_SCHEMA,
}]
const unavailable = () => Object.assign(new Error('Hermes Desk is not running'), { code: 'app_unavailable' })
const toolError = (code, message) => ({ content: [{ type: 'text', text: `${code}: ${message}` }], isError: true })
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function loadTools() {
  try {
    const catalog = require('../tools.cjs')
    const tools = Array.isArray(catalog) ? catalog
      : (typeof catalog.listTools === 'function' ? catalog.listTools() : catalog.TOOLS || catalog.tools)
    if (validTools(tools)) return tools
  } catch {
    // Packaged shims are standalone, so the app's richer catalog may not be beside them.
  }
  return FALLBACK_TOOLS
}

function validTools(tools) {
  return Array.isArray(tools) && tools.length === TOOL_NAMES.length &&
    TOOL_NAMES.every(name => tools.filter(tool => tool?.name === name && isObject(tool.inputSchema)).length === 1) &&
    browserTools.every(expected => isDeepStrictEqual(tools.find(tool => tool.name === expected.name), expected)) &&
    isDeepStrictEqual(tools.find(tool => tool.name === 'render_ui').inputSchema, RENDER_UI_SCHEMA)
}

const unsafeDataText = /[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|\b(?:https?|file|data|javascript|vbscript):|(?:^|\s)\/\/[a-z0-9]/iu
function matchesDataSchema(value, schema) {
  if (schema.oneOf) return schema.oneOf.filter(s => matchesDataSchema(value, s)).length === 1
  if (Object.hasOwn(schema, 'const')) return value === schema.const
  if (schema.type === 'string') return typeof value === 'string' && !!value.trim() &&
    value.length >= schema.minLength && value.length <= schema.maxLength &&
    !unsafeDataText.test(value) && (!schema.pattern || new RegExp(schema.pattern).test(value))
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value) &&
    value >= schema.minimum && value <= schema.maximum
  if (schema.type === 'boolean') return typeof value === 'boolean'
  if (schema.type === 'array') return Array.isArray(value) && value.length >= schema.minItems &&
    value.length <= schema.maxItems && Object.keys(value).length === value.length &&
    value.every(v => matchesDataSchema(v, schema.items))
  if (schema.type === 'object') {
    if (!isObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return Reflect.ownKeys(value).length === Object.keys(value).length &&
      schema.required.every(key => Object.hasOwn(value, key)) &&
      Object.keys(value).every(key => Object.hasOwn(schema.properties, key) &&
        Object.hasOwn(descriptors[key], 'value') && matchesDataSchema(descriptors[key].value, schema.properties[key]))
  }
  return false
}
function validRenderUiArguments(args) {
  try {
    if (!matchesDataSchema(args, RENDER_UI_SCHEMA) || Buffer.byteLength(JSON.stringify(args)) > 16_384) return false
    return args.components.every(component =>
      (component.type !== 'table' || component.rows.every(row => row.length === component.columns.length)) &&
      (component.type !== 'handbook' || (
        (component.rows === undefined) === (component.columns === undefined) &&
        (component.rows === undefined || component.rows.every(row => row.length === component.columns.length)))) &&
      (component.type !== 'checklist' || new Set(component.items.map(item => item.id)).size === component.items.length))
  } catch { return false }
}

function abortable(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

class AppSocket {
  constructor({ profile, socketPath, token, connectTimeoutMs = 2000 }) {
    this.profile = profile
    this.token = token
    this.socketPath = socketPath
    this.connectTimeoutMs = connectTimeoutMs
    this.nextId = 1
    this.pending = new Map()
    this.socket = null
    this.connecting = null
    this.ready = false
    this.closed = false
    this.connectionError = null
  }

  async connect(signal) {
    if (this.closed) throw unavailable()
    if (!this.ready && !this.connecting) {
      this.connecting = this.open().finally(() => { this.connecting = null })
    }
    await abortable(this.ready ? Promise.resolve() : this.connecting, signal)
  }

  async open() {
    const socket = net.createConnection({ path: this.socketPath })
    this.socket = socket
    this.connectionError = null
    socket.setEncoding('utf8')
    let buffer = ''
    const fail = (error = unavailable()) => {
      if (this.socket === socket) {
        this.connectionError = error
        this.ready = false
        this.socket = null
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
      }
      socket.destroy()
    }
    socket.on('error', () => fail())
    socket.on('close', () => fail())
    socket.on('data', chunk => {
      buffer += chunk
      // Screenshots may exceed 1 MB; cap corrupt or unbounded app frames at 32 MB.
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) return fail()
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        let frame
        try { frame = JSON.parse(line) } catch { fail(); return }
        if (frame?.id === null && frame.error && ['resource_limit', 'timeout'].includes(frame.error.code)) {
          fail(Object.assign(new Error(frame.error.code === 'resource_limit'
            ? 'Hermes Desk MCP resource limit reached' : 'Hermes Desk MCP connection timed out'), { code: frame.error.code }))
          return
        }
        const pending = this.pending.get(frame?.id)
        if (!pending) continue
        this.pending.delete(frame.id)
        if (frame.error) {
          const code = typeof frame.error.code === 'string' ? frame.error.code : 'app_unavailable'
          pending.reject(Object.assign(new Error(frame.error.message || 'Hermes Desk rejected the request'), { code }))
        } else if (Object.hasOwn(frame, 'result')) pending.resolve(frame.result)
        else pending.reject(unavailable())
      }
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(unavailable()), this.connectTimeoutMs)
    try {
      await abortable(new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', () => reject(unavailable()))
        socket.once('close', () => reject(unavailable()))
      }), controller.signal)
      const hello = await this.request('hello', {
        profile: this.profile, token: this.token, shimVersion: SHIM_VERSION, pid: process.pid,
      }, controller.signal)
      if (hello?.protocol !== 1 || socket.destroyed || this.closed) throw unavailable()
      this.ready = true
    } catch (error) {
      fail()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  request(method, params, signal, onSent) {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const socket = this.socket
    if (!socket || socket.destroyed) return Promise.reject(this.connectionError || unavailable())
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', abort)
      }
      const abort = () => { cleanup(); reject(signal.reason) }
      this.pending.set(id, {
        resolve: result => { cleanup(); resolve(result) },
        reject: error => { cleanup(); reject(error) },
      })
      signal?.addEventListener('abort', abort, { once: true })
      const line = JSON.stringify({ id, method, params }) + '\n'
      if (socket.writableLength + Buffer.byteLength(line) > 1024 * 1024) {
        cleanup()
        reject(Object.assign(new Error('Hermes Desk MCP resource limit reached'), { code: 'resource_limit' }))
        return
      }
      socket.write(line)
      onSent?.()
    })
  }

  cancel(callId) {
    if (this.ready && this.socket && !this.socket.destroyed) {
      this.socket.write(JSON.stringify({ method: 'cancel', params: { profile: this.profile, callId } }) + '\n')
    }
  }

  close() {
    this.closed = true
    this.ready = false
    this.socket?.destroy()
  }
}

function createShim({ profile, socketPath, input = process.stdin, output = process.stdout,
  token = process.env.HERMES_DESK_MCP_TOKEN, stderr = process.stderr,
  timeoutMs = 90000, connectTimeoutMs = 2000, tools = loadTools(),
  maxFrameBytes = 64 * 1024, maxRequests = 32, maxOutputBytes = 16 * 1024 * 1024,
  partialFrameTimeoutMs = 5000 }) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile || '') || !path.isAbsolute(socketPath || '')) {
    throw new Error('Expected --profile <profile-name> and --socket <absolute-path>')
  }
  const app = new AppSocket({ profile, socketPath, token, connectTimeoutMs })
  const active = new Map()
  const requests = new Set()
  let sequence = 0
  let stopped = false
  let buffer = Buffer.alloc(0)
  let partialTimer
  let outputBytes = 0
  let blocked = false
  const send = frame => {
    if (stopped) return
    const line = JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n'
    const bytes = Buffer.byteLength(line)
    if (outputBytes + bytes > maxOutputBytes) { close(); return }
    outputBytes += bytes
    try {
      if (!output.write(line, () => { outputBytes -= bytes })) {
        blocked = true
        input.pause()
      }
    } catch { close() }
  }
  const rpcError = (id, code, message) => send({ id, error: { code, message } })

  async function listTools() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(unavailable()), connectTimeoutMs * 2)
    try {
      await app.connect(controller.signal)
      const result = await app.request('tools/list', { profile }, controller.signal)
      if (validTools(result?.tools)) return { tools: result.tools }
    } catch {
      // The MCP handshake and discovery must still work while the desktop app is closed.
    } finally {
      clearTimeout(timer)
    }
    return { tools }
  }

  async function callTool(frame) {
    const params = frame.params || {}
    if (!TOOL_NAMES.includes(params.name) || (params.arguments !== undefined && !isObject(params.arguments)) ||
        (params.name === 'render_ui' && !validRenderUiArguments(params.arguments))) {
      return toolError('bad_args', 'Unknown tool or invalid arguments')
    }
    const controller = new AbortController()
    const callId = `hd:${process.pid}:${++sequence}`
    const operation = {
      sent: false,
      abort(code, message) {
        if (controller.signal.aborted) return
        if (operation.sent) app.cancel(callId)
        controller.abort(Object.assign(new Error(message), { code }))
      },
    }
    active.set(frame.id, operation)
    const timer = setTimeout(() => operation.abort('timeout', 'Hermes Desk tool call exceeded 90 seconds'), timeoutMs)
    try {
      await app.connect(controller.signal)
      const result = await app.request('tools/call', {
        profile, name: params.name, arguments: params.arguments || {}, callId,
      }, controller.signal, () => { operation.sent = true })
      if (!isObject(result) || !Array.isArray(result.content)) throw unavailable()
      return result
    } catch (error) {
      const code = typeof error.code === 'string' ? error.code : 'app_unavailable'
      return toolError(code, code === 'app_unavailable' ? 'Hermes Desk is not running' : error.message)
    } finally {
      clearTimeout(timer)
      active.delete(frame.id)
    }
  }

  async function handle(line) {
    if (stopped) return
    let frame
    try { frame = JSON.parse(line) } catch { rpcError(null, -32700, 'Parse error'); return }
    if (!isObject(frame) || frame.jsonrpc !== '2.0' || typeof frame.method !== 'string' ||
        (Object.hasOwn(frame, 'id') && typeof frame.id !== 'string' && !Number.isFinite(frame.id)) ||
        (typeof frame.id === 'string' && frame.id.length > 256) ||
        (frame.params !== undefined && !isObject(frame.params))) {
      rpcError(null, -32600, 'Invalid Request')
      return
    }
    if (!Object.hasOwn(frame, 'id')) {
      if (frame.method === 'notifications/cancelled') {
        active.get(frame.params?.requestId)?.abort('cancelled', 'Tool call was cancelled')
      }
      return
    }
    if (requests.has(frame.id)) { rpcError(frame.id, -32600, 'Request id is already in use'); return }
    if (requests.size >= maxRequests) {
      if (frame.method === 'tools/call') send({ id: frame.id,
        result: toolError('resource_limit', 'Hermes Desk MCP resource limit reached') })
      else rpcError(frame.id, -32000, 'Hermes Desk MCP resource limit reached')
      return
    }
    requests.add(frame.id)
    try {
      let result
      switch (frame.method) {
        case 'initialize':
          if (typeof frame.params?.protocolVersion !== 'string') {
            rpcError(frame.id, -32602, 'protocolVersion is required')
            return
          }
          result = {
            protocolVersion: PROTOCOL_VERSIONS.includes(frame.params.protocolVersion)
              ? frame.params.protocolVersion : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'hermes-desk', version: SHIM_VERSION },
          }
          break
        case 'ping': result = {}; break
        case 'tools/list': result = await listTools(); break
        case 'tools/call': result = await callTool(frame); break
        default: rpcError(frame.id, -32601, 'Method not found'); return
      }
      send({ id: frame.id, result })
    } finally { requests.delete(frame.id) }
  }

  function data(chunk) {
    if (stopped) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (bytes.length > maxFrameBytes * maxRequests) {
      rpcError(null, -32600, 'MCP input batch limit reached')
      close()
      return
    }
    let start = 0
    while (start < bytes.length && !stopped) {
      const end = bytes.indexOf(10, start)
      const part = bytes.subarray(start, end < 0 ? bytes.length : end)
      if (buffer.length + part.length > maxFrameBytes) {
        rpcError(null, -32600, 'MCP frame limit reached')
        close()
        return
      }
      buffer = Buffer.concat([buffer, part])
      if (end < 0) {
        if (!partialTimer) {
          partialTimer = setTimeout(() => { rpcError(null, -32600, 'Incomplete MCP frame timed out'); close() }, partialFrameTimeoutMs)
          partialTimer.unref?.()
        }
        return
      }
      clearTimeout(partialTimer)
      partialTimer = undefined
      let line
      try { line = new TextDecoder('utf-8', { fatal: true }).decode(buffer) } catch {
        rpcError(null, -32700, 'Invalid UTF-8')
        close()
        return
      }
      buffer = Buffer.alloc(0)
      if (line.trim()) void handle(line).catch(() => {
        if (!stopped) {
          stderr.write('hermes-desk-mcp: request failed\n')
          rpcError(null, -32603, 'Internal error')
        }
      })
      start = end + 1
      // Already-delivered chunks can contain many frames even after pause().
      // Output reservations and request admission still bound that work.
    }
  }
  const drain = () => { if (!stopped && blocked) { blocked = false; input.resume() } }
  input.on('data', data)
  input.on('end', close)
  input.on('error', close)
  output.on('drain', drain)
  output.on('error', close)
  function close() {
    if (stopped) return
    for (const operation of active.values()) operation.abort('cancelled', 'MCP client disconnected')
    stopped = true
    clearTimeout(partialTimer)
    buffer = Buffer.alloc(0)
    input.off('data', data)
    input.off('end', close)
    input.off('error', close)
    input.pause()
    output.off('drain', drain)
    output.off('error', close)
    app.close()
  }
  return { close }
}

function parseArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--profile', '--socket'].includes(args[i]) || !args[i + 1] || options[args[i]]) {
      throw new Error('Usage: hermes-desk-mcp.cjs --profile <P> --socket <absolute-path>')
    }
    options[args[i]] = args[i + 1]
  }
  return { profile: options['--profile'], socketPath: options['--socket'] }
}

if (require.main === module) {
  try {
    const shim = createShim(parseArgs(process.argv.slice(2)))
    process.once('SIGTERM', () => shim.close())
    process.once('SIGINT', () => shim.close())
  } catch (error) {
    process.stderr.write(`hermes-desk-mcp: ${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = { createShim, parseArgs, loadTools, validTools, validRenderUiArguments,
  TOOL_NAMES, BROWSER_TOOL_NAMES, FALLBACK_TOOLS, SHIM_VERSION }
