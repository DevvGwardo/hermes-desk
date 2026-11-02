/**
 * Message grouping for transcript bubbles (iMessage-style stacks).
 *
 * Consecutive bubbles from the same speaker form one group. Each bubble gets
 * its place in that group so CSS can round the outer corners fully and pinch
 * the corners where bubbles meet (see `.ca-bubble` in index.css), and so the
 * rows inside a group sit tighter than rows between groups.
 */

import type { ChatMessage } from './agents'

export type BubbleGroupPos = 'single' | 'first' | 'middle' | 'last'

/** Two bubbles further apart than this start a new group. */
export const GROUP_GAP_MS = 5 * 60 * 1000

export interface BubbleGroupRow {
  m: ChatMessage
  /** The row renders nothing (no bubble, no cards) — skipped, never a break. */
  hidden: boolean
  /** The row shows no bubble, or shows extra blocks (file cards, artifacts)
   *  under it — it can't join the bubble after it. */
  breakAfter: boolean
}

function groupable(m: ChatMessage): boolean {
  return (m.role === 'user' || m.role === 'agent') && !m.error
}

function joins(prev: ChatMessage, next: ChatMessage): boolean {
  if (!groupable(prev) || !groupable(next)) return false
  if (prev.role !== next.role) return false
  if (prev.role === 'agent') {
    if ((prev.fromAgentId ?? '') !== (next.fromAgentId ?? '')) return false
    if ((prev.toAgentId ?? '') !== (next.toAgentId ?? '')) return false
  }
  // A quote pill opens its own bubble; a thread reply is collapsed anyway.
  if (next.replyTo) return false
  const a = Date.parse(prev.createdAt)
  const b = Date.parse(next.createdAt)
  if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(b - a) > GROUP_GAP_MS) {
    return false
  }
  return true
}

/**
 * Position of every row in its bubble group, aligned with `rows`. Hidden rows
 * get `single` and are ignored when linking their neighbours.
 */
export function bubbleGroupPositions(rows: BubbleGroupRow[]): BubbleGroupPos[] {
  const out: BubbleGroupPos[] = rows.map(() => 'single')
  const visible: number[] = []
  for (let i = 0; i < rows.length; i++) if (!rows[i].hidden) visible.push(i)

  for (let k = 0; k < visible.length; k++) {
    const i = visible[k]
    const prevIdx = k > 0 ? visible[k - 1] : -1
    const nextIdx = k + 1 < visible.length ? visible[k + 1] : -1
    const joinsPrev =
      prevIdx >= 0 && !rows[prevIdx].breakAfter && joins(rows[prevIdx].m, rows[i].m)
    const joinsNext =
      nextIdx >= 0 && !rows[i].breakAfter && joins(rows[i].m, rows[nextIdx].m)
    out[i] = joinsPrev
      ? joinsNext
        ? 'middle'
        : 'last'
      : joinsNext
        ? 'first'
        : 'single'
  }
  return out
}
