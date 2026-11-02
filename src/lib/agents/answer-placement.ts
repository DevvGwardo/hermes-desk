/**
 * Where a typed answer to a mid-reply question belongs in the transcript.
 *
 * The agent asks a question partway through a reply, the user types the
 * answer, and the agent carries on IN THE SAME REPLY. Stored, that is one
 * agent row followed by the user's row — so read top to bottom the answer
 * came after text that was written because of it.
 *
 * The store keeps that shape (one row per server turn: hydration, retry and
 * paging all key on it). The answer row records where in the reply it was
 * given (`answerAt`), and this module lays the rows out for display: the
 * reply up to the question, the answer, then the rest of the reply.
 */
import type { ChatMessage } from './types'

type AnswerAt = NonNullable<ChatMessage['answerAt']>

/** Id suffix of a display-only row holding an earlier part of a split reply. */
const PART_MARK = '~part'
const TAIL_CHARS = 24

/** A display-only earlier part of a split reply: not a real message, so it
 *  takes no replies, reactions or threads. */
export function isReplyPartRow(m: Pick<ChatMessage, 'id'>): boolean {
  return m.id.includes(PART_MARK)
}

/** Mark for an answer given now, while `reply` is paused on its question. */
export function answerAtFor(reply: ChatMessage): AnswerAt {
  const offset = reply.content.length
  return { replyId: reply.id, offset, tail: reply.content.slice(Math.max(0, offset - TAIL_CHARS)) }
}

/**
 * Where the reply is cut for this answer, or null when the text no longer
 * lines up (a failed turn's error copy replaced it) — the answer then stays
 * where it is stored.
 */
function cutPoint(content: string, at: AnswerAt): number | null {
  if (at.offset === 0) return 0
  if (content.slice(Math.max(0, at.offset - at.tail.length), at.offset) === at.tail) return at.offset
  // The settled text can differ from the streamed one by a few characters.
  const i = at.tail ? content.indexOf(at.tail) : -1
  return i >= 0 ? i + at.tail.length : null
}

function replyIndexFor(messages: ChatMessage[], answer: ChatMessage, answerIndex: number): number {
  const at = answer.answerAt!
  for (let i = answerIndex - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'agent') continue
    if (m.id === at.replyId) return i
    if (answer.turnId && (m.id === answer.turnId || m.turnId === answer.turnId)) return i
  }
  return -1
}

// Earlier parts are rebuilt on every streamed token; reuse the object while
// its text is unchanged so memo'd rows stay put.
const partCache = new Map<string, ChatMessage>()
const PART_CACHE_MAX = 200

function partRow(reply: ChatMessage, n: number, content: string): ChatMessage {
  const id = `${reply.id}${PART_MARK}${n}`
  const cached = partCache.get(id)
  if (
    cached &&
    cached.content === content &&
    cached.fromAgentId === reply.fromAgentId &&
    cached.createdAt === reply.createdAt
  ) {
    return cached
  }
  const row: ChatMessage = {
    id,
    threadId: reply.threadId,
    role: reply.role,
    content,
    createdAt: reply.createdAt,
    ...(reply.fromAgentId ? { fromAgentId: reply.fromAgentId } : {}),
    ...(reply.turnId ? { turnId: reply.turnId } : {}),
    ...(reply.turnCreatedAt ? { turnCreatedAt: reply.turnCreatedAt } : {}),
  }
  if (partCache.size >= PART_CACHE_MAX) partCache.clear()
  partCache.set(id, row)
  return row
}

const placed = new WeakMap<ChatMessage[], ChatMessage[]>()

/**
 * Display order for a thread: each typed answer sits at the point of the
 * reply where it was given. The last part of a split reply is the real row
 * (its id, live state, tools and reactions); earlier parts are display-only.
 * Returns `messages` itself when nothing needs placing.
 */
export function placeTypedAnswers(messages: ChatMessage[]): ChatMessage[] {
  const hit = placed.get(messages)
  if (hit) return hit
  const out = place(messages)
  placed.set(messages, out)
  return out
}

function place(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some((m) => m.answerAt)) return messages

  const byReply = new Map<number, { answer: ChatMessage; cut: number }[]>()
  const moved = new Set<ChatMessage>()
  messages.forEach((m, i) => {
    if (m.role !== 'user' || !m.answerAt) return
    const ri = replyIndexFor(messages, m, i)
    if (ri < 0) return
    const cut = cutPoint(messages[ri]!.content, m.answerAt)
    if (cut === null) return
    const list = byReply.get(ri) ?? []
    list.push({ answer: m, cut })
    byReply.set(ri, list)
    moved.add(m)
  })
  if (moved.size === 0) return messages

  const out: ChatMessage[] = []
  messages.forEach((m, i) => {
    if (moved.has(m)) return
    const answers = byReply.get(i)
    if (!answers) {
      out.push(m)
      return
    }
    answers.sort((a, b) => a.cut - b.cut)
    // Alternating: text before each answer, the answer, …, the rest.
    const texts: string[] = []
    let prev = 0
    for (const a of answers) {
      texts.push(m.content.slice(prev, a.cut).trim())
      prev = a.cut
    }
    const rest = m.content.slice(prev).replace(/^\s+/, '')
    const restShown = rest.trim() !== '' || m.streaming === true
    // The real row is the last part with anything to show.
    let realAt = restShown ? texts.length : -1
    if (realAt < 0) {
      for (let t = texts.length - 1; t >= 0; t--) {
        if (texts[t]) {
          realAt = t
          break
        }
      }
    }
    if (realAt < 0) {
      // Nothing to split (an empty reply): leave the rows as stored.
      out.push(m, ...answers.map((a) => a.answer))
      return
    }
    texts.forEach((text, t) => {
      if (t === realAt) out.push({ ...m, content: text })
      else if (text) out.push(partRow(m, t, text))
      out.push(answers[t]!.answer)
    })
    if (realAt === texts.length) out.push({ ...m, content: rest })
  })
  return out
}
