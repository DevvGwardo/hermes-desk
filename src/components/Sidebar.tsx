import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'framer-motion'
import { useWindowFocused } from '../lib/useWindowFocused'
import type { Agent, Conversation, Group, ThreadRef } from '../lib/agents/types'
import { getStructuralState, subscribe } from '../lib/agents/store'
import { getPendingToolPermissions, subscribePendingToolPermission } from '../lib/agents/tool-permission'
import { HOVER_INTENT_MS } from '../lib/agents/prefetch'
import { previewPlainText } from '../lib/preview-text'
import { getLocalPrefs, subscribeLocalPrefs, updateLocalPrefs } from '../lib/local-prefs'
import {
  activityLine, belongsToAgent, latestConversation, presenceFor, profileName, reorderRoster,
  relativeActivityTime, sortRoster, unreadFor, type RosterActivity, type RosterAgent, type RosterConversation,
} from '../lib/agents/roster'
import { AgentAvatar, AgentCard } from './AgentCard'
import { Button } from './ui/Button'
import type { MainDestination } from '../lib/shell-layout'
import { getHostBridge } from '../lib/desktop-bridge'
import { Icon } from './ui/icons'
import { IconButton } from './ui/IconButton'
import { Tooltip } from './ui/Tooltip'
import { ListRow } from './ui/ListRow'
import { Badge } from './ui/Badge'
import { EmptyState } from './EmptyState'
import { Onboarding } from './Onboarding'
import { ConnectorStrip, useHostStatus } from './ConnectorStrip'
import { RestoreHiddenMenu } from './RestoreHiddenMenu'
import { SidebarCreateActions } from './SidebarCreateActions'
import { PluginSlot, usePluginSidebarNav } from '../plugins/PluginHost'
import { host as pluginHost } from '../plugins/host'
import '../styles/skin-messenger-sidebar.css'
import '../styles/sidebar-compact.css'
import '../styles/sidebar-controls.css'

export const SIDEBAR_WIDTH_DEFAULT = 240
export const SIDEBAR_WIDTH_MIN = 180
export const SIDEBAR_WIDTH_MAX = 480
export const SIDEBAR_WIDTH_COMPACT = 60
const SELECTION_SPRING = { type: 'spring', stiffness: 520, damping: 42, mass: 0.8 } as const
const SIDEBAR_WIDTH_KEY = 'maia:sidebarWidth'
const SIDEBAR_EXPANDED_KEY = 'maia:sidebarExpandedWidth'
const SIDEBAR_SECTIONS_KEY = 'maia:sidebarSections'
export function sidebarPreview(agent: RosterAgent, latest?: RosterConversation,
  summary?: { preview?: string; lastActivityAt?: string; hasSessions: boolean }, now = Date.now()): string {
  const preview = previewPlainText(summary?.preview || latest?.preview || '')
  if (preview) return preview
  const when = relativeActivityTime(summary?.lastActivityAt || latest?.lastActivityAt || latest?.lastUsedAt || agent.lastActivityAt, now)
  return when ? `No desktop chats yet · last active ${when}` :
    summary?.hasSessions || latest ? 'No desktop chats yet · other sessions available' : 'No desktop chats yet'
}

/** Retained for existing callers and saved classic layout preferences. */
export type SidebarSectionId = 'pinned' | 'conversations'
export function loadSectionCollapsed(id: SidebarSectionId): boolean {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_SECTIONS_KEY)
    return raw != null && JSON.parse(raw)?.[id] === true
  } catch { return false }
}
export function saveSectionCollapsed(id: SidebarSectionId, collapsed: boolean): void {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_SECTIONS_KEY)
    const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, boolean>
    parsed[id] = collapsed
    window.localStorage.setItem(SIDEBAR_SECTIONS_KEY, JSON.stringify(parsed))
  } catch { /* best-effort persistence */ }
}
export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(px)))
}
export function loadSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
    return raw == null ? SIDEBAR_WIDTH_DEFAULT : clampSidebarWidth(Number(raw))
  } catch { return SIDEBAR_WIDTH_DEFAULT }
}
export function saveSidebarWidth(px: number): void {
  try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(px))) }
  catch { /* best-effort persistence */ }
}
export function loadExpandedSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_EXPANDED_KEY)
    return raw == null ? SIDEBAR_WIDTH_DEFAULT : clampSidebarWidth(Number(raw))
  } catch { return SIDEBAR_WIDTH_DEFAULT }
}
export function saveExpandedSidebarWidth(px: number): void {
  try { window.localStorage.setItem(SIDEBAR_EXPANDED_KEY, String(clampSidebarWidth(px))) }
  catch { /* best-effort persistence */ }
}
export function toggleCompactSidebarWidth(current: number): number {
  if (clampSidebarWidth(current) <= SIDEBAR_WIDTH_MIN) return loadExpandedSidebarWidth()
  saveExpandedSidebarWidth(current)
  return SIDEBAR_WIDTH_MIN
}
export function sidebarOrbPaused(_windowFocused: boolean, _live: boolean): boolean { return true }
export const SIDEBAR_LIVE_ORB_BUDGET = 2
export function sidebarAnimatedOrbIds(
  orderedIds: readonly string[], isLive: (id: string) => boolean, selectedId: string | null,
  budget = SIDEBAR_LIVE_ORB_BUDGET,
): Set<string> {
  const live = orderedIds.filter(isLive)
  const ranked = selectedId && live.includes(selectedId)
    ? [selectedId, ...live.filter((id) => id !== selectedId)] : live
  return new Set(ranked.slice(0, Math.max(0, budget)))
}
/** Keep focused roster Pips animated, including their autonomous idle acts. */
export function sidebarRowOrbMotion(windowFocused: boolean, _live: boolean, _animated: boolean) {
  return { paused: !windowFocused, bob: false }
}
export function sidebarRosterPlaceholder(itemCount: number, hydrating: boolean): 'loading' | 'empty' | null {
  return itemCount > 0 ? null : hydrating ? 'loading' : 'empty'
}
export function conversationIsLive(
  conv: Conversation, liveSubagentAgentIds?: ReadonlySet<string>,
  liveConversationIds?: ReadonlySet<string>, memberAgentIds?: readonly string[],
): boolean {
  return Boolean(liveConversationIds?.has(conv.id) ||
    (conv.target.type === 'agent' && liveSubagentAgentIds?.has(conv.target.agentId)) ||
    memberAgentIds?.some((id) => liveSubagentAgentIds?.has(id)))
}
export function conversationTitle(conv: Conversation, agents: Agent[], groups: Group[]): string {
  const t = conv.target
  return t.type === 'agent' ? agents.find((a) => a.id === t.agentId)?.name ?? conv.title
    : groups.find((g) => g.id === t.groupId)?.name ?? conv.title
}
export function conversationSubtitle(
  conv: Conversation, agents: Agent[], groups: Group[],
  liveSubagentAgentIds?: ReadonlySet<string>, liveConversationIds?: ReadonlySet<string>,
  instanceBusy?: 'updating' | 'restarting' | null,
): string | null {
  const t = conv.target
  if (t.type === 'agent') {
    if (!agents.some((a) => a.id === t.agentId)) return 'agent'
    return instanceBusy ?? (conversationIsLive(conv, liveSubagentAgentIds, liveConversationIds) ? 'working' : null)
  }
  const g = groups.find((group) => group.id === t.groupId)
  if (!g) return 'group room'
  const live = conversationIsLive(conv, liveSubagentAgentIds, liveConversationIds, g.memberAgentIds)
  return instanceBusy ? `${g.memberAgentIds.length} members · ${instanceBusy}`
    : live ? `${g.memberAgentIds.length} members · working` : `${g.memberAgentIds.length} members`
}
export function sidebarRowText(
  conv: Conversation, agents: Agent[], groups: Group[],
  liveSubagentAgentIds?: ReadonlySet<string>, liveConversationIds?: ReadonlySet<string>,
  instanceBusy?: 'updating' | 'restarting' | null,
): { title: string; sub: string | null; time: string } {
  return {
    title: conversationTitle(conv, agents, groups),
    sub: conversationSubtitle(conv, agents, groups, liveSubagentAgentIds, liveConversationIds, instanceBusy) ??
      (conv.preview ? previewPlainText(conv.preview) || null : null),
    time: relativeActivityTime(conv.lastUsedAt, Date.now()),
  }
}
export type SidebarMenuItem = { id: string; label: string; danger?: boolean }
/** Legacy conversation menu models remain public for existing consumers. */
export function sidebarChromeMenuItems(opts: {
  hiddenCount: number; canCreateGroup?: boolean; canOpenChatHistory?: boolean
}): SidebarMenuItem[] {
  const items: SidebarMenuItem[] = []
  if (opts.canCreateGroup) items.push({ id: 'new-shared-room', label: 'New shared room…' })
  if (opts.canOpenChatHistory) items.push({ id: 'chat-history', label: 'Chat history…' })
  if (opts.hiddenCount > 0) items.push({ id: 'hidden-chats', label: `Hidden chats (${opts.hiddenCount})` })
  return items
}
export function sidebarRowMenuItems(
  conv: Pick<Conversation, 'pinned' | 'hasUnread' | 'target'>,
  opts: { hasAgent?: boolean; canHide?: boolean; canDelete?: boolean; canExport?: boolean } = {},
): SidebarMenuItem[] {
  const items: SidebarMenuItem[] = [
    { id: conv.pinned ? 'unpin' : 'pin', label: conv.pinned ? 'Unpin' : 'Pin' },
    { id: conv.hasUnread ? 'mark-read' : 'mark-unread', label: conv.hasUnread ? 'Mark as Read' : 'Mark as Unread' },
  ]
  if (opts.hasAgent) items.push({ id: 'edit-profile', label: 'Edit Profile' })
  if (conv.target.type === 'agent') items.push({ id: 'duplicate', label: 'Duplicate' })
  items.push({ id: 'copy-id', label: 'Copy conversation ID' })
  if (opts.canExport) items.push({ id: 'export-chat', label: 'Export chat' })
  if (opts.canHide !== false) items.push({ id: 'hide', label: 'Hide from sidebar' })
  if (opts.canDelete !== false) items.push({ id: 'delete', label: 'Delete', danger: true })
  return items
}

/** Shared with MobileHome. Keep focus and suppress duplicate page requests. */
export function ShowMoreConversationsButton({
  loading, onLoadMore,
  className = 'w-full rounded-xl px-3 py-1.5 text-left text-[11px] font-medium text-[var(--ca-primary-text)] transition hover:bg-[var(--ca-hover)] aria-disabled:opacity-60',
  testId = 'sidebar-show-more',
}: {
  loading: boolean; onLoadMore: () => unknown; className?: string; testId?: string
}) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(false)
  const onClick = async () => {
    if (loading || busyRef.current) return
    busyRef.current = true
    const btn = btnRef.current
    const list = btn?.closest('ul') ?? null
    const hadFocus = typeof document !== 'undefined' && document.activeElement === btn
    const rowsBefore = list ? list.children.length - 1 : 0
    try { await onLoadMore() } finally { busyRef.current = false }
    if (!hadFocus || !list) return
    requestAnimationFrame(() => {
      if (btnRef.current?.isConnected) return
      const active = document.activeElement
      if (active && active !== document.body) return
      const row = list.children[rowsBefore] ?? list.lastElementChild
      row?.querySelector<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')?.focus()
    })
  }
  return (
    <button ref={btnRef} type="button" data-testid={testId} onClick={() => void onClick()}
      aria-disabled={loading} aria-busy={loading}
      aria-label={loading ? 'Loading more conversations' : 'Show more conversations'} className={className}>
      {loading ? 'Loading…' : 'Show more conversations'}
    </button>
  )
}

interface SidebarProps {
  skin?: 'messenger' | 'classic'
  agents: RosterAgent[]
  groups: Group[]
  conversations: RosterConversation[]
  selectedConversationId: string | null
  selectedAgentId?: string | null
  liveSubagentAgentIds?: ReadonlySet<string>
  liveConversationIds?: ReadonlySet<string>
  activityByAgent?: Readonly<Record<string, RosterActivity>>
  onOpenAgentInfo?: (agentId: string) => void
  instanceBusy?: 'updating' | 'restarting' | null
  conversationsHydrating?: boolean
  conversationsHasMore?: boolean
  conversationsLoadingMore?: boolean
  onLoadMoreConversations?: () => unknown
  rosterHydrateError?: string | null
  onRetryRoster?: () => void
  onSelectConversation: (conversationId: string) => void
  onPrefetchConversation?: (conversationId: string) => void
  onNewConversation: () => void
  onCreateGroup?: () => void
  onCreateAgent?: (name?: string) => void
  onOpenTarget: (target: ThreadRef) => void
  hiddenConversations?: RosterConversation[]
  onHideConversation?: (conversationId: string) => void
  onUnhideConversation?: (conversationId: string) => void
  onTogglePin?: (conversationId: string) => void
  onMarkRead?: (conversationId: string) => void
  onMarkUnread?: (conversationId: string) => void
  onDuplicate?: (conversationId: string) => void
  onDeleteConversation?: (conversationId: string) => void
  onEditProfile?: (conversationId: string) => void
  onOpenSettings: () => void
  onOpenSearch?: () => void
  /** Back to the Home page. Omitted ⇒ no Home button. */
  onOpenHome?: () => void
  onOpenChats?: () => void
  onOpenRoutines?: () => void
  onManageAgents?: () => void
  destination?: MainDestination
  /** The open plugin page, so its sidebar link shows as current. */
  pluginPath?: string | null
  connectionRecoveryShown?: boolean
  onOpenChatHistory?: () => void
  onExportChat?: (conversationId: string) => void
}

export const Sidebar = memo(function Sidebar({
  skin = 'messenger',
  agents, groups, conversations, selectedConversationId, selectedAgentId,
  liveSubagentAgentIds, liveConversationIds, activityByAgent, onOpenAgentInfo,
  conversationsHydrating = false, conversationsHasMore = false, conversationsLoadingMore = false,
  onLoadMoreConversations, rosterHydrateError, onRetryRoster, onSelectConversation,
  onPrefetchConversation, onCreateAgent, onOpenTarget, hiddenConversations = [],
  onMarkRead, onEditProfile, onOpenSettings, onOpenSearch, onOpenHome, onNewConversation, onCreateGroup,
  onOpenChats, onOpenRoutines, onManageAgents, destination, pluginPath = null, connectionRecoveryShown = false,
}: SidebarProps) {
  const pluginNav = usePluginSidebarNav()
  const reduceMotion = useReducedMotion()
  const focused = useWindowFocused()
  const prefs = useSyncExternalStore(subscribeLocalPrefs, getLocalPrefs, getLocalPrefs)
  const state = useSyncExternalStore(subscribe, getStructuralState, getStructuralState)
  const permissions = useSyncExternalStore(subscribePendingToolPermission, getPendingToolPermissions, getPendingToolPermissions)
  const hostStatus = useHostStatus()
  const [summaries, setSummaries] = useState<Record<string, { preview?: string; lastActivityAt?: string; hasSessions: boolean }>>({})
  useEffect(() => {
    const host = getHostBridge()
    if (!host?.sidebarActivity || hostStatus?.serve.state !== 'up') return
    let alive = true
    let retry: number | undefined
    let attempts = 0
    const refresh = () => { void host.sidebarActivity?.().then(value => {
      if (!alive) return
      // Hermes is up but its socket is still connecting: retry soon, not in a minute.
      if (value === null) {
        if (attempts++ < 5) retry = window.setTimeout(refresh, 1500 * attempts)
        return
      }
      attempts = 0
      setSummaries(value)
    }).catch(() => {}) }
    refresh()
    const timer = window.setInterval(refresh, 60_000)
    return () => { alive = false; window.clearInterval(timer); window.clearTimeout(retry) }
  }, [hostStatus?.serve.state])
  const [width, setWidth] = useState(loadSidebarWidth)
  const [dragging, setDragging] = useState(false)
  const [dragRail, setDragRail] = useState(false)
  const [menu, setMenu] = useState<{ agent: RosterAgent; x: number; y: number } | null>(null)
  const [now, setNow] = useState(Date.now)
  const [navigationOrder, setNavigationOrder] = useState<string[] | null>(null)
  const pointerInRoster = useRef(false)
  const asideRef = useRef<HTMLElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const reorderFrom = useRef<string | null>(null)
  const widthRef = useRef(width)
  const intentTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  if (!dragRef.current) widthRef.current = width
  const compact = dragging ? dragRail : width <= SIDEBAR_WIDTH_MIN

  const commitWidth = useCallback((px: number) => {
    const next = clampSidebarWidth(px)
    widthRef.current = next
    setWidth(next)
    saveSidebarWidth(next)
  }, [])
  useEffect(() => {
    const toggle = () => commitWidth(toggleCompactSidebarWidth(widthRef.current))
    window.addEventListener('maia:toggle-sidebar-compact', toggle)
    const clock = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => {
      window.removeEventListener('maia:toggle-sidebar-compact', toggle)
      window.clearInterval(clock)
    }
  }, [commitWidth])
  useEffect(() => () => {
    if (dragRef.current) {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])
  const cancelIntent = useCallback(() => {
    if (intentTimer.current) clearTimeout(intentTimer.current)
    intentTimer.current = null
  }, [])
  const startIntent = (id?: string) => {
    cancelIntent()
    if (id && onPrefetchConversation) intentTimer.current = setTimeout(() => {
      intentTimer.current = null
      onPrefetchConversation(id)
    }, HOVER_INTENT_MS)
  }
  useEffect(() => cancelIntent, [cancelIntent])
  useEffect(() => {
    if (!menu) return
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenu(null)
      focusAgentRow(menu.agent.id)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', key)
    }
  }, [menu])

  const allConversations = useMemo(() => {
    const byId = new Map(hiddenConversations.map((c) => [c.id, c]))
    for (const c of conversations) byId.set(c.id, c)
    return [...byId.values()]
  }, [conversations, hiddenConversations])
  const sortedRoster = useMemo(() => sortRoster(agents, allConversations, prefs), [agents, allConversations, prefs])
  const roster = useMemo(() => navigationOrder
    ? [...sortedRoster].sort((a, b) => {
      const aIndex = navigationOrder.indexOf(a.id), bIndex = navigationOrder.indexOf(b.id)
      return (aIndex < 0 ? Infinity : aIndex) - (bIndex < 0 ? Infinity : bIndex)
    }) : sortedRoster, [sortedRoster, navigationOrder])
  useEffect(() => setNavigationOrder(null), [prefs.pinnedOrder])
  const selectedConv = allConversations.find((c) => c.id === selectedConversationId)
  const currentAgentId = selectedAgentId ?? (selectedConv?.target.type === 'agent' ? selectedConv.target.agentId : null)
  const selectedAgent = agents.find((a) => a.id === currentAgentId)
  const activities = useMemo(() => {
    const result = new Map<string, RosterActivity>()
    for (const agent of agents) {
      const latest = latestConversation(agent.id, allConversations)
      const relevant = allConversations.filter((c) => belongsToAgent(c, agent.id))
      let live = Boolean(liveSubagentAgentIds?.has(agent.id))
      let liveTool: RosterActivity['liveTool'] = null
      for (const c of relevant) {
        const last = state.messagesByThreadId[c.id]?.findLast((m) => m.role === 'agent')
        const running = last?.toolEvents?.findLast((tool) => tool.status === 'running')
        live ||= Boolean(liveConversationIds?.has(c.id) || last?.streaming || running)
        if (running) {
          let url: string | undefined
          try {
            const args: unknown = JSON.parse(running.args ?? '{}')
            if (args && typeof args === 'object' && 'url' in args && typeof args.url === 'string') url = args.url
          } catch { /* malformed tool args are not a UI failure */ }
          liveTool = { name: running.tool, url, status: running.status }
        }
      }
      const groupLive = allConversations.some((c) => c.target.type === 'group' &&
        liveConversationIds?.has(c.id) && groups.find((g) => c.target.type === 'group' && g.id === c.target.groupId)
          ?.memberAgentIds.includes(agent.id))
      const waiting = permissions.filter(permission => relevant.some(c => c.id === permission.conversationId))
      result.set(agent.id, {
        live: live || groupLive,
        liveTool,
        waitingApproval: waiting.some(permission => permission.kind !== 'question'),
        waitingClarify: waiting.some(permission => permission.kind === 'question'),
        lastActivityDescription: latest?.last_activity_description ?? agent.last_activity_description,
        lastActivityAt: latest?.lastActivityAt ?? latest?.lastUsedAt ?? agent.lastActivityAt,
        ...activityByAgent?.[agent.id],
      })
    }
    return result
  }, [agents, allConversations, state, groups, liveSubagentAgentIds, liveConversationIds, permissions, activityByAgent])
  const animatedIds = sidebarAnimatedOrbIds(roster.map(agent => agent.id),
    id => presenceFor(activities.get(id) ?? {}) !== 'idle', currentAgentId)

  const conversationFor = (agentId: string) => {
    const eligible = conversations.filter((c) => !c.hiddenFromSidebar &&
      prefs.sessionSources.includes(c.source ?? 'desktop'))
    return selectedConv && eligible.some((c) => c.id === selectedConv.id) && belongsToAgent(selectedConv, agentId)
      ? selectedConv : latestConversation(agentId, eligible)
  }
  const openAgent = (agent: RosterAgent) => {
    const conv = conversationFor(agent.id)
    if (conv) {
      onSelectConversation(conv.id)
      onMarkRead?.(conv.id)
    } else onOpenTarget({ type: 'agent', agentId: agent.id })
  }
  const openInfo = (agent: RosterAgent) => {
    if (onOpenAgentInfo) onOpenAgentInfo(agent.id)
    else {
      const conv = conversationFor(agent.id)
      // CONTRACT: onEditProfile is App's existing select + AgentInfo flow.
      // Profiles without conversations need onOpenAgentInfo in wave 2.
      if (conv && onEditProfile) onEditProfile(conv.id)
      else onOpenTarget({ type: 'agent', agentId: agent.id })
    }
  }
  /** The menu is portaled to the body: closing it would otherwise drop focus there. */
  const focusAgentRow = (agentId: string) => requestAnimationFrame(() => {
    const row = [...document.querySelectorAll<HTMLElement>('.hd-agent-row')].find((el) => el.dataset.agentId === agentId)
    row?.querySelector<HTMLElement>('.hd-row-button')?.focus()
  })
  const hide = (agent: RosterAgent) => {
    updateLocalPrefs({ hiddenProfiles: [...prefs.hiddenProfiles, profileName(agent)] })
    setMenu(null)
  }
  const openMenu = (agent: RosterAgent, x: number, y: number) => setMenu({
    agent,
    x: Math.max(8, Math.min(x, window.innerWidth - 200)),
    y: Math.max(8, Math.min(y, window.innerHeight - 100)),
  })
  const endResize = (target: HTMLDivElement, pointerId: number) => {
    if (!dragRef.current) return
    dragRef.current = null
    commitWidth(widthRef.current)
    setDragging(false)
    setDragRail(false)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    try { target.releasePointerCapture(pointerId) } catch { /* already released */ }
  }
  const placeholder = sidebarRosterPlaceholder(roster.length, conversationsHydrating)
  return (
    <aside ref={asideRef} data-skin={skin} data-compact={compact} className="hd-sidebar desk-theme"
      style={{ width: compact ? SIDEBAR_WIDTH_COMPACT : dragging ? widthRef.current : width }}>
      <style>{`
        .hd-sidebar.hd-sidebar {position:relative;display:flex;flex-direction:column;flex-shrink:0;height:100%;min-height:0;overflow:hidden;background:var(--desk-surface-1);color:var(--desk-text-primary)}
        .hd-sidebar .hd-section-label {display:flex;align-items:center;justify-content:space-between;font-size:12px}
        .hd-sidebar .hd-section-label {flex-shrink:0;padding:8px 16px;color:var(--desk-text-tertiary);font-size:11px}
        .hd-sidebar .hd-agent-roster {flex:1;min-height:0;overflow-y:auto;padding:0 8px}
        .hd-sidebar .hd-agent-roster ul {list-style:none;padding:0;margin:0}
        .hd-sidebar .hd-agent-row {position:relative;margin:2px 0}
        .hd-sidebar .hd-row-button {min-height:64px;position:relative;display:flex;gap:8px;padding:8px;border-radius:12px}
        .hd-sidebar .desk-list-row-description {font-size:12px;line-height:16px;color:var(--desk-text-secondary)}
        .hd-sidebar .desk-list-row-meta {font-size:11px;line-height:16px;color:var(--desk-text-tertiary)}
        .hd-sidebar .hd-row-selection {background:var(--desk-surface-3)}
        .hd-sidebar .hd-agent-avatar {display:inline-flex;flex-shrink:0;overflow:visible;border-radius:50%}
        .hd-sidebar .hd-agent-avatar img {object-fit:cover;width:100%;height:100%;border-radius:50%}
        .hd-sidebar .hd-sidebar-footer {flex-shrink:0;border-top:1px solid var(--desk-hairline);padding:4px 8px 0}
        .hd-sidebar .hd-settings {display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:4px 8px;color:var(--desk-text-secondary)}
        .hd-sidebar .hd-restore-trigger {display:block;width:100%;height:var(--desk-space-8);padding:var(--desk-space-1) var(--desk-space-2);font-size:var(--desk-type-11);line-height:var(--desk-leading-11);color:var(--desk-text-secondary)}
        .hd-sidebar .hd-connector-strip {height:32px;align-items:center;padding:4px 0;display:flex;gap:4px;justify-content:center}
        .hd-sidebar .hd-connector {font-size:11px;color:var(--desk-text-tertiary)}
        .hd-sidebar .hd-connector-divider {display:none}
      `}</style>
      <Onboarding onOpenSettings={onOpenSettings} />
      <div className="hd-sidebar-top">
        <header className="hd-sidebar-header">
          {compact ? (
            <IconButton aria-label="Expand sidebar"
              onClick={() => commitWidth(loadExpandedSidebarWidth())}><Icon name="chevron-right" /></IconButton>
          ) : <strong>Hermes Desk</strong>}
          <IconButton aria-label="Search" shortcut="⌘K" tooltipPortal tooltipSide={compact ? 'right' : 'bottom'}
            disabled={!onOpenSearch} onClick={onOpenSearch}><Icon name="search" /></IconButton>
        </header>
        <div className="hd-primary-actions">
          <SidebarCreateActions compact={compact} onNewConversation={onNewConversation} onCreateGroup={onCreateGroup} />
        </div>
        <nav className="hd-main-nav" aria-label="Main navigation">
          {[
            { id: 'home', label: 'Home', icon: 'home' as const, action: onOpenHome },
            { id: 'chats', label: 'Chats', icon: 'chat' as const, action: onOpenChats },
            { id: 'routines', label: 'Routines', icon: 'clock' as const, action: onOpenRoutines },
            // Two plugin pages fit beside the built-ins; the palette lists every page.
            ...pluginNav.slice(0, 2).map(item => ({ id: `plugin:${item.data.path}`, label: item.data.label.slice(0, 24),
              icon: 'sparkle' as const, action: () => pluginHost.navigate(item.data.path), path: item.data.path })),
          ].filter(item => item.action).map(item => <Tooltip key={item.id} content={item.label} side="right"
            disabled={!compact} className="hd-nav-tooltip">
            <button type="button" className="hd-nav-link"
              aria-label={item.label} aria-current={('path' in item ? destination === 'plugin' && pluginPath === item.path :
                destination === item.id) ? 'page' : undefined}
              onClick={item.action}><Icon name={item.icon} size={18} />{!compact && <span>{item.label}</span>}</button>
          </Tooltip>)}
        </nav>
      </div>
      <div className="hd-section-label">{!compact && <span>Agents · {roster.length}</span>}
        <IconButton size="xs" aria-label="Manage agents" onClick={onManageAgents || onOpenSettings}><Icon name="more" size={16} /></IconButton>
      </div>
      {!compact && <p className="hd-roster-hint">Chats keeps your history.</p>}
      <nav className="hd-agent-roster" aria-label="Your agents"
        onPointerEnter={() => { pointerInRoster.current = true; setNavigationOrder(roster.map(agent => agent.id)) }}
        onPointerLeave={() => {
          pointerInRoster.current = false
          if (!asideRef.current?.querySelector('.hd-agent-roster')?.contains(document.activeElement)) setNavigationOrder(null)
        }}
        onFocusCapture={() => setNavigationOrder(previous => previous ?? roster.map(agent => agent.id))}
        onBlurCapture={event => {
          if (!pointerInRoster.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) setNavigationOrder(null)
        }}>
        {rosterHydrateError && !connectionRecoveryShown && <div role="alert" className="hd-roster-placeholder">
          <p>{rosterHydrateError}</p>
          {onRetryRoster && <button type="button" onClick={onRetryRoster}>Retry</button>}
        </div>}
        <ul>
          {roster.map((agent) => {
            const latest = latestConversation(agent.id, allConversations)
            const conv = conversationFor(agent.id)
            const activity = activities.get(agent.id) ?? {}
            const presence = agent.status === 'error' ? 'error' : presenceFor(activity)
            const orbMotion = sidebarRowOrbMotion(focused && !reduceMotion, presence !== 'idle' && presence !== 'error', animatedIds.has(agent.id))
            const unread = unreadFor(agent.id, allConversations)
            const active = currentAgentId === agent.id
            const rowDescription = activity.waitingApproval ? 'Waiting for your approval'
              : activity.waitingClarify ? 'Waiting for your answer'
                : presence !== 'idle' && presence !== 'error' ? activityLine({ liveTool: activity.liveTool }, now) || 'Working…'
                  : sidebarPreview(agent, latest, summaries[profileName(agent)], now)
            // The row's aria-label replaces its content, so status, preview and
            // unread count are exposed as its accessible description instead.
            const statusDescription = [
              presence === 'error' ? 'Agent error' : '',
              rowDescription,
              unread > 0 ? `${unread} unread` : '',
            ].filter(Boolean).join(', ')
            return (
              <li key={agent.id} className="hd-agent-row" data-agent-id={agent.id} data-selected={active}
                data-presence={presence} data-unread={unread > 0}
                data-conversation-id={conv?.id} draggable
                onDragStart={(e) => {
                  reorderFrom.current = agent.id
                  cancelIntent()
                  if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', agent.id)
                  }
                }}
                onDragOver={(e) => { if (reorderFrom.current) e.preventDefault() }}
                onDrop={(e) => {
                  e.preventDefault()
                  const from = reorderFrom.current
                  reorderFrom.current = null
                  if (from) updateLocalPrefs({
                    pinnedOrder: reorderRoster(roster.map((a) => a.id), from, agent.id, prefs.pinnedOrder),
                  })
                }}
                onDragEnd={() => { reorderFrom.current = null }}
                onPointerEnter={() => startIntent(conv?.id)} onPointerLeave={cancelIntent}
                onFocus={() => startIntent(conv?.id)} onBlur={cancelIntent}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openMenu(agent, e.clientX, e.clientY)
                }}>
                {active && <motion.span className="hd-row-selection"
                  layoutId="sidebar-selection" data-testid={compact ? 'sidebar-rail-selection' : 'sidebar-selection'}
                  transition={reduceMotion ? { duration: 0 } : SELECTION_SPRING} />}
                <Tooltip content={agent.ui_meta?.display_name ?? agent.name} side="right" disabled={!compact}
                  className="desk-tooltip-anchor-block">
                <ListRow className="hd-row-button" aria-label={agent.ui_meta?.display_name ?? agent.name}
                  aria-description={statusDescription || undefined}
                  aria-current={active || undefined} onClick={() => openAgent(agent)}
                  title={compact ? '' : agent.ui_meta?.display_name ?? agent.name}
                  leading={compact ? <span className="hd-rail-avatar">
                    <AgentAvatar agent={agent} size={36} presence={presence} {...orbMotion} />
                    <Badge className="hd-rail-unread" count={unread} tone="accent" />
                    {agent.orchestrator && <span className="hd-rail-orchestrator" aria-label="Orchestrator">
                      <Icon name="sparkle" size={12} />
                    </span>}
                  </span> : <AgentAvatar agent={agent} presence={presence} {...orbMotion} />}
                  description={compact ? undefined : rowDescription}
                  trailing={!compact && (unread > 0 || agent.orchestrator || activity.waitingApproval || activity.waitingClarify || presence === 'error') ? <span className="flex items-center gap-1">
                    {(activity.waitingApproval || activity.waitingClarify || presence === 'error') && <span
                      className="hd-row-attention" role="img" aria-label={presence === 'error' ? 'Agent error' : activity.waitingApproval ? 'Needs approval' : 'Needs an answer'}>
                      <Icon name={presence === 'error' ? 'x' : 'reply'} size={16} />
                    </span>}
                    {agent.orchestrator && <span aria-label="Orchestrator"><Icon name="sparkle" size={16} /></span>}
                    <Badge count={unread} tone="accent" /></span> : undefined}
                  onKeyDown={(e) => {
                    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                      e.preventDefault()
                      const rect = e.currentTarget.getBoundingClientRect()
                      openMenu(agent, rect.left, rect.bottom)
                    }
                    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                      e.preventDefault()
                      const index = roster.findIndex((a) => a.id === agent.id)
                      const target = roster[index + (e.key === 'ArrowUp' ? -1 : 1)]
                      if (target) updateLocalPrefs({
                        pinnedOrder: reorderRoster(roster.map((a) => a.id), agent.id, target.id, prefs.pinnedOrder),
                      })
                    }
                  }} />
                </Tooltip>
              </li>
            )
          })}
          {placeholder && <li className="hd-roster-placeholder" aria-busy={placeholder === 'loading'}
            aria-label={placeholder === 'loading' ? 'Loading agents' : undefined}>
            {placeholder === 'loading' ? 'Loading agents…' : connectionRecoveryShown ? 'Reconnect to load your agents.' : <EmptyState
              kind={hostStatus?.installation && !hostStatus.installation.detected ? 'hermes-not-found' : 'no-profiles'}
              onAction={onOpenSettings} />}
          </li>}
          {conversationsHasMore && onLoadMoreConversations && <li>
            <ShowMoreConversationsButton loading={conversationsLoadingMore} onLoadMore={onLoadMoreConversations}
              className="hd-roster-placeholder" />
          </li>}
        </ul>
      </nav>
      <footer className="hd-sidebar-footer">
        {selectedAgent && <AgentCard key={selectedAgent.id} agent={selectedAgent} presence={selectedAgent.status === 'error' ? 'error' : presenceFor(activities.get(selectedAgent.id) ?? {})}
          compact={compact} paused={!focused || Boolean(reduceMotion)} onOpenInfo={() => openInfo(selectedAgent)} />}
        <Tooltip content="Settings" shortcut="⌘," side="right" disabled={!compact} className="desk-tooltip-anchor-block">
          <button type="button" className="hd-settings" aria-label="Settings" onClick={onOpenSettings}>
            <Icon name="settings" size={20} />{!compact && <span>Settings</span>}
          </button>
        </Tooltip>
        <p className="hd-connection-summary" role="status" title={compact ? (hostStatus?.serve.state === 'up' ? 'Hermes connected' : 'Hermes disconnected') : undefined}>
          <i className="hd-status-dot" data-state={hostStatus?.serve.state === 'up' ? 'ready' : 'unknown'} aria-hidden="true" />
          <span className={compact ? 'desk-sr-only' : undefined}>{hostStatus?.serve.state === 'up' ? 'Hermes connected' :
            hostStatus?.serve.state === 'starting' ? 'Hermes connecting…' : hostStatus?.serve.state === 'down' ? 'Hermes disconnected' : 'Checking Hermes connection…'}</span>
        </p>
        <RestoreHiddenMenu agents={agents} hiddenProfiles={prefs.hiddenProfiles} compact={compact}
          onRestore={(profile) => updateLocalPrefs({
            hiddenProfiles: prefs.hiddenProfiles.filter((p) => p !== profile),
          })} />
        {!compact && <PluginSlot area="statusBar.left" className="hd-plugin-status" />}
        {!compact && <PluginSlot area="statusBar.right" className="hd-plugin-status" />}
        <ConnectorStrip status={hostStatus} compact={compact} />
      </footer>
      {menu && createPortal(
        <div data-skin={skin} data-esc-layer>
          <div ref={menuRef} role="menu" aria-label={`${menu.agent.name} actions`} className="hd-sidebar-menu"
            style={{ position: 'fixed', left: menu.x, top: menu.y, bottom: 'auto' }}
            onKeyDown={(e) => {
              const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
              const at = items.indexOf(document.activeElement as HTMLElement)
              const go = (i: number) => {
                e.preventDefault()
                items[(i + items.length) % items.length]?.focus()
              }
              if (e.key === 'ArrowDown') go(at + 1)
              else if (e.key === 'ArrowUp') go(at - 1)
              else if (e.key === 'Home') go(0)
              else if (e.key === 'End') go(items.length - 1)
              else if (e.key === 'Tab') setMenu(null)
            }}>
            <button type="button" role="menuitem" autoFocus onClick={() => {
              const key = profileName(menu.agent)
              const pinned = prefs.pinnedOrder.includes(menu.agent.id) || prefs.pinnedOrder.includes(key)
              updateLocalPrefs({ pinnedOrder: pinned
                ? prefs.pinnedOrder.filter((id) => id !== menu.agent.id && id !== key)
                : [...prefs.pinnedOrder, menu.agent.id] })
              setMenu(null)
              focusAgentRow(menu.agent.id)
            }}>{prefs.pinnedOrder.includes(menu.agent.id) || prefs.pinnedOrder.includes(profileName(menu.agent))
                ? 'Unpin' : 'Pin'}</button>
            <button type="button" role="menuitem" onClick={() => hide(menu.agent)}>Hide</button>
            <button type="button" role="menuitem" onClick={() => { openInfo(menu.agent); setMenu(null) }}>Agent details</button>
          </div>
        </div>, document.body,
      )}
      {!compact && onCreateAgent && <details className="hd-agent-management"><summary>Agent actions</summary>
        <Button onClick={() => onCreateAgent()}>New agent</Button>
        {onManageAgents && <Button onClick={onManageAgents}>Manage agents</Button>}
      </details>}
      <div role="separator" aria-orientation="vertical" aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_WIDTH_MIN} aria-valuemax={SIDEBAR_WIDTH_MAX} aria-valuenow={width}
        tabIndex={0} title="Drag to resize · double-click to reset"
        className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none"
        onDoubleClick={() => commitWidth(SIDEBAR_WIDTH_DEFAULT)}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          dragRef.current = { startX: e.clientX, startW: widthRef.current }
          setDragging(true)
          setDragRail(widthRef.current <= SIDEBAR_WIDTH_MIN)
          document.body.style.cursor = 'col-resize'
          document.body.style.userSelect = 'none'
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current
          if (!drag) return
          const raw = drag.startW + e.clientX - drag.startX
          const rail = raw < SIDEBAR_WIDTH_MIN
          widthRef.current = clampSidebarWidth(raw)
          setDragRail(rail)
          if (asideRef.current) asideRef.current.style.width = `${rail ? SIDEBAR_WIDTH_COMPACT : widthRef.current}px`
        }}
        onPointerUp={(e) => endResize(e.currentTarget, e.pointerId)}
        onPointerCancel={(e) => endResize(e.currentTarget, e.pointerId)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 32 : 16
          const next = e.key === 'ArrowLeft' ? widthRef.current - step
            : e.key === 'ArrowRight' ? widthRef.current + step
              : e.key === 'Home' ? SIDEBAR_WIDTH_MIN : e.key === 'End' ? SIDEBAR_WIDTH_MAX : null
          if (next !== null) { e.preventDefault(); commitWidth(next) }
        }} />
    </aside>
  )
})
