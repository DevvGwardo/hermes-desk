/**
 * Grok Bot v0.18 hover-action contract, wired to Hermes-agent.
 *
 * Grok renderer (asar 0.18 `index-UbX-y3il.js`):
 *   - hover toolbar: Add reaction (smiley-happy) · Reply (arrow-u-up-*) · More
 *   - quick picker: 👍 👎 ❤️ 😂 🎉 😮 + "More emoji" (smiley-plus)
 *   - reply composer: sand-prompt-reply-pill (arrow + 72-char preview + Cancel)
 *   - in-bubble quote: sand-reply-quote (96-char, arrow-u-up-right)
 *
 * Hermes backend:
 *   - `message.react` RPC + `message.reaction` events (iOS tapback, one per author)
 *   - `display.message_reactions` must be on for the model to hear tapbacks
 *   - no reply-to RPC — we prefix the model-facing prompt and keep the
 *     transcript bubble clean via `replyTo` on the local ChatMessage
 */

import type { ChatMessage, MessageReaction, MessageReplyTo, MessageRole } from './agents/types'
import { getMessagesForConversation, patchMessage } from './agents/store'

/** Grok Bot quick row — not Hermes' iOS ‼️/❓ set. */
export const QUICK_REACTIONS = ['👍', '👎', '❤️', '😂', '🎉', '😮'] as const

export const REPLY_QUOTE_CHARS = 96
export const REPLY_PILL_CHARS = 72

const REACTIONS_PREF_KEY = 'maia:message-reactions'

/** Expanded picker (Grok uses emojibase; we ship a local catalog, no CDN). */
export const MORE_EMOJI: { id: string; label: string; emojis: string[] }[] = [
  {
    id: 'smileys',
    label: 'Smileys',
    emojis: ['😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😜', '🤔', '🤨', '😐', '😴', '😢', '😭', '😤', '😡', '🤯', '🥳', '😎'],
  },
  {
    id: 'gestures',
    label: 'Gestures',
    emojis: ['👍', '👎', '👏', '🙌', '🤝', '🙏', '💪', '✌️', '🤞', '👌', '👋', '🫶', '❤️', '💔', '🔥', '⭐', '🎉', '💯', '✨', '⚡', '‼️', '❓', '✅', '❌'],
  },
  {
    id: 'work',
    label: 'Work',
    emojis: ['💡', '🧠', '📝', '📌', '📎', '🔍', '🛠️', '⚙️', '💻', '🧪', '🚀', '🐛', '🧱', '📦', '🗂️', '📈'],
  },
]

export function areMessageReactionsEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(REACTIONS_PREF_KEY)
    if (raw == null) return true
    return raw !== '0' && raw !== 'false'
  } catch {
    return true
  }
}

export function setMessageReactionsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(REACTIONS_PREF_KEY, enabled ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/** One reaction per author; re-tapping the same emoji retracts (Hermes tapback). */
export function applyReaction(
  reactions: MessageReaction[] | undefined,
  emoji: string | null,
  author: MessageReaction['author'],
): MessageReaction[] {
  const current = reactions ?? []
  const previous = current.find((r) => r.author === author)
  const without = current.filter((r) => r.author !== author)
  if (!emoji || previous?.emoji === emoji) return without
  return [...without, { emoji, author, at: Date.now() / 1000 }]
}

export interface GroupedReaction {
  emoji: string
  count: number
  isMine: boolean
  reactors: MessageReaction['author'][]
}

/** Grok `DTe` — group by emoji, mark the user's as mine. */
export function groupReactions(reactions: MessageReaction[] | undefined): GroupedReaction[] {
  const list = reactions ?? []
  const order: string[] = []
  const byEmoji = new Map<string, GroupedReaction>()
  for (const r of list) {
    const hit = byEmoji.get(r.emoji)
    if (!hit) {
      order.push(r.emoji)
      byEmoji.set(r.emoji, {
        emoji: r.emoji,
        count: 1,
        isMine: r.author === 'user',
        reactors: [r.author],
      })
      continue
    }
    hit.count += 1
    hit.isMine = hit.isMine || r.author === 'user'
    if (!hit.reactors.includes(r.author)) hit.reactors.push(r.author)
  }
  return order.map((emoji) => byEmoji.get(emoji)!).filter(Boolean)
}

export function clipReplySnippet(text: string, max = REPLY_QUOTE_CHARS): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const clipped = t.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd()
  return `${clipped}…`
}

export function replyPreviewFromMessage(msg: ChatMessage): MessageReplyTo {
  return {
    id: msg.id,
    role: msg.role,
    snippet: clipReplySnippet(msg.content.trim() || (msg.attachments?.[0]?.name ?? '')),
  }
}

const REPLY_NOTE_RE =
  /^\[The user is replying to (your|their own) message: "((?:\\.|[^"\\])*)"\]\n\n/

export function encodeReplyNote(replyTo: MessageReplyTo, text: string): string {
  const whose = replyTo.role === 'user' ? 'their own' : 'your'
  const snippet = clipReplySnippet(replyTo.snippet, 120)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
  return `[The user is replying to ${whose} message: "${snippet}"]\n\n${text}`
}

export function decodeReplyNote(text: string): {
  text: string
  snippet: string
  role: MessageRole
} | null {
  const m = REPLY_NOTE_RE.exec(text)
  if (!m) return null
  const snippet = (m[2] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  return {
    text: text.slice(m[0].length),
    snippet,
    role: m[1] === 'their own' ? 'user' : 'agent',
  }
}

export function submitTextForReply(text: string, replyTo?: MessageReplyTo): string {
  return replyTo ? encodeReplyNote(replyTo, text) : text
}

export function reactionsFromDisplayMetadata(meta: unknown): MessageReaction[] | undefined {
  let parsed = meta
  if (typeof meta === 'string') {
    try {
      parsed = JSON.parse(meta) as unknown
    } catch {
      return undefined
    }
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const raw = (parsed as { reactions?: unknown }).reactions
  if (!Array.isArray(raw)) return undefined
  const out: MessageReaction[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as { emoji?: unknown; author?: unknown; by?: unknown; at?: unknown }
    const emoji = typeof rec.emoji === 'string' ? rec.emoji : ''
    if (!emoji) continue
    const author: MessageReaction['author'] =
      rec.author === 'agent' || rec.by === 'agent' ? 'agent' : 'user'
    const at = typeof rec.at === 'number' ? rec.at : undefined
    out.push({ emoji, author, at })
  }
  return out.length > 0 ? out : undefined
}

export function hydrateMessageExtras(
  content: string,
  opts: {
    id?: number | string | null
    replyToId?: string | null
    displayMetadata?: unknown
  } = {},
): Pick<ChatMessage, 'content' | 'replyTo' | 'reactions' | 'hermesRowId'> {
  const decoded = decodeReplyNote(content)
  const reactions = reactionsFromDisplayMetadata(opts.displayMetadata)
  const row =
    typeof opts.id === 'number'
      ? opts.id
      : typeof opts.id === 'string' && /^\d+$/.test(opts.id)
        ? Number(opts.id)
        : undefined
  return {
    content: decoded?.text ?? content,
    ...(decoded
      ? {
          replyTo: {
            id: opts.replyToId ?? decoded.snippet ?? '',
            role: decoded.role,
            snippet: decoded.snippet,
          },
        }
      : {}),
    ...(reactions ? { reactions } : {}),
    ...(row != null ? { hermesRowId: row } : {}),
  }
}

export function applyLocalReaction(
  conversationId: string,
  messageId: string,
  emoji: string | null,
  author: MessageReaction['author'] = 'user',
): MessageReaction[] {
  const msg = getMessagesForConversation(conversationId).find((m) => m.id === messageId)
  const next = applyReaction(msg?.reactions, emoji, author)
  if (msg) patchMessage(conversationId, messageId, { reactions: next })
  return next
}

export function mergePreservedReactions(
  previous: ChatMessage[],
  next: ChatMessage[],
): ChatMessage[] {
  if (previous.length === 0) return next
  const byRow = new Map<number, ChatMessage>()
  const byId = new Map<string, ChatMessage>()
  for (const m of previous) {
    byId.set(m.id, m)
    if (m.hermesRowId != null) byRow.set(m.hermesRowId, m)
  }
  return next.map((msg) => {
    if (msg.reactions && msg.reactions.length > 0) return msg
    const prev =
      (msg.hermesRowId != null ? byRow.get(msg.hermesRowId) : undefined) ?? byId.get(msg.id)
    if (!prev?.reactions?.length) return msg
    return { ...msg, reactions: [...prev.reactions] }
  })
}
