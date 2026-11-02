/** Local profile roster policy, creation and hide preferences (never deletion). */
import type { Agent, NewAgentProfile } from './types'
import type { TransportEvent } from './transport'
import type { LocalTransportPrefs } from './local-transport-prefs'
import { getState, setState, setHydrateStatus } from './store'
import { listHermesProfiles, profileToAgent, type HermesProfile, type LocalProfileAgent } from './hermes-profiles'
import { profileIdForName, putHermesProfileSoul } from '../agent-profiles'
import { LOCAL_SERVE_OFFLINE as OFFLINE } from './local-gateway-connection'

const profilePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/
interface ProfilesIO {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>
  emit(event: TransportEvent): void
  readOnly(): boolean
  prefs(): LocalTransportPrefs
  setPrefs(prefs: LocalTransportPrefs): void | Promise<void>
  showScratch(): boolean | undefined
}

export class LocalProfiles {
  private io: ProfilesIO
  constructor(io: ProfilesIO) { this.io = io }

  async list(): Promise<LocalProfileAgent[]> {
    let profiles: HermesProfile[]
    try {
      profiles = (await this.io.request<{ profiles?: HermesProfile[] }>('profiles.list', { include_sessions: true })).profiles ?? []
    } catch {
      profiles = await listHermesProfiles()
      if (!profiles.length && this.io.readOnly()) {
        setHydrateStatus({ rosterHydrating: false, rosterHydrateError: OFFLINE })
        return getState().agents as LocalProfileAgent[]
      }
    }
    const prefs = this.io.prefs()
    const hidden = new Set((prefs.hidden ?? []).map((name) => name.replace(/^profile:/, '')))
    const pins = new Map((prefs.pinnedOrder ?? []).map((name, i) => [name.replace(/^profile:/, ''), i]))
    const showScratch = this.io.showScratch() ?? prefs.showScratch ?? false
    const agents = profiles
      .filter((profile) => profilePattern.test(profile.name) && !hidden.has(profile.name) &&
        (showScratch || !profile.name.startsWith('session-')))
      .map((profile) => {
        const meta = profile as HermesProfile & { role?: string }
        const agent = { ...profileToAgent(profile), ui_meta: profile.ui_meta,
          model: profile.model ?? undefined, provider: profile.provider ?? undefined,
          ...(meta.role === 'orchestrator' ? { role: 'orchestrator' as const } : {}) }
        const previous = getState().agents.find((a) => a.id === agent.id)
        return { ...previous, ...agent, createdAt: previous?.createdAt ?? agent.createdAt }
      })
      .sort((a, b) => (pins.get(a.hermesProfile!) ?? Infinity) - (pins.get(b.hermesProfile!) ?? Infinity) ||
        (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.name.localeCompare(b.name))
    setState({ agents })
    setHydrateStatus({ rosterHydrating: false, rosterHydrateError: null })
    this.io.emit({ type: 'agents', agents })
    return agents
  }


  async create(partial?: NewAgentProfile): Promise<Agent> {
    const name = profileIdForName(partial?.name ?? `Agent ${getState().agents.length + 1}`)
    const created = await this.io.request<{ name: string; path: string; ok?: boolean }>('profiles.create', { name, description: partial?.description ?? '' })
    if (created.ok === false) throw new Error('Could not create the local profile')
    const soul = partial?.personality ?? partial?.description ?? ''
    const saved = await putHermesProfileSoul(created.name, soul)
    if (!saved.ok) throw new Error(saved.error ?? 'Profile created, but SOUL could not be saved')
    const displayName = partial?.name?.trim()
    if (displayName) {
      const configured = await this.io.request<{ ok?: boolean }>('profiles.configure', { name: created.name, ui_meta: { display_name: displayName } })
      if (configured.ok === false) throw new Error('Profile created, but its display name could not be saved')
    }
    const agent = profileToAgent({ name: created.name, path: created.path, description: partial?.description, soul, ui_meta: { display_name: displayName }, orchestrator: partial?.role === 'orchestrator' })
    setState((state) => ({ agents: [...state.agents.filter((a) => a.id !== agent.id), agent] }))
    this.io.emit({ type: 'agents', agents: getState().agents })
    return agent
  }

  async hide(agentId: string): Promise<void> {
    const profile = agentId.replace(/^profile:/, '')
    if (!profilePattern.test(profile)) throw new Error('Invalid profile')
    const prefs = this.io.prefs()
    await this.io.setPrefs({ ...prefs, hidden: [...new Set([...(prefs.hidden ?? []), profile])] })
    setState((state) => ({ agents: state.agents.filter((a) => a.id !== agentId) }))
    this.io.emit({ type: 'agents', agents: getState().agents })
  }

}
