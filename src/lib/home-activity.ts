/**
 * Home page activity model. Pure: App passes in the roster data it already
 * holds (conversations, live ids, per-agent activity), this sorts it into
 * "Needs you" plus day buckets. No fetching, no store access.
 */
import type { ChatMessage, Group, PendingToolPermission } from './agents/types'
import type { LocalPrefs } from './local-prefs'
import {
  activityLine, activityTime, latestConversation, relativeActivityTime, sortRoster,
  type RosterActivity, type RosterAgent, type RosterConversation,
} from './agents/roster'
import { validatedGenUiEvents, type GenUiComponent } from './genui'
import { previewPlainText } from './preview-text'

export type HomeSectionId = 'needs-you' | 'today' | 'yesterday' | 'week' | 'earlier'
export interface HomeActivityItem {
  conversationId: string
  /** Avatar owner: the agent, or a group's primary agent. */
  agentId: string | null
  groupId: string | null
  title: string
  /** Agent or group name. */
  who: string
  preview: string
  at: number
  when: string
  live: boolean
  unread: number
  needs: 'approval' | 'answer' | null
}
export interface HomeActivitySection { id: HomeSectionId; label: string; items: HomeActivityItem[] }
export interface HomeActivity {
  sections: HomeActivitySection[]
  /** Every visible conversation, before the row limit. */
  total: number
  needsCount: number
  liveCount: number
  /** Whose mascot leads the page: the most recently active agent. */
  focusAgentId: string | null
}
export interface HomeActivityInput {
  agents: readonly RosterAgent[]
  groups: readonly Group[]
  conversations: readonly RosterConversation[]
  messagesByThreadId?: Readonly<Record<string, readonly ChatMessage[] | undefined>>
  liveConversationIds?: ReadonlySet<string>
  activityByAgent?: Readonly<Record<string, RosterActivity>>
  pendingPermissions?: readonly PendingToolPermission[]
  prefs?: Partial<LocalPrefs>
  now: number
  /** Rows shown outside "Needs you". */
  limit?: number
}

export const HOME_ACTIVITY_LIMIT = 12
const PREVIEW_MAX = 140
const DAY_MS = 86_400_000
const LABELS: Record<HomeSectionId, string> = {
  'needs-you': 'Needs you', today: 'Today', yesterday: 'Yesterday', week: 'Earlier this week', earlier: 'Earlier',
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : flat
}

function unreadCount(c: RosterConversation): number {
  if (c.hasUnread === false || c.unread === false) return 0
  const raw = typeof c.unread === 'number' ? c.unread : c.unreadCount
  const known = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0
  return c.hasUnread || c.unread === true ? Math.max(1, known) : known
}

function genUiComponentPreview(component: GenUiComponent): string {
  switch (component.type) {
    case 'stat':
      return `${component.title}: ${component.value}${component.detail ? ` (${component.detail})` : ''}`
    case 'table':
      return `${component.title}: ${[...component.columns, ...component.rows.flat().map(String)].join(' ')}`
    case 'bar_chart':
      return `${component.title}: ${component.items.map((item) => `${item.label} ${item.value}${component.unit ? ` ${component.unit}` : ''}`).join(', ')}`
    case 'checklist':
      return `${component.title}: ${component.items.map((item) => item.label).join(', ')}`
    case 'handbook':
      return `${component.title}: ${[...component.paragraphs,
        ...(component.rows?.flat().map((cell) => String(cell)) ?? []), component.notice?.text ?? '']
        .filter(Boolean).join(' ')}`
  }
}

function messagePreview(m: ChatMessage): string {
  if (m.role !== 'agent' && m.role !== 'user') return ''
  if (m.content.trim()) return previewPlainText(m.content)
  if (m.role !== 'agent') return ''
  return validatedGenUiEvents(m.toolEvents)
    .flatMap((ev) => ev.genui?.components ?? [])
    .map(genUiComponentPreview)
    .filter(Boolean)
    .join(' · ')
}

function lastText(messages: readonly ChatMessage[] | undefined): string {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const text = messagePreview(messages![i]!)
    if (text) return text
  }
  return ''
}

export function homeSection(at: number, now: number): Exclude<HomeSectionId, 'needs-you'> {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = today.getTime()
  if (at >= start) return 'today'
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (at >= yesterday.getTime()) return 'yesterday'
  return at >= start - 6 * DAY_MS ? 'week' : 'earlier'
}

export function buildHomeActivity(input: HomeActivityInput): HomeActivity {
  const { agents, groups, conversations, now } = input
  const visibleAgents = new Map(sortRoster(agents, [], input.prefs).map((a) => [a.id, a]))
  const groupsById = new Map(groups.map((g) => [g.id, g]))
  const live = input.liveConversationIds ?? new Set<string>()
  const activityByAgent = input.activityByAgent ?? {}
  const seen = new Set<string>()
  const visible = conversations.filter((c) => {
    if (seen.has(c.id) || c.hiddenFromSidebar || c.placeholder) return false
    seen.add(c.id)
    return c.target.type === 'agent' ? visibleAgents.has(c.agentId ?? c.target.agentId) : groupsById.has(c.target.groupId)
  })
  // Native requests name their exact chat, including rooms and older threads.
  const waitingOn = new Map<string, 'approval' | 'answer'>()
  if (input.pendingPermissions) {
    for (const ask of input.pendingPermissions) {
      if (ask.kind !== 'question' || !waitingOn.has(ask.conversationId)) {
        waitingOn.set(ask.conversationId, ask.kind === 'question' ? 'answer' : 'approval')
      }
    }
  } else {
    for (const [agentId, activity] of Object.entries(activityByAgent)) {
      const needs = activity.waitingApproval ? 'approval' : activity.waitingClarify ? 'answer' : null
      const latest = needs ? latestConversation(agentId, visible) : undefined
      if (needs && latest) waitingOn.set(latest.id, needs)
    }
  }

  const items = visible.map((c): HomeActivityItem => {
    const target = c.target
    const agent = target.type === 'agent' ? visibleAgents.get(c.agentId ?? target.agentId) : undefined
    const group = target.type === 'group' ? groupsById.get(target.groupId) : undefined
    const who = agent?.name ?? group?.name ?? c.title
    const agentId = agent?.id ?? group?.primaryAgentId ?? null
    const at = activityTime(c.lastActivityAt ?? c.lastUsedAt)
    const isLive = live.has(c.id)
    const activity = agent ? activityByAgent[agent.id] : undefined
    const liveLine = isLive && activity?.liveTool ? activityLine(activity, now) : ''
    const title = c.title?.trim() && c.title.trim() !== 'New conversation' ? c.title.trim() : who
    // Newest loaded message first; an auto-title is the first line, so never echo it back.
    const preview = [liveLine, lastText(input.messagesByThreadId?.[c.id]), previewPlainText(c.preview ?? ''),
      c.last_activity_description ?? ''].map(clip).find((text) => text && text !== title) ?? ''
    return {
      conversationId: c.id, agentId, groupId: group?.id ?? null, title, who, preview,
      at, when: relativeActivityTime(at ? new Date(at).toISOString() : undefined, now),
      live: isLive, unread: unreadCount(c), needs: waitingOn.get(c.id) ?? null,
    }
  }).sort((a, b) => b.at - a.at || a.title.localeCompare(b.title))

  const sections: HomeActivitySection[] = []
  const needs = items.filter((item) => item.needs)
  if (needs.length) sections.push({ id: 'needs-you', label: LABELS['needs-you'], items: needs })
  const buckets = new Map<HomeSectionId, HomeActivityItem[]>()
  for (const item of items.filter((i) => !i.needs).slice(0, input.limit ?? HOME_ACTIVITY_LIMIT)) {
    const id = homeSection(item.at, now)
    buckets.set(id, [...buckets.get(id) ?? [], item])
  }
  for (const id of ['today', 'yesterday', 'week', 'earlier'] as const) {
    const bucket = buckets.get(id)
    if (bucket) sections.push({ id, label: LABELS[id], items: bucket })
  }
  return {
    sections, total: items.length, needsCount: needs.length,
    liveCount: items.filter((item) => item.live).length,
    focusAgentId: items.find((item) => item.agentId)?.agentId ?? [...visibleAgents.keys()][0] ?? null,
  }
}

export function homeGreeting(now: number): string {
  const hour = new Date(now).getHours()
  return hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 17 ? 'Good afternoon' : 'Good evening'
}

/** One line under the greeting. */
export function homeSummary(activity: Pick<HomeActivity, 'needsCount' | 'liveCount' | 'total'>, agentName?: string): string {
  if (activity.needsCount) return `${activity.needsCount} ${activity.needsCount === 1 ? 'chat needs' : 'chats need'} you`
  if (activity.liveCount === 1 && agentName) return `${agentName} is working on something`
  if (activity.liveCount) return `${activity.liveCount} chats in progress`
  return activity.total ? 'All caught up' : 'No activity yet'
}
