import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_HISTORY_CAP,
  cycleConversationId,
  historyStep,
  pushConversationHistory,
} from '../useAgentRuntime'

describe('conversation history / cycle', () => {
  it('pushes, trims forward stack, and caps at 20', () => {
    const a = pushConversationHistory([], -1, 'a')
    const b = pushConversationHistory(a.stack, a.index, 'b')
    const c = pushConversationHistory(b.stack, b.index, 'c')
    expect(c.stack).toEqual(['a', 'b', 'c'])
    const back = historyStep(c.stack, c.index, -1)
    expect(back).toEqual({ id: 'b', index: 1 })
    const branched = pushConversationHistory(c.stack, back!.index, 'd')
    expect(branched.stack).toEqual(['a', 'b', 'd'])

    let cur = { stack: [] as string[], index: -1 }
    for (let i = 0; i < CONVERSATION_HISTORY_CAP + 5; i++) {
      cur = pushConversationHistory(cur.stack, cur.index, `c${i}`)
    }
    expect(cur.stack).toHaveLength(CONVERSATION_HISTORY_CAP)
    expect(cur.stack[0]).toBe('c5')
  })

  it('does not duplicate the current id', () => {
    const a = pushConversationHistory([], -1, 'a')
    const again = pushConversationHistory(a.stack, a.index, 'a')
    expect(again.stack).toEqual(['a'])
  })

  it('cycles visible sidebar ids', () => {
    expect(cycleConversationId(['a', 'b', 'c'], 'b', 1)).toBe('c')
    expect(cycleConversationId(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(cycleConversationId(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(cycleConversationId([], 'a', 1)).toBeNull()
  })
})
