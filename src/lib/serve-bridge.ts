/**
 * Renderer side of the `hermes serve` auth split (#161).
 *
 * The dashboard session token lives in the Electron main process only:
 *   - `serveConfig()` reports presence + base URL, never the token;
 *   - main attaches `X-Hermes-Session-Token` to serve REST requests from
 *     this window itself (electron/serve-auth.cjs), so bridge-derived
 *     connections carry `token: ''` and send no auth header;
 *   - serve WebSockets are opened by main and relayed (`serveSocket`).
 *
 * An explicit token (tests, non-Electron callers that already hold one) is
 * still honored: it rides the header / `?token=` exactly as before.
 */

import { isLocalHermesServeUrl } from './maiavm-api'

export interface ServeBridgeConnection {
  /** base URL like http://127.0.0.1:9119 */
  baseUrl: string
  /** Empty for bridge-derived connections — main attaches the credential. */
  token: string
}

/** Resolve the local serve endpoint via the desktop bridge (presence only). */
export async function serveBridgeConnection(): Promise<ServeBridgeConnection | null> {
  const cfg = typeof window !== 'undefined' ? window.nubAgent?.serveConfig : undefined
  if (!cfg) return null
  try {
    const c = await cfg()
    if (c?.present && typeof c.baseUrl === 'string' && isLocalHermesServeUrl(c.baseUrl)) {
      return { baseUrl: c.baseUrl.replace(/\/+$/, ''), token: '' }
    }
  } catch {
    /* bridge failed — caller falls back */
  }
  return null
}

/** Auth header for an explicit token; `{}` when main attaches it. */
export function serveTokenHeader(token: string | undefined): Record<string, string> {
  return token ? { 'X-Hermes-Session-Token': token } : {}
}

/** The WebSocket surface the serve clients use (native or main-relayed). */
export interface ServeSocketLike {
  readonly readyState: number
  send(data: string): void | Promise<void>
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (ev: Event) => void, opts?: AddEventListenerOptions | boolean): void
  removeEventListener(type: string, listener: (ev: Event) => void): void
}

export const SOCKET_CONNECTING = 0
export const SOCKET_OPEN = 1
export const SOCKET_CLOSED = 3

type ServeSocketEvent = {
  id: string
  type: 'open' | 'message' | 'error' | 'close'
  data?: string
  code?: number
  reason?: string
}

let socketSeq = 0
function newSocketId(): string {
  const rand = globalThis.crypto?.randomUUID?.().replace(/-/g, '') ?? Math.random().toString(36).slice(2)
  socketSeq += 1
  return `s${socketSeq}_${rand}`.slice(0, 64)
}

/**
 * WebSocket-shaped handle over the main-process relay. Events mirror the
 * native ones: open → message* → (error) → close.
 */
type ServeSocketRelay = NonNullable<NonNullable<Window['nubAgent']>['serveSocket']>

class RelayedServeSocket extends EventTarget implements ServeSocketLike {
  private state = SOCKET_CONNECTING
  private readonly id = newSocketId()
  private readonly bridge: ServeSocketRelay
  private unsubscribe: (() => void) | null = null
  private offHost: (() => void) | null = null
  /** Settles once main has handled the open (a close must not overtake it). */
  private readonly opened: Promise<unknown>

  constructor(bridge: ServeSocketRelay, path: string, query: Record<string, string>) {
    super()
    this.bridge = bridge
    // Subscribe BEFORE asking main to open, so no event can be missed.
    this.unsubscribe = bridge.onEvent((ev: ServeSocketEvent) => {
      if (ev?.id === this.id) this.handle(ev)
    })
    // Relays open against main's current endpoint, not the client's cached URL.
    // Closing on a host restart also triggers the transport's normal reconnect.
    this.opened = serveBridgeConnection().then(() => {
      if (this.state === SOCKET_CLOSED) return
      return bridge.open({ id: this.id, path, query }).then(
        (res) => { if (!res?.ok) this.fail() },
        () => this.fail(),
      )
    })
    const host = window.nubAgent?.host
    // serveConfig exposes the REST proxy port, not Hermes's socket port.
    // Main closes the broker itself when the actual endpoint changes.
    this.offHost = host?.onStatus(status => {
      if (this.state === SOCKET_CLOSED) return
      if (status.serve.state !== 'up') {
        this.close(1012, 'Local host restarting')
        this.finish(1012, 'Local host restarting')
      }
    }) ?? null
    if (this.state === SOCKET_CLOSED) { this.offHost?.(); this.offHost = null }
  }

  get readyState(): number {
    return this.state
  }

  send(data: string): Promise<void> {
    if (this.state !== SOCKET_OPEN) throw new Error('serve socket not open')
    return this.bridge.send(this.id, data).then((result) => {
      if (result?.ok) return
      this.fail()
      throw new Error('Hermes relay send failed')
    }, () => {
      this.fail()
      throw new Error('Hermes relay send failed')
    })
  }

  close(code?: number, reason?: string): void {
    if (this.state === SOCKET_CLOSED) return
    void this.opened.then(() => this.bridge.close(this.id, code, reason)).catch(() => {})
  }

  private handle(ev: ServeSocketEvent): void {
    if (this.state === SOCKET_CLOSED) return
    if (ev.type === 'open') {
      this.state = SOCKET_OPEN
      this.dispatchEvent(new Event('open'))
    } else if (ev.type === 'message') {
      this.dispatchEvent(new MessageEvent('message', { data: ev.data ?? '' }))
    } else if (ev.type === 'error') {
      this.dispatchEvent(new Event('error'))
    } else if (ev.type === 'close') {
      this.finish(ev.code, ev.reason)
    }
  }

  /** Open refused (no token, path, cap) — surface it like a failed connect. */
  private fail(): void {
    if (this.state === SOCKET_CLOSED) return
    this.dispatchEvent(new Event('error'))
    this.finish(1006, '')
  }

  private finish(code?: number, reason?: string): void {
    if (this.state === SOCKET_CLOSED) return
    this.state = SOCKET_CLOSED
    this.unsubscribe?.()
    this.unsubscribe = null
    this.offHost?.()
    this.offHost = null
    this.dispatchEvent(Object.assign(new Event('close'), { code: code ?? 1005, reason: reason ?? '' }))
  }
}

/**
 * Open a serve WebSocket. With no explicit token and the desktop relay
 * present, main opens it (token never enters the renderer); otherwise a
 * native WebSocket with `?token=` when one was given.
 */
export function openServeSocket(
  conn: ServeBridgeConnection,
  path: string,
  query: Record<string, string> = {},
): ServeSocketLike {
  if (!isLocalHermesServeUrl(conn.baseUrl)) throw new Error('serve must be on loopback')
  const relay = typeof window !== 'undefined' ? window.nubAgent?.serveSocket : undefined
  if (!conn.token && relay) return new RelayedServeSocket(relay, path, query)
  if (!conn.token) throw new Error('serve requires the main-process socket relay')
  const base = new URL(conn.baseUrl.replace(/\/+$/, ''))
  const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:'
  const qs = new URLSearchParams()
  if (conn.token) qs.set('token', conn.token)
  for (const [k, v] of Object.entries(query)) qs.set(k, v)
  return new WebSocket(`${scheme}//${base.host}${path}?${qs.toString()}`)
}
