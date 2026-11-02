/** Owns one loopback gateway connection, its subscriptions and reconnect timer. */
import {
  HermesServeClient, resolveServeConnection, type ServeConnection,
  type ServeEvent, type ServeServerRequest,
} from '../hermes-serve'
import { isLocalHermesServeUrl } from '../maiavm-api'

export const LOCAL_SERVE_OFFLINE = 'Hermes serve offline — Retry / Diagnostics'

interface ConnectionHooks {
  event(event: ServeEvent): void
  request(request: ServeServerRequest): void
  connection(state: 'connecting' | 'online' | 'offline'): void
  reconnect(): Promise<void>
}

export class LocalGatewayConnection {
  private options: { baseUrl?: string; token?: string }
  private hooks: ConnectionHooks
  private current: HermesServeClient | null = null
  private connecting: Promise<HermesServeClient> | null = null
  private seenOpen = false
  private disposed = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = 1000
  private releases: (() => void)[] = []

  constructor(options: { baseUrl?: string; token?: string }, hooks: ConnectionHooks) {
    this.options = options
    this.hooks = hooks
  }

  get client(): HermesServeClient | null { return this.current }
  get readOnly(): boolean { return this.current?.connectionState !== 'open' }

  ensureClient(): Promise<HermesServeClient> {
    if (this.disposed) return Promise.reject(new Error('Transport disposed'))
    if (this.current?.connectionState === 'open') return Promise.resolve(this.current)
    if (this.connecting) return this.connecting
    const attempt = this.connect()
    this.connecting = attempt
    const cleanup = () => { if (this.connecting === attempt) this.connecting = null }
    void attempt.then(cleanup, cleanup)
    return attempt
  }

  private async connect(): Promise<HermesServeClient> {
    this.hooks.connection('connecting')
    try {
      if (!this.current) {
        const connection: ServeConnection | null = this.options.baseUrl
          ? { baseUrl: this.options.baseUrl, token: this.options.token ?? '' }
          : await resolveServeConnection()
        if (this.disposed) throw new Error('Transport disposed')
        if (!connection || !isLocalHermesServeUrl(connection.baseUrl)) throw new Error(LOCAL_SERVE_OFFLINE)
        const client = new HermesServeClient(connection)
        this.current = client
        this.releases.push(client.onAny(event => this.hooks.event(event)))
        for (const method of ['approval', 'clarify', 'secret', 'sudo']) {
          this.releases.push(client.onRequest(method, request => this.hooks.request(request)))
        }
        this.releases.push(client.onState(state => {
          if (this.disposed) return
          if (state === 'open') {
            this.hooks.connection('online')
            this.retryDelay = 1000
            if (this.retryTimer) clearTimeout(this.retryTimer)
            this.retryTimer = null
            if (this.seenOpen) void this.hooks.reconnect().catch(() => this.scheduleReconnect())
            this.seenOpen = true
          } else if (state === 'closed' || state === 'error') {
            this.hooks.connection('offline')
            this.scheduleReconnect()
          }
        }))
      }
      await this.current.connect()
      return this.current
    } catch (error) {
      this.hooks.connection('offline')
      this.scheduleReconnect()
      throw error
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.ensureClient().catch(() => this.scheduleReconnect())
    }, this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000)
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    for (const release of this.releases.splice(0)) release()
    this.current?.close()
  }
}
