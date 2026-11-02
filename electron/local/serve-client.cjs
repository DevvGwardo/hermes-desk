'use strict'

const MAX_FRAME_CHARS = 4 * 1024 * 1024
// Transcript history includes compression ancestors and can legitimately exceed
// the outbound RPC ceiling; serve-auth admits up to 16 MiB inbound on the
// socket. Dispatching on a smaller bound silently drops a reply the socket
// already accepted, hanging the renderer call until its timeout instead.
const MAX_INBOUND_FRAME_CHARS = 16 * 1024 * 1024
const SESSION_BIND_METHODS = new Set(['session.create', 'session.resume', 'session.activate', 'session.branch', 'session.branch_stored'])
/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
/**
 * @param {string | number} code
 * @param {string} message
 * @returns {Error & {code: string | number}}
 */
const rpcError = (code, message) => Object.assign(new Error(message), { code })
/**
 * @param {unknown} method
 * @returns {boolean}
 */
const isSecureRequest = (method) => method === 'secret' || method === 'sudo' ||
  method === 'display.install.sudo' || (typeof method === 'string' && method.startsWith('vault.'))
const RENDERER_METHODS = new Map(Object.entries({
  'client.capabilities': ['server_requests'],
  'profiles.list': ['include_sessions'],
  'profiles.create': ['name', 'description'],
  'profiles.configure': ['name', 'ui_meta'],
  'session.create': ['profile', 'source', 'title', 'parent_session_id', 'follow_profile_config'],
  'session.resume': ['profile', 'session_id', 'lazy', 'omit_messages', 'follow_profile_config'],
  'session.activate': ['profile', 'session_id'],
  'session.list': ['profile', 'limit', 'offset', 'source'],
  'session.history': ['profile', 'session_id', 'limit', 'before'],
  'session.events.since': ['profile', 'session_id', 'last_seen'],
  'session.interrupt': ['profile', 'session_id'],
  'session.steer': ['profile', 'session_id', 'text'],
  'session.close': ['profile', 'session_id'],
  'session.branch': ['profile', 'session_id', 'count', 'name', 'idempotency_key'],
  'session.branch_stored': ['profile', 'parent_session_id', 'source', 'idempotency_key'],
  'session.title': ['profile', 'session_id', 'title'],
  'session.usage': ['profile', 'session_id'],
  'session.context_breakdown': ['profile', 'session_id'],
  'session.active_list': ['profile'],
  'prompt.submit': ['profile', 'session_id', 'text', 'surface'],
  'approval.pending': ['profile', 'session_id'],
  'approval.respond': ['profile', 'session_id', 'choice', 'all', 'request_id'],
  'clarify.respond': ['request_id', 'answer', 'question_id'],
  'subagent.list': ['profile', 'session_id'],
  'subagent.tail': ['profile', 'session_id', 'subagent_id'],
  'subagent.interrupt': ['profile', 'session_id', 'subagent_id'],
  'subagent.steer': ['profile', 'subagent_id', 'text', 'session_id'],
  'message.react': ['session_id', 'row_id', 'newest_role', 'emoji', 'author'],
  'config.get': ['profile', 'session_id', 'key'],
  'model.options': ['profile', 'session_id', 'refresh'],
  'config.set': ['profile', 'session_id', 'key', 'value', 'confirm_expensive_model'],
}))
// The only config.set the renderer may send: one picked model, an explicit
// provider and an explicit scope. Persisting a profile default (--global) asks first.
const MODEL_SWITCH_VALUE = /^([A-Za-z0-9_.:/@+][^\s]{0,255}) --provider ([A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}) --(session|global)$/
/**
 * @param {unknown} value
 * @returns {{model: string, provider: string, scope: string} | null}
 */
function parseModelSwitch(value) {
  const match = typeof value === 'string' ? MODEL_SWITCH_VALUE.exec(value) : null
  return match ? { model: match[1], provider: match[2], scope: match[3] } : null
}
const SAFE_CONFIG_VALUES = {
  'approvals.mode': ['manual', 'smart', 'off'],
  approval_mode: ['manual', 'smart', 'off'],
  theme: ['auto', 'light', 'dark'],
  thinking_mode: ['full', 'collapsed', 'off'],
  details_mode: ['expanded', 'collapsed'],
  density: ['on', 'off'],
}
const profileName = (/** @type {unknown} */ value) => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
/**
 * A tracked RPC call: renderer calls carry method/params/turn and gain
 * transport/completedSessions once routed through a live socket.
 * @typedef {object} TrackedCall
 * @property {string} method
 * @property {unknown} params
 * @property {unknown} turn
 * @property {ServeTransport} [transport]
 * @property {Map<string, number>} [completedSessions]
 */
/**
 * A pending RPC awaiting a serve reply. Resolvers ride alongside the
 * tracked call so rejection can clean up timers and watchers.
 * @typedef {TrackedCall & {resolve: (value: unknown) => void, reject: (reason?: unknown) => void, timer: NodeJS.Timeout, transport: ServeTransport}} PendingCall
 */
/**
 * A JSON-RPC frame from an untrusted renderer. Payload shapes are validated
 * field-by-field below; the record type only unlocks property access.
 * @typedef {object} RpcFrame
 * @property {unknown} [id]
 * @property {unknown} [method]
 * @property {Record<string, unknown>} [params]
 * @property {unknown} [error]
 * @property {Record<string, unknown>} [result]
 * @property {unknown} [jsonrpc]
 */
/**
 * @param {unknown} frame
 * @returns {boolean}
 */
function rendererRpcAllowed(frame) {
  const f = /** @type {RpcFrame} */ (frame)
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false
  const method = typeof f.method === 'string' ? f.method : null
  const allowed = method ? RENDERER_METHODS.get(method) : undefined
  if (f.jsonrpc !== '2.0' || !allowed ||
      Object.keys(f).some((key) => !['jsonrpc', 'id', 'method', 'params'].includes(key))) return false
  const params = /** @type {Record<string, unknown>} */ (f.params ?? {})
  if (typeof params !== 'object' || Array.isArray(params) ||
      Object.keys(params).some((key) => !allowed.includes(key))) return false
  for (const [key, value] of Object.entries(params)) {
    if (key === 'profile' || (key === 'name' && typeof f.method === 'string' && f.method.startsWith('profiles.'))) {
      if (!profileName(value)) return false
    } else if (key === 'follow_profile_config') {
      if (typeof value !== 'boolean') return false
    } else if (key === 'count') {
      if (!Number.isSafeInteger(value) || (typeof value === 'number' && value <= 0)) return false
    } else if (key === 'idempotency_key') {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) return false
    } else if (key === 'ui_meta') {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).some((key) => !['display_name', 'avatar'].includes(key)) ||
          Object.values(value).some((v) => typeof v !== 'string' || v.length > 4096)) return false
    } else if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) return false
    if (typeof value === 'string' && value.length > 1024 * 1024) return false
    if (typeof value === 'number' && !Number.isFinite(value)) return false
  }
  if (f.method === 'config.set') {
    const rule = /** @type {Record<string, unknown>} */ (params)
    return rule.key === 'model' && parseModelSwitch(rule.value) !== null &&
      (rule.confirm_expensive_model === undefined || typeof rule.confirm_expensive_model === 'boolean')
  }
  if (f.method === 'model.options' && params.refresh !== undefined && typeof params.refresh !== 'boolean') return false
  return f.method !== 'config.get' || Object.hasOwn(SAFE_CONFIG_VALUES, /** @type {string} */ (params.key))
}

/**
 * @param {unknown} method
 * @param {unknown} params
 * @param {unknown} result
 * @returns {unknown}
 */
function rendererResult(method, params, result) {
  const res = /** @type {Record<string, unknown>} */ (result && typeof result === 'object' ? result : {})
  const args = /** @type {Record<string, unknown>} */ (params && typeof params === 'object' ? params : {})
  if (method === 'subagent.list') {
    /**
     * @param {Record<string, unknown>} row
     * @param {Array<string>} keys
     */
    const pick = (row, keys) => Object.fromEntries(keys.filter(key =>
      row && ['string', 'number', 'boolean'].includes(typeof row[key]))
      .map(key => [key, row[key]]))
    return {
      subagents: Array.isArray(res.subagents) ? res.subagents.filter(row =>
        row && typeof row === 'object' && !Array.isArray(row) &&
        typeof /** @type {Record<string, unknown>} */ (row).subagent_id === 'string' &&
        /** @type {string} */ (/** @type {Record<string, unknown>} */ (row).subagent_id).trim()).slice(0, 128).map(row =>
        pick(/** @type {Record<string, unknown>} */ (row), ['subagent_id', 'parent_id', 'depth', 'goal', 'model', 'started_at', 'status', 'tool_count', 'last_tool', 'accepting_steer'])) : [],
      delegations: Array.isArray(res.delegations) ? res.delegations.slice(0, 128).map(row =>
        pick(/** @type {Record<string, unknown>} */ (row), ['delegation_id', 'task_index', 'status', 'goal', 'error', 'dispatched_at', 'completed_at'])) : [],
    }
  }
  if (method === 'subagent.tail') return {
    subagent_id: args.subagent_id, available: res.available === true,
    text: typeof res.text === 'string' ? res.text.slice(-16384) : '',
    truncated: res.truncated === true,
  }
  if (method === 'subagent.interrupt') return { subagent_id: args.subagent_id, found: res.found === true }
  if (method === 'subagent.steer') return { subagent_id: args.subagent_id, status: res.status === 'queued' ? 'queued' : 'rejected' }
  if (method === 'session.context_breakdown') {
    /**
     * @param {Record<string, unknown>} value
     * @param {Array<string>} keys
     */
    const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value || {}, key) &&
      ['string', 'number', 'boolean'].includes(typeof value[key]))
      .map(key => [key, value[key]]))
    return {
      ...pick(res, ['context_max', 'context_used', 'context_estimated', 'context_source']),
      categories: Array.isArray(res.categories) ? res.categories.slice(0, 128)
        .map(row => pick(/** @type {Record<string, unknown>} */ (row), ['id', 'label', 'tokens'])) : [],
      context_files: Array.isArray(res.context_files) ? res.context_files.slice(0, 128)
        .map(row => pick(/** @type {Record<string, unknown>} */ (row), ['label', 'path', 'est_tokens', 'loaded', 'status'])) : [],
    }
  }
  if (method === 'model.options') {
    /**
     * @param {unknown} value
     * @param {number} [max]
     * @returns {string | undefined}
     */
    const text = (value, max = 256) => typeof value === 'string' && value.length <= max ? value : undefined
    /**
     * @param {unknown} value
     * @param {number} limit
     * @returns {Array<string>}
     */
    const names = (value, limit) => Array.isArray(value)
      ? value.filter((entry) => typeof entry === 'string' && entry.length <= 256).slice(0, limit) : []
    return {
      model: text(res.model), provider: text(res.provider),
      providers: Array.isArray(res.providers) ? res.providers.slice(0, 128)
        .filter((row) => row && typeof row === 'object' && !Array.isArray(row) &&
          typeof /** @type {Record<string, unknown>} */ (row).slug === 'string' &&
          /** @type {string} */ (/** @type {Record<string, unknown>} */ (row).slug).length <= 128)
        .map((row) => {
          const item = /** @type {Record<string, unknown>} */ (row)
          return {
            slug: item.slug, name: text(item.name) ?? item.slug,
            models: names(item.models, 2000), featured_models: names(item.featured_models, 64),
            unavailable_models: names(item.unavailable_models, 2000),
            is_current: item.is_current === true, authenticated: typeof item.authenticated === 'boolean' ? item.authenticated : null,
            warning: text(item.warning, 1024),
          }
        }) : [],
    }
  }
  if (method === 'config.set') {
    /**
     * @param {Record<string, unknown>} value
     * @param {Array<string>} keys
     */
    const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value || {}, key) &&
      ['string', 'boolean'].includes(typeof value[key])).map(key => [key, value[key]]))
    return pick(res, ['key', 'value', 'warning', 'confirm_required', 'confirm_message', 'scope', 'deferred'])
  }
  if (method === 'config.get') {
    const allowed = /** @type {Record<string, Array<string> | undefined>} */ (SAFE_CONFIG_VALUES)[/** @type {string} */ (args.key)]
    return allowed?.includes(/** @type {string} */ (res.value)) ? { value: res.value } : {}
  }
  /**
   * @param {unknown} value
   * @param {number} [depth]
   * @returns {unknown}
   */
  const project = (value, depth = 0) => {
    if (depth > 64) return null
    if (Array.isArray(value)) return value.map((entry) => project(entry, depth + 1))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/^(?:config|effective_config|env|environment|credentials|authorization|password|secret|token|session_token|api_key|access_token|refresh_token)$/i.test(key))
      .map(([key, entry]) => [key, project(entry, depth + 1)]))
  }
  return project(result)
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function loopbackBaseUrl(raw = 'http://127.0.0.1:9119') {
  const url = new URL(typeof raw === 'string' ? raw : '')
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Hermes serve must use an HTTP origin on 127.0.0.1')
  }
  return url.origin
}

/**
 * JSON-RPC and the renderer broker share this dispatcher. Controller calls
 * must use the transport attached to their session, not a second WS connection.
 * Broker taps keep that routing in main without changing workspace callers.
 */
/**
 * A browser or renderer socket attached to the dispatcher.
 * @typedef {object} ServeTransport
 * @property {(text: string) => void} send
 * @property {boolean} [connected]
 * @property {Map<unknown, TrackedCall>} [calls]
 * @property {(data: unknown) => void} [forward]
 * @property {Set<string>} [rendererRequests]
 * @property {Map<string, unknown>} [approvalRequests]
 * @property {unknown} [sender]
 * @property {number} [readyState]
 * @property {(code?: number) => void} [close]
 */
/**
 * A renderer broker tap: a ServeTransport with tracking state.
 * @typedef {ServeTransport & {connected: boolean, calls: Map<unknown, TrackedCall>, rendererRequests: Set<string>, approvalRequests: Map<unknown, unknown>, sender: unknown, forward: (data: unknown) => void, close: () => void, approving?: boolean}} ServeTap
 */
/**
 * @typedef {object} ServeClientOptions
 * @property {new (url: string) => WebSocket} [WebSocketImpl]
 * @property {number} [requestTimeoutMs]
 * @property {(handler: () => void, ms: number) => NodeJS.Timeout} [setTimer]
 * @property {(timer: NodeJS.Timeout | undefined) => void} [clearTimer]
 * @property {(sender: unknown, details: unknown) => unknown} [approveRendererAction]
 * @property {(sender: unknown, details: unknown) => Promise<unknown>} [approveModelDefault]
 */
/**
 * @param {ServeClientOptions} [options]
 */
function createServeClient({
  WebSocketImpl = globalThis.WebSocket,
  requestTimeoutMs = 30000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  approveRendererAction = async () => false,
  approveModelDefault = async () => false,
} = {}) {
  /** @type {{baseUrl: string, auth: Record<string, unknown>} | null} */
  /** @type {{baseUrl: string, auth: Record<string, unknown>} | null} */
  let endpoint = null
  /** @type {WebSocket | null} */
  let socket = null
  let running = false
  /** @type {NodeJS.Timeout | undefined} */
  /** @type {NodeJS.Timeout | undefined} */
  let retryTimer
  let retryMs = 1000
  let sequence = 0
  let connectionState = false
  /** @type {Map<string, {resolve: (value: unknown) => void, reject: (reason?: unknown) => void, timer: NodeJS.Timeout, transport: ServeTransport, method: string, params: unknown, turn: unknown, completedSessions?: Map<string, number>}>} */
  /** @type {Map<string, PendingCall>} */
  const pending = new Map()
  /** @type {Set<(name: string, params: unknown) => void>} */
  /** @type {Set<(name: unknown, params: unknown) => void>} */
  const events = new Set()
  /** @type {Set<(connected: boolean) => void>} */
  /** @type {Set<(connected: boolean) => void>} */
  const connections = new Set()
  /** @type {Map<string, unknown>} */
  /** @type {Map<unknown, (params: unknown) => unknown>} */
  const requests = new Map()
  /** @type {Map<string, ServeTap>} */
  /** @type {Map<unknown, ServeTap>} */
  const taps = new Map()
  /** @type {Map<unknown, ServeTransport>} */
  /** @type {Map<unknown, ServeTransport>} */
  const sessions = new Map()
  /** @type {Map<unknown, {storedId?: unknown, profile?: unknown, mainOwned?: boolean, lastSeen: number, disconnected?: boolean}>} */
  /** @type {Map<unknown, {storedId?: unknown, profile?: unknown, mainOwned?: boolean, lastSeen: number, disconnected?: boolean}>} */
  const replay = new Map()
  /** @type {Map<unknown, {profile?: unknown}>} */
  /** @type {Map<unknown, {profile?: unknown}>} */
  const activeTurns = new Map()
  /** @type {Map<unknown, Map<string, AbortController>>} */
  /** @type {Map<unknown, Map<string, AbortController>>} */
  const serverRequests = new Map()
  /** @type {null | ((method: string, params: unknown, options: {signal: AbortSignal, profile: unknown}) => Promise<unknown>)} */
  /** @type {null | ((method: unknown, params: unknown, options: {signal: AbortSignal, profile: unknown}) => Promise<unknown>)} */
  let secureRequestHandler = null

  const connected = () => socket?.readyState === 1 || [...taps.values()].some((t) => t.connected)
  function updateConnection() {
    const next = connected()
    if (next === connectionState) return
    connectionState = next
    for (const cb of connections) cb(next)
  }

  /**
   * @param {ServeTransport} transport
   */
  function rejectPending(transport) {
    for (const request of serverRequests.get(transport)?.values() || []) request.abort()
    serverRequests.delete(transport)
    for (const [id, entry] of pending) {
      if (entry.transport !== transport) continue
      pending.delete(id)
      clearTimer(entry.timer)
      entry.reject(rpcError('disconnected', 'Hermes serve disconnected'))
    }
  }

  /**
   * @param {ServeTransport} transport
   * @param {unknown} frame
   */
  function sendFrame(transport, frame) {
    const text = JSON.stringify(frame) + '\n'
    if (text.length > MAX_FRAME_CHARS) throw rpcError('bad_args', 'Serve frame too large')
    if (typeof transport.send !== 'function') throw rpcError('disconnected', 'Chat socket is not open')
    transport.send(text)
  }

  /**
   * @param {unknown} method
   * @param {unknown} params
   * @param {unknown} result
   * @param {ServeTransport} transport
   * @param {TrackedCall} call
   */
  function trackSession(method, params, result, transport, call) {
    const p = /** @type {Record<string, unknown> | null} */ (params && typeof params === 'object' ? params : null)
    const r = /** @type {Record<string, unknown> | null} */ (result && typeof result === 'object' ? result : null)
    const rInfo = /** @type {Record<string, unknown> | null} */ (r && typeof r.info === 'object' && r.info !== null && !Array.isArray(r.info) ? r.info : null)
    if (method === 'session.close') {
      sessions.delete(p?.session_id)
      replay.delete(p?.session_id)
      activeTurns.delete(p?.session_id)
      return
    }
    if (typeof method !== 'string' || !SESSION_BIND_METHODS.has(method)) return
    const id = r?.session_id || p?.session_id
    if (typeof id !== 'string' || !id) return
    let previous = replay.get(id)
    const profile = p?.profile || rInfo?.profile_name
    const storedId = r?.stored_session_id || p?.session_id || id
    if (!previous) {
      const old = [...replay].find(([, entry]) => entry.disconnected &&
        entry.storedId === storedId && entry.profile === profile)
      if (old) {
        previous = old[1]
        replay.delete(old[0])
        activeTurns.delete(old[0])
      }
    }
    const entry = previous || { lastSeen: 0 }
    entry.storedId = r?.stored_session_id || entry.storedId || p?.session_id || id
    entry.profile = p?.profile || rInfo?.profile_name || entry.profile
    entry.mainOwned = transport === socket
    entry.lastSeen = Math.max(entry.lastSeen, call.completedSessions?.get(id) ?? 0)
    sessions.set(id, transport)
    replay.set(id, entry)
    const active = activeTurns.get(id)
    if (active && !active.profile) active.profile = entry.profile
    // A live completion outranks an earlier snapshot. Preserve a newer
    // prompt's identity so its own rejection can still remove it.
    if ((r?.running || r?.inflight) && !call.completedSessions?.has(id) && !activeTurns.has(id)) {
      activeTurns.set(id, { profile: entry.profile })
    }
    if (previous?.disconnected && !entry.mainOwned) {
      entry.disconnected = false
      void replaySession(id, entry, transport)
    }
  }

  /**
   * @param {unknown} method
   * @param {unknown} params
   * @returns {{profile?: unknown} | null}
   */
  function trackPrompt(method, params) {
    const p = /** @type {Record<string, unknown> | null} */ (params && typeof params === 'object' ? params : null)
    if (method !== 'prompt.submit' || typeof p?.session_id !== 'string' || activeTurns.has(p.session_id)) return null
    const turn = { profile: p?.profile || replay.get(p.session_id)?.profile }
    activeTurns.set(p.session_id, turn)
    return turn
  }
  /**
   * @param {TrackedCall} call
   * @param {RpcFrame} frame
   */
  function finishPrompt(call, frame) {
    const p = /** @type {Record<string, unknown> | null} */ (call.params && typeof call.params === 'object' ? call.params : null)
    const r = /** @type {Record<string, unknown> | null} */ (frame && typeof frame === 'object' ? frame.result : null)
    if (call.turn && (frame.error || r?.status !== 'streaming') &&
        activeTurns.get(p?.session_id) === call.turn) activeTurns.delete(/** @type {string} */ (p?.session_id))
  }

  /**
   * @param {unknown} id
   * @param {unknown} seq
   * @param {ServeTransport} transport
   * @param {Map<unknown, TrackedCall> | undefined} rendererCalls
   * @param {boolean} [settle]
   */
  function trackCompletion(id, seq, transport, rendererCalls, settle = true) {
    if (settle) activeTurns.delete(id)
    if (typeof id !== 'string') return
    /**
     * @param {TrackedCall} call
     */
    const remember = (call) => {
      if (!SESSION_BIND_METHODS.has(call.method)) return
      const completed = call.completedSessions ?? new Map()
      call.completedSessions = completed
      const ordinal = typeof seq === 'number' && Number.isInteger(seq) ? seq : 0
      completed.set(id, Math.max(completed.get(id) ?? 0, ordinal))
    }
    for (const call of pending.values()) if (call.transport === transport) remember(call)
    for (const call of rendererCalls?.values() || []) remember(call)
  }

  /**
   * @param {RpcFrame} frame
   * @param {ServeTransport} transport
   */
  function answerSecureRequest(frame, transport) {
    const frameParams = /** @type {Record<string, unknown> | null} */ (frame.params)
    let ledger = serverRequests.get(transport)
    if (!ledger) serverRequests.set(transport, ledger = new Map())
    const id = String(frame.id)
    if (ledger.has(id)) return
    // Retain ids (not values) to suppress duplicate live/replay questions.
    if (ledger.size >= 512) {
      for (const [key, request] of ledger) {
        if (request.signal.aborted) ledger.delete(key)
        if (ledger.size < 512) break
      }
    }
    if (ledger.size >= 512) {
      sendFrame(transport, { jsonrpc: '2.0', id: frame.id, result: { value: '' } })
      return
    }
    const controller = new AbortController()
    ledger.set(id, controller)
    Promise.resolve().then(() => secureRequestHandler?.(frame.method, frame.params, {
      signal: controller.signal, profile: frameParams && replay.get(frameParams.session_id)?.profile,
    })).then((result) => {
      if (controller.signal.aborted) return
      const data = /** @type {Record<string, unknown> | null} */ (result && typeof result === 'object' ? result : null)
      sendFrame(transport, { jsonrpc: '2.0', id: frame.id,
        result: { value: typeof data?.value === 'string' ? data.value : '' } })
    }, () => {
      if (!controller.signal.aborted) sendFrame(transport, { jsonrpc: '2.0', id: frame.id, result: { value: '' } })
    }).catch(() => {}).finally(() => controller.abort())
  }

  /**
   * @param {RpcFrame} frame
   * @param {ServeTransport} transport
   * @returns {RpcFrame}
   */
  function filterOpenRequests(frame, transport) {
    const payload = /** @type {{open_requests?: unknown}} */ (frame.result && typeof frame.result === 'object' ? frame.result : null)
    if (!payload || !Array.isArray(payload.open_requests)) return frame
    return { ...frame, result: { ...payload, open_requests: payload.open_requests.filter((request) => {
      const item = /** @type {Record<string, unknown> | null} */ (request && typeof request === 'object' ? request : null)
      if (!isSecureRequest(item?.method)) return true
      if (item?.id != null) answerSecureRequest(/** @type {RpcFrame} */ (request), transport)
      return false
    }) } }
  }

  /**
   * @param {unknown} id
   * @param {{storedId?: unknown, profile?: unknown, mainOwned?: boolean, lastSeen: number, disconnected?: boolean}} entry
   * @param {ServeTransport} transport
   */
  async function replaySession(id, entry, transport) {
    try {
      // CONTRACT: the current Hermes wire calls the watermark `last_seen`,
      // not `seq` as in spec §6.3.
      const params = { session_id: id, last_seen: entry.lastSeen,
        ...(entry.profile ? { profile: entry.profile } : {}) }
      let result = /** @type {{latest_seq?: unknown, events?: unknown, truncated?: unknown}} */ (await callOn(transport, 'session.events.since', params))
      if (/** @type {number} */ (result.latest_seq) < entry.lastSeen) {
        entry.lastSeen = 0
        result = /** @type {{latest_seq?: unknown, events?: unknown, truncated?: unknown}} */ (await callOn(transport, 'session.events.since', { ...params, last_seen: 0 }))
      }
      for (const event of /** @type {Array<unknown>} */ (result.events || [])) {
        const visible = dispatch(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: event }), transport,
          transport.calls)
        if (visible && transport.forward) transport.forward(visible)
      }
      if (result.truncated) {
        for (const cb of events) cb('session.replay.truncated', { session_id: id })
      }
    } catch {
      // Read-only replay is best effort; never retry a prompt or mutation.
      for (const cb of events) cb('session.replay.unavailable', { session_id: id })
    }
  }

  /**
   * @param {WebSocket} ws
   */
  async function restoreMainSessions(ws) {
    for (const [id, entry] of [...replay]) {
      if (!entry.mainOwned || !entry.disconnected || socket !== ws) continue
      try {
        const result = /** @type {{session_id?: unknown}} */ (await callOn(ws, 'session.resume', {
          session_id: entry.storedId, omit_messages: true,
          ...(entry.profile ? { profile: entry.profile } : {}),
        }))
        const newId = /** @type {unknown} */ (result && typeof result === 'object' ? result.session_id : undefined) || id
        if (newId !== id) { replay.delete(id); replay.set(newId, entry) }
        entry.disconnected = false
        sessions.set(newId, ws)
        await replaySession(newId, entry, ws)
      } catch {
        for (const cb of events) cb('session.replay.unavailable', { session_id: id })
      }
    }
  }

  /**
   * @param {unknown} raw
   * @param {ServeTransport} transport
   * @param {Map<unknown, TrackedCall> | undefined} rendererCalls
   * @returns {string}
   */
  /**
   * @param {unknown} raw
   * @param {ServeTransport} transport
   * @param {Map<unknown, TrackedCall> | undefined} [rendererCalls]
   * @returns {string}
   */
  function dispatch(raw, transport, rendererCalls) {
    if (typeof raw !== 'string' || raw.length > MAX_INBOUND_FRAME_CHARS) return ''
    const forwarded = []
    for (const line of raw.split('\n').filter((s) => s.trim())) {
      /** @type {RpcFrame} */
      let frame
      try { frame = JSON.parse(line) } catch { continue }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.jsonrpc !== '2.0') continue
      if (frame.id != null && !frame.method) {
        frame = filterOpenRequests(frame, transport)
        const id = String(frame.id)
        const call = pending.get(id)
        if (call && call.transport === transport) {
          pending.delete(id)
          clearTimer(call.timer)
          finishPrompt(call, frame)
          if (frame.error) {
            // Backend messages may contain a token-bearing URL. Do not forward it.
            const failure = frame.error && typeof frame.error === 'object' ? /** @type {Record<string, unknown>} */ (frame.error) : null
            const message = sanitizeMessage(failure ? failure.message : undefined)
            call.reject(rpcError(/** @type {string | number} */ (failure?.code) ?? -32603, message))
          } else {
            trackSession(call.method, call.params, frame.result, transport, call)
            call.resolve(frame.result)
          }
        } else {
          const rendererCall = rendererCalls?.get(id)
          if (rendererCall && rendererCalls) {
            rendererCalls.delete(id)
            finishPrompt(rendererCall, frame)
            if (!frame.error) trackSession(rendererCall.method, rendererCall.params, frame.result, transport, rendererCall)
            frame = frame.error
              ? { jsonrpc: '2.0', id: frame.id, error: { code: /** @type {Record<string, unknown>} */ (frame.error).code ?? -32603, message: 'Serve request failed' } }
              : { jsonrpc: '2.0', id: frame.id,
                result: /** @type {Record<string, unknown>} */ (rendererResult(rendererCall.method, rendererCall.params, frame.result)) }
            forwarded.push(JSON.stringify(frame))
          } else if (rendererCalls && Array.isArray(/** @type {{open_requests?: unknown} | null} */ (typeof frame.result === 'object' && frame.result !== null ? frame.result : null)?.open_requests)) {
            // Some serve versions publish replay request state without a live
            // client call. Only the cleared state is safe without correlation.
            forwarded.push(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { open_requests: [] } }))
          }
        }
      } else if (frame.method && frame.id != null) {
        if (isSecureRequest(frame.method)) {
          answerSecureRequest(frame, transport)
          continue
        }
        const method = /** @type {string} */ (frame.method)
        const handler = requests.get(method)
        if (!handler) {
          const tap = /** @type {ServeTap} */ (transport)
          if (rendererCalls && ['approval', 'clarify'].includes(method) && tap.rendererRequests.size < 512) {
            tap.rendererRequests.add(String(frame.id))
            if (frame.method === 'approval') tap.approvalRequests.set(String(frame.id), frame.params || {})
            forwarded.push(line)
          } else sendFrame(transport, { jsonrpc: '2.0', id: frame.id,
            error: { code: -32601, message: 'No main-process request handler' } })
          continue
        }
        Promise.resolve().then(() => handler(frame.params)).then(
          (result) => sendFrame(transport, { jsonrpc: '2.0', id: frame.id, result }),
          () => sendFrame(transport, { jsonrpc: '2.0', id: frame.id,
            error: { code: -32603, message: 'Main-process request failed' } }),
        ).catch(() => {})
      } else if (frame.method) {
        // A sensitive frame without an id is malformed, not renderer content.
        if (isSecureRequest(frame.method)) continue
        const fp = /** @type {Record<string, unknown>} */ (frame.params)
        const name = frame.method === 'event' ? fp?.type : frame.method
        if (name === 'request.cancel') {
          const id = String(typeof fp?.payload === 'object' && fp.payload !== null ? /** @type {{id?: unknown}} */ (fp.payload).id : undefined)
          serverRequests.get(transport)?.get(id)?.abort()
          transport.rendererRequests?.delete(id)
          transport.approvalRequests?.delete(id)
        }
        const entry = replay.get(fp?.session_id)
        if (entry && Number.isInteger(fp?.seq)) {
          if (fp && /** @type {number} */ (fp.seq) <= entry.lastSeen) {
            // Hermes fans a session out to several sockets. Main handles each
            // event once, but each renderer needs its own copy of every token.
            if (name === 'message.complete' || name === 'session.closed') {
              trackCompletion(fp?.session_id, fp?.seq, transport, rendererCalls, false)
            }
            if (rendererCalls) forwarded.push(line)
            continue
          }
          entry.lastSeen = /** @type {number} */ (fp?.seq)
        }
        const sessionId = fp?.session_id
        if (name === 'message.start' && typeof sessionId === 'string') {
          if (!activeTurns.has(sessionId)) activeTurns.set(sessionId, { profile: replay.get(sessionId)?.profile })
        }
        if (name === 'message.complete' || name === 'session.closed') {
          trackCompletion(sessionId, fp?.seq, transport, rendererCalls)
        }
        if (name === 'gateway.ready') {
          void callOn(transport, 'client.capabilities', { server_requests: true }).catch(() => {})
        }
        for (const cb of events) cb(name, fp)
        forwarded.push(line)
      } else {
        forwarded.push(line)
      }
    }
    return forwarded.join('\n')
  }

  /**
 * @param {unknown} message
 * @returns {string}
 */
function sanitizeMessage(message) {
    let value = typeof message === 'string' ? message : 'Serve request failed'
    if (endpoint?.auth?.token) value = value.split(String(endpoint.auth.token)).join('[secret]')
    return value.replace(/([?&]token=)[^&\s]+/gi, '$1[secret]').slice(0, 2000)
  }

  function scheduleReconnect() {
    if (!running || retryTimer || !endpoint?.auth?.token) return
    retryTimer = setTimer(() => { retryTimer = undefined; connect() }, retryMs)
    retryTimer?.unref?.()
    retryMs = Math.min(retryMs * 2, 30000)
  }

  function connect() {
    if (!running || !endpoint?.auth?.token || socket) return
    /** @type {WebSocket | undefined} */
    let ws
    try {
      const url = new URL('/api/ws', endpoint.baseUrl)
      url.protocol = 'ws:'
      url.searchParams.set('token', String(endpoint.auth.token))
      ws = new WebSocketImpl(url.toString())
    } catch { scheduleReconnect(); return }
    socket = /** @type {WebSocket} */ (ws)
    ws.addEventListener('open', () => {
      if (socket !== ws) return
      retryMs = 1000
      updateConnection()
      void restoreMainSessions(ws)
    })
    ws.addEventListener('message', (event) => {
      if (socket !== ws) return
      dispatch(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'), ws)
    })
    ws.addEventListener('error', () => {
      // Never log the error, which can contain the credential-bearing URL.
      try { ws.close() } catch {}
    })
    ws.addEventListener('close', () => {
      rejectPending(ws)
      for (const [id, owner] of sessions) if (owner === ws) {
        sessions.delete(id)
        const doomed = replay.get(id)
        if (doomed) doomed.disconnected = true
      }
      if (socket !== ws) return
      socket = null
      updateConnection()
      scheduleReconnect()
    })
  }

  function stop() {
    running = false
    clearTimer(retryTimer)
    retryTimer = undefined
    const ws = socket
    socket = null
    if (ws) {
      rejectPending(ws)
      try { ws.close() } catch {}
    }
    for (const tap of taps.values()) {
      rejectPending(tap)
      tap.close()
    }
    taps.clear()
    sessions.clear()
    replay.clear()
    activeTurns.clear()
    updateConnection()
  }

  /**
   * @param {unknown} method
   * @param {unknown} params
   * @returns {ServeTransport}
   */
  function transportFor(method, params) {
    const p = /** @type {Record<string, unknown> | null} */ (params && typeof params === 'object' ? params : null)
    if (typeof method === 'string' && method.startsWith('browser.controller.') ||
        (p?.session_id && sessions.has(p.session_id))) {
      const transport = sessions.get(p?.session_id)
      if (!transport || (transport === socket ? socket?.readyState !== 1 : !transport.connected)) {
        throw rpcError('disconnected', 'Chat session is not attached to a serve socket')
      }
      return transport
    }
    if (socket?.readyState !== 1) throw rpcError('disconnected', 'Hermes serve offline')
    return socket
  }

  /**
   * @param {unknown} method
   * @param {unknown} params
   * @returns {Promise<unknown>}
   */
  function call(method, params = {}) {
    /** @type {ServeTransport | undefined} */
    let transport
    try { transport = transportFor(method, params) } catch (err) { return Promise.reject(err) }
    return callOn(transport, method, params)
  }

  /**
   * @param {ServeTransport} transport
   * @param {unknown} method
   * @param {unknown} params
   * @returns {Promise<unknown>}
   */
  function callOn(transport, method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = `hd_main_${++sequence}`
      const timer = setTimer(() => {
        pending.delete(id)
        reject(rpcError('timeout', 'Serve request timed out'))
      }, requestTimeoutMs)
      timer?.unref?.()
      const entry = { resolve, reject, timer, transport, method: /** @type {string} */ (method), params, turn: trackPrompt(method, params) }
      pending.set(id, entry)
      try { sendFrame(transport, { jsonrpc: '2.0', id, method, params }) } catch (err) {
        pending.delete(id)
        clearTimer(timer)
        finishPrompt(entry, { error: true })
        reject(err)
      }
    })
  }

  /**
   * A renderer webContents behind the broker. Only the used surface is typed.
   * @typedef {object} RendererSender
   * @property {() => boolean} isDestroyed
   * @property {(event: string, listener: (...args: Array<unknown>) => void) => void} once
   * @property {(channel: string, ...args: Array<unknown>) => void} send
   */
  /**
   * The tap as the broker proxy sees it: a live channel to one renderer.
   * @typedef {object} TapProxy
   * @property {() => boolean} isDestroyed
   * @property {(event: string, listener: (...args: Array<unknown>) => void) => void} once
   * @property {(channel: string, event: unknown) => void} send
   */
  /**
   * The main-side broker the taps drive. Types describe the consumed protocol.
   * @typedef {object} RendererBroker
   * @property {(proxy: unknown, message: unknown) => {ok: boolean}} send
   * @property {(proxy: unknown, params: unknown) => Promise<unknown>} open
   * @property {(proxy: unknown, params: unknown) => unknown} close
   * @property {(proxy: unknown) => unknown} closeAllFor
   */
  /**
   * @param {RendererBroker} broker
   */
  function bindRendererBroker(broker) {
    /** @type {WeakMap<object, unknown>} */
    const proxies = new WeakMap()
    /**
     * @param {unknown} id
     * @param {ServeTap} tap
     */
    function dropTap(id, tap) {
      if (taps.get(id) !== tap) return
      tap.connected = false
      rejectPending(tap)
      for (const [sessionId, owner] of sessions) if (owner === tap) {
        sessions.delete(sessionId)
        const doomed = replay.get(sessionId)
        if (doomed) doomed.disconnected = true
      }
      taps.delete(id)
      updateConnection()
    }
    /**
     * @param {RendererSender} sender
     */
    function dropSender(sender) {
      for (const [id, tap] of taps) if (tap.sender === sender) dropTap(id, tap)
    }
    /**
     * @param {RendererSender} sender
     * @returns {TapProxy}
     */
    /**
     * @param {RendererSender} sender
     * @returns {TapProxy}
     */
    /**
     * @param {RendererSender} sender
     * @returns {TapProxy}
     */
    function proxyFor(sender) {
      let proxy = /** @type {TapProxy | undefined} */ (proxies.get(sender))
      if (proxy) return proxy
      proxy = {
        isDestroyed: () => sender.isDestroyed(),
        /**
         * @param {string} name
         * @param {(...args: Array<unknown>) => void} cb
         */
        once: (name, cb) => sender.once(name, cb),
        /**
         * @param {string} channel
         * @param {unknown} event
         */
        send(channel, event) {
          const evt = /** @type {Record<string, unknown>} */ (event)
          const tap = taps.get(evt.id)
          if (tap) {
            if (evt.type === 'open') { tap.connected = true; updateConnection() }
            if (evt.type === 'message') {
              const visible = dispatch(evt.data, tap, tap.calls)
              if (!visible) return
              event = { ...evt, data: visible }
            }
            if (evt.type === 'close') {
              dropTap(evt.id, tap)
            }
          }
          if (!sender.isDestroyed()) sender.send(channel, event)
        },
      }
      proxies.set(sender, proxy)
      sender.once?.('destroyed', () => dropSender(sender))
      return proxy
    }
    return {
      /**
       * @param {RendererSender} sender
       * @param {unknown} payload
       */
      async open(sender, payload) {
        const proxy = proxyFor(sender)
        const body = /** @type {{id?: unknown, path?: unknown}} */ (payload)
        if (taps.has(body?.id)) throw new Error('serveSocket: id in use')
        /** @type {ServeTap} */
        const tap = {
          sender, connected: false, calls: new Map(), rendererRequests: new Set(), approvalRequests: new Map(),
          forward: (data) => sender.send('maia:serveSocketEvent', { id: body.id, type: 'message', data }),
          send(data) {
            const result = /** @type {{ok: unknown}} */ (broker.send(proxy, { id: body.id, data }))
            if (!result.ok) throw rpcError('disconnected', 'Chat socket is not open')
          },
          close: () => broker.close(proxy, { id: body.id }),
        }
        if (body?.path === '/api/ws') taps.set(/** @type {string} */ (body.id), tap)
        try {
          const result = /** @type {{ok: unknown}} */ (await broker.open(proxy, payload))
          if (!result.ok) dropTap(body.id, tap)
          return result
        } catch (err) { dropTap(body?.id, tap); throw err }
      },
      /**
       * @param {RendererSender} sender
       * @param {unknown} payload
       */
      send(sender, payload) {
        const body = /** @type {Record<string, unknown>} */ (payload)
        const tap = taps.get(body?.id)
        if (!tap || tap.sender !== sender || typeof body.data !== 'string' || body.data.length > MAX_FRAME_CHARS) {
          return { ok: false, error: 'invalid renderer frame' }
        }
        /** @type {Array<RpcFrame>} */
        let frames
        try { frames = body.data.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)) } catch {
          return { ok: false, error: 'invalid renderer frame' }
        }
        const ids = /** @type {Set<string>} */ (new Set())
        for (const frame of frames) {
          const id = String(frame?.id)
          if (!frame || frame.jsonrpc !== '2.0' || frame.id == null ||
              !['string', 'number'].includes(typeof frame.id) || id.length > 256 ||
              id.startsWith('hd_main_') || ids.has(id)) return { ok: false, error: 'invalid request id' }
          ids.add(id)
          if (frame.method) {
            const fp = /** @type {Record<string, unknown>} */ (frame.params)
            if (!rendererRpcAllowed(frame) || tap.calls.has(id) || tap.calls.size + frames.length > 1024) {
              return { ok: false, error: 'renderer RPC not allowed' }
            }
            if ((frame.method === 'session.context_breakdown' || (/** @type {string} */ (frame.method)).startsWith('subagent.') ||
                 frame.method === 'config.set' || (frame.method === 'model.options' && fp?.session_id !== undefined)) &&
                (typeof fp?.session_id !== 'string' || !profileName(fp?.profile) ||
                 sessions.get(fp.session_id) !== tap ||
                 replay.get(fp.session_id)?.profile !== fp.profile))
              return { ok: false, error: 'inspection/control requires an owned profile session' }
            if ((/** @type {string} */ (frame.method)).startsWith('subagent.') && frame.method !== 'subagent.list' &&
                (typeof fp?.subagent_id !== 'string' || !fp.subagent_id.trim() ||
                 fp.subagent_id.length > 256))
              return { ok: false, error: 'subagent id required' }
            if (frame.method === 'approval.respond' &&
                (sessions.get(fp?.session_id) !== tap ||
                 !['once', 'deny'].includes(/** @type {string} */ (fp?.choice)) ||
                 fp?.all !== undefined && fp.all !== false ||
                 fp?.profile && replay.get(fp.session_id)?.profile !== fp.profile)) {
              return { ok: false, error: 'approval requires an owned session and an individual decision' }
            }
            if (frame.method === 'subagent.steer' &&
                (typeof fp?.text !== 'string' || !fp.text.trim() || fp.text.length > 16384))
              return { ok: false, error: 'bounded steering text required' }
          } else if (!tap.rendererRequests.has(id) || Object.hasOwn(frame, 'error') ||
              Object.keys(frame).some((key) => !['jsonrpc', 'id', 'result'].includes(key))) {
            return { ok: false, error: 'renderer response not allowed' }
          }
        }
        if (!frames.length) return { ok: false, error: 'invalid renderer frame' }
        const forward = () => {
        if (!tap || taps.get(body?.id) !== tap || !tap.connected || sender.isDestroyed()) return { ok: false, error: 'renderer disconnected' }
        for (const frame of frames) {
          if (frame.method) tap.calls.set(String(frame.id), { method: /** @type {string} */ (frame.method), params: frame.params,
            turn: trackPrompt(frame.method, frame.params) })
          else {
            tap.rendererRequests.delete(String(frame.id))
            tap.approvalRequests.delete(String(frame.id))
          }
        }
        const result = broker.send(proxyFor(sender), payload)
        if (!result.ok) for (const frame of frames) {
          const entry = tap.calls.get(String(frame.id))
          if (entry) finishPrompt(entry, { error: true })
          tap.calls.delete(String(frame.id))
        }
        return result
        }
        const defaults = frames.filter(frame => frame.method === 'config.set' && parseModelSwitch(frame.params && typeof frame.params === 'object' ? /** @type {Record<string, unknown>} */ (frame.params).value : undefined)?.scope === 'global')
        if (defaults.length) {
          if (frames.length !== 1 || tap.approving) return { ok: false, error: 'one profile change at a time' }
          const firstParams = /** @type {Record<string, unknown>} */ (defaults[0].params)
          const parsed = parseModelSwitch(firstParams.value)
          if (!parsed) throw new Error('invalid renderer frame')
          const { model, provider } = parsed
          tap.approving = true
          return Promise.resolve().then(async () => {
            const allowed = await approveModelDefault(sender, { profile: firstParams.profile, model, provider })
            return allowed ? forward() : { ok: false, error: 'model default change cancelled' }
          }).finally(() => { tap.approving = false })
        }
        const approvals = frames.filter(frame => frame.method === 'approval.respond' || tap.approvalRequests.has(String(frame.id)))
        if (!approvals.length) return forward()
        if (frames.length !== 1 || tap.approving) return { ok: false, error: 'one approval at a time' }
        const frame = approvals[0]
        const serverRequest = tap.approvalRequests.get(String(frame.id))
        const choice = frame.method ? /** @type {Record<string, unknown>} */ (frame.params).choice : frame.result?.choice
        if (!['once', 'deny'].includes(/** @type {string} */ (choice)) || !frame.method &&
            (!frame.result || Object.keys(/** @type {Record<string, unknown>} */ (frame.result)).some(key => key !== 'choice'))) {
          return { ok: false, error: 'only individual approvals are allowed' }
        }
        if (choice === 'deny') return forward()
        tap.approving = true
        const fpAgain = /** @type {Record<string, unknown> | null} */ (frame.params)
        const sessionId = fpAgain?.session_id || /** @type {Record<string, unknown> | null} */ (serverRequest)?.session_id
        return Promise.resolve().then(async () => {
          if (typeof sessionId !== 'string' || sessions.get(sessionId) !== tap) return { ok: false, error: 'approval session unavailable' }
          // Obtain authoritative pending-command details, not renderer prose.
          let pending = serverRequest
          if (frame.method) {
            const snapshot = /** @type {{approvals?: unknown}} */ (await callOn(tap, 'approval.pending', { session_id: sessionId }))
            const candidates = snapshot?.approvals
            pending = Array.isArray(candidates) && (typeof frame.params?.request_id === 'string' && frame.params.request_id
              ? candidates.find((item) => /** @type {Record<string, unknown>} */ (item).request_id === frame.params?.request_id)
              : candidates.length === 1 ? candidates[0] : null)
            const completed = /** @type {{request_id?: unknown}} */ (pending && typeof pending === 'object' ? pending : null)
            if (typeof completed?.request_id !== 'string' || !completed.request_id || completed.request_id.length > 256) {
              return { ok: false, error: 'an individual pending request is required' }
            }
            frame.params = { ...(frame.params ?? {}), request_id: completed.request_id, all: false }
          }
          const detail = JSON.stringify(pending)
          if (!detail || detail.length > 4000) return { ok: false, error: 'approval details unavailable' }
          const allowed = await approveRendererAction(sender, { sessionId, choice, detail })
          if (!allowed || sessions.get(sessionId) !== tap ||
              serverRequest && tap.approvalRequests.get(String(frame.id)) !== serverRequest) {
            return { ok: false, error: 'approval cancelled' }
          }
          if (frame.method) {
            const current = /** @type {{approvals?: Array<{request_id?: unknown}>}} */ (await callOn(tap, 'approval.pending', { session_id: sessionId }))
            const wanted = /** @type {{request_id?: unknown} | null | undefined} */ (pending)
            if (JSON.stringify(current?.approvals?.find(item => item.request_id === wanted?.request_id)) !== detail) {
              return { ok: false, error: 'pending approval changed' }
            }
            payload = { .../** @type {Record<string, unknown>} */ (payload), data: JSON.stringify(frame) }
          }
          return forward()
        }).catch(() => ({ ok: false, error: 'approval unavailable' })).finally(() => { tap.approving = false })
      },
      /**
       * @param {RendererSender} sender
       * @param {unknown} payload
       */
      close: (sender, payload) => broker.close(proxyFor(sender), payload),
      /**
       * @param {RendererSender} sender
       */
      closeAllFor(sender) { dropSender(sender); return broker.closeAllFor(proxyFor(sender)) },
    }
  }

  return {
    get connected() { return connected() },
    call,
    /**
     * @param {unknown} runtimeId
     * @param {unknown} profile
     * @returns {boolean}
     */
    hasSession: (runtimeId, profile) => {
      const transport = sessions.get(runtimeId)
      return Boolean(transport && (transport === socket ? socket?.readyState === 1 : transport.connected) &&
        replay.get(runtimeId)?.profile === profile)
    },
    getActiveTurns: () => [...activeTurns].map(([session_id, turn]) => ({ session_id,
      ...(turn.profile ? { profile: turn.profile } : {}) })),
    /**
     * @param {object} ref
     * @param {unknown} [ref.profile]
     * @param {unknown} [ref.storedId]
     * @param {unknown} [ref.runtimeId]
     * @param {unknown} sender
     */
    assertRendererSession({ profile, storedId, runtimeId }, sender) {
      const transport = sessions.get(runtimeId)
      const entry = replay.get(runtimeId)
      if (!transport?.connected || transport.sender !== sender || entry?.profile !== profile || entry?.storedId !== storedId) {
        throw rpcError('bad_args', 'Session is not attached to this renderer socket')
      }
    },
    /**
     * @param {(method: unknown, params: unknown, options: {signal: AbortSignal, profile: unknown}) => Promise<unknown>} handler
     */
    setSecureRequestHandler(handler) {
      secureRequestHandler = handler
      return () => { if (secureRequestHandler === handler) secureRequestHandler = null }
    },
    /**
     * @param {unknown} method
     * @param {unknown} [params]
     */
    notify(method, params = {}) { sendFrame(transportFor(method, params), { jsonrpc: '2.0', method, params }) },
    /**
     * @param {unknown} nameOrCb
     * @param {((params: unknown) => void) | undefined} [handler]
     */
    onEvent(nameOrCb, handler) {
      /** @type {(name: unknown, params: unknown) => void} */
      const cb = typeof nameOrCb === 'function' ? /** @type {(name: unknown, params: unknown) => void} */ (nameOrCb)
        : (name, params) => { if (name === nameOrCb) /** @type {(params: unknown) => void} */ (handler)(params) }
      events.add(cb)
      return () => events.delete(cb)
    },
    /**
     * @param {string} method
     * @param {(params: unknown) => unknown} handler
     */
    onRequest(method, handler) {
      requests.set(method, handler)
      if (socket?.readyState === 1) void callOn(socket, 'client.capabilities', { server_requests: true }).catch(() => {})
      for (const tap of taps.values()) {
        if (tap.connected) void callOn(tap, 'client.capabilities', { server_requests: true }).catch(() => {})
      }
      return () => { if (requests.get(method) === handler) requests.delete(method) }
    },
    /**
     * @param {(connected: boolean) => void} cb
     */
    onConnection(cb) { connections.add(cb); return () => connections.delete(cb) },
    /**
     * @param {unknown} baseUrl
     * @param {unknown} auth
     */
    setEndpoint(baseUrl, auth) {
      const next = { baseUrl: loopbackBaseUrl(baseUrl), auth: { .../** @type {Record<string, unknown>} */ (auth) } }
      stop()
      endpoint = next
      retryMs = 1000
      running = true
      connect()
    },
    stop,
    bindRendererBroker,
  }
}

module.exports = { createServeClient, loopbackBaseUrl, isSecureRequest, rendererRpcAllowed }
