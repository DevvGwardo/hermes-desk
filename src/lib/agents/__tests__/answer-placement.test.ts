import { describe, expect, it } from 'vitest'
import { answerAtFor, isReplyPartRow, placeTypedAnswers } from '../answer-placement'
import type { ChatMessage } from '../types'

const row = (over: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content'>): ChatMessage => ({
  threadId: 'c1',
  createdAt: '2026-09-30T10:00:00Z',
  ...over,
})

const ASKED = 'Quick check before I dig in:'

function thread(replyContent: string, extra: Partial<ChatMessage> = {}): ChatMessage[] {
  const paused = row({ id: 'turn_1', role: 'agent', content: ASKED, streaming: true })
  return [
    row({ id: 'usr_1', role: 'user', content: 'order stickers', turnId: 'turn_1' }),
    row({ id: 'turn_1', role: 'agent', content: replyContent, toolEvents: [], ...extra }),
    row({ id: 'usr_2', role: 'user', content: 'my art. endless budget', turnId: 'turn_1', answerAt: answerAtFor(paused) }),
  ]
}

const shape = (msgs: ChatMessage[]) => msgs.map((m) => `${m.role}:${m.content}`)

describe('placeTypedAnswers', () => {
  it('returns the same list when there is nothing to place', () => {
    const msgs = [row({ id: 'a', role: 'user', content: 'hi' }), row({ id: 'b', role: 'agent', content: 'hello' })]
    expect(placeTypedAnswers(msgs)).toBe(msgs)
  })

  it('puts the answer between the question and the rest of the reply', () => {
    const msgs = thread(`${ASKED}\n\nGreat — custom it is. Here is the plan.`)
    const out = placeTypedAnswers(msgs)
    expect(shape(out)).toEqual([
      'user:order stickers',
      `agent:${ASKED}`,
      'user:my art. endless budget',
      'agent:Great — custom it is. Here is the plan.',
    ])
    // The continuing part is the real row; the earlier part is display-only.
    expect(out[3]!.id).toBe('turn_1')
    expect(out[3]!.toolEvents).toEqual([])
    expect(isReplyPartRow(out[1]!)).toBe(true)
    expect(isReplyPartRow(out[3]!)).toBe(false)
    expect(out[1]!.toolEvents).toBeUndefined()
    // The stored rows are untouched.
    expect(shape(msgs)).toEqual([
      'user:order stickers',
      `agent:${ASKED}\n\nGreat — custom it is. Here is the plan.`,
      'user:my art. endless budget',
    ])
  })

  it('shows an empty live bubble below the answer while the agent thinks', () => {
    const out = placeTypedAnswers(thread(ASKED, { streaming: true }))
    expect(shape(out)).toEqual(['user:order stickers', `agent:${ASKED}`, 'user:my art. endless budget', 'agent:'])
    expect(out[3]).toMatchObject({ id: 'turn_1', streaming: true })
  })

  it('leaves the rows alone when the reply ended at the question', () => {
    const out = placeTypedAnswers(thread(ASKED))
    expect(shape(out)).toEqual(['user:order stickers', `agent:${ASKED}`, 'user:my art. endless budget'])
    expect(out[1]!.id).toBe('turn_1')
  })

  it('puts the answer first when the agent asked before writing anything', () => {
    const msgs = [
      row({ id: 'turn_1', role: 'agent', content: 'On it.', streaming: true }),
      row({ id: 'usr_2', role: 'user', content: 'blue', answerAt: { replyId: 'turn_1', offset: 0, tail: '' } }),
    ]
    expect(shape(placeTypedAnswers(msgs))).toEqual(['user:blue', 'agent:On it.'])
  })

  it('re-finds the spot when the settled text shifted', () => {
    const msgs = thread(`  ${ASKED}\n\nDone.`)
    expect(shape(placeTypedAnswers(msgs))).toEqual([
      'user:order stickers',
      `agent:${ASKED}`,
      'user:my art. endless budget',
      'agent:Done.',
    ])
  })

  it('keeps the stored order when the reply text was replaced (failed turn)', () => {
    const msgs = thread("The agent couldn't finish this reply.", { error: true })
    expect(placeTypedAnswers(msgs)).toBe(msgs)
  })

  it('handles two questions in one reply', () => {
    const first = row({ id: 'turn_1', role: 'agent', content: 'One?' })
    const second = row({ id: 'turn_1', role: 'agent', content: 'One? Ok. Two?' })
    const msgs = [
      row({ id: 'turn_1', role: 'agent', content: 'One? Ok. Two? All set.' }),
      row({ id: 'usr_a', role: 'user', content: 'yes', answerAt: answerAtFor(first) }),
      row({ id: 'usr_b', role: 'user', content: 'no', answerAt: answerAtFor(second) }),
    ]
    const out = placeTypedAnswers(msgs)
    expect(shape(out)).toEqual(['agent:One?', 'user:yes', 'agent:Ok. Two?', 'user:no', 'agent:All set.'])
    expect(new Set(out.map((m) => m.id)).size).toBe(5)
  })

  it('finds the reply by turn after its row id changed, and ignores an answer with no reply', () => {
    const msgs = [
      row({ id: 'msg_local', role: 'agent', content: `${ASKED} Sure.`, turnId: 'turn_9' }),
      row({ id: 'usr_2', role: 'user', content: 'ok', turnId: 'turn_9', answerAt: { replyId: 'gone', offset: ASKED.length, tail: ASKED.slice(-24) } }),
      row({ id: 'usr_3', role: 'user', content: 'stray', answerAt: { replyId: 'nowhere', offset: 3, tail: 'abc' } }),
    ]
    expect(shape(placeTypedAnswers(msgs))).toEqual([`agent:${ASKED}`, 'user:ok', 'agent:Sure.', 'user:stray'])
  })

  it('is stable: same input list, same output, same earlier-part object', () => {
    const msgs = thread(`${ASKED} More.`)
    const a = placeTypedAnswers(msgs)
    expect(placeTypedAnswers(msgs)).toBe(a)
    const b = placeTypedAnswers([...msgs.slice(0, 1), { ...msgs[1]!, content: `${ASKED} More text.` }, msgs[2]!])
    expect(b[1]).toBe(a[1])
    expect(b[3]!.content).toBe('More text.')
  })
})
