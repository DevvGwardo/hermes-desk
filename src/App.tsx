import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
const ChatPanel = lazy(() => import('./components/ChatPanel').then((m) => ({ default: m.ChatPanel })))
import { SidePanel, readSidePanelWidth } from './components/SidePanel'
import { OfflineBanner } from './components/OfflineBanner'
import { WorkspacePane } from './components/workspace/WorkspacePane'
import { WorkspaceComputerPreview } from './components/WorkspaceComputerPreview'
import type { PaletteCommand } from './components/CommandPalette'
import type { FilePreviewGuard } from './components/FilePreview'
import { useAgentRuntime } from './lib/agents/useAgentRuntime'
import { getActiveTransport } from './lib/agents/active-transport'
import { HermesLocalTransport, type LocalTransportEvent } from './lib/agents/hermes-local-transport'
import { bindLocalWorkspaceSession, configureLocalTransport } from './lib/agents/local-transport-prefs'
import { getHydrateStatus, getState, setHydrateStatus, subscribe } from './lib/agents/store'
import { roomMemberName } from './lib/agents/rooms'
import { activityLine, latestConversation, profileName, sortRoster, type RosterActivity, type RosterAgent } from './lib/agents/roster'
import { resolveAgentMascot, type NewAgentProfile } from './lib/agents'
import { getLocalPrefs, subscribeLocalPrefs } from './lib/local-prefs'
import { getHostBridge, getWorkspaceBridge, type TabSummary } from './lib/desktop-bridge'
import { useHostConfig } from './lib/host-config'
import { installShellShortcuts } from './lib/shortcuts'
import { useSystemNotifications } from './lib/use-system-notifications'
import { installDeskAutomation, type AutomationFlag } from './components/chat/automation'
import { messageMascotPresence } from './components/chat/presence'
import { cueMascot } from './lib/mascot/cues'
import { finishLocalSetup, shouldShowLocalSetup } from './components/chat/local-setup'
import type { AgentMascotPresence } from './components/AgentMascot'
import type { ChatMessage } from './lib/agents'
import { Button } from './components/ui/Button'
import './styles/desk-tokens.css'
export { notifyLocalEvent } from './lib/use-system-notifications'
import { onOpenSettingsRequest, type SettingsPaneRequest } from './lib/open-settings'
import { onOpenFilesRequest } from './lib/open-files'
import { launchHash, parseHash, resolveRoute, serializeRoute, shouldPushRoute, writeHash, type RouteState } from './lib/router'
import { getHomeOnLaunch } from './lib/home-prefs'
import { recordActivity } from './lib/activity-log'
import { activityEntries } from './lib/home-heatmap'
import { HomePage } from './components/home/HomePage'
import { useEverOpened } from './lib/use-ever-opened'
import { startHudActivityRelay } from './lib/hud-activity'
import { isViewerOpen, useViewerState } from './lib/image-viewer'
import { fileRefsFromMessages } from './lib/file-refs'
import { loadRoutines, markLocalRun, removeRoutine, routineDraftOf, sameRoutine, setRoutineEnabled, testRunRemote, upsertRoutine, type Routine, type RoutineDraft } from './lib/routines'
import { useLocalRoutineScheduler } from './lib/use-local-routine-scheduler'
import { PluginHost, usePluginPaletteCommands, usePluginRoutes, usePluginThemes } from './plugins/PluginHost'
import { $activeProfile, PLUGIN_ROUTE_EVENT, seedPluginSession } from './plugins/host'
import { setDesignProfile } from './lib/design-preset'
import { PluginPage } from './plugins/PluginPage'
import { activePluginThemeId, setPluginTheme } from './plugins/themes'
import { agentColor } from './components/AgentCard'
import { ChatsPage } from './components/ChatsPage'
import { NewChatDialog } from './components/NewChatDialog'
import { destinationFor, initialWorkspaceOpen, panelBudget, WORKSPACE_MIN_WIDTH, WORKSPACE_OPEN_KEY, type MainDestination } from './lib/shell-layout'
import { ShellLayoutContext, useShellLayout } from './lib/use-shell-layout'
import { Icon } from './components/ui/icons'
import { requestSkillDraft, skillRequest } from './lib/skill-draft'
import { memoryReviewRequest } from './lib/profile-memory'
import { getPendingToolPermissions, subscribePendingToolPermission } from './lib/agents/tool-permission'

const AgentInfo = lazy(() => import('./components/AgentInfo').then((m) => ({ default: m.AgentInfo })))
const AgentEditor = lazy(() => import('./components/AgentEditor').then((m) => ({ default: m.AgentEditor })))
const GroupEditor = lazy(() => import('./components/GroupEditor').then((m) => ({ default: m.GroupEditor })))
const SettingsStub = lazy(() => import('./components/SettingsStub').then((m) => ({ default: m.SettingsStub })))
const CommandPalette = lazy(() => import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })))
const ImproveHermesDesk = lazy(() => import('./components/ImproveHermesDesk').then((m) => ({ default: m.ImproveHermesDesk })))
const FilesPanel = lazy(() => import('./components/FilesPanel'))
const FilePreview = lazy(() => import('./components/FilePreview'))
const KanbanPanel = lazy(() => import('./components/KanbanPanel').then((m) => ({ default: m.KanbanPanel })))
const HermesSurfacesPanel = lazy(() => import('./components/ProfileToolsPanel').then((m) => ({ default: m.ProfileToolsPanel })))
const RoutineEditor = lazy(() => import('./components/RoutineEditor').then((m) => ({ default: m.RoutineEditor })))
const RoutinesPage = lazy(() => import('./components/RoutinesPage').then((m) => ({ default: m.RoutinesPage })))

export function localActivityForEvent(event: LocalTransportEvent): { agentId: string; activity: RosterActivity } | null {
  if (event.type !== 'message' || event.message.role !== 'agent' || !event.message.fromAgentId) return null
  const tool = event.message.toolEvents?.findLast((item) => item.status === 'running')
  let url: string | undefined
  try {
    const args: unknown = JSON.parse(tool?.args ?? '{}')
    if (args && typeof args === 'object' && 'url' in args && typeof args.url === 'string') url = args.url
  } catch { /* malformed arguments do not break presence */ }
  return {
    agentId: event.message.fromAgentId,
    activity: {
      live: Boolean(event.message.streaming),
      liveTool: tool ? { name: tool.tool, status: tool.status, url } : null,
      thinking: Boolean(event.message.streaming && !tool),
    },
  }
}

export default function App() {
  const runtime = useAgentRuntime()
  const viewerOpen = useViewerState() !== null
  const hydrate = useSyncExternalStore(subscribe, getHydrateStatus, getHydrateStatus)
  const pendingPermissions = useSyncExternalStore(subscribePendingToolPermission, getPendingToolPermissions, getPendingToolPermissions)
  const prefs = useSyncExternalStore(subscribeLocalPrefs, getLocalPrefs, getLocalPrefs)
  const hostConfig = useHostConfig()
  const skin = hostConfig?.appearance.messengerSkin === false ? 'classic' : 'messenger'
  const initial = useMemo(() => {
    const hash = launchHash(window.location.hash, getHomeOnLaunch())
    if (hash !== window.location.hash) writeHash(hash, false)
    return parseHash(hash)
  }, [])
  const [showWorkspace, setShowWorkspace] = useState(initialWorkspaceOpen)
  const [workArea, setWorkArea] = useState<'chat' | 'workspace'>(() => initialWorkspaceOpen() ? 'workspace' : 'chat')
  const [workspaceWidth, setWorkspaceWidth] = useState(() => readSidePanelWidth('workspace', 480))
  const shellRef = useRef<HTMLDivElement>(null)
  const geometry = useShellLayout(shellRef)
  const [showInfo, setShowInfo] = useState(initial.info && !initial.files)
  const [showFiles, setShowFiles] = useState(initial.files)
  const [showSettings, setShowSettings] = useState(initial.settings)
  const [settingsPane, setSettingsPane] = useState<SettingsPaneRequest | null>(initial.settingsPane)
  const [previewPath, setPreviewPath] = useState<string | null>(initial.previewPath)
  const previewGuard = useRef<FilePreviewGuard | null>(null)
  const previewPathRef = useRef(previewPath)
  previewPathRef.current = previewPath
  const [showPalette, setShowPalette] = useState(false)
  const [showImprovements, setShowImprovements] = useState(false)
  const [agentEditorOpen, setAgentEditorOpen] = useState(false)
  const [groupEditorOpen, setGroupEditorOpen] = useState(false)
  const groupEditorEpoch = useRef(0)
  const openGroupEditor = useCallback(() => {
    groupEditorEpoch.current += 1
    setGroupEditorOpen(true)
  }, [])
  const closeGroupEditor = useCallback(() => {
    groupEditorEpoch.current += 1
    setGroupEditorOpen(false)
  }, [])
  useEffect(() => () => { groupEditorEpoch.current += 1 }, [])
  const [showKanban, setShowKanban] = useState(initial.kanban)
  const [toolsTab, setToolsTab] = useState<RouteState['toolsTab']>(initial.toolsTab)
  const [destination, updateDestination] = useState<MainDestination>(() => destinationFor(initial))
  const showRoutines = destination === 'routines'
  const showHome = destination === 'home'
  const showChats = destination === 'chats'
  const showPluginPage = destination === 'plugin'
  const [pluginPath, setPluginPath] = useState<string | null>(null)
  const chatActive = destination === 'chat'
  const [newChatPicker, setNewChatPicker] = useState(false)
  const [routines, setRoutines] = useState<Routine[]>([])
  const [routineEditorOpen, setRoutineEditorOpen] = useState(false)
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null)
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null)
  const [activityByAgent, setActivityByAgent] = useState<Record<string, RosterActivity>>({})
  const [mascotStates, setMascotStates] = useState<Record<string, AgentMascotPresence>>({})
  const [leaseConflicts, setLeaseConflicts] = useState<Record<string, boolean>>({})
  const [branchBusy, setBranchBusy] = useState(false)
  const branchPending = useRef(false)
  const [showLocalGuide, setShowLocalGuide] = useState(() => shouldShowLocalSetup(window.localStorage))
  const happyTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [shellError, setShellError] = useState<string | null>(null)
  const [transportReady, setTransportReady] = useState(false)
  const transportRef = useRef<HermesLocalTransport | null>(null)
  const runtimeRef = useRef(runtime)
  runtimeRef.current = runtime
  const stopRequests = useRef(new Map<string, Promise<boolean>>())
  const [stoppingConversationId, setStoppingConversationId] = useState<string | null>(null)
  const registrationIds = useRef(new Set<string>())
  const routeApplied = useRef(false)
  const startupSettingsIntent = useRef<Pick<RouteState, 'settings' | 'settingsPane'> | null>(null)
  const startupDestinationIntent = useRef<MainDestination | null>(null)
  const setDestination = useCallback((next: MainDestination) => {
    if (!routeApplied.current) startupDestinationIntent.current = next
    updateDestination(next)
  }, [])
  const lastWrittenHash = useRef<string | null>(null)
  const lastRoute = useRef(initial)

  const everInfo = useEverOpened(showInfo)
  const everFiles = useEverOpened(showFiles)
  const everSettings = useEverOpened(showSettings)
  const everPreview = useEverOpened(previewPath !== null)
  const everPalette = useEverOpened(showPalette)
  const everImprovements = useEverOpened(showImprovements)
  const everEditor = useEverOpened(agentEditorOpen)
  const everGroupEditor = useEverOpened(groupEditorOpen)
  const everKanban = useEverOpened(showKanban)
  const everTools = useEverOpened(toolsTab !== null)
  const everRoutineEditor = useEverOpened(routineEditorOpen)

  const reportError = useCallback(() => setShellError('The local action could not finish. Open Diagnostics to check Hermes.'), [])
  const stopSelectedTurn = useCallback((): Promise<boolean> => {
    const current = runtimeRef.current
    const id = current.selectedConversation?.id
    if (!id) return Promise.resolve(false)
    const pending = stopRequests.current.get(id)
    if (pending) return pending
    setStoppingConversationId(id)
    const request = Promise.resolve().then(() => current.stopTurn()).finally(() => {
      if (stopRequests.current.get(id) === request) stopRequests.current.delete(id)
      setStoppingConversationId(value => value === id ? null : value)
    })
    stopRequests.current.set(id, request)
    return request
  }, [])
  const refreshRoster = useCallback(async () => {
    const transport = transportRef.current
    if (!transport) return
    try { await transport.listConversations() }
    catch { setHydrateStatus({ rosterHydrating: false, conversationsHydrating: false }) }
  }, [])
  const openSettings = useCallback((pane?: SettingsPaneRequest) => {
    if (!routeApplied.current) startupSettingsIntent.current = { settings: true, settingsPane: pane ?? null }
    setSettingsPane(pane ?? null)
    setShowSettings(true)
  }, [])
  const closeSettings = useCallback(() => {
    if (!routeApplied.current) startupSettingsIntent.current = { settings: false, settingsPane: null }
    setShowSettings(false)
  }, [])
  const chooseSettingsPane = useCallback((pane: SettingsPaneRequest | null) => {
    if (!routeApplied.current) startupSettingsIntent.current = { settings: true, settingsPane: pane }
    setSettingsPane(pane)
  }, [])
  const selectConversation = useCallback((id: string) => {
    setDestination('chat')
    runtimeRef.current.handleSelect(id)
  }, [])
  const openAgent = useCallback((agentId: string) => {
    const current = runtimeRef.current
    const latest = latestConversation(agentId, current.conversations.filter(chat => !chat.hiddenFromSidebar && !chat.placeholder))
    setDestination('chat')
    if (latest) current.handleSelect(latest.id)
    else current.openWithTarget({ type: 'agent', agentId })
  }, [])
  const newChatForAgent = useCallback((agentId: string) => {
    setDestination('chat')
    setNewChatPicker(false)
    setShowInfo(false)
    setShowFiles(false)
    runtimeRef.current.newConversation({ type: 'agent', agentId })
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.messenger-chat textarea[aria-label="Message the agent"]')?.focus())
  }, [])
  const newConversation = useCallback(() => {
    const agent = runtimeRef.current.selectedAgent
    if (agent) newChatForAgent(agent.id)
    else setNewChatPicker(true)
  }, [newChatForAgent])
  const openInfo = useCallback((agentId?: string) => {
    if (agentId && agentId !== runtimeRef.current.selectedAgent?.id) openAgent(agentId)
    setShowFiles(false)
    setShowInfo(true)
  }, [openAgent])
  const openHome = useCallback(() => {
    setShowInfo(false)
    setShowFiles(false)
    setDestination('home')
  }, [])
  const openChats = useCallback(() => {
    setShowInfo(false)
    setShowFiles(false)
    setDestination('chats')
  }, [])
  const openRoutines = useCallback(() => {
    setShowInfo(false)
    setShowFiles(false)
    setDestination('routines')
  }, [])
  useEffect(() => {
    const open = (event: Event) => {
      const path = (event as CustomEvent<{ path?: unknown }>).detail?.path
      if (typeof path !== 'string') return
      setShowInfo(false)
      setShowFiles(false)
      setPluginPath(path)
      setDestination('plugin')
    }
    window.addEventListener(PLUGIN_ROUTE_EVENT, open)
    return () => window.removeEventListener(PLUGIN_ROUTE_EVENT, open)
  }, [setDestination])
  const pluginCommands = usePluginPaletteCommands()
  const pluginRoutes = usePluginRoutes()
  const pluginThemes = usePluginThemes()
  const toggleWorkspace = useCallback(() => {
    const next = !showWorkspace
    try { window.localStorage.setItem(WORKSPACE_OPEN_KEY, String(next)) } catch { /* layout only */ }
    setShowInfo(false)
    setShowFiles(false)
    setShowWorkspace(next)
    setWorkArea(next ? 'workspace' : 'chat')
    if (!next) window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="Toggle workspace"]')?.focus())
  }, [showWorkspace])
  const openFile = useCallback((path: string) => {
    if (previewGuard.current && !previewGuard.current.confirmLeave()) return
    setPreviewPath(path)
  }, [])
  const closePreview = useCallback(() => {
    if (!previewGuard.current || previewGuard.current.confirmLeave()) setPreviewPath(null)
  }, [])
  const openFiles = useCallback(() => { setShowInfo(false); setShowFiles(true) }, [])
  useSystemNotifications({
    linked: transportReady && !hydrate.readOnly, local: true, transport: transportRef.current,
    onOpenConversation: selectConversation, onOpenRoutine: openRoutines,
  })
  useEffect(() => () => { for (const timer of happyTimers.current.values()) clearTimeout(timer) }, [])

  useEffect(() => {
    let cancelled = false
    let off: (() => void) | undefined
    void getActiveTransport().then(({ transport }) => {
      if (cancelled || !(transport instanceof HermesLocalTransport)) return
      configureLocalTransport(transport)
      transportRef.current = transport
      setTransportReady(true)
      off = transport.subscribeLocal((event) => {
        if (event.type === 'lease') setLeaseConflicts(previous => ({ ...previous, [event.conversationId]: event.held }))
        let mascotAgent: string | undefined
        let presence: AgentMascotPresence | undefined
        if (event.type === 'message' && event.message.role === 'agent') {
          mascotAgent = event.message.fromAgentId
          presence = messageMascotPresence(event.message)
        } else if (event.type === 'turn' && ['done', 'failed'].includes(event.turn.phase)) {
          mascotAgent = event.turn.agentId
          presence = event.turn.phase === 'failed' ? 'error' : 'happy'
        } else if (event.type === 'clarify' || event.type === 'permission') {
          const target = getState().conversations.find(c => c.id === event.conversationId)?.target
          mascotAgent = target?.type === 'agent' ? target.agentId : undefined
          presence = (event.type === 'clarify' ? event.prompt : event.ask) ? 'waiting-approval' : 'thinking'
        }
        if (mascotAgent && presence) {
          const id = mascotAgent
          // Motion v2 stage cues: Pip delivers a settled reply and waits on approval cards.
          // Deferred a beat so the bubble / approval surface has rendered before it takes off.
          if (event.type === 'turn' && presence === 'happy') window.setTimeout(() => cueMascot(id, { type: 'deliver', key: event.turn.id }), 260)
          if (event.type === 'clarify' || event.type === 'permission') {
            const waiting = presence === 'waiting-approval'
            window.setTimeout(() => cueMascot(id, waiting ? { type: 'await-approval' } : { type: 'home' }), waiting ? 220 : 0)
          }
          clearTimeout(happyTimers.current.get(id))
          setMascotStates(previous => ({ ...previous, [id]: presence! }))
          if (presence === 'happy') happyTimers.current.set(id, setTimeout(() => {
            setMascotStates(previous => ({ ...previous, [id]: previous[id] === 'happy' ? 'idle' : previous[id]! }))
            happyTimers.current.delete(id)
          }, 1600))
        }
        let activity = localActivityForEvent(event)
        if (activity && !activity.activity.live) {
          const state = getState()
          const agentId = activity.agentId
          const otherLive = state.conversations.filter((c) => c.target.type === 'agent' && c.target.agentId === agentId)
            .flatMap((c) => state.messagesByThreadId[c.id] ?? []).findLast((message) => message.role === 'agent' && message.streaming)
          if (otherLive) activity = localActivityForEvent({ type: 'message', conversationId: otherLive.threadId, message: otherLive })
        }
        if (activity) setActivityByAgent((previous) => ({
          ...previous, [activity.agentId]: { ...previous[activity.agentId], ...activity.activity },
        }))
        if (event.type === 'clarify' || event.type === 'permission') {
          const conversation = getState().conversations.find((c) => c.id === event.conversationId)
          if (conversation?.target.type === 'agent') {
            const agentId = conversation.target.agentId
            setActivityByAgent((previous) => ({
              ...previous, [agentId]: { ...previous[agentId],
                ...(event.type === 'clarify' ? { waitingClarify: !!event.prompt } : { waitingApproval: !!event.ask }) },
            }))
          }
        }
      })
      void refreshRoster()
    }).catch(reportError)
    return () => { cancelled = true; off?.(); transportRef.current = null }
  }, [refreshRoster, reportError])
  const rosterPrefsKey = JSON.stringify([prefs.hiddenProfiles, prefs.showScratch, prefs.sessionSources])
  useEffect(() => {
    const timer = setTimeout(() => { void refreshRoster() }, 500)
    return () => clearTimeout(timer)
  }, [rosterPrefsKey, refreshRoster])
  // A profile's model is edited outside Desk (`hermes model`, `/model`, a config
  // edit), so the roster snapshot taken at connect goes stale while the window
  // sits in the background and the chat header keeps reporting the old model.
  // Re-read it when the app comes back to the front, throttled so focus
  // ping-ponging cannot turn into a request loop.
  const rosterRefreshedAt = useRef(0)
  useEffect(() => {
    const refreshIfStale = () => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - rosterRefreshedAt.current < 30_000) return
      rosterRefreshedAt.current = now
      void refreshRoster()
    }
    window.addEventListener('focus', refreshIfStale)
    document.addEventListener('visibilitychange', refreshIfStale)
    return () => {
      window.removeEventListener('focus', refreshIfStale)
      document.removeEventListener('visibilitychange', refreshIfStale)
    }
  }, [refreshRoster])
  useEffect(() => startHudActivityRelay(), [])
  useEffect(() => {
    seedPluginSession(runtime.selectedAgent ? profileName(runtime.selectedAgent) : 'default', null)
  }, [runtime.selectedAgent])
  // Design presets follow the active Hermes profile (Appearance → Design).
  useEffect(() => {
    const apply = (profile: string) => setDesignProfile(profile)
    apply($activeProfile.get())
    return $activeProfile.listen(apply)
  }, [])
  useEffect(() => onOpenSettingsRequest((pane) => openSettings(pane)), [openSettings])
  useEffect(() => onOpenFilesRequest(openFiles), [openFiles])
  useEffect(() => installDeskAutomation(window, import.meta.env.DEV,
    (window.nubAgent as unknown as { automation?: AutomationFlag } | undefined)?.automation, {
      version: '1',
      getState: () => {
        const state = getState()
        return { agents: state.agents, conversations: state.conversations, selectedConversationId: state.selectedConversationId,
          selectedAgentId: runtimeRef.current.selectedAgent?.id ?? null, hydrate: getHydrateStatus(), offline: getHydrateStatus().readOnly }
      },
      selectAgent: openAgent,
      openPanel: name => {
        if (name === 'files') openFiles()
        else if (name === 'settings') openSettings()
        else if (name === 'info') openInfo()
        else if (name === 'workspace') { setDestination('chat'); setShowInfo(false); setShowFiles(false); setShowWorkspace(true); setWorkArea('workspace') }
      },
      getMascotStates: () => mascotStates,
    }), [openAgent, openFiles, openSettings, openInfo, mascotStates])
  useEffect(() => {
    const hud = window.nubAgent?.hud as unknown as {
      onOpenConversation?: (callback: (value: { conversationId?: string }) => void) => (() => void) | void
    } | undefined
    const off = hud?.onOpenConversation?.((value) => {
      if (value?.conversationId) selectConversation(value.conversationId)
    })
    return () => { if (typeof off === 'function') off() }
  }, [selectConversation])

  const registerSession = useCallback((binding: { profile: string; storedId: string; runtimeId: string }) => {
    const bridge = getWorkspaceBridge()
    if (!bridge?.registerSession) return
    const key = `${binding.profile}:${binding.storedId}:${binding.runtimeId}`
    if (registrationIds.current.has(key)) return
    registrationIds.current.add(key)
    void bridge.registerSession(binding).catch(() => { registrationIds.current.delete(key) })
  }, [])
  useEffect(() => {
    if (hydrate.readOnly) { registrationIds.current.clear(); return }
    for (const session of Object.values(hydrate.localSessions)) {
      if (session.binding) registerSession(session.binding)
    }
  }, [hydrate.localSessions, hydrate.readOnly, registerSession])
  useEffect(() => {
    const transport = transportRef.current
    const conversation = runtime.selectedConversation
    if (!transport || !conversation || hydrate.readOnly) return
    void bindLocalWorkspaceSession(transport, conversation).then((binding) => {
      if (binding) registerSession(binding)
    }).catch(() => { /* host/controller health explains failed registrations */ })
  }, [transportReady, runtime.selectedConversation?.id, runtime.selectedConversation?.hermesSessionId, hydrate.readOnly, registerSession])

  // Home heatmap: remember each day a chat was active (ids only). Debounced so a
  // streaming reply records once it settles, not per token.
  useEffect(() => {
    const timer = window.setTimeout(() => recordActivity(activityEntries(runtime.conversations, runtime.messagesByThreadId)), 1500)
    return () => window.clearTimeout(timer)
  }, [runtime.conversations, runtime.messagesByThreadId])
  const roster = useMemo(() => sortRoster(runtime.agents, runtime.conversations, prefs), [runtime.agents, runtime.conversations, prefs])
  const rosterRef = useRef(roster)
  rosterRef.current = roster
  useEffect(() => installShellShortcuts({
    selectAgent: (index) => { const agent = rosterRef.current[index]; if (agent) openAgent(agent.id) },
    openTab: (lane) => {
      const bridge = getWorkspaceBridge()
      const agent = runtimeRef.current.selectedAgent
      if (!bridge || (lane === 'agent' && !agent)) return
      const laneId = lane === 'agent' ? `profile:${profileName(agent!)}` : 'you'
      setDestination('chat')
      setShowWorkspace(true)
      setWorkArea('workspace')
      setShowInfo(false)
      setShowFiles(false)
      void (async () => {
        await bridge.focusLane(laneId)
        const id = await bridge.openTab(laneId)
        await bridge.activate(id)
      })().catch(reportError)
    },
    stopAll: () => {
      const bridge = getWorkspaceBridge()
      const id = runtimeRef.current.selectedConversation?.id
      // Run both independently: a failed workspace stop must not block chat.
      void Promise.resolve().then(() => bridge?.stopAll?.()).catch(reportError)
      if (id) void transportRef.current?.stopTurn(id).catch(reportError)
    },
  }), [openAgent, reportError])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault()
        if (event.shiftKey) openInfo()
        else openSettings()
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setShowPalette((open) => !open)
      } else if (event.key === 'Escape' && !isViewerOpen() && !document.querySelector('[data-esc-layer]')) {
        if (previewPath) closePreview()
        else if (showPalette) setShowPalette(false)
        else if (agentEditorOpen) setAgentEditorOpen(false)
        else if (routineEditorOpen) setRoutineEditorOpen(false)
        else if (showSettings) closeSettings()
        else if (showKanban) setShowKanban(false)
        else if (toolsTab) setToolsTab(null)
        else if (showInfo) setShowInfo(false)
        else if (showFiles) setShowFiles(false)
        else if (newChatPicker) setNewChatPicker(false)
        else if (!chatActive) setDestination('chat')
        else return
        event.preventDefault()
      }
    }
    const back = () => runtimeRef.current.goConversationBack()
    const forward = () => runtimeRef.current.goConversationForward()
    window.addEventListener('keydown', onKey)
    window.addEventListener('maia:go-back', back)
    window.addEventListener('maia:go-forward', forward)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('maia:go-back', back)
      window.removeEventListener('maia:go-forward', forward)
    }
  }, [openInfo, openSettings, closeSettings, previewPath, closePreview, showPalette, agentEditorOpen, routineEditorOpen, showSettings, showKanban, toolsTab, showInfo, showFiles, chatActive, newChatPicker])

  useEffect(() => {
    const apply = (initialHydration = false) => {
      const parsed = parseHash(window.location.hash)
      const route = resolveRoute(parsed, runtimeRef.current)
      if (previewPathRef.current !== route.previewPath && previewGuard.current &&
        !previewGuard.current.confirmLeave()) {
        writeHash(lastWrittenHash.current ?? serializeRoute(lastRoute.current), false)
        return
      }
      // Resolve the launch thread without undoing Settings actions made while it loaded.
      if (initialHydration && startupSettingsIntent.current) Object.assign(route, startupSettingsIntent.current)
      startupSettingsIntent.current = null
      if (initialHydration && startupDestinationIntent.current) {
        const next = startupDestinationIntent.current
        route.home = next === 'home'
        route.chats = next === 'chats'
        route.routines = next === 'routines'
      }
      startupDestinationIntent.current = null
      const hash = serializeRoute(route)
      lastWrittenHash.current = hash
      lastRoute.current = route
      writeHash(hash, false)
      if ((parsed.conversationId && !route.conversationId) || (parsed.agentId && !route.agentId)) {
        setShellError('This chat or agent is no longer available. Choose one from the sidebar.')
      }
      setShowInfo(route.info && !route.files)
      setShowFiles(route.files)
      setShowSettings(route.settings)
      setSettingsPane(route.settingsPane)
      setShowKanban(route.kanban)
      setToolsTab(route.toolsTab)
      setPreviewPath(route.previewPath)
      if (route.conversationId) selectConversation(route.conversationId)
      else if (route.agentId) openAgent(route.agentId)
      // Selection must not clear a routed main view.
      updateDestination(destinationFor(route))
    }
    const onHash = () => {
      if (window.location.hash === lastWrittenHash.current) return
      // Before the first hydration applies the route, a deep link would resolve
      // against an empty roster and fall back. Explicit navigation still
      // supersedes startup intents; that first apply then reads the live hash.
      if (!routeApplied.current) {
        startupSettingsIntent.current = null
        startupDestinationIntent.current = null
        return
      }
      apply()
    }
    if (!routeApplied.current && !hydrate.rosterHydrating && !hydrate.conversationsHydrating) {
      routeApplied.current = true
      apply(true)
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('popstate', onHash)
    }
  }, [hydrate.rosterHydrating, hydrate.conversationsHydrating, selectConversation, openAgent])
  useEffect(() => {
    if (!routeApplied.current) return
    const route: RouteState = {
      ...parseHash(''), conversationId: runtime.selectedConversation?.id ?? null,
      settings: showSettings, settingsPane,
      info: showInfo, files: showFiles, previewPath, kanban: showKanban, toolsTab, routines: showRoutines, home: showHome, chats: showChats,
    }
    const hash = serializeRoute(route)
    if (hash !== window.location.hash) {
      lastWrittenHash.current = hash
      const push = shouldPushRoute(lastRoute.current, route)
      lastRoute.current = route
      writeHash(hash, push)
    }
  }, [runtime.selectedConversation?.id, showSettings, settingsPane, showInfo, showFiles, previewPath, showKanban, toolsTab, showRoutines, showHome, showChats])

  const refreshRoutines = useCallback(async () => {
    const { jobs } = await loadRoutines()
    setRoutines(jobs)
  }, [])
  useEffect(() => { if (showRoutines || showInfo || routineEditorOpen) void refreshRoutines().catch(reportError) }, [showRoutines, showInfo, routineEditorOpen, refreshRoutines, reportError])
  const fireRoutine = useCallback(async (draft: RoutineDraft, job?: Routine | null): Promise<'started' | 'sent'> => {
    if (hydrate.readOnly) throw new Error('Hermes serve is offline.')
    if (job && await testRunRemote(job)) { await refreshRoutines(); return 'started' }
    const agentId = draft.agentId || job?.agentId || runtimeRef.current.selectedAgent?.id
    if (agentId) runtimeRef.current.openWithTarget({ type: 'agent', agentId })
    const state = getState()
    const conversation = state.conversations.find((c) => c.id === state.selectedConversationId)
    if (!conversation || !draft.prompt.trim()) throw new Error('Pick an agent and add an instruction first.')
    const { transport } = await getActiveTransport()
    await transport.sendMessage(conversation, draft.prompt.trim())
    if (job?.origin === 'local') setRoutines((previous) => previous.map((item) => sameRoutine(item, job) ? markLocalRun(item) : item))
    return 'sent'
  }, [hydrate.readOnly, refreshRoutines])
  useLocalRoutineScheduler(routines, async (job) => { await fireRoutine(routineDraftOf(job), job) })
  const openRoutineEditor = (job?: Routine | null) => { setEditingRoutine(job ?? null); setRoutineEditorOpen(true) }

  const commands: PaletteCommand[] = [
    { id: 'open-home', label: 'Home', run: openHome },
    { id: 'open-chats', label: 'All chats', run: openChats },
    { id: 'new-conversation', label: 'New chat', run: newConversation },
    { id: 'find-in-chat', label: 'Find in chat', keywords: ['search', 'transcript', 'messages'], detail: '⌘F', run: () => window.dispatchEvent(new CustomEvent('maia:find-in-chat')) },
    { id: 'new-agent', label: 'New agent', run: () => setAgentEditorOpen(true) },
    { id: 'new-shared-room', label: 'New shared room', run: openGroupEditor },
    { id: 'open-settings', label: 'Settings', detail: '⌘,', run: () => openSettings() },
    { id: 'improve-hermes-desk', label: 'Improve Hermes Desk', keywords: ['change', 'request', 'development'], detail: 'Local requests only', run: () => setShowImprovements(true) },
    { id: 'open-diagnostics', label: 'Diagnostics', run: () => openSettings('diagnostics') },
    { id: 'open-workspace', label: 'Workspace on your Mac', run: toggleWorkspace },
    { id: 'open-files', label: 'Files', run: () => { setShowInfo(false); setShowFiles(true) } },
    { id: 'open-info', label: 'Agent info', run: () => openInfo() },
    { id: 'open-routines', label: 'Routines', run: openRoutines },
    { id: 'open-kanban', label: 'Kanban', run: () => setShowKanban(true) },
    { id: 'open-hermes-tools', label: 'Skills and memory', run: () => setToolsTab('skills') },
    { id: 'toggle-hud', label: 'Show HUD cat', run: () => { void window.nubAgent?.hud?.toggle?.() } },
    { id: 'open-plugins', label: 'Desktop plugins', keywords: ['extensions', 'trust', 'review'], run: () => openSettings('plugins') },
    ...pluginRoutes.filter((route) => typeof route.data?.path === 'string' && typeof route.data.title === 'string').map((route) => ({
      id: `plugin-route:${route.id}`, label: `Open ${route.data.title}`, detail: 'Plugin page',
      run: () => window.dispatchEvent(new CustomEvent(PLUGIN_ROUTE_EVENT, { detail: { path: route.data.path } })),
    })),
    ...pluginThemes.filter((theme) => typeof theme.data?.id === 'string' && typeof theme.data.label === 'string').map((theme) => ({
      id: `plugin-theme:${theme.id}`, label: `Theme: ${theme.data.label}`, keywords: ['colors', 'appearance'],
      detail: activePluginThemeId() === theme.data.id ? 'Current' : 'Plugin theme', run: () => setPluginTheme(theme.data.id),
    })),
    ...(pluginThemes.length ? [{ id: 'plugin-theme-reset', label: 'Theme: Hermes Desk default', keywords: ['colors', 'appearance'], run: () => setPluginTheme(null) }] : []),
    ...pluginCommands.map((command) => ({ ...command, id: `plugin:${command.id}` })),
  ]
  const workspaceAgents = runtime.agents.map((agent) => ({
    id: agent.id, name: agent.name, color: agentColor(agent), profile: profileName(agent),
  }))
  const selected = runtime.selectedAgent
  const hasChatTarget = Boolean(selected || runtime.selectedGroup)
  const selectedPresence = hydrate.readOnly ? 'offline' : selected ? mascotStates[selected.id] ?? 'idle' : 'idle'
  const selectedActivity = selected ? activityByAgent[selected.id] : undefined
  const statusLine = selectedActivity?.waitingApproval ? 'Waiting for approval' :
    selectedActivity?.waitingClarify ? 'Waiting for your answer' : hydrate.localSessions[runtime.threadKey]?.status ||
    (selectedActivity ? activityLine(selectedActivity, Date.now()) : null)
  const pickedUp = useMemo(() => new Set(hydrate.localSessions[runtime.threadKey]?.pickedUpMessageIds ?? []), [hydrate.localSessions, runtime.threadKey])
  const dockVisible = showWorkspace && !showInfo && !showFiles && !previewPath && chatActive
  const workspaceBudget = panelBudget(geometry, workspaceWidth, WORKSPACE_MIN_WIDTH)
  const workspacePresentation = getWorkspaceBridge() ? workspaceBudget.presentation : 'main'
  const singleWorkArea = dockVisible && workspacePresentation === 'main'
  const workspaceStopping = stoppingConversationId !== null && stoppingConversationId === runtime.selectedConversation?.id
  const workspaceVisible = dockVisible && !showSettings && !showPalette && !showImprovements && !agentEditorOpen &&
    !groupEditorOpen && !routineEditorOpen && !newChatPicker && !showKanban && !toolsTab && !viewerOpen &&
    (!singleWorkArea || workArea === 'workspace')
  const askAgent = (tab: TabSummary) => {
    if (hydrate.readOnly || !runtimeRef.current.selectedAgent) return
    setDestination('chat')
    runtimeRef.current.handleSend(`[Workspace] Look at tab ${tab.title} (${tab.url})`)
  }
  const retry = async () => {
    const host = getHostBridge()
    try { if (host) await host.restartServe() }
    finally { await transportRef.current?.retryConnection() }
    await refreshRoster()
  }
  const send: typeof runtime.handleSend = async (...args) => {
    return hydrate.readOnly ? { status: 'rejected' } : runtime.handleSend(...args)
  }
  const prepareInChat = (profile: string, text: string) => {
    const current = runtimeRef.current
    if (!current.selectedAgent || current.selectedGroup || profileName(current.selectedAgent) !== profile || hydrate.readOnly) return
    setDestination('chat')
    setToolsTab(null)
    setShowInfo(false)
    const threadKey = current.threadKey
    window.requestAnimationFrame(() => {
      if (runtimeRef.current.threadKey === threadKey && !getHydrateStatus().readOnly)
        requestSkillDraft({ threadKey, text })
    })
  }
  const prepareSkill = (profile: string, name: string) => prepareInChat(profile, skillRequest(name))
  const prepareMemoryReview = (profile: string) => prepareInChat(profile, memoryReviewRequest())
  const branch = async (message?: ChatMessage) => {
    const id = runtimeRef.current.selectedConversation?.id
    if (!id || branchPending.current || hydrate.readOnly) return
    branchPending.current = true
    setBranchBusy(true)
    try {
      const conversation = await transportRef.current?.branchConversation(id, message)
      if (conversation && runtimeRef.current.selectedConversation?.id === id) selectConversation(conversation.id)
    } catch (error) { setShellError(error instanceof Error ? error.message : 'Could not branch this chat. Check Chats before trying again.') }
    finally { branchPending.current = false; setBranchBusy(false) }
  }
  const attachments = (window.nubAgent as unknown as { attachments?: {
    pickAndUpload?: (request: { profile: string; sessionId: string }) => Promise<{
      files: { name: string; path: string; kind: 'file' | 'image'; size?: number }[]; error?: string
    }>
  } } | undefined)?.attachments
  const pickAttachments = async () => {
    const conversation = runtimeRef.current.selectedConversation
    if (!conversation || !transportRef.current || !attachments?.pickAndUpload) return []
    const binding = await transportRef.current.attachmentSession(conversation)
    await getWorkspaceBridge()?.registerSession?.(binding)
    const result = await attachments.pickAndUpload({ profile: binding.profile, sessionId: binding.runtimeId })
    if (result.error) {
      if (!result.files.length) throw new Error('The attachment could not be uploaded.')
      setShellError('Some files could not upload. The uploaded files are still attached.')
    }
    return result.files
  }

  return (
    <PluginHost>
      <ShellLayoutContext.Provider value={geometry}>
      <div ref={shellRef} data-skin={skin} data-home-open={showHome || undefined} data-workspace-presentation={dockVisible ? workspacePresentation : 'closed'} className={`${skin === 'messenger' ? 'desk-theme' : ''} hermes-desk-shell flex h-dvh min-h-0 overflow-hidden bg-[var(--ca-bg)] text-[var(--ca-ink)]`}>
        {showHome && <HomePage agents={runtime.agents} groups={runtime.groups} conversations={runtime.conversations}
          messagesByThreadId={runtime.messagesByThreadId} liveConversationIds={runtime.liveConversationIds}
          activityByAgent={activityByAgent} pendingPermissions={pendingPermissions} mascotStates={mascotStates} prefs={prefs}
          hydrating={runtime.rosterHydrating || runtime.conversationsHydrating} offline={hydrate.readOnly}
          onRetry={retry} onDiagnostics={() => openSettings('diagnostics')}
          onOpenConversation={selectConversation} onOpenAgent={openAgent} onOpenApp={openChats}
          onStartSession={() => setNewChatPicker(true)}
          onCreateAgent={() => setAgentEditorOpen(true)} onOpenSearch={() => setShowPalette(true)}
          onOpenSettings={() => openSettings()} />}
        {/* The full shell stays mounted under Home (drafts, scroll, transport); display:contents keeps its layout. */}
        <div className="contents" style={showHome ? { display: 'none' } : undefined}>
        <Sidebar skin={skin} agents={runtime.agents} groups={runtime.groups} conversations={runtime.conversations}
          selectedConversationId={runtime.selectedConversation?.id ?? null} selectedAgentId={selected?.id}
          activityByAgent={activityByAgent} liveConversationIds={runtime.liveConversationIds}
          liveSubagentAgentIds={runtime.liveSubagentAgentIds} conversationsHydrating={runtime.rosterHydrating || runtime.conversationsHydrating}
          rosterHydrateError={runtime.rosterHydrateError} onRetryRoster={() => void refreshRoster()}
          connectionRecoveryShown={hydrate.readOnly} destination={destination} pluginPath={pluginPath}
          onSelectConversation={selectConversation} onOpenTarget={(target) => {
            setDestination('chat'); runtime.openWithTarget(target)
          }} onNewConversation={newConversation} onCreateGroup={openGroupEditor} onCreateAgent={() => setAgentEditorOpen(true)}
          onOpenAgentInfo={openInfo} onMarkRead={runtime.markConversationRead}
          onPrefetchConversation={runtime.prefetchConversation} onOpenSettings={() => openSettings()}
          onOpenSearch={() => setShowPalette(true)} onOpenHome={openHome} onOpenChats={openChats}
          onOpenRoutines={openRoutines} onManageAgents={() => openSettings('agents')} />
        <main className="flex min-w-0 flex-1 flex-col">
          <div hidden={!chatActive}><TopBar agent={selected} group={runtime.selectedGroup} active={chatActive} showInfo={showInfo}
            conversationTitle={runtime.selectedConversation?.title} conversations={runtime.conversations}
            onSelectConversation={selectConversation} onNewChat={newConversation}
            onToggleInfo={() => { setShowFiles(false); setShowInfo((open) => !open) }}
            showFiles={showFiles} onToggleFiles={() => { setShowInfo(false); setShowFiles((open) => !open) }}
            live={runtime.sending || !!selectedActivity?.live} statusLine={statusLine} skin={skin}
            mascotPresence={selectedPresence}
            hydrating={runtime.rosterHydrating} workspaceOpen={dockVisible} onToggleWorkspace={toggleWorkspace} /></div>
          <OfflineBanner offline={hydrate.readOnly} onRetry={retry} onDiagnostics={() => openSettings('diagnostics')} />
          {chatActive && !hasChatTarget && !hydrate.rosterHydrating && !hydrate.readOnly && <div className="messenger-setup shrink-0" role="region" aria-label="Local setup">
            <h2>Choose an agent to start</h2>
            <p>Agents are configured local Hermes profiles. Choose one in the sidebar or add an agent.</p>
            <Button onClick={newConversation}>Choose an agent</Button>
            <Button onClick={() => setAgentEditorOpen(true)}>New agent</Button>
          </div>}
          {chatActive && selected && showLocalGuide && !hydrate.readOnly && <div className="messenger-setup shrink-0">
            <p>Chats and browser data are stored on this Mac. Your configured model provider may receive prompts and tool results. Browser and computer control are optional.</p>
            <Button onClick={() => { finishLocalSetup(window.localStorage); setShowLocalGuide(false) }}>Got it</Button>
          </div>}
          {leaseConflicts[runtime.threadKey] && <div className="messenger-lease" role="alert">
            <span>Open in Hermes.app holds this chat.</span>
            <Button loading={branchBusy} disabled={hydrate.readOnly} onClick={() => void branch()}>Branch here</Button>
          </div>}
          {shellError && <div role="alert" className="px-4 py-2 text-xs">
            {shellError} <button type="button" onClick={() => setShellError(null)}>Dismiss</button>
          </div>}
          {branchBusy && <p role="status" className="px-4 py-2 text-xs">Creating a separate chat. The parent stays unchanged.</p>}
          {singleWorkArea && <div className="desk-work-area-switch" role="group" aria-label="Main work area">
            <Button aria-pressed={workArea === 'chat'} onClick={() => setWorkArea('chat')}>Chat</Button>
            <Button aria-pressed={workArea === 'workspace'} onClick={() => setWorkArea('workspace')}>Workspace</Button>
            <Button variant="ghost" onClick={toggleWorkspace} aria-label="Close workspace"><Icon name="x" size={16} />Close</Button>
            {workArea === 'workspace' && (runtime.sending || workspaceStopping) &&
              <Button size="sm" variant="danger" disabled={workspaceStopping} aria-label="Stop the agent" onClick={() => {
                const id = runtimeRef.current.selectedConversation?.id
                void stopSelectedTurn().then(stopped => {
                  if (!stopped && runtimeRef.current.selectedConversation?.id === id) setShellError('The stop could not be confirmed. Check the connection and try again.')
                }).catch(reportError)
              }}><Icon name="stop" size={16} />{workspaceStopping ? 'Stopping…' : 'Stop'}</Button>}
          </div>}
          <div className="desk-work-areas">
          <div className={`${chatActive && (!singleWorkArea || workArea === 'chat') && (hasChatTarget || hydrate.readOnly || runtime.rosterHydrating) ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col`}
            data-retained-chat>
            <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted">Loading chat…</div>}>
            <ChatPanel messages={runtime.messages} skin={skin} active={chatActive && (!singleWorkArea || workArea === 'chat')}
              disabled={!hasChatTarget || !!leaseConflicts[runtime.threadKey]} readOnly={hydrate.readOnly} statusLine={statusLine}
              profile={selected ? profileName(selected) : undefined} model={(selected as RosterAgent | null)?.model}
              provider={(selected as RosterAgent | null)?.provider}
              modelRoute={hydrate.localSessions[runtime.threadKey]?.modelRoute}
              onOpenModel={() => openSettings('agents')} pickedUpMessageIds={pickedUp}
              threadKey={runtime.threadKey} agents={runtime.agents} starterAgent={selected}
              sending={runtime.sending} activityState={runtime.activityPhase} mascot={resolveAgentMascot(selected)}
              transcriptLoading={runtime.transcriptLoading} transcriptSyncing={runtime.transcriptSyncing}
              transcriptError={runtime.transcriptError} onRetryTranscript={runtime.retryTranscript}
              historyHasMore={runtime.historyHasMore} historyLoadingOlder={runtime.historyLoadingOlder}
              onLoadOlder={runtime.loadOlderMessages} onSend={send} onReact={runtime.handleReact}
              onChoice={runtime.handleChoice} onStopTurn={stopSelectedTurn} onRetryTurn={runtime.retryTurn}
              onAcknowledgeUncertain={runtime.acknowledgeUncertainSend}
              onBranch={hydrate.readOnly || branchBusy || runtime.sending || runtime.selectedGroup ? undefined : message => void branch(message)}
              onOpenSkills={selected && !runtime.selectedGroup ? () => setToolsTab('skills') : undefined}
              modelActions={transportRef.current && !runtime.selectedGroup && runtime.selectedConversation ? {
                load: () => transportRef.current!.modelOptions(runtime.selectedConversation!.id),
                switch: (choice) => transportRef.current!.switchModel(runtime.selectedConversation!.id, choice),
              } : undefined}
              onInspectContext={transportRef.current && !runtime.selectedGroup && runtime.selectedConversation?.hermesSessionId ? () =>
                transportRef.current!.inspectSessionContext(runtime.selectedConversation!.id) : undefined}
              delegationActions={transportRef.current && !runtime.selectedGroup && runtime.selectedConversation?.hermesSessionId ? {
                list: () => transportRef.current!.inspectDelegates(runtime.selectedConversation!.id),
                tail: (id, generation) => transportRef.current!.inspectDelegateTail(runtime.selectedConversation!.id, id, generation),
                steer: (id, text, generation) => transportRef.current!.steerDelegate(runtime.selectedConversation!.id, id, text, generation),
                interrupt: (id, generation) => transportRef.current!.interruptDelegate(runtime.selectedConversation!.id, id, generation),
              } : undefined}
              onPickAttachments={attachments?.pickAndUpload && !hydrate.readOnly ? pickAttachments : undefined}
              todos={hydrate.localSessions[runtime.threadKey]?.todos} usage={hydrate.localSessions[runtime.threadKey]?.usage}
              localRoom={runtime.selectedConversation?.localRoom}
              onSetRoomBudget={hydrate.readOnly ? undefined : async limit => {
                const id = runtime.selectedConversation?.id
                return id ? await transportRef.current?.setRoomTokenBudget(id, limit) ?? false : false
              }}
              mascotPresence={selectedPresence}
              permissionAsk={runtime.permissionAsk} onPermission={hydrate.readOnly ? undefined : runtime.handlePermission}
              onOpenSettings={() => openSettings()} onOpenKanban={() => setShowKanban(true)}
              onNewAgent={() => setAgentEditorOpen(true)} onNewConversation={newConversation}
              onOpenFile={openFile} cwd={runtime.selectedConversation?.cwd}
              liveSubagents={runtime.liveSubagents} conversationSubagents={runtime.conversationSubagents}
              onSpawnSubagent={runtime.spawnIntoConversation} onCancelSubagent={runtime.cancelSubagent}
              onMessageSubagent={runtime.messageSubagent} onOpenAgent={openAgent}
              agentName={(id) => roomMemberName(id, runtime.agents)}
              showAgentSpeaker={Boolean(runtime.selectedGroup)} roomStatus={runtime.roomStatus}
              roomHandoffs={runtime.roomHandoffs} roomThreadStrips={runtime.roomThreadStrips}
              mentionMembers={runtime.mentionMembers}
              toolWhere="mac" focusMessageId={focusMessageId} onFocusMessageHandled={() => setFocusMessageId(null)} />
            </Suspense>
          </div>
          {showChats && <ChatsPage agents={runtime.agents} groups={runtime.groups} conversations={runtime.conversations} prefs={prefs}
            messagesByThreadId={runtime.messagesByThreadId}
            liveConversationIds={runtime.liveConversationIds} activityByAgent={activityByAgent} pendingPermissions={pendingPermissions}
            hydrating={runtime.rosterHydrating || runtime.conversationsHydrating}
            onOpenConversation={selectConversation} onNewChat={newConversation} onCreateGroup={openGroupEditor} />}
          {showPluginPage && pluginPath && <PluginPage path={pluginPath} onClose={() => setDestination('chat')} />}
          {showRoutines && <Suspense fallback={null}><RoutinesPage routines={routines}
            onClose={() => setDestination('chat')} onCreate={() => openRoutineEditor()}
            onOpen={(job) => openRoutineEditor(job)} onRefresh={refreshRoutines}
            onRunNow={async (job) => { if (await fireRoutine(routineDraftOf(job), job) === 'sent') setDestination('chat') }}
            onToggle={async (job, enabled) => {
              await setRoutineEnabled(job, enabled); await refreshRoutines()
            }} /></Suspense>}
          <SidePanel id="workspace" title="Workspace on your Mac" chrome={false} scroll={false}
            hidden={!dockVisible || (singleWorkArea && workArea !== 'workspace')} defaultWidth={480} onClose={toggleWorkspace}
            minWidth={WORKSPACE_MIN_WIDTH} presentation={workspacePresentation} maxWidth={workspaceBudget.maximum}
            onWidthChange={setWorkspaceWidth}>
            <WorkspacePane agents={workspaceAgents} selectedAgentId={selected?.id} visible={workspaceVisible}
              onAskAgent={hydrate.readOnly || !selected ? undefined : askAgent} onOpenSettings={() => openSettings('workspace')} />
            <WorkspaceComputerPreview profile={selected ? profileName(selected) : undefined} agentName={selected?.name}
              placement={hostConfig?.computer.placement} visible={workspaceVisible} />
          </SidePanel>
          </div>
        </main>
        </div>
        <Suspense fallback={null}>
          <NewChatDialog open={newChatPicker} agents={roster} onClose={() => setNewChatPicker(false)}
            onChoose={newChatForAgent} onCreateAgent={() => setAgentEditorOpen(true)} />
          {everInfo && <Suspense fallback={null}><AgentInfo agent={selected} group={runtime.selectedGroup} allAgents={runtime.agents}
            open={showInfo} onClose={() => setShowInfo(false)} onUpdateProfile={runtime.updateAgentProfile}
            onUpdateGroup={runtime.updateGroup} onSetGroupMembers={runtime.setGroupMembers}
            liveSubagents={runtime.liveSubagents} recentSubagents={runtime.recentSubagents}
            onCancelSubagent={runtime.cancelSubagent} routines={routines}
            onUseSkill={hydrate.readOnly ? undefined : prepareSkill}
            onCreateRoutine={() => openRoutineEditor()} onManageRoutines={openRoutines} /></Suspense>}
          {everFiles && <Suspense fallback={null}><FilesPanel open={showFiles} cwd={runtime.selectedConversation?.cwd ?? '/'}
            onClose={() => setShowFiles(false)} onOpenFile={openFile} recentFiles={fileRefsFromMessages(runtime.messages).map((file) => ({
              path: file.path, label: file.path.split('/').pop() || file.path,
            }))} /></Suspense>}
          {everPreview && <Suspense fallback={null}><FilePreview open={previewPath !== null} filePath={previewPath}
            guardRef={previewGuard} onClose={closePreview} /></Suspense>}
          {everSettings && <Suspense fallback={null}><SettingsStub open={showSettings} onClose={closeSettings}
            initialPane={(settingsPane ?? undefined) as SettingsPaneRequest | undefined} apiBase="" mockMode={false}
            onPaneChange={chooseSettingsPane} /></Suspense>}
          {everImprovements && <Suspense fallback={null}><ImproveHermesDesk open={showImprovements}
            onClose={() => setShowImprovements(false)} /></Suspense>}
          {everPalette && <Suspense fallback={null}><CommandPalette open={showPalette} onClose={() => setShowPalette(false)} commands={commands}
            agents={runtime.agents} groups={runtime.groups} conversations={runtime.conversations}
            messagesByThreadId={runtime.messagesByThreadId} onJumpToAgent={openAgent}
            onNewConversation={newConversation}
            onOpenFiles={openFiles}
            onJumpToMessage={(conversationId, messageId) => { selectConversation(conversationId); setFocusMessageId(messageId) }} /></Suspense>}
          {everEditor && <Suspense fallback={null}><AgentEditor open={agentEditorOpen} onClose={() => setAgentEditorOpen(false)}
            onCreate={async (profile: NewAgentProfile) => { await runtime.createAgent(profile) }} /></Suspense>}
          {everGroupEditor && <Suspense fallback={null}><GroupEditor open={groupEditorOpen} agents={runtime.agents}
            chiefRouting={transportReady} onClose={closeGroupEditor}
            onCreate={async (input) => {
              const epoch = groupEditorEpoch.current
              const conversation = await runtimeRef.current.createGroup(input, { select: false })
              if (epoch !== groupEditorEpoch.current) return
              closeGroupEditor()
              selectConversation(conversation.id)
            }} /></Suspense>}
          {everKanban && <Suspense fallback={null}><KanbanPanel open={showKanban} onClose={() => setShowKanban(false)} /></Suspense>}
          {everTools && <Suspense fallback={null}><HermesSurfacesPanel open={toolsTab !== null} onClose={() => setToolsTab(null)}
            initialTab={toolsTab ?? 'skills'} profile={selected && !runtime.selectedGroup ? profileName(selected) : undefined}
            onUseSkill={hydrate.readOnly ? undefined : prepareSkill}
            onPrepareMemoryReview={hydrate.readOnly ? undefined : prepareMemoryReview} /></Suspense>}
          {everRoutineEditor && <Suspense fallback={null}><RoutineEditor open={routineEditorOpen} initial={editingRoutine} agents={runtime.agents}
            defaultAgentId={runtime.selectedAgent?.id}
            onClose={() => setRoutineEditorOpen(false)} onSave={async (draft, existing) => {
              const saved = await upsertRoutine(draft, existing); await refreshRoutines(); return saved
            }} onDelete={async (job) => { await removeRoutine(job); await refreshRoutines() }}
            onTestRun={async (draft) => { await fireRoutine(draft, editingRoutine) }} /></Suspense>}
        </Suspense>
      </div>
      </ShellLayoutContext.Provider>
    </PluginHost>
  )
}
