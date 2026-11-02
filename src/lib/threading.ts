/**
 * Reply threading (A4) — derived, not stored.
 *
 * Grok parity: a reply chain A→B→C collapses under its root A. The main
 * transcript shows the root bubble with an "N replies" chip; the full chain
 * renders in the ThreadPane. Grouping is pure: given one conversation's
 * messages, compute roots, descendant counts, and per-message thread paths.
 */

import type { ChatMessage } from './agents/types'

export interface ThreadGroup {
  /** The root message (the bubble that stays in the main transcript). */
  root: ChatMessage
  /** Root + descendants in conversation order — what ThreadPane renders. */
  all: ChatMessage[]
  /** Descendants only (the count on the "N replies" chip). */
  replies: ChatMessage[]
}

/**
 * Follow `replyTo.id` links up to the root. Falls back to snippet matching
 * for replies absorbed from Hermes transcripts, where `replyTo.id` may carry
 * the quoted snippet instead of a local message id. Returns the message id of
 * the root, or null when this reply doesn't resolve inside `byId`.
 */
export function replyRootId(
  msg: ChatMessage,
  byId: Map<string, ChatMessage>,
  bySnippet: Map<string, ChatMessage>,
): string | null {
  let current = msg
  const seen = new Set<string>([msg.id])
  while (current.replyTo) {
    const parent =
      byId.get(current.replyTo.id) ??
      (current.replyTo.snippet ? bySnippet.get(current.replyTo.snippet) : undefined)
    if (!parent || seen.has(parent.id)) return null
    seen.add(parent.id)
    current = parent
  }
  return current.id
}

/** Snippet index for absorbed replies: trimmed content → first message with it. */
function snippetIndex(messages: ChatMessage[]): Map<string, ChatMessage> {
  const out = new Map<string, ChatMessage>()
  const prefixes: Array<[string, ChatMessage]> = []
  for (const m of messages) {
    const key = m.content.replace(/\s+/g, ' ').trim()
    if (key && !out.has(key)) out.set(key, m)
    // Legacy fallback: reply quotes are still cut at 96 chars (ThreadPane),
    // so absorbed/out-of-conversation replies may carry a truncated snippet.
    const prefix = key.slice(0, 96)
    if (prefix && prefix !== key) prefixes.push([prefix, m])
  }
  // Full keys first so an exact full-content match always wins over a
  // colliding prefix; first-seen wins among colliding prefixes (old behavior,
  // strictly better than a miss).
  for (const [prefix, m] of prefixes) {
    if (!out.has(prefix)) out.set(prefix, m)
  }
  return out
}

/**
 * Group one conversation's messages into threads. Messages whose reply chain
 * resolves to another message in the list collapse under that root; every
 * other message is its own trivial group. Output preserves conversation order
 * by root position.
 */
export function threadGroups(messages: ChatMessage[]): ThreadGroup[] {
  const byId = new Map<string, ChatMessage>()
  for (const m of messages) byId.set(m.id, m)
  const bySnippet = snippetIndex(messages)

  const groups = new Map<string, ThreadGroup>()
  const order: string[] = []

  for (const m of messages) {
    // Only THREAD replies collapse. A quote reply ("Reply") also carries
    // `replyTo` — for its inline quote pill — and must stay in the main
    // transcript; treating it as a thread reply hid the user's own message.
    // An unresolvable thread reply (parent absent from this conversation)
    // stays its own trivial thread rather than being silently dropped.
    //
    // Legacy note: messages persisted before the flag existed carry no
    // `thread`, so they read as quote replies and un-collapse. That is the
    // safe direction — a visible message beats one hidden behind a chip, and
    // new replies carry the flag.
    const isThreadReply = m.replyTo?.thread === true
    const key =
      isThreadReply ? replyRootId(m, byId, bySnippet) ?? m.id : m.id
    let group = groups.get(key)
    if (!group) {
      const root = byId.get(key) ?? m
      group = { root, all: [root], replies: [] }
      groups.set(key, group)
      order.push(key)
    }
    if (m.id !== key) {
      group.all.push(m)
      group.replies.push(m)
    }
  }

  const out: ThreadGroup[] = []
  for (const id of order) {
    const g = groups.get(id)
    if (g) out.push(g)
  }
  return out
}

/**
 * Main-transcript filter: drop messages that collapsed into another
 * message's thread (they live in the pane). Trivial groups pass through.
 * Accepts precomputed groups so callers that already derived them (e.g. once
 * per render) don't pay for a second grouping pass.
 */
export function topLevelMessages(messages: ChatMessage[], groups?: ThreadGroup[]): ChatMessage[] {
  const list = groups ?? threadGroups(messages)
  const collapsed = new Set<string>()
  for (const g of list) {
    for (const r of g.replies) collapsed.add(r.id)
  }
  return messages.filter((m) => !collapsed.has(m.id))
}

/** Reply-count chip text for a precomputed descendant count. */
export function repliesChipLabelForCount(count: number): string {
  return count > 0 ? `${count} ${count === 1 ? 'reply' : 'replies'}` : ''
}

/** Reply-count chip label for a root bubble from precomputed groups. */
export function repliesChipLabelForRoot(rootId: string, groups: ThreadGroup[]): string {
  const n = groups.find((g) => g.root.id === rootId)?.replies.length ?? 0
  return repliesChipLabelForCount(n)
}

/** Reply-count chip label for a root bubble ('' when there are no replies). */
export function repliesChipLabel(root: ChatMessage, messages: ChatMessage[], groups?: ThreadGroup[]): string {
  const n = (groups ?? threadGroups(messages)).find((g) => g.root.id === root.id)?.replies.length ?? 0
  return repliesChipLabelForCount(n)
}

/** All messages of the thread rooted at `rootId` from precomputed groups. */
export function threadMessagesForRoot(rootId: string, groups: ThreadGroup[]): ChatMessage[] {
  return groups.find((g) => g.root.id === rootId)?.all ?? []
}

/** All messages of the thread rooted at `rootId`, conversation-ordered. */
export function threadMessagesFor(rootId: string, messages: ChatMessage[], groups?: ThreadGroup[]): ChatMessage[] {
  return (groups ?? threadGroups(messages)).find((g) => g.root.id === rootId)?.all ?? []
}
