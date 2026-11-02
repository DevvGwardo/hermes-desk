/** Serve I/O for local rooms. The engine owns routing; each member owns a session. */
import { ServeRpcError, type ServeEvent } from '../hermes-serve'
import type { SendMessageOptions, TransportEvent } from './transport'
import type { Conversation } from './types'
import { isRoomTurnRow, roomMessageIdOf, roomTurnRowId } from './room-row-ids'
import { LocalRoomEngine, roomPrompt, wasSubmitted, type LocalRoomBinding, type LocalRoomMember, type LocalRoomTurn } from './local-rooms'
import { systemRoomClock, type RoomRepository, type RoomClock } from './local-room-ports'
import { genUiResultFromResult, isRenderUiTool, MAX_GENUI_CALLS } from '../genui'
import { isRoomBudgetPaused } from './room-usage'
export type { RoomRepository, RoomClock } from './local-room-ports'

export interface RoomServeIO {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>
  emit(event: TransportEvent): void
  dispatchRequest(request: { id: string; method: string; params: Record<string, unknown> }): void
  clearSessionRequests(sessionId: string, conversationId: string): void
  captureSessionRequests(sessionIds: string[], conversationId: string):
    (requests: SessionResult['open_requests']) => void
}
interface SessionResult {
  session_id: string
  stored_session_id?: string | null
  session_key?: string
  info?: { profile_name?: string; stored_session_id?: string; usage?: unknown }
  open_requests?: { id: string; method: string; params: Record<string, unknown> }[] | null
}

class RoomCheckpointError extends Error {}
const MAX_ROOM_REPLAY_EVENTS = 4096
interface RoomReplayBuffer {
  events: ServeEvent[]
  current: () => boolean
  invalidated: boolean
}
const replayCritical = (event: ServeEvent) => event.type === 'message.complete' ||
  event.type === 'session.closed' || event.type === 'session.reclaimed' ||
  (['tool.start', 'tool.generating', 'tool.complete'].includes(event.type) &&
    isRenderUiTool((event.payload as Record<string, unknown> | undefined)?.name))

export class LocalRoomRunner {
  private io: RoomServeIO
  private repository: RoomRepository
  private clock: RoomClock
  private rooms = new Map<string, LocalRoomEngine>()
  private attached = new Set<string>()
  private bindingInflight = new Map<string, Promise<LocalRoomBinding>>()
  private interruptInflight = new Map<string, Promise<boolean>>()
  private pumping = new Set<string>()
  private wakeRequested = new Set<string>()
  private retiredSessions = new Set<string>()
  private recovering = new Map<string, Promise<void>>()
  private recovered = new Set<string>()
  private starting = new Map<string, symbol>()
  private cancelTimer: () => void
  private release: () => void
  private publishing = false
  private membershipPending = false
  private syncingMembership = false
  private epoch: string | null = null
  private epochGeneration = 0
  private replayBuffers = new Map<string, RoomReplayBuffer>()
  private disposed = false
  /** A refused dispatch needs explicit recovery, not a liveness-timer retry. */
  private dispatchPaused = new Set<string>()

  constructor(io: RoomServeIO, repository: RoomRepository, clock: RoomClock = systemRoomClock) {
    this.io = io
    this.repository = repository
    this.clock = clock
    this.release = repository.subscribe(() => this.syncMembership())
    this.cancelTimer = clock.every(() => {
      for (const [id, room] of this.rooms) if (room.state.turns.some(t => t.status === 'running') ||
        Object.values(room.state.bindings).some(b => b.blocked)) void this.recoverRoom(id, true, false).catch(() => {})
    }, 30_000)
  }

  setEpoch(epoch: string): void {
    if (this.disposed || this.epoch === epoch) return
    const changed = this.epoch !== null
    this.epoch = epoch
    if (!changed) return
    const generation = ++this.epochGeneration
    const current = () => !this.disposed && generation === this.epochGeneration
    // A new epoch must not append new frames to a retired replay's buffer.
    this.replayBuffers.clear()
    this.attached.clear()
    this.bindingInflight.clear()
    this.recovering.clear()
    this.recovered.clear()
    this.starting.clear()
    for (const room of this.rooms.values()) {
      if (!current()) return
      for (const [id, binding] of Object.entries(room.state.bindings)) {
        // Requests from a dead backend cannot be answered in the new epoch.
        this.io.clearSessionRequests(binding.runtimeId, room.state.conversationId)
        // Request subscribers can synchronously dispose or replace this epoch.
        if (!current()) return
        room.setBinding(id, { ...binding, epoch, lastSeen: 0 })
      }
      for (const turn of room.state.turns) if (turn.status === 'running') {
        // Only a claim without durable submission intent is safe to dispatch again.
        if (!turn.submittedText) this.releaseClaim(room, turn)
        else room.update(turn.id, { startSeq: 0 })
      }
      this.publish(room)
    }
  }

  get(conversationId: string): LocalRoomEngine {
    if (this.disposed) throw new Error('Local room runner has been disposed')
    const record = this.repository.read(conversationId)
    const conversation = record?.conversation
    if (!conversation || conversation.target.type !== 'group') throw new Error('Local room no longer exists')
    const definition = record!.definition
    if (!definition) throw new Error('Local group no longer exists')
    let room = this.rooms.get(conversationId)
    if (!room) {
      room = new LocalRoomEngine(conversationId, definition.members, definition.name, definition.purpose, conversation.localRoom, () => this.clock.now())
      this.rooms.set(conversationId, room)
    }
    room.name = definition.name
    room.purpose = definition.purpose
    this.syncRoomMembership(room, definition.members)
    return room
  }

  conversationForSession(sessionId: string): Conversation | null {
    for (const conversation of this.repository.list()) {
      const room = this.rooms.get(conversation.id)?.state ?? conversation.localRoom
      if (room && Object.values(room.bindings).some(b => b.runtimeId === sessionId)) return conversation
    }
    return null
  }

  sessionAcceptsRequests(sessionId: string): boolean {
    const conversation = this.conversationForSession(sessionId)
    if (!conversation) return false
    const record = this.repository.read(conversation.id)
    if (!record?.definition || record.conversation.target.type !== 'group') return false
    const room = this.get(conversation.id)
    const entry = Object.entries(room.state.bindings).find(([, b]) => b.runtimeId === sessionId)
    return !!entry && !entry[1].closed && room.members.some(m => m.id === entry[0]) &&
      room.state.turns.some(t => t.memberId === entry[0] && t.status === 'running')
  }

  memberForSession(sessionId: string): LocalRoomMember | undefined {
    const conversation = this.conversationForSession(sessionId)
    if (!conversation) return undefined
    const record = this.repository.read(conversation.id)
    if (!record?.definition || record.conversation.target.type !== 'group') return undefined
    const room = this.get(conversation.id)
    return room.members.find(m => room.state.bindings[m.id]?.runtimeId === sessionId)
  }

  isInternalSession(profile: string, sessionId: string): boolean {
    return this.repository.list().some(c => Object.values(c.localRoom?.bindings ?? {})
      .some(b => b.profile === profile && (b.storedId === sessionId || b.runtimeId === sessionId)))
  }

  publish(room: LocalRoomEngine, settledReply = false): void {
    const conversationId = room.state.conversationId
    if (this.disposed || !this.repository.read(conversationId)) return
    const publishing = this.publishing
    this.publishing = true
    let events: TransportEvent[]
    try { events = this.repository.publish(room, settledReply) } finally {
      this.publishing = publishing
      // Subscribers may change the roster inside this publication. Drain only
      // after the outermost write, before dispatch or captured output can continue.
      if (!this.publishing && this.membershipPending) this.syncMembership()
    }
    for (const event of events) {
      const record = this.repository.read(conversationId)
      if (this.disposed || record?.conversation.target.type !== 'group' || !record.definition) break
      if (event.type === 'message' && isRoomTurnRow(event.message) && !room.state.turns.some(t =>
        roomTurnRowId(t.id) === event.message.id && (t.status === 'running' || t.status === 'queued'))) continue
      this.io.emit(event)
    }
  }

  private checkpoint(room: LocalRoomEngine): boolean {
    const durable = this.repository.checkpoint(room)
    if (!durable) this.dispatchPaused.add(room.state.conversationId)
    return durable
  }

  /** Only release this unsubmitted claim; never undo cancellation or completion. */
  private releaseClaim(room: LocalRoomEngine, turn: LocalRoomTurn): void {
    const active = room.state.turns.find(t => t.id === turn.id && t.status === 'running' &&
      (t.attempts?.length ?? 0) === (turn.attempts?.length ?? 0))
    if (active) room.update(turn.id, {
      status: 'queued', phase: 'queued', startedAt: undefined, startSeq: undefined,
      submittedText: undefined, lastContactAt: undefined,
    })
  }

  private syncMembership(): void {
    if (this.disposed) return
    const generation = this.epochGeneration
    this.membershipPending = true
    if (this.publishing || this.syncingMembership) return
    this.syncingMembership = true
    try {
      while (this.membershipPending && !this.disposed) {
        this.membershipPending = false
        for (const [id, room] of this.rooms) {
          const record = this.repository.read(id)
          const groupExists = record?.conversation.target.type === 'group' && record.definition
          if (!groupExists) {
            this.rooms.delete(id)
            const running = room.cancel(undefined, 'Room deleted')
            for (const binding of Object.values(room.state.bindings)) {
              this.repository.retire(id, binding.storedId)
              this.retiredSessions.add(binding.runtimeId)
              this.io.clearSessionRequests(binding.runtimeId, id)
            }
            this.repository.disable(id)
            void this.interrupt(room, running, generation)
            continue
          }
          this.syncRoomMembership(room, record!.definition!.members)
        }
      }
    } finally { this.syncingMembership = false }
  }

  private syncRoomMembership(room: LocalRoomEngine, members: LocalRoomMember[]): void {
    const generation = this.epochGeneration
    // Restored pending turns retain their owner even if the roster changed offline.
    const owners = [...room.members.map(m => m.id), ...room.state.turns
      .filter(t => t.status === 'queued' || t.status === 'running').map(t => t.memberId)]
    const removed = [...new Set(owners)].filter(id => !members.some(m => m.id === id))
    room.members = members
    if (!removed.length) return
    // Only the removed members' turns end; the rest of each request can still wrap.
    // An unsent claim is simply dropped: its start() no longer owns the turn.
    const running = room.cancel(removed, 'Room member removed', { memberOnly: true }).filter(t => t.submittedText)
    this.quarantine(room, running)
    if (this.disposed || generation !== this.epochGeneration) return
    this.publish(room)
    if (this.checkpoint(room)) this.wake(room)
    void this.interrupt(room, running, generation)
  }

  async send(conversation: Conversation, text: string, options?: SendMessageOptions): Promise<{ turnId: string }> {
    const hasAttachments = options?.attachments?.some(a => typeof a.path === 'string' && a.path.trim())
    if ((!text.trim() && !hasAttachments) || text.length > 16_000)
      throw new Error('Room messages require text or an uploaded attachment (up to 16,000 characters).')
    const generation = this.epochGeneration
    const room = this.get(conversation.id)
    const routing = () => JSON.stringify(room.members.map(m => [m.id, m.profile, m.name, m.role]))
    const selectedRouting = routing()
    await this.recover(conversation.id)
    if (this.disposed || !this.repository.read(conversation.id)) throw new Error('Local room no longer exists')
    if (generation !== this.epochGeneration || this.rooms.get(conversation.id) !== room ||
      this.get(conversation.id) !== room || routing() !== selectedRouting)
      throw new Error('Room recipients changed while recovering. Review the room and send again.')
    if (!room.members.length) throw new Error('This room has no local profiles to answer')
    const reply = options?.replyTo?.id
    const before = room.state
    const restoreTranscript = this.repository.captureTranscript(conversation.id)
    const root = room.send(text, {
      id: options?.echoId ? roomMessageIdOf({ id: options.echoId }) ?? options.echoId : undefined,
      echoId: options?.echoId,
      replyToId: reply ? roomMessageIdOf({ id: reply }) ?? reply : undefined,
      attachmentPaths: options?.attachments?.map(a => a.path),
      attachments: options?.attachments?.map((a, i) => ({ ...a, id: `${options?.echoId ?? globalThis.crypto.randomUUID()}:${i}` })),
    })
    this.publish(room)
    if (!this.checkpoint(room)) {
      room.state = before
      this.publish(room)
      restoreTranscript()
      throw new Error('Could not save the local room journal. Free local storage before retrying.')
    }
    this.dispatchPaused.delete(conversation.id)
    this.wake(room)
    return { turnId: room.state.turns.find(t => t.rootId === root.id)?.id ?? root.id }
  }

  private async bind(room: LocalRoomEngine, memberId: string, ownsClaim?: () => boolean): Promise<LocalRoomBinding> {
    const generation = this.epochGeneration
    if (this.disposed || !this.repository.read(room.state.conversationId)) throw new Error('Room no longer exists')
    this.publish(room)
    // A session itself is a backend side effect, even before prompt intent.
    if (!this.checkpoint(room)) throw new RoomCheckpointError('Could not persist the room before session binding')
    if (this.disposed || !this.repository.read(room.state.conversationId)) throw new Error('Room no longer exists')
    if (generation !== this.epochGeneration) throw new RoomCheckpointError('Room binding belongs to a retired backend epoch')
    if (ownsClaim && this.dispatchPaused.has(room.state.conversationId)) throw new RoomCheckpointError('Room dispatch awaits durable recovery')
    if (ownsClaim && !ownsClaim()) throw new Error('Room turn no longer owns this claim')
    const key = `${room.state.conversationId}:${memberId}`
    const saved = room.state.bindings[memberId]
    if (saved && this.attached.has(key)) return saved
    const pending = this.bindingInflight.get(key)
    if (pending) return pending
    const member = room.members.find(m => m.id === memberId) ??
      (saved ? { profile: saved.profile } : undefined)
    if (!member) throw new Error('Room member was removed')
    const attempt = (async () => {
      let resumed: LocalRoomBinding | undefined = saved
      const create = () => this.io.request<SessionResult>('session.create',
        { profile: member.profile, source: 'desktop', follow_profile_config: true, title: `Room: ${room.name}`.slice(0, 60) })
      let result: SessionResult
      try {
        result = await (resumed ? this.io.request<SessionResult>('session.resume',
          // Read-only lazy resume never schedules generic crash auto-continue.
          // An explicit prompt upgrades it, retaining desktop tools/approvals.
          // The stored session owns its source; the renderer cannot override it.
          // CONTRACT: session.resume has no follow_profile_config; unknown keys are refused.
          { profile: member.profile, session_id: resumed.storedId, omit_messages: true, lazy: true }) : create())
      } catch (error) {
        // 4007: Hermes no longer has the stored session. Replace it, never loop on resume.
        if (!resumed || !(error instanceof ServeRpcError) || error.code !== 4007 ||
          this.disposed || generation !== this.epochGeneration) throw error
        const sent = room.state.turns.find(t => t.memberId === memberId && t.status === 'running' && t.submittedText)
        room.dropBinding(memberId)
        if (sent) {
          // Its accepted prompt died with the session; resubmitting could repeat side effects.
          room.complete(sent.id, { error: 'This member\'s Hermes session no longer exists; its turn was lost.', retryable: false })
          this.publish(room)
          if (this.checkpoint(room)) this.wake(room)
          throw error
        }
        resumed = undefined
        result = await create()
      }
      if (!result.session_id || (result.info?.profile_name && result.info.profile_name !== member.profile)) throw new Error('Serve returned the wrong room profile')
      const latest = room.state.bindings[memberId] ?? resumed
      if (latest?.closed && !resumed?.closed && latest.runtimeId === result.session_id)
        throw new Error('Room session closed while resuming. Try again.')
      const binding: LocalRoomBinding = {
        ...latest, profile: member.profile, runtimeId: result.session_id, closed: false,
        storedId: result.stored_session_id ?? result.info?.stored_session_id ?? result.session_key ?? latest?.storedId ?? result.session_id,
        lastSeen: latest && (latest.runtimeId !== result.session_id || (latest.epoch && latest.epoch !== this.epoch))
          ? 0 : latest?.lastSeen ?? 0,
        ...(this.epoch ? { epoch: this.epoch } : {}),
      }
      const record = this.repository.read(room.state.conversationId)
      if (this.disposed || !record || generation !== this.epochGeneration) {
        // Resuming a saved session grants no deletion authority over its new owner.
        const stillOwned = record?.definition && record.conversation.target.type === 'group' &&
          Object.values(record.conversation.localRoom?.bindings ?? {}).some(current =>
            current.profile === binding.profile && current.storedId === binding.storedId)
        if (!stillOwned) this.repository.retire(record ? binding.storedId : room.state.conversationId, binding.storedId)
        if (!this.disposed && record && generation !== this.epochGeneration)
          throw new RoomCheckpointError('Room binding belongs to a retired backend epoch')
        throw new Error('Room no longer exists')
      }
      room.setBinding(memberId, binding)
      room.setUsageBaseline(memberId, result.info?.usage)
      if (latest && latest.runtimeId !== binding.runtimeId)
        for (const turn of room.state.turns.filter(t => t.memberId === memberId && t.status === 'running'))
          room.update(turn.id, { startSeq: 0 })
      this.publish(room)
      if (!this.checkpoint(room)) throw new RoomCheckpointError('Could not persist the room member binding')
      if (this.disposed || generation !== this.epochGeneration)
        throw new RoomCheckpointError('Room binding owner changed before request publication')
      this.attached.add(key)
      for (const request of result.open_requests ?? []) {
        if (this.disposed || generation !== this.epochGeneration)
          throw new RoomCheckpointError('Room binding owner changed during request publication')
        this.io.dispatchRequest(request)
      }
      if (this.disposed || generation !== this.epochGeneration)
        throw new RoomCheckpointError('Room binding owner changed during request publication')
      return binding
    })()
    this.bindingInflight.set(key, attempt)
    try { return await attempt } finally {
      if (this.bindingInflight.get(key) === attempt) this.bindingInflight.delete(key)
    }
  }

  /** A wake during shutdown is recorded, not dropped behind the pump lock. */
  private wake(room: LocalRoomEngine): void {
    const id = room.state.conversationId
    if (this.disposed || this.dispatchPaused.has(id)) return
    this.wakeRequested.add(id)
    if (this.pumping.has(id) || this.disposed) return
    this.pumping.add(id)
    this.clock.defer(() => {
      try {
        while (this.wakeRequested.delete(id) && !this.disposed && !this.dispatchPaused.has(id) && this.repository.read(id)) {
          const ready = room.takeReady()
          if (!ready.length) continue
          // Register ownership before publication can synchronously reenter recovery.
          const claims = ready.map(turn => {
            const dispatch = Symbol('room dispatch')
            this.starting.set(turn.id, dispatch)
            return { turn, dispatch }
          })
          this.publish(room)
          if (!this.checkpoint(room)) {
            for (const { turn, dispatch } of claims) {
              this.releaseClaim(room, turn)
              if (this.starting.get(turn.id) === dispatch) this.starting.delete(turn.id)
            }
            this.publish(room)
            continue
          }
          for (const { turn, dispatch } of claims) {
            void this.start(room, turn, dispatch).finally(() => {
              if (this.starting.get(turn.id) !== dispatch) return
              this.starting.delete(turn.id)
              // Explicit recovery can finish before the refused claim is released.
              // Preserve its wake, but a failed checkpoint still leaves dispatch paused.
              if (room.state.turns.some(t => t.id === turn.id && t.status === 'queued')) this.wake(room)
            })
          }
        }
      } finally {
        this.pumping.delete(id)
        if (this.wakeRequested.has(id) && !this.disposed) this.wake(room)
      }
    })
  }

  private async start(room: LocalRoomEngine, turn: LocalRoomTurn, dispatch: symbol): Promise<void> {
    // Reclaimed dispatches can share a turn and retry history, never their owner.
    const attempt = turn.attempts?.length ?? 0
    const generation = this.epochGeneration
    const current = () => !this.disposed && this.epochGeneration === generation && this.starting.get(turn.id) === dispatch
      ? room.state.turns.find(t => t.id === turn.id && t.status === 'running' && (t.attempts?.length ?? 0) === attempt)
      : undefined
    try {
      if (this.disposed || !this.repository.read(room.state.conversationId) || !current()) return
      const binding = await this.bind(room, turn.memberId, () => !!current())
      if (this.disposed || !this.repository.read(room.state.conversationId) || !current()) return
      if (this.dispatchPaused.has(room.state.conversationId)) throw new RoomCheckpointError('Room dispatch awaits durable recovery')
      // A concurrent member can reach the limit while this one is binding.
      if (room.budgetPaused(turn.rootId)) {
        room.update(turn.id, { status: 'queued', phase: 'queued', startedAt: undefined })
        this.publish(room)
        this.checkpoint(room)
        return
      }
      room.update(turn.id, { cursorSeq: room.state.nextSeq - 1, memberName: room.members.find(m => m.id === turn.memberId)?.name })
      const active = current()!
      const text = roomPrompt(room, active)
      room.update(turn.id, { startSeq: binding.lastSeen, submittedText: text, lastContactAt: this.clock.now() })
      this.publish(room)
      // Journal intent before the backend can accept it.
      if (!this.checkpoint(room)) throw new RoomCheckpointError('Could not persist the room submission journal')
      if (this.disposed || !this.repository.read(room.state.conversationId) || !current()) return
      if (this.dispatchPaused.has(room.state.conversationId)) throw new RoomCheckpointError('Room dispatch awaits durable recovery')
      const result = await this.io.request<{ status?: string }>('prompt.submit', {
        profile: binding.profile, session_id: binding.runtimeId, text, surface: 'desktop',
      })
      if (result.status !== 'streaming') throw new Error('Serve did not start an isolated room turn')
    } catch (error) {
      const binding = room.state.bindings[turn.memberId]
      const active = current()
      if (!active) return
      if (error instanceof RoomCheckpointError) {
        this.releaseClaim(room, turn)
        this.publish(room)
        return
      }
      if (binding && active.submittedText &&
        /timeout|timed out|disconnect|(?:websocket|client) closed|did not start/i.test(error instanceof Error ? error.message : '')) {
        room.setBinding(turn.memberId, { ...binding, blocked: true })
        room.update(turn.id, { phase: 'reading', activity: 'reconciling submission' })
        this.publish(room)
        return
      }
      if (binding && active.submittedText && error instanceof ServeRpcError && error.code === 4001) {
        room.setBinding(turn.memberId, { ...binding, closed: true })
        this.attached.delete(`${room.state.conversationId}:${turn.memberId}`)
      }
      room.complete(turn.id, { error: error instanceof Error ? error.message : 'Room submission failed' })
      this.publish(room)
      if (this.checkpoint(room)) this.wake(room)
    }
  }

  handleEvent(event: ServeEvent, fromReplay = false): boolean {
    if (this.disposed) return true
    if (!event.session_id) return false
    if (this.retiredSessions.has(event.session_id)) return true
    // These requests are rendered/answered by the owning transport, not as room output.
    if (event.type === 'request.cancel' || event.type.endsWith('.request')) return false
    const conversation = this.conversationForSession(event.session_id)
    if (!conversation) return false
    const record = this.repository.read(conversation.id)
    // An orphaned binding is still internal, but cannot own output or requests.
    if (!record?.definition || record.conversation.target.type !== 'group') return true
    const buffer = this.replayBuffers.get(event.session_id)
    if (buffer && !fromReplay) {
      if (!buffer.current()) return true
      if (buffer.events.length >= MAX_ROOM_REPLAY_EVENTS) {
        const disposable = buffer.events.findIndex(event => !replayCritical(event))
        if (disposable < 0) { buffer.invalidated = true; return true }
        buffer.events.splice(disposable, 1)
      }
      buffer.events.push(event)
      return true
    }
    const room = this.get(conversation.id)
    const entry = Object.entries(room.state.bindings).find(([, b]) => b.runtimeId === event.session_id)
    if (!entry) return true
    const [memberId, binding] = entry
    if (binding.closed) return true
    if (typeof event.seq === 'number') {
      if (event.seq <= binding.lastSeen) return true
      room.setBinding(memberId, { ...binding, lastSeen: event.seq })
    }
    const closed = event.type === 'session.closed' || event.type === 'session.reclaimed'
    if (closed) {
      room.setBinding(memberId, { ...room.state.bindings[memberId]!, closed: true })
      this.attached.delete(`${conversation.id}:${memberId}`)
    }
    const turn = room.state.turns.find(t => t.memberId === memberId && t.status === 'running')
    const payload = (event.payload ?? {}) as Record<string, unknown>
    if (turn) room.update(turn.id, { lastContactAt: this.clock.now() })
    if (event.type === 'session.usage') {
      // ~1/s per member: journal only the transition that pauses a request.
      const before = room.state
      const rootId = room.recordUsage(memberId, payload.usage ?? payload)
      this.publish(room)
      if (rootId && !isRoomBudgetPaused(before, rootId) && room.budgetPaused(rootId)) this.checkpoint(room)
      return true
    }
    if (!turn) {
      if (event.type === 'message.complete' || closed) room.recordUsage(memberId, payload.usage)
      if ((event.type === 'message.complete' || closed) && binding.blocked) {
        room.setBinding(memberId, { ...room.state.bindings[memberId]!, blocked: false })
        this.io.clearSessionRequests(binding.runtimeId, conversation.id)
      }
      this.publish(room)
      if ((event.type === 'message.complete' || closed) && this.checkpoint(room)) this.wake(room)
      return true
    }
    if (event.type === 'message.delta' || (event.type === 'message.interim' && payload.already_streamed !== true)) {
      room.update(turn.id, { partialText: turn.partialText + (typeof payload.text === 'string' ? payload.text : ''), phase: 'typing', activity: null })
    } else if (event.type === 'tool.start' || event.type === 'tool.generating') {
      const toolEvents = isRenderUiTool(payload.name) && typeof payload.tool_id === 'string'
        ? turn.toolEvents?.filter(e => e.toolCallId !== payload.tool_id) : turn.toolEvents
      room.update(turn.id, { phase: 'working', toolEvents, activity: { tool: String(payload.name ?? 'tool'), label: typeof payload.summary === 'string' ? payload.summary : undefined } })
    } else if (event.type === 'tool.complete') {
      const tool = typeof payload.name === 'string' ? payload.name : ''
      const callId = typeof payload.tool_id === 'string' ? payload.tool_id : ''
      let toolEvents = turn.toolEvents
      if (isRenderUiTool(tool) && callId && callId.length <= 256) {
        toolEvents = (toolEvents ?? []).filter(e => e.toolCallId !== callId)
        const result = genUiResultFromResult(payload)
        if (result && toolEvents.length < MAX_GENUI_CALLS)
          toolEvents.push({ tool, toolCallId: callId, status: 'completed', ...result })
      }
      room.update(turn.id, { phase: 'reading', activity: null, toolEvents })
    } else if (event.type === 'status.update') {
      room.update(turn.id, { phase: 'working', activity: typeof payload.text === 'string' ? payload.text : null })
    } else if (event.type === 'message.complete' || closed) {
      room.recordUsage(memberId, payload.usage)
      const failed = payload.status === 'error' || (typeof payload.error === 'string' && !!payload.error)
      const messageCount = room.state.messages.length
      room.complete(turn.id, {
        text: typeof payload.text === 'string' ? payload.text : turn.partialText,
        cancelled: payload.status === 'interrupted' || event.type !== 'message.complete',
        error: failed ? String(payload.error || 'Hermes could not finish this room turn') : undefined,
      })
      if (binding.blocked) room.setBinding(memberId, { ...room.state.bindings[memberId]!, blocked: false })
      this.io.clearSessionRequests(binding.runtimeId, conversation.id)
      this.publish(room, room.state.messages.length > messageCount)
      if (this.checkpoint(room)) this.wake(room)
      return true
    }
    this.publish(room)
    return true
  }

  private quarantine(room: LocalRoomEngine, turns: LocalRoomTurn[]): void {
    const generation = this.epochGeneration
    for (const turn of turns) {
      if (this.disposed || generation !== this.epochGeneration) return
      const binding = room.state.bindings[turn.memberId]
      if (binding) {
        room.setBinding(turn.memberId, { ...binding, blocked: true })
        this.io.clearSessionRequests(binding.runtimeId, room.state.conversationId)
      }
    }
  }

  private async interrupt(room: LocalRoomEngine, turns: LocalRoomTurn[], generation = this.epochGeneration): Promise<boolean> {
    const current = () => !this.disposed && generation === this.epochGeneration
    if (!current()) return false
    const results = await Promise.all(turns.map(async turn => {
      if (!current()) return false
      const binding = room.state.bindings[turn.memberId]
      if (!binding) return true // A claim still binding has not submitted anything.
      const key = JSON.stringify([room.state.conversationId, binding.profile, binding.runtimeId, this.epoch,
        turn.id, turn.attempts?.length ?? 0])
      const known = this.interruptInflight.get(key)
      if (known) return known
      let resolve!: (accepted: boolean) => void
      let reject!: (error: unknown) => void
      const pending = new Promise<boolean>((yes, no) => { resolve = yes; reject = no })
      // Reserve before I/O or refusal publication can synchronously reenter Stop.
      this.interruptInflight.set(key, pending)
      void (async () => {
        try {
          const result = await this.io.request<{ status?: string; interrupted?: boolean }>('session.interrupt', {
            profile: binding.profile, session_id: binding.runtimeId,
          })
          if (!current()) return false
          const accepted = result.status === 'interrupted' || result.interrupted === true
          if (!accepted) {
            room.state = { ...room.state, turns: room.state.turns.map(t => t.id === turn.id
              ? { ...t, error: 'Stopped locally; Hermes refused the interruption. Session awaiting reconciliation.' } : t) }
            this.publish(room)
          }
          return accepted
        } catch {
          if (!current()) return false
          room.state = { ...room.state, turns: room.state.turns.map(t => t.id === turn.id
            ? { ...t, error: 'Stopped locally; interruption could not be confirmed. Session awaiting reconciliation.' } : t) }
          this.publish(room)
          return false
        }
      })().finally(() => {
        // A settled refusal may be retried explicitly; never cache it as success.
        if (this.interruptInflight.get(key) === pending) this.interruptInflight.delete(key)
      }).then(resolve, reject)
      return pending
    }))
    return results.every(Boolean)
  }

  async stop(conversationId: string): Promise<boolean> {
    const generation = this.epochGeneration
    const current = () => !this.disposed && generation === this.epochGeneration
    const room = this.get(conversationId)
    const hadWork = room.state.turns.some(t => t.status === 'running' || t.status === 'queued')
    // An unsent claim has nothing to interrupt or quarantine; its start() bails.
    const running = room.cancel().filter(t => t.submittedText)
    // Local cancellation does not prove a refused backend interruption settled.
    const quarantined = Object.entries(room.state.bindings).flatMap(([memberId, binding]) => {
      if (!binding.blocked || binding.closed) return []
      const turn = room.state.turns.findLast(t => t.memberId === memberId && wasSubmitted(t) &&
        ['cancelled', 'error', 'timeout'].includes(t.status))
      return turn && !running.some(t => t.id === turn.id) ? [turn] : []
    })
    this.quarantine(room, running)
    if (!current()) return false
    this.publish(room)
    if (!current()) return false
    this.checkpoint(room)
    return (hadWork || quarantined.length > 0) && await this.interrupt(room, [...running, ...quarantined], generation)
  }

  /** Restore running work, never resubmit an uncertain accepted prompt. */
  recover(conversationId: string, force = false): Promise<void> {
    return this.recoverRoom(conversationId, force, true)
  }

  private recoverRoom(conversationId: string, force: boolean, resumeQueued: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const generation = this.epochGeneration
    const known = this.recovering.get(conversationId)
    if (known) return resumeQueued ? known.then(() => {
      if (this.disposed || generation !== this.epochGeneration || !this.dispatchPaused.has(conversationId) ||
        !this.repository.read(conversationId)?.definition) return
      const room = this.get(conversationId)
      this.publish(room)
      if (this.checkpoint(room)) {
        this.dispatchPaused.delete(conversationId)
        this.wake(room)
      }
    }) : known
    if (!force && this.recovered.has(conversationId) && !(resumeQueued && this.dispatchPaused.has(conversationId))) return Promise.resolve()
    const attempt: Promise<void> = this.reconcile(conversationId, resumeQueued).finally(() => {
      if (this.recovering.get(conversationId) === attempt) this.recovering.delete(conversationId)
    })
    this.recovering.set(conversationId, attempt)
    return attempt
  }

  async recoverAll(reconnect = false): Promise<void> {
    if (reconnect) { this.attached.clear(); this.recovered.clear() }
    for (const c of this.repository.list()) if (c.target.type === 'group' && c.localRoom) {
      // Earlier recoveries can outlive another room or its group definition.
      const record = this.repository.read(c.id)
      if (!record?.definition || record.conversation.target.type !== 'group') continue
      await this.recover(c.id, reconnect)
    }
  }

  private async reconcile(conversationId: string, resumeQueued: boolean): Promise<void> {
    const generation = this.epochGeneration
    const room = this.get(conversationId)
    for (const memberId of new Set([
      ...room.state.turns.filter(t => t.status === 'running' && !this.starting.has(t.id)).map(t => t.memberId),
      ...Object.entries(room.state.bindings).filter(([, b]) => b.blocked).map(([id]) => id),
    ])) {
      if (this.disposed || generation !== this.epochGeneration) return
      let turn = room.state.turns.find(t => t.memberId === memberId && t.status === 'running')
      // A durable claim without submission intent cannot have reached prompt.submit.
      // Requeue it after a crash; an intent-bearing turn still needs replay, never retry.
      if (turn && !turn.submittedText && !this.starting.has(turn.id)) {
        this.releaseClaim(room, turn)
        turn = undefined
        if (!room.state.bindings[memberId]?.blocked) continue
      }
      if (turn?.startedAt && this.clock.now() - Date.parse(turn.startedAt) >= 3 * 60 * 60_000) {
        room.complete(turn.id, { timeout: true, error: 'Room member reached the three-hour hung-turn backstop.' })
        this.quarantine(room, [turn])
        this.publish(room)
        await this.interrupt(room, [turn], generation)
        continue
      }
      if (!room.state.bindings[memberId]) {
        if (turn) room.complete(turn.id, { error: 'Room execution was interrupted before session binding; send a new request.' })
        continue
      }
      let replaySessionId: string | undefined
      let buffer: RoomReplayBuffer | undefined
      let current = () => false
      let apply: ((events: ServeEvent[], latestSeq?: number) => void) | undefined
      try {
        const binding = await this.bind(room, memberId)
        if (this.disposed || generation !== this.epochGeneration) return
        const reconcileRequests = this.io.captureSessionRequests(
          [binding.runtimeId, room.state.bindings[memberId]!.storedId], conversationId)
        let lastSeen = binding.lastSeen
        const epoch = this.epoch
        const startSeq = turn?.startSeq ?? lastSeen
        const attempt = turn?.attempts?.length ?? 0
        const turnId = turn?.id, turnStartSeq = turn?.startSeq, startedAt = turn?.startedAt, rootId = turn?.rootId
        const owns = () => {
          const record = this.repository.read(conversationId)
          const latest = room.state.bindings[memberId]
          const owner = room.state.turns.find(t => t.id === turnId)
          return !this.disposed && !!record?.definition && record.conversation.target.type === 'group' &&
            this.rooms.get(conversationId) === room && this.epoch === epoch &&
            latest?.runtimeId === binding.runtimeId && latest.storedId === binding.storedId &&
            latest.profile === binding.profile && latest.epoch === binding.epoch &&
            latest.closed === binding.closed && latest.lastSeen === lastSeen &&
            (!turn || (!!owner && owner.memberId === memberId && owner.rootId === rootId &&
              owner.startSeq === turnStartSeq && owner.startedAt === startedAt &&
              (owner.attempts?.length ?? 0) === attempt &&
              record.definition.members.some(m => m.id === memberId && m.profile === binding.profile)))
        }
        current = () => owns() && !buffer?.invalidated &&
          this.replayBuffers.get(binding.runtimeId) === buffer &&
          (!turn ? !room.state.turns.some(t => t.memberId === memberId && t.status === 'running')
            : room.state.turns.find(t => t.id === turn.id)?.status === 'running')
        replaySessionId = binding.runtimeId
        buffer = { events: [], current, invalidated: false }
        this.replayBuffers.set(binding.runtimeId, buffer)
        apply = (incoming, latestSeq) => {
          // Live frames are merged BEFORE terminal settlement, including when
          // the backend cache has truncated away the successful tool result.
          // Prefer the live copy of an overlapping sequence; apply each once.
          const sequenced = new Map<number, ServeEvent>(), unsequenced: ServeEvent[] = []
          for (const event of incoming) {
            if (!event || typeof event !== 'object' || typeof event.type !== 'string' || event.session_id !== binding.runtimeId) continue
            if (typeof event.seq === 'number') {
              if (!Number.isSafeInteger(event.seq) || event.seq <= startSeq) continue
              sequenced.set(event.seq, event)
            } else unsequenced.push(event)
          }
          const events = [...unsequenced, ...[...sequenced.values()].sort((a, b) => a.seq! - b.seq!)]
          const terminal = events.findLast(e => e.type === 'message.complete' && (e.seq ?? 0) > startSeq)
          if (terminal) {
            // Final text stays authoritative; do not append old text deltas.
            for (const event of events) {
              if ((event.seq ?? 0) >= terminal.seq! || !current()) break
              if (event.type !== 'message.complete' && replayCritical(event)) {
                this.handleEvent(event, true)
                lastSeen = room.state.bindings[memberId]?.lastSeen ?? lastSeen
              }
            }
            if (!current()) return
            this.handleEvent({ ...terminal, seq: undefined }, true)
            // Publication can reenter epoch/owner changes even synchronously.
            if (owns()) {
              const latest = room.state.bindings[memberId]!
              lastSeen = Math.max(latest.lastSeen, latestSeq ?? terminal.seq ?? 0)
              room.setBinding(memberId, { ...latest, lastSeen })
            }
          } else {
            for (const event of events) {
              if (!current()) break
              this.handleEvent(event, true)
              lastSeen = room.state.bindings[memberId]?.lastSeen ?? lastSeen
            }
          }
        }
        const replay = await this.io.request<{
          events?: ServeEvent[]; latest_seq?: number; epoch?: string; truncated?: boolean;
          open_requests?: { id: string; method: string; params: Record<string, unknown> }[] | null
        }>('session.events.since', { profile: binding.profile, session_id: binding.runtimeId, last_seen: turn?.startSeq ?? lastSeen })
        if (!current()) continue
        const matchingEpoch = !replay.epoch || !epoch || replay.epoch === epoch
        // A mismatched cache cannot advance this epoch's watermark or revoke
        // its requests. Still reconcile liveness and the current live buffer.
        apply([...(matchingEpoch && Array.isArray(replay.events) ? replay.events : []).slice(0, MAX_ROOM_REPLAY_EVENTS),
          ...buffer.events.splice(0)], matchingEpoch ? replay.latest_seq : undefined)
        if (!current()) continue
        const active = await this.io.request<{ sessions?: { id: string; status: string }[] }>(
          'session.active_list', { profile: binding.profile })
        if (!current()) continue
        // A completion may have arrived while this second RPC was pending.
        apply(buffer.events.splice(0))
        if (!current()) continue
        const status = active.sessions?.find(s => s.id === binding.runtimeId)?.status
        if (status === 'working' || status === 'starting' || status === 'waiting') {
          if (turn) room.update(turn.id, { lastContactAt: this.clock.now() })
        } else if (status === 'idle') {
          if (turn) room.complete(turn.id, { error: 'Room execution was interrupted or its completion was lost; reconciled without resubmitting. Send a new request if needed.', retryable: false })
          room.setBinding(memberId, { ...room.state.bindings[memberId]!, blocked: false, lastSeen: Math.max(lastSeen, matchingEpoch ? replay.latest_seq ?? 0 : 0) })
          this.io.clearSessionRequests(binding.runtimeId, conversationId)
        }
        if (turn && status !== 'idle' && matchingEpoch) reconcileRequests(replay.open_requests)
        if (turn && !status && this.clock.now() - (turn.lastContactAt ?? Date.parse(turn.startedAt ?? turn.createdAt)) >= 8 * 60_000)
          await this.loseContact(room, turn)
      } catch (error) {
        // A failed replay read must not discard a valid current live buffer,
        // or time out a turn whose terminal result is already available.
        if (buffer && current()) apply?.(buffer.events.splice(0))
        if (!(error instanceof RoomCheckpointError) && !this.disposed && generation === this.epochGeneration &&
          turn && room.state.turns.find(t => t.id === turn.id)?.status === 'running' &&
          (!buffer || current()) &&
          this.clock.now() - (turn.lastContactAt ?? Date.parse(turn.startedAt ?? turn.createdAt)) >= 8 * 60_000)
          await this.loseContact(room, turn)
      } finally {
        if (replaySessionId) {
          if (buffer && current()) apply?.(buffer.events.splice(0))
          // Do not drain/delete a replacement context, or an old epoch's data.
          if (this.replayBuffers.get(replaySessionId) === buffer) this.replayBuffers.delete(replaySessionId)
        }
      }
    }
    if (!this.disposed && generation === this.epochGeneration && this.repository.read(conversationId)) {
      this.recovered.add(conversationId)
      this.publish(room)
      if (this.checkpoint(room)) {
        if (resumeQueued) this.dispatchPaused.delete(conversationId)
        this.wake(room)
      }
    }
  }

  private async loseContact(room: LocalRoomEngine, turn: LocalRoomTurn): Promise<void> {
    const generation = this.epochGeneration
    room.complete(turn.id, { error: 'Lost contact with this room member. Execution reconciled without resubmitting.', retryable: false })
    this.quarantine(room, [turn])
    if (this.disposed || generation !== this.epochGeneration) return
    this.publish(room)
    await this.interrupt(room, [turn], generation)
  }

  async attachmentSession(conversationId: string): Promise<LocalRoomBinding> {
    if (this.disposed) throw new Error('Room attachment ownership changed. Try again.')
    const generation = this.epochGeneration
    const room = this.get(conversationId)
    const current = () => !this.disposed && generation === this.epochGeneration &&
      this.rooms.get(conversationId) === room
    if (!current()) throw new Error('Room attachment ownership changed. Try again.')
    const member = room.members.find(m => m.id === room.chiefId) ?? room.members[0]
    if (!member) throw new Error('This room has no local member for attachments')
    const binding = await this.bind(room, member.id)
    if (!current()) throw new Error('Room attachment ownership changed. Try again.')
    const latestRoom = this.get(conversationId)
    const latestMember = latestRoom.members.find(m => m.id === latestRoom.chiefId) ?? latestRoom.members[0]
    const latestBinding = latestRoom.state.bindings[member.id]
    if (!current() || latestMember?.id !== member.id || latestMember.profile !== binding.profile ||
      latestBinding?.runtimeId !== binding.runtimeId || latestBinding.storedId !== binding.storedId ||
      latestBinding.profile !== binding.profile || latestBinding.epoch !== binding.epoch || latestBinding.closed)
      throw new Error('Room member changed while preparing attachments. Try again.')
    return binding
  }

  async setTokenBudget(conversationId: string, limit: number): Promise<boolean> {
    const room = this.get(conversationId), before = room.state
    room.setTokenBudget(limit)
    this.publish(room)
    if (!this.checkpoint(room)) {
      room.state = before
      this.publish(room)
      return false
    }
    this.dispatchPaused.delete(conversationId)
    this.wake(room)
    return true
  }

  async retry(conversationId: string): Promise<boolean> {
    const generation = this.epochGeneration
    const room = this.get(conversationId)
    const root = room.state.messages.findLast(m => m.speakerKind === 'human')
    if (!root) return false
    await this.recover(conversationId, true)
    // Recovery cannot retarget an explicit retry to a newer human request.
    if (this.disposed || generation !== this.epochGeneration || this.rooms.get(conversationId) !== room ||
      this.get(conversationId).state.messages.findLast(m => m.speakerKind === 'human')?.id !== root.id) return false
    const before = room.state
    if (!room.retry(root.id)) return false
    this.publish(room)
    if (!this.checkpoint(room)) {
      room.state = before
      this.publish(room)
      return false
    }
    this.dispatchPaused.delete(conversationId)
    this.wake(room)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.release()
    this.cancelTimer()
    this.wakeRequested.clear()
    for (const room of this.rooms.values()) for (const binding of Object.values(room.state.bindings))
      this.io.clearSessionRequests(binding.runtimeId, room.state.conversationId)
    this.repository.checkpoint()
  }
}
