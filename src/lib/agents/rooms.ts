/**
 * Server-run group rooms — client side (hermes-deploy
 * docs/plans/2026-09-25-group-rooms.md). The server owns the turn loop; the
 * client posts human messages, polls the room feed and renders it:
 *
 * - `messages[]` → transcript rows (`room_<id>`), ordered by server time;
 * - live `turns[]` with `partialText` → one streaming bubble per member turn
 *   (`roomturn_<turnId>`), dropped when the turn's final message lands;
 * - `turns[]` phases → the presence line above the composer;
 * - `recent[]` passes → a quiet "AllenNub passed" line;
 * - `handoffs[]` → the hand-off strip under a message that @mentioned
 *   members: one pill per member it asked, with that turn's live phase or
 *   outcome, plus the Chief's wrap-up.
 *
 * Everything here is pure except the small per-conversation view store the
 * transport writes and the React runtime reads.
 */
import type { Agent, ChatMessage, Group } from './types'
import { isOrchestrator } from '../peer-roster'
import { sortKeyedRows } from './turns-to-messages'
import { parseMentions, type MentionMember } from '../mentions'
import { validatedGenUiEvents } from '../genui'

// --- wire ------------------------------------------------------------------

export interface RoomMessageDTO {
  id: string
  seq: number
  speakerKind: 'human' | 'agent' | 'system'
  speakerId?: string | null
  speakerName: string
  text: string
  replyToId?: string | null
  rootId?: string | null
  depth?: number
  roomTurnId?: string | null
  createdAt: string
  toolEvents?: ChatMessage['toolEvents']
}

export type RoomTurnPhase = 'queued' | 'reading' | 'working' | 'typing'

export type RoomActivity =
  | string
  | { tool?: string | null; label?: string | null; emoji?: string | null }
  | null

export interface RoomTurnDTO {
  id: string
  memberId: string
  status: 'queued' | 'running'
  phase: RoomTurnPhase
  activity?: RoomActivity
  partialText?: string | null
  chatTurnId?: string | null
  rootId?: string | null
  /** The message that asked for this turn (servers before hand-offs omit it). */
  triggerId?: string | null
  kind?: string | null
  depth?: number | null
  toolEvents?: ChatMessage['toolEvents']
  /** Queued behind the room's token budget, not about to run. */
  paused?: boolean
}

export type RoomTurnStatus = 'queued' | 'running' | 'sent' | 'pass' | 'error' | 'timeout' | 'cancelled'

/**
 * One member turn in an active thread, whatever its status. The hand-off
 * strip under a message is every `reply` turn whose `triggerId` is it.
 * `messageId` is the reply the turn wrote (status `sent`).
 */
export interface RoomHandoffDTO {
  id: string
  memberId: string
  rootId: string
  triggerId: string
  depth: number
  kind: 'reply' | 'wrap' | string
  windingDown?: boolean
  status: RoomTurnStatus | string
  error?: string | null
  messageId?: string | null
  createdAt: string
  completedAt?: string | null
}

export interface RoomFeedMember {
  id: string
  name: string
  title?: string
  description?: string
  role?: 'orchestrator' | 'specialist'
  avatarColor?: string
  avatarEyeColor?: string
}

export interface RoomRecentDTO {
  memberId: string
  status: 'pass' | 'error' | 'timeout' | 'cancelled'
  rootId?: string | null
  error?: string | null
  /** Explicit local eligibility; absence does not permit UI retry. */
  retryable?: boolean
}

export interface RoomFeed {
  messages: RoomMessageDTO[]
  turns: RoomTurnDTO[]
  recent: RoomRecentDTO[]
  /** Every turn in the threads this page touches. Empty from older servers. */
  handoffs: RoomHandoffDTO[]
  /** The member the server treats as the room's Chief (null: none / unknown). */
  chiefId: string | null
  /** Seated members as the server knows them (a tagged member may not have
   *  spoken yet, and this device may not have it in its roster). */
  members: RoomFeedMember[]
  cursor: number
  /** Server: the page's first seq is > 1. Null from servers that omit it. */
  hasOlder: boolean | null
}

/** `#rrggbb` only. Feed colors reach inline CSS (red-team D-1). */
const HEX = /^#[0-9a-f]{6}$/i

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v)
}

/** Drop feed-supplied mascot colors that aren't plain hex, and a role that
 *  isn't one of the two known values. */
function sanitizeFeedMember(m: RoomFeedMember): RoomFeedMember {
  const out: RoomFeedMember = { ...m }
  if (!isHexColor(out.avatarColor)) delete out.avatarColor
  if (!isHexColor(out.avatarEyeColor)) delete out.avatarEyeColor
  if (out.role !== 'orchestrator' && out.role !== 'specialist') delete out.role
  return out
}

/** Defensive parse of a feed body (unknown shapes degrade to empty lists). */
export function parseRoomFeed(raw: unknown): RoomFeed {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  const messages = list<RoomMessageDTO>(o.messages).filter(
    (m) => m && typeof m.id === 'string' && typeof m.seq === 'number',
  )
  const maxSeq = messages.reduce((n, m) => Math.max(n, m.seq), 0)
  return {
    messages: [...messages].sort((a, b) => a.seq - b.seq),
    turns: list<RoomTurnDTO>(o.turns).filter((t) => t && typeof t.id === 'string'),
    recent: list<RoomRecentDTO>(o.recent).filter((r) => r && typeof r.memberId === 'string'),
    handoffs: list<RoomHandoffDTO>(o.handoffs).filter(
      (h) =>
        h &&
        typeof h.id === 'string' &&
        typeof h.memberId === 'string' &&
        typeof h.triggerId === 'string' &&
        typeof h.rootId === 'string',
    ),
    chiefId: typeof o.chiefId === 'string' ? o.chiefId : null,
    members: list<RoomFeedMember>(o.members)
      .filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string')
      .map(sanitizeFeedMember),
    // The `after` cursor is the highest seq this page DELIVERED — never the
    // server's `cursor`. The server reads that from a separate query after
    // the rows, so a reply committed in between (or rows past a full page)
    // sat below it: the next `after=` poll skipped them for good and the
    // reply only appeared after a refresh. Rows nobody delivered are
    // re-requested; a duplicate is merged by id.
    cursor: maxSeq,
    hasOlder: typeof o.hasOlder === 'boolean' ? o.hasOlder : null,
  }
}

// --- member profiles ---------------------------------------------------------

export interface RoomMemberProfile {
  id: string
  name: string
  title?: string
  description?: string
  role?: 'orchestrator' | 'specialist'
  /** Mascot colors (hex), so other devices draw the member the same way. */
  avatarColor?: string
  avatarEyeColor?: string
}

export const ROOM_MAX_MEMBERS = 12
/** Server clip for a member title (hermes-deploy rooms/core.ts). */
const TITLE_MAX = 80
const NAME_MAX = 60
const DESCRIPTION_MAX = 600

/**
 * Names the server told us (feed `speakerName`s), for members this device's
 * roster doesn't have — e.g. an agent created on another device. Without it
 * labels, presence and the @mention picker showed raw ids (found live).
 */
const learnedNames = new Map<string, string>()

export function learnRoomSpeakerNames(messages: RoomMessageDTO[]): void {
  for (const m of messages) {
    const name = m.speakerName?.trim()
    if (m.speakerKind === 'agent' && m.speakerId && name && name !== m.speakerId) {
      learnedNames.set(m.speakerId, name)
    }
  }
}

/** What the room feed says about members this device may not know. */
const learnedMembers = new Map<string, RoomFeedMember>()

/** Seated members from the feed: names (same fallback role as speakers),
 *  plus title, role and mascot colors for the profile card and avatars. */
export function learnRoomMemberNames(members: RoomFeedMember[]): void {
  for (const m of members) {
    const name = m.name?.trim()
    if (m.id && name && name !== m.id) learnedNames.set(m.id, name)
    if (m.id) learnedMembers.set(m.id, sanitizeFeedMember(m))
  }
}

/** The feed's view of a member (null when no feed has mentioned it). */
export function learnedRoomMember(id: string): RoomFeedMember | null {
  return learnedMembers.get(id) ?? null
}

/** Test hook. */
export function resetLearnedRoomNames(): void {
  learnedNames.clear()
  learnedMembers.clear()
}

/** Display name of a member: this device's roster, then a name the room
 *  feed taught us, with the paired VM agent falling back to "Nub". */
export function roomMemberName(id: string, agents: Agent[], instanceId?: string): string {
  const name = agents.find((a) => a.id === id)?.name?.trim()
  if (name) return name
  const learned = learnedNames.get(id)
  if (learned) return learned
  return id === instanceId ? 'Nub' : id
}

/** `extra.memberProfiles` for PUT /api/chat/groups/:id (server limits applied). */
export function memberProfilesFor(
  group: Pick<Group, 'memberAgentIds'>,
  agents: Agent[],
  instanceId?: string,
): RoomMemberProfile[] {
  // Only agents this device knows (plus the paired VM agent): a bare
  // `{ id, name: id }` for an unknown agent would overwrite the profile the
  // device that created it stored — the server keeps profiles left out.
  return group.memberAgentIds
    .filter(Boolean)
    .filter((id) => id === instanceId || agents.some((a) => a.id === id))
    .slice(0, ROOM_MAX_MEMBERS)
    .map((id) => profileFor(id, agents, instanceId))
}

function profileFor(id: string, agents: Agent[], instanceId?: string): RoomMemberProfile {
  const agent = agents.find((a) => a.id === id)
  const profile: RoomMemberProfile = {
    id,
    name: roomMemberName(id, agents, instanceId).slice(0, NAME_MAX),
  }
  const title = agent?.persona?.title?.trim()
  if (title) profile.title = title.slice(0, TITLE_MAX)
  const description = (agent?.persona?.description?.trim() || agent?.summary?.trim() || '')
  if (description) profile.description = description.slice(0, DESCRIPTION_MAX)
  // Always explicit: the server's isChief still falls back to a name/title
  // match when `role` is absent, so an unset role would let an agent named
  // "Chief of Staff" lead the room server-side (red-team D-3).
  profile.role = isOrchestrator(agent) ? 'orchestrator' : 'specialist'
  if (agent?.avatarColor && HEX.test(agent.avatarColor)) profile.avatarColor = agent.avatarColor
  if (agent?.avatarEyeColor && HEX.test(agent.avatarEyeColor)) profile.avatarEyeColor = agent.avatarEyeColor
  return profile
}

/**
 * The account's Chief of Staff: the first agent marked Chief. Like Grok
 * Bot's Chief of Staff ("manages your other Bots"), it is account-wide, not
 * a group member: it leads every room that has no member Chief.
 */
export function accountChief(agents: Agent[]): Agent | null {
  return agents.find((a) => isOrchestrator(a)) ?? null
}

/** `extra.chiefProfile` for a group PUT: the account Chief, or null (the
 *  server seats it only when no member is a Chief). */
export function chiefProfileFor(agents: Agent[], instanceId?: string): RoomMemberProfile | null {
  const chief = accountChief(agents)
  return chief ? { ...profileFor(chief.id, agents, instanceId), role: 'orchestrator' } : null
}

/** "A", "A and B", "A, B and C", "A, B and N others". */
export function joinNames(names: string[]): string {
  const n = names.filter(Boolean)
  if (n.length === 0) return ''
  if (n.length === 1) return n[0]!
  if (n.length === 2) return `${n[0]} and ${n[1]}`
  if (n.length === 3) return `${n[0]}, ${n[1]} and ${n[2]}`
  return `${n[0]}, ${n[1]} and ${n.length - 2} others`
}

/** Default room name from its members (used until the user names it). */
export function groupAutoName(names: string[]): string {
  return joinNames(names) || 'Group'
}

/** Who leads the room: a member marked Chief, else the account's Chief of
 *  Staff (it doesn't have to be a member), else nobody (everyone answers).
 *  Same rule as the server's roomMembers(). */
export function roomChief(memberAgentIds: string[], agents: Agent[]): Agent | null {
  for (const id of memberAgentIds) {
    const agent = agents.find((a) => a.id === id)
    if (isOrchestrator(agent)) return agent ?? null
  }
  return memberAgentIds.length > 0 ? accountChief(agents) : null
}

// --- feed → transcript ---------------------------------------------------------

export { ROOM_ROW_PREFIX, ROOM_TURN_ROW_PREFIX, roomRowId, roomTurnRowId, isRoomRow, isRoomTurnRow, roomMessageIdOf } from './room-row-ids'
import { roomRowId, roomTurnRowId, isRoomRow, isRoomTurnRow } from './room-row-ids'

function activityTool(activity: RoomActivity | undefined): { tool: string; label?: string; emoji?: string } | null {
  if (!activity) return null
  if (typeof activity === 'string') return activity.trim() ? { tool: activity.trim() } : null
  const tool = activity.tool?.trim() || activity.label?.trim()
  if (!tool) return null
  return {
    tool,
    ...(activity.label?.trim() ? { label: activity.label.trim() } : {}),
    ...(activity.emoji ? { emoji: activity.emoji } : {}),
  }
}

/** Longest tool phrase the presence line / hand-off pills will show. */
export const ACTIVITY_LABEL_MAX = 32

/** A server label that is already a short human phrase ("web search",
 *  "reading README.md") — not the tool's arguments. Code, commands and
 *  JSON (seen live: a whole `execute_code` script, bearer token included)
 *  fail this and fall back to the tool's name. */
function isHumanLabel(label: string): boolean {
  if (label.length > ACTIVITY_LABEL_MAX || /[\r\n]/.test(label)) return false
  return !/[=(){}[\]"'`$|;<>\\]|\s--?\w|:\/\//.test(label)
}

/** "execute_code" -> "execute code", "WebSearch" -> "web search". */
function humanToolName(tool: string): string {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Human-readable tool label for the presence line ("shell", "web search").
 *  Never the tool's raw arguments: the label is used only when it is a short
 *  plain phrase, otherwise the tool's name; both capped. */
export function activityLabel(activity: RoomActivity | undefined): string | null {
  const t = activityTool(activity)
  if (!t) return null
  const label = t.label?.trim()
  const name = humanToolName(t.tool)
  // No tool name from the server falls back to the label as the "tool" —
  // which can itself be code: then say "a tool", never the code.
  const text = label && isHumanLabel(label) ? label : name && isHumanLabel(name) ? name : 'a tool'
  return text.length > ACTIVITY_LABEL_MAX ? `${text.slice(0, ACTIVITY_LABEL_MAX - 1).trimEnd()}…` : text
}

function sameText(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ')
}

function rowFor(
  m: RoomMessageDTO,
  conversationId: string,
  rowById: (id: string) => ChatMessage | undefined,
): ChatMessage {
  const replyRow = m.replyToId ? rowById(roomRowId(m.replyToId)) : undefined
  const role: ChatMessage['role'] =
    m.speakerKind === 'human' ? 'user' : m.speakerKind === 'agent' ? 'agent' : 'system'
  return {
    id: roomRowId(m.id),
    threadId: conversationId,
    role,
    content: m.text,
    createdAt: m.createdAt,
    // Server ordering stamps (same keys the legacy merge sorts on), so legacy
    // member history interleaves by time — i.e. lands above the room.
    turnId: `room:${m.id}`,
    turnCreatedAt: m.createdAt,
    ...(role === 'agent' && m.speakerId ? { fromAgentId: m.speakerId } : {}),
    toolEvents: role === 'agent' ? validatedGenUiEvents(m.toolEvents) : undefined,
    ...(m.replyToId
      ? {
          replyTo: {
            id: roomRowId(m.replyToId),
            role: replyRow?.role ?? 'agent',
            snippet: (replyRow?.content ?? '').slice(0, 120),
          },
        }
      : {}),
  }
}

function rowChanged(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.content !== b.content ||
    a.role !== b.role ||
    a.streaming !== b.streaming ||
    a.fromAgentId !== b.fromAgentId ||
    a.turnId !== b.turnId ||
    a.turnCreatedAt !== b.turnCreatedAt ||
    JSON.stringify(a.toolEvents ?? null) !== JSON.stringify(b.toolEvents ?? null)
  )
}

export interface RoomMergeOptions {
  conversationId: string
  /** Room message id → local echo row id (set when the POST 202 names it). */
  echoByMessageId?: ReadonlyMap<string, string>
  /**
   * Live-turn rows are replaced wholesale (true for a newest-page / after=
   * poll). An older page (`before=`) must leave the live bubbles alone.
   */
  applyTurns?: boolean
}

export interface RoomMergeResult {
  messages: ChatMessage[]
  changed: boolean
  added: ChatMessage[]
}

/**
 * Merge one feed page into the thread. Pure: no store access.
 *
 * - A human message binds the local echo (by the POST's message id, else the
 *   first unbound local user row with the same text) instead of adding a
 *   second bubble.
 * - An agent message with `roomTurnId` replaces that turn's streaming bubble.
 * - Live turns with `partialText` get one streaming bubble each; bubbles for
 *   turns no longer live are dropped (a pass or error writes no message).
 */
export function mergeRoomFeed(
  existing: ChatMessage[],
  feed: Pick<RoomFeed, 'messages' | 'turns'>,
  opts: RoomMergeOptions,
): RoomMergeResult {
  let msgs = existing
  const added: ChatMessage[] = []
  // Row id → index, so a feed page merges in O(n) instead of a scan per row.
  let index: Map<string, number> | null = null
  const indexOf = (id: string) => {
    if (!index) {
      index = new Map()
      for (let i = msgs.length - 1; i >= 0; i--) index.set(msgs[i]!.id, i)
    }
    return index.get(id) ?? -1
  }
  const own = () => (msgs === existing ? (msgs = [...existing]) : msgs)
  const put = (at: number, row: ChatMessage) => {
    const list = own()
    if (index && list[at]!.id !== row.id) index.delete(list[at]!.id)
    list[at] = row
    index?.set(row.id, at)
  }
  const push = (row: ChatMessage) => {
    const list = own()
    if (index && !index.has(row.id)) index.set(row.id, list.length)
    list.push(row)
  }
  const drop = (gone: (r: ChatMessage) => boolean) => {
    msgs = own().filter((r) => !gone(r))
    index = null
  }
  // Unbound local echoes a human message may claim (few; bound ones leave).
  let echoes: number[] | null = null
  const settledLive = new Set<string>()

  for (const m of feed.messages) {
    const next = rowFor(m, opts.conversationId, (id) => msgs[indexOf(id)])
    const at = indexOf(next.id)
    if (at >= 0) {
      const cur = msgs[at]!
      const merged: ChatMessage = { ...cur, ...next, reactions: cur.reactions }
      if (!merged.reactions) delete merged.reactions
      if (rowChanged(cur, merged)) put(at, merged)
    } else {
      let echoAt = -1
      if (m.speakerKind === 'human') {
        const echoId = opts.echoByMessageId?.get(m.id)
        if (echoId) echoAt = indexOf(echoId)
        if (echoAt < 0) {
          echoes ??= msgs.flatMap((r, i) =>
            r.role === 'user' && !isRoomRow(r) && !r.turnId && r.pending !== true ? [i] : [])
          echoAt = echoes.find((i) => msgs[i]!.role === 'user' && !isRoomRow(msgs[i]!) &&
            !msgs[i]!.turnId && sameText(msgs[i]!.content, m.text)) ?? -1
        }
      }
      if (echoAt >= 0) {
        const echo = msgs[echoAt]!
        const bound: ChatMessage = { ...echo, ...next, replyTo: next.replyTo ?? echo.replyTo }
        if (!bound.replyTo) delete bound.replyTo
        put(echoAt, bound)
      } else {
        push(next)
        added.push(next)
      }
    }
    if (m.speakerKind === 'agent' && m.roomTurnId) {
      const live = roomTurnRowId(m.roomTurnId)
      if (indexOf(live) >= 0) settledLive.add(live)
    }
  }
  if (settledLive.size) drop((r) => settledLive.has(r.id))

  if (opts.applyTurns !== false) {
    const wanted = new Map<string, ChatMessage>()
    for (const t of feed.turns) {
      const text = t.partialText?.trim() ? t.partialText : ''
      const genui = validatedGenUiEvents(t.toolEvents)
      if (!text && genui.length === 0) continue
      const tool = activityTool(t.activity)
      wanted.set(roomTurnRowId(t.id), {
        id: roomTurnRowId(t.id),
        threadId: opts.conversationId,
        role: 'agent',
        fromAgentId: t.memberId,
        content: text,
        createdAt: new Date().toISOString(),
        streaming: true,
        toolEvents: [...genui, ...tool ? [{ ...tool, status: 'running' as const }] : []],
      })
    }
    // Drop bubbles of turns that settled (pass / error / final landed).
    if (msgs.some((r) => isRoomTurnRow(r) && !wanted.has(r.id))) {
      drop((r) => isRoomTurnRow(r) && !wanted.has(r.id))
    }
    for (const [id, row] of wanted) {
      const at = indexOf(id)
      if (at < 0) {
        push(row)
        added.push(row)
      } else if (rowChanged(msgs[at]!, { ...msgs[at]!, content: row.content, toolEvents: row.toolEvents, streaming: true })) {
        const cur = msgs[at]!
        put(at, { ...cur, content: row.content, toolEvents: row.toolEvents, streaming: true })
      }
    }
  }

  if (msgs === existing) return { messages: existing, changed: false, added }
  // Server time order for room + legacy rows; live bubbles always sit last.
  const sorted = sortKeyedRows(msgs)
  const live = sorted.filter(isRoomTurnRow)
  const ordered = live.length ? [...sorted.filter((r) => !isRoomTurnRow(r)), ...live] : sorted
  const changed =
    ordered.length !== existing.length || ordered.some((r, i) => r !== existing[i])
  return { messages: changed ? ordered : existing, changed, added }
}

// --- presence ------------------------------------------------------------------

const PHASE_RANK: Record<RoomTurnPhase, number> = { queued: 0, reading: 1, working: 2, typing: 3 }

/**
 * Grok-style presence line: "CoderBob is typing", "CoderBob and Nub are
 * working", "AllenNub is reading", "A, B and N others are working". One
 * working member with a tool activity → "Nub is using shell". Queued turns
 * read as "reading" (the member is about to look at the room).
 */
export function roomPresenceText(
  turns: RoomTurnDTO[],
  nameOf: (memberId: string) => string,
): string | null {
  // One entry per member: its most advanced live turn.
  const byMember = new Map<string, RoomTurnDTO>()
  for (const t of turns) {
    const cur = byMember.get(t.memberId)
    if (!cur || PHASE_RANK[t.phase] > PHASE_RANK[cur.phase]) byMember.set(t.memberId, t)
  }
  if (byMember.size === 0) return null
  if (byMember.size === 1) {
    const only = [...byMember.values()][0]!
    const tool = activityLabel(only.activity)
    if (only.phase === 'working' && tool) return `${nameOf(only.memberId)} is using ${tool}`
  }
  const groups: Array<{ verb: string; ids: string[] }> = [
    { verb: 'typing', ids: [] },
    { verb: 'working', ids: [] },
    { verb: 'reading', ids: [] },
  ]
  for (const t of byMember.values()) {
    const g = t.phase === 'typing' ? groups[0] : t.phase === 'working' ? groups[1] : groups[2]
    g!.ids.push(t.memberId)
  }
  const parts = groups
    .filter((g) => g.ids.length > 0)
    .map((g) => `${joinNames(g.ids.map(nameOf))} ${g.ids.length === 1 ? 'is' : 'are'} ${g.verb}`)
  return parts.join(' · ')
}

// --- optimistic presence -------------------------------------------------------

/** Placeholder turn ids. Server turn ids are cuids, so these never collide. */
const PENDING_TURN_PREFIX = 'pending:'

export function isPendingRoomTurn(t: Pick<RoomTurnDTO, 'id'>): boolean {
  return t.id.startsWith(PENDING_TURN_PREFIX)
}

/**
 * Who the server will queue for a human message. Mirrors hermes-deploy
 * `respondersForHuman` (src/lib/rooms/core.ts): @mentions win, then the
 * member the message replies to, then the room's Chief, then everyone.
 * Only drives the presence line between send and the first poll that sees
 * the real turns, so a miss costs a brief wrong name, never a wrong turn.
 */
export function predictRoomResponders(opts: {
  text: string
  members: MentionMember[]
  chiefId: string | null
  replyToMemberId: string | null
}): string[] {
  const ids = opts.members.map((m) => m.id)
  const mentioned = parseMentions(opts.text, opts.members)
  if (mentioned.length > 0) return mentioned
  if (opts.replyToMemberId && ids.includes(opts.replyToMemberId)) return [opts.replyToMemberId]
  if (opts.chiefId && ids.includes(opts.chiefId)) return [opts.chiefId]
  return ids
}

/** Queued placeholder turns for `memberIds` (the send's nonce keys them). */
export function pendingRoomTurns(key: string, memberIds: string[]): RoomTurnDTO[] {
  return [...new Set(memberIds)].map((memberId) => ({
    id: `${PENDING_TURN_PREFIX}${key}:${memberId}`,
    memberId,
    status: 'queued' as const,
    phase: 'queued' as const,
  }))
}

/**
 * Live turns plus the placeholders for members that have no live turn yet.
 * Placeholders only reach the presence line: bubbles and hand-off pills key
 * on server turn ids, which a placeholder never matches.
 */
export function withPendingTurns(turns: RoomTurnDTO[], pending: RoomTurnDTO[]): RoomTurnDTO[] {
  const real = turns.filter((t) => !isPendingRoomTurn(t))
  if (pending.length === 0) return real
  const live = new Set(real.map((t) => t.memberId))
  return [...real, ...pending.filter((t) => !live.has(t.memberId))]
}

/**
 * Quiet line for settled no-reply turns under the latest root: "AllenNub
 * passed", "CoderBob couldn't answer". Cancelled turns (stop / newer root)
 * stay silent. Members that are live again are left out.
 */
export function roomPassLine(
  recent: RoomRecentDTO[],
  nameOf: (memberId: string) => string,
  opts?: { rootId?: string | null; liveMemberIds?: ReadonlySet<string> },
): string | null {
  const scoped = recent.filter(
    (r) =>
      (!opts?.rootId || !r.rootId || r.rootId === opts.rootId) &&
      !opts?.liveMemberIds?.has(r.memberId),
  )
  const passed = [...new Set(scoped.filter((r) => r.status === 'pass').map((r) => r.memberId))]
  const failed = [
    ...new Set(
      scoped
        .filter((r) => r.status === 'error' || r.status === 'timeout')
        .map((r) => r.memberId),
    ),
  ].filter((id) => !passed.includes(id))
  const parts: string[] = []
  if (passed.length) parts.push(`${joinNames(passed.map(nameOf))} passed`)
  if (failed.length) parts.push(`${joinNames(failed.map(nameOf))} couldn't answer`)
  return parts.length ? parts.join(' · ') : null
}

// --- hand-off strip --------------------------------------------------------------

/** Hand-off rows kept per room view: a thread has at most ~8 turns, so this
 *  covers the last ~50 threads — far more than one screen of transcript. */
export const ROOM_HANDOFFS_KEEP = 400

/**
 * Upsert a feed page's hand-offs into the ones already known (a poll only
 * carries the threads it touches). Returns `prev` when nothing changed.
 */
export function mergeRoomHandoffs(
  prev: readonly RoomHandoffDTO[],
  incoming: readonly RoomHandoffDTO[],
): RoomHandoffDTO[] {
  if (incoming.length === 0) return prev as RoomHandoffDTO[]
  const byId = new Map(prev.map((h) => [h.id, h]))
  let changed = false
  for (const h of incoming) {
    const cur = byId.get(h.id)
    if (cur && JSON.stringify(cur) === JSON.stringify(h)) continue
    byId.set(h.id, h)
    changed = true
  }
  if (!changed) return prev as RoomHandoffDTO[]
  const all = [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
  return all.length > ROOM_HANDOFFS_KEEP ? all.slice(all.length - ROOM_HANDOFFS_KEEP) : all
}

export type HandoffState =
  | 'queued'
  | 'reading'
  | 'working'
  | 'typing'
  | 'replied'
  | 'passed'
  | 'failed'
  | 'stopped'

export interface HandoffPill {
  turnId: string
  memberId: string
  name: string
  state: HandoffState
  /** Short status text: "typing", "using shell", "replied", "passed". */
  label: string
  /** Transcript row of the reply this turn wrote (state `replied`). */
  replyRowId: string | null
}

export interface HandoffStrip {
  /** Row the strip hangs under (`room_<trigger message id>`). */
  rowId: string
  /** Who wrote the hand-off message (a member id), when known. */
  fromMemberId: string | null
  pills: HandoffPill[]
  /**
   * The Chief's follow-up for this batch: `pending` while the hand-offs
   * are still going, then its live phase / outcome. Null when the message
   * wasn't the Chief's, or no follow-up is coming.
   */
  wrap: (Omit<HandoffPill, 'state'> & { state: HandoffState | 'pending' }) | null
  /** Every pill settled and the wrap (if any) settled too. */
  done: boolean
}

const LIVE_STATES = new Set<HandoffState | 'pending'>(['queued', 'reading', 'working', 'typing', 'pending'])

function pillState(
  h: RoomHandoffDTO,
  live: RoomTurnDTO | undefined,
): { state: HandoffState; label: string; tool: string | null } {
  if (h.status === 'queued' || h.status === 'running') {
    if (h.status === 'queued' && live?.paused) return { state: 'queued', label: 'paused', tool: null }
    const phase: RoomTurnPhase = live?.phase ?? (h.status === 'queued' ? 'queued' : 'reading')
    const tool = phase === 'working' ? activityLabel(live?.activity) : null
    return { state: phase, label: tool ? `using ${tool}` : phase, tool }
  }
  if (h.status === 'sent') return { state: 'replied', label: 'replied', tool: null }
  if (h.status === 'pass') return { state: 'passed', label: 'passed', tool: null }
  if (h.status === 'cancelled') return { state: 'stopped', label: 'stopped', tool: null }
  return { state: 'failed', label: "couldn't answer", tool: null }
}

/**
 * The hand-off strips for one room, keyed by transcript row id. A strip
 * exists for every message that handed work to members (its `reply` turns
 * whose trigger isn't the human message that started the thread). Pure.
 */
export function roomHandoffStrips(
  view: Pick<RoomView, 'handoffs' | 'turns' | 'chiefId'> | undefined,
  nameOf: (memberId: string) => string,
  opts?: {
    /** Also strip the turns a HUMAN message started (its own root). The
     *  inline strips skip them — every message would carry one — but the
     *  hand-off modal needs them to thread a follow-up's answers. */
    includeRoots?: boolean
  },
): Map<string, HandoffStrip> {
  const out = new Map<string, HandoffStrip>()
  if (!view || view.handoffs.length === 0) return out
  const live = new Map(view.turns.map((t) => [t.id, t]))
  const authorOf = new Map<string, string>()
  for (const h of view.handoffs) if (h.messageId) authorOf.set(h.messageId, h.memberId)

  const byTrigger = new Map<string, RoomHandoffDTO[]>()
  for (const h of view.handoffs) {
    if (h.kind !== 'reply' || (h.triggerId === h.rootId && !opts?.includeRoots)) continue
    const list = byTrigger.get(h.triggerId)
    if (list) list.push(h)
    else byTrigger.set(h.triggerId, [h])
  }

  for (const [triggerId, turns] of byTrigger) {
    const pills: HandoffPill[] = turns.map((h) => {
      const { state, label } = pillState(h, live.get(h.id))
      return {
        turnId: h.id,
        memberId: h.memberId,
        name: nameOf(h.memberId),
        state,
        label,
        replyRowId: h.status === 'sent' && h.messageId ? roomRowId(h.messageId) : null,
      }
    })
    const fromMemberId = authorOf.get(triggerId) ?? null
    let wrap: HandoffStrip['wrap'] = null
    if (fromMemberId && view.chiefId && fromMemberId === view.chiefId) {
      // Mirrors the runner's maybeWrap: the Chief's follow-up for this batch
      // is its first wrap turn under the root created after the batch.
      const batchAt = turns.reduce((t, h) => (h.createdAt > t ? h.createdAt : t), '')
      const rootId = turns[0]!.rootId
      // A retried member's late reply can earn this batch a second wrap: show the newest.
      const w =
        view.handoffs.findLast((h) => h.kind === 'wrap' && h.rootId === rootId && h.triggerId === triggerId) ??
        view.handoffs.find((h) => h.kind === 'wrap' && h.rootId === rootId && h.createdAt > batchAt)
      const name = nameOf(view.chiefId)
      if (w) {
        const { state, label } = pillState(w, live.get(w.id))
        wrap = {
          turnId: w.id,
          memberId: w.memberId,
          name,
          state,
          label: state === 'replied' ? 'wrapped up' : state === 'passed' ? 'nothing to add' : label,
          replyRowId: w.status === 'sent' && w.messageId ? roomRowId(w.messageId) : null,
        }
      } else if (pills.some((p) => LIVE_STATES.has(p.state))) {
        wrap = {
          turnId: '',
          memberId: view.chiefId,
          name,
          state: 'pending',
          label: 'will wrap up',
          replyRowId: null,
        }
      }
    }
    const done = pills.every((p) => !LIVE_STATES.has(p.state)) && !(wrap && LIVE_STATES.has(wrap.state))
    out.set(roomRowId(triggerId), { rowId: roomRowId(triggerId), fromMemberId, pills, wrap, done })
  }
  return out
}

/**
 * Reuse the previous strip object when a strip didn't change, so memoized
 * transcript rows only re-render for the thread that moved.
 */
export function stableHandoffStrips(
  prev: ReadonlyMap<string, HandoffStrip> | null,
  next: Map<string, HandoffStrip>,
): Map<string, HandoffStrip> {
  if (!prev) return next
  for (const [id, strip] of next) {
    const old = prev.get(id)
    if (old && JSON.stringify(old) === JSON.stringify(strip)) next.set(id, old)
  }
  return next
}

// --- per-conversation view store ----------------------------------------------

export interface RoomView {
  /** The server runs this room (feed answered). */
  enabled: boolean
  /** Highest seq seen (feed `after` cursor). */
  cursor: number
  /** Lowest seq loaded (paging `before`), null before the first page. */
  oldestSeq: number | null
  /** Older room messages exist above `oldestSeq`. */
  hasOlder: boolean
  loadingOlder: boolean
  turns: RoomTurnDTO[]
  recent: RoomRecentDTO[]
  /** Root of the latest exchange (scopes the pass line). */
  latestRootId: string | null
  /** Known member turns by thread (see mergeRoomHandoffs), oldest first. */
  handoffs: RoomHandoffDTO[]
  chiefId: string | null
}

export function emptyRoomView(): RoomView {
  return {
    enabled: false,
    cursor: 0,
    oldestSeq: null,
    hasOlder: false,
    loadingOlder: false,
    turns: [],
    recent: [],
    latestRootId: null,
    handoffs: [],
    chiefId: null,
  }
}

let views: ReadonlyMap<string, RoomView> = new Map()
const listeners = new Set<() => void>()

export function getRoomViews(): ReadonlyMap<string, RoomView> {
  return views
}

export function getRoomView(conversationId: string): RoomView | undefined {
  return views.get(conversationId)
}

export function subscribeRoomViews(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function setRoomView(conversationId: string, patch: Partial<RoomView>): RoomView {
  const prev = views.get(conversationId) ?? emptyRoomView()
  const next = { ...prev, ...patch }
  const same = (Object.keys(patch) as Array<keyof RoomView>).every(
    (k) => JSON.stringify(prev[k]) === JSON.stringify(next[k]),
  )
  if (same && views.has(conversationId)) return prev
  const map = new Map(views)
  map.set(conversationId, next)
  views = map
  listeners.forEach((cb) => {
    try {
      cb()
    } catch {
      /* ignore */
    }
  })
  return next
}

export function moveRoomView(from: string, to: string): void {
  const v = views.get(from)
  if (!v) return
  const map = new Map(views)
  map.delete(from)
  if (!map.has(to)) map.set(to, v)
  views = map
  listeners.forEach((cb) => cb())
}

/** Test seam. */
export function resetRoomViews(): void {
  views = new Map()
  listeners.forEach((cb) => cb())
}

/** UI summary for the open room: presence + pass line + liveness. */
export interface RoomStatus {
  live: boolean
  presence: string | null
  passLine: string | null
  /** A settled latest-root failure explicitly permits retry. */
  canRetry?: boolean
  /** The thread (root message) the pass line is about, so hiding it hides
   *  only that thread's line. */
  passRootId?: string | null
  /** The member whose live turn is furthest along (typing > working >
   *  reading): the activity line shows its mascot. */
  leadMemberId?: string | null
  /** Every member with a live turn: its phase and tool, for profile cards. */
  liveMembers?: Record<string, { phase: RoomTurnPhase; tool: string | null }>
  /** The room's Chief under the server's rule (null: none, or not known yet). */
  chiefId?: string | null
}

export const ROOM_BUDGET_PAUSED_TEXT = 'Paused — token budget reached'

export function roomStatusOf(
  view: RoomView | undefined,
  nameOf: (memberId: string) => string,
): RoomStatus | null {
  if (!view?.enabled) return null
  const live = view.turns.length > 0
  const liveIds = new Set(view.turns.map((t) => t.memberId))
  // A hand-off's outcome already shows on its strip pill; the pass line keeps
  // only members answering the human directly (e.g. a room with no Chief).
  const onStrip = new Set(
    (view.handoffs ?? [])
      .filter((h) => h.kind === 'reply' && h.triggerId !== h.rootId)
      .map((h) => `${h.memberId}|${h.rootId}`),
  )
  const recent = onStrip.size
    ? view.recent.filter((r) => !r.rootId || !onStrip.has(`${r.memberId}|${r.rootId}`))
    : view.recent
  const liveMembers: NonNullable<RoomStatus['liveMembers']> = {}
  let leadMemberId: string | null = null
  for (const t of view.turns) {
    const cur = liveMembers[t.memberId]
    if (!cur || PHASE_RANK[t.phase] > PHASE_RANK[cur.phase]) {
      liveMembers[t.memberId] = { phase: t.phase, tool: activityLabel(t.activity) }
    }
    if (!leadMemberId || PHASE_RANK[t.phase] > PHASE_RANK[liveMembers[leadMemberId]!.phase]) leadMemberId = t.memberId
  }
  return {
    live,
    canRetry: !live && !!view.latestRootId && view.recent.some(r =>
      r.rootId === view.latestRootId && (r.status === 'error' || r.status === 'timeout') && r.retryable === true),
    leadMemberId,
    liveMembers,
    chiefId: view.chiefId ?? null,
    // Budget-held turns keep the room live (Stop / raise the budget) but are not working.
    presence: roomPresenceText(view.turns.filter((t) => !t.paused), nameOf) ??
      (view.turns.some((t) => t.paused) ? ROOM_BUDGET_PAUSED_TEXT : null),
    passLine: roomPassLine(recent, nameOf, {
      rootId: view.latestRootId,
      liveMemberIds: liveIds,
    }),
    passRootId: view.latestRootId ?? null,
  }
}
