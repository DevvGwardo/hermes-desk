'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const net = require('node:net')
const { TextDecoder } = require('node:util')
const { PROFILE_RE } = require('./tools.cjs')
const MAX_LINE_BYTES = 8 * 1024 * 1024
const MAX_IN_FLIGHT = 32
const MAX_CONNECTIONS = 32
const MAX_TOTAL_BUFFERED_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_IN_FLIGHT = 128

/**
 * @typedef {object} SocketDispatch
 * @property {(callId: unknown, options: unknown) => void} cancel
 * @property {(params: unknown, reason: unknown) => unknown} rejectCall
 * @property {(profile: unknown) => void} gate
 * @property {() => unknown} listTools
 * @property {(params: unknown, options: unknown) => Promise<unknown>} call
 */
/**
 * A parsed NDJSON frame. Every field is untrusted until validated below.
 * @typedef {object} McpFrame
 * @property {unknown} [id]
 * @property {unknown} [method]
 * @property {unknown} [params]
 */
/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function socketError(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * @param {import('node:net').Socket} client
 * @param {string} code
 * @param {string} message
 */
function endWithError(client, code, message) {
  client.end(`${JSON.stringify({ id: null, error: { code, message } })}\n`)
  const timer = setTimeout(() => client.destroy(), 100)
  timer.unref?.()
  client.once('close', () => clearTimeout(timer))
  client.once('finish', () => client.destroy())
}

/**
 * @param {string} file
 * @returns {Promise<import('node:fs').Stats | null>}
 */
async function statOrNull(file) {
  try { return await fs.lstat(file) } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * @param {string} socketPath
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
function probeSocket(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath)
    const timer = setTimeout(() => done(socketError('EADDRINUSE', 'Existing MCP socket did not answer')), timeoutMs)
    /**
     * @param {unknown} error
     * @param {unknown} [live]
     */
    function done(error, live) {
      clearTimeout(timer)
      client.destroy()
      if (error) reject(error)
      else resolve(live)
    }
    client.once('connect', () => done(null, true))
    client.once('error', (error) => {
      const err = /** @type {NodeJS.ErrnoException} */ (error)
      if (['ECONNREFUSED', 'ENOENT'].includes(err.code ?? '')) done(null, false)
      else done(error)
    })
  })
}

/**
 * @param {object} deps
 * @param {string} deps.userDataDir
 * @param {SocketDispatch} deps.dispatch
 * @param {string} [deps.appVersion]
 * @param {(profile: string, token: unknown) => unknown} [deps.verifyToken]
 * @param {number} [deps.maxLineBytes]
 * @param {number} [deps.maxInFlight]
 * @param {number} [deps.maxConnections]
 * @param {number} [deps.maxTotalBufferedBytes]
 * @param {number} [deps.maxTotalInFlight]
 * @param {number} [deps.partialFrameTimeoutMs]
 * @param {number} [deps.idleTimeoutMs]
 * @param {number} [deps.probeTimeoutMs]
 * @param {(message: string) => void} [deps.onError]
 */
function createSocketServer({ userDataDir, dispatch, appVersion = '0.1.0',
  verifyToken = () => false, maxLineBytes = MAX_LINE_BYTES, maxInFlight = MAX_IN_FLIGHT,
  maxConnections = MAX_CONNECTIONS, maxTotalBufferedBytes = MAX_TOTAL_BUFFERED_BYTES,
  maxTotalInFlight = MAX_TOTAL_IN_FLIGHT, partialFrameTimeoutMs = 5000, idleTimeoutMs = 60_000,
  probeTimeoutMs = 500, onError = () => {} }) {
  const directory = path.join(userDataDir, 'mcp')
  const socketPath = path.join(directory, 'hermes-desk.sock')
  /** @type {Set<import('node:net').Socket>} */
  const connections = new Set()
  const server = net.createServer(accept)
  /** @type {import('node:fs').Stats | null | undefined} */
  let ownedSocket
  /** @type {Promise<string> | undefined} */
  let starting
  /** @type {Promise<void> | undefined} */
  let closing
  let disposed = false
  let ready = false
  let totalBufferedBytes = 0
  let totalInFlight = 0

  /**
   * @param {import('node:net').Socket} client
   */
  function accept(client) {
    if (!ready || disposed) { client.destroy(); return }
    client.on('error', () => {})
    if (connections.size >= maxConnections) {
      endWithError(client, 'resource_limit', 'MCP connection limit reached')
      // A rejected peer must not keep its socket open after receiving the error.
      return
    }
    connections.add(client)
    const owner = {}
    const controller = new AbortController()
    let buffer = Buffer.alloc(0)
    let bytes = 0
    let inFlight = 0
    /** @type {string | undefined} */
    let profile
    /** @type {unknown} */
    let token
    /** @type {NodeJS.Timeout | undefined} */
    let partialTimer
    let ending = false
    /** @type {Set<{bytes: number}>} */
    const writes = new Set()
    /** @type {Set<string | number>} */
    const ids = new Set()
    function releaseBuffer() {
      totalBufferedBytes -= buffer.length
      buffer = Buffer.alloc(0)
      bytes = 0
      clearTimeout(partialTimer)
      partialTimer = undefined
    }
    /**
     * @param {{bytes: number}} write
     */
    function releaseWrite(write) {
      if (writes.delete(write)) totalBufferedBytes -= write.bytes
    }
    client.once('close', () => {
      connections.delete(client)
      releaseBuffer()
      for (const write of writes) releaseWrite(write)
      controller.abort()
    })
    /**
     * @param {string} code
     * @param {string} message
     */
    function disconnect(code, message) {
      if (client.destroyed || ending) return
      ending = true
      releaseBuffer()
      controller.abort()
      endWithError(client, code, message)
    }
    client.setTimeout(idleTimeoutMs, () => disconnect('timeout', 'MCP connection idle deadline reached'))
    /**
     * @param {unknown} frame
     */
    function send(frame) {
      if (client.destroyed || ending || !client.writable) return
      const line = `${JSON.stringify(frame)}\n`
      // Bound replies too: a client that stops reading must not grow main's
      // write buffer without limit.
      const length = Buffer.byteLength(line)
      if (length > maxLineBytes || client.writableLength + length > maxLineBytes * 2 ||
          totalBufferedBytes + length > maxTotalBufferedBytes) {
        disconnect('resource_limit', 'MCP response buffer limit reached')
        return
      }
      const write = { bytes: length }
      writes.add(write)
      totalBufferedBytes += length
      client.write(line, () => releaseWrite(write))
    }
    /**
     * @param {unknown} id
     * @param {string} message
     * @param {unknown} [code]
     */
    function invalid(id, message, code = 'bad_args') {
      send({ id: id ?? null, error: { code, message } })
    }
    /**
     * @param {McpFrame} frame
     */
    async function handle(frame) {
      if (frame.method === 'cancel') {
        const cancelParams = /** @type {{profile?: unknown, callId?: unknown}} */ (frame.params)
        if (!profile || cancelParams.profile !== profile || !verifyToken(profile, token)) {
          return invalid(frame.id, 'MCP admission required', 'blocked_by_policy')
        }
        const callId = cancelParams.callId
        if (frame.id !== undefined || typeof callId !== 'string' || !callId || callId.length > 256) return invalid(frame.id, 'Invalid cancellation')
        dispatch.cancel(callId, { owner })
        return
      }
      const id = frame.id
      if (typeof id !== 'string' && typeof id !== 'number') {
        if (frame.method === 'tools/call') dispatch.rejectCall(frame.params, 'bad_args')
        return invalid(null, 'Invalid request ID')
      }
      if ((typeof id === 'string' && (id.length === 0 || id.length > 256)) ||
          (typeof id === 'number' && !Number.isSafeInteger(id))) {
        if (frame.method === 'tools/call') dispatch.rejectCall(frame.params, 'bad_args')
        return invalid(null, 'Invalid request ID')
      }
      if (ids.has(id)) {
        if (frame.method === 'tools/call') dispatch.rejectCall(frame.params, 'bad_args')
        return invalid(id, 'Duplicate in-flight request ID')
      }
      if (inFlight >= maxInFlight || totalInFlight >= maxTotalInFlight) {
        if (frame.method === 'tools/call') send({ id, result: dispatch.rejectCall(frame.params, 'resource_limit') })
        else invalid(id, 'Too many in-flight requests', 'resource_limit')
        return
      }
      ids.add(id)
      inFlight++
      totalInFlight++
      try {
        const params = frame.params
        if (!params || typeof params !== 'object' || Array.isArray(params)) throw socketError('bad_args', 'Invalid request parameters')
        const body = /** @type {Record<string, unknown>} */ (params)
        if (frame.method !== 'hello' && (!profile || body.profile !== profile || !verifyToken(profile, token))) {
          throw socketError('blocked_by_policy', 'MCP admission required')
        }
        if (frame.method === 'tools/call') {
          send({ id, result: await dispatch.call(body, { owner, signal: controller.signal }) })
        } else if (frame.method === 'hello') {
          if (profile) throw socketError('blocked_by_policy', 'MCP connection already admitted')
          if (typeof body.profile !== 'string' || !PROFILE_RE.test(body.profile)) throw socketError('bad_args', 'Invalid profile')
          if (typeof body.shimVersion !== 'string' || !body.shimVersion || body.shimVersion.length > 64 ||
              typeof body.pid !== 'number' || !Number.isSafeInteger(body.pid) || body.pid <= 0) throw socketError('bad_args', 'Invalid shim identity')
          if (!verifyToken(body.profile, body.token)) throw socketError('blocked_by_policy', 'Invalid profile credential')
          dispatch.gate(body.profile)
          profile = body.profile
          token = body.token
          send({ id, result: { protocol: 1, appVersion } })
        } else if (frame.method === 'tools/list') {
          dispatch.gate(body.profile)
          send({ id, result: { tools: dispatch.listTools() } })
        } else {
          throw socketError('bad_args', 'Unknown MCP socket method')
        }
      } catch (error) {
        const failure = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (frame.method === 'tools/call') send({ id, result: dispatch.rejectCall(frame.params, failure) })
        else invalid(id, 'MCP request rejected', typeof failure === 'string' ? failure : 'bad_args')
      } finally {
        ids.delete(id)
        inFlight--
        totalInFlight--
      }
    }
    /**
     * @param {Buffer} data
     */
    function line(data) {
      try {
        const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid frame')
        void handle(frame)
      } catch {
        invalid(null, 'Malformed NDJSON frame')
      }
    }
    client.on('data', (chunk) => {
      let offset = 0
      while (offset < chunk.length && !client.destroyed && !ending) {
        const newline = chunk.indexOf(10, offset)
        const end = newline < 0 ? chunk.length : newline
        const part = chunk.subarray(offset, end)
        if (bytes + part.length > maxLineBytes) {
          disconnect('resource_limit', 'MCP frame limit reached')
          return
        }
        const needed = bytes + part.length
        if (needed > buffer.length) {
          const capacity = Math.min(maxLineBytes, Math.max(needed, buffer.length * 2, 4096), maxTotalBufferedBytes)
          if (capacity < needed || totalBufferedBytes + capacity - buffer.length > maxTotalBufferedBytes) {
            disconnect('resource_limit', 'MCP aggregate buffer limit reached')
            return
          }
          const next = Buffer.allocUnsafe(capacity)
          buffer.copy(next, 0, 0, bytes)
          totalBufferedBytes += capacity - buffer.length
          buffer = next
        }
        part.copy(buffer, bytes)
        bytes += part.length
        if (newline < 0) {
          if (!partialTimer) {
            partialTimer = setTimeout(() => disconnect('timeout', 'MCP partial frame deadline reached'), partialFrameTimeoutMs)
            partialTimer.unref?.()
          }
          break
        }
        const data = buffer.subarray(0, bytes)
        // Release reserved input capacity before generating the reply.
        releaseBuffer()
        line(data)
        offset = newline + 1
      }
    })
  }

  async function unlinkOwned() {
    const current = await statOrNull(socketPath)
    if (ownedSocket && current?.isSocket() && current.dev === ownedSocket.dev && current.ino === ownedSocket.ino) {
      await fs.unlink(socketPath)
    }
    ownedSocket = null
  }
  server.on('error', () => { if (!disposed) onError('MCP socket unavailable') })

  async function start() {
    if (disposed) throw socketError('app_unavailable', 'MCP server disposed')
    if (starting) return starting
    starting = (async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const dir = await fs.lstat(directory)
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.()) throw socketError('blocked_by_policy', 'Unsafe MCP socket directory')
      await fs.chmod(directory, 0o700)
      const stale = await statOrNull(socketPath)
      if (stale) {
        if (!stale.isSocket() || stale.uid !== process.getuid?.()) throw socketError('blocked_by_policy', 'Unsafe MCP socket path')
        if (await probeSocket(socketPath, probeTimeoutMs)) throw socketError('EADDRINUSE', 'Hermes Desk MCP socket already has a listener')
        const current = await statOrNull(socketPath)
        if (current && (current.dev !== stale.dev || current.ino !== stale.ino)) throw socketError('EADDRINUSE', 'MCP socket changed during probe')
        if (current) await fs.unlink(socketPath)
      }
      if (disposed) throw socketError('app_unavailable', 'MCP server disposed')
      await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => { server.removeListener('error', reject); resolve() })
      }))
      ownedSocket = await fs.lstat(socketPath)
      await fs.chmod(socketPath, 0o600)
      ready = true
      return socketPath
    })().catch(async (error) => {
      for (const client of connections) client.destroy()
      if (server.listening) await /** @type {Promise<void>} */ (new Promise((resolve, reject) => server.close((err) => { if (err) reject(err); else resolve() })))
      await unlinkOwned()
      throw error
    })
    return starting
  }

  function dispose() {
    if (closing) return closing
    disposed = true
    closing = (async () => {
      await starting?.catch(() => {})
      for (const client of connections) client.destroy()
      if (server.listening) await /** @type {Promise<void>} */ (new Promise((resolve, reject) => server.close((err) => { if (err) reject(err); else resolve() })))
      await unlinkOwned()
    })()
    return closing
  }
  return { start, dispose, socketPath }
}

module.exports = { createSocketServer, MAX_LINE_BYTES, MAX_IN_FLIGHT,
  MAX_CONNECTIONS, MAX_TOTAL_BUFFERED_BYTES, MAX_TOTAL_IN_FLIGHT }
