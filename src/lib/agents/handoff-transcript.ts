import type { HandoffState, HandoffStrip } from './rooms'
import type { ChatMessage } from './types'

/**
 * The conversation behind one hand-off strip, for the transcript modal: the
 * message that handed off, each asked member's reply (or live status), the
 * hand-offs those replies made in turn, then the Chief's wrap-up. Built from
 * the room transcript + strips the client already has — the rooms API has
 * no per-turn log. Pure.
 */
export type HandoffTranscriptEntry =
  | {
      kind: 'message'
      rowId: string
      message: ChatMessage
      /** 0 = the hand-off message; each nested hand-off adds one. */
      depth: number
      /** The hand-off turn that wrote it (null for the opening message). */
      turnId: string | null
    }
  | {
      kind: 'status'
      memberId: string
      name: string
      state: HandoffState | 'pending'
      label: string
      depth: number
      turnId: string | null
    }

/** Nesting cap: a runaway @mention chain can't blow the modal up. */
export const HANDOFF_TRANSCRIPT_MAX_DEPTH = 4

export function buildHandoffTranscript(
  rowId: string,
  strips: ReadonlyMap<string, HandoffStrip>,
  messagesById: ReadonlyMap<string, ChatMessage>,
  followUps?: {
    /** Strips for every trigger, human-started ones included (a follow-up
     *  the user sends from the modal starts its own root). */
    threadStrips?: ReadonlyMap<string, HandoffStrip> | null
    /** The room's messages in order — where follow-ups are discovered. */
    ordered: readonly ChatMessage[]
  },
): HandoffTranscriptEntry[] {
  const out: HandoffTranscriptEntry[] = []
  const seen = new Set<string>()
  const depthOf = new Map<string, number>()
  if (followUps?.threadStrips) strips = followUps.threadStrips

  const visit = (id: string, depth: number, turnId: string | null) => {
    if (seen.has(id)) return
    seen.add(id)
    const message = messagesById.get(id)
    depthOf.set(id, depth)
    if (message) out.push({ kind: 'message', rowId: id, message, depth, turnId })
    const strip = strips.get(id)
    if (!strip || depth >= HANDOFF_TRANSCRIPT_MAX_DEPTH) return
    const pills = strip.wrap ? [...strip.pills, strip.wrap] : strip.pills
    for (const p of pills) {
      const pillTurn = p.turnId || null
      if (p.replyRowId && messagesById.has(p.replyRowId)) {
        visit(p.replyRowId, depth + 1, pillTurn)
      } else if (!p.replyRowId || !seen.has(p.replyRowId)) {
        out.push({
          kind: 'status',
          memberId: p.memberId,
          name: p.name,
          state: p.state,
          label: p.label,
          depth: depth + 1,
          turnId: pillTurn,
        })
      }
    }
  }

  visit(rowId, 0, null)

  // Follow-ups: a human message that replies to anything already in this
  // thread (e.g. sent from the modal) joins it, with the answers it started.
  // Repeat until stable — a follow-up to a follow-up joins too.
  if (followUps) {
    for (let grew = true; grew; ) {
      grew = false
      for (const m of followUps.ordered) {
        const parent = m.replyTo?.id
        if (m.role !== 'user' || seen.has(m.id) || !parent || !seen.has(parent)) continue
        visit(m.id, Math.min((depthOf.get(parent) ?? 0) + 1, HANDOFF_TRANSCRIPT_MAX_DEPTH - 1), null)
        grew = true
      }
    }
  }
  return out
}

/** Where a reply typed in the modal goes. The member the user opened the
 *  modal from wins: reply to their latest message; if they haven't posted
 *  yet (still working), reply to the thread's latest message but @mention
 *  them (the server routes mentions before reply targets). Otherwise the
 *  thread's latest agent message, else the opening message. */
export function handoffReplyTarget(
  entries: readonly HandoffTranscriptEntry[],
  preferMemberId?: string | null,
): { message: ChatMessage; mention: { id: string; name: string } | null } | null {
  const latestAgent = (from?: string) => {
    let latest: ChatMessage | null = null
    for (const e of entries) {
      if (e.kind !== 'message' || e.message.role !== 'agent') continue
      if (from && e.message.fromAgentId !== from) continue
      if (!latest || e.message.createdAt >= latest.createdAt) latest = e.message
    }
    return latest
  }
  const first = entries.find((e) => e.kind === 'message')
  const fallback = latestAgent() ?? (first && first.kind === 'message' ? first.message : null)
  if (preferMemberId) {
    const own = latestAgent(preferMemberId)
    if (own) return { message: own, mention: null }
    const status = entries.find((e) => e.kind === 'status' && e.memberId === preferMemberId)
    if (fallback && status && status.kind === 'status') {
      return { message: fallback, mention: { id: preferMemberId, name: status.name } }
    }
  }
  return fallback ? { message: fallback, mention: null } : null
}
