/**
 * Cross-device conversation sync (hermes-deploy `/api/chat/sync`).
 *
 * Postgres holds the conversation list; each device caches it in the store
 * and applies a change feed. Local edits go out through a persisted outbox
 * (PUT/DELETE /api/chat/threads/:id and /api/chat/groups/:id), coalesced per
 * id and retried with backoff, so they survive a reload or a dead network.
 *
 * Apply rule: the server row wins for every field EXCEPT the fields an outbox
 * op for that id is still carrying — those are newer local intent. Tombstones
 * remove the conversation and its messages; a `reset` snapshot drops local
 * rows it does not list (unless the outbox still owns them).
 *
 * `roster.json` no longer carries conversations or groups (agents only).
 */

import type { AgentsState, ConversationSyncSink, LiveTurn } from './store'
import {
  currentStoreEpoch,
  getConversationSyncSink,
  getHydrateStatus,
  getState,
  setHydrateStatus,
  setState,
} from './store'
import type { ChatMessage, Conversation, Group, ThreadRef } from './types'
import { expireDeletedConversation, isDeletedConversation } from './tombstones'
import { logger } from '../logger'

/**
 * Poll cadence while someone is using the app. Idle / unfocused windows back
 * off to 1 min then 5 min (lib/poll-cadence) and refresh at once on return —
 * each poll is a platform function call + Redis commands.
 */
export const CONV_SYNC_POLL_MS = 10_000

const CURSOR_PREFIX = 'maia:conv-sync:v1:'
// Both keys start with `maia:conv-sync` — clearPersistedState drops them.
const OUTBOX_PREFIX = 'maia:conv-sync-outbox:v1:'

const PAGE_LIMIT = 200
/** hasMore pages chained in one sync before yielding to the next poll. */
const MAX_PAGES_PER_SYNC = 25
const FLUSH_DEBOUNCE_MS = 250
const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 5 * 60 * 1000
/** A 4xx the server will never accept (bad body, missing route) is dropped
 *  after this many tries instead of retrying forever. */
const MAX_REJECTED_ATTEMPTS = 3
/** After a DELETE is acked the tombstone only has to outlive one in-flight
 *  poll that was computed before the delete committed. */
const TOMBSTONE_GRACE_MS = 2 * 60 * 1000
const DEFAULT_TITLE = 'New conversation'

export interface ConversationDTO {
  id: string
  kind: 'agent' | 'group'
  targetId: string
  sessionId: string | null
  memberSessions: Record<string, string> | null
  title: string
  titleSource: 'auto' | 'user'
  hidden: boolean
  pinned: boolean
  preview: string
  lastTurnAt: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface GroupDTO {
  id: string
  name: string
  memberAgentIds: string[]
  extra: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface LiveTurnDTO {
  /** Null while the server can't map the session yet (a group member session
   *  whose room PUT hasn't landed) — resolved client-side by session id. */
  conversationId: string | null
  sessionId: string
  turnId: string
  status: 'pending' | 'streaming' | 'queued' | 'dispatching'
  updatedAt: string
}

export interface SyncPage {
  conversations: ConversationDTO[]
  groups: GroupDTO[]
  live: LiveTurnDTO[]
  cursor: string
  hasMore: boolean
  reset: boolean
}

/** PUT /api/chat/threads/:id body — every key optional (partial update). */
export interface ThreadPutBody {
  kind?: 'agent' | 'group'
  targetId?: string
  sessionId?: string
  memberSessions?: Record<string, string>
  title?: string
  titleSource?: 'auto' | 'user'
  hidden?: boolean
  pinned?: boolean
}

/** PUT /api/chat/groups/:id body. `extra` round-trips the other Group fields. */
export interface GroupPutBody {
  name?: string
  memberAgentIds?: string[]
  extra?: Record<string, unknown>
}

export type SyncEntity = 'thread' | 'group'

export interface OutboxOp {
  entity: SyncEntity
  id: string
  op: 'put' | 'delete'
  body?: ThreadPutBody | GroupPutBody
  attempts: number
  /** Epoch ms before which the op is not retried (backoff). */
  nextAt: number
  /** Bumped on every coalesce; an ack only clears the op when unchanged. */
  rev: number
  /** Delete only: session ids tombstoned with the row (expired on ack). */
  sessionIds?: string[]
}

function opKey(entity: SyncEntity, id: string): string {
  return `${entity}:${id}`
}

/**
 * Fold a new op into the pending one for the same id. Puts merge field-wise
 * (latest value wins); a delete supersedes everything; a put never revives a
 * pending delete. Backoff state is kept so new edits can't hammer a server
 * that is already failing.
 */
export function coalesceOutboxOp(existing: OutboxOp | undefined, incoming: OutboxOp): OutboxOp {
  if (!existing) return incoming
  if (existing.op === 'delete') return existing
  if (incoming.op === 'delete') {
    return { ...incoming, rev: existing.rev + 1, attempts: 0 }
  }
  return {
    ...existing,
    body: { ...existing.body, ...incoming.body },
    rev: existing.rev + 1,
  }
}

/** Store fields an outbox put is still carrying (server must not overwrite). */
export function pendingFieldsOf(op: OutboxOp | undefined): ReadonlySet<string> {
  if (!op || op.op !== 'put' || !op.body) return new Set()
  const out = new Set<string>()
  for (const key of Object.keys(op.body)) {
    if (op.entity === 'thread') {
      if (key === 'kind' || key === 'targetId') out.add('target')
      else if (key === 'titleSource') out.add('title')
      else out.add(key)
    } else {
      out.add(key)
    }
  }
  return out
}

/** What the apply step needs to know about the outbox. */
export interface PendingView {
  op(entity: SyncEntity, id: string): OutboxOp | undefined
}

/**
 * Server row → thread target. Server-minted rows (legacy clients, Telegram,
 * a turn that landed before our PUT) carry `targetId: ""` — they belong to
 * the paired default agent.
 */
function targetOf(dto: Pick<ConversationDTO, 'kind' | 'targetId'>, defaultAgentId = ''): ThreadRef {
  if (!dto.targetId) return { type: 'agent', agentId: defaultAgentId }
  return dto.kind === 'group'
    ? { type: 'group', groupId: dto.targetId }
    : { type: 'agent', agentId: dto.targetId }
}

function sameTarget(a: ThreadRef, b: ThreadRef): boolean {
  if (a.type !== b.type) return false
  return a.type === 'agent'
    ? a.agentId === (b as { agentId: string }).agentId
    : a.groupId === (b as { groupId: string }).groupId
}

function sameRecord(a?: Record<string, string>, b?: Record<string, string>): boolean {
  const ka = Object.keys(a ?? {})
  const kb = Object.keys(b ?? {})
  if (ka.length !== kb.length) return false
  return ka.every((k) => a?.[k] === b?.[k])
}

function sameConversation(a: Conversation, b: Conversation): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    sameTarget(a.target, b.target) &&
    a.createdAt === b.createdAt &&
    a.lastUsedAt === b.lastUsedAt &&
    a.hermesSessionId === b.hermesSessionId &&
    sameRecord(a.memberSessionIds, b.memberSessionIds) &&
    Boolean(a.hiddenFromSidebar) === Boolean(b.hiddenFromSidebar) &&
    Boolean(a.pinned) === Boolean(b.pinned) &&
    a.preview === b.preview &&
    Boolean(a.placeholder) === Boolean(b.placeholder)
  )
}

/** Server row → store conversation, keeping fields the outbox still owns. */
export function conversationFromDto(
  dto: ConversationDTO,
  existing: Conversation | undefined,
  pending: ReadonlySet<string>,
  defaultAgentId = '',
): Conversation {
  const lastTurn = dto.lastTurnAt ?? ''
  const base: Conversation = existing ?? {
    id: dto.id,
    title: DEFAULT_TITLE,
    target: targetOf(dto, defaultAgentId),
    createdAt: dto.createdAt,
    lastUsedAt: lastTurn || dto.createdAt,
  }
  const next: Conversation = { ...base, id: dto.id }
  delete next.placeholder
  // An empty server target is "unknown", never a reason to drop a real one.
  if (!pending.has('target') && (dto.targetId || !existing)) {
    next.target = targetOf(dto, defaultAgentId)
  }
  // An empty server title means "no turn yet" — keep the local label.
  if (!pending.has('title') && dto.title) next.title = dto.title
  if (!pending.has('hidden')) {
    if (dto.hidden) next.hiddenFromSidebar = true
    else delete next.hiddenFromSidebar
  }
  if (!pending.has('pinned')) {
    if (dto.pinned) next.pinned = true
    else delete next.pinned
  }
  // A room's sessions are its member sessions. A primary sessionId on a group
  // row is a touch-before-PUT artifact (a member's session), never the room's.
  if (!pending.has('sessionId') && dto.sessionId && next.target.type !== 'group') {
    next.hermesSessionId = dto.sessionId
  }
  if (!pending.has('memberSessions') && dto.memberSessions && Object.keys(dto.memberSessions).length > 0) {
    next.memberSessionIds = { ...dto.memberSessions }
  }
  if (dto.preview) next.preview = dto.preview
  // Only a real turn moves a row, and never backward: a local send's touch
  // can be a hair newer than the server's turn timestamp.
  if (lastTurn && lastTurn > next.lastUsedAt) next.lastUsedAt = lastTurn
  return next
}

/** Server group → store group, keeping fields the outbox still owns. */
export function groupFromDto(
  dto: GroupDTO,
  existing: Group | undefined,
  pending: ReadonlySet<string>,
): Group {
  const extra = dto.extra ?? {}
  const next: Group = existing
    ? { ...existing }
    : {
        id: dto.id,
        name: dto.name,
        memberAgentIds: [...dto.memberAgentIds],
        primaryAgentId: dto.memberAgentIds[0] ?? '',
        createdAt: dto.createdAt,
      }
  if (!pending.has('name') && dto.name) next.name = dto.name
  if (!pending.has('memberAgentIds') && Array.isArray(dto.memberAgentIds)) {
    next.memberAgentIds = [...dto.memberAgentIds]
  }
  if (!pending.has('extra')) {
    const primary = typeof extra.primaryAgentId === 'string' ? extra.primaryAgentId : ''
    if (primary) next.primaryAgentId = primary
    if (typeof extra.summary === 'string') next.summary = extra.summary
    if (typeof extra.inviteLink === 'string') next.inviteLink = extra.inviteLink
    if (Array.isArray(extra.remoteMembers)) {
      next.remoteMembers = extra.remoteMembers.filter((m): m is string => typeof m === 'string')
    }
    if (typeof extra.autoNamed === 'boolean') next.autoNamed = extra.autoNamed
  }
  if (!next.memberAgentIds.includes(next.primaryAgentId)) {
    next.primaryAgentId = next.memberAgentIds[0] ?? next.primaryAgentId
  }
  return next
}

/** Store group → PUT body (non-core fields ride in `extra`). `more` adds
 *  server-read extras the store group does not carry (room member profiles). */
export function groupPutBody(group: Group, more?: Record<string, unknown>): GroupPutBody {
  const extra: Record<string, unknown> = { primaryAgentId: group.primaryAgentId }
  if (group.summary !== undefined) extra.summary = group.summary
  if (group.inviteLink !== undefined) extra.inviteLink = group.inviteLink
  if (group.remoteMembers !== undefined) extra.remoteMembers = group.remoteMembers
  if (group.autoNamed !== undefined) extra.autoNamed = group.autoNamed
  return { name: group.name, memberAgentIds: [...group.memberAgentIds], extra: { ...extra, ...more } }
}

function sameGroup(a: Group, b: Group): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.primaryAgentId === b.primaryAgentId &&
    a.memberAgentIds.join('\0') === b.memberAgentIds.join('\0') &&
    a.summary === b.summary &&
    a.inviteLink === b.inviteLink &&
    a.autoNamed === b.autoNamed &&
    (a.remoteMembers ?? []).join('\0') === (b.remoteMembers ?? []).join('\0')
  )
}

type SyncSlice = Pick<
  AgentsState,
  'conversations' | 'groups' | 'messagesByThreadId' | 'selectedConversationId' | 'subagentsById' | 'turnsById'
>

/** Pinned first, then most recently used — the sidebar's order. */
function firstVisibleId(conversations: Conversation[]): string | null {
  const visible = conversations
    .filter((c) => !c.hiddenFromSidebar)
    .sort((a, b) => {
      const pin = Number(!!b.pinned) - Number(!!a.pinned)
      if (pin !== 0) return pin
      return a.lastUsedAt < b.lastUsedAt ? 1 : -1
    })
  return visible[0]?.id ?? conversations[0]?.id ?? null
}

/** Remove conversations (and their cached messages) from a slice. */
export function removeConversations<S extends SyncSlice>(state: S, ids: ReadonlySet<string>): S {
  if (ids.size === 0 || !state.conversations.some((c) => ids.has(c.id))) return state
  const conversations = state.conversations.filter((c) => !ids.has(c.id))
  const messagesByThreadId = { ...state.messagesByThreadId }
  for (const id of ids) delete messagesByThreadId[id]
  const selectedConversationId =
    state.selectedConversationId && ids.has(state.selectedConversationId)
      ? firstVisibleId(conversations)
      : state.selectedConversationId
  return { ...state, conversations, messagesByThreadId, selectedConversationId }
}

/**
 * Move a local conversation onto the server's canonical id: the row, its
 * cached messages (threadId rewritten), selection, subagent runs and turns.
 * When the canonical row is already local too, the two collapse into it.
 */
export function rekeyConversation<S extends SyncSlice>(state: S, fromId: string, toId: string): S {
  if (fromId === toId) return state
  const from = state.conversations.find((c) => c.id === fromId)
  if (!from) return state
  const into = state.conversations.find((c) => c.id === toId)
  const conversations = into
    ? state.conversations.filter((c) => c.id !== fromId)
    : state.conversations.map((c) => (c.id === fromId ? { ...c, id: toId } : c))
  const messagesByThreadId = { ...state.messagesByThreadId }
  const moved = messagesByThreadId[fromId]
  delete messagesByThreadId[fromId]
  const kept = messagesByThreadId[toId]
  if (moved && moved.length > 0 && !(kept && kept.some(isRealMessage))) {
    messagesByThreadId[toId] = moved.map((m) => ({ ...m, threadId: toId }))
  }
  let subagentsById = state.subagentsById
  if (Object.values(subagentsById).some((r) => r.conversationId === fromId)) {
    subagentsById = Object.fromEntries(
      Object.entries(subagentsById).map(([k, r]) => [
        k,
        r.conversationId === fromId ? { ...r, conversationId: toId } : r,
      ]),
    )
  }
  let turnsById = state.turnsById
  if (Object.values(turnsById).some((t) => t.threadId === fromId)) {
    turnsById = Object.fromEntries(
      Object.entries(turnsById).map(([k, t]) => [k, t.threadId === fromId ? { ...t, threadId: toId } : t]),
    )
  }
  return {
    ...state,
    conversations,
    messagesByThreadId,
    subagentsById,
    turnsById,
    selectedConversationId: state.selectedConversationId === fromId ? toId : state.selectedConversationId,
  }
}

function isRealMessage(m: ChatMessage): boolean {
  return m.role === 'user' || m.role === 'agent'
}

export interface ApplyOptions {
  /** A local send owns this conversation: never re-key it mid-stream. */
  isBusy?: (conversationId: string) => boolean
  /** Agent for server rows with an empty targetId (the paired default agent). */
  defaultAgentId?: string
}

export interface ApplyResult<S extends SyncSlice> {
  state: S
  changed: boolean
  /** Local ids moved onto a canonical server id: [from, to]. */
  rekeys: Array<[string, string]>
  /** Local rows matched by session but left un-keyed (busy) — re-PUT later so
   *  the 409 path finishes the re-key. */
  deferred: Array<{ localId: string; sessionId: string }>
  /** Live server rows whose session this device deleted under another id. */
  staleServerIds: string[]
}

/**
 * Apply one sync page (pure). Server rows win except outbox-owned fields;
 * rows this device is deleting stay gone; tombstones remove rows + messages.
 */
export function applySyncPage<S extends SyncSlice>(
  input: S,
  page: Pick<SyncPage, 'conversations' | 'groups'>,
  pending: PendingView,
  opts: ApplyOptions = {},
): ApplyResult<S> {
  let state = input
  let changed = false
  const rekeys: Array<[string, string]> = []
  const deferred: Array<{ localId: string; sessionId: string }> = []
  const staleServerIds: string[] = []
  const removed = new Set<string>()
  let sawLiveRow = false

  for (const dto of page.conversations ?? []) {
    if (!dto?.id) continue
    if (dto.deletedAt) {
      const ids = new Set<string>([dto.id])
      // A local copy still keyed by the session (never re-keyed) is the same chat.
      if (dto.sessionId) {
        for (const c of state.conversations) {
          if (c.hermesSessionId === dto.sessionId && c.id !== dto.id && !pending.op('thread', c.id)) {
            ids.add(c.id)
          }
        }
      }
      const next = removeConversations(state, ids)
      if (next !== state) {
        state = next
        changed = true
        for (const id of ids) removed.add(id)
      }
      continue
    }
    if (pending.op('thread', dto.id)?.op === 'delete') continue
    if (isDeletedConversation(dto.id) || (dto.sessionId && isDeletedConversation(dto.sessionId))) {
      // Deleted on this device (possibly under another local id, or before
      // deletes reached the server): converge the server copy too.
      staleServerIds.push(dto.id)
      continue
    }
    sawLiveRow = true
    let existing = state.conversations.find((c) => c.id === dto.id)
    if (!existing && dto.kind === 'agent' && dto.sessionId) {
      const bySession = state.conversations.find((c) => c.hermesSessionId === dto.sessionId)
      if (bySession && pending.op('thread', bySession.id)?.op !== 'delete') {
        if (opts.isBusy?.(bySession.id)) {
          deferred.push({ localId: bySession.id, sessionId: dto.sessionId })
          continue
        }
        state = rekeyConversation(state, bySession.id, dto.id)
        rekeys.push([bySession.id, dto.id])
        changed = true
        existing = state.conversations.find((c) => c.id === dto.id)
      }
    }
    const next = conversationFromDto(
      dto,
      existing,
      pendingFieldsOf(pending.op('thread', dto.id)),
      opts.defaultAgentId,
    )
    if (existing && sameConversation(existing, next)) continue
    state = {
      ...state,
      conversations: existing
        ? state.conversations.map((c) => (c.id === dto.id ? next : c))
        : [...state.conversations, next],
    }
    changed = true
  }

  // The synthesized forever-chat is not server state: once the server lists
  // real rows, an unused placeholder only duplicates them.
  if (sawLiveRow) {
    const stale = new Set(
      state.conversations
        .filter(
          (c) =>
            c.placeholder &&
            !pending.op('thread', c.id) &&
            !(state.messagesByThreadId[c.id] ?? []).some(isRealMessage),
        )
        .map((c) => c.id),
    )
    const next = removeConversations(state, stale)
    if (next !== state) {
      state = next
      changed = true
    }
  }

  for (const dto of page.groups ?? []) {
    if (!dto?.id) continue
    const existing = state.groups.find((g) => g.id === dto.id)
    if (dto.deletedAt) {
      if (existing) {
        state = { ...state, groups: state.groups.filter((g) => g.id !== dto.id) }
        changed = true
      }
      continue
    }
    if (pending.op('group', dto.id)?.op === 'delete') continue
    const next = groupFromDto(dto, existing, pendingFieldsOf(pending.op('group', dto.id)))
    if (existing && sameGroup(existing, next)) continue
    state = {
      ...state,
      groups: existing ? state.groups.map((g) => (g.id === dto.id ? next : g)) : [...state.groups, next],
    }
    changed = true
  }

  return { state, changed, rekeys, deferred, staleServerIds }
}

/**
 * After a full `reset` snapshot: drop local conversations and groups the
 * server did not list, unless the outbox still owns them (not yet created
 * server-side) or they are the synthesized placeholder.
 */
export function dropUnlisted<S extends SyncSlice>(
  state: S,
  listed: { conversations: ReadonlySet<string>; groups: ReadonlySet<string> },
  pending: PendingView,
): S {
  const drop = new Set(
    state.conversations
      .filter((c) => !listed.conversations.has(c.id) && !c.placeholder && !pending.op('thread', c.id))
      .map((c) => c.id),
  )
  let next = removeConversations(state, drop)
  const groups = next.groups.filter((g) => listed.groups.has(g.id) || pending.op('group', g.id))
  if (groups.length !== next.groups.length) next = { ...next, groups }
  return next
}

/**
 * Fill in `conversationId` for live rows the server could not map yet, by
 * matching the session against local rows (primary or group member session).
 * Rows that still can't be placed are dropped.
 */
export function resolveLiveTurns(
  live: LiveTurnDTO[] | undefined,
  conversations: Conversation[],
): Array<LiveTurnDTO & { conversationId: string }> {
  const out: Array<LiveTurnDTO & { conversationId: string }> = []
  for (const row of live ?? []) {
    if (!row?.turnId) continue
    const conversationId =
      row.conversationId ||
      (row.sessionId
        ? conversations.find(
            (c) =>
              c.hermesSessionId === row.sessionId ||
              Object.values(c.memberSessionIds ?? {}).includes(row.sessionId),
          )?.id
        : undefined)
    if (conversationId) out.push({ ...row, conversationId })
  }
  return out
}

/** `live` (always the full current set) → the hydrate-status map. */
export function liveTurnsFromPage(live: LiveTurnDTO[] | undefined): Record<string, LiveTurn> {
  const out: Record<string, LiveTurn> = {}
  for (const row of live ?? []) {
    if (!row?.conversationId || !row.turnId) continue
    out[row.conversationId] = { turnId: row.turnId, sessionId: row.sessionId, status: row.status }
  }
  return out
}

function sameLiveTurns(a: Record<string, LiveTurn>, b: Record<string, LiveTurn>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every(
    (k) => a[k]?.turnId === b[k]?.turnId && a[k]?.status === b[k]?.status && a[k]?.sessionId === b[k]?.sessionId,
  )
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    /* best-effort: the outbox still works for this session */
  }
}

function parseOutbox(raw: string | null): OutboxOp[] {
  if (!raw) return []
  try {
    const rows = JSON.parse(raw) as unknown
    if (!Array.isArray(rows)) return []
    return rows.filter(
      (r): r is OutboxOp =>
        !!r &&
        typeof r === 'object' &&
        (r.entity === 'thread' || r.entity === 'group') &&
        typeof r.id === 'string' &&
        r.id !== '' &&
        (r.op === 'put' || r.op === 'delete'),
    ).map((r) => ({
      ...r,
      attempts: typeof r.attempts === 'number' ? r.attempts : 0,
      nextAt: typeof r.nextAt === 'number' ? r.nextAt : 0,
      rev: typeof r.rev === 'number' ? r.rev : 0,
    }))
  } catch {
    return []
  }
}

export function backoffMs(attempts: number): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS)
  return exp * (0.75 + Math.random() * 0.5)
}

export interface ConversationSyncOptions {
  host: string
  instanceId: string
  headers: (extra?: Record<string, string>) => Record<string, string>
  /** A local send owns this conversation's stream (never re-key it now). */
  isBusy?: (conversationId: string) => boolean
  /** A local conversation moved onto a canonical id — migrate per-id state. */
  onRekey?: (fromId: string, toId: string) => void
  /** Agent for server rows with an empty targetId (the paired default agent). */
  defaultAgentId?: string
}

export interface SyncResult {
  ok: boolean
  /** Live turns with conversationId resolved (unplaceable rows dropped). */
  live: Array<LiveTurnDTO & { conversationId: string }>
}

export class ConversationSyncEngine implements ConversationSyncSink {
  private readonly host: string
  private readonly instanceId: string
  private readonly opts: ConversationSyncOptions
  private readonly outbox = new Map<string, OutboxOp>()
  private cursor: string | null
  private syncing: Promise<SyncResult> | null = null
  private flushing: Promise<void> | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  /** Thread ids the server has confirmed this session (acked PUT or feed row). */
  private readonly serverKnown = new Set<string>()

  constructor(opts: ConversationSyncOptions) {
    this.opts = opts
    this.host = opts.host
    this.instanceId = opts.instanceId
    for (const op of parseOutbox(readStorage(this.outboxKey()))) {
      this.outbox.set(opKey(op.entity, op.id), op)
    }
    // Every launch starts from a full snapshot, never the persisted cursor.
    // A cursor can outrun the rows it covers — store discarded, a schema
    // bump, or an older build that advanced it without applying (seen in
    // the field: cursor current, sidebar stuck on months-old rows). Deltas
    // on top of that never heal; one snapshot per launch always converges,
    // and the list is small (one page, PAGE_LIMIT rows).
    this.cursor = null
    if (readStorage(this.cursorKey()) !== null) this.setCursor(null)
    // A persisted outbox (edits from before a reload) goes out with the
    // first sync(), which always flushes before it reads the feed.
  }

  private cursorKey(): string {
    return `${CURSOR_PREFIX}${this.instanceId}`
  }

  private outboxKey(): string {
    return `${OUTBOX_PREFIX}${this.instanceId}`
  }

  private setCursor(cursor: string | null): void {
    this.cursor = cursor
    writeStorage(this.cursorKey(), cursor)
  }

  private saveOutbox(): void {
    writeStorage(this.outboxKey(), this.outbox.size ? JSON.stringify([...this.outbox.values()]) : null)
  }

  /** Test seam + debugging: pending ops, oldest first. */
  pendingOps(): OutboxOp[] {
    return [...this.outbox.values()]
  }

  hasPending(entity: SyncEntity, id: string): boolean {
    return this.outbox.has(opKey(entity, id))
  }

  private readonly pendingView: PendingView = {
    op: (entity, id) => this.outbox.get(opKey(entity, id)),
  }

  /** Only the registered store sink writes: a replaced transport's engine
   *  (relink, Settings switch) must not keep sending from a stale outbox. */
  private isActive(): boolean {
    return !this.disposed && getConversationSyncSink() === this
  }

  dispose(): void {
    this.disposed = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  // --- outbox ---------------------------------------------------------------

  private enqueue(op: Omit<OutboxOp, 'attempts' | 'nextAt' | 'rev'>): void {
    if (this.disposed) return
    const key = opKey(op.entity, op.id)
    const next = coalesceOutboxOp(this.outbox.get(key), { ...op, attempts: 0, nextAt: 0, rev: 0 })
    this.outbox.set(key, next)
    this.saveOutbox()
    this.scheduleFlush(FLUSH_DEBOUNCE_MS)
  }

  /** Create-or-update a conversation. `kind`/`targetId` are always sent so the
   *  first PUT for a new id can create the row. */
  putThread(id: string, body: ThreadPutBody): void {
    const conv = getState().conversations.find((c) => c.id === id)
    const target = conv?.target
    const identity: ThreadPutBody = target
      ? target.type === 'group'
        ? { kind: 'group', targetId: target.groupId }
        : { kind: 'agent', targetId: target.agentId }
      : {}
    this.enqueue({ entity: 'thread', id, op: 'put', body: { ...identity, ...body } })
  }

  deleteThread(conv: Pick<Conversation, 'id' | 'hermesSessionId' | 'memberSessionIds'>): void {
    const sessionIds = [conv.hermesSessionId ?? '', ...Object.values(conv.memberSessionIds ?? {})].filter(Boolean)
    this.enqueue({
      entity: 'thread',
      id: conv.id,
      op: 'delete',
      ...(sessionIds.length ? { sessionIds } : {}),
    })
  }

  putGroup(group: Group, extra?: Record<string, unknown>): void {
    this.enqueue({ entity: 'group', id: group.id, op: 'put', body: groupPutBody(group, extra) })
  }

  /**
   * Send a group's pending PUT now and wait for it (bounded) — a room POST
   * needs the group (and its member profiles) on the server first. Never
   * throws; a timeout proceeds anyway.
   */
  async flushGroupNow(id: string, timeoutMs = 3000): Promise<void> {
    const key = opKey('group', id)
    const op = this.outbox.get(key)
    if (!op || op.op !== 'put' || !this.isActive()) return
    op.nextAt = 0
    const run = (async () => {
      if (this.flushing) await this.flushing
      const cur = this.outbox.get(key)
      if (cur && cur.op === 'put') await this.send(cur)
    })().catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      run,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)
  }

  deleteGroup(id: string): void {
    this.enqueue({ entity: 'group', id, op: 'delete' })
  }

  private scheduleFlush(delayMs: number): void {
    if (!this.isActive()) return
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, delayMs)
  }

  /** Send every due op (sequential — the outbox is small). The body runs
   *  synchronously up to its first fetch, so pushNow's PUT is dispatched
   *  before the caller's POST. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    // Clear the slot in a chained finally, never inside the body: with nothing
    // due the body completes synchronously, before the slot is even assigned.
    this.flushing = this.runFlush().finally(() => {
      this.flushing = null
      this.rescheduleAfterFlush()
    })
    return this.flushing
  }

  private async runFlush(): Promise<void> {
    const now = Date.now()
    for (const key of [...this.outbox.keys()]) {
      if (!this.isActive()) return
      // Re-read: an earlier send may have re-keyed or dropped this op.
      const op = this.outbox.get(key)
      if (!op || op.nextAt > now) continue
      await this.send(op)
    }
  }

  private rescheduleAfterFlush(): void {
    if (!this.isActive() || this.outbox.size === 0) return
    const soonest = Math.min(...[...this.outbox.values()].map((o) => o.nextAt))
    this.scheduleFlush(Math.max(FLUSH_DEBOUNCE_MS, soonest - Date.now()))
  }

  /**
   * Send a conversation's pending op NOW, ahead of a POST /api/chat that
   * depends on it (the server's turn touch wants the row's target and member
   * sessions). Not awaited: the PUT is dispatched first, but a slow server
   * must never delay the send — the server tolerates either order.
   */
  pushNow(id: string): void {
    const op = this.outbox.get(opKey('thread', id))
    if (!op || !this.isActive()) return
    op.nextAt = 0
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    void this.flush()
  }

  /**
   * Before the FIRST POST /api/chat of a conversation the server has not
   * confirmed yet. Only a GROUP row waits (bounded) for its create PUT: if the
   * turn's touch got there first it would create the row as a bare agent row
   * with this session as its primary, and the late PUT does not undo that.
   * An agent row never waits — the touch creates it under this client id
   * (kind agent, no target yet) and the PUT, dispatched first by pushNow,
   * fills in the target whichever lands first (hermes-deploy chat-sync.ts
   * touchConversationForTurn / putConversation). Never throws; a timeout
   * sends anyway.
   */
  async flushBeforeFirstSend(id: string, timeoutMs = 3000): Promise<void> {
    const key = opKey('thread', id)
    const op = this.outbox.get(key)
    if (
      !op ||
      op.op !== 'put' ||
      this.serverKnown.has(id) ||
      !this.isActive() ||
      !this.isGroupThread(id, op)
    ) {
      this.pushNow(id)
      return
    }
    op.nextAt = 0
    // Already on the wire: wait for that PUT alone. Otherwise send it now,
    // beside whatever else a flush is sending (send() never doubles it up).
    const run = this.send(op).catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      run,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)
  }

  private isGroupThread(id: string, op: OutboxOp): boolean {
    const kind = (op.body as ThreadPutBody | undefined)?.kind
    if (kind) return kind === 'group'
    return getState().conversations.find((c) => c.id === id)?.target.type === 'group'
  }

  private url(entity: SyncEntity, id: string): string {
    const path = entity === 'thread' ? 'threads' : 'groups'
    return (
      `${this.host}/api/chat/${path}/${encodeURIComponent(id)}` +
      `?instanceId=${encodeURIComponent(this.instanceId)}`
    )
  }

  /** Ack only when no newer edit coalesced into the op while it was in flight. */
  private ack(op: OutboxOp): void {
    const key = opKey(op.entity, op.id)
    const cur = this.outbox.get(key)
    if (cur && cur.rev === op.rev && cur.op === op.op) {
      this.outbox.delete(key)
      this.saveOutbox()
    }
  }

  private fail(op: OutboxOp, rejected: boolean): void {
    const key = opKey(op.entity, op.id)
    const cur = this.outbox.get(key)
    if (!cur) return
    cur.attempts += 1
    if (rejected && cur.attempts >= MAX_REJECTED_ATTEMPTS) {
      logger.warn('[nub] conversation sync dropped a rejected op', op.entity, op.id)
      this.outbox.delete(key)
    } else {
      cur.nextAt = Date.now() + backoffMs(cur.attempts)
    }
    this.saveOutbox()
  }

  /** Sends on the wire, by op key: a second send of the same op joins it. */
  private readonly sending = new Map<string, Promise<void>>()

  private send(op: OutboxOp): Promise<void> {
    const key = opKey(op.entity, op.id)
    const cur = this.sending.get(key)
    if (cur) return cur
    const p = this.sendOnce(op).finally(() => {
      if (this.sending.get(key) === p) this.sending.delete(key)
    })
    this.sending.set(key, p)
    return p
  }

  private async sendOnce(op: OutboxOp): Promise<void> {
    const sent = { ...op }
    let res: Response
    try {
      res = await fetch(this.url(op.entity, op.id), {
        method: op.op === 'put' ? 'PUT' : 'DELETE',
        headers: this.opts.headers({
          Accept: 'application/json',
          ...(op.op === 'put' ? { 'Content-Type': 'application/json' } : {}),
        }),
        ...(op.op === 'put' ? { body: JSON.stringify(op.body ?? {}) } : {}),
        cache: 'no-store',
      })
    } catch (err) {
      logger.warn('[nub] conversation sync unreachable', err)
      this.fail(sent, false)
      return
    }
    if (res.ok) {
      this.ack(sent)
      if (op.entity === 'thread' && op.op === 'put') this.serverKnown.add(op.id)
      if (op.op === 'delete') {
        if (op.entity === 'thread') {
          expireDeletedConversation([op.id, ...(op.sessionIds ?? [])], TOMBSTONE_GRACE_MS)
        }
        return
      }
      const body = (await res.json().catch(() => null)) as
        | { conversation?: ConversationDTO; group?: GroupDTO }
        | null
      if (op.entity === 'thread' && body?.conversation) this.applyRows({ conversations: [body.conversation], groups: [] })
      if (op.entity === 'group' && body?.group) this.applyRows({ conversations: [], groups: [body.group] })
      return
    }
    if (res.status === 410 && op.op === 'put') {
      // Deleted on another device: never resurrect — drop our copy.
      this.outbox.delete(opKey(op.entity, op.id))
      this.saveOutbox()
      this.removeLocal(op.entity, op.id)
      return
    }
    if (res.status === 409 && op.entity === 'thread' && op.op === 'put') {
      const body = (await res.json().catch(() => null)) as { canonical?: ConversationDTO } | null
      const canonical = body?.canonical
      if (canonical?.deletedAt) {
        // A tombstone owns the session: the chat was deleted elsewhere. Never
        // re-key onto it — drop our copy like a 410.
        this.outbox.delete(opKey(op.entity, op.id))
        this.saveOutbox()
        this.removeLocal(op.entity, op.id)
        return
      }
      if (canonical?.id && canonical.id !== op.id) {
        this.rekey(op.id, canonical)
        return
      }
    }
    const rejected = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 && res.status !== 401
    logger.warn('[nub] conversation sync write failed', res.status, op.entity, op.id)
    this.fail(sent, rejected)
  }

  private removeLocal(entity: SyncEntity, id: string): void {
    const epoch = currentStoreEpoch()
    if (entity === 'thread') {
      setState((prev) => {
        const next = removeConversations(prev, new Set([id]))
        return next === prev ? {} : next
      }, { epoch })
    } else {
      setState((prev) =>
        prev.groups.some((g) => g.id === id) ? { groups: prev.groups.filter((g) => g.id !== id) } : {},
      { epoch })
    }
  }

  /** 409: our session is owned by another row. Re-key onto it (unless a send
   *  owns the conversation right now — then retry shortly). */
  private rekey(fromId: string, canonical: ConversationDTO): void {
    const fromKey = opKey('thread', fromId)
    const op = this.outbox.get(fromKey)
    if (this.opts.isBusy?.(fromId)) {
      if (op) {
        op.nextAt = Date.now() + BACKOFF_BASE_MS
        this.saveOutbox()
      }
      return
    }
    this.outbox.delete(fromKey)
    if (op) {
      const toKey = opKey('thread', canonical.id)
      this.outbox.set(toKey, coalesceOutboxOp(this.outbox.get(toKey), { ...op, id: canonical.id, attempts: 0, nextAt: 0 }))
    }
    this.saveOutbox()
    const epoch = currentStoreEpoch()
    setState((prev) => rekeyConversation(prev, fromId, canonical.id), { epoch })
    this.opts.onRekey?.(fromId, canonical.id)
    this.applyRows({ conversations: [canonical], groups: [] })
    this.scheduleFlush(FLUSH_DEBOUNCE_MS)
  }

  // --- feed -----------------------------------------------------------------

  private applyRows(page: Pick<SyncPage, 'conversations' | 'groups'>, epoch = currentStoreEpoch()): void {
    if (epoch !== currentStoreEpoch()) return
    const result = applySyncPage(getState(), page, this.pendingView, {
      isBusy: this.opts.isBusy,
      defaultAgentId: this.opts.defaultAgentId,
    })
    for (const dto of page.conversations ?? []) {
      if (dto?.id && !dto.deletedAt) this.serverKnown.add(dto.id)
    }
    if (result.changed) {
      const s = result.state
      setState(
        {
          conversations: s.conversations,
          groups: s.groups,
          messagesByThreadId: s.messagesByThreadId,
          selectedConversationId: s.selectedConversationId,
          subagentsById: s.subagentsById,
          turnsById: s.turnsById,
        },
        { epoch },
      )
    }
    for (const [from, to] of result.rekeys) {
      // Pending edits for the old id now belong to the canonical row.
      const op = this.outbox.get(opKey('thread', from))
      if (op) {
        this.outbox.delete(opKey('thread', from))
        const toKey = opKey('thread', to)
        this.outbox.set(toKey, coalesceOutboxOp(this.outbox.get(toKey), { ...op, id: to }))
        this.saveOutbox()
      }
      this.opts.onRekey?.(from, to)
    }
    // Busy match: re-PUT the session from the local id so the 409 path
    // finishes the re-key once the send is over.
    for (const { localId, sessionId } of result.deferred) this.putThread(localId, { sessionId })
    for (const id of result.staleServerIds) {
      if (this.outbox.get(opKey('thread', id))?.op !== 'delete') this.deleteThread({ id })
    }
  }

  /** GET one feed page. `null` on any failure (the next poll retries). */
  private async fetchPage(since: string | null): Promise<SyncPage | null> {
    let url =
      `${this.host}/api/chat/sync?instanceId=${encodeURIComponent(this.instanceId)}` +
      `&limit=${PAGE_LIMIT}`
    if (since) url += `&since=${encodeURIComponent(since)}`
    const res = await fetch(url, {
      method: 'GET',
      headers: this.opts.headers({ Accept: 'application/json' }),
      cache: 'no-store',
    })
    if (!res.ok) {
      logger.error('[nub] conversation sync failed', res.status)
      return null
    }
    const body = (await res.json()) as Partial<SyncPage>
    return {
      conversations: Array.isArray(body.conversations) ? body.conversations : [],
      groups: Array.isArray(body.groups) ? body.groups : [],
      live: Array.isArray(body.live) ? body.live : [],
      cursor: typeof body.cursor === 'string' ? body.cursor : '',
      hasMore: body.hasMore === true,
      reset: body.reset === true,
    }
  }

  /**
   * Pull the feed from the stored cursor (single-flight): push due outbox
   * ops first so the feed reflects them, then chain `hasMore` pages. A reset
   * snapshot drops unlisted local rows only once its LAST page lands.
   */
  sync(): Promise<SyncResult> {
    if (this.syncing) return this.syncing
    this.syncing = (async (): Promise<SyncResult> => {
      const epoch = currentStoreEpoch()
      try {
        if (this.outbox.size > 0) await this.flush()
        let cursor = this.cursor
        // No cursor = the server sends the whole list: treat it as a reset
        // snapshot so rows it no longer has are dropped here too.
        let listed: { conversations: Set<string>; groups: Set<string> } | null =
          cursor === null ? { conversations: new Set(), groups: new Set() } : null
        let rawLive: LiveTurnDTO[] = []
        let ended = false
        for (let i = 0; i < MAX_PAGES_PER_SYNC; i++) {
          const page = await this.fetchPage(cursor)
          if (!page || this.disposed || epoch !== currentStoreEpoch()) return { ok: false, live: [] }
          if (page.reset && !listed) listed = { conversations: new Set(), groups: new Set() }
          if (listed) {
            for (const c of page.conversations) if (!c.deletedAt) listed.conversations.add(c.id)
            for (const g of page.groups) if (!g.deletedAt) listed.groups.add(g.id)
          }
          this.applyRows(page, epoch)
          rawLive = page.live
          if (page.cursor) cursor = page.cursor
          if (!page.hasMore) {
            ended = true
            break
          }
        }
        const live = resolveLiveTurns(rawLive, getState().conversations)
        const liveTurns = liveTurnsFromPage(live)
        if (!sameLiveTurns(getHydrateStatus().liveTurns, liveTurns)) setHydrateStatus({ liveTurns })
        if (listed && !ended) {
          // Page cap hit mid-snapshot: the union is partial, so dropping
          // "unlisted" rows would wipe real ones. Keep the old cursor so the
          // whole reset re-runs next poll (rows applied so far are idempotent).
          return { ok: true, live }
        }
        if (listed) {
          const snapshot = listed
          setState((prev) => {
            const next = dropUnlisted(prev, snapshot, this.pendingView)
            return next === prev ? {} : next
          }, { epoch })
        }
        // Persist only after the whole chain: a reload mid-snapshot re-runs
        // it (idempotent) instead of skipping the unlisted-row drop.
        if (cursor !== this.cursor) this.setCursor(cursor)
        return { ok: true, live }
      } catch (err) {
        logger.error('[nub] conversation sync failed', err)
        return { ok: false, live: [] }
      }
    })().finally(() => {
      // Chained (see flush): the body may settle before the slot is assigned.
      this.syncing = null
    })
    return this.syncing
  }
}
