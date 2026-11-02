import type { Agent, Conversation } from './types'
import type { LocalPrefs } from '../local-prefs'
import { describeToolActivity, clipActivityText } from './tool-activity'

// CONTRACT: shared Agent/Conversation types do not yet carry profile UI metadata,
// model, source or last_activity_description. Transport can supply these additions.
export type RosterAgent = Agent & {
  ui_meta?: { avatar?: string; display_name?: string }
  avatarUrl?: string
  model?: string
  provider?: string
  orchestrator?: boolean
  lastActivityAt?: string
  last_activity_description?: string
}
export type RosterConversation = Conversation & {
  agentId?: string
  source?: string
  lastActivityAt?: string
  last_activity_description?: string
  unread?: number | boolean
}
export interface RosterActivity {
  liveTool?: { name: string; url?: string; detail?: string; status?: string } | null
  live?: boolean
  thinking?: boolean
  waitingApproval?: boolean
  waitingClarify?: boolean
  lastActivityDescription?: string
  lastActivityAt?: string
}
export type AgentPresence = 'idle' | 'thinking' | 'tool' | 'browsing' | 'waiting-approval'

export function profileName(agent: Pick<Agent, 'id' | 'hermesProfile'>): string {
  return agent.hermesProfile ?? (agent.id.startsWith('profile:') ? agent.id.slice(8) : agent.id)
}

export function belongsToAgent(conversation: RosterConversation, agentId: string): boolean {
  return conversation.target.type === 'agent' &&
    (conversation.agentId ?? conversation.target.agentId) === agentId
}

export function activityTime(value?: string): number {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

export function latestConversation(
  agentId: string,
  conversations: readonly RosterConversation[],
): RosterConversation | undefined {
  return conversations.filter((c) => belongsToAgent(c, agentId)).reduce<RosterConversation | undefined>(
    (latest, c) => !latest || activityTime(c.lastActivityAt ?? c.lastUsedAt) >
      activityTime(latest.lastActivityAt ?? latest.lastUsedAt) ? c : latest,
    undefined,
  )
}

/** Hidden/scratch profiles disappear, pinned profiles lead, then newest activity. */
export function sortRoster<T extends RosterAgent>(
  agents: readonly T[],
  conversations: readonly RosterConversation[] = [],
  prefs: Partial<LocalPrefs> = {},
): T[] {
  const hidden = new Set(prefs.hiddenProfiles ?? [])
  const pins = new Map((prefs.pinnedOrder ?? []).map((id, index) => [id, index]))
  const times = new Map<string, number>()
  for (const c of conversations) {
    if (c.target.type !== 'agent') continue
    const id = c.agentId ?? c.target.agentId
    times.set(id, Math.max(times.get(id) ?? 0, activityTime(c.lastActivityAt ?? c.lastUsedAt)))
  }
  return agents.filter((agent) => !hidden.has(profileName(agent)) && !hidden.has(agent.id) &&
    (prefs.showScratch || !profileName(agent).startsWith('session-'))).sort((a, b) => {
    const ap = pins.get(a.id) ?? pins.get(profileName(a)) ?? Infinity
    const bp = pins.get(b.id) ?? pins.get(profileName(b)) ?? Infinity
    if (ap !== bp) return ap < bp ? -1 : 1
    const recent = Math.max(times.get(b.id) ?? 0, activityTime(b.lastActivityAt)) -
      Math.max(times.get(a.id) ?? 0, activityTime(a.lastActivityAt))
    return recent || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  })
}

/** Count conversation unread once. Explicit read state beats a stale count. */
export function unreadFor(agentId: string, conversations: readonly RosterConversation[]): number {
  const seen = new Set<string>()
  let count = 0
  for (const c of conversations) {
    if (!belongsToAgent(c, agentId) || seen.has(c.id)) continue
    seen.add(c.id)
    if (c.hasUnread === false || c.unread === false) continue
    const raw = typeof c.unread === 'number' ? c.unread : c.unreadCount
    const known = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0
    count += c.hasUnread || c.unread === true ? Math.max(1, known) : known
  }
  return count
}

function activeTool(activity: RosterActivity): RosterActivity['liveTool'] {
  const tool = activity.liveTool
  return tool && (!tool.status || ['running', 'pending', 'in_progress'].includes(tool.status)) ? tool : null
}

function isBrowser(name: string): boolean {
  return /browser|browse|navigate|webfetch/i.test(name)
}

function toolLine(tool: NonNullable<RosterActivity['liveTool']>): string {
  if (isBrowser(tool.name)) {
    const candidate = tool.url ?? tool.detail?.match(/https?:\/\/[^\s"'<>]+/)?.[0]
    try {
      if (candidate) return `Browsing ${new URL(candidate).hostname}`
    } catch {
      // Do not display raw URLs, credentials or malformed tool arguments.
    }
    return 'Browsing the web'
  }
  if (/terminal|bash|shell|execute|run_command/i.test(tool.name)) return 'Running terminal'
  return describeToolActivity(tool.name).text
}

export function relativeActivityTime(at: string | undefined, now: number): string {
  if (!at || !Number.isFinite(Date.parse(at))) return ''
  const elapsed = Math.max(0, now - Date.parse(at))
  if (elapsed < 60_000) return 'Just now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return `${Math.floor(elapsed / 86_400_000)}d ago`
}

/** Live tool > persisted description > relative time. Caller supplies the clock. */
export function activityLine(activity: RosterActivity, now: number): string {
  const tool = activeTool(activity)
  if (tool) return clipActivityText(toolLine(tool))
  if (activity.lastActivityDescription?.trim()) return clipActivityText(activity.lastActivityDescription)
  return relativeActivityTime(activity.lastActivityAt, now)
}

export function presenceFor(activity: RosterActivity): AgentPresence {
  if (activity.waitingApproval || activity.waitingClarify) return 'waiting-approval'
  const tool = activeTool(activity)
  if (tool) return isBrowser(tool.name) ? 'browsing' : 'tool'
  return activity.thinking || activity.live ? 'thinking' : 'idle'
}

/** Reordering pins the displayed order without losing absent/hidden pins. */
export function reorderRoster(
  orderedIds: readonly string[],
  from: string,
  to: string,
  previousPins: readonly string[] = [],
): string[] {
  if (from === to || !orderedIds.includes(from) || !orderedIds.includes(to)) return [...previousPins]
  const next = orderedIds.filter((id) => id !== from)
  next.splice(orderedIds.indexOf(to), 0, from)
  return [...next, ...previousPins.filter((id) => !next.includes(id))]
}

export type RosterNotification =
  | { kind: 'approval' | 'clarify' }
  | { kind: 'finished'; startedAt: string; finishedAt: string; windowFocused: boolean }

// CONTRACT: wave 2 wires this policy to system-notify and conversation deep links.
// "Long run" is one minute here; the spec does not prescribe a threshold.
export const LONG_RUN_NOTIFICATION_MS = 60_000
export function shouldNotify(event: RosterNotification): boolean {
  if (event.kind !== 'finished') return true
  const start = Date.parse(event.startedAt)
  const end = Date.parse(event.finishedAt)
  return !event.windowFocused && Number.isFinite(start) && Number.isFinite(end) &&
    end - start >= LONG_RUN_NOTIFICATION_MS
}
