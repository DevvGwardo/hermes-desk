/**
 * Hermes gateway "Connections" — messaging platform setup over the dashboard
 * REST (`hermes_cli/web_routers/messaging.py`). Replaces `hermes gateway setup`:
 * credentials land in the agent's `.env`, `platforms.<id>.enabled` in
 * config.yaml, then the gateway restarts to pick them up.
 *
 * Secret values only travel renderer → dashboard; the catalog echoes back
 * `is_set` + a redacted preview, never the value.
 */

import { serveGetDetailed, serveSend, type ServeSendResult } from './hermes-rest'
import { restFailureText } from './agent-rest'

export interface MessagingEnvVar {
  key: string
  required: boolean
  is_set: boolean
  redacted_value?: string | null
  /** Plain value; newer agents send it only for non-secret keys (allowlists, home chats, ports). */
  value?: string | null
  description?: string
  prompt?: string
  help?: string
  url?: string | null
  is_password?: boolean
  advanced?: boolean
}

/** Runtime state from gateway_state.json, as normalised by the dashboard. */
export type MessagingState =
  | 'connected'
  | 'connecting'
  | 'retrying'
  | 'disconnected'
  | 'paused'
  | 'disabled'
  | 'not_configured'
  | 'pending_restart'
  | 'gateway_stopped'
  | 'startup_failed'
  | 'error'
  | 'fatal'
  | (string & {})

export interface MessagingPlatform {
  id: string
  name: string
  description?: string
  docs_url?: string
  enabled: boolean
  configured: boolean
  gateway_running: boolean
  state: MessagingState
  error_code?: string | null
  error_message?: string | null
  home_channel?: unknown
  env_vars: MessagingEnvVar[]
  /**
   * Newer agents: hidden per-platform setup keys (allow-all switch, real home
   * var, …). PUT /api/messaging/platforms/{id} accepts keys from both lists.
   */
  extra_env_vars?: MessagingEnvVar[]
}

export interface MessagingCatalog {
  platforms: MessagingPlatform[]
}

export type CatalogResult =
  | { kind: 'ok'; platforms: MessagingPlatform[] }
  /** Agent answered 404: its Hermes predates the messaging API. */
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

export async function listMessagingPlatforms(): Promise<CatalogResult> {
  const res = await serveGetDetailed<MessagingCatalog>('/api/messaging/platforms')
  if (res.data && Array.isArray(res.data.platforms)) {
    return { kind: 'ok', platforms: res.data.platforms }
  }
  if (res.status === 404) return { kind: 'unsupported' }
  const kind = res.error?.kind
  if (kind === 'unauthorized') return { kind: 'error', message: 'This device needs to be re-linked (Settings → General).' }
  if (kind === 'not-ready') return { kind: 'error', message: 'Your agent is still starting up. Try again in a minute.' }
  if (kind === 'timeout') return { kind: 'error', message: 'Your agent took too long to answer.' }
  if (!res.status) return { kind: 'error', message: 'Your agent isn’t reachable right now.' }
  return { kind: 'error', message: restFailureText({ status: res.status, error: res.error?.message }, `Your agent returned an error (${res.status}).`) }
}

export interface PlatformUpdate {
  enabled?: boolean
  /** Only keys in the platform's catalog `env_vars` are accepted (else 400). */
  env?: Record<string, string>
  clear_env?: string[]
}

export function updateMessagingPlatform(
  id: string,
  update: PlatformUpdate,
): Promise<ServeSendResult<{ ok?: boolean }>> {
  return serveSend('PUT', `/api/messaging/platforms/${encodeURIComponent(id)}`, {
    ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
    env: update.env ?? {},
    clear_env: update.clear_env ?? [],
  })
}

/**
 * `/api/env` accepts almost any key — including `*_BASE_URL` overrides and the
 * platform-injected LLM key — so this client only ever writes gateway knobs
 * the platform catalog doesn't list (EMAIL_ALLOWED_USERS, ports, …).
 */
const AGENT_ENV_ALLOWED = [
  /^EMAIL_(IMAP_PORT|SMTP_PORT|IMAP_SECURITY|SMTP_SECURITY|POLL_INTERVAL|HOME_ADDRESS|HOME_ADDRESS_NAME)$/,
  /^[A-Z][A-Z0-9]*_(ALLOWED_USERS|ALLOW_ALL_USERS|GROUP_ALLOWED_USERS)$/,
  /^[A-Z][A-Z0-9]*_HOME_(CHANNEL|CHANNEL_NAME|CHANNEL_THREAD_ID|ROOM)$/,
]

export function isAgentEnvKeyAllowed(key: string): boolean {
  return AGENT_ENV_ALLOWED.some((re) => re.test(key))
}

function refused(key: string): ServeSendResult<unknown> {
  return { ok: false, data: null, error: `${key} can’t be changed from the app.` }
}

export function setAgentEnv(key: string, value: string): Promise<ServeSendResult<unknown>> {
  if (!isAgentEnvKeyAllowed(key)) return Promise.resolve(refused(key))
  return serveSend('PUT', '/api/env', { key, value })
}

export async function clearAgentEnv(key: string): Promise<ServeSendResult<unknown>> {
  if (!isAgentEnvKeyAllowed(key)) return refused(key)
  const res = await serveSend<unknown>('DELETE', '/api/env', { key })
  // 404 = already absent; that's the state we wanted.
  if (!res.ok && res.status === 404) return { ok: true, data: null, status: 404 }
  return res
}

/**
 * Restart the gateway so new credentials load. Newer dashboards expose
 * /api/gateway/restart; older ones only stop/start (same bounce nub-link uses).
 */
export async function restartGateway(): Promise<ServeSendResult<unknown>> {
  const restart = await serveSend<unknown>('POST', '/api/gateway/restart')
  if (restart.ok || restart.status !== 404) return restart
  await serveSend('POST', '/api/gateway/stop')
  return serveSend('POST', '/api/gateway/start')
}

export interface PlatformTestResult {
  ok: boolean
  state?: string
  message?: string
}

const SETTLED = new Set(['connected', 'error', 'fatal', 'startup_failed', 'disabled', 'not_configured'])

/**
 * After a restart, poll until the platform reports a settled state (connected
 * or a real error) or the timeout lapses. Returns the last payload seen.
 */
export async function waitForPlatform(
  id: string,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<MessagingPlatform | null> {
  const timeoutMs = opts.timeoutMs ?? 45_000
  const intervalMs = opts.intervalMs ?? 3_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = Date.now() + timeoutMs
  let last: MessagingPlatform | null = null
  while (Date.now() < deadline) {
    await sleep(intervalMs)
    const res = await listMessagingPlatforms()
    if (res.kind !== 'ok') continue
    last = res.platforms.find((p) => p.id === id) ?? null
    if (!last || !last.gateway_running) continue
    // A failed login lands in "retrying" with the reason attached; that's an
    // answer worth showing now rather than after the whole timeout.
    if (SETTLED.has(last.state) || (last.state === 'retrying' && last.error_message)) return last
  }
  return last
}

export type StatusTone = 'ok' | 'warn' | 'error' | 'idle'

/** Plain-language status for a platform card. */
export function describePlatformState(p: MessagingPlatform): { label: string; tone: StatusTone } {
  if (!p.enabled) return { label: p.configured ? 'Off' : 'Not set up', tone: 'idle' }
  if (!p.configured) return { label: 'Needs setup', tone: 'warn' }
  switch (p.state) {
    case 'connected':
      return { label: 'Connected', tone: 'ok' }
    case 'connecting':
    case 'pending_restart':
      return { label: 'Connecting…', tone: 'warn' }
    case 'retrying':
      return { label: p.error_message ? 'Can’t connect' : 'Retrying…', tone: p.error_message ? 'error' : 'warn' }
    case 'paused':
      return { label: 'Paused', tone: 'warn' }
    case 'disconnected':
      return { label: 'Disconnected', tone: 'warn' }
    case 'gateway_stopped':
      // The agent's chat-app service isn't running (its own name is internal).
      return { label: 'Not running', tone: 'warn' }
    case 'startup_failed':
    case 'error':
    case 'fatal':
      return { label: 'Error', tone: 'error' }
    default:
      // A state this app doesn't know yet: never show the raw snake_case id.
      return { label: 'Checking…', tone: 'warn' }
  }
}

/**
 * Platforms whose setup can't be a plain token form (QR pairing, local
 * bridges, OAuth service accounts). The pane shows guidance instead of fields.
 */
export const GUIDED_ONLY: Record<string, string> = {
  weixin: 'WeChat pairs by scanning a QR code. Ask your agent to "set up WeChat".',
  google_chat: 'Google Chat needs a Google Cloud service account. Ask your agent to "set up Google Chat".',
}

/**
 * Chat apps that work on a hosted Nub VM, in display order. The VM's tunnel
 * only reaches the dashboard and the API server (checked on o3inq4,
 * 2026-09-28), so a channel works only when the gateway connects OUT:
 * IMAP polling, Telegram long polling, the Discord gateway, Slack Socket
 * Mode, the bundled WhatsApp (Baileys) bridge.
 */
export const PRIMARY_CHANNELS = ['email', 'telegram', 'discord', 'slack', 'whatsapp']

/** Also outbound-only, but rarer: behind "More chat apps". */
export const MORE_CHANNELS = ['matrix', 'mattermost', 'irc', 'ntfy']

/**
 * Never listed, even when set up:
 * - api_server is this app's own link to the agent (turning it off breaks chat);
 * - homeassistant isn't a chat app (it's under Capabilities).
 * Everything else not in the two lists above is hidden too: it needs inbound
 * webhooks the VM can't receive (SMS/Twilio, WhatsApp Cloud, LINE, Teams, …)
 * or a daemon the VM doesn't run (Signal, BlueBubbles, SimpleX, Buzz).
 */
export const NEVER_LISTED = new Set(['api_server', 'homeassistant'])

/** Plain one-liners for the listed channels. The agent's own descriptions
 *  name its framework ("Talk to Hermes…") and protocols (IMAP/SMTP, Socket
 *  Mode); unlisted ids fall back to them. */
export const CHANNEL_BLURB: Record<string, string> = {
  email: 'Your agent reads and replies to an email inbox.',
  telegram: 'Chat with your agent in Telegram.',
  discord: 'Your agent in Discord DMs and channels.',
  slack: 'Your agent in your Slack workspace.',
  whatsapp: 'Link WhatsApp by scanning a QR code with your phone.',
  matrix: 'Your agent in Matrix rooms and DMs.',
  mattermost: 'Your agent in Mattermost channels and DMs.',
  irc: 'Your agent in an IRC channel.',
  ntfy: 'Chat with your agent over ntfy push topics.',
}

/** Kept for the sort: primary channels first, in order. */
export const FEATURED_PLATFORMS = [...PRIMARY_CHANNELS, ...MORE_CHANNELS]

/**
 * What the Connections pane lists: the primary channels, the "more" ones when
 * expanded, and anything already set up (so an existing Signal or SMS setup
 * can still be managed or turned off) — never the internal ones.
 */
export function listedPlatforms(all: MessagingPlatform[], showMore: boolean): MessagingPlatform[] {
  return all.filter((p) => {
    if (NEVER_LISTED.has(p.id)) return false
    if (PRIMARY_CHANNELS.includes(p.id)) return true
    if (showMore && MORE_CHANNELS.includes(p.id)) return true
    return Boolean(p.enabled || p.configured)
  })
}

export function sortPlatforms(list: MessagingPlatform[]): MessagingPlatform[] {
  const rank = (id: string) => {
    const i = FEATURED_PLATFORMS.indexOf(id)
    return i < 0 ? FEATURED_PLATFORMS.length : i
  }
  return [...list].sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
}
