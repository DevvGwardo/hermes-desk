/** In-memory store + subscribers (background revival lives here). */

import type { Agent, ChatMessage, Conversation, Group, SubagentRun, ThreadRef, Turn } from './types'
import type { GrokOrbShape } from '../../components/FatCatIcon'
import { SEED_AGENTS, SEED_GROUPS, SEED_CONVERSATIONS, SEED_SUBAGENT_HISTORY, seedMessages, SEED_AGENT_IDS, SEED_CONVERSATION_IDS } from './mock-data'
import { loadPersistedState, schedulePersist as persistState, scheduleSlowPersist as persistSlowState, clearPersistedState } from './persist'
import { recordDeletedConversation } from './tombstones'

export interface AgentsState {
  agents: Agent[]
  groups: Group[]
  /** Conversations (Grok parity): the sidebar lists these; each owns a thread. */
  conversations: Conversation[]
  /** Keyed by conversation id (a conversation == a thread). */
  messagesByThreadId: Record<string, ChatMessage[]>
  /** All runs keyed by run id */
  subagentsById: Record<string, SubagentRun>
  turnsById: Record<string, Turn>
  selectedConversationId: string | null
}

type Listener = () => void

function indexRuns(runs: SubagentRun[]): Record<string, SubagentRun> {
  const out: Record<string, SubagentRun> = {}
  for (const r of runs) out[r.id] = r
  return out
}

function createSeedState(): AgentsState {
  return {
    agents: SEED_AGENTS.map((a) => ({ ...a })),
    groups: SEED_GROUPS.map((g) => ({ ...g, memberAgentIds: [...g.memberAgentIds] })),
    conversations: SEED_CONVERSATIONS.map((c) => ({ ...c, target: { ...c.target } })),
    messagesByThreadId: seedMessages(),
    subagentsById: indexRuns(SEED_SUBAGENT_HISTORY),
    turnsById: {},
    selectedConversationId: SEED_CONVERSATIONS[0]?.id ?? null,
  }
}

function createEmptyState(): AgentsState {
  return {
    agents: [],
    groups: [],
    conversations: [],
    messagesByThreadId: {},
    subagentsById: {},
    turnsById: {},
    selectedConversationId: null,
  }
}

/** Boot with local profile/thread metadata only. Never load hosted or demo chats. */
function createInitialState(): AgentsState {
  const persisted = loadPersistedState()
  if (!persisted) return createEmptyState()
  if (hasOnlySeedData(persisted)) {
    const empty = createEmptyState()
    schedulePersist(empty)
    return empty
  }
  const agents = persisted.agents.filter((a) => a.id.startsWith('profile:'))
  const groups = persisted.groups.filter(g => g.memberAgentIds.every(id => id.startsWith('profile:')))
  const conversations = persisted.conversations.filter((c) =>
    c.target.type === 'agent' ? c.target.agentId.startsWith('profile:')
      : groups.some(g => c.target.type === 'group' && g.id === c.target.groupId),
  )
  const local = {
    ...createEmptyState(),
    agents,
    groups,
    conversations,
    selectedConversationId: conversations.some((c) => c.id === persisted.selectedConversationId)
      ? persisted.selectedConversationId : null,
  }
  // Supersede the legacy loader's migration write, which may include old transcripts.
  schedulePersist(local)
  return local
}

// Shared empties: persist skips an unchanged write by identity, and a fresh
// `{}` per call made every debounced save rewrite the whole meta.
const NO_MESSAGES: AgentsState['messagesByThreadId'] = Object.freeze({})
const NO_SUBAGENTS: AgentsState['subagentsById'] = Object.freeze({})
const NO_TURNS: AgentsState['turnsById'] = Object.freeze({})

/** DMs are serve-owned. Local room logs live in their conversation journal. */
function schedulePersist(value: AgentsState): void {
  persistState({ ...value, messagesByThreadId: NO_MESSAGES, subagentsById: NO_SUBAGENTS, turnsById: NO_TURNS })
}

function scheduleSlowPersist(value: AgentsState): void {
  persistSlowState({ ...value, messagesByThreadId: NO_MESSAGES, subagentsById: NO_SUBAGENTS, turnsById: NO_TURNS })
}

/** True when every agent/conversation in the state is a demo seed id. */
function hasOnlySeedData(state: AgentsState): boolean {
  const seedAgents = new Set<string>(SEED_AGENT_IDS as readonly string[])
  const seedConvs = new Set<string>(SEED_CONVERSATION_IDS as readonly string[])
  const hasNonSeedAgent = state.agents.some((a) => !seedAgents.has(a.id) && a.id !== 'local-hermes')
  const hasNonSeedConv = state.conversations.some((c) => !seedConvs.has(c.id))
  return !hasNonSeedAgent && !hasNonSeedConv
}

let state: AgentsState = createInitialState()
const listeners = new Set<Listener>()

export function getState(): AgentsState {
  return state
}

/**
 * The state as of the last STRUCTURAL commit. A streaming tick that only
 * grows the text of a reply that already shows text ("content-only", see
 * applyPendingMessagePatches) updates `state` but leaves this snapshot alone,
 * so shell-level subscribers (App, TopBar, the ChatPanel body) skip the
 * ~60/s re-render while a reply streams. The rows that show that text read
 * it through `useLiveMessage`. Any other commit catches this up to `state`.
 */
let structuralState: AgentsState = state

export function getStructuralState(): AgentsState {
  return structuralState
}

/** Messages whose content moved since `structuralState`, by message id. */
const liveMessages = new Map<string, ChatMessage>()

/**
 * The newest copy of `m` when a content-only tick grew it past the
 * structural snapshot; otherwise `m` itself (same identity). Only a strict
 * text extension is substituted, so a derived row (a reply split around a
 * typed answer) never gets the whole reply's text.
 */
export function getLiveMessage(m: ChatMessage): ChatMessage {
  if (liveMessages.size === 0) return m
  const live = liveMessages.get(m.id)
  if (!live || live === m || live.streaming !== m.streaming) return m
  if (live.content.length <= m.content.length || !live.content.startsWith(m.content)) return m
  return live
}

/** True when applying `patch` would leave every key identical. */
function isNoopPatch(patch: Partial<AgentsState>): boolean {
  for (const key in patch) {
    if (patch[key as keyof AgentsState] !== state[key as keyof AgentsState]) return false
  }
  return true
}

/** Commit a new state. `contentOnly` lists the messages a content-only tick
 *  grew; anything else is structural and catches the shell snapshot up. */
function commit(nextPatch: Partial<AgentsState>, contentOnly?: ChatMessage[]): void {
  state = { ...state, ...nextPatch }
  if (contentOnly) {
    for (const m of contentOnly) liveMessages.set(m.id, m)
  } else {
    structuralState = state
    liveMessages.clear()
  }
  listeners.forEach((l) => l())
}

/** Session-only hydrate flags — never persisted. Prod boots hydrating so
 *  the first paint is a skeleton, not a fake empty roster. */
export interface HydrateStatus {
  serveConnection: 'connecting' | 'online' | 'offline'
  readOnly: boolean
  serveError: string | null
  localSessions: Record<string, LocalSessionState>
  rosterHydrating: boolean
  conversationsHydrating: boolean
  rosterHydrateError: string | null
  /** Conversation whose transcript is being fetched for the first time.
   *  The chat shows a skeleton instead of a false "No messages yet". */
  transcriptLoadingId: string | null
  /** Conversation whose last transcript fetch FAILED. With no cached rows the
   *  chat shows a retry offer instead of the false "Send a message" empty
   *  state — a failed load is unknown, not empty, same as a running one. */
  transcriptErrorId: string | null
  /** A CACHED conversation's transcript refresh is in flight. `behind`: the
   *  sync feed says the server has newer turns than the cache, so the chat
   *  shows where they will land (transcript-freshness.ts). */
  transcriptSync: TranscriptSync | null
  /** Server history paging per conversation (deploy transport). Absent →
   *  no older page known (old server, or not hydrated yet). */
  historyPaging: Record<string, HistoryPageStatus>
  /** The conversation list has another (older) server page. */
  conversationsHasMore: boolean
  /** A "Show more" conversation page fetch is in flight. */
  conversationsLoadingMore: boolean
  /** Server-reported live turns keyed by conversation id (conversation sync
   *  `live`) — lights the working indicator on rows streaming on ANY device. */
  liveTurns: Record<string, LiveTurn>
}

export interface LocalSessionState {
  binding?: { profile: string; storedId: string; runtimeId: string }
  pickedUpMessageIds?: readonly string[]
  status?: string
  todos?: unknown[]
  todoRevision?: number
  usage?: Record<string, unknown>
  modelRoute?: import('./session-model').SessionModelRoute
}

export function setLocalSessionBinding(
  conversationId: string,
  binding: NonNullable<LocalSessionState['binding']>,
): void {
  const previous = hydrateStatus.localSessions[conversationId]
  if (previous?.binding?.profile === binding.profile &&
    previous.binding.storedId === binding.storedId && previous.binding.runtimeId === binding.runtimeId) return
  setHydrateStatus({
    localSessions: { ...hydrateStatus.localSessions, [conversationId]: { ...previous, binding, modelRoute: undefined } },
  })
}

/** Only message.start acknowledges a send, not an optimistic reply or history. */
export function acknowledgeLocalMessageStart(conversationId: string): void {
  const turn = Object.values(state.turnsById).findLast((t) => t.threadId === conversationId)
  const messageId = turn?.userMessageId ||
    state.messagesByThreadId[conversationId]?.findLast((m) => m.role === 'user')?.id
  if (!messageId) return
  const previous = hydrateStatus.localSessions[conversationId]
  const pickedUp = previous?.pickedUpMessageIds ?? []
  if (pickedUp.includes(messageId)) return
  setHydrateStatus({
    localSessions: {
      ...hydrateStatus.localSessions,
      [conversationId]: { ...previous, pickedUpMessageIds: [...pickedUp, messageId] },
    },
  })
}

export interface TranscriptSync {
  id: string
  behind: boolean
}

export interface LiveTurn {
  turnId: string
  sessionId: string
  status: 'pending' | 'streaming' | 'queued' | 'dispatching'
}

export interface HistoryPageStatus {
  /** The server reported older turns above the oldest downloaded page. */
  hasMore: boolean
  /** An older page fetch is in flight. */
  loadingOlder: boolean
}

function initialHydrateStatus(): HydrateStatus {
  return {
    serveConnection: 'offline',
    readOnly: true,
    serveError: 'Hermes serve offline — Retry / Diagnostics',
    localSessions: {},
    rosterHydrating: true,
    conversationsHydrating: true,
    rosterHydrateError: null,
    transcriptLoadingId: null,
    transcriptErrorId: null,
    transcriptSync: null,
    historyPaging: {},
    conversationsHasMore: false,
    conversationsLoadingMore: false,
    liveTurns: {},
  }
}

let hydrateStatus: HydrateStatus = initialHydrateStatus()

export function getHydrateStatus(): HydrateStatus {
  return hydrateStatus
}

export function setHydrateStatus(patch: Partial<HydrateStatus>): void {
  const next: HydrateStatus = { ...hydrateStatus, ...patch }
  if (
    next.serveConnection === hydrateStatus.serveConnection &&
    next.readOnly === hydrateStatus.readOnly &&
    next.serveError === hydrateStatus.serveError &&
    next.localSessions === hydrateStatus.localSessions &&
    next.rosterHydrating === hydrateStatus.rosterHydrating &&
    next.conversationsHydrating === hydrateStatus.conversationsHydrating &&
    next.rosterHydrateError === hydrateStatus.rosterHydrateError &&
    next.transcriptLoadingId === hydrateStatus.transcriptLoadingId &&
    next.transcriptErrorId === hydrateStatus.transcriptErrorId &&
    next.transcriptSync === hydrateStatus.transcriptSync &&
    next.historyPaging === hydrateStatus.historyPaging &&
    next.conversationsHasMore === hydrateStatus.conversationsHasMore &&
    next.conversationsLoadingMore === hydrateStatus.conversationsLoadingMore &&
    next.liveTurns === hydrateStatus.liveTurns
  ) {
    return
  }
  hydrateStatus = next
  listeners.forEach((l) => l())
}

export function setState(
  patch: Partial<AgentsState> | ((prev: AgentsState) => Partial<AgentsState>),
  opts?: { persist?: boolean; epoch?: number },
): void {
  // Hydrate epoch guard: transports capture the epoch when a poll starts and
  // pass it back with the result. A relink/reset bumps the epoch, so a slow
  // response from the PREVIOUS session is discarded instead of smearing the
  // old cube's roster over the fresh link.
  if (opts?.epoch !== undefined && opts.epoch !== storeEpoch) return
  const nextPatch = typeof patch === 'function' ? patch(state) : patch
  // Nothing changed (empty patch, or every key identity-equal — e.g. an
  // updater that returned `prev`): no notify, no full-store persist.
  if (isNoopPatch(nextPatch)) return
  commit(nextPatch)
  if (opts?.persist !== false) schedulePersist(state)
}

/** Hydrate epoch: bump on relink/reset; stale poll results carry the old one. */
let storeEpoch = 0

export function beginStoreEpoch(): number {
  storeEpoch += 1
  return storeEpoch
}

export function currentStoreEpoch(): number {
  return storeEpoch
}

/**
 * Metadata-only patch: applies immediately to the UI but skips the full
 * localStorage stringify, parking one coalesced write on the slow flush
 * instead. Use for flags/previews/sort keys — never for message content.
 */
function setMetadataState(
  patch: Partial<AgentsState> | ((prev: AgentsState) => Partial<AgentsState>),
): void {
  const nextPatch = typeof patch === 'function' ? patch(state) : patch
  if (isNoopPatch(nextPatch)) return
  commit(nextPatch)
  scheduleSlowPersist(state)
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetStore(opts?: { seed?: boolean }): void {
  clearPendingMessagePatches()
  clearPersistedState()
  // A reset starts a new epoch: any in-flight poll that captured the old
  // epoch has its setState discarded on arrival (see setState).
  beginStoreEpoch()
  state = opts?.seed ? createSeedState() : createEmptyState()
  structuralState = state
  liveMessages.clear()
  hydrateStatus = {
    serveConnection: 'offline',
    readOnly: true,
    serveError: 'Hermes serve offline — Retry / Diagnostics',
    localSessions: {},
    rosterHydrating: false,
    conversationsHydrating: false,
    rosterHydrateError: null,
    transcriptLoadingId: null,
    transcriptErrorId: null,
    transcriptSync: null,
    historyPaging: {},
    conversationsHasMore: false,
    conversationsLoadingMore: false,
    liveTurns: {},
  }
  conversationSyncSink = null
  conversationReadSink = null
  listeners.forEach((l) => l())
}

/**
 * Server write-back for conversation/group edits (the deploy transport's
 * conversation sync outbox). Null on transports with no server list (mock,
 * serve), so these mutations stay local there.
 */
export interface ConversationSyncSink {
  // Compatibility for legacy consumers. Local serve does not install this sink.
  putThread(id: string, body: {
    kind?: 'agent' | 'group'; targetId?: string; sessionId?: string
    memberSessions?: Record<string, string>; title?: string
    titleSource?: 'auto' | 'user'; hidden?: boolean; pinned?: boolean
  }): void
  deleteThread(conv: Pick<Conversation, 'id' | 'hermesSessionId' | 'memberSessionIds'>): void
  putGroup(group: Group): void
  deleteGroup(id: string): void
}

let conversationSyncSink: ConversationSyncSink | null = null

export function setConversationSyncSink(sink: ConversationSyncSink | null): void {
  conversationSyncSink = sink
}

export function getConversationSyncSink(): ConversationSyncSink | null {
  return conversationSyncSink
}

/** Publish one conversation's history paging state (no-op when unchanged). */
export function setHistoryPaging(conversationId: string, status: HistoryPageStatus): void {
  const prev = hydrateStatus.historyPaging[conversationId] ?? { hasMore: false, loadingOlder: false }
  // Absent reads as "no more, idle" — a plain first hydrate with no older
  // page must not cost the open thread an extra notify (C1: one commit).
  if (prev.hasMore === status.hasMore && prev.loadingOlder === status.loadingOlder) return
  setHydrateStatus({ historyPaging: { ...hydrateStatus.historyPaging, [conversationId]: status } })
}

export function appendMessage(threadId: string, message: ChatMessage): void {
  setState((prev) => ({
    messagesByThreadId: {
      ...prev.messagesByThreadId,
      [threadId]: [...(prev.messagesByThreadId[threadId] ?? []), message],
    },
  }))
}

/**
 * Drop one message from a thread.
 *
 * Retry uses this to clear the failed bubble (and its user echo) before
 * re-sending, so a retried turn does not leave the error row behind. Any
 * queued patch for the message is discarded too — a pending streaming patch
 * would otherwise resurrect nothing (the id is gone) but still flush a
 * pointless store write.
 */
export function removeMessage(threadId: string, messageId: string): void {
  pendingMsgPatches.delete(messagePatchKey(threadId, messageId))
  setState((prev) => {
    const thread = prev.messagesByThreadId[threadId]
    if (!thread?.some((m) => m.id === messageId)) return prev
    return {
      messagesByThreadId: {
        ...prev.messagesByThreadId,
        [threadId]: thread.filter((m) => m.id !== messageId),
      },
    }
  })
}

type PendingMsgPatch = { threadId: string; messageId: string; patch: Partial<ChatMessage> }
const pendingMsgPatches = new Map<string, PendingMsgPatch>()
let patchRaf = 0

function messagePatchKey(threadId: string, messageId: string): string {
  return `${threadId}\0${messageId}`
}

function applyPendingMessagePatches(): void {
  patchRaf = 0
  if (pendingMsgPatches.size === 0) return
  const batch = [...pendingMsgPatches.values()]
  pendingMsgPatches.clear()
  // Persist any patch that changes a message's DELIVERY state. `streaming`
  // and `pending` both used to be session-only flags, but `pending` now marks
  // an outbox send that has since been delivered — without persisting that
  // transition a reload would resurrect the "Waiting to send" marker on a
  // message the agent already answered.
  const persist = batch.some(
    (item) => item.patch.streaming === false || item.patch.pending === false,
  )
  // A live turn settling in a thread the user is NOT reading flags the row.
  // This is the phone's "did my agent answer while I was away?" signal, and
  // the streaming→false transition is the one moment that distinguishes a
  // real reply from history: hydration appends already-settled messages
  // straight through appendMessage, so flagging there would badge every
  // thread on every load. selectConversation clears the flag on open.
  const settledThreads = new Set(
    batch
      .filter((item) => item.patch.streaming === false)
      .map((item) => item.threadId),
  )
  const settled: ReplySettled[] = []
  const prev = state
  const messagesByThreadId = { ...prev.messagesByThreadId }
  const byThread = new Map<string, Map<string, Partial<ChatMessage>>>()
  for (const item of batch) {
    let byId = byThread.get(item.threadId)
    if (!byId) {
      byId = new Map()
      byThread.set(item.threadId, byId)
    }
    const prevPatch = byId.get(item.messageId)
    byId.set(item.messageId, prevPatch ? { ...prevPatch, ...item.patch } : item.patch)
  }
  const unread = new Set<string>()
  // Grown replies, while every patch in the batch is a content-only tick;
  // null once any patch is structural.
  let contentOnly: ChatMessage[] | null = []
  for (const [threadId, byId] of byThread) {
    const thread = messagesByThreadId[threadId] ?? []
    // A typed answer splits its reply into derived rows (placeTypedAnswers)
    // that the live row lookup cannot follow: keep that thread structural.
    if (contentOnly && thread.some((m) => m.answerAt)) contentOnly = null
    messagesByThreadId[threadId] = thread.map((m) => {
      const p = byId.get(m.id)
      if (!p) return m
      const next = { ...m, ...p }
      if (contentOnly) {
        if (isContentOnlyTick(m, p, next)) contentOnly.push(next)
        else contentOnly = null
      }
      if (settledThreads.has(threadId) && p.streaming === false && m.streaming === true && next.role === 'agent') {
        settled.push({ threadId, message: next })
      }
      if (
        settledThreads.has(threadId) &&
        next.role === 'agent' &&
        next.streaming === false &&
        !next.error &&
        prev.selectedConversationId !== threadId
      ) {
        unread.add(threadId)
      }
      return next
    })
  }
  const patch: Partial<AgentsState> =
    unread.size === 0
      ? { messagesByThreadId }
      : {
          messagesByThreadId,
          conversations: prev.conversations.map((c) =>
            unread.has(c.id) && !c.hiddenFromSidebar ? { ...c, hasUnread: true } : c,
          ),
        }
  commit(patch, contentOnly && contentOnly.length > 0 ? contentOnly : undefined)
  if (persist) schedulePersist(state)
  for (const event of settled) for (const l of [...replyListeners]) l(event)
}

/**
 * A streaming tick that only extends the text of an agent reply that
 * already shows text. Nothing but the bubble itself renders differently
 * (the activity line, row shape and bubble grouping key on "has text", tool
 * events and flags), so it skips the shell snapshot. The first token
 * (empty → text) stays structural: it flips "Working…" to "Typing…".
 */
function isContentOnlyTick(m: ChatMessage, p: Partial<ChatMessage>, next: ChatMessage): boolean {
  for (const key in p) if (key !== 'content') return false
  return (
    m.streaming === true &&
    m.role === 'agent' &&
    m.content.trim() !== '' &&
    next.content.length > m.content.length &&
    next.content.startsWith(m.content)
  )
}

export interface ReplySettled {
  threadId: string
  /** The agent message as it settled (check `error` for a failed turn). */
  message: ChatMessage
}

const replyListeners = new Set<(e: ReplySettled) => void>()

/**
 * A live agent reply just finished streaming (or failed). Fires once per
 * reply, at the streaming→settled transition; history loads never fire it.
 * System notifications listen here (lib/use-system-notifications.ts).
 */
export function onReplySettled(listener: (e: ReplySettled) => void): () => void {
  replyListeners.add(listener)
  return () => replyListeners.delete(listener)
}

function clearPendingMessagePatches(): void {
  pendingMsgPatches.clear()
  if (patchRaf) {
    cancelAnimationFrame(patchRaf)
    patchRaf = 0
  }
}

/** Flush coalesced streaming patches now (tests + turn-complete). */
export function flushMessagePatches(): void {
  if (patchRaf) {
    cancelAnimationFrame(patchRaf)
    patchRaf = 0
  }
  applyPendingMessagePatches()
}

function isUrgentMessagePatch(patch: Partial<ChatMessage>): boolean {
  return patch.streaming === false || patch.toolEvents !== undefined
}

/** Patch a message in place (streaming: grow content / add tool events).
 *  Token deltas coalesce to one store notify per animation frame. Tool-call
 *  chips and the final `streaming: false` flush immediately. */
export function patchMessage(threadId: string, messageId: string, patch: Partial<ChatMessage>): void {
  const key = messagePatchKey(threadId, messageId)
  const prev = pendingMsgPatches.get(key)
  pendingMsgPatches.set(key, {
    threadId,
    messageId,
    patch: prev ? { ...prev.patch, ...patch } : patch,
  })
  if (isUrgentMessagePatch(patch)) {
    flushMessagePatches()
    return
  }
  if (!patchRaf) {
    patchRaf = requestAnimationFrame(applyPendingMessagePatches)
  }
}

/**
 * Append a token delta to a streaming bubble inside the pending-patch queue.
 * The naive `content: current + text` pattern reads the store, concatenates,
 * and writes — two deltas in one rAF coalesce to the SAME base value and the
 * first token is dropped. Queuing an append keeps every delta.
 */
export function appendMessageContent(threadId: string, messageId: string, text: string): void {
  if (!text) return
  const key = messagePatchKey(threadId, messageId)
  const prev = pendingMsgPatches.get(key)
  if (prev?.patch.content !== undefined) {
    // Extend the queued append: still one store notify per frame, no lost
    // tokens between them.
    patchMessage(threadId, messageId, { content: prev.patch.content + text })
    return
  }
  const thread = getState().messagesByThreadId[threadId] ?? []
  const current = thread.find((m) => m.id === messageId)?.content ?? ''
  patchMessage(threadId, messageId, { content: current + text })
}

export function upsertSubagent(run: SubagentRun): void {
  setState((prev) => ({
    subagentsById: capRuns(
      { ...prev.subagentsById, [run.id]: run },
      // A just-settled run ages from settlement, not creation: otherwise a
      // days-old delegate that fails today vanishes before showing failed.
      // Clamped at creation: a finish timestamp older than creation is
      // corrupt data (clocks, fixtures) and must not extend retention.
      (r) => {
        const finished = Date.parse(r.finishedAt ?? '')
        const created = Date.parse(r.createdAt ?? '')
        if (Number.isFinite(finished) && Number.isFinite(created)) {
          return new Date(Math.max(finished, created)).toISOString()
        }
        return r.finishedAt ?? r.createdAt
      },
      (r) => r.status === 'queued' || r.status === 'running',
    ),
  }))
}

/**
 * Grok Bot parity: a spawned subagent is ALSO a clickable bubble in the parent
 * conversation's transcript (not just a sub-thread tab). This appends that
 * bubble message and returns it. Id is deterministic (`submsg_<runId>`) so a
 * re-sync never duplicates it.
 */
export function appendSubagentMessage(conversationId: string, run: SubagentRun): ChatMessage {
  const thread = getState().messagesByThreadId[conversationId] ?? []
  const existing = thread.find((m) => m.role === 'subagent' && m.subagentRunId === run.id)
  if (existing) return existing
  const msg: ChatMessage = {
    id: `submsg_${run.id}`,
    threadId: conversationId,
    role: 'subagent',
    content: '',
    createdAt: run.createdAt,
    subagentRunId: run.id,
    subagentKind: run.kind,
    subagentStatus: run.status,
    ...(run.label ? { subagentLabel: run.label } : {}),
  }
  setState((prev) => ({
    messagesByThreadId: {
      ...prev.messagesByThreadId,
      [conversationId]: [...(prev.messagesByThreadId[conversationId] ?? []), msg],
    },
  }))
  return msg
}

/**
 * Grok Bot parity: keep the subagent bubble's live status (and body) in step
 * with its run — queued → running → completed/failed. Body is the latest
 * digest, or the final result/error once the run ends. No-op when the run has
 * no conversation (e.g. subagents listed by parent id only).
 */
export function syncSubagentMessage(run: SubagentRun): void {
  const conversationId = run.conversationId
  if (!conversationId) return
  const body = run.error ?? run.result?.summary ?? run.digests[run.digests.length - 1]?.text ?? ''
  setState((prev) => ({
    messagesByThreadId: {
      ...prev.messagesByThreadId,
      [conversationId]: (prev.messagesByThreadId[conversationId] ?? []).map((m) =>
        m.role === 'subagent' && m.subagentRunId === run.id
          ? { ...m, subagentStatus: run.status, ...(body ? { content: body } : {}) }
          : m,
      ),
    },
  }))
}

export function upsertTurn(turn: Turn): void {
  setState((prev) => ({
    turnsById: capRuns({ ...prev.turnsById, [turn.id]: turn }, (t) => t.startedAt),
  }))
}

/**
 * LRU + TTL cap for run maps (subagents, turns): keep the 50 most recent,
 * drop terminal runs older than 7 days. Live (queued/running) runs are
 * never evicted — dropping a run the UI still watches loses digests and
 * breaks waiters holding the run id. Unparseable timestamps are kept
 * (never evict what we cannot date).
 */
const MAX_RUNS_KEPT = 50
const RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000

function capRuns<R>(
  byId: Record<string, R>,
  atOf: (r: R) => string | undefined,
  isLive?: (r: R) => boolean,
): Record<string, R> {
  const entries = Object.entries(byId)
  const now = Date.now()
  const live = isLive ?? (() => false)
  const kept = entries.filter(([, r]) => {
    if (live(r)) return true
    const t = Date.parse(atOf(r) ?? '')
    return !Number.isFinite(t) || now - t <= RUN_TTL_MS
  })
  kept.sort(([, a], [, b]) => {
    const la = live(a) ? 1 : 0
    const lb = live(b) ? 1 : 0
    if (la !== lb) return lb - la
    const ta = Date.parse(atOf(a) ?? '')
    const tb = Date.parse(atOf(b) ?? '')
    const na = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY
    const nb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY
    return nb - na
  })
  const sliced = kept.slice(0, MAX_RUNS_KEPT)
  if (sliced.length === entries.length) return byId
  return Object.fromEntries(sliced)
}

export function listSubagentsForParent(
  parentAgentId: string,
  opts?: { liveOnly?: boolean },
): SubagentRun[] {
  const runs = Object.values(getState().subagentsById).filter(
    (r) => r.parentAgentId === parentAgentId,
  )
  const filtered = opts?.liveOnly
    ? runs.filter((r) => r.status === 'queued' || r.status === 'running')
    : runs
  return filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/** Grok Bot parity: subagents bound to a conversation (side chats). */
export function listSubagentsForConversation(
  conversationId: string,
  opts?: { liveOnly?: boolean },
): SubagentRun[] {
  const runs = Object.values(getState().subagentsById).filter(
    (r) => r.conversationId === conversationId,
  )
  const filtered = opts?.liveOnly
    ? runs.filter((r) => r.status === 'queued' || r.status === 'running')
    : runs
  return filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export function getMessagesForConversation(conversationId: string): ChatMessage[] {
  return getState().messagesByThreadId[conversationId] ?? []
}

export function getConversation(id: string): Conversation | null {
  return getState().conversations.find((c) => c.id === id) ?? null
}

let conversationReadSink: ((conversation: Conversation) => Promise<void>) | null = null

export function setConversationReadSink(sink: typeof conversationReadSink): void {
  conversationReadSink = sink
}

function notifyConversationRead(conv: Conversation): void {
  void conversationReadSink?.(conv).catch(() => {
    // Offline: keep the local read flag. The next selection retries the PATCH.
  })
}

export function selectConversation(conversationId: string): void {
  const conv = getConversation(conversationId)
  if (!conv) return
  notifyConversationRead(conv)
  // NOTE: selection does NOT bump lastUsedAt — grok only re-sorts on send.
  // Opening a thread clears its unread badge: every selection path in both
  // shells funnels through here, so this is the one place that has to know.
  if (conv.hasUnread) {
    setState((prev) => ({
      selectedConversationId: conversationId,
      conversations: prev.conversations.map((c) =>
        c.id === conversationId ? { ...c, hasUnread: false, unreadCount: 0 } : c,
      ),
    }))
    return
  }
  setState({ selectedConversationId: conversationId })
}

/** Bump lastUsedAt so the sidebar re-sorts (grok: runTurn does this). */
export function touchConversation(conversationId: string): void {
  setMetadataState((prev) => ({
    conversations: prev.conversations.map((c) =>
      c.id === conversationId ? { ...c, lastUsedAt: new Date().toISOString() } : c,
    ),
  }))
}

/** Home-list snippet. No-op when unchanged so a poll cannot flicker the row. */
export function setConversationPreview(conversationId: string, preview: string): void {
  const trimmed = preview.replace(/\s+/g, ' ').trim()
  if (!trimmed) return
  const conv = getConversation(conversationId)
  if (!conv || conv.preview === trimmed) return
  setMetadataState((prev) => ({
    conversations: prev.conversations.map((c) =>
      c.id === conversationId ? { ...c, preview: trimmed } : c,
    ),
  }))
}

/** Create a fresh conversation bound to a target (agent or group). Grok parity:
 *  creating a conversation never creates a new agent. */
export function createConversation(target: ThreadRef, title = 'New conversation', options?: { select?: boolean }): Conversation {
  const now = new Date().toISOString()
  const conv: Conversation = {
    id: `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    title,
    target,
    createdAt: now,
    lastUsedAt: now,
  }
  setState((prev) => ({
    conversations: [...prev.conversations, conv],
    messagesByThreadId: {
      ...prev.messagesByThreadId,
      [conv.id]: [
        {
          id: `sys_${Date.now().toString(36)}`,
          threadId: conv.id,
          role: 'system',
          content: `Conversation started.`,
          createdAt: now,
        },
      ],
    },
    selectedConversationId: options?.select === false ? prev.selectedConversationId : conv.id,
  }))
  // The default label is a placeholder: leave the server title empty so the
  // first turn auto-titles it there too.
  conversationSyncSink?.putThread(
    conv.id,
    title === 'New conversation' ? {} : { title, titleSource: 'user' },
  )
  return conv
}

export function deleteConversation(conversationId: string): void {
  const conv = getConversation(conversationId)
  if (!conv) return
  recordDeletedConversation(conv.id, conv.hermesSessionId)
  conversationSyncSink?.deleteThread(conv)
  setState((prev) => {
    const conversations = prev.conversations.filter((c) => c.id !== conversationId)
    const messagesByThreadId = { ...prev.messagesByThreadId }
    delete messagesByThreadId[conversationId]
    let selectedConversationId = prev.selectedConversationId
    if (selectedConversationId === conversationId) {
      selectedConversationId = conversations[0]?.id ?? null
    }
    return { conversations, messagesByThreadId, selectedConversationId }
  })
}

/** Grok Bot parity: Hide from sidebar. Does not delete the thread. */
export function hideConversation(conversationId: string): void {
  const conv = getConversation(conversationId)
  if (!conv) return
  setMetadataState((prev) => {
    const conversations = prev.conversations.map((c) =>
      c.id === conversationId ? { ...c, hiddenFromSidebar: true } : c,
    )
    let selectedConversationId = prev.selectedConversationId
    if (selectedConversationId === conversationId) {
      selectedConversationId =
        conversations.find((c) => !c.hiddenFromSidebar)?.id ?? null
    }
    return { conversations, selectedConversationId }
  })
  conversationSyncSink?.putThread(conversationId, { hidden: true })
}

/** Restore a hidden conversation to the sidebar. */
export function unhideConversation(conversationId: string): void {
  const conv = getConversation(conversationId)
  if (!conv) return
  setMetadataState((prev) => ({
    conversations: prev.conversations.map((c) =>
      c.id === conversationId ? { ...c, hiddenFromSidebar: false } : c,
    ),
  }))
  conversationSyncSink?.putThread(conversationId, { hidden: false })
}

/** Hidden conversations, most recently used first. */
export function listHiddenConversations(): Conversation[] {
  return getState()
    .conversations.filter((c) => c.hiddenFromSidebar)
    .sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1))
}

/** Grok Bot parity: pin/unpin. Pinned rows sort above unpinned. */
export function togglePinConversation(conversationId: string): void {
  const conv = getConversation(conversationId)
  if (!conv) return
  setMetadataState((prev) => ({
    conversations: prev.conversations.map((c) =>
      c.id === conversationId ? { ...c, pinned: !c.pinned } : c,
    ),
  }))
  conversationSyncSink?.putThread(conversationId, { pinned: !conv.pinned })
}

export function markConversationRead(conversationId: string): void {
  const conv = getConversation(conversationId)
  if (!conv) return
  notifyConversationRead(conv)
  setMetadataState((prev) => ({
    conversations: prev.conversations.map((c) =>
      c.id === conversationId ? { ...c, hasUnread: false, unreadCount: 0 } : c,
    ),
  }))
}

export function markConversationUnread(conversationId: string): void {
  const conv = getConversation(conversationId)
  if (!conv) return
  setMetadataState((prev) => ({
    conversations: prev.conversations.map((c) =>
      c.id === conversationId ? { ...c, hasUnread: true } : c,
    ),
  }))
}

/** New thread, same agent target, title suffixed with " copy". Groups are not duplicated. */
export function duplicateConversation(conversationId: string): Conversation | null {
  const conv = getConversation(conversationId)
  if (!conv || conv.target.type !== 'agent') return null
  return createConversation({ type: 'agent', agentId: conv.target.agentId }, `${conv.title} copy`)
}

/** Session ids already claimed by a conversation or a subagent run. */
export function boundHermesSessionIds(): Set<string> {
  const ids = new Set<string>()
  for (const c of getState().conversations) {
    if (c.hermesSessionId) ids.add(c.hermesSessionId)
  }
  for (const r of Object.values(getState().subagentsById)) {
    if (r.hermesSessionId) ids.add(r.hermesSessionId)
  }
  return ids
}

/**
 * Match a Hermes session to a subagent run so hydration can claim it as a
 * side_chat instead of a new sidebar row. Marker in the session title is
 * the reliable path (`[maia-run:<runId>]` prefixed onto the spawn goal).
 */
export function findSubagentRunForSession(
  sessionId: string,
  title?: string,
): SubagentRun | null {
  const runs = Object.values(getState().subagentsById)
  const bySid = runs.find((r) => r.hermesSessionId === sessionId)
  if (bySid) return bySid
  const bySub = runs.find((r) => r.hermesSubagentId === sessionId)
  if (bySub) return bySub
  if (!title) return null
  const byMarker = runs.find(
    (r) => title.includes(`[maia-run:${r.id}]`) || title.includes(r.id),
  )
  if (byMarker) return byMarker
  return null
}

/** True when a first-line reply is an error, not a title. */
export function isUnusableConversationTitle(text: string): boolean {
  const firstLine = text.split('\n')[0]?.trim() ?? ''
  if (!firstLine) return true
  if (/^stream timed out$/i.test(firstLine)) return true
  if (/^Your agent connected but didn't finish a reply/i.test(firstLine)) return true
  if (/^no response body$/i.test(firstLine)) return true
  if (/^\(serve unavailable/i.test(firstLine)) return true
  if (/^api_server \d+/i.test(firstLine)) return true
  if (/^error\b/i.test(firstLine)) return true
  return false
}

/** Auto-title a conversation from the first reply (first line, ≤60 chars). */
export function autoTitleConversation(conversationId: string, fromText: string): void {
  const conv = getConversation(conversationId)
  if (!conv || conv.title !== 'New conversation') return
  if (isUnusableConversationTitle(fromText)) return
  const firstLine = fromText.split('\n')[0]?.trim() ?? ''
  if (!firstLine) return
  const title = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
  setMetadataState((prev) => ({
    conversations: prev.conversations.map((c) =>
      c.id === conversationId ? { ...c, title } : c,
    ),
  }))
  // 'auto' never overwrites a title the user set on another device.
  conversationSyncSink?.putThread(conversationId, { title, titleSource: 'auto' })
}

/** Convenience: pinned first, then most recently used (Grok `Ovn` / `Nke`). */
export function listConversations(): Conversation[] {
  return [...getState().conversations].sort((a, b) => {
    const pin = Number(!!b.pinned) - Number(!!a.pinned)
    if (pin !== 0) return pin
    return a.lastUsedAt < b.lastUsedAt ? 1 : -1
  })
}

export interface AgentProfilePatch {
  name?: string
  /** Persona title — the one-line role, shown under the name. */
  title?: string
  /** Persona description — the bio. */
  description?: string
  /** Mascot customization: orb silhouette shape (Grok Bot parity). */
  avatarShape?: GrokOrbShape | null
  /** Mascot customization: orb body color (Grok Bot parity). */
  avatarColor?: string | null
  /** Mascot customization: orb eye color (Grok Bot parity). */
  avatarEyeColor?: string | null
  /** Grok custom-bot plugins: MCP servers pinned on this specialist. */
  mcpServers?: import('./types').AgentMcpServer[]
  /** Chief of Staff (`orchestrator`) or `specialist`; null clears it back
   *  to the name/title rule. */
  role?: import('./types').AgentRole | null
}

/** Update an agent's editable profile fields (Grok Bot "Edit Profile"). */
export function updateAgent(agentId: string, patch: AgentProfilePatch): Agent | null {
  const prev = getState().agents.find((a) => a.id === agentId)
  if (!prev) return null
  const next: Agent = { ...prev }
  if (patch.name !== undefined) next.name = patch.name
  if (patch.title !== undefined || patch.description !== undefined) {
    next.persona = {
      ...(prev.persona ?? {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
    }
  }
  if (patch.avatarShape !== undefined) {
    next.avatarShape = patch.avatarShape ?? undefined
  }
  if (patch.avatarColor !== undefined) {
    next.avatarColor = patch.avatarColor ?? undefined
  }
  if (patch.avatarEyeColor !== undefined) {
    next.avatarEyeColor = patch.avatarEyeColor ?? undefined
  }
  if (patch.mcpServers !== undefined) {
    next.mcpServers = patch.mcpServers
  }
  if (patch.role !== undefined) {
    next.role = patch.role ?? undefined
  }
  setState((s) => ({
    agents: s.agents.map((a) => (a.id === agentId ? next : a)),
  }))
  return next
}
