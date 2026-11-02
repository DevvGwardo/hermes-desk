/**
 * React bridge to the module-level agents store + mock transport.
 * Conversations are the thread owner (Grok parity): selectedConversationId
 * picks the conversation; its target resolves to an agent or group.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  resolvePresence,
  collectLiveConversationIds,
  type ActivityPhase,
} from './activity'
import { getActiveTransport } from './active-transport'
import { addAgentFast } from './add-agent'
import {
  SELECTION_REFRESH_DEBOUNCE_MS,
  cachedTranscriptBehind,
  selectionRefreshPlan,
} from './transcript-freshness'
import { canPrefetchOnThisConnection } from './prefetch'
import { useBehindWarmup, useBootWarmup } from './useBootWarmup'
import { failedSend, type SendOutcome } from './send-outcome'
import {
  getState,
  getStructuralState,
  getHydrateStatus,
  setHydrateStatus,
  setState,
  createConversation as storeCreateConversation,
  hideConversation,
  unhideConversation,
  listHiddenConversations,
  togglePinConversation,
  markConversationRead,
  markConversationUnread,
  duplicateConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listSubagentsForConversation,
  listSubagentsForParent,
  selectConversation,
  subscribe,
  updateAgent as updateAgentStore,
} from './store'
import { settleStaleInFlight } from './persist'
import { isOrchestrator } from '../peer-roster'
import {
  getRoomViews,
  roomHandoffStrips,
  roomMemberName,
  roomStatusOf,
  stableHandoffStrips,
  subscribeRoomViews,
  type HandoffStrip,
  type RoomStatus,
} from './rooms'
import {
  enqueueOutbox,
  getOutboxSnapshot,
  markOutboxFailure,
  removeOutbox,
  subscribeOutbox,
  type OutboxItem,
} from '../outbox'
import {
  appendMessage,
  getMessagesForConversation,
  patchMessage,
  removeMessage as removeMessageFromThread,
} from './store'
import type { QueuedMessageItem } from './transport'
import type { Agent, ChatMessage, Conversation, Group, NewAgentProfile, SubagentKind, SubagentRun, ThreadRef, ToolPermissionChoice, Turn } from './types'
import { placeTypedAnswers } from './answer-placement'
import { withAttachmentNote } from '../attachment-note'
import type { PresenceState } from '../blob-fx'
import {
  getPendingToolPermission,
  subscribePendingToolPermission,
} from './tool-permission'
import { continueAfterSubagent, startDelegateContinuations } from '../subagent-continue'
import { syncDesktopAgentToHermes, syncRosterToHermes } from '../hermes-agents'
import { maybeApplyAvatarIntent } from '../avatar-intent'
import { track } from '../analytics'
import { logger } from '../logger'
import { markTurnStopped } from '../ui-sounds'

export type { ActivityPhase }

export const CONVERSATION_HISTORY_CAP = 20

export function pushConversationHistory(
  stack: string[],
  index: number,
  id: string,
  cap = CONVERSATION_HISTORY_CAP,
): { stack: string[]; index: number } {
  const trimmed = index >= 0 ? stack.slice(0, index + 1) : []
  if (trimmed[trimmed.length - 1] === id) {
    return { stack: trimmed, index: trimmed.length - 1 }
  }
  trimmed.push(id)
  while (trimmed.length > cap) trimmed.shift()
  return { stack: trimmed, index: trimmed.length - 1 }
}

export function historyStep(stack: string[], index: number, delta: -1 | 1): { id: string; index: number } | null {
  const next = index + delta
  const id = stack[next]
  if (!id) return null
  return { id, index: next }
}

export function cycleConversationId(
  ids: string[],
  currentId: string | null,
  delta: -1 | 1,
): string | null {
  if (ids.length === 0) return null
  const i = currentId ? ids.indexOf(currentId) : -1
  const next = (i + delta + ids.length) % ids.length
  return ids[next] ?? null
}

/** One-shot: a reload/HMR leaves streaming flags in the module store with no
 *  live send behind them, which leaves the chat stuck on "Working…". */
let didSettleBootInFlight = false

/** Survives React remounts (not a full module reload) so a live send is not
 *  settled away and `sending` can be restored. */
const inFlightCounts = new Map<string, number>()

function inFlightIdSet(): ReadonlySet<string> {
  return new Set(inFlightCounts.keys())
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms))
}

/** True when the device reports no network. Optimistic on platforms that
 *  don't expose it — a false negative just means the send fails normally. */
/** Local id for optimistic rows the outbox owns (mirrors the store's ids). */
function uid(prefix = 'obx'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function isOffline(): boolean {
  // Browser internet connectivity says nothing about local Hermes serve.
  // Transport failures, not navigator.onLine, determine local availability.
  return false
}

export function useAgentRuntime() {
  // The structural snapshot: a streaming tick that only grows a reply's text
  // does not re-render the shell (rows follow it via useLiveMessage).
  const state = useSyncExternalStore(subscribe, getStructuralState, getStructuralState)
  const hydrate = useSyncExternalStore(subscribe, getHydrateStatus, getHydrateStatus)
  const roomViews = useSyncExternalStore(subscribeRoomViews, getRoomViews, getRoomViews)
  const [localPhase, setLocalPhase] = useState<ActivityPhase>(null)
  const sendGen = useRef(0)
  useEffect(() => () => { sendGen.current += 1 }, [])
  const [inFlightIds, setInFlightIds] = useState<ReadonlySet<string>>(inFlightIdSet)
  const [queuedCounts, setQueuedCounts] = useState<ReadonlyMap<string, number>>(new Map())
  const [queuedItems, setQueuedItems] = useState<ReadonlyMap<string, QueuedMessageItem[]>>(
    new Map(),
  )
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const skipHistoryRef = useRef(false)

  // Mascot queue state: a send parked behind a live stream shows up as a
  // "N queued" badge on the activity line instead of vanishing (the old
  // busy-gate silently swallowed it). The deploy transport emits
  // { type: 'queued' } on enqueue/drain; mock/serve transports never emit
  // it, so the count stays 0 there.
  useEffect(() => {
    let cancelled = false
    let unsub: (() => void) | undefined
    void (async () => {
      const [{ getActiveTransport }] = [await import('./active-transport')]
      if (cancelled) return
      const { transport } = await getActiveTransport()
      if (cancelled) return
      unsub = transport.subscribe((ev) => {
        if (cancelled || ev.type !== 'queued') return
        setQueuedCounts((prev) => {
          const next = new Map(prev)
          if (ev.count <= 0) next.delete(ev.conversationId)
          else next.set(ev.conversationId, ev.count)
          return next
        })
        setQueuedItems((prev) => {
          const next = new Map(prev)
          if (ev.count <= 0) next.delete(ev.conversationId)
          else next.set(ev.conversationId, ev.items)
          return next
        })
      })
    })().catch(() => {
      if (!cancelled) logger.warn('[hermes] queue subscription setup failed')
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  const beginFlight = useCallback((conversationId: string) => {
    const n = (inFlightCounts.get(conversationId) ?? 0) + 1
    inFlightCounts.set(conversationId, n)
    setInFlightIds(inFlightIdSet())
  }, [])

  const endFlight = useCallback((conversationId: string) => {
    const n = (inFlightCounts.get(conversationId) ?? 0) - 1
    if (n <= 0) inFlightCounts.delete(conversationId)
    else inFlightCounts.set(conversationId, n)
    setInFlightIds(inFlightIdSet())
  }, [])

  const cancelLocalPhase = useCallback(() => {
    sendGen.current += 1
    setLocalPhase(null)
  }, [])

  // Tap the local transport's event stream into the append-only audit log.
  useEffect(() => {
    let cancelled = false
    let unsub: (() => void) | undefined
    void (async () => {
      const [{ getActiveTransport }, { auditRowsFromTransportEvent, appendAuditRows }] =
        await Promise.all([
          import('./active-transport'),
          import('./audit-log'),
        ])
      if (cancelled) return
      const { transport } = await getActiveTransport()
      if (cancelled) return
      // Subagent events fire on every child token; the log only needs a row
      // when a run's outcome changes, not a synchronous storage rewrite each time.
      const lastByKey = new Map<string, string>()
      unsub = transport.subscribe((ev) => {
        if (cancelled) return
        const rows = auditRowsFromTransportEvent(
          ev as Parameters<typeof auditRowsFromTransportEvent>[0],
          'mac',
        ).filter((row) => {
          if (!row.key) return true
          const signature = `${row.outcome}\u0001${row.target}`
          if (lastByKey.get(row.key) === signature) return false
          lastByKey.delete(row.key)
          lastByKey.set(row.key, signature)
          if (lastByKey.size > 500) lastByKey.delete(lastByKey.keys().next().value!)
          return true
        })
        if (rows.length > 0) appendAuditRows(rows)
      })
    })().catch(() => {
      if (!cancelled) logger.warn('[hermes] audit subscription setup failed')
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  const agents = state.agents
  const groups = state.groups
  // Synthesized placeholder threads (roster with zero server threads yet) are
  // hidden while hydration is in flight — during that window the sidebar shows
  // skeletons and the main pane shows the boot surface, never fake content.
  // Once hydration settles the placeholder is the legitimate forever-chat.
  const conversations: Conversation[] = useMemo(
    () =>
      listConversations().filter(
        (c) => !c.hiddenFromSidebar && !(c.placeholder && (hydrate.rosterHydrating || hydrate.conversationsHydrating)),
      ),
    [state.conversations, hydrate.rosterHydrating, hydrate.conversationsHydrating],
  )

  const hiddenConversations: Conversation[] = useMemo(
    () => listHiddenConversations(),
    [state.conversations],
  )

  // A synthesized placeholder selected while hydration is in flight is not a
  // real thread — treat it as no selection so the boot surfaces (sidebar
  // skeletons, BootPanel) show instead of a fake "Nub" chat. Once hydration
  // settles, the placeholder becomes the legitimate forever-chat.
  const selectedConversationRaw: Conversation | null = useMemo(
    () => getConversation(state.selectedConversationId ?? '') ?? null,
    [state.selectedConversationId, state.conversations],
  )
  const selectedConversation: Conversation | null = useMemo(
    () =>
      selectedConversationRaw?.placeholder &&
      (hydrate.rosterHydrating || hydrate.conversationsHydrating)
        ? null
        : selectedConversationRaw,
    [selectedConversationRaw, hydrate.rosterHydrating, hydrate.conversationsHydrating],
  )

  const selectedTarget: ThreadRef | null = selectedConversation?.target ?? null

  const selectedAgent: Agent | null = useMemo(() => {
    if (!selectedTarget || selectedTarget.type !== 'agent') return null
    return agents.find((a) => a.id === selectedTarget.agentId) ?? null
  }, [selectedTarget, agents])

  const selectedGroup: Group | null = useMemo(() => {
    if (!selectedTarget || selectedTarget.type !== 'group') return null
    return groups.find((g) => g.id === selectedTarget.groupId) ?? null
  }, [selectedTarget, groups])

  const computerAgentId = useMemo(() => {
    if (!selectedTarget) return null
    if (selectedTarget.type === 'agent') return selectedTarget.agentId
    const g = groups.find((x) => x.id === selectedTarget.groupId)
    return g?.primaryAgentId ?? null
  }, [selectedTarget, groups])

  const computerAgent = useMemo(
    () => agents.find((a) => a.id === computerAgentId) ?? null,
    [agents, computerAgentId],
  )

  const messages: ChatMessage[] = useMemo(() => {
    if (!selectedConversation) return []
    // Display order: a typed answer sits where in the reply it was given.
    return placeTypedAnswers(state.messagesByThreadId[selectedConversation.id] ?? [])
  }, [selectedConversation, state.messagesByThreadId])

  const parentForSubagents = computerAgentId
  const liveSubagents: SubagentRun[] = useMemo(() => {
    if (!parentForSubagents) return []
    return listSubagentsForParent(parentForSubagents, { liveOnly: true })
  }, [parentForSubagents, state.subagentsById])

  /** Grok Bot parity: subagents pulled into the SELECTED conversation. */
  const conversationSubagents: SubagentRun[] = useMemo(() => {
    if (!selectedConversation) return []
    return listSubagentsForConversation(selectedConversation.id)
  }, [selectedConversation, state.subagentsById])

  const recentSubagents: SubagentRun[] = useMemo(() => {
    if (!parentForSubagents) return []
    return listSubagentsForParent(parentForSubagents, { liveOnly: false }).slice(0, 8)
  }, [parentForSubagents, state.subagentsById])

  /**
   * Truth for the sidebar status row: all parent agent ids with LIVE
   * (queued/running) subagent runs. An agent is only genuinely "running"
   * when it has an actual worker in flight — not merely because the hermes
   * process exists (that's the hardcoded `status: 'running'` on hydrated
   * agents, which is a lie for idle rows).
   */
  const liveSubagentAgentIds: Set<string> = useMemo(() => {
    const ids = new Set<string>()
    for (const run of Object.values(state.subagentsById)) {
      if (run.status === 'queued' || run.status === 'running') ids.add(run.parentAgentId)
    }
    return ids
  }, [state.subagentsById])

  /**
   * Grok Bot parity: `isRunning` is per conversation, not per selection.
   * Streaming replies and in-flight sends keep the sidebar orb alive after
   * the user clicks another agent.
   */
  // Recomputed on every message change (each streamed token), but the SET
  // only changes when a conversation starts or stops being live. Keep the
  // previous identity when the members match, so the memo'd Sidebar (and
  // every row) does not re-render per token.
  const liveConversationIdsRef = useRef<Set<string>>(new Set())
  const liveConversationIds: Set<string> = useMemo(() => {
    const ids = collectLiveConversationIds(inFlightIds, state.messagesByThreadId)
    // Server-reported live turns: a reply streaming on another device (or a
    // queued turn) lights its row even though this device holds no stream.
    for (const id of Object.keys(hydrate.liveTurns)) ids.add(id)
    // Server-run rooms with a member turn in flight.
    for (const [id, view] of roomViews) if (view.enabled && view.turns.some((turn) => !turn.paused)) ids.add(id)
    const prev = liveConversationIdsRef.current
    if (prev.size === ids.size && [...ids].every((id) => prev.has(id))) return prev
    liveConversationIdsRef.current = ids
    return ids
  }, [inFlightIds, state.messagesByThreadId, hydrate.liveTurns, roomViews])

  const sending = Boolean(
    selectedConversation && inFlightIds.has(selectedConversation.id),
  )

  /** Server-run room status for the open group (presence / pass line / live).
   *  Null when the open thread is not a server-run room. */
  const roomStatus: RoomStatus | null = useMemo(() => {
    if (!selectedConversation || selectedConversation.target.type !== 'group') return null
    return roomStatusOf(roomViews.get(selectedConversation.id), (id) => roomMemberName(id, agents))
  }, [selectedConversation, roomViews, agents])

  /** Hand-off strips for the open room, keyed by transcript row id. Strips
   *  that didn't change keep their identity across polls (memoized rows). */
  const [stripCache] = useState(() => ({ prev: null as ReadonlyMap<string, HandoffStrip> | null }))
  const roomHandoffs: ReadonlyMap<string, HandoffStrip> | null = useMemo(() => {
    if (!selectedConversation || selectedConversation.target.type !== 'group') return null
    const view = roomViews.get(selectedConversation.id)
    if (!view?.enabled || view.handoffs.length === 0) return null
    const next = stableHandoffStrips(
      stripCache.prev,
      roomHandoffStrips(view, (id) => roomMemberName(id, agents)),
    )
    stripCache.prev = next
    return next
  }, [selectedConversation, roomViews, agents, stripCache])

  /** Every turn strip in the open room, including the ones a human message
   *  started — the hand-off modal threads follow-up replies through these
   *  (the inline strips above deliberately skip human-started turns). */
  const roomThreadStrips: ReadonlyMap<string, HandoffStrip> | null = useMemo(() => {
    if (!selectedConversation || selectedConversation.target.type !== 'group') return null
    const view = roomViews.get(selectedConversation.id)
    if (!view?.enabled || view.handoffs.length === 0) return null
    return roomHandoffStrips(view, (id) => roomMemberName(id, agents), { includeRoots: true })
  }, [selectedConversation, roomViews, agents])

  /** @mention candidates for the open group (members, by display name). */
  // Recomputed on room-view changes too: the feed teaches names for members
  // this device's roster doesn't have. Same list → same array (no re-render).
  const [mentionCache] = useState(() => ({ prev: [] as Array<{ id: string; name: string }> }))
  const mentionMembers = useMemo(() => {
    if (!selectedGroup) return []
    const ids = [...selectedGroup.memberAgentIds]
    // The account Chief leads rooms it isn't a member of; the server says
    // who (the feed's chiefId), so it can be @mentioned there too.
    const chiefId = selectedConversation ? roomViews.get(selectedConversation.id)?.chiefId : null
    if (chiefId && !ids.includes(chiefId)) ids.push(chiefId)
    const next = ids.map((id) => ({
      id,
      name: roomMemberName(id, agents),
    }))
    if (JSON.stringify(next) === JSON.stringify(mentionCache.prev)) return mentionCache.prev
    mentionCache.prev = next
    return next
  }, [selectedGroup, selectedConversation, agents, roomViews, mentionCache])

  // Poll the open group's room feed while it is open (the transport pauses
  // it while the document is hidden). No-op on transports without rooms.
  const openGroupConversationId =
    selectedConversation?.target.type === 'group' ? selectedConversation.id : null
  useEffect(() => {
    if (!openGroupConversationId) return
    let release: (() => void) | undefined
    let cancelled = false
    void (async () => {
      const { transport } = await getActiveTransport()
      if (cancelled) return
      release = transport.watchRoom?.(openGroupConversationId)
    })().catch(() => {
      if (!cancelled) logger.warn('[hermes] room watch setup failed')
    })
    return () => {
      cancelled = true
      release?.()
    }
  }, [openGroupConversationId])

  const latestTurn: Turn | undefined = useMemo(() => {
    if (!selectedConversation) return undefined
    const tid = selectedConversation.id
    return Object.values(state.turnsById)
      .filter((t) => t.threadId === tid)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0]
  }, [selectedConversation, state.turnsById])

  const permissionAskRaw = useSyncExternalStore(
    subscribePendingToolPermission,
    () => getPendingToolPermission(selectedConversation?.id ?? ''),
    () => getPendingToolPermission(selectedConversation?.id ?? ''),
  )
  const permissionAsk =
    permissionAskRaw && permissionAskRaw.conversationId === selectedConversation?.id
      ? permissionAskRaw
      : null

  const statusAgent = selectedAgent ?? computerAgent

  const activityPhase: ActivityPhase = useMemo(() => {
    if (localPhase) return localPhase
    if (sending || liveSubagents.length > 0) {
      if (latestTurn?.phase === 'acked') return 'listening'
      return 'working'
    }
    if (!statusAgent) return null
    if (statusAgent.status === 'error') return 'surprised'
    if (statusAgent.status === 'provisioning') return 'thinking'
    if (statusAgent.status === 'running') return 'idle'
    return 'sleeping'
  }, [localPhase, sending, liveSubagents.length, latestTurn, statusAgent])

  const presence: PresenceState | null = useMemo(
    () =>
      resolvePresence({
        sending,
        activityPhase,
        subagents: liveSubagents,
        turnPhase: latestTurn?.phase,
        agentStatus: statusAgent?.status,
        agentBusy: sending || liveSubagents.length > 0,
      }),
    [sending, activityPhase, liveSubagents, latestTurn?.phase, statusAgent?.status],
  )

  // Bumped to re-run the transcript load for the thread that is already selected.
  const [transcriptRetry, setTranscriptRetry] = useState(0)
  const retryTranscript = useCallback(() => setTranscriptRetry((n) => n + 1), [])
  const handleSelect = useCallback(
    (conversationId: string) => {
      // Re-choosing the selected thread does not change the selection, so an empty
      // transcript (e.g. a boot fetch that ran before serve was up) would never reload.
      const current = getState()
      if (conversationId === current.selectedConversationId &&
        getHydrateStatus().transcriptLoadingId !== conversationId &&
        !(current.messagesByThreadId[conversationId] ?? []).some((m) => m.role === 'user' || m.role === 'agent')) {
        setTranscriptRetry((n) => n + 1)
      }
      if (!skipHistoryRef.current) {
        const next = pushConversationHistory(
          historyRef.current,
          historyIndexRef.current,
          conversationId,
        )
        historyRef.current = next.stack
        historyIndexRef.current = next.index
      }
      skipHistoryRef.current = false
      selectConversation(conversationId)
      cancelLocalPhase()
    },
    [cancelLocalPhase],
  )

  const goConversationBack = useCallback(() => {
    const step = historyStep(historyRef.current, historyIndexRef.current, -1)
    if (!step) return
    historyIndexRef.current = step.index
    skipHistoryRef.current = true
    selectConversation(step.id)
    cancelLocalPhase()
  }, [cancelLocalPhase])

  const goConversationForward = useCallback(() => {
    const step = historyStep(historyRef.current, historyIndexRef.current, 1)
    if (!step) return
    historyIndexRef.current = step.index
    skipHistoryRef.current = true
    selectConversation(step.id)
    cancelLocalPhase()
  }, [cancelLocalPhase])

  const cycleConversation = useCallback(
    (delta: -1 | 1) => {
      const next = cycleConversationId(
        conversations.map((c) => c.id),
        selectedConversation?.id ?? null,
        delta,
      )
      if (next) handleSelect(next)
    },
    [conversations, selectedConversation, handleSelect],
  )

  // Grok parity: opening a hermes-backed conversation loads its REAL
  // transcript. An empty thread loads at once (transcript + live-turn state)
  // behind a skeleton. A cached (persisted) thread renders at once but can be
  // stale (turns from another device), so it refreshes too — transcript page
  // only (the poll owns /state), skipped when it hydrated within
  // TRANSCRIPT_FRESH_MS, and debounced so clicking through the sidebar does
  // not fire a fetch per row passed (PR #60 refresh storm). A cached thread
  // the sync feed says is BEHIND (the server has a newer turn) fetches at
  // once instead, and the chat marks where the new messages will land
  // (transcriptSync) rather than letting them pop in unannounced.
  // Single-flight: both paths go through the active transport, sharing its
  // deduped transcript fetch with panels and the refresh loop.
  const selectedSessionId = state.conversations.find((c) => c.id === state.selectedConversationId)?.hermesSessionId
  const serveOnline = hydrate.serveConnection === 'online'
  useEffect(() => {
    const conv = getState().conversations.find((c) => c.id === state.selectedConversationId)
    if (!conv?.hermesSessionId) return
    const msgs = getState().messagesByThreadId[conv.id] ?? []
    const hasReal = msgs.some((m) => m.role === 'user' || m.role === 'agent')
    const behind =
      hasReal &&
      cachedTranscriptBehind(conv, msgs, { live: Boolean(getHydrateStatus().liveTurns[conv.id]) })
    const plan = selectionRefreshPlan(conv.id, hasReal, Date.now(), behind)
    if (plan === 'skip') return
    let cancelled = false
    // Until this first fetch lands an empty thread is unknown, not empty: the
    // chat shows a skeleton instead of "No messages yet".
    if (plan === 'full') setHydrateStatus({ transcriptLoadingId: conv.id })
    // A new attempt supersedes the previous failure's retry offer.
    if (getHydrateStatus().transcriptErrorId === conv.id) setHydrateStatus({ transcriptErrorId: null })
    const sync = plan === 'full' ? null : { id: conv.id, behind: plan === 'behind' }
    if (sync?.behind) setHydrateStatus({ transcriptSync: sync })
    const run = async () => {
      if (sync && !sync.behind) setHydrateStatus({ transcriptSync: sync })
      try {
        const { transport } = await getActiveTransport()
        if (cancelled) return
        const loaded =
          plan !== 'full' && transport.refreshTranscript
            ? await transport.refreshTranscript(conv.id)
            : await transport.getMessages(conv.id)
        if (!cancelled && loaded.length > 0) logger.log(`[hermes] loaded ${loaded.length} message(s) for ${conv.title}`)
      } catch (err) {
        logger.error('[hermes] transcript load failed', err)
        // The thread stays unknown, not empty: with no cached rows the chat
        // offers a retry instead of the false "Send a message" empty state.
        if (!cancelled) setHydrateStatus({ transcriptErrorId: conv.id })
      } finally {
        if (plan === 'full' && getHydrateStatus().transcriptLoadingId === conv.id) {
          setHydrateStatus({ transcriptLoadingId: null })
        }
        if (sync && getHydrateStatus().transcriptSync === sync) setHydrateStatus({ transcriptSync: null })
      }
    }
    const timer =
      plan === 'transcript' ? setTimeout(() => void run(), SELECTION_REFRESH_DEBOUNCE_MS) : null
    if (!timer) void run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      // Leaving the thread mid-fetch: the indicator belongs to this thread.
      if (sync && getHydrateStatus().transcriptSync === sync) setHydrateStatus({ transcriptSync: null })
    }
    // Also re-run once the thread gains its Hermes session or serve comes online: the
    // restored selection loads at boot, often before either is ready, and that failed
    // fetch is otherwise never retried. A loaded thread just takes the cheap fresh path.
  }, [state.selectedConversationId, selectedSessionId, serveOnline, transcriptRetry])

  /** Warm one conversation's transcript without opening it (sidebar hover
   *  intent). Fire-and-forget; the transport decides eligibility. */
  const prefetchConversation = useCallback((conversationId: string) => {
    if (!canPrefetchOnThisConnection()) return
    void getActiveTransport()
      .then(({ transport }) => transport.prefetchTranscript?.(conversationId))
      .catch((err) => logger.warn('[hermes] transcript prefetch failed', err))
  }, [])

  // Post-boot warm-up (useBootWarmup / prefetch.ts): once hydration
  // settles, fetch the next few recent threads so first switches are cached.
  useBootWarmup({
    selectedConversationId: state.selectedConversationId,
    rosterHydrating: hydrate.rosterHydrating,
    conversationsHydrating: hydrate.conversationsHydrating,
  })
  // Threads the sync feed says moved past their cache are refreshed in the
  // background (bounded), so opening one usually paints the new turns.
  useBehindWarmup({
    conversations: state.conversations,
    selectedConversationId: state.selectedConversationId,
    conversationsHydrating: hydrate.conversationsHydrating,
  })

  /** "Load earlier" past the downloaded rows: page older history in. */
  const loadOlderMessages = useCallback(async (): Promise<boolean> => {
    const id = getState().selectedConversationId
    if (!id) return false
    try {
      const { transport } = await getActiveTransport()
      return (await transport.loadOlderMessages?.(id)) ?? false
    } catch (err) {
      logger.error('[hermes] load older messages failed', err)
      return false
    }
  }, [])

  /** Sidebar "Show more": next conversation-list page. */
  const loadMoreConversations = useCallback(async (): Promise<void> => {
    try {
      const { transport } = await getActiveTransport()
      await transport.loadMoreConversations?.()
    } catch (err) {
      logger.error('[hermes] load more conversations failed', err)
    }
  }, [])

  const handleSend = useCallback(
    async (text: string, opts?: Pick<import('./transport').SendMessageOptions, 'replyTo' | 'attachments' | 'images'>): Promise<SendOutcome> => {
      if (!selectedConversation) return { status: 'rejected' }
      const conversationSnapshot = selectedConversation
      const gen = ++sendGen.current
      beginFlight(conversationSnapshot.id)
      setLocalPhase('listening')

      // CreatureMark morph staging (overlaps transport timers)
      void (async () => {
        await sleep(1000)
        if (sendGen.current !== gen) return
        setLocalPhase('thinking')
        await sleep(900)
        if (sendGen.current !== gen) return
        setLocalPhase('working')
      })()

      let released = false
      const release = () => {
        if (released) return
        released = true
        endFlight(conversationSnapshot.id)
      }

      // No network → park the send instead of throwing it at a gateway that
      // cannot be reached. The optimistic bubble goes into the thread now (so
      // the user sees their message land) and is marked `pending` until the
      // outbox flush delivers it.
      if (isOffline()) {
        const parked = enqueueOutbox({
          id: uid(),
          conversationId: conversationSnapshot.id,
          // Attached files are already on the agent computer; the parked
          // text carries their paths (the bubble hides the note).
          text: withAttachmentNote(text, (opts?.attachments ?? []).map((a) => a.path)),
          ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}),
        })
        appendMessage(conversationSnapshot.id, {
          id: parked.id,
          threadId: conversationSnapshot.id,
          role: 'user',
          content: parked.text,
          createdAt: parked.createdAt,
          pending: true,
          ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}),
          ...(opts?.attachments?.length
            ? { attachments: opts.attachments.map((a, i) => ({ id: `${parked.id}-att-${i}`, name: a.name, kind: a.kind, path: a.path })) }
            : {}),
        })
        cancelLocalPhase()
        release()
        return { status: 'queued' }
      }

      let dispatched = false
      try {
        // Chat→avatar intent: apply + confirm locally, then STILL send
        // normally so the agent sees the message.
        const target = conversationSnapshot.target
        const agentId =
          target.type === 'agent' ? target.agentId : computerAgentId
        if (agentId) maybeApplyAvatarIntent(agentId, text, conversationSnapshot.id)
        const { transport } = await getActiveTransport()
        dispatched = true
        const sendPromise = transport.sendMessage(conversationSnapshot, text, opts)
        track('message_sent', { target: target.type })
        // Unlock `sending` once the transport has the turn. Nub/mock await
        // the full SSE (no timeout on the Nub bridge); hung prompt.submit
        // can sit for 120s. Stream liveness is message.streaming.
        release()
        await sendPromise
        return { status: 'accepted' }
      } catch (err) {
        logger.error(err)
        if (sendGen.current === gen) setLocalPhase('surprised')
        return failedSend(err, dispatched)
      } finally {
        release()
        if (sendGen.current === gen) setLocalPhase(null)
      }
    },
    [selectedConversation, computerAgentId, beginFlight, endFlight],
  )

  const handleChoice = useCallback(
    (choiceId: string, label: string) => {
      void handleSend(`[choice:${choiceId}] ${label}`)
    },
    [handleSend],
  )

  // --- Offline outbox flush ------------------------------------------------
  // Parked sends replay FIFO, one at a time, once the device reports network.
  // Sequential on purpose: the gateway threads turns in order, so firing them
  // in parallel would interleave replies.
  const [outbox, setOutbox] = useState<OutboxItem[]>(() => getOutboxSnapshot())
  const flushingRef = useRef(false)

  useEffect(() => subscribeOutbox(() => setOutbox(getOutboxSnapshot())), [])

  const flushOutbox = useCallback(async () => {
    if (flushingRef.current) return
    if (isOffline()) return
    const items = getOutboxSnapshot()
    if (items.length === 0) return
    flushingRef.current = true
    try {
      const { transport } = await getActiveTransport()
      for (const item of items) {
        // The device may drop again mid-flush; keep the rest parked.
        if (isOffline()) return
        const conversation = getConversation(item.conversationId)
        if (!conversation) {
          // Conversation was deleted while parked — drop rather than leak.
          removeOutbox(item.id)
          continue
        }
        try {
          await transport.sendMessage(conversation, item.text, {
            // The optimistic bubble already rendered; do not echo a second one.
            echoUser: false,
            echoId: item.id,
            ...(item.replyTo ? { replyTo: item.replyTo } : {}),
          })
          removeOutbox(item.id)
          // Delivered: the bubble stops being pending. The reply arrives on
          // the transport's own stream, exactly like a normal send.
          //
          // The bubble and the outbox are separate writes with separate
          // debounces, so a send parked less than one persist window before
          // the app was killed can be queued without its bubble. The outbox is
          // authoritative — re-create the bubble rather than deliver a
          // message the transcript never shows.
          const thread = getMessagesForConversation(item.conversationId)
          if (thread.some((m) => m.id === item.id)) {
            patchMessage(item.conversationId, item.id, { pending: false })
          } else {
            appendMessage(item.conversationId, {
              id: item.id,
              threadId: item.conversationId,
              role: 'user',
              content: item.text,
              createdAt: item.createdAt,
              ...(item.replyTo ? { replyTo: item.replyTo } : {}),
            })
          }
        } catch (err) {
          markOutboxFailure(item.id, err instanceof Error ? err.message : 'Send failed')
          // A failure that is not connectivity (auth, 4xx) will not fix itself
          // by retrying the rest — stop the flush and let the user act.
          return
        }
      }
    } finally {
      flushingRef.current = false
    }
  }, [])

  // Retry when the device comes back, and when the app is resumed (a phone
  // can regain network while backgrounded, which fires no `online` event).
  useEffect(() => {
    const onOnline = () => void flushOutbox()
    window.addEventListener('online', onOnline)
    let wasHidden = document.hidden
    const onVis = () => {
      const becameVisible = wasHidden && !document.hidden
      wasHidden = document.hidden
      if (becameVisible) void flushOutbox()
    }
    document.addEventListener('visibilitychange', onVis)
    // Catch a queue left over from a previous session on first mount.
    void flushOutbox()
    return () => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [flushOutbox])

  /**
   * Drop a parked send (and its optimistic bubble) by message id.
   *
   * The bubble is removed even when the outbox has no matching item: the two
   * are written together, but a failed outbox write (quota, private mode)
   * would otherwise leave a "Waiting to send" bubble that Discard could not
   * clear — a dead end with no way out.
   */
  const discardOutboxItem = useCallback((messageId: string) => {
    const item = getOutboxSnapshot().find((i) => i.id === messageId)
    if (item) removeOutbox(item.id)
    const conversationId =
      item?.conversationId ??
      getState().conversations.find((c) =>
        (getMessagesForConversation(c.id) ?? []).some((m) => m.id === messageId),
      )?.id
    if (conversationId) removeMessageFromThread(conversationId, messageId)
  }, [])

  const handleReact = useCallback(
    async (message: import('./types').ChatMessage, emoji: string | null) => {
      if (!selectedConversation) return
      const { transport } = await getActiveTransport()
      if (transport.reactToMessage) {
        await transport.reactToMessage(selectedConversation, message, emoji)
        return
      }
      const { applyLocalReaction } = await import('../message-actions')
      applyLocalReaction(selectedConversation.id, message.id, emoji, 'user')
    },
    [selectedConversation],
  )

  const handlePermission = useCallback(
    (choice: ToolPermissionChoice, opts?: { optionId?: string }) => {
      const convId = selectedConversation?.id
      if (!convId) return
      void (async () => {
        const { transport } = await getActiveTransport()
        await transport.respondPermission?.(convId, choice, { ...opts, requestId: permissionAsk?.id })
      })().catch(() => logger.warn('[nub] approval response failed; the card can be retried'))
    },
    [selectedConversation, permissionAsk],
  )

  const createAgent = useCallback(async (profile?: NewAgentProfile) => {
    const { transport } = await getActiveTransport()
    const agent = await transport.createAgent(profile)
    // A new agent gets its own first conversation (Grok parity — conversations
    // are the sidebar unit; agents are the roster).
    return storeCreateConversation({ type: 'agent', agentId: agent.id })
  }, [])

  /** Marketplace Add: agent + conversation now, VM setup in the background
   *  (see addAgentFast). The caller must handle `ready` rejecting. */
  const addAgent = useCallback(async (profile?: NewAgentProfile) => {
    const { transport } = await getActiveTransport()
    return addAgentFast(transport, profile)
  }, [])

  const createGroup = useCallback(async (partial?: { name?: string; memberAgentIds?: string[] }, options?: { select?: boolean }) => {
    const { transport } = await getActiveTransport()
    // A blank name lets the transport auto-name the room from its members
    // ("A, B and C") until the user names it.
    const group = await transport.createGroup({
      name: partial?.name?.trim() || undefined,
      memberAgentIds: partial?.memberAgentIds,
    })
    return storeCreateConversation({ type: 'group', groupId: group.id }, group.name, options)
  }, [])

  /** Rooms on for this account (Chief routing). False when unknown. */
  const roomsEnabled = useCallback(async (): Promise<boolean> => {
    const { transport } = await getActiveTransport()
    return (await transport.roomsEnabled?.().catch(() => false)) ?? false
  }, [])

  const setGroupMembers = useCallback(async (groupId: string, memberAgentIds: string[]) => {
    const { transport } = await getActiveTransport()
    return transport.setGroupMembers(groupId, memberAgentIds)
  }, [])

  /** Rename a group or set its purpose. Transports without server groups
   *  update the local store only. */
  const updateGroup = useCallback(async (groupId: string, patch: { name?: string; summary?: string }) => {
    const { transport } = await getActiveTransport()
    if (transport.updateGroup) return transport.updateGroup(groupId, patch)
    setState((prev) => ({
      groups: prev.groups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              ...(patch.name?.trim() ? { name: patch.name.trim(), autoNamed: undefined } : {}),
              ...(patch.summary !== undefined ? { summary: patch.summary.trim() } : {}),
            }
          : g,
      ),
    }))
    return getState().groups.find((g) => g.id === groupId) ?? null
  }, [])

  /** New chat is explicitly fresh. Roster selection still resumes existing work. */
  const newConversation = useCallback(
    (target?: ThreadRef) => {
      const t: ThreadRef | null =
        target ?? selectedConversation?.target ?? (agents[0] ? { type: 'agent', agentId: agents[0]!.id } : null)
      if (!t) return
      const conversation = storeCreateConversation(t)
      cancelLocalPhase()
      return conversation
    },
    [selectedConversation, agents, cancelLocalPhase],
  )

  /** Open a conversation bound to a specific agent/group (roster click). */
  const openWithTarget = useCallback(
    (target: ThreadRef) => {
      const existing = listConversations().find(
        (c) =>
          !c.hiddenFromSidebar &&
          c.target.type === target.type &&
          (c.target.type === 'agent'
            ? c.target.agentId === (target as { agentId: string }).agentId
            : c.target.groupId === (target as { groupId: string }).groupId),
      )
      if (existing) {
        selectConversation(existing.id)
      } else {
        storeCreateConversation(target)
      }
      cancelLocalPhase()
    },
    [cancelLocalPhase],
  )

  // Hide/unhide/pin/delete write back to the server conversation list from
  // the store itself (conversation-sync outbox), so every caller converges.
  const handleHideConversation = useCallback((conversationId: string) => {
    hideConversation(conversationId)
    cancelLocalPhase()
  }, [cancelLocalPhase])

  const handleUnhideConversation = useCallback((conversationId: string) => {
    unhideConversation(conversationId)
  }, [])

  const handleTogglePin = useCallback((conversationId: string) => {
    togglePinConversation(conversationId)
  }, [])

  const handleMarkRead = useCallback((conversationId: string) => {
    markConversationRead(conversationId)
  }, [])

  const handleMarkUnread = useCallback((conversationId: string) => {
    markConversationUnread(conversationId)
  }, [])

  const handleDuplicate = useCallback((conversationId: string) => {
    duplicateConversation(conversationId)
    cancelLocalPhase()
  }, [cancelLocalPhase])

  const handleDeleteConversation = useCallback((conversationId: string) => {
    deleteConversation(conversationId)
    cancelLocalPhase()
  }, [cancelLocalPhase])

  /** False when the stop didn't reach the agent (the UI says so). */
  const cancelSubagent = useCallback(async (runId: string): Promise<boolean> => {
    try {
      const { transport } = await getActiveTransport()
      return await transport.cancelSubagent(runId)
    } catch {
      return false
    }
  }, [])

  /**
   * Stop the turn running in the selected conversation.
   *
   * Only a confirmed stop cancels local activity and silences its completion
   * cue. A delayed confirmation must not change a newer send or selection.
   * Each send releases its own in-flight count; Stop does not own that count.
   */
  const stopTurn = useCallback(async (): Promise<boolean> => {
    if (!selectedConversation) return false
    const conversationId = selectedConversation.id
    const gen = sendGen.current
    const ownsLocalTurn = () =>
      sendGen.current === gen && getState().selectedConversationId === conversationId
    try {
      if (!ownsLocalTurn()) return false
      const { transport } = await getActiveTransport()
      if (!ownsLocalTurn()) return false
      const stopped = (await transport.stopTurn?.(conversationId)) === true
      if (stopped && ownsLocalTurn()) {
        markTurnStopped(conversationId)
        cancelLocalPhase()
      }
      return stopped
    } catch {
      return false
    }
  }, [selectedConversation, cancelLocalPhase])

  /** Retry the last user message. Preserve local activity until confirmed,
   *  and do not dispatch or apply obsolete work after a newer send/selection. */
  const retryTurn = useCallback(async (): Promise<boolean> => {
    if (!selectedConversation) return false
    const conversationId = selectedConversation.id
    const gen = sendGen.current
    const ownsLocalTurn = () =>
      sendGen.current === gen && getState().selectedConversationId === conversationId
    try {
      if (!ownsLocalTurn()) return false
      const { transport } = await getActiveTransport()
      if (!ownsLocalTurn()) return false
      const retried = (await transport.retryTurn?.(conversationId)) === true
      if (retried && ownsLocalTurn()) cancelLocalPhase()
      return retried
    } catch {
      return false
    }
  }, [selectedConversation, cancelLocalPhase])

  const acknowledgeUncertainSend = useCallback(async (conversationId: string): Promise<void> => {
    try {
      const { transport } = await getActiveTransport()
      transport.acknowledgeUncertain?.(conversationId)
    } catch {
      // No transport: there is no guard to lift.
    }
  }, [])

  /** False when the message didn't reach the helper (the UI says so). */
  const messageSubagent = useCallback(async (runId: string, text: string): Promise<boolean> => {
    try {
      const { transport } = await getActiveTransport()
      return (await transport.messageSubagent?.(runId, text)) ?? false
    } catch {
      return false
    }
  }, [])

  /** Grok Bot parity: spawn a subagent INTO the selected conversation (separate
   *  agent session shown as a sub-thread tab, not fake inline chips). */
  const spawnIntoConversation = useCallback(
    async (kind: SubagentKind, goal: string, label?: string): Promise<SubagentRun | null> => {
      if (!selectedConversation) return null
      const { transport } = await getActiveTransport()
      const run = await transport.spawnSubagentInto(
        selectedConversation,
        kind,
        goal,
        label ? { label } : undefined,
      )
      if (run.source !== 'delegate_task') {
        void continueAfterSubagent({
          runId: run.id,
          userText: goal,
          conversation: selectedConversation,
          send: (prompt) =>
            transport.sendMessage(selectedConversation, prompt, { echoUser: false }),
        })
      }
      return run
    },
    [selectedConversation],
  )

  /** Grok Bot parity: edit an agent's mascot (shape/color), name, title, bio. */
  const updateAgentProfile = useCallback(
    (agentId: string, patch: {
      name?: string
      title?: string
      description?: string
      avatarShape?: string | null
      avatarColor?: string | null
      avatarEyeColor?: string | null
      mcpServers?: import('./types').AgentMcpServer[]
      role?: import('./types').AgentRole
    }) => {
      updateAgentStore(agentId, {
        ...patch,
        avatarShape: patch.avatarShape as import('../../components/FatCatIcon').GrokOrbShape | null | undefined,
      })
      const next = getState().agents.find((a) => a.id === agentId)
      if (next?.hermesProfile && (patch.name !== undefined || patch.description !== undefined)) {
        // Keep the real hermes profile (hosted VM) in step: rename + description.
        void import('../agent-profiles').then((m) => m.syncAgentProfile(agentId, next.hermesProfile!, patch))
      }
      if (next) {
        void (async () => {
          try {
            await syncDesktopAgentToHermes(next)
          } catch (err) {
            logger.warn('[nub] failed to sync agent to VM', err)
          }
        })()
        // Group rooms read member profiles off the group: re-put them.
        void (async () => {
          try {
            const { transport } = await getActiveTransport()
            transport.saveAgentEdit?.(agentId)
            transport.syncGroupProfiles?.(agentId)
          } catch (err) {
            logger.warn('[nub] failed to re-sync group profiles', err)
          }
        })()
      }
    },
    [],
  )

  /** Make one member the group's Chief of Staff: it becomes the orchestrator
   *  and any other member that was one becomes a specialist, so the room has
   *  exactly one lead. `null` clears the Chief (everyone answers). */
  const setGroupChief = useCallback(
    (groupId: string, agentId: string | null) => {
      const group = getState().groups.find((g) => g.id === groupId)
      if (!group) return
      for (const id of group.memberAgentIds) {
        const agent = getState().agents.find((a) => a.id === id)
        if (!agent) continue
        if (id === agentId) {
          if (agent.role !== 'orchestrator') updateAgentProfile(id, { role: 'orchestrator' })
        } else if (isOrchestrator(agent)) {
          updateAgentProfile(id, { role: 'specialist' })
        }
      }
    },
    [updateAgentProfile],
  )

  useEffect(() => {
    void syncRosterToHermes(getState().agents)
  }, [])

  useEffect(() => {
    return startDelegateContinuations(async (conversation, prompt) => {
      const { transport } = await getActiveTransport()
      await transport.sendMessage(conversation, prompt, { echoUser: false })
    })
  }, [])

  useEffect(() => {
    if (didSettleBootInFlight) return
    didSettleBootInFlight = true
    const prev = getState()
    const live = inFlightIdSet()
    const settled = settleStaleInFlight(prev)
    const messagesByThreadId = { ...settled.messagesByThreadId }
    for (const id of live) {
      const msgs = prev.messagesByThreadId[id]
      if (msgs) messagesByThreadId[id] = msgs
    }
    setState({
      messagesByThreadId,
      subagentsById: settled.subagentsById,
    })
  }, [])

  useEffect(() => {
    if (state.selectedConversationId) return
    // While hydration is in flight, skip the synthesized placeholder thread —
    // auto-selecting it would flash a fake "Nub" chat instead of skeletons.
    // Once hydration settles, the placeholder is the legitimate forever-chat.
    const hydrating = hydrate.rosterHydrating || hydrate.conversationsHydrating
    const first = hydrating
      ? conversations.find((c) => !c.placeholder)
      : conversations[0]
    if (first) selectConversation(first.id)
  }, [state.selectedConversationId, conversations, hydrate])

  useEffect(() => {
    const id = state.selectedConversationId
    if (!id || historyRef.current.length > 0) return
    historyRef.current = [id]
    historyIndexRef.current = 0
  }, [state.selectedConversationId])

  return {
    agents,
    groups,
    conversations,
    rosterHydrating: hydrate.rosterHydrating,
    conversationsHydrating: hydrate.conversationsHydrating,
    rosterHydrateError: hydrate.rosterHydrateError,
    /** The server has older history above the open thread's oldest page. */
    historyHasMore: Boolean(
      state.selectedConversationId &&
        hydrate.historyPaging[state.selectedConversationId]?.hasMore,
    ),
    /** An older-history page for the open thread is being fetched. */
    historyLoadingOlder: Boolean(
      state.selectedConversationId &&
        hydrate.historyPaging[state.selectedConversationId]?.loadingOlder,
    ),
    loadOlderMessages,
    prefetchConversation,
    conversationsHasMore: hydrate.conversationsHasMore,
    conversationsLoadingMore: hydrate.conversationsLoadingMore,
    loadMoreConversations,
    /** The open conversation's transcript is still on its first fetch. */
    transcriptLoading:
      hydrate.transcriptLoadingId !== null &&
      hydrate.transcriptLoadingId === state.selectedConversationId,
    /** The open conversation's last transcript fetch failed. With no cached
     *  rows the chat offers a retry instead of the false empty state. */
    transcriptError:
      hydrate.transcriptErrorId !== null &&
      hydrate.transcriptErrorId === state.selectedConversationId,
    /** Re-run the transcript load for the already-selected thread. */
    retryTranscript,
    /** The open CACHED conversation is re-checking its transcript: `behind`
     *  when the sync feed says newer turns are on the way, `checking`
     *  otherwise (ChatPanel shows the latter only if it runs long). */
    transcriptSyncing:
      hydrate.transcriptSync && hydrate.transcriptSync.id === state.selectedConversationId
        ? hydrate.transcriptSync.behind
          ? ('behind' as const)
          : ('checking' as const)
        : null,
    hiddenConversations,
    selectedConversation,
    selectedAgent,
    selectedGroup,
    computerAgentId,
    computerAgent,
    messages,
    messagesByThreadId: state.messagesByThreadId,
    liveSubagents,
    conversationSubagents,
    recentSubagents,
    liveSubagentAgentIds,
    liveConversationIds,
    sending,
    activityPhase,
    presence,
    roomStatus,
    roomHandoffs,
    roomThreadStrips,
    mentionMembers,
    queuedCount: (conversationId: string) => queuedCounts.get(conversationId) ?? 0,
    queuedMessages: (conversationId: string) => queuedItems.get(conversationId) ?? [],
    removeQueuedMessage: useCallback((conversationId: string, itemId: string) => {
      void (async () => {
        const { getActiveTransport } = await import('./active-transport')
        const { transport } = await getActiveTransport()
        // Local optimistic removal is handled by the transport's own 'queued'
        // emit; this just forwards to transports that implement removal.
        await transport.removeQueuedMessage?.(conversationId, itemId)
      })()
    }, []),
    handleSelect,
    goConversationBack,
    goConversationForward,
    cycleConversation,
    handleSend,
    handleReact,
    handleChoice,
    handlePermission,
    stopTurn,
    retryTurn,
    acknowledgeUncertainSend,
    /** Parked offline sends (all conversations, oldest first). */
    outbox,
    flushOutbox,
    discardOutboxItem,
    permissionAsk,
    createAgent,
    addAgent,
    createGroup,
    roomsEnabled,
    setGroupMembers,
    updateGroup,
    setGroupChief,
    newConversation,
    openWithTarget,
    hideConversation: handleHideConversation,
    unhideConversation: handleUnhideConversation,
    togglePinConversation: handleTogglePin,
    markConversationRead: handleMarkRead,
    markConversationUnread: handleMarkUnread,
    duplicateConversation: handleDuplicate,
    deleteConversation: handleDeleteConversation,
    updateAgentProfile,
    spawnIntoConversation,
    cancelSubagent,
    messageSubagent,
    threadKey: selectedConversation?.id ?? 'none',
  }
}
