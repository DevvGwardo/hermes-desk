/**
 * Group-chat behaviour and "strangers may ask for access" for chat platforms,
 * stored in the agent's config.yaml through the allowlisted
 * `patchAgentConfig` (src/lib/agent-config.ts), plus the home-chat check over
 * `GET /api/cron/delivery-targets`.
 */

import { getAgentConfig, patchAgentConfig, readDotted } from './agent-config'
import { serveGetDetailed } from './hermes-rest'

export interface GroupChatSpec {
  requireMention: string
  allowedChannels?: string
  freeResponseChannels?: string
  autoThread?: string
  /** "channel" / "room" for copy. */
  noun: string
  idHint: string
}

export const GROUP_CHAT_SPECS: Record<string, GroupChatSpec> = {
  slack: {
    requireMention: 'slack.require_mention',
    allowedChannels: 'slack.allowed_channels',
    freeResponseChannels: 'slack.free_response_channels',
    noun: 'channel',
    idHint: 'Channel IDs like C01ABC2DEF3 (open the channel → its name → copy the ID at the bottom).',
  },
  discord: {
    requireMention: 'discord.require_mention',
    allowedChannels: 'discord.allowed_channels',
    freeResponseChannels: 'discord.free_response_channels',
    autoThread: 'discord.auto_thread',
    noun: 'channel',
    idHint: 'Channel IDs (Developer Mode on → right-click the channel → Copy Channel ID).',
  },
  mattermost: {
    requireMention: 'mattermost.require_mention',
    allowedChannels: 'mattermost.allowed_channels',
    noun: 'channel',
    idHint: 'Mattermost channel IDs (channel menu → View Info).',
  },
  matrix: {
    requireMention: 'matrix.require_mention',
    allowedChannels: 'matrix.allowed_rooms',
    noun: 'room',
    idHint: 'Room IDs like !abc123:matrix.org (room settings → Advanced).',
  },
}

/**
 * Chat platforms whose gateway honours `platforms.<id>.unauthorized_dm_behavior`
 * (gateway/config_loader.py `_SHARED_KEYS`, read in authz_mixin
 * `_get_unauthorized_dm_behavior`). Email is left out on purpose: inboxes
 * default to ignoring strangers.
 */
export const STRANGER_POLICY_PLATFORMS = [
  'telegram',
  'discord',
  'slack',
  'whatsapp',
  'signal',
  'sms',
  'mattermost',
  'matrix',
  'bluebubbles',
] as const

export function strangerPolicyPath(platformId: string): string | null {
  return (STRANGER_POLICY_PLATFORMS as readonly string[]).includes(platformId)
    ? `platforms.${platformId}.unauthorized_dm_behavior`
    : null
}

export type StrangerPolicy = 'pair' | 'ignore'

/** `"a, b"` or `['a','b']` → `['a','b']` */
export function toIdList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

export interface GroupChatValues {
  requireMention: boolean
  allowedChannels: string[]
  freeResponseChannels: string[]
  autoThread: boolean
}

export interface ChatPolicy {
  group: GroupChatValues | null
  /** null = not set explicitly (gateway picks: allowlist set → ignore, else pair). */
  stranger: StrangerPolicy | null
}

export async function readChatPolicy(platformId: string): Promise<ChatPolicy | null> {
  const res = await getAgentConfig()
  if (res.kind !== 'ok') return null
  const cfg = res.config
  const spec = GROUP_CHAT_SPECS[platformId]
  const group: GroupChatValues | null = spec
    ? {
        requireMention: readDotted(cfg, spec.requireMention) !== false,
        allowedChannels: spec.allowedChannels ? toIdList(readDotted(cfg, spec.allowedChannels)) : [],
        freeResponseChannels: spec.freeResponseChannels ? toIdList(readDotted(cfg, spec.freeResponseChannels)) : [],
        autoThread: spec.autoThread ? readDotted(cfg, spec.autoThread) !== false : false,
      }
    : null
  const path = strangerPolicyPath(platformId)
  const raw = path ? readDotted(cfg, path) : undefined
  const stranger = raw === 'pair' || raw === 'ignore' ? raw : null
  return { group, stranger }
}

export function saveGroupChat(platformId: string, v: GroupChatValues) {
  const spec = GROUP_CHAT_SPECS[platformId]
  if (!spec) return Promise.resolve({ ok: false, data: null, error: 'Not supported for this app.' })
  const patch: Record<string, unknown> = { [spec.requireMention]: v.requireMention }
  if (spec.allowedChannels) patch[spec.allowedChannels] = v.allowedChannels.join(',')
  if (spec.freeResponseChannels) patch[spec.freeResponseChannels] = v.freeResponseChannels.join(',')
  if (spec.autoThread) patch[spec.autoThread] = v.autoThread
  return patchAgentConfig(patch)
}

export function saveStrangerPolicy(platformId: string, policy: StrangerPolicy) {
  const path = strangerPolicyPath(platformId)
  if (!path) return Promise.resolve({ ok: false, data: null, error: 'Not supported for this app.' })
  return patchAgentConfig({ [path]: policy })
}

// ---------------------------------------------------------------------------
// Home chat (where scheduled results / updates go)
// ---------------------------------------------------------------------------

export interface DeliveryTarget {
  id: string
  name: string
  home_target_set: boolean
  home_env_var?: string | null
}

/** null = couldn't tell (older agent / unreachable). */
export async function isHomeChatSet(platformId: string): Promise<boolean | null> {
  const res = await serveGetDetailed<{ targets?: DeliveryTarget[] }>('/api/cron/delivery-targets')
  const targets = res.data?.targets
  if (!Array.isArray(targets)) return null
  const t = targets.find((x) => x.id === platformId)
  return t ? Boolean(t.home_target_set) : false
}
