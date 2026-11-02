import { describe, expect, it } from 'vitest'
import {
  applyReaction,
  clipReplySnippet,
  decodeReplyNote,
  encodeReplyNote,
  groupReactions,
  hydrateMessageExtras,
  QUICK_REACTIONS,
  replyPreviewFromMessage,
} from '../message-actions'

describe('message-actions', () => {
  it('uses Grok Bot quick reactions, not Hermes iOS ‼️/❓', () => {
    expect([...QUICK_REACTIONS]).toEqual(['👍', '👎', '❤️', '😂', '🎉', '😮'])
  })

  it('toggles one reaction per author (tapback)', () => {
    const heart = applyReaction([], '❤️', 'user')
    expect(heart).toEqual([expect.objectContaining({ emoji: '❤️', author: 'user' })])
    const same = applyReaction(heart, '❤️', 'user')
    expect(same).toEqual([])
    const swapped = applyReaction(heart, '👍', 'user')
    expect(swapped).toEqual([expect.objectContaining({ emoji: '👍', author: 'user' })])
    const both = applyReaction(heart, '😂', 'agent')
    expect(both).toHaveLength(2)
  })

  it('groups Grok-style pills by emoji', () => {
    const grouped = groupReactions([
      { emoji: '👍', author: 'user' },
      { emoji: '👍', author: 'agent' },
      { emoji: '❤️', author: 'agent' },
    ])
    expect(grouped[0]).toMatchObject({ emoji: '👍', count: 2, isMine: true })
    expect(grouped[1]).toMatchObject({ emoji: '❤️', count: 1, isMine: false })
  })

  it('clips reply snippets like Grok quote (96) / pill (72)', () => {
    const long = 'word '.repeat(40).trim()
    expect(clipReplySnippet(long, 16).endsWith('…')).toBe(true)
    expect(clipReplySnippet(long, 16).length).toBeLessThanOrEqual(16)
  })

  it.each([72, 96, 120])('keeps Unicode intact at the %i-character reply preview boundary', max => {
    const preview = clipReplySnippet('x'.repeat(max - 2) + '😀 more text', max)
    expect(new TextDecoder().decode(new TextEncoder().encode(preview))).toBe(preview)
    expect(preview).toBe('x'.repeat(max - 2) + '…')
    expect(preview.length).toBeLessThanOrEqual(max)
    expect(clipReplySnippet('A complete 😀 label', max)).toBe('A complete 😀 label')
  })

  it.each(['', ' \n\t '])('previews the attached filename for a blank caption %j', content => {
    expect(replyPreviewFromMessage({
      id: 'original', threadId: 'room', role: 'user', content,
      createdAt: '2026-10-10T06:00:00Z',
      attachments: [{ id: 'constraints-file', name: 'constraints.txt', path: '/fake/constraints.txt', kind: 'file' }],
    })).toEqual({ id: 'original', role: 'user', snippet: 'constraints.txt' })
  })

  it('round-trips the Hermes-facing reply note without leaking into decode', () => {
    const encoded = encodeReplyNote(
      { id: 'm1', role: 'agent', snippet: 'ship the "fix"' },
      'do it now',
    )
    expect(encoded.startsWith('[The user is replying to your message:')).toBe(true)
    const decoded = decodeReplyNote(encoded)
    expect(decoded).toEqual({
      text: 'do it now',
      snippet: 'ship the "fix"',
      role: 'agent',
    })
  })

  it('hydrates row id, reactions, and a persisted reply prefix', () => {
    const extra = hydrateMessageExtras(
      '[The user is replying to their own message: "hello"]\n\nagain',
      {
        id: 42,
        displayMetadata: { reactions: [{ emoji: '🎉', author: 'agent', at: 1 }] },
      },
    )
    expect(extra).toMatchObject({
      content: 'again',
      hermesRowId: 42,
      replyTo: { role: 'user', snippet: 'hello' },
      reactions: [{ emoji: '🎉', author: 'agent', at: 1 }],
    })
  })
})
