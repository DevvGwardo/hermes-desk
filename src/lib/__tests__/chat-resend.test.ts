import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../agents'
import { askAgainTarget, draftAfterEdit, resendableAttachments } from '../chat-resend'

function msg(partial: Pick<ChatMessage, 'id' | 'role' | 'content'> & Partial<ChatMessage>): ChatMessage {
  return { threadId: 't1', createdAt: '2026-10-03T12:00:00Z', ...partial }
}

describe('askAgainTarget', () => {
  it('offers the newest reply and resends the prompt it answered', () => {
    const prompt = msg({ id: 'u2', role: 'user', content: 'compare the plans' })
    const target = askAgainTarget([
      msg({ id: 'u1', role: 'user', content: 'hi' }),
      msg({ id: 'a1', role: 'agent', content: 'hello' }),
      prompt,
      msg({ id: 'a2', role: 'agent', content: 'here is the comparison' }),
    ])
    expect(target).toEqual({ rowId: 'a2', prompt })
  })

  it('skips answers typed to a mid-turn question when finding the prompt', () => {
    const target = askAgainTarget([
      msg({ id: 'u1', role: 'user', content: 'book a table' }),
      msg({ id: 'a1', role: 'agent', content: 'for how many?' }),
      msg({ id: 'u2', role: 'user', content: '4', answerAt: { replyId: 'a1', offset: 13, tail: '' } }),
      msg({ id: 'a2', role: 'agent', content: 'booked' }),
    ])
    expect(target?.prompt.id).toBe('u1')
    expect(target?.rowId).toBe('a2')
  })

  it('skips agent-to-agent notes, which are not replies to you', () => {
    const target = askAgainTarget([
      msg({ id: 'u1', role: 'user', content: 'deploy it' }),
      msg({ id: 'a1', role: 'agent', content: 'deployed' }),
      msg({ id: 'd1', role: 'agent', content: 'need the summary', fromAgentId: 'ops', toAgentId: 'alpha' }),
    ])
    expect(target?.rowId).toBe('a1')
    expect(
      askAgainTarget([
        msg({ id: 'u1', role: 'user', content: 'deploy it' }),
        msg({ id: 'd1', role: 'agent', content: 'need the summary', fromAgentId: 'ops', toAgentId: 'alpha' }),
      ]),
    ).toBeNull()
  })

  it('offers nothing while the reply streams, after a failure, or before any reply', () => {
    const u = msg({ id: 'u1', role: 'user', content: 'go' })
    expect(askAgainTarget([u, msg({ id: 'a1', role: 'agent', content: 'wor', streaming: true })])).toBeNull()
    expect(askAgainTarget([u, msg({ id: 'a1', role: 'agent', content: 'failed', error: true })])).toBeNull()
    expect(askAgainTarget([u])).toBeNull()
    expect(askAgainTarget([])).toBeNull()
  })
})

describe('draftAfterEdit', () => {
  it('fills an empty draft and keeps anything already typed', () => {
    expect(draftAfterEdit('', 'hello')).toBe('hello')
    expect(draftAfterEdit('  ', 'hello')).toBe('hello')
    expect(draftAfterEdit('half a thought  ', 'hello')).toBe('half a thought\n\nhello')
    const padded = `a${'\n'.repeat(60_000)}b  `
    const started = performance.now()
    expect(draftAfterEdit(padded, 'hello')).toBe(`${padded.trimEnd()}\n\nhello`)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('resendableAttachments', () => {
  it('keeps only files that live on the agent computer', () => {
    const m = msg({
      id: 'u1',
      role: 'user',
      content: 'see attached',
      attachments: [
        { id: '1', name: 'a.pdf', kind: 'file', path: '/opt/data/workspace/a.pdf', size: 10 },
        { id: '2', name: 'b.png', kind: 'image' },
      ],
    })
    expect(resendableAttachments(m)).toEqual([{ name: 'a.pdf', path: '/opt/data/workspace/a.pdf', kind: 'file', size: 10 }])
  })
})
