/**
 * C1 (docs/CHAT_LOAD_AND_MOTION_SPEC.md): pure deploy-transcript hydrate merge.
 *
 * `hydrateSessionTurns` used to call `applyTurnState` per turn — one store
 * `setState` per turn, so a 200-turn open committed 200 times before the
 * windowed list was stable. This module builds the next `ChatMessage[]` in
 * memory with no store access; the transport commits the result in ONE
 * `setState`, and skips the commit entirely when nothing the UI renders
 * changed (which makes unchanged `getMessages` polls no-ops — slice C2).
 *
 * Merge semantics mirror the historical per-turn `applyTurnState`:
 * - merge by server turn id onto the existing thread;
 * - keep local-only rows the server does not know (pending outbox bubbles,
 *   `submsg_*` subagent bubbles, reactions, attachments);
 * - user echoes match on the reply-note-free text so a reply-quoted send
 *   does not hydrate as a second user bubble;
 * - a local streaming bubble binds to its server turn id — only for a LIVE
 *   turn, and only a row with a local id (never another server turn's row);
 * - a settled local-id bubble with identical content binds too (id rebind).
 *
 * Ordering: rows the server knows carry `turnId` + `turnCreatedAt` and sit in
 * server order (createdAt, then turn id, user before agent). New server rows
 * are INSERTED at their place rather than appended, so an older page (paging)
 * or a turn from another device never lands below newer rows. Local-only rows
 * (optimistic sends, subagent pills) keep their relative position; rows added
 * after the newest server row stay at the tail.
 */
import { attachmentKind, attachmentName, splitAttachmentNote } from '../attachment-note'
import type { ChatMessage } from './types'
import { decodeReplyNote } from '../message-actions'
import { displayUserPrompt } from '../peer-roster'

export type ChatTurnState = {
  id: string
  status: 'pending' | 'streaming' | 'complete' | 'error'
  user?: { text?: string; imageCount?: number }
  assistantContent?: string | null
  activity?: { tool: string; label?: string; emoji?: string } | null
  /** Raw failure text (status 'error'). */
  error?: string | null
  /** Short user-facing failure headline. Newer servers send it alongside
   *  `error`; preferred for display when present. */
  errorHeadline?: string | null
  /** Server turn creation time (ISO). Absent on older servers — rows then
   *  fall back to arrival order. */
  createdAt?: string | null
}

export interface TurnMergeOptions {
  conversationId: string
  /** Group member attribution for hydrated rows. */
  fromAgentId?: string
  /** Speaker attribution for brand-new agent bubbles (DM agent or instance id). */
  speakerId?: string
  /** Mint ids for local user echoes (transport uid). */
  newId?: (prefix: string) => string
  /** Map a failed turn's server error to display copy. */
  formatTurnError?: (error: string | null | undefined) => string
  now?: () => string
  /**
   * Turns whose agent bubble a live SSE stream (send / attachTurn) owns. The
   * merge still echoes + orders the user row, but never writes the agent row:
   * a lagging snapshot would shrink the replayed text (flicker).
   */
  streamOwnedTurnIds?: ReadonlySet<string>
  /** An OLDER page is being merged: new rows without an ordering key go above
   *  the existing thread instead of the tail. Keyed rows place by key. */
  prepend?: boolean
  /**
   * Group rooms (legacy fan-out): every member session stores its OWN copy of
   * the user's message, so one send hydrates as N identical user turns. A
   * user turn whose text matches an already-stamped user row from ANOTHER
   * turn within this many ms is the same send — it is not added again.
   */
  crossTurnUserDedupeMs?: number
}

/** Copy for a failed turn whose server row carries no error headline. */
export const GENERIC_TURN_ERROR = "The agent couldn't finish this reply."

/**
 * Local ids minted on this device (`uid()` in the deploy transport:
 * `msg_` streaming bubbles, `usr_` echoes, `turn_` fallbacks) — two base-36
 * segments. Only these rows may be rebound to a server turn id; server turn
 * ids never match.
 */
const LOCAL_ID_RE = /^(msg|usr|turn)_[0-9a-z]+_[0-9a-z]+$/

export function isLocalMessageId(id: string): boolean {
  return LOCAL_ID_RE.test(id)
}

type OrderKey = { at: number; turnId: string; rank: number }

function orderKey(m: ChatMessage): OrderKey | null {
  if (!m.turnId || !m.turnCreatedAt) return null
  const at = Date.parse(m.turnCreatedAt)
  if (Number.isNaN(at)) return null
  return { at, turnId: m.turnId, rank: m.role === 'user' ? 0 : 1 }
}

function compareKeys(a: OrderKey, b: OrderKey): number {
  if (a.at !== b.at) return a.at - b.at
  if (a.turnId !== b.turnId) return a.turnId < b.turnId ? -1 : 1
  return a.rank - b.rank
}

/** Valid ISO timestamp from the server, else undefined. */
function serverTime(v: string | null | undefined): string | undefined {
  if (typeof v !== 'string' || !v) return undefined
  return Number.isNaN(Date.parse(v)) ? undefined : v
}

/**
 * Insert a new row at its server-order position: before the first keyed row
 * that sorts after it, else right after the newest keyed row (so trailing
 * local-only rows — optimistic sends — stay at the tail). Key-less rows (old
 * server) append, or go to `prependAt` when merging an older page.
 */
function insertRow(
  list: ChatMessage[],
  row: ChatMessage,
  prependAt: { i: number } | null,
): ChatMessage[] {
  const key = orderKey(row)
  if (!key) {
    if (prependAt) {
      const out = [...list]
      out.splice(prependAt.i, 0, row)
      prependAt.i += 1
      return out
    }
    return [...list, row]
  }
  let lastKeyed = -1
  for (let i = 0; i < list.length; i++) {
    const k = orderKey(list[i])
    if (!k) continue
    if (compareKeys(k, key) > 0) {
      const out = [...list]
      out.splice(i, 0, row)
      return out
    }
    lastKeyed = i
  }
  if (lastKeyed < 0) {
    // No server-ordered rows yet: newest page → tail, older page → top.
    if (prependAt) {
      const out = [...list]
      out.splice(prependAt.i, 0, row)
      prependAt.i += 1
      return out
    }
    return [...list, row]
  }
  const out = [...list]
  out.splice(lastKeyed + 1, 0, row)
  return out
}

/**
 * Repair threads persisted by the old append-at-bottom merge: keyed rows are
 * stably sorted within the slots keyed rows already occupy, so local-only
 * rows never move. Returns the input when already ordered.
 */
export function sortKeyedRows(list: ChatMessage[]): ChatMessage[] {
  const slots: number[] = []
  const rows: Array<{ m: ChatMessage; k: OrderKey }> = []
  list.forEach((m, i) => {
    const k = orderKey(m)
    if (k) {
      slots.push(i)
      rows.push({ m, k })
    }
  })
  const sorted = [...rows].sort((a, b) => compareKeys(a.k, b.k))
  if (sorted.every((r, i) => r === rows[i])) return list
  const out = [...list]
  slots.forEach((slot, j) => {
    out[slot] = sorted[j].m
  })
  return out
}

export interface TurnMergeResult {
  messages: ChatMessage[]
  /** False → the caller must not call setState at all. */
  changed: boolean
  /** Turn ids whose status was pending/streaming after the merge. */
  liveTurnIds: string[]
  /** Rows this merge appended (for transport message events). */
  added: ChatMessage[]
}

/** Fields the transcript UI renders. Everything else (reactions, attachments,
 *  hermesRowId) is preserved through the merge and must not force a commit. */
function renderSignature(m: ChatMessage): string {
  return JSON.stringify([
    m.id,
    m.role,
    m.content,
    m.streaming === true,
    m.error === true,
    m.toolEvents ?? null,
    m.replyTo ?? null,
    m.pending === true,
    m.fromAgentId ?? null,
  ])
}

/** Render fields plus the server ordering stamps — a stamp that moved must
 *  commit (and persist) even when nothing visible changed. */
function rowSignature(m: ChatMessage): string {
  return renderSignature(m) + JSON.stringify([m.turnId ?? null, m.turnCreatedAt ?? null, m.createdAt])
}



function nonBlank(v: string | null | undefined): string | undefined {
  const t = typeof v === 'string' ? v.trim() : ''
  return t || undefined
}

/**
 * First unstamped, non-outbox user row whose text matches — and that is not
 * positioned below a server-ordered row NEWER than the turn being merged
 * (such a row is a later send, not this turn's echo). `key` null (old server,
 * no createdAt) → position is unknown, any matching row qualifies.
 */
function findUnstampedEcho(msgs: ChatMessage[], userText: string, key: OrderKey | null): number {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    const k = orderKey(m)
    if (key && k && compareKeys(k, key) > 0) return -1
    if (m.role === 'user' && !m.turnId && !m.answerAt && m.pending !== true && userTextOf(m) === userText) return i
  }
  return -1
}

/** A stamped user row from a different turn with the same text, sent within
 *  `windowMs` of `at` (group fan-out twin). */
function findCrossTurnUserTwin(
  msgs: ChatMessage[],
  userText: string,
  turnId: string,
  at: number,
  windowMs: number,
): number {
  return msgs.findIndex((m) => {
    if (m.role !== 'user' || !m.turnId || m.turnId === turnId || !m.turnCreatedAt) return false
    const t = Date.parse(m.turnCreatedAt)
    return !Number.isNaN(t) && Math.abs(t - at) <= windowMs && userTextOf(m) === userText
  })
}

/**
 * Hidden mid-thread gap: the newest server page does not reach back to the
 * newest turn this device already has, and the server has older turns. The
 * cached rows would sit flush against the page with the turns between them
 * missing (and "Load earlier" would fill the hole out of view).
 */
export function hasHistoryGap(
  pageTurns: ChatTurnState[],
  pageHasMore: boolean,
  existing: ChatMessage[],
): boolean {
  if (!pageHasMore || pageTurns.length === 0) return false
  let newest: OrderKey | null = null
  for (const m of existing) {
    const k = orderKey(m)
    if (k && (!newest || compareKeys(k, newest) > 0)) newest = k
  }
  if (!newest) return false
  const cached = newest
  let oldestPage: number | null = null
  for (const t of pageTurns) {
    if (t?.id === cached.turnId) return false
    const at = serverTime(t?.createdAt)
    if (!at) return false // old server: no ordering, cannot tell
    const ms = Date.parse(at)
    if (oldestPage === null || ms < oldestPage) oldestPage = ms
  }
  return oldestPage !== null && oldestPage > cached.at
}

/**
 * Gap fallback: the server is authoritative, so server-known rows older than
 * `oldestKeptAt` (the oldest turn actually fetched) are dropped rather than
 * shown flush against newer history. Local-only rows are kept.
 */
export function dropServerRowsOlderThan(existing: ChatMessage[], oldestKeptAt: string): ChatMessage[] {
  const cut = Date.parse(oldestKeptAt)
  if (Number.isNaN(cut)) return existing
  const out = existing.filter((m) => {
    const k = orderKey(m)
    return !k || k.at >= cut
  })
  return out.length === existing.length ? existing : out
}

/** Reply-note-free, persona-free text of a user row (echo matching). */
function userTextOf(m: ChatMessage): string {
  const local = displayUserPrompt(m.content)
  const localDecoded = decodeReplyNote(local)
  return localDecoded ? displayUserPrompt(localDecoded.text) : local
}

export function turnsToMessages(
  turns: ChatTurnState[],
  existing: ChatMessage[],
  opts: TurnMergeOptions,
): TurnMergeResult {
  const newId = opts.newId ?? ((prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 9)}`)
  const now = opts.now ?? (() => new Date().toISOString())
  const liveTurnIds: string[] = []
  const added: ChatMessage[] = []
  const prependAt = opts.prepend ? { i: 0 } : null

  // Same pre-pass the per-turn path ran: stored user prompts from older
  // phone builds carry a persona wrap — strip it (idempotent).
  let msgs = existing.map((m) => {
    if (m.role !== 'user') return m
    const next = displayUserPrompt(m.content)
    return next !== m.content ? { ...m, content: next } : m
  })
  // A merge that grows at the top must start below a leading system row
  // ("Conversation started.") so older history lands under it.
  if (prependAt) {
    while (prependAt.i < msgs.length && msgs[prependAt.i].role === 'system') prependAt.i += 1
  }

  // Ids the server owns: this payload's turns plus rows stamped earlier.
  // Rebinding (streaming fallback / identical text) may only take a row that
  // is none of these AND carries a local id — never another turn's bubble.
  const serverIds = new Set<string>()
  for (const t of turns) if (t?.id) serverIds.add(t.id)
  const rebindable = (m: ChatMessage) =>
    !m.turnId && !serverIds.has(m.id) && isLocalMessageId(m.id)

  const replaceAt = (i: number, next: ChatMessage) => {
    if (rowSignature(next) !== rowSignature(msgs[i])) {
      msgs = msgs.map((m, j) => (j === i ? next : m))
    }
  }

  for (const turn of turns) {
    if (!turn?.id) continue
    const status: ChatTurnState['status'] = turn.status
    const live = status === 'pending' || status === 'streaming'
    if (live) liveTurnIds.push(turn.id)
    const at = serverTime(turn.createdAt)
    // Server ordering stamp; createdAt drives hover time + bubble grouping.
    const stamp: Partial<ChatMessage> = {
      turnId: turn.id,
      ...(at ? { turnCreatedAt: at, createdAt: at } : {}),
    }

    // The server echoes the MODEL text, which for a reply carries the
    // `[The user is replying to …]` note the client prepended at send time.
    // The local echo stores the raw prompt, so comparing the two verbatim
    // never matches — compare on the reply-note-free text instead.
    const rawUserText = turn.user?.text?.trim() ?? ''
    // Files attached to that send come back as a note in the text.
    const attachedPaths = splitAttachmentNote(decodeReplyNote(rawUserText)?.text ?? rawUserText).paths
    const decodedUser = decodeReplyNote(rawUserText)
    const userText = displayUserPrompt(decodedUser ? decodedUser.text : rawUserText)
    if (userText) {
      // Echo dedupe: the row already stamped with this turn, else the first
      // unstamped bubble with the same text (the optimistic local echo, or a
      // row persisted before stamps existed) — which then takes the stamp.
      // The same prompt sent twice is two turns → two stamped bubbles.
      // (A typed answer to a mid-reply question carries the turn id too, but
      // it is never the turn's prompt.)
      let ui = msgs.findIndex((m) => m.role === 'user' && m.turnId === turn.id && !m.answerAt)
      // Text fallback — never for an OLDER page (older turns are never local
      // sends: a prepended "continue" must not steal a just-sent echo into old
      // history), never an outbox row, and only a row that is not already
      // below a server turn newer than this one (i.e. at/before where this
      // turn belongs in the thread).
      if (ui < 0 && !opts.prepend) {
        ui = findUnstampedEcho(msgs, userText, at ? { at: Date.parse(at), turnId: turn.id, rank: 0 } : null)
      }
      // Group fan-out: another member's copy of this same send is already on
      // screen (stamped with that member's turn). Keep that one row.
      const dupeOfOtherMember =
        ui < 0 && opts.crossTurnUserDedupeMs && at
          ? findCrossTurnUserTwin(msgs, userText, turn.id, Date.parse(at), opts.crossTurnUserDedupeMs)
          : -1
      if (ui >= 0) {
        replaceAt(ui, { ...msgs[ui], ...stamp })
      } else if (dupeOfOtherMember >= 0) {
        // Same send, other member session — nothing to add.
      } else {
        const userMsg: ChatMessage = {
          id: newId('usr'),
          threadId: opts.conversationId,
          role: 'user',
          content: userText,
          createdAt: now(),
          ...stamp,
          ...(attachedPaths.length
            ? {
                attachments: attachedPaths.map((p, n) => ({
                  id: `${turn.id}-att-${n}`,
                  name: attachmentName(p),
                  kind: attachmentKind(p),
                  path: p,
                })),
              }
            : {}),
          ...(decodedUser
            ? {
                replyTo: {
                  id: '',
                  role: decodedUser.role,
                  snippet: decodedUser.snippet,
                } as ChatMessage['replyTo'],
              }
            : {}),
        }
        msgs = insertRow(msgs, userMsg, prependAt)
        added.push(userMsg)
      }
    }

    const assistant = turn.assistantContent ?? ''
    let idx = msgs.findIndex((m) => m.id === turn.id)
    if (idx < 0 && live) {
      // Streaming fallback: bind a LOCAL streaming bubble (the send's
      // `msg_` row, pre-rebind) to this live turn so hydrate patches the same
      // row instead of adding a second bubble. Never a settled turn (an old
      // turn would steal the live bubble) and never another server turn's
      // row. In a group thread several members stream into the same
      // conversation — never bind another member's live bubble.
      idx = msgs.findIndex(
        (m) =>
          m.role === 'agent' &&
          m.streaming &&
          rebindable(m) &&
          (!opts.fromAgentId || !m.fromAgentId || m.fromAgentId === opts.fromAgentId),
      )
      if (idx >= 0) {
        msgs = msgs.map((m, i) => (i === idx ? { ...m, id: turn.id } : m))
      }
    }
    if (idx < 0 && assistant && !live) {
      // A settled turn whose bubble exists under a LOCAL id (offline echo or
      // retry): rebind the last identical settled local agent bubble. Rows
      // owned by other server turns are never candidates.
      let match = -1
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]
        if (m.role === 'agent' && !m.streaming && m.content === assistant && rebindable(m)) match = i
      }
      if (match >= 0) {
        msgs = msgs.map((m, i) => (i === match ? { ...m, id: turn.id } : m))
        idx = match
      }
    }

    // A live SSE stream owns this bubble: stamp its order, never its text.
    if (opts.streamOwnedTurnIds?.has(turn.id)) {
      if (idx >= 0) replaceAt(idx, { ...msgs[idx], ...stamp })
      continue
    }

    const existingMsg = idx >= 0 ? msgs[idx] : undefined
    const toolEvents = turn.activity?.tool
      ? [
          {
            tool: turn.activity.tool,
            label: turn.activity.label,
            emoji: turn.activity.emoji,
            status: 'running' as const,
          },
        ]
      : existingMsg?.toolEvents
    const serverError = nonBlank(turn.errorHeadline) ?? turn.error
    const errorCopy =
      status === 'error' ? opts.formatTurnError?.(serverError) || GENERIC_TURN_ERROR : ''

    if (!existingMsg) {
      // A failed turn with no reply still gets a row: the error headline and
      // the Retry affordance (historical failures used to vanish).
      if (!assistant && !live && status !== 'error') continue
      const reply: ChatMessage = {
        id: turn.id,
        threadId: opts.conversationId,
        role: 'agent',
        fromAgentId: opts.fromAgentId ?? opts.speakerId,
        content: assistant || errorCopy,
        createdAt: now(),
        ...stamp,
        streaming: live,
        ...(status === 'error' && !live ? { error: true } : {}),
        ...(toolEvents ? { toolEvents } : {}),
      }
      msgs = insertRow(msgs, reply, prependAt)
      added.push(reply)
      continue
    }

    let next: ChatMessage
    if (live) {
      next = {
        ...existingMsg,
        ...stamp,
        ...(assistant ? { content: assistant } : {}),
        streaming: true,
        // A resumed turn must stop offering Retry on the live bubble.
        error: false,
        ...(toolEvents ? { toolEvents } : {}),
      }
    } else {
      // A bubble this device was waiting on that settles with no text and no
      // tool chips would render as nothing — the reply just never appears.
      // Show the failure copy (with Retry) instead.
      const settledBlank =
        !assistant &&
        status !== 'error' &&
        existingMsg.streaming === true &&
        !existingMsg.content.trim() &&
        !(existingMsg.toolEvents?.length)
      next = {
        ...existingMsg,
        ...stamp,
        content:
          assistant ||
          (status === 'error' ? errorCopy : settledBlank ? GENERIC_TURN_ERROR : existingMsg.content),
        streaming: false,
        // A settled non-error turn clears the flag: a resumed turn that
        // eventually succeeded must stop offering Retry. An error turn keeps
        // (or sets) it so Retry stays reachable after a reload. A "complete"
        // with no reply text over a local error row is not a success — keep
        // the error (and its Retry) rather than a blank settled bubble.
        error: status === 'error' || settledBlank || (!assistant && existingMsg.error === true),
      }
    }
    // Identity-stable merge: only replace the row when a rendered field (or
    // an ordering stamp) actually moved, so unchanged rows keep their object
    // identity and the memo'd TranscriptRow bail-out holds.
    replaceAt(idx, next)
  }

  msgs = sortKeyedRows(msgs)

  const changed =
    msgs.length !== existing.length ||
    msgs.some((m, i) => m !== existing[i] && rowSignature(m) !== rowSignature(existing[i]))
  // Identical reapply keeps the caller's array (and row) identities intact —
  // the transport then skips setState entirely (C2 quiet polls).
  return { messages: changed ? msgs : existing, changed, liveTurnIds, added }
}
