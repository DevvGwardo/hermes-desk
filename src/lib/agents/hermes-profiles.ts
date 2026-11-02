/** The local profile roster, shared by transport and sidebar. */
import type { Agent } from './types'
import { serveGet } from '../hermes-rest'

export interface HermesProfile {
  name: string
  path: string
  is_default?: boolean
  model?: string | null
  provider?: string | null
  has_env?: boolean
  skill_count?: number
  gateway_running?: boolean
  description?: string
  description_auto?: boolean
  distribution_name?: string | null
  distribution_version?: string | null
  has_alias?: boolean
  display_name?: string
  ui_meta?: Record<string, unknown> | null
  orchestrator?: boolean
  soul?: string
  last_session?: { id: string; title?: string; preview?: string; last_active?: number; started_at?: number } | null
  canonical_session?: { id: string; last_active?: number; started_at?: number } | null
  last_activity_at?: number | string
}

export interface LocalProfileAgent extends Agent {
  lastActivityAt?: string
  avatar?: string
  model?: string | null
  provider?: string | null
}

export type ProfileBridge = (kind: string, args: string[]) => Promise<{ ok: boolean; data?: unknown; error?: string }>

export function profileToAgent(p: HermesProfile, origin: 'local' | 'remote' = 'local'): LocalProfileAgent {
  const displayName = p.ui_meta?.display_name
  const name = typeof displayName === 'string' && displayName.trim()
    ? displayName.trim()
    : p.display_name?.trim() || (p.name === 'default' ? 'Hermes'
      : p.name.split(/[-_]+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' '))
  const description = (p.soul ?? p.description ?? '').split('\n').find((line) => line.trim())?.trim()
  const activity = p.last_activity_at ?? p.last_session?.last_active ??
    p.canonical_session?.last_active ?? p.last_session?.started_at
  const lastActivityAt = typeof activity === 'number'
    ? new Date(activity * 1000).toISOString() : activity
  return {
    id: `profile:${p.name}`,
    hermesProfile: p.name,
    name,
    status: p.gateway_running === false ? 'stopped' : 'running',
    region: origin,
    createdAt: new Date().toISOString(),
    summary: description || (p.name === 'default' ? 'Default Hermes profile.' : `${p.name} profile.`),
    persona: {
      title: name,
      description: description || `${p.skill_count ?? 0} skills.`,
      instructionsPreview: description,
    },
    unreadCount: 0,
    ...(lastActivityAt ? { lastActivityAt } : {}),
    ...(typeof p.ui_meta?.avatar === 'string' ? { avatar: p.ui_meta.avatar } : {}),
    ...(p.orchestrator || p.ui_meta?.orchestrator === true ? { role: 'orchestrator' as const } : {}),
    model: p.model,
    provider: p.provider,
  }
}

/** REST fallback for servers without profiles.list; no CLI or VM guessing. */
export async function listHermesProfiles(): Promise<HermesProfile[]> {
  const data = await serveGet<{ profiles?: HermesProfile[] } | HermesProfile[]>('/api/profiles')
  return Array.isArray(data) ? data : data?.profiles ?? []
}

/** Use the same filtering and ordering as the transport, not a second roster. */
export async function hydrateProfileAgents(): Promise<number> {
  const { getActiveTransport } = await import('./active-transport')
  const { getState, setState } = await import('./store')
  const before = new Set(getState().agents.map((a) => a.id))
  const agents = await (await getActiveTransport()).transport.listAgents()
  setState({ agents })
  return agents.filter((a) => !before.has(a.id)).length
}
