/** Local-only, profile-scoped Hermes Desk transport. No hosted or demo fallback. */
import { HermesServeTransport, toolEventFromPayload, toolResultStatus, type HermesServeTransportOptions } from './hermes-transport'
import {
  ServeRpcError,
  type HermesServeClient,
  type ServeEvent, type ServeServerRequest, type ServeToolEvent,
} from '../hermes-serve'
import type { SendMessageOptions, TransportEvent } from './transport'
import type {
  Agent, ChatMessage, Conversation, DeploySkillEntry, NewAgentProfile,
  PendingToolPermission, SubagentKind, SubagentRun, ToolPermissionChoice, Turn,
} from './types'
import {
  acknowledgeLocalMessageStart, appendMessage, appendSubagentMessage, flushMessagePatches, getConversation, getHydrateStatus, getMessagesForConversation,
  getState, patchMessage, setConversationReadSink, setHydrateStatus,
  setLocalSessionBinding, setState, touchConversation, upsertSubagent, upsertTurn,
} from './store'
import type { LocalProfileAgent } from './hermes-profiles'
import {
  agentPromptsFor, answerClarifyWithText, clearAgentPrompt, clearAgentPromptsForConversation, parseClarifyRequest, setAgentPrompt,
  type ClarifyPrompt,
} from './agent-prompts'
import { clearPendingToolPermission, choicesForApprovalRisk, getPendingToolPermission, getPendingToolPermissions, isHighStakesApproval, setPendingToolPermission } from './tool-permission'
import { serveGet } from '../hermes-rest'
import { splitAttachmentNote, withAttachmentNote } from '../attachment-note'
import { submitTextForReply } from '../message-actions'
import { conversationHasLiveDelegates } from '../delegate-apply'
import { isDeletedConversation, recordDeletedConversation } from './tombstones'
import { getTransportPrefs, setTransportPrefs, type LocalTransportPrefs } from './local-transport-prefs'
import { LocalRoomRunner } from './local-room-runner'
import { createRoomRepository } from './local-room-repository'
import { SendError } from './send-outcome'
import { mutateSession } from '../session-mutation'
import { modelOptionsView, modelSwitchValue, sessionModelRoute, type ModelChoice, type ModelOptionsView, type ModelSwitchOutcome } from './session-model'
import { sessionContextSnapshot, type SessionContextSnapshot } from './session-context'
import type { NativeDelegationSnapshot, NativeDelegateTail } from './native-delegation'

import { LocalGatewayConnection, LOCAL_SERVE_OFFLINE as OFFLINE } from './local-gateway-connection'
import { LocalProfiles } from './local-profiles'
import { LocalHistory, localHistoryMessages, type LocalHistoryRow } from './local-history'
import { capGenUiEvents, isGenUiOccurrence, isRenderUiTool, MAX_GENUI_CALLS, validatedGenUiEvents } from '../genui'
const profilePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/

export type { LocalTransportPrefs } from './local-transport-prefs'

export const getLocalTransportPrefs = getTransportPrefs
export const setLocalTransportPrefs = setTransportPrefs

export interface HermesLocalTransportOptions extends HermesServeTransportOptions {
  getPrefs?: () => LocalTransportPrefs
  setPrefs?: (prefs: LocalTransportPrefs) => void | Promise<void>
  showScratch?: boolean
  sources?: readonly string[]
}

/** CONTRACT: shared Conversation/TransportEvent are not owned by this worker. */
export interface LocalConversation extends Conversation {
  agentId: string
  sessionId?: string
  source: string
  lastActivityAt: string
  unread: boolean
}

export type LocalTransportEvent = TransportEvent
  | { type: 'clarify'; conversationId: string; prompt: ClarifyPrompt | null }
  | { type: 'status'; conversationId: string; text: string }
  | { type: 'todo'; conversationId: string; todos: unknown[]; revision: number }
  | { type: 'usage'; conversationId: string; usage: Record<string, unknown> }
  | { type: 'connection'; readOnly: boolean; message: string | null }
  | { type: 'lease'; conversationId: string; held: boolean }

export { localHistoryMessages, type LocalHistoryRow } from './local-history'

export function isSessionLeaseConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message ?? '')
  return /lease|session.*(?:held|owned|in use|another (?:app|process|client))|already active.*(?:app|process)/i.test(message)
}

interface SessionBinding {
  profile: string
  storedId: string
  runtimeId: string
}

interface ReconnectReplay {
  client: HermesServeClient
  generation: number
  epoch: string | null
  events: { event: ServeEvent; current: () => boolean }[]
  promise?: Promise<void>
  overflow: boolean
  histories: Map<string, RecoveredHistory>
}
interface RecoveredHistory {
  binding: SessionBinding
  current: () => boolean
  turnId: string
  occurrences: Map<string, { messageId: string; revision: string }>
}
const MAX_RECONNECT_REPLAY_EVENTS = 4096
const criticalReplayEvent = (event: ServeEvent) =>
  event.type === 'message.complete' || event.type === 'session.closed' || event.type === 'session.reclaimed' ||
  event.type.startsWith('tool.') || event.type === 'request.cancel'

interface SessionResult {
  session_id: string
  stored_session_id?: string | null
  open_requests?: { id: string; method: string; params: Record<string, unknown> }[] | null
  info?: { profile_name?: string; stored_session_id?: string; cwd?: string; model?: string; provider?: string }
}

interface SessionRow {
  id: string
  resolved_id?: string | null
  source?: string
  title?: string
  preview?: string
  started_at?: number
  last_active?: number
  last_activity_at?: number | string
  unread?: boolean
  unread_count?: number
  last_read_at?: number
}

const uid = (prefix: string) => `${prefix}_${globalThis.crypto.randomUUID()}`
const iso = (value: number | string | undefined) => value === undefined ? new Date(0).toISOString()
  : new Date(typeof value === 'number' ? value * 1000 : value).toISOString()

export class HermesLocalTransport extends HermesServeTransport {
  private gateway: LocalGatewayConnection
  private localProfiles: LocalProfiles
  private localHistory: LocalHistory
  private get localClient(): HermesServeClient | null { return this.gateway.client }
  private localOptions: HermesLocalTransportOptions
  private localListeners = new Set<(event: LocalTransportEvent) => void>()
  private bindings = new Map<string, SessionBinding>()
  private helperBindings = new Map<string, SessionBinding>()
  private delegateAuthorities = new WeakMap<SessionBinding, string>()
  private bindingInflight = new Map<string, Promise<SessionBinding>>()
  private watermarks = new Map<string, number>()
  private epoch: string | null = null
  private disposed = false
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private turns = new Map<string, Turn>()
  private rebindAfterEpoch = new Set<string>()
  private uncertainSubmissions = new Set<string>()
  private branchInflight = new Map<string, Promise<Conversation>>()
  private uncertainBranches = new Set<string>()
  private permissions = new Map<string, PendingToolPermission>()
  private requests = new Map<string, ServeServerRequest>()
  private replayContext: ReconnectReplay | null = null
  private replayGeneration = 0
  private conversationReplayVersions = new Map<string, number>()
  private idleProbes = new Map<string, Promise<boolean>>()
  private streamStartSequences = new Map<string, number>()
  private localRooms: LocalRoomRunner

  constructor(options: HermesLocalTransportOptions = {}) {
    super(options)
    this.gateway = new LocalGatewayConnection(options, {
      event: event => this.handleServeEvent(event),
      request: request => this.handleServerRequest(request),
      connection: state => this.connection(state),
      reconnect: () => this.replayOpenSessions(),
    })
    this.localHistory = new LocalHistory({
      bind: conversation => this.bind(conversation),
      request: (method, params) => this.request(method, params),
      capture: conversation => {
        const generation = this.replayGeneration
        const version = this.conversationReplayVersions.get(conversation.id) ?? 0
        const turn = this.turns.get(conversation.id)
        const owner = this.captureReplayOwner(conversation)
        return { key: `${generation}:${version}:${turn?.id ?? ''}:${turn?.phase ?? ''}`, current: () =>
          !this.disposed && this.replayGeneration === generation && owner() }
      },
    })
    this.localOptions = { getPrefs: getTransportPrefs, setPrefs: setTransportPrefs, ...options }
    this.localProfiles = new LocalProfiles({
      request: (method, params) => this.request(method, params),
      emit: event => this.emit(event),
      readOnly: () => this.readOnly,
      prefs: () => this.prefs(),
      setPrefs: prefs => (this.localOptions.setPrefs ?? setLocalTransportPrefs)(prefs),
      showScratch: () => this.localOptions.showScratch,
    })
    this.localRooms = new LocalRoomRunner({
      request: (method, params) => this.request(method, params),
      emit: event => this.emit(event),
      dispatchRequest: request => this.localClient?.dispatchRequest(request),
      clearSessionRequests: (sessionId, conversationId) => {
        for (const [id, request] of this.requests) if (request.params.session_id === sessionId) this.clearServerRequest(id, conversationId)
        for (const prompt of agentPromptsFor(conversationId)) if (prompt.sessionId === sessionId) clearAgentPrompt(prompt.requestId)
        for (const ask of getPendingToolPermissions()) {
          if (ask.conversationId !== conversationId || ask.sessionId !== sessionId) continue
          clearPendingToolPermission(ask.id)
          this.emit({ type: 'permission', conversationId, ask: getPendingToolPermission(conversationId) })
        }
      },
      captureSessionRequests: (sessionIds, conversationId) => {
        const known = new Map([...this.requests].filter(([, request]) =>
          typeof request.params.session_id === 'string' && sessionIds.includes(request.params.session_id)))
        return (open) => {
          if (Array.isArray(open)) {
            const ids = new Set(open.map(r => String(r.id)))
            for (const [id, request] of known) if (this.requests.get(id) === request && !ids.has(id))
              this.clearServerRequest(id, conversationId)
          }
          for (const request of open ?? []) {
            if (this.requests.get(String(request.id)) === known.get(String(request.id))) this.localClient?.dispatchRequest(request)
          }
        }
      },
    }, createRoomRepository())
    setConversationReadSink((conversation) => this.markRead(conversation.id))
  }

  get readOnly(): boolean {
    return this.gateway.readOnly
  }

  configurePrefs(adapters: Pick<HermesLocalTransportOptions, 'getPrefs' | 'setPrefs'>): void {
    this.localOptions = { ...this.localOptions, ...adapters }
  }

  /** Attach an existing stored session without creating an unsent draft. */
  async bindWorkspaceSession(conversation: Conversation): Promise<SessionBinding | null> {
    if (this.readOnly || !conversation.hermesSessionId) return null
    return this.bind(conversation)
  }

  private prefs(): LocalTransportPrefs {
    return (this.localOptions.getPrefs ?? getLocalTransportPrefs)()
  }

  protected override emit(event: TransportEvent): void {
    super.emit(event)
    this.emitLocal(event)
  }

  private emitLocal(event: LocalTransportEvent): void {
    for (const callback of this.localListeners) {
      try { callback(event) } catch { /* isolated UI subscriber */ }
    }
  }

  subscribeLocal(callback: (event: LocalTransportEvent) => void): () => void {
    this.localListeners.add(callback)
    return () => { this.localListeners.delete(callback) }
  }

  private connection(state: 'connecting' | 'online' | 'offline'): void {
    if (state !== 'online') this.retireReplay()
    const readOnly = state !== 'online'
    setHydrateStatus({ serveConnection: state, readOnly, serveError: readOnly ? OFFLINE : null })
    this.emitLocal({ type: 'connection', readOnly, message: readOnly ? OFFLINE : null })
  }

  protected override ensureClient(): Promise<HermesServeClient> {
    return this.gateway.ensureClient()
  }

  async retryConnection(): Promise<void> {
    await this.ensureClient()
  }

  override async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.ensureClient()).request<T>(method, params)
  }

  override async listAgents(): Promise<LocalProfileAgent[]> {
    return this.localProfiles.list()
  }

  override async listConversations(options?: { followLive?: boolean; sources?: readonly string[]; includeCli?: boolean; includeCron?: boolean }): Promise<LocalConversation[]> {
    const agents = await this.listAgents()
    await this.localRooms.recoverAll()
    const sources = new Set(options?.sources ?? this.localOptions.sources ?? this.prefs().sources ?? ['desktop'])
    if (options?.includeCli) sources.add('cli')
    if (options?.includeCron) sources.add('cron')
    const rows: LocalConversation[] = []
    // A profile that fails to list keeps its cached rows (retained below);
    // only when every profile fails does the whole refresh fall back.
    let failedProfiles = 0
    for (const agent of agents) {
      try {
        const profile = agent.hermesProfile!
        const result = await this.request<{ sessions: SessionRow[] }>('session.list', { profile, limit: 50 })
        // CONTRACT: session.list omits activity/read metadata; REST supplies those fields.
        const metadata = await serveGet<{ sessions?: SessionRow[] }>(
          `/api/sessions?profile=${encodeURIComponent(profile)}&limit=50`,
        )
        const details = new Map((metadata?.sessions ?? []).map((row) => [row.id, row]))
        for (const row of result.sessions) {
          if (!sources.has(row.source ?? '') || isDeletedConversation(row.id) ||
            this.localRooms.isInternalSession(profile, row.id)) continue
          const old = getState().conversations.find((conversation) =>
            conversation.target.type === 'agent' && conversation.target.agentId === agent.id &&
            (conversation.hermesSessionId === row.id || (conversation as LocalConversation).sessionId === row.id),
          )
          const detail = { ...row, ...details.get(row.id) }
          const activity = detail.last_activity_at ?? detail.last_active ?? row.started_at
          const unread = detail.unread ?? (detail.unread_count !== undefined ? detail.unread_count > 0
            : detail.last_read_at !== undefined && typeof activity === 'number' ? activity > detail.last_read_at : old?.hasUnread ?? false)
          rows.push({
            ...old,
            id: old?.id ?? `local:${profile}:${row.id}`,
            agentId: agent.id, target: { type: 'agent', agentId: agent.id },
            sessionId: row.id, hermesSessionId: row.resolved_id ?? row.id,
            source: row.source!, title: row.title || row.preview?.slice(0, 60) || 'New conversation',
            preview: row.preview ?? '', createdAt: old?.createdAt ?? iso(row.started_at),
            lastUsedAt: iso(activity), lastActivityAt: iso(activity),
            unread, hasUnread: unread, unreadCount: detail.unread_count ?? (unread ? 1 : 0),
          })
        }
      } catch {
        failedProfiles += 1
      }
    }
    if (agents.length > 0 && failedProfiles === agents.length) {
      setHydrateStatus({ conversationsHydrating: false })
      return this.cachedConversations(sources)
    }
    const visible = new Set(agents.map((agent) => agent.id))
    // Preserve new unsent threads and open transcripts even if the list's 50-row window moved.
    const retained = getState().conversations.filter((conversation) =>
      (conversation.target.type === 'group' || visible.has(conversation.target.agentId)) &&
      !rows.some((row) => row.id === conversation.id),
    )
    const conversations = [...rows, ...retained]
    setState({ conversations })
    const result = this.cachedConversations(sources)
    const unreadAgents = agents.map((agent) => ({
      ...agent,
      unreadCount: result.filter((c) => c.agentId === agent.id).reduce((sum, c) => sum + (c.unreadCount ?? 0), 0),
    }))
    setState({ agents: unreadAgents })
    setHydrateStatus({ conversationsHydrating: false })
    this.emit({ type: 'conversations', conversations: result })
    this.emit({ type: 'agents', agents: unreadAgents })
    return result
  }

  private cachedConversations(sources: Set<string>): LocalConversation[] {
    const visible = new Set(getState().agents.map((agent) => agent.id))
    return getState().conversations.filter((conversation) =>
      (conversation.target.type === 'group' || visible.has(conversation.target.agentId)) &&
      sources.has((conversation as LocalConversation).source ?? 'desktop'),
    ).map((conversation) => ({
      ...conversation,
      agentId: conversation.target.type === 'agent' ? conversation.target.agentId : '',
      sessionId: (conversation as LocalConversation).sessionId ?? conversation.hermesSessionId,
      source: (conversation as LocalConversation).source ?? 'desktop',
      lastActivityAt: (conversation as LocalConversation).lastActivityAt ?? conversation.lastUsedAt,
      unread: conversation.hasUnread ?? false,
    })).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  }

  private updateUnreadAgents(): void {
    const state = getState()
    const agents = state.agents.map((agent) => ({
      ...agent, unreadCount: state.conversations.filter((c) => c.target.type === 'agent' && c.target.agentId === agent.id && c.hasUnread)
        .reduce((sum, c) => sum + (c.unreadCount ?? 1), 0),
    }))
    setState({ agents })
    this.emit({ type: 'agents', agents })
  }

  private profile(conversation: Conversation): string {
    if (conversation.target.type !== 'agent') throw new Error('Local chat requires a profile')
    const agentId = conversation.target.agentId
    const agent = getState().agents.find((a) => a.id === agentId)
    const profile = agent?.hermesProfile ?? agentId.replace(/^profile:/, '')
    if (!agentId.startsWith('profile:') || !profilePattern.test(profile)) throw new Error('Invalid local profile')
    return profile
  }

  private requireConversation(conversationId: string): Conversation {
    const conversation = getConversation(conversationId)
    if (!conversation) throw new Error('Conversation no longer exists')
    return conversation
  }

  private async bind(conversation: Conversation, title?: string): Promise<SessionBinding> {
    conversation = this.requireConversation(conversation.id)
    const known = this.bindings.get(conversation.id)
    if (known && known.profile === this.profile(conversation) && known.storedId === conversation.hermesSessionId) return known
    if (known) this.bindings.delete(conversation.id)
    const pending = this.bindingInflight.get(conversation.id)
    if (pending) return pending
    const attempt = (async () => {
      const profile = this.profile(conversation)
      const client = await this.ensureClient()
      this.requireConversation(conversation.id)
      const generation = this.replayGeneration
      let result: SessionResult
      try {
        result = await client.request<SessionResult>(conversation.hermesSessionId ? 'session.resume' : 'session.create',
        conversation.hermesSessionId
          // CONTRACT: session.resume has no follow_profile_config (the backend always
          // refreshes resumed policy); an unknown key is refused as out of sync.
          ? { session_id: conversation.hermesSessionId, profile, omit_messages: true }
          : { profile, source: 'desktop', follow_profile_config: true, ...(title ? { title: title.slice(0, 60) } : {}) })
      } catch (error) {
        if (conversation.hermesSessionId && isSessionLeaseConflict(error)) this.emitLocal({ type: 'lease', conversationId: conversation.id, held: true })
        throw error
      }
      if (result.info?.profile_name && result.info.profile_name !== profile) throw new Error('Serve resumed the wrong profile')
      const binding = {
        profile, runtimeId: result.session_id,
        storedId: result.stored_session_id ?? result.info?.stored_session_id ?? conversation.hermesSessionId ?? result.session_id,
      }
      const current = getConversation(conversation.id)
      if (this.disposed || generation !== this.replayGeneration || client !== this.localClient ||
          client.connectionState !== 'open' || (current && (this.profile(current) !== profile ||
          (current.hermesSessionId !== conversation.hermesSessionId && current.hermesSessionId !== binding.storedId)))) {
        throw new Error('Session attachment ownership changed')
      }
      if (!getConversation(conversation.id)) {
        // A new session can reveal its stored id only after its chat was deleted.
        if (isDeletedConversation(conversation.id)) recordDeletedConversation(conversation.id, binding.storedId)
        throw new Error('Conversation no longer exists')
      }
      this.emitLocal({ type: 'lease', conversationId: conversation.id, held: false })
      this.bindings.set(conversation.id, binding)
      setLocalSessionBinding(conversation.id, binding)
      this.publishModelRoute(conversation.id, result.info)
      setState((state) => ({
        conversations: state.conversations.map((c) => c.id === conversation.id
          ? { ...c, hermesSessionId: binding.storedId, sessionId: binding.storedId, source: (c as LocalConversation).source ?? 'desktop',
            ...(result.info?.cwd ? { cwd: result.info.cwd } : {}) } : c),
      }))
      for (const request of result.open_requests ?? []) client.dispatchRequest(request)
      return binding
    })()
    this.bindingInflight.set(conversation.id, attempt)
    try { return await attempt } finally {
      if (this.bindingInflight.get(conversation.id) === attempt) this.bindingInflight.delete(conversation.id)
    }
  }

  protected override conversationForSession(sessionId: string): Conversation | null {
    const room = this.localRooms.conversationForSession(sessionId)
    if (room) return room
    const match = [...this.bindings].find(([, binding]) => binding.runtimeId === sessionId || binding.storedId === sessionId)
    return getState().conversations.find((conversation) => conversation.id === match?.[0] ||
      conversation.hermesSessionId === sessionId) ?? null
  }

  override async getMessages(conversationId: string): Promise<ChatMessage[]> {
    if (getConversation(conversationId)?.target.type === 'group') {
      await this.localRooms.recover(conversationId)
      this.localRooms.publish(this.localRooms.get(conversationId))
      return getMessagesForConversation(conversationId)
    }
    return this.localHistory.getMessages(conversationId)
  }

  async loadOlderMessages(conversationId: string): Promise<boolean> {
    return this.localHistory.loadOlderMessages(conversationId)
  }

  override async sendMessage(conversation: Conversation, text: string, options?: SendMessageOptions): Promise<{ turnId: string }> {
    try { return await this.sendLocalMessage(conversation, text, options) }
    catch (error) { throw error instanceof SendError ? error : new SendError('rejected', error) }
  }

  private async sendLocalMessage(conversation: Conversation, text: string, options?: SendMessageOptions): Promise<{ turnId: string }> {
    const client = await this.ensureClient() // Offline sends must not fabricate a successful reply.
    if (this.requireConversation(conversation.id).target.type === 'group') return this.localRooms.send(conversation, text, options)
    if (this.uncertainSubmissions.has(conversation.id)) throw new SendError('uncertain')
    const binding = await this.bind(this.requireConversation(conversation.id), text)
    this.requireConversation(conversation.id)
    flushMessagePatches()
    let userMessageId = options?.echoId ?? ''
    if (options?.echoUser !== false) {
      const message: ChatMessage = {
        id: uid('usr'), threadId: conversation.id, role: 'user', content: text,
        createdAt: new Date().toISOString(), replyTo: options?.replyTo,
        attachments: options?.attachments?.map((attachment) => ({ id: uid('att'), ...attachment })),
      }
      userMessageId = message.id
      appendMessage(conversation.id, message)
      this.emit({ type: 'message', conversationId: conversation.id, message })
    }
    const streaming = getMessagesForConversation(conversation.id).findLast((m) => m.streaming)
    if (streaming) {
      const previousTurn = this.turns.get(conversation.id)
      if ((userMessageId && await answerClarifyWithText(conversation.id, text)) ||
          await this.steer(conversation.id, withAttachmentNote(text, (options?.attachments ?? []).map((a) => a.path)))) {
        return { turnId: this.turns.get(conversation.id)?.id ?? uid('turn') }
      }
      this.requireConversation(conversation.id)
      flushMessagePatches()
      const current = getMessagesForConversation(conversation.id).findLast((m) => m.streaming)
      if (current && (current.id !== streaming.id || this.turns.get(conversation.id) !== previousTurn)) {
        throw new Error('The reply changed before Hermes accepted this message. Try sending again.')
      }
      // An idle backend rejects steering. Do not acknowledge text it never accepted,
      // or let its abandoned tool flags block the next real prompt.
      if (current) this.handleServeEvent({
        type: 'message.complete', session_id: binding.runtimeId,
        payload: { status: 'error', text: current.content, error: 'Hermes is no longer running this reply. You can retry it.' },
      })
    }
    const reply = this.startReply(conversation)
    const turn: Turn = {
      id: uid('turn'), threadId: conversation.id, agentId: `profile:${binding.profile}`,
      userMessageId, phase: 'acked', subagentRunIds: [], startedAt: new Date().toISOString(),
    }
    this.conversationReplayVersions.set(conversation.id, (this.conversationReplayVersions.get(conversation.id) ?? 0) + 1)
    this.turns.set(conversation.id, turn)
    patchMessage(conversation.id, reply.id, { turnId: turn.id })
    upsertTurn(turn)
    this.emit({ type: 'turn', turn })
    try {
      const modelText = submitTextForReply(withAttachmentNote(text, (options?.attachments ?? []).map((a) => a.path)), options?.replyTo)
      await client.request('prompt.submit', { session_id: binding.runtimeId, profile: binding.profile, text: modelText, surface: 'desktop' })
      touchConversation(conversation.id)
      this.armStreamWatch(conversation.id, reply.id, binding.runtimeId)
      return { turnId: turn.id }
    } catch (error) {
      const rejected = error instanceof ServeRpcError || (error instanceof Error && error.message === 'gateway not connected')
      if (!rejected) this.uncertainSubmissions.add(conversation.id)
      patchMessage(conversation.id, reply.id, { streaming: false, error: true, content: 'Hermes could not submit this message. Retry when serve is available.' })
      this.streamingByConversation.delete(conversation.id)
      this.streamStartSequences.delete(conversation.id)
      this.updateTurn(conversation, 'failed')
      throw new SendError(rejected ? 'rejected' : 'uncertain', error)
    }
  }

  private startReply(conversation: Conversation): ChatMessage {
    const existing = getMessagesForConversation(conversation.id).findLast((m) => m.role === 'agent' && m.streaming)
    if (existing) return existing
    const message: ChatMessage = {
      id: uid('msg'), threadId: conversation.id, role: 'agent', fromAgentId: this.profileAgentId(conversation),
      content: '', createdAt: new Date().toISOString(), streaming: true, toolEvents: [],
    }
    this.streamingByConversation.set(conversation.id, true)
    const binding = this.bindings.get(conversation.id)
    this.streamStartSequences.set(conversation.id, binding ? this.watermarks.get(binding.runtimeId) ?? 0 : 0)
    appendMessage(conversation.id, message)
    this.emit({ type: 'message', conversationId: conversation.id, message })
    return message
  }

  private profileAgentId(conversation: Conversation): string {
    return conversation.target.type === 'agent' ? conversation.target.agentId : ''
  }

  private updateTurn(conversation: Conversation, phase: Turn['phase']): void {
    const previous = this.turns.get(conversation.id)
    // Every streamed delta reports 'working': re-committing an identical turn
    // would make each token a structural store change and re-render the shell.
    if (phase === 'working' && previous?.phase === 'working' && previous.threadId === conversation.id &&
      previous.agentId === this.profileAgentId(conversation)) return
    const turn: Turn = {
      id: previous?.id ?? uid('turn'), threadId: conversation.id, agentId: this.profileAgentId(conversation),
      userMessageId: previous?.userMessageId ?? '', subagentRunIds: previous?.subagentRunIds ?? [],
      startedAt: previous?.startedAt ?? new Date().toISOString(), phase,
      ...(['done', 'failed'].includes(phase) ? { finishedAt: new Date().toISOString() } : {}),
    }
    this.turns.set(conversation.id, turn)
    upsertTurn(turn)
    this.emit({ type: 'turn', turn })
  }

  private sessionState(conversationId: string, patch: Partial<import('./store').LocalSessionState>): void {
    const sessions = getHydrateStatus().localSessions
    setHydrateStatus({ localSessions: { ...sessions, [conversationId]: { ...sessions[conversationId], ...patch } } })
  }

  protected override onStreamWatchFire(conversationId: string): void {
    if (!getConversation(conversationId) || !this.streamingByConversation.has(conversationId)) {
      this.clearStreamWatch(conversationId)
      this.streamingByConversation.delete(conversationId)
      this.streamStartSequences.delete(conversationId)
      return
    }
    if (this.hasPermission(conversationId) ||
        agentPromptsFor(conversationId).length > 0 || conversationHasLiveDelegates(conversationId)) {
      this.holdStreamWatch(conversationId)
      return
    }
    if (this.idleProbes.has(conversationId)) return
    const probe = this.recoverCompletedStream(conversationId)
    this.idleProbes.set(conversationId, probe)
    void probe.then((handled) => {
      if (this.idleProbes.get(conversationId) !== probe) return
      this.idleProbes.delete(conversationId)
      if (this.disposed) return
      if (!getConversation(conversationId)) {
        this.clearStreamWatch(conversationId)
        this.streamingByConversation.delete(conversationId)
        this.streamStartSequences.delete(conversationId)
      } else if (handled) this.holdStreamWatch(conversationId)
      else super.onStreamWatchFire(conversationId)
    })
  }

  private async recoverCompletedStream(conversationId: string): Promise<boolean> {
    const binding = this.bindings.get(conversationId)
    const client = this.localClient
    const turn = this.turns.get(conversationId)
    const reply = getMessagesForConversation(conversationId).findLast((m) => m.streaming)
    if (!binding || !client || !reply) return false
    const userMessageId = getMessagesForConversation(conversationId).findLast((m) => m.role === 'user')?.id
    const lastSeen = this.watermarks.get(binding.runtimeId) ?? 0
    const epoch = this.epoch
    const current = () => !this.disposed && getConversation(conversationId) &&
      this.bindings.get(conversationId) === binding && client.connectionState === 'open' &&
      this.turns.get(conversationId) === turn && this.epoch === epoch &&
      !this.hasPermission(conversationId) &&
      agentPromptsFor(conversationId).length === 0 && !conversationHasLiveDelegates(conversationId) &&
      getMessagesForConversation(conversationId).findLast((m) => m.role === 'user')?.id === userMessageId &&
      (this.watermarks.get(binding.runtimeId) ?? 0) === lastSeen &&
      getMessagesForConversation(conversationId).some((m) => m.id === reply.id && m.streaming)
    try {
      const live = await client.request<{ sessions?: { id: string; status: string }[] }>(
        'session.active_list', { profile: binding.profile }, 5000,
      )
      if (!current()) return true
      const status = Array.isArray(live.sessions) ? live.sessions.find((s) => s.id === binding.runtimeId)?.status : undefined
      // Backend liveness is authoritative even when no renderer updates arrive.
      if (status === 'working' || status === 'starting' || status === 'waiting') return true
      if (status !== 'idle') return false
      const replay = await client.request<{
        events?: ServeEvent[]; epoch?: string; open_requests?: unknown[] | null
      }>('session.events.since', {
        session_id: binding.runtimeId, profile: binding.profile,
        last_seen: Math.min(this.streamStartSequences.get(conversationId) ?? lastSeen, lastSeen),
      }, 5000)
      if (!current()) return true
      if (!Array.isArray(replay.events) || (epoch && replay.epoch !== epoch)) return false
      if (replay.open_requests?.length) return true
      const start = this.streamStartSequences.get(conversationId) ?? lastSeen
      const terminal = replay.events.findLast((event) => event.type === 'message.complete' &&
        event.session_id === binding.runtimeId && typeof event.seq === 'number' && event.seq > Math.min(start, lastSeen))
      if (terminal) {
        // A later usage/info frame can advance the live watermark past a lost completion.
        // The reply/turn/epoch guards above own this terminal, not the global live cursor.
        this.handleServeEvent({ ...terminal, seq: undefined }, true)
        this.watermarks.set(binding.runtimeId, Math.max(lastSeen, terminal.seq!))
      } else this.settleHungStream(conversationId)
      return true
    } catch {
      // Older/offline backends retain the existing watchdog and human/tool safeguards.
      return !current()
    }
  }

  protected override async interruptStreamWatch(conversationId: string, sessionId: string): Promise<void> {
    const profile = this.bindings.get(conversationId)?.profile
    if (!profile) return
    await this.request('session.interrupt', { session_id: sessionId, profile })
  }

  protected override settleHungStream(conversationId: string): void {
    if (!this.streamingByConversation.has(conversationId)) return
    this.conversationReplayVersions.set(conversationId, (this.conversationReplayVersions.get(conversationId) ?? 0) + 1)
    super.settleHungStream(conversationId)
    this.streamStartSequences.delete(conversationId)
    const conversation = getState().conversations.find((row) => row.id === conversationId)
    if (conversation) this.updateTurn(conversation, 'failed')
    this.sessionState(conversationId, { status: '' })
    this.emitLocal({ type: 'status', conversationId, text: '' })
  }

  protected override handleServeEvent(event: ServeEvent, fromReplay = false, history?: RecoveredHistory): void {
    if (event.type === 'gateway.ready') {
      const epoch = (event.payload as { replay_epoch?: string })?.replay_epoch
      const changed = !!epoch && !!this.epoch && this.epoch !== epoch
      // onState(open) can start recovery before the first gateway.ready.
      // With no previous epoch authority, adopt that socket's first epoch;
      // replacements of an established epoch must retire the entire context.
      if (epoch && !this.epoch && this.replayContext?.generation === this.replayGeneration &&
          this.replayContext.client === this.localClient) this.replayContext.epoch = epoch
      if (epoch) this.epoch = epoch
      if (changed) {
        this.retireReplay()
        for (const [id, request] of this.requests) {
          const owner = this.conversationForSession(String(request.params.session_id ?? ''))
          this.clearServerRequest(id, owner?.id ?? '')
        }
        this.watermarks.clear()
        // Chats used this run rebind on the new serve; cached-only chats bind when opened.
        for (const id of this.bindings.keys()) this.rebindAfterEpoch.add(id)
        this.bindings.clear()
        this.helperBindings.clear()
        // A restarted serve has no record of an unacknowledged submit: its
        // replay can no longer settle it, so the guard would never lift.
        this.uncertainSubmissions.clear()
      }
      if (epoch) this.localRooms.setEpoch(epoch)
      if (changed) void this.replayOpenSessions().catch(() => {})
      void this.localClient?.request('client.capabilities', { server_requests: true }).catch(() => {})
      return
    }
    const replay = this.replayContext
    if (!fromReplay && replay && this.replayCurrent(replay) && event.session_id) {
      const conversation = this.conversationForSession(event.session_id)
      if (!conversation) return
      if (replay.events.length >= MAX_RECONNECT_REPLAY_EVENTS) {
        const removable = replay.events.findIndex(item => !criticalReplayEvent(item.event))
        if (removable < 0) { replay.overflow = true; return }
        replay.events.splice(removable, 1)
      }
      let current = this.captureReplayOwner(conversation)
      if (event.type === 'request.cancel') {
        const id = String((event.payload as { id?: unknown })?.id ?? '')
        const request = this.requests.get(id)
        // Stop retires output, not withdrawal of the same still-live question.
        // Reused request ids cannot cancel a replacement request object.
        current = () => !!request && this.requests.get(id) === request &&
          request.params.session_id === event.session_id &&
          this.conversationForSession(String(event.session_id))?.id === conversation.id
      }
      replay.events.push({ event, current })
      return
    }
    if (this.localRooms.handleEvent(event)) return
    if (event.session_id && typeof event.seq === 'number') {
      if (event.seq <= (this.watermarks.get(event.session_id) ?? 0)) return
      this.watermarks.set(event.session_id, event.seq)
    }
    if (event.type.startsWith('browser.controller.')) return // Main owns the lane executor.
    if (event.type === 'sessions.changed') {
      if (this.refreshTimer) clearTimeout(this.refreshTimer)
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null
        void this.listConversations()
      }, 500)
      return
    }
    if (event.type === 'request.cancel') {
      const id = (event.payload as { id?: string })?.id
      if (id) this.clearServerRequest(id, event.session_id ? this.conversationForSession(event.session_id)?.id ?? '' : '')
      return
    }
    if (event.type === 'approval.request' || event.type === 'clarify.request' ||
      event.type === 'secret.request' || event.type === 'sudo.request') {
      this.handleLegacyRequest(event)
      return
    }
    const conversation = event.session_id ? this.conversationForSession(event.session_id) : null
    if (!conversation) { super.handleServeEvent(event); return }
    const previousTurn = this.turns.get(conversation.id)
    const settledFailure = previousTurn?.phase === 'failed' && !this.streamingByConversation.has(conversation.id)
    // Cancellation can emit one last thinking/status frame after the timeout has settled.
    if (settledFailure && (event.type === 'message.delta' || event.type === 'message.interim' ||
      event.type === 'reasoning.delta' || event.type === 'thinking.delta' ||
      event.type === 'status.update' || event.type === 'todo.updated' || event.type.startsWith('tool.'))) return
    this.bumpStreamWatch(conversation.id)
    if (event.type === 'message.start') acknowledgeLocalMessageStart(conversation.id)
    const payload = (event.payload ?? {}) as Record<string, unknown>
    if (history && event.type.startsWith('tool.') && this.mergeRecoveredGenUi(conversation, event, history)) return
    if (event.type === 'session.info') {
      const binding = this.bindings.get(conversation.id)
      if (binding && binding.runtimeId === event.session_id &&
          (!payload.profile_name || payload.profile_name === binding.profile)) {
        this.publishModelRoute(conversation.id, payload)
      }
      super.handleServeEvent(event)
      return
    }
    if (event.type === 'message.start' || event.type === 'message.delta' ||
      event.type === 'message.interim' || event.type === 'reasoning.delta' || event.type === 'thinking.delta') {
      const reply = this.startReply(conversation)
      if (event.type !== 'message.start' && typeof payload.text === 'string') {
        flushMessagePatches()
        const current = getMessagesForConversation(conversation.id).find((m) => m.id === reply.id)!
        if (event.type === 'reasoning.delta' || event.type === 'thinking.delta') {
          patchMessage(conversation.id, reply.id, { reasoning: (current.reasoning ?? '') + payload.text })
        } else if (event.type !== 'message.interim' || payload.already_streamed !== true) {
          patchMessage(conversation.id, reply.id, { content: current.content + payload.text })
        }
        flushMessagePatches()
        this.emit({ type: 'message', conversationId: conversation.id, message: getMessagesForConversation(conversation.id).find((m) => m.id === reply.id)! })
      }
      this.updateTurn(conversation, 'working')
      return
    }
    if (event.type === 'message.complete') {
      this.uncertainSubmissions.delete(conversation.id)
      flushMessagePatches()
      const turnId = previousTurn?.id
      const reply = getMessagesForConversation(conversation.id).findLast((message) =>
        message.role === 'agent' && (message.streaming || (turnId && message.turnId === turnId))) ??
        this.startReply(conversation)
      const failed = payload.status === 'error' || payload.status === 'interrupted' ||
        (typeof payload.error === 'string' && !!payload.error.trim())
      const failure = typeof payload.error === 'string' && payload.error.trim()
        ? payload.error : payload.status === 'interrupted'
          ? 'This reply was interrupted before it finished.' : 'Hermes could not finish this reply.'
      const content = settledFailure && failed ? reply.content :
        typeof payload.text === 'string' && payload.text ? payload.text : reply.content || (failed ? failure : '')
      patchMessage(conversation.id, reply.id, {
        content, streaming: false, error: Boolean(failed),
        errorNote: failed ? settledFailure ? reply.errorNote :
          reply.errorNote ?? (content !== failure ? failure : undefined) : undefined,
        ...(typeof payload.reasoning === 'string' ? { reasoning: payload.reasoning } : {}),
        toolEvents: reply.toolEvents?.map((tool) => tool.status === 'running'
          ? { ...tool, status: failed ? 'failed' : 'completed' } : tool),
      })
      this.streamingByConversation.delete(conversation.id)
      this.streamStartSequences.delete(conversation.id)
      this.clearStreamWatch(conversation.id)
      clearAgentPromptsForConversation(conversation.id)
      this.emitLocal({ type: 'clarify', conversationId: conversation.id, prompt: null })
      this.emit({ type: 'message', conversationId: conversation.id, message: getMessagesForConversation(conversation.id).find((m) => m.id === reply.id)! })
      this.updateTurn(conversation, failed ? 'failed' : 'done')
      const finished = getMessagesForConversation(conversation.id).find((m) => m.id === reply.id)!
      this.sessionState(conversation.id, { status: '' })
      const unread = getState().selectedConversationId !== conversation.id
      const at = new Date().toISOString()
      setState((state) => ({
        conversations: state.conversations.map((c) => c.id === conversation.id
          ? { ...c, preview: finished.content.replace(/\s+/g, ' ').slice(0, 160),
            lastUsedAt: at, lastActivityAt: at, hasUnread: unread, unread,
            unreadCount: unread ? (c.unreadCount ?? 0) + 1 : 0 } : c),
      }))
      this.emit({ type: 'conversations', conversations: getState().conversations })
      this.updateUnreadAgents()
      if (payload.usage && typeof payload.usage === 'object') this.publishUsage(conversation.id, payload.usage as Record<string, unknown>)
      return
    }
    if (event.type === 'status.update') {
      const text = typeof payload.text === 'string' ? payload.text : ''
      this.sessionState(conversation.id, { status: text })
      this.emitLocal({ type: 'status', conversationId: conversation.id, text })
      this.updateTurn(conversation, 'working')
      return
    }
    if (event.type === 'todo.updated') {
      const todos = Array.isArray(payload.todos) ? payload.todos : []
      const revision = typeof payload.revision === 'number' ? payload.revision : 0
      this.sessionState(conversation.id, { todos, todoRevision: revision })
      this.emitLocal({ type: 'todo', conversationId: conversation.id, todos, revision })
      this.updateTurn(conversation, 'working')
      return
    }
    if (event.type === 'session.usage') {
      this.publishUsage(conversation.id, (payload.usage ?? payload) as Record<string, unknown>)
      return
    }
    if (event.type === 'session.title' && typeof payload.title === 'string') {
      setState((state) => ({ conversations: state.conversations.map((c) => c.id === conversation.id ? { ...c, title: payload.title as string } : c) }))
      this.emit({ type: 'conversations', conversations: getState().conversations })
      return
    }
    if (event.type.startsWith('tool.')) {
      const reply = this.startReply(conversation)
      if (event.type === 'tool.start') {
        patchMessage(conversation.id, reply.id, {
          toolEvents: (reply.toolEvents ?? []).filter((tool) => tool.toolCallId !== `generating:${payload.name}`),
        })
        flushMessagePatches()
      }
      super.handleServeEvent(event.type === 'tool.generating'
        ? { ...event, type: 'tool.start', payload: { ...payload, tool_id: `generating:${payload.name}` } as unknown as ServeToolEvent } : event)
      flushMessagePatches()
      const message = getMessagesForConversation(conversation.id).findLast((m) => m.streaming)
      if (message) this.emit({ type: 'message', conversationId: conversation.id, message })
      this.updateTurn(conversation, 'working')
      return
    }
    super.handleServeEvent(event)
  }

  private publishUsage(conversationId: string, usage: Record<string, unknown>): void {
    const merged = { ...getHydrateStatus().localSessions[conversationId]?.usage, ...usage }
    this.sessionState(conversationId, { usage: merged })
    this.emitLocal({ type: 'usage', conversationId, usage: merged })
  }

  private publishModelRoute(conversationId: string, info: unknown): void {
    const modelRoute = sessionModelRoute(info)
    const previous = getHydrateStatus().localSessions[conversationId]?.modelRoute
    if (modelRoute && (modelRoute.model !== previous?.model || modelRoute.provider !== previous?.provider)) {
      this.sessionState(conversationId, { modelRoute })
    }
  }

  /** Native attachments need a bound renderer session, including an unsent draft. */
  async attachmentSession(conversation: Conversation): Promise<SessionBinding> {
    if (conversation.target.type === 'group') return this.localRooms.attachmentSession(conversation.id)
    return this.bind(conversation)
  }

  async inspectSessionContext(conversationId: string): Promise<SessionContextSnapshot> {
    const conversation = this.requireConversation(conversationId)
    if (conversation.target.type !== 'agent') throw new Error('Inspect an individual chat, not a shared room.')
    if (!conversation.hermesSessionId) throw new Error('Send a message before inspecting context.')
    // Reattach through the native lease, never create a substitute or steal ownership.
    const binding = await this.bind(conversation)
    const result = await this.request('session.context_breakdown', { profile: binding.profile, session_id: binding.runtimeId })
    return sessionContextSnapshot(result)
  }
  /** Models Hermes offers this chat's profile; uses the live session when one is bound. */
  async modelOptions(conversationId: string): Promise<ModelOptionsView> {
    const conversation = this.requireConversation(conversationId)
    if (conversation.target.type !== 'agent') throw new Error('Change the model in an individual chat, not a shared room.')
    const binding = this.bindings.get(conversationId)
    const result = await this.request('model.options', binding
      ? { profile: binding.profile, session_id: binding.runtimeId }
      : { profile: this.profile(conversation) })
    return modelOptionsView(result)
  }

  /** Switches this chat's model; `global` also makes it the profile default (main asks first). */
  async switchModel(conversationId: string, choice: ModelChoice): Promise<ModelSwitchOutcome> {
    const conversation = this.requireConversation(conversationId)
    if (conversation.target.type !== 'agent') throw new Error('Change the model in an individual chat, not a shared room.')
    const value = modelSwitchValue(choice)
    if (!value) throw new Error('Choose a model and provider from the list.')
    // config.set model needs a live session; an unsent draft gets one, as attachments do.
    const binding = await this.bind(conversation)
    const result = await this.request<Record<string, unknown>>('config.set', {
      profile: binding.profile, session_id: binding.runtimeId, key: 'model', value,
      ...(choice.confirmExpensive ? { confirm_expensive_model: true } : {}),
    })
    if (this.bindings.get(conversationId) !== binding) throw new Error('The chat connection changed. Choose the model again.')
    if (result?.confirm_required === true) {
      return { status: 'confirm', message: typeof result.confirm_message === 'string' && result.confirm_message
        ? result.confirm_message.slice(0, 1000) : 'This model may cost more. Switch anyway?' }
    }
    const warning = typeof result?.warning === 'string' && result.warning ? result.warning.slice(0, 1000) : undefined
    if (result?.deferred === true) return { status: 'deferred', scope: choice.scope, warning }
    this.sessionState(conversationId, { modelRoute: { model: choice.model, provider: choice.provider } })
    return { status: 'switched', scope: choice.scope, warning }
  }

  async inspectDelegates(conversationId: string): Promise<NativeDelegationSnapshot> {
    const conversation = this.requireConversation(conversationId)
    if (conversation.target.type !== 'agent' || !conversation.hermesSessionId)
      throw new Error('Inspect delegation in an existing individual chat.')
    const binding = await this.bind(conversation)
    if (!this.delegateAuthorities.has(binding)) this.delegateAuthorities.set(binding, uid('delegate_owner'))
    const data = await this.delegateRequest<Omit<NativeDelegationSnapshot, 'generation'>>(conversationId, binding, 'subagent.list')
    return { ...data, generation: this.delegateAuthorities.get(binding)! }
  }
  private async delegateRequest<T>(conversationId: string, binding: SessionBinding, method: string,
    params: Record<string, unknown> = {}): Promise<T> {
    const result = await this.request<T>(method, { ...params, profile: binding.profile, session_id: binding.runtimeId })
    if (this.bindings.get(conversationId) !== binding || !getConversation(conversationId))
      throw new Error('The chat connection changed. Inspect tasks again.')
    return result
  }
  private delegateBinding(conversationId: string, generation?: string): SessionBinding {
    this.requireConversation(conversationId)
    const binding = this.bindings.get(conversationId)
    if (!binding || this.readOnly || (generation !== undefined && this.delegateAuthorities.get(binding) !== generation))
      throw new Error('Inspect tasks on the current connection before controlling them.')
    return binding
  }
  async inspectDelegateTail(conversationId: string, id: string, generation?: string): Promise<NativeDelegateTail> {
    return this.delegateRequest(conversationId, this.delegateBinding(conversationId, generation), 'subagent.tail', { subagent_id: id })
  }
  async steerDelegate(conversationId: string, id: string, text: string, generation?: string): Promise<boolean> {
    const clean = text.trim()
    if (!clean || clean.length > 16384) return false
    const result = await this.delegateRequest<{ status: string }>(conversationId, this.delegateBinding(conversationId, generation),
      'subagent.steer', { subagent_id: id, text: clean })
    return result.status === 'queued'
  }
  async interruptDelegate(conversationId: string, id: string, generation?: string): Promise<boolean> {
    const result = await this.delegateRequest<{ found: boolean }>(conversationId, this.delegateBinding(conversationId, generation),
      'subagent.interrupt', { subagent_id: id })
    return result.found === true
  }
  protected override async delegationSnapshot(conversationId: string) {
    const data = await this.inspectDelegates(conversationId)
    return { active: data.subagents, completionFromAbsence: false }
  }
  override async cancelSubagent(runId: string): Promise<boolean> {
    const run = getState().subagentsById[runId]
    if (!run?.conversationId || this.readOnly) return false
    if (run.hermesSubagentId) {
      try { return await this.interruptDelegate(run.conversationId, run.hermesSubagentId) }
      catch { return false }
    }
    // Desk helpers are owned sessions, not delegate_task children. Never guess their profile after a restart.
    const binding = this.helperBindings.get(runId)
    if (!binding || run.source !== 'spawn') return false
    try {
      await this.request('session.interrupt', { profile: binding.profile, session_id: binding.runtimeId })
      return true
    } catch { return false }
  }
  override async messageSubagent(runId: string, text: string): Promise<boolean> {
    const run = getState().subagentsById[runId]
    const clean = text.trim()
    if (!run?.conversationId || !clean || this.readOnly) return false
    if (run.hermesSubagentId) {
      if (run.status !== 'running' && run.status !== 'queued') return false
      try { return await this.steerDelegate(run.conversationId, run.hermesSubagentId, clean) }
      catch { return false }
    }
    const binding = this.helperBindings.get(runId)
    if (!binding || run.source !== 'spawn') return false
    try {
      await this.request('prompt.submit', { profile: binding.profile, session_id: binding.runtimeId, text: clean, surface: 'desktop' })
      return true
    } catch { return false }
  }

  async branchConversation(conversationId: string, message?: ChatMessage): Promise<Conversation> {
    const pending = this.branchInflight.get(conversationId)
    if (pending) return pending
    if (this.uncertainBranches.has(conversationId))
      throw new Error('The branch acknowledgment was lost. Check Chats for the child before trying another branch.')
    const operation = this.createBranch(conversationId, message)
    this.branchInflight.set(conversationId, operation)
    try { return await operation }
    finally { if (this.branchInflight.get(conversationId) === operation) this.branchInflight.delete(conversationId) }
  }

  private async createBranch(conversationId: string, message?: ChatMessage): Promise<Conversation> {
    const parent = getState().conversations.find(c => c.id === conversationId)
    if (!parent?.hermesSessionId) throw new Error('Send a message before branching.')
    if (parent.target.type !== 'agent') throw new Error('Branch an individual agent chat, not a shared room.')
    if (getMessagesForConversation(conversationId).some(row => row.streaming || row.pending))
      throw new Error('Wait for this reply to finish before branching.')
    const profile = this.profile(parent)
    let binding: SessionBinding | undefined
    try { binding = await this.bind(parent) }
    catch (error) { if (!isSessionLeaseConflict(error)) throw error }
    let count: number | undefined
    if (!binding && message) throw new Error('This chat is held by another client. Use Branch here to copy the whole stored chat.')
    if (binding && message) {
      const history = await this.request<{ messages: LocalHistoryRow[] }>('session.history', {
        session_id: binding.runtimeId, profile,
      })
      // Live rows acquire durable ids on refresh. Match by content only when unambiguous.
      // Hermes branches its user/assistant display projection, not tool rows.
      const rows = history.messages.filter(row => ['user', 'assistant'].includes(row.role) &&
        typeof (row.text ?? row.content) === 'string' && String(row.text ?? row.content).trim())
      const matches = rows.map((row, index) => ({ row, index })).filter(({ row }) =>
        message.hermesRowId !== undefined ? (row.row_id ?? row.id) === message.hermesRowId
          : (row.role === (message.role === 'user' ? 'user' : 'assistant') && (row.text ?? row.content) === message.content))
      if (matches.length !== 1) throw new Error('Refresh this chat before branching from this message.')
      count = matches[0]!.index + 1
    }
    // CONTRACT: branch_stored is the upstream lease-safe route. No forced resume or lease theft.
    let result: SessionResult & { title?: string; messages?: LocalHistoryRow[] }
    try {
      result = await this.request(
        binding ? 'session.branch' : 'session.branch_stored',
        binding ? { session_id: binding.runtimeId, profile, idempotency_key: uid('branch'), ...(count ? { count } : {}) }
          : { parent_session_id: parent.hermesSessionId, profile, source: 'desktop', idempotency_key: uid('branch') },
      )
    } catch (error) {
      // Never replay a possibly accepted mutation, especially after backend restart.
      if (!(error instanceof ServeRpcError)) {
        this.uncertainBranches.add(conversationId)
        throw new Error('The branch acknowledgment was lost. Check Chats for the child before trying another branch.')
      }
      throw error
    }
    if (!result.session_id || !result.stored_session_id || (result.info?.profile_name && result.info.profile_name !== profile)) {
      throw new Error('Hermes did not return a valid branch.')
    }
    const at = new Date().toISOString()
    const conversation: LocalConversation = {
      id: `local:${profile}:${result.stored_session_id}`, agentId: this.profileAgentId(parent),
      target: parent.target, hermesSessionId: result.stored_session_id, sessionId: result.stored_session_id,
      title: result.title ?? `${parent.title} (branch)`, createdAt: at, lastUsedAt: at, lastActivityAt: at,
      source: 'desktop', unread: false, cwd: result.info?.cwd ?? parent.cwd,
    }
    const nextBinding = { profile, runtimeId: result.session_id, storedId: result.stored_session_id }
    this.bindings.set(conversation.id, nextBinding)
    setState(state => ({ conversations: [...state.conversations.filter(row => row.id !== conversation.id), conversation],
      messagesByThreadId: { ...state.messagesByThreadId,
        [conversation.id]: localHistoryMessages(result.stored_session_id!, conversation.id, profile, result.messages ?? []) } }))
    setLocalSessionBinding(conversation.id, nextBinding)
    this.publishModelRoute(conversation.id, result.info)
    this.emit({ type: 'conversations', conversations: getState().conversations })
    return conversation
  }

  private clearServerRequest(id: string, conversationId: string): void {
    clearAgentPrompt(id)
    this.requests.delete(id)
    this.emitLocal({ type: 'clarify', conversationId, prompt: null })
    for (const [key, permission] of this.permissions) {
      if (permission.id !== id) continue
      this.permissions.delete(key)
      clearPendingToolPermission(id)
      this.emit({ type: 'permission', conversationId: permission.conversationId, ask: null })
    }
  }

  private hasPermission(conversationId: string): boolean {
    return [...this.permissions.values()].some(ask => ask.conversationId === conversationId)
  }

  private handleServerRequest(request: ServeServerRequest): void {
    if (request.method === 'secret' || request.method === 'sudo') {
      // TODO(wave 2): main's secure-prompt handler must intercept on this same socket.
      this.localClient?.respondError(request.id, -32001, 'Secure prompts are handled by the main process; renderer access denied')
      return
    }
    const sessionId = request.params.session_id
    const conversation = typeof sessionId === 'string' ? this.conversationForSession(sessionId) : null
    if (!conversation) { this.localClient?.respondError(request.id, -32000, 'Session is not open in Hermes Desk'); return }
    if (conversation.target.type === 'group' && !this.localRooms.sessionAcceptsRequests(String(sessionId))) {
      this.localClient?.respondError(request.id, -32000, 'Room member turn is no longer active')
      return
    }
    const member = this.localRooms.memberForSession(String(sessionId))
    const owner = member ? { memberId: member.id, memberName: member.name } : {}
    if (request.method === 'approval') {
      const command = typeof request.params.command === 'string' ? request.params.command : undefined
      const description = typeof request.params.description === 'string' ? request.params.description : undefined
      const risk = isHighStakesApproval(command, description) ? 'high-stakes' : 'standard'
      const choices = choicesForApprovalRisk(request.params.choices, risk).filter((choice) =>
        choice === 'once' || choice === 'deny')
      const ask: PendingToolPermission = {
        ...owner,
        id: String(request.id), conversationId: conversation.id, sessionId: String(sessionId),
        command, description,
        patterns: Array.isArray(request.params.pattern_keys)
          ? request.params.pattern_keys.filter((key): key is string => typeof key === 'string')
          : typeof request.params.pattern_key === 'string' ? [request.params.pattern_key] : undefined,
        choices, risk, status: 'pending',
      }
      this.requests.set(ask.id, request)
      this.permissions.set(ask.id, ask)
      setPendingToolPermission(ask, { queue: true })
      this.emit({ type: 'permission', conversationId: conversation.id, ask })
    } else if (request.method === 'clarify') {
      const prompt = parseClarifyRequest({ ...request.params, request_id: String(request.id) }, { conversationId: conversation.id, sessionId: String(sessionId) })
      if (!prompt || prompt.kind !== 'clarify') { this.localClient?.respondError(request.id, -32602, 'Invalid clarify request'); return }
      Object.assign(prompt, owner)
      this.requests.set(prompt.requestId, request)
      setAgentPrompt(prompt, async (answer) => {
        if (answer.kind !== 'clarify') throw new Error('Expected a clarify answer')
        const result = 'cancel' in answer ? {} : { answers: Object.fromEntries(answer.answers.map((item) => [item.qid ?? prompt.questions[0]?.qid ?? 'answer', item.answer])) }
        await this.localClient?.respond(request.id, result)
        if (this.requests.get(prompt.requestId) === request) {
          this.requests.delete(prompt.requestId)
          this.emitLocal({ type: 'clarify', conversationId: conversation.id, prompt: null })
        }
      })
      this.emitLocal({ type: 'clarify', conversationId: conversation.id, prompt })
    }
  }

  private handleLegacyRequest(event: ServeEvent): void {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    if (event.type === 'secret.request' || event.type === 'sudo.request') {
      // Older gateways use notification + late-answer RPC. Decline without opening a renderer field.
      if (typeof payload.request_id === 'string') void this.request(event.type.replace('.request', '.respond'), { request_id: payload.request_id, value: '' }).catch(() => {})
      return
    }
    const conversation = event.session_id ? this.conversationForSession(event.session_id) : null
    if (conversation?.target.type === 'group' && !this.localRooms.sessionAcceptsRequests(String(event.session_id))) return
    if (event.type === 'clarify.request') {
      // Modern gateways use server requests; legacy cards keep their late-answer RPC.
      if (!conversation) return
      const prompt = parseClarifyRequest(payload, { conversationId: conversation.id, sessionId: event.session_id })
      if (!prompt) return
      const member = this.localRooms.memberForSession(String(event.session_id))
      if (member) Object.assign(prompt, { memberId: member.id, memberName: member.name })
      setAgentPrompt(prompt, async (answer) => {
        if (answer.kind !== 'clarify') throw new Error('Expected a clarify answer')
        if ('cancel' in answer) await this.request('clarify.respond', { request_id: prompt.requestId, answer: '' })
        else for (const item of answer.answers) await this.request('clarify.respond', { request_id: prompt.requestId, answer: item.answer, ...(item.qid ? { question_id: item.qid } : {}) })
      })
      this.emitLocal({ type: 'clarify', conversationId: conversation.id, prompt })
      return
    }
    super.handleServeEvent(event)
  }

  override async respondPermission(conversationId: string, choice: ToolPermissionChoice, opts?: { optionId?: string; requestId?: string }): Promise<void> {
    const shown = getPendingToolPermission(conversationId)
    if (opts?.requestId && shown?.id !== opts.requestId) return
    const ask = shown?.conversationId === conversationId
      ? this.permissions.get(shown.id)
      : [...this.permissions.values()].find(p => p.conversationId === conversationId)
    if (!ask) { await super.respondPermission(conversationId, choice, opts); return }
    const key = ask.id
    if (ask.status === 'submitting') return
    if (!ask.choices.includes(choice)) throw new Error('Approval choice is not allowed')
    const request = this.requests.get(ask.id)
    if (!request) return
    const submitting = { ...ask, status: 'submitting' as const }
    this.permissions.set(key, submitting)
    setPendingToolPermission(submitting, { queue: true })
    try {
      const client = await this.ensureClient()
      // Cancellation or replay may replace the request while the client reconnects.
      if (this.permissions.get(key) !== submitting || this.requests.get(ask.id) !== request || this.disposed) return
      await client.respond(request.id, { choice })
      if (this.requests.get(ask.id) === request) this.requests.delete(ask.id)
      if (this.permissions.get(key) !== submitting || this.disposed) return
      this.permissions.delete(key)
      clearPendingToolPermission(ask.id)
      this.emit({ type: 'permission', conversationId, ask: null })
    } catch (error) {
      if (this.permissions.get(key) === submitting) {
        const failed = { ...ask, status: 'failed' as const }
        this.permissions.set(key, failed)
        setPendingToolPermission(failed, { queue: true })
      }
      throw error
    }
  }

  async stopTurn(conversationId: string): Promise<boolean> {
    const conversation = getState().conversations.find((c) => c.id === conversationId)
    if (conversation?.target.type === 'group') return this.localRooms.stop(conversationId)
    if (!conversation?.hermesSessionId) return false
    const binding = await this.bind(conversation)
    const result = await this.request<{ status: string; interrupted?: boolean }>('session.interrupt', { session_id: binding.runtimeId, profile: binding.profile })
    const stopped = result.status === 'interrupted' || result.interrupted === true
    if (stopped) this.conversationReplayVersions.set(conversationId, (this.conversationReplayVersions.get(conversationId) ?? 0) + 1)
    return stopped
  }

  async steer(conversationId: string, text: string): Promise<boolean> {
    const conversation = getState().conversations.find((c) => c.id === conversationId)
    if (!conversation?.hermesSessionId) return false
    const binding = await this.bind(conversation)
    let result: { status: string }
    try { result = await this.request<{ status: string }>('session.steer', { session_id: binding.runtimeId, profile: binding.profile, text }) }
    catch (error) { throw new SendError(error instanceof ServeRpcError ? 'rejected' : 'uncertain', error) }
    if (result?.status === 'queued' || result?.status === 'redirected') return true
    if (result?.status === 'rejected') return false
    throw new SendError('uncertain')
  }

  acknowledgeUncertain(conversationId: string): void {
    this.uncertainSubmissions.delete(conversationId)
  }

  async retryTurn(conversationId: string): Promise<boolean> {
    if (this.uncertainSubmissions.has(conversationId)) return false
    const conversation = getState().conversations.find((c) => c.id === conversationId)
    if (conversation?.target.type === 'group') return this.localRooms.retry(conversationId)
    const message = [...getMessagesForConversation(conversationId)].reverse().find((m) => m.role === 'user')
    if (!conversation || !message) return false
    const notedPaths = new Set(splitAttachmentNote(message.content).paths)
    const attachments = message.attachments?.flatMap(({ name, path, kind, size }) =>
      typeof path === 'string' && path.trim() && !notedPaths.has(path.trim()) ? [{ name, path, kind, size }] : [])
    await this.sendMessage(conversation, message.content, {
      echoUser: false, echoId: message.id,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(attachments?.length ? { attachments } : {}),
    })
    return true
  }

  override async spawnSubagentInto(
    conversation: Conversation, kind: SubagentKind, goal: string, options?: { label?: string; profile?: string },
  ): Promise<SubagentRun> {
    const client = await this.ensureClient()
    const parent = await this.bind(conversation)
    const profile = options?.profile ?? parent.profile
    if (!profilePattern.test(profile)) throw new Error('Invalid local profile')
    const created = await client.request<SessionResult>('session.create', {
      profile, source: 'desktop', follow_profile_config: true, parent_session_id: parent.storedId, title: goal.slice(0, 60),
    })
    const run: SubagentRun = {
      id: uid('run'), parentAgentId: this.profileAgentId(conversation), kind,
      title: goal.slice(0, 60), status: 'running', createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(), digests: [], conversationId: conversation.id,
      source: 'spawn', hermesSessionId: created.session_id, ...(options?.label ? { label: options.label } : {}),
    }
    this.helperBindings.set(run.id, { profile, runtimeId: created.session_id,
      storedId: created.stored_session_id ?? created.session_id })
    upsertSubagent(run)
    appendSubagentMessage(conversation.id, run)
    this.emit({ type: 'subagent', run })
    try {
      await client.request('prompt.submit', { session_id: created.session_id, profile, text: goal, surface: 'desktop' })
    } catch (error) {
      const failed: SubagentRun = { ...run, status: 'failed', finishedAt: new Date().toISOString() }
      upsertSubagent(failed)
      this.emit({ type: 'subagent', run: failed })
      throw error
    }
    return run
  }

  async listSkills(): Promise<DeploySkillEntry[]> {
    const conversation = getState().conversations.find((c) => c.id === getState().selectedConversationId)
    const profile = conversation ? this.profile(conversation) : 'default'
    const result = await this.request<{ skills?: Record<string, string[]> }>('skills.manage', { profile, action: 'list' })
    return Object.entries(result.skills ?? {}).flatMap(([category, names]) => names.map((name) => ({ name, category })))
  }

  override async createAgent(partial?: NewAgentProfile): Promise<Agent> {
    return this.localProfiles.create(partial)
  }

  async removeAgent(agentId: string): Promise<void> {
    return this.localProfiles.hide(agentId)
  }

  async markRead(conversationId: string): Promise<void> {
    const conversation = getState().conversations.find((c) => c.id === conversationId)
    if (conversation?.target.type === 'group') {
      setState(state => ({ conversations: state.conversations.map(c => c.id === conversationId
        ? { ...c, hasUnread: false, unreadCount: 0 } : c) }))
      return
    }
    if (!conversation?.hermesSessionId) return
    const profile = this.profile(conversation)
    const result = await mutateSession('PATCH', conversation.hermesSessionId, { unread: false }, profile)
    if (!result.ok) throw new Error(result.error ?? 'Could not mark the session read')
    setState((state) => ({ conversations: state.conversations.map((c) => c.id === conversationId
      ? { ...c, hasUnread: false, unreadCount: 0, unread: false } : c) }))
    this.updateUnreadAgents()
  }

  private retireReplay(): void {
    this.replayGeneration++
    this.replayContext = null
    this.bindingInflight.clear()
  }

  private replayCurrent(context: ReconnectReplay): boolean {
    return !this.disposed && !context.overflow && this.replayContext === context &&
      context.generation === this.replayGeneration && context.epoch === this.epoch &&
      context.client === this.localClient && context.client.connectionState === 'open'
  }

  private captureReplayOwner(conversation: Conversation, activeOnly = true): () => boolean {
    const { id, hermesSessionId, target } = conversation
    const profile = target.type === 'agent' ? this.profile(conversation) : null
    const version = this.conversationReplayVersions.get(id) ?? 0
    const turnId = this.turns.get(id)?.id
    const phase = this.turns.get(id)?.phase
    const room = target.type === 'group' ? this.localRooms.get(id) : null
    const turn = room?.state.turns.find(t => t.status === 'running')
    const member = turn && room?.state.bindings[turn.memberId]
    const attempt = turn?.attempts?.length
    const startSeq = turn?.startSeq
    const startedAt = turn?.startedAt, rootId = turn?.rootId
    return () => {
      const latest = getConversation(id)
      if (this.disposed || !latest || latest.hermesSessionId !== hermesSessionId ||
          latest.target.type !== target.type || (profile !== null && this.profile(latest) !== profile) ||
          (this.conversationReplayVersions.get(id) ?? 0) !== version) return false
      if (!room) {
        const current = this.turns.get(id)
        return (!turnId || current?.id === turnId) && (!activeOnly || (phase === 'done' || phase === 'failed'
          ? current?.phase === phase : current?.phase !== 'done' && current?.phase !== 'failed'))
      }
      if (latest.target.type !== 'group' || target.type !== 'group' || latest.target.groupId !== target.groupId ||
          this.localRooms.get(id) !== room) return false
      if (!turn) return !room.state.turns.some(t => t.status === 'running')
      const owner = room.state.turns.find(t => t.id === turn.id)
      const binding = room.state.bindings[turn.memberId]
      return owner?.status === 'running' && owner.memberId === turn.memberId && owner.startSeq === startSeq &&
        owner.startedAt === startedAt && owner.rootId === rootId && binding?.profile === member?.profile &&
        owner.attempts?.length === attempt && binding?.runtimeId === member?.runtimeId &&
        binding?.storedId === member?.storedId && binding?.epoch === member?.epoch &&
        !!getState().groups.find(g => g.id === target.groupId)?.memberAgentIds.includes(turn.memberId)
    }
  }

  /** Only a freshly published owning transcript can identify an overlapping dispatch. */
  private mergeRecoveredGenUi(conversation: Conversation, event: ServeEvent, history: RecoveredHistory): boolean {
    if (!history.current() || this.bindings.get(conversation.id) !== history.binding ||
        this.turns.get(conversation.id)?.id !== history.turnId ||
        (event.session_id !== history.binding.runtimeId && event.session_id !== history.binding.storedId)) return false
    const payload = event.payload as ServeToolEvent
    if (!payload || !isRenderUiTool(payload.name)) return false
    const messages = getMessagesForConversation(conversation.id)
    const streaming = messages.findLast(message => message.role === 'agent' && message.streaming)
    const incoming = event.type === 'tool.complete' ? toolEventFromPayload(payload, toolResultStatus(payload)) : null
    const liveTools = validatedGenUiEvents(streaming?.toolEvents)
    const newDispatch = incoming?.genui && isGenUiOccurrence(incoming.genuiOccurrence) &&
      !liveTools.some(tool => tool.genuiOccurrence === incoming.genuiOccurrence &&
        JSON.stringify(tool.genui) === JSON.stringify(incoming.genui))
    // A new dispatch may reuse a provider id. Fork its activity, not its occurrence,
    // before generic running status can overwrite an already completed widget.
    if (streaming && (liveTools.some(tool => tool.toolCallId === payload.tool_id &&
        (event.type === 'tool.start' || newDispatch)) || (newDispatch && liveTools.length >= MAX_GENUI_CALLS))) {
      patchMessage(conversation.id, streaming.id, { streaming: false })
      flushMessagePatches()
      if (!history.current()) return true
      this.streamingByConversation.delete(conversation.id)
    }
    if (!incoming?.genui || !isGenUiOccurrence(incoming.genuiOccurrence)) return false
    const revision = JSON.stringify(incoming.genui)
    const source = history.occurrences.get(incoming.genuiOccurrence)
    if (!source || source.revision !== revision) return false
    const target = messages.find(message => message.id === source.messageId && message.threadId === conversation.id &&
      message.fromAgentId === `profile:${history.binding.profile}`)
    if (!target) return false
    const at = (target.toolEvents ?? []).findIndex(tool => validatedGenUiEvents([tool]).some(valid =>
      valid.genuiOccurrence === incoming.genuiOccurrence && JSON.stringify(valid.genui) === revision))
    if (at < 0) return false
    const tools = [...target.toolEvents!]
    const known = tools[at]!
    tools[at] = toolEventFromPayload({ ...payload, name: known.tool, tool_id: known.toolCallId }, 'completed', known)
    const live = messages.findLast(message => message.role === 'agent' && message.streaming && message.id !== target.id)
    const knownTools = validatedGenUiEvents(tools)
    const additionalTools = validatedGenUiEvents(live?.toolEvents)
    const collision = live && (knownTools.length + additionalTools.length > MAX_GENUI_CALLS ||
      additionalTools.some(tool => knownTools.some(existing => existing.toolCallId === tool.toolCallId &&
        (existing.genuiOccurrence !== tool.genuiOccurrence || JSON.stringify(existing.genui) !== JSON.stringify(tool.genui)))))
    if (live && !collision) {
      for (const tool of live.toolEvents ?? []) {
        const existing = tools.findIndex(old => old.toolCallId === tool.toolCallId &&
          (old.tool === tool.tool || (isRenderUiTool(old.tool) && isRenderUiTool(tool.tool))))
        // A pending duplicate cannot revoke the proven successful history result.
        if (existing < 0) tools.push(tool)
        else if (!validatedGenUiEvents([tools[existing]]).length) tools[existing] = tool
      }
    }
    if (!history.current()) return true
    setState(state => ({ messagesByThreadId: { ...state.messagesByThreadId,
      [conversation.id]: (state.messagesByThreadId[conversation.id] ?? [])
        .filter(message => !live || collision || message.id !== live.id)
        .map(message => message.id !== target.id ? message : { ...message, turnId: history.turnId,
          streaming: !collision, toolEvents: capGenUiEvents(tools),
          content: message.content + (!collision && live?.content ? live.content : ''),
          reasoning: [message.reasoning, !collision ? live?.reasoning : undefined].filter(Boolean).join('\n') || undefined }),
    } }), { persist: false })
    if (!history.current()) return true
    if (!collision) this.streamingByConversation.set(conversation.id, true)
    this.updateTurn(conversation, 'working')
    if (!history.current()) return true
    this.emit({ type: 'message', conversationId: conversation.id,
      message: getMessagesForConversation(conversation.id).find(message => message.id === target.id)! })
    return true
  }

  private replayOpenSessions(): Promise<void> {
    const client = this.localClient
    if (this.disposed || !client || client.connectionState !== 'open') return Promise.resolve()
    if (this.replayContext && this.replayCurrent(this.replayContext) && this.replayContext.promise) return this.replayContext.promise
    const context: ReconnectReplay = { client, generation: this.replayGeneration, epoch: this.epoch, events: [], overflow: false, histories: new Map() }
    this.replayContext = context
    const attempt = this.replaySessions(context)
    context.promise = attempt
    const cleanup = () => {
      // Drain only THIS still-current context, including RPC failure. A retired
      // export/read may finish after its replacement has already begun recovery.
      try {
        for (const item of context.events.sort((a, b) => (a.event.seq ?? 0) - (b.event.seq ?? 0))) {
          if (!this.replayCurrent(context)) break
          if (item.current()) {
            const conversation = item.event.session_id ? this.conversationForSession(item.event.session_id) : null
            this.handleServeEvent(item.event, true, conversation ? context.histories.get(conversation.id) : undefined)
          }
        }
      } finally {
        context.events.length = 0
        context.histories.clear()
        if (this.replayContext === context) this.replayContext = null
      }
    }
    void attempt.then(cleanup, cleanup)
    return attempt
  }

  /** Chats with something to recover: bound this run, mid-reply, awaiting an answer, or open. */
  private replayTargets(): Set<string> {
    const targets = new Set([...this.bindings.keys(), ...this.rebindAfterEpoch, ...this.streamingByConversation.keys()])
    this.rebindAfterEpoch.clear()
    for (const [id, turn] of this.turns) if (!turn.finishedAt) targets.add(id)
    for (const request of this.requests.values()) {
      const owner = this.conversationForSession(String(request.params.session_id ?? ''))
      if (owner) targets.add(owner.id)
    }
    const selected = getState().selectedConversationId
    if (selected) targets.add(selected)
    return targets
  }

  private async replaySessions(context: ReconnectReplay): Promise<void> {
    const client = context.client
    await this.localRooms.recoverAll(true)
    if (!this.replayCurrent(context)) return
    const open = this.replayTargets()
    for (const conversationId of open) {
      if (!this.replayCurrent(context)) return
      const conversation = getState().conversations.find((c) => c.id === conversationId)
      if (!conversation?.hermesSessionId) continue
      try {
        // Reattach the session's transport ownership to the newly opened socket.
        const previous = this.bindings.get(conversationId)
        this.bindings.delete(conversationId)
        const binding = await this.bind(conversation)
        if (!this.replayCurrent(context)) return
        // Snapshot cursor authority survives its OWN terminal settlement. Live
        // buffer/history ownership does not; Stop/hung/new-turn versions retire it.
        const owner = this.captureReplayOwner(this.requireConversation(conversationId), false)
        const current = () => this.replayCurrent(context) && owner() && this.bindings.get(conversationId) === binding
        const turn = this.turns.get(conversationId)
        const beforeHistory = getMessagesForConversation(conversationId)
        const prompt = beforeHistory.find(message => message.id === turn?.userMessageId && message.role === 'user')
        const previousPromptRow = Math.max(0, ...beforeHistory.filter(message => message.role === 'user' &&
          message.id !== prompt?.id && Number.isSafeInteger(message.hermesRowId)).map(message => message.hermesRowId!))
        if (previous && !this.watermarks.has(binding.runtimeId)) {
          this.watermarks.set(binding.runtimeId, this.watermarks.get(previous.runtimeId) ?? 0)
        }
        const sessionIds = new Set([binding.runtimeId, binding.storedId, previous?.runtimeId, previous?.storedId])
        const knownRequests = new Map([...this.requests].filter(([, request]) =>
          typeof request.params.session_id === 'string' && sessionIds.has(request.params.session_id)))
        const params = { session_id: binding.runtimeId, profile: binding.profile, last_seen: this.watermarks.get(binding.runtimeId) ?? 0 }
        type ReplayResult = {
          events: ServeEvent[]; latest_seq: number; truncated: boolean; epoch: string;
          open_requests?: { id: string; method: string; params: Record<string, unknown> }[] | null
        }
        let result = await client.request<ReplayResult>('session.events.since', params)
        if (!current()) continue
        if (!this.epoch && result.epoch) {
          this.epoch = result.epoch
          context.epoch = result.epoch
          this.localRooms.setEpoch(result.epoch)
        }
        if (result.epoch && context.epoch && result.epoch !== context.epoch) continue
        if (result.truncated) {
          this.streamingByConversation.delete(conversationId)
          this.clearStreamWatch(conversationId)
          setState((state) => ({ messagesByThreadId: { ...state.messagesByThreadId, [conversationId]: (state.messagesByThreadId[conversationId] ?? []).map((m) => ({ ...m, streaming: false })) } }), { persist: false })
          await this.localHistory.getMessages(conversationId, current, messages => {
            if (!current() || !turn || !prompt) return
            const promptIndex = messages.findLastIndex(message => message.role === 'user')
            const durablePrompt = messages[promptIndex]
            if (!durablePrompt || durablePrompt.threadId !== conversationId ||
                durablePrompt.fromAgentId !== `profile:${binding.profile}` ||
                !Number.isSafeInteger(durablePrompt.hermesRowId) || durablePrompt.hermesRowId! <= previousPromptRow ||
                durablePrompt.content !== prompt.content) return
            const owningTurn = this.turns.get(conversationId)
            if (!owningTurn || owningTurn.id !== turn.id) return
            // Hydration replaces the optimistic user row; retain its owning durable anchor.
            const hydratedTurn = { ...owningTurn, userMessageId: durablePrompt.id }
            this.turns.set(conversationId, hydratedTurn)
            upsertTurn(hydratedTurn)
            const occurrences: RecoveredHistory['occurrences'] = new Map()
            // Only the current durable prompt section, not earlier turns or cached
            // rows from failed reads. Scan/count remains bounded like GENUI display.
            for (const message of messages.slice(promptIndex + 1, promptIndex + 51)) {
              if (message.role !== 'agent' || message.threadId !== conversationId ||
                  message.fromAgentId !== `profile:${binding.profile}`) continue
              for (const tool of validatedGenUiEvents(message.toolEvents)) if (isGenUiOccurrence(tool.genuiOccurrence)) {
                occurrences.set(tool.genuiOccurrence, { messageId: message.id, revision: JSON.stringify(tool.genui) })
              }
            }
            context.histories.set(conversationId, { binding, current, turnId: turn.id, occurrences })
          })
          if (!current()) continue
        } else {
          for (const event of (Array.isArray(result.events) ? result.events : []).slice(0, MAX_RECONNECT_REPLAY_EVENTS)) {
            if (!current()) break
            if (event.session_id === binding.runtimeId || event.session_id === binding.storedId) this.handleServeEvent(event, true)
          }
        }
        if (!current()) continue
        this.watermarks.set(binding.runtimeId, Math.max(result.latest_seq, this.watermarks.get(binding.runtimeId) ?? 0))
        if (Array.isArray(result.open_requests)) {
          const openIds = new Set(result.open_requests.map((request) => String(request.id)))
          // Only reconcile requests known before this read; newer live cards own their lifetime.
          for (const [id, request] of knownRequests) {
            if (!current()) break
            if (this.requests.get(id) === request && !openIds.has(id)) this.clearServerRequest(id, conversationId)
          }
        }
        for (const request of result.open_requests ?? []) {
          if (!current()) break
          const id = String(request.id)
          if (this.requests.get(id) !== knownRequests.get(id)) continue
          client.dispatchRequest(request)
        }
      } catch {
        // One session that cannot be resumed (lease held elsewhere, deleted,
        // ownership changed) must not abandon recovery of every other chat.
      }
    }
  }

  override async getComputerUrl(): Promise<{ url: string | null; provider: string }> {
    return { url: null, provider: 'local' }
  }

  async roomsEnabled(): Promise<boolean> { return true }

  async setRoomTokenBudget(conversationId: string, limit: number): Promise<boolean> {
    return this.localRooms.setTokenBudget(conversationId, limit)
  }

  watchRoom(conversationId: string): () => void {
    this.localRooms.publish(this.localRooms.get(conversationId))
    // Watching a room is a view lifetime, never an execution lifetime.
    return () => {}
  }

  dispose(): void {
    this.disposed = true
    this.retireReplay()
    this.localRooms.dispose()
    for (const permission of this.permissions.values()) clearPendingToolPermission(permission.id)
    this.permissions.clear()
    this.idleProbes.clear()
    this.streamStartSequences.clear()
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    for (const conversationId of this.bindings.keys()) {
      this.clearStreamWatch(conversationId)
      clearAgentPromptsForConversation(conversationId)
    }
    this.gateway.dispose()
    setConversationReadSink(null)
    this.localListeners.clear()
  }
}
