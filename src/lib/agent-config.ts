/**
 * Typed, allowlisted writes to the agent's config.yaml via the dashboard's
 * `PUT /api/config` (deep-merge of `{config: {...}}`).
 *
 * `PUT /api/config` accepts ANY key — it can switch off approvals, redaction,
 * the SSRF guard, enable shell hooks, or repoint the model. The app therefore
 * only ever writes dotted paths listed in AGENT_CONFIG_WRITABLE; everything
 * else is refused client-side before a request is made. Add a path here (with
 * a comment saying which UI owns it, after checking it exists in hermes'
 * DEFAULT_CONFIG — `hermes_cli/config_defaults.py`) rather than calling PUT /api/config
 * directly. The platform proxy must enforce the same list server-side
 * (docs/maiavm-proxy-hardening.md).
 */

import { serveGetDetailed, serveSend, type ServeSendResult } from './hermes-rest'

/** Exact dotted paths, or `prefix.*` for one level of dynamic keys. */
export const AGENT_CONFIG_WRITABLE: readonly string[] = [
  // Settings → Safety: approvals
  'approvals.mode',
  'approvals.cron_mode',
  'approvals.smart_policy',
  'approvals.deny',
  'command_allowlist',
  // Settings → Safety
  'privacy.redact_pii',
  'security.website_blocklist.enabled',
  'security.website_blocklist.domains',
  'checkpoints.enabled',
  // Locale (auto-pushed from the OS)
  'timezone',
  'display.language',
  // Memory
  'memory.memory_enabled',
  'memory.user_profile_enabled',
  'memory.write_approval',
  // Messaging: DM strangers + group-chat behaviour
  'slack.require_mention',
  'slack.free_response_channels',
  'slack.allowed_channels',
  'discord.require_mention',
  'discord.free_response_channels',
  'discord.allowed_channels',
  'discord.auto_thread',
  'mattermost.require_mention',
  'matrix.require_mention',
  // Settings → Connections → "In group chats" (ChatPolicySettings.tsx); both in DEFAULT_CONFIG.
  'mattermost.allowed_channels',
  'matrix.allowed_rooms',
  // Settings → Connections → "Let strangers ask for access" (ChatPolicySettings.tsx).
  // Not in DEFAULT_CONFIG: the gateway reads top-level
  // `platforms.<id>.unauthorized_dm_behavior` ("pair" | "ignore") from config.yaml via
  // gateway/config_loader.py merge_platform_sections + _SHARED_KEYS → PlatformConfig.extra,
  // consumed by authz_mixin._get_unauthorized_dm_behavior (explicit per-platform value wins;
  // otherwise an allowlist means "ignore"). Same path `hermes gateway setup` writes
  // (hermes_cli/gateway.py _set_platform_unauthorized_dm_behavior).
  // Settings → Connections → People (lib/pairing.ts ensurePairingInstructions): the text a
  // stranger gets with their pairing code ({platform}, {code}). Newer hermes only; set once
  // when the approvals inbox is available and the value is still the default "".
  'gateway.pairing_instructions',
  'platforms.telegram.unauthorized_dm_behavior',
  'platforms.discord.unauthorized_dm_behavior',
  'platforms.slack.unauthorized_dm_behavior',
  'platforms.whatsapp.unauthorized_dm_behavior',
  'platforms.signal.unauthorized_dm_behavior',
  'platforms.sms.unauthorized_dm_behavior',
  'platforms.mattermost.unauthorized_dm_behavior',
  'platforms.matrix.unauthorized_dm_behavior',
  'platforms.bluebubbles.unauthorized_dm_behavior',
  'streaming.enabled',
  'human_delay.mode',
  // Sessions retention (Storage)
  'sessions.retention_days',
  'sessions.auto_prune',
]

function isWritable(path: string): boolean {
  return AGENT_CONFIG_WRITABLE.some((p) =>
    p.endsWith('.*') ? path.startsWith(p.slice(0, -1)) && !path.slice(p.length - 1).includes('.') : p === path,
  )
}

export function isAgentConfigPathWritable(path: string): boolean {
  return isWritable(path)
}

/** `{ 'a.b': 1, 'a.c': 2 }` → `{ a: { b: 1, c: 2 } }` */
export function nestDotted(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split('.')
    let cur = out
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i]
      if (typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) cur[k] = {}
      cur = cur[k] as Record<string, unknown>
    }
    cur[parts[parts.length - 1]] = value
  }
  return out
}

/** Read `a.b.c` out of a nested config object. */
export function readDotted(config: unknown, path: string): unknown {
  let cur: unknown = config
  for (const k of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

export type AgentConfig = Record<string, unknown>

export type AgentConfigResult =
  | { kind: 'ok'; config: AgentConfig }
  | { kind: 'unavailable'; message: string }

export async function getAgentConfig(): Promise<AgentConfigResult> {
  const res = await serveGetDetailed<AgentConfig>('/api/config')
  if (res.data && typeof res.data === 'object') return { kind: 'ok', config: res.data }
  return { kind: 'unavailable', message: res.error?.message ?? 'Your agent isn’t reachable right now.' }
}

/**
 * Deep-merge `patch` (dotted paths → values) into the agent config. Refuses
 * the whole patch if any path is not allowlisted.
 */
export async function patchAgentConfig(patch: Record<string, unknown>): Promise<ServeSendResult<unknown>> {
  const bad = Object.keys(patch).filter((p) => !isWritable(p))
  if (bad.length) {
    return { ok: false, data: null, error: `Not changeable from the app: ${bad.join(', ')}` }
  }
  if (Object.keys(patch).length === 0) return { ok: true, data: null }
  return serveSend('PUT', '/api/config', { config: nestDotted(patch) })
}
