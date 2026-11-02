import { describe, expect, it } from 'vitest'
import {
  repliesChipLabel,
  threadGroups,
  threadMessagesFor,
  topLevelMessages,
} from '../threading'
import type { ChatMessage } from '../agents/types'

/** A THREAD reply (collapses under its root). Quote replies — the plain
 *  "Reply" gesture — use `quoteMsg` instead. */
function msg(id: string, content: string, replyToId?: string): ChatMessage {
  return {
    id,
    threadId: 't1',
    role: id.startsWith('u') ? 'user' : 'agent',
    content,
    createdAt: `2026-08-22T00:00:${String(Math.abs(hash(id)) % 60).padStart(2, '0')}.000Z`,
    ...(replyToId
      ? { replyTo: { id: replyToId, role: 'user' as const, snippet: '', thread: true } }
      : {}),
  }
}

/** A QUOTE reply: carries `replyTo` for its quote pill but is NOT a thread
 *  reply, so it must stay inline in the main transcript. */
function quoteMsg(id: string, content: string, replyToId: string): ChatMessage {
  const m = msg(id, content)
  return { ...m, replyTo: { id: replyToId, role: 'user' as const, snippet: 'quoted' } }
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

describe('threadGroups (A4)', () => {
  it('collapses an A→B→C chain under root A', () => {
    const messages = [msg('u1', 'root question'), msg('a1', 'first answer', 'u1'), msg('a2', 'nested answer', 'a1')]
    const groups = threadGroups(messages)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.root.id).toBe('u1')
    expect(groups[0]!.replies.map((m) => m.id)).toEqual(['a1', 'a2'])
    expect(groups[0]!.all.map((m) => m.id)).toEqual(['u1', 'a1', 'a2'])
  })

  it('keeps unthreaded messages as their own groups alongside a thread', () => {
    const messages = [
      msg('u9', 'standalone'),
      msg('u1', 'root'),
      msg('a1', 'reply', 'u1'),
    ]
    const groups = threadGroups(messages)
    expect(groups.map((g) => g.root.id)).toEqual(['u9', 'u1'])
    const threaded = groups.find((g) => g.root.id === 'u1')!
    expect(threaded.replies).toHaveLength(1)
  })

  it('keeps a QUOTE reply inline instead of collapsing it into a thread', () => {
    // Regression: `Reply` and `Reply in thread` both set `replyTo`, so a
    // quoted reply used to collapse under its target and disappear from the
    // transcript behind an "N replies" chip.
    const messages = [msg('a1', 'the agent answer'), quoteMsg('u2', 'my quote reply', 'a1')]
    const groups = threadGroups(messages)
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.replies.length === 0)).toBe(true)
    expect(topLevelMessages(messages).map((m) => m.id)).toEqual(['a1', 'u2'])
  })

  it('still collapses a THREAD reply that also carries a quote', () => {
    const messages = [msg('u1', 'root'), msg('u2', 'thread reply', 'u1')]
    expect(topLevelMessages(messages).map((m) => m.id)).toEqual(['u1'])
  })

  it('resolves absorbed serve replies via snippet when the id misses', () => {
    const parent = msg('u1', 'what changed in the deploy today')
    const absorbed: ChatMessage = {
      ...msg('srv1', 'the api rolled out cleanly'),
      replyTo: { id: 'missing-row', role: 'user', snippet: 'what changed in the deploy today', thread: true },
    }
    const groups = threadGroups([parent, absorbed])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.replies[0]!.id).toBe('srv1')
  })

  it('does not loop on cyclic reply links', () => {
    const x = { ...msg('x1', 'x'), replyTo: { id: 'y1', role: 'agent' as const, snippet: '', thread: true } }
    const y = { ...msg('y1', 'y'), replyTo: { id: 'x1', role: 'user' as const, snippet: '', thread: true } }
    // Must terminate and keep every message somewhere.
    const groups = threadGroups([x, y])
    expect(groups.flatMap((g) => g.all)).toHaveLength(2)
  })

  it('does not collide two messages sharing a 96-char prefix in the snippet index', () => {
    // Regression: the snippet index used to truncate keys at 96 chars, so an
    // absorbed reply whose snippet matched the SECOND message with a shared
    // prefix resolved to the FIRST and threaded under the wrong root.
    const prefix = 'a'.repeat(96)
    const first = msg('u1', `${prefix} FIRST tail that differs between the two parents`)
    const second = msg('u2', `${prefix} SECOND tail that differs between the two parents`)
    const snippet = second.content.replace(/\s+/g, ' ').trim()
    const absorbed: ChatMessage = {
      ...msg('srv1', 'the api rolled out cleanly'),
      replyTo: { id: 'missing-row', role: 'user', snippet, thread: true },
    }
    const groups = threadGroups([first, second, absorbed])
    expect(groups).toHaveLength(2)
    const underSecond = groups.find((g) => g.root.id === 'u2')!
    expect(underSecond.replies.map((m) => m.id)).toEqual(['srv1'])
    const underFirst = groups.find((g) => g.root.id === 'u1')!
    expect(underFirst.replies).toHaveLength(0)
  })

  it('prefers a full-content exact match over a colliding 96-char prefix', () => {
    // The short message's full content equals the long message's 96-char
    // prefix: a snippet carrying the short content must resolve to the short
    // message even though the long message comes first in the conversation.
    const shortText = 'q'.repeat(96)
    const long = msg('u1', `${shortText} plus a distinguishing tail that makes it longer`)
    const short = msg('u2', shortText)
    const absorbed: ChatMessage = {
      ...msg('srv1', 'the api rolled out cleanly'),
      replyTo: { id: 'missing-row', role: 'user', snippet: shortText, thread: true },
    }
    const groups = threadGroups([long, short, absorbed])
    expect(groups).toHaveLength(2)
    const underShort = groups.find((g) => g.root.id === 'u2')!
    expect(underShort.replies.map((m) => m.id)).toEqual(['srv1'])
    const underLong = groups.find((g) => g.root.id === 'u1')!
    expect(underLong.replies).toHaveLength(0)
  })

  it('resolves a legacy 96-char truncated snippet to its parent', () => {
    // Reply quotes are cut at 96 chars (ThreadPane), so absorbed replies may
    // carry a truncated snippet that predates the full-content index. It must
    // still resolve instead of falling back to a trivial group.
    const content = `${'x'.repeat(96)} and then a long tail that pushes well past ninety-six chars`
    const parent = msg('u1', content)
    const snippet = content.replace(/\s+/g, ' ').trim().slice(0, 96)
    expect(snippet).toHaveLength(96)
    const absorbed: ChatMessage = {
      ...msg('srv2', 'the api rolled out cleanly'),
      replyTo: { id: 'missing-row', role: 'user', snippet, thread: true },
    }
    const groups = threadGroups([parent, absorbed])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.replies[0]!.id).toBe('srv2')
  })
})

describe('topLevelMessages / chip label / pane lookup', () => {
  const messages = [
    msg('u1', 'root question'),
    msg('a1', 'first answer', 'u1'),
    msg('u2', 'unrelated'),
    msg('a2', 'nested answer', 'a1'),
  ]

  it('drops collapsed replies from the main transcript', () => {
    expect(topLevelMessages(messages).map((m) => m.id)).toEqual(['u1', 'u2'])
  })

  it('labels the root chip with the descendant count only', () => {
    expect(repliesChipLabel(msg('u1', 'root question'), messages)).toBe('2 replies')
    expect(repliesChipLabel(msg('u2', 'unrelated'), messages)).toBe('')
  })

  it('returns the full ordered chain for the pane', () => {
    expect(threadMessagesFor('u1', messages).map((m) => m.id)).toEqual(['u1', 'a1', 'a2'])
    expect(threadMessagesFor('nope', messages)).toEqual([])
  })

  it('uses singular "reply" for one descendant', () => {
    const two = [msg('u1', 'r'), msg('a1', 'only reply', 'u1')]
    expect(repliesChipLabel(two[0]!, two)).toBe('1 reply')
  })
})
