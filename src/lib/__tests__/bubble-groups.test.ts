import { describe, expect, it } from 'vitest'
import { bubbleGroupPositions, GROUP_GAP_MS, type BubbleGroupRow } from '../bubble-groups'
import type { ChatMessage } from '../agents'

const T0 = Date.parse('2026-09-23T15:00:00Z')

function row(
  id: string,
  role: ChatMessage['role'],
  opts: Partial<ChatMessage> & { at?: number; hidden?: boolean; breakAfter?: boolean } = {},
): BubbleGroupRow {
  const { at = 0, hidden = false, breakAfter = false, ...m } = opts
  return {
    m: {
      id,
      threadId: 't',
      role,
      content: id,
      createdAt: new Date(T0 + at * 1000).toISOString(),
      ...m,
    },
    hidden,
    breakAfter,
  }
}

const pos = (rows: BubbleGroupRow[]) => bubbleGroupPositions(rows)

describe('bubbleGroupPositions', () => {
  it('stacks consecutive bubbles from one speaker', () => {
    expect(
      pos([
        row('u1', 'user'),
        row('u2', 'user', { at: 5 }),
        row('u3', 'user', { at: 9 }),
        row('a1', 'agent', { at: 12 }),
      ]),
    ).toEqual(['first', 'middle', 'last', 'single'])
  })

  it('alternating speakers are all single', () => {
    expect(pos([row('u1', 'user'), row('a1', 'agent'), row('u2', 'user')])).toEqual([
      'single',
      'single',
      'single',
    ])
  })

  it('splits agents by speaker in a group room', () => {
    expect(
      pos([
        row('a1', 'agent', { fromAgentId: 'bob' }),
        row('a2', 'agent', { fromAgentId: 'bob' }),
        row('a3', 'agent', { fromAgentId: 'poke' }),
      ]),
    ).toEqual(['first', 'last', 'single'])
  })

  it('breaks on a long pause', () => {
    const gap = GROUP_GAP_MS / 1000 + 1
    expect(pos([row('u1', 'user'), row('u2', 'user', { at: gap })])).toEqual(['single', 'single'])
  })

  it('breaks on errors, quote replies and non-bubble roles', () => {
    expect(pos([row('a1', 'agent'), row('a2', 'agent', { error: true })])).toEqual([
      'single',
      'single',
    ])
    expect(
      pos([
        row('u1', 'user'),
        row('u2', 'user', { replyTo: { id: 'a0', snippet: 'x', role: 'agent' } }),
      ]),
    ).toEqual(['single', 'single'])
    expect(pos([row('a1', 'agent'), row('s1', 'subagent'), row('a2', 'agent')])).toEqual([
      'single',
      'single',
      'single',
    ])
  })

  it('skips hidden rows without breaking the stack', () => {
    expect(
      pos([row('u1', 'user'), row('x', 'agent', { hidden: true }), row('u2', 'user')]),
    ).toEqual(['first', 'single', 'last'])
  })

  it('a row with cards under it ends the group', () => {
    expect(
      pos([row('a1', 'agent', { breakAfter: true }), row('a2', 'agent'), row('a3', 'agent')]),
    ).toEqual(['single', 'first', 'last'])
  })
})
