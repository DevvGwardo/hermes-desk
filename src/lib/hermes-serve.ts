/**
 * Typed JSON-RPC/WS client for `hermes serve` (port 9119 default).
 *
 * Frozen protocol (see docs/HERMES_SERVE_PROTOCOL.md):
 *   - newline-delimited JSON-RPC 2.0 over WebSocket at `/api/ws`
 *   - auth: `?token=<session token>` on loopback; `?ticket=` in gated mode.
 *     On desktop the Electron main process opens the socket and adds the
 *     token itself (serve-bridge.ts) — the renderer never holds it.
 *   - server pushes `gateway.ready` on accept, then responses + events
 *   - events: `{"jsonrpc":"2.0","method":"event","params":{type, session_id, payload}}`
 *
 * `window.nubAgent.serveConfig()` reports presence only; the token stays in
 * the Electron main process (#161).
 */
import { openServeSocket, serveBridgeConnection, SOCKET_OPEN, type ServeSocketLike } from './serve-bridge'


export type ServeEventName =
  | 'gateway.ready'
  | 'session.info'
  | 'message.start'
  | 'message.delta'
  | 'message.interim'
  | 'message.complete'
  | 'thinking.delta'
  | 'reasoning.delta'
  | 'status.update'
  | 'tool.start'
  | 'tool.progress'
  | 'tool.complete'
  | 'tool.generating'
  | 'clarify.request'
  | 'approval.request'
  | 'sudo.request'
  | 'secret.request'
  | 'secret.expire'
  | 'clarify.expire'
  | 'mcp.setup.request'
  | 'mcp.setup.expire'
  | 'background.complete'
  | 'subagent.spawn_requested'
  | 'subagent.start'
  | 'subagent.thinking'
  | 'subagent.tool'
  | 'subagent.progress'
  | 'subagent.complete'
  | 'error'
  | 'skin.changed'
  | 'pet.changed'
  | 'cron.changed'
  | 'sessions.changed'
  | 'message.reaction'
  | (string & {})

export interface ServeEvent<P = unknown> {
  type: ServeEventName
  session_id?: string
  payload?: P
  seq?: number
}

export interface ServeServerRequest {
  id: string | number
  method: string
  params: Record<string, unknown>
}

export class ServeRpcError extends Error {
  readonly code?: number
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'ServeRpcError'
    this.code = code
  }
}

export interface ServeMessageDelta {
  text: string
  rendered?: string
}

export interface ServeMessageComplete {
  text: string
  usage?: Record<string, unknown>
  status?: string
  error?: string
  partial?: boolean
  rendered?: string
}

export interface ServeToolEvent {
  tool_id?: string
  name: string
  args?: Record<string, unknown>
  args_text?: string
  result?: unknown
  duration_s?: number
  summary?: string
  todos?: unknown[]
  inline_diff?: string
}

/** Gateway `subagent.*` payload (relayed on the parent session id). */
export interface ServeSubagentEvent {
  goal?: string
  subagent_id?: string
  child_session_id?: string
  parent_id?: string
  task_index?: number
  task_count?: number
  status?: string
  summary?: string
  text?: string
  tool_name?: string
  tool_preview?: string
  duration_seconds?: number
}

export interface ServeApprovalRequest {
  command?: string
  description?: string
  choices?: string[]
  /** Grok-widget question chips (A1) — raw payload, normalized by parseApprovalOptions. */
  options?: unknown
  kind?: unknown
  smart_denied?: boolean
  allow_permanent?: boolean
  pattern_key?: string
}

export interface ServeSessionInfo {
  model?: string
  provider?: string
  reasoning_effort?: string
  fast?: boolean
  yolo?: boolean
  approval_mode?: string
  tools?: Record<string, unknown>
  skills?: Record<string, unknown>
  cwd?: string
  branch?: string
  project?: Record<string, unknown>
  personality?: string
  running?: boolean
  title?: string
  stored_session_id?: string
  desktop_contract?: number
  usage?: Record<string, unknown>
  profile_name?: string
}

export interface ServeSessionRow {
  id: string
  title: string
  preview: string
  started_at: number
  message_count: number
  source: string
}

export interface ServeConnection {
  /** base URL like http://127.0.0.1:9119 */
  baseUrl: string
  /** Empty for desktop-bridge connections (main attaches the credential). */
  token: string
}

/** Resolve serve config via the Electron bridge; null in a plain browser. */
export async function resolveServeConnection(): Promise<ServeConnection | null> {
  // No token is available in a plain browser; serve mode needs the desktop
  // bridge for auth. Callers detect null and fall back to api/mock.
  return serveBridgeConnection()
}

export interface HermesServeClientOpts {
  baseUrl: string
  token: string
  /** WS path (default /api/ws). */
  path?: string
  requestTimeoutMs?: number
  connectTimeoutMs?: number
}

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Minimal newline-delimited JSON-RPC 2.0 client over WebSocket — mirrors the
 * official @hermes/shared JsonRpcGatewayClient dialect (see apps/shared/src/
 * json-rpc-gateway.ts) without the package dependency.
 */
export class HermesServeClient {
  private ws: ServeSocketLike | null = null
  private nextId = 0
  private pending = new Map<string, PendingCall>()
  private eventHandlers = new Map<string, Set<(event: ServeEvent) => void>>()
  private stateHandlers = new Set<(state: 'idle' | 'connecting' | 'open' | 'closed' | 'error') => void>()
  private state: 'idle' | 'connecting' | 'open' | 'closed' | 'error' = 'idle'
  private connecting: Promise<void> | null = null
  private requestHandlers = new Map<string, (request: ServeServerRequest) => void>()
  private opts: Required<Omit<HermesServeClientOpts, 'path'>> & { path: string }

  constructor(opts: HermesServeClientOpts) {
    this.opts = {
      baseUrl: opts.baseUrl,
      token: opts.token,
      requestTimeoutMs: opts.requestTimeoutMs ?? 120_000,
      connectTimeoutMs: opts.connectTimeoutMs ?? 15_000,
      path: opts.path ?? '/api/ws',
    }
  }

  get connectionState(): 'idle' | 'connecting' | 'open' | 'closed' | 'error' {
    return this.state
  }

  connect(): Promise<void> {
    if (this.state === 'open') return Promise.resolve()
    if (this.connecting) return this.connecting
    const attempt = this.connectSocket()
    this.connecting = attempt
    const cleanup = () => { if (this.connecting === attempt) this.connecting = null }
    void attempt.then(cleanup, cleanup)
    return attempt
  }

  private async connectSocket(): Promise<void> {
    this.setState('connecting')
    const socket = openServeSocket({ baseUrl: this.opts.baseUrl, token: this.opts.token }, this.opts.path.startsWith('/') ? this.opts.path : `/${this.opts.path}`)
    this.ws = socket
    socket.addEventListener('message', (msg) => {
      if (this.ws === socket) this.handleMessage((msg as MessageEvent).data as string)
    })
    socket.addEventListener('close', () => {
      if (this.ws !== socket) return
      this.ws = null
      this.setState('closed')
      this.rejectAllPending(new Error('WebSocket closed'))
    })
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('close', onClose)
      }
      const onOpen = () => {
        if (settled || this.ws !== socket) return
        settled = true
        cleanup()
        this.setState('open')
        resolve()
      }
      const onError = () => {
        if (settled || this.ws !== socket) return
        settled = true
        cleanup()
        socket.close()
        this.ws = null
        this.setState('error')
        reject(new Error('WebSocket connection failed'))
      }
      const onClose = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error('WebSocket closed before connecting'))
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        if (this.ws === socket) {
          try {
            socket.close()
          } catch {
            /* ignore */
          }
          this.ws = null
        }
        this.setState('error')
        reject(new Error('WebSocket connect timed out'))
      }, this.opts.connectTimeoutMs)
      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })
      socket.addEventListener('close', onClose, { once: true })
    })
  }

  close(): void {
    const socket = this.ws
    if (socket) {
      try {
        socket.close()
      } catch {
        /* ignore */
      }
    }
    this.ws = null
    this.setState('closed')
    this.rejectAllPending(new Error('client closed'))
  }

  on<P = unknown>(type: ServeEventName, handler: (event: ServeEvent<P>) => void): () => void {
    let set = this.eventHandlers.get(type)
    if (!set) {
      set = new Set()
      this.eventHandlers.set(type, set)
    }
    const h = handler as (event: ServeEvent) => void
    set.add(h)
    return () => {
      set.delete(h)
    }
  }

  onAny(handler: (event: ServeEvent) => void): () => void {
    return this.on('*' as ServeEventName, handler)
  }

  onState(handler: (state: 'idle' | 'connecting' | 'open' | 'closed' | 'error') => void): () => void {
    this.stateHandlers.add(handler)
    handler(this.state)
    return () => {
      this.stateHandlers.delete(handler)
    }
  }

  onRequest(method: string, handler: (request: ServeServerRequest) => void): () => void {
    this.requestHandlers.set(method, handler)
    return () => {
      if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method)
    }
  }

  respond(id: string | number, result: unknown): Promise<void> {
    if (!this.ws || this.ws.readyState !== SOCKET_OPEN) throw new Error('gateway not connected')
    return Promise.resolve(this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result })))
  }

  respondError(id: string | number, code: number, message: string): void {
    if (!this.ws || this.ws.readyState !== SOCKET_OPEN) throw new Error('gateway not connected')
    void Promise.resolve(this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))).catch(() => {})
  }

  /** Re-deliver a still-open question after session.resume / replay. */
  dispatchRequest(request: ServeServerRequest): void {
    const handler = this.requestHandlers.get(request.method)
    if (!handler) {
      this.respondError(request.id, -32601, 'Unsupported server request')
      return
    }
    try {
      handler(request)
    } catch {
      this.respondError(request.id, -32603, 'Server request handler failed')
    }
  }

  request<T>(method: string, params: object = {}, timeoutMs?: number): Promise<T> {
    const socket = this.ws
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      return Promise.reject(new Error('gateway not connected'))
    }
    const id = `w${++this.nextId}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`request timed out after ${Math.round((timeoutMs ?? this.opts.requestTimeoutMs) / 1000)}s: ${method}`))
        }
      }, timeoutMs ?? this.opts.requestTimeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      const fail = (err: unknown) => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
      try {
        void Promise.resolve(socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))).catch(fail)
      } catch (err) {
        fail(err)
      }
    })
  }

  private handleMessage(raw: unknown): void {
    const text = typeof raw === 'string' ? raw : String(raw)
    for (const line of text.split('\n')) {
      if (line.trim()) this.handleFrame(line)
    }
  }

  private handleFrame(text: string): void {
    let frame: { id?: string | number; method?: string; params?: ServeEvent | Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string } }
    try {
      frame = JSON.parse(text) as typeof frame
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return
    if (frame.id !== undefined && frame.id !== null) {
      if (frame.method) {
        this.dispatchRequest({
          id: frame.id,
          method: frame.method,
          params: (frame.params ?? {}) as Record<string, unknown>,
        })
        return
      }
      const call = this.pending.get(String(frame.id))
      if (call) {
        this.pending.delete(String(frame.id))
        clearTimeout(call.timer)
        if (frame.error) {
          call.reject(new ServeRpcError(frame.error.message ?? `RPC error ${frame.error.code ?? ''}`, frame.error.code))
        } else {
          call.resolve(frame.result)
        }
      }
      return
    }
    if (frame.method === 'event' && frame.params) {
      const ev = frame.params as ServeEvent
      const handlers = this.eventHandlers.get(ev.type)
      if (handlers) {
        for (const h of [...handlers]) {
          try {
            h(ev)
          } catch {
            /* subscriber errors are isolated */
          }
        }
      }
      const anyHandlers = this.eventHandlers.get('*')
      if (anyHandlers) {
        for (const h of [...anyHandlers]) {
          try {
            h(ev)
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer)
      call.reject(err)
    }
    this.pending.clear()
  }

  private setState(s: 'idle' | 'connecting' | 'open' | 'closed' | 'error'): void {
    this.state = s
    for (const h of [...this.stateHandlers]) {
      try {
        h(s)
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Typed method helpers (frozen from tui_gateway/methods_*.py)
// ---------------------------------------------------------------------------

export interface SessionCreateParams {
  messages?: { role: string; content: string }[]
  title?: string
  model?: string
  provider?: string
  reasoning_effort?: string
  fast?: boolean
  cwd?: string
  profile?: string
  parent_session_id?: string
  source?: string
  cols?: number
}

export interface SessionCreateResult {
  session_id: string
  stored_session_id: string
  message_count: number
  messages: unknown[]
  info: ServeSessionInfo
}

/** Create a session; returns {session_id, info, messages}. */
export async function serveCreateSession(
  client: HermesServeClient,
  params: SessionCreateParams = {},
): Promise<SessionCreateResult> {
  return client.request<SessionCreateResult>('session.create', params)
}

export interface ServePromptSubmitParams {
  session_id: string
  profile?: string
  text: string
  queued?: boolean
  surface?: string
}

/** Submit a prompt; the turn streams back as events on the client. */
export async function servePromptSubmit(
  client: HermesServeClient,
  params: ServePromptSubmitParams,
): Promise<{ ok: boolean }> {
  return client.request<{ ok: boolean }>('prompt.submit', params)
}

/** List sessions (denies kanban/tool sources server-side). */
export async function serveListSessions(
  client: HermesServeClient,
  params: { limit?: number; profile?: string } = {},
): Promise<{ sessions: ServeSessionRow[] }> {
  return client.request<{ sessions: ServeSessionRow[] }>('session.list', params)
}


/** Interrupt the current turn. */
export async function serveInterrupt(
  client: HermesServeClient,
  sessionId: string,
): Promise<unknown> {
  return client.request('session.interrupt', { session_id: sessionId })
}

/** Live `delegate_task` children for this Hermes process. */
export async function serveDelegationStatus(
  client: HermesServeClient,
): Promise<{
  active?: { subagent_id?: string; goal?: string; status?: string; child_session_id?: string }[]
  paused?: boolean
  max_spawn_depth?: number
  max_concurrent_children?: number
}> {
  return client.request('delegation.status', {})
}

/** Grok StopSubagent analogue — interrupt one live `delegate_task` child. */
export async function serveSubagentInterrupt(
  client: HermesServeClient,
  subagentId: string,
): Promise<{ found?: boolean; subagent_id?: string }> {
  return client.request('subagent.interrupt', { subagent_id: subagentId })
}

/**
 * Grok MessageSubagent analogue for a live child — queue text at the next
 * iteration boundary without cutting the in-flight tool call.
 */
export async function serveSubagentSteer(
  client: HermesServeClient,
  params: { subagent_id: string; text: string; session_id?: string },
): Promise<{ status?: string; subagent_id?: string }> {
  return client.request('subagent.steer', params)
}

/** Resolve a pending `approval.request` (Hermes dangerous-command gate). */
export async function serveApprovalRespond(
  client: HermesServeClient,
  params: { session_id: string; choice: string; all?: boolean },
): Promise<{ resolved: number }> {
  return client.request<{ resolved: number }>('approval.respond', params)
}

// ---------------------------------------------------------------------------
// Blocking in-chat prompts (tui_gateway `_block` + methods_prompt late-answer RPCs)
//   secret.request    → secret.respond    {request_id, value}   ('' = skip)
//   clarify.request   → clarify.respond   {request_id, answer, question_id?}
//   mcp.setup.request → mcp.setup.respond {request_id, result}  (JSON outcome)
// Every respond tolerates a late answer ({status:'expired'}) server-side.
// ---------------------------------------------------------------------------

/** `secret.request` payload (tui_gateway/agent_callbacks.py secret_cb). */
export interface ServeSecretRequest {
  request_id?: string
  env_var?: string
  prompt?: string
  metadata?: { skill_name?: string; help?: string; required_for?: string }
}

/** `clarify.request` payload — single question, or a batch with `questions`. */
export interface ServeClarifyRequest {
  request_id?: string
  question?: string
  choices?: string[] | null
  multi_select?: boolean
  questions?: { qid: string; question: string; choices?: string[] | null; multi_select?: boolean }[]
}

/** `mcp.setup.request` payload (setup_mcp tool, desktop sessions only). */
export interface ServeMcpSetupRequest {
  request_id?: string
  server?: string
  action?: string
  reason?: string
}

export type ServeRespondResult = { status?: 'ok' | 'expired' | string; remaining?: string[] }

/**
 * Answer a `secret.request`. `value: ''` skips. The value goes straight onto
 * the wire — callers must never log, store or echo it.
 */
export async function serveSecretRespond(
  client: HermesServeClient,
  params: { request_id: string; value: string },
): Promise<ServeRespondResult> {
  return client.request<ServeRespondResult>('secret.respond', params)
}

/** Answer a `clarify.request` (`question_id` for one question of a batch; `answer: ''` cancels). */
export async function serveClarifyRespond(
  client: HermesServeClient,
  params: { request_id: string; answer: string; question_id?: string },
): Promise<ServeRespondResult> {
  return client.request<ServeRespondResult>('clarify.respond', params)
}

/** Answer a `mcp.setup.request` with the JSON-encoded outcome the setup_mcp tool expects. */
export async function serveMcpSetupRespond(
  client: HermesServeClient,
  params: { request_id: string; result: string },
): Promise<ServeRespondResult> {
  return client.request<ServeRespondResult>('mcp.setup.respond', params)
}

/** Reload MCP servers into a live session after a setup card changed mcp_servers. */
export async function serveReloadMcp(
  client: HermesServeClient,
  sessionId?: string,
): Promise<unknown> {
  return client.request('reload.mcp', { confirm: true, ...(sessionId ? { session_id: sessionId } : {}) })
}

export type ServeApprovalMode = 'ask' | 'smart' | 'yolo'

/** Map Maia Settings pills onto Hermes `/approvals manual|smart|off`. */
export function approvalModeToCommand(mode: ServeApprovalMode): { name: string; arg: string } {
  if (mode === 'yolo') return { name: 'approvals', arg: 'off' }
  if (mode === 'smart') return { name: 'approvals', arg: 'smart' }
  return { name: 'approvals', arg: 'manual' }
}

export async function serveSetApprovalMode(
  client: HermesServeClient,
  mode: ServeApprovalMode,
  sessionId?: string,
): Promise<Record<string, unknown>> {
  const cmd = approvalModeToCommand(mode)
  return serveDispatchCommand(client, { ...cmd, session_id: sessionId })
}

export interface ServeMessageReactParams {
  session_id: string
  row_id?: number
  newest_role?: 'user' | 'assistant'
  emoji: string | null
  author?: 'user' | 'agent'
}

export interface ServeMessageReactResult {
  row_id: number
  reactions: { emoji: string; author: 'user' | 'agent'; at?: number }[]
}

/** Hermes `message.react` — iOS tapback on a persisted row. */
export async function serveMessageReact(
  client: HermesServeClient,
  params: ServeMessageReactParams,
): Promise<ServeMessageReactResult> {
  return client.request<ServeMessageReactResult>('message.react', params)
}

/** Flip `display.message_reactions` so the model hears tapbacks + can react back. */
export async function serveSetMessageReactions(
  client: HermesServeClient,
  enabled: boolean,
): Promise<unknown> {
  return client.request('config.set', {
    key: 'display.message_reactions',
    value: enabled ? 'true' : 'false',
  })
}

/** Dispatch a slash command (name without leading /). */
export async function serveDispatchCommand(
  client: HermesServeClient,
  params: { name: string; arg?: string; session_id?: string },
): Promise<Record<string, unknown>> {
  return client.request<Record<string, unknown>>('command.dispatch', params)
}

// ---------------------------------------------------------------------------
// Probe + shared singleton helper
// ---------------------------------------------------------------------------

/** Quick health probe: true when /api/health answers (serve is up). */
export async function probeServe(baseUrl: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/health`, {
      signal: ctrl.signal,
      credentials: 'omit',
    })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}
