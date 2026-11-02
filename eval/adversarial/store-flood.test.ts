/**
 * Adversarial store-flood tests — drive the REAL agents store
 * (src/lib/agents/store.ts) with hostile volumes/orderings:
 *   - 10,000 rapid streaming token deltas on one message
 *   - two interleaved/out-of-order turn streams in one thread
 *   - streaming-flag flip mid-stream + transcript replay (the known
 *     "double bubble" class), using the app's actual hydrate write path:
 *     parseTranscriptMessages → mergePreservedReactions → setState replace,
 *     exactly as loadHermesTranscript/tryServeTranscript do it.
 *
 * Conventions matched from src/lib/agents/__tests__/store.test.ts:
 * fake timers, rAF stubbed (jsdom has none), resetStore between tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendMessage,
  appendMessageContent,
  createConversation,
  flushMessagePatches,
  getMessagesForConversation,
  getState,
  patchMessage,
  resetStore,
  setState,
  subscribe,
  upsertTurn,
} from '../../src/lib/agents/store'
import { parseTranscriptMessages } from '../../src/lib/agents/hermes-sessions'
import { mergePreservedReactions } from '../../src/lib/message-actions'
import type { ChatMessage } from '../../src/lib/agents/types'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-22T12:00:00Z'))
  // jsdom has no requestAnimationFrame; the store coalesces patches with it.
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  // Seed agents/groups/conversations: this suite drives the real store and
  // needs a live agent id (`getState().agents[0]`) exactly as
  // src/lib/agents/__tests__/store.test.ts seeds it.
  resetStore({ seed: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function newConv(): string {
  const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
  return conv.id
}

function agentMsg(threadId: string, id: string): ChatMessage {
  return {
    id,
    threadId,
    role: 'agent',
    content: '',
    createdAt: new Date().toISOString(),
    streaming: true,
    toolEvents: [],
  }
}

describe('token-delta flood', () => {
  it('10,000 rapid deltas land intact and in order via the pending-patch queue', () => {
    const conv = newConv()
    appendMessage(conv, {
      id: 'u1',
      threadId: conv,
      role: 'user',
      content: 'go',
      createdAt: new Date().toISOString(),
    })
    appendMessage(conv, agentMsg(conv, 'turn_flood'))

    let notifies = 0
    const unsub = subscribe(() => {
      notifies += 1
    })

    const expected: string[] = []
    for (let i = 0; i < 10_000; i++) {
      const tok = `t${i} `
      expected.push(tok)
      appendMessageContent(conv, 'turn_flood', tok)
    }
    // Coalescing contract: nothing hits the store until a flush.
    expect(notifies).toBe(0)

    flushMessagePatches()
    unsub()

    const msg = getMessagesForConversation(conv).find((m) => m.id === 'turn_flood')!
    expect(msg.content).toBe(expected.join(''))
    expect(msg.content.startsWith('t0 t1 t2 ')).toBe(true)
    expect(msg.content.endsWith('t9998 t9999 ')).toBe(true)
    expect(msg.streaming).toBe(true) // still mid-stream; only content grew

    // No unbounded growth: one user bubble + one agent bubble (+ system opener).
    expect(getMessagesForConversation(conv)).toHaveLength(3)
    // The whole flood produced exactly ONE extra store notify (the flush).
    expect(notifies).toBe(1)
  })

  it('a second flush after draining emits nothing (pending map fully drained)', () => {
    const conv = newConv()
    appendMessage(conv, agentMsg(conv, 'turn_drain'))
    for (let i = 0; i < 100; i++) appendMessageContent(conv, 'turn_drain', 'x')
    flushMessagePatches()

    let notifies = 0
    const unsub = subscribe(() => {
      notifies += 1
    })
    flushMessagePatches()
    unsub()
    expect(notifies).toBe(0)
  })
})

describe('interleaved out-of-order turns', () => {
  it('two interleaved turn streams never cross-contaminate their bubbles', () => {
    const conv = newConv()
    appendMessage(conv, agentMsg(conv, 'turn_a'))
    appendMessage(conv, agentMsg(conv, 'turn_b'))
    upsertTurn({
      id: 'turn_a',
      threadId: conv,
      agentId: getState().agents[0]!.id,
      userMessageId: 'u_a',
      phase: 'working',
      subagentRunIds: [],
      startedAt: new Date().toISOString(),
    })
    upsertTurn({
      id: 'turn_b',
      threadId: conv,
      agentId: getState().agents[0]!.id,
      userMessageId: 'u_b',
      phase: 'working',
      subagentRunIds: [],
      startedAt: new Date().toISOString(),
    })

    const tokensA = ['alpha1 ', 'alpha2 ', 'alpha3 ', 'alpha4 ']
    const tokensB = ['bravo1 ', 'bravo2 ', 'bravo3 ', 'bravo4 ']
    // Round-robin AND reversed order within each pair — hostile ordering.
    for (let i = 0; i < tokensA.length; i++) {
      appendMessageContent(conv, 'turn_b', tokensB[i])
      appendMessageContent(conv, 'turn_a', tokensA[i])
    }
    flushMessagePatches()

    const byId = (id: string) =>
      getMessagesForConversation(conv).find((m) => m.id === id)!
    expect(byId('turn_a').content).toBe(tokensA.join(''))
    expect(byId('turn_b').content).toBe(tokensB.join(''))

    // Each turn id maps to exactly ONE message; texts are not interleaved.
    const thread = getMessagesForConversation(conv)
    for (const turnId of ['turn_a', 'turn_b']) {
      expect(thread.filter((m) => m.id === turnId)).toHaveLength(1)
    }
    expect(thread.find((m) => m.id === 'turn_a')!.content.includes('bravo')).toBe(false)
    expect(thread.find((m) => m.id === 'turn_b')!.content.includes('alpha')).toBe(false)

    // Turn registry: one entry per turn id, each pointing at its own user msg.
    const turnsById = getState().turnsById
    expect(Object.keys(turnsById).sort()).toEqual(['turn_a', 'turn_b'])
    expect(turnsById['turn_a']!.userMessageId).toBe('u_a')
    expect(turnsById['turn_b']!.userMessageId).toBe('u_b')
  })
})

describe('streaming flip + transcript replay (double-bubble class)', () => {
  /**
   * Replay a hermes session transcript into a thread through the exact
   * store write used by loadHermesTranscript / tryServeTranscript.
   */
  function hydrateReplay(conversationId: string, sessionId: string, messages: unknown[]): void {
    const parsed = parseTranscriptMessages(sessionId, JSON.stringify({ messages }))
    if (parsed.length === 0) return
    const previous = getState().messagesByThreadId[conversationId] ?? []
    const thread = mergePreservedReactions(
      previous,
      parsed.map((m) => ({ ...m, threadId: conversationId })),
    )
    setState((prev) => ({
      messagesByThreadId: {
        ...prev.messagesByThreadId,
        [conversationId]: thread,
      },
    }))
  }

  function liveScenario(): { conv: string; stream: (tok: string) => void } {
    const conv = newConv()
    appendMessage(conv, {
      id: 'u_live',
      threadId: conv,
      role: 'user',
      content: 'status?',
      createdAt: new Date().toISOString(),
    })
    appendMessage(conv, agentMsg(conv, 'turn_live'))
    return {
      conv,
      stream: (tok: string) => {
        appendMessageContent(conv, 'turn_live', tok)
        flushMessagePatches()
      },
    }
  }

  it('hydrate replay after a mid-stream streaming:false flip creates no duplicates', () => {
    const { conv, stream } = liveScenario()
    stream('partial ')
    // Flip the flag MID-stream (urgent patch flushes immediately).
    patchMessage(conv, 'turn_live', { streaming: false })
    const flipped = getMessagesForConversation(conv).find((m) => m.id === 'turn_live')!
    expect(flipped.streaming).toBe(false)
    expect(flipped.content).toBe('partial ')

    const serverRows = [
      { role: 'user', content: 'status?', id: 1 },
      { role: 'assistant', content: 'partial full answer', id: 2 },
    ]
    // Replays happen back-to-back in production (poll + open). Both must be
    // idempotent replaces, not appends.
    hydrateReplay(conv, 'sess_replay', serverRows)
    const once = getMessagesForConversation(conv)
    hydrateReplay(conv, 'sess_replay', serverRows)
    const twice = getMessagesForConversation(conv)

    expect(once).toHaveLength(twice.length)
    const ids = twice.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length) // zero duplicate ids
    expect(twice.filter((m) => m.id === 'turn_live')).toHaveLength(0) // replaced, not doubled
    expect(twice.find((m) => m.role === 'agent')?.content).toBe('partial full answer')
  })

  it('late deltas aimed at a replayed-away bubble are dropped without creating messages', () => {
    const { conv, stream } = liveScenario()
    stream('gone soon ')
    patchMessage(conv, 'turn_live', { streaming: false })
    hydrateReplay(conv, 'sess_late', [
      { role: 'assistant', content: 'server answer', id: 9 },
    ])
    const before = getMessagesForConversation(conv)

    expect(() => {
      appendMessageContent(conv, 'turn_live', ' late token')
      patchMessage(conv, 'turn_live', { toolEvents: [{ tool: 'bash', status: 'completed' }] })
      flushMessagePatches()
    }).not.toThrow()

    const after = getMessagesForConversation(conv)
    expect(after).toHaveLength(before.length)
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id))
  })

  it('guarded re-append of a settled turn (transport re-sync pattern) does not double-bubble', () => {
    const { conv } = liveScenario()
    patchMessage(conv, 'turn_live', { streaming: false })
    flushMessagePatches()

    // Exactly what hermes-deploy-transport.attachTurn does on reattach:
    // only append the placeholder when no message with that id exists.
    const exists = getMessagesForConversation(conv).some((m) => m.id === 'turn_live')
    if (!exists) appendMessage(conv, agentMsg(conv, 'turn_live'))
    expect(getMessagesForConversation(conv).filter((m) => m.id === 'turn_live')).toHaveLength(1)
  })
})

describe('registry growth bounds', () => {
  // The live store bounds the turn registry: capRuns (store.ts, MAX_RUNS_KEPT)
  // keeps only the 50 most recent terminal turns and never evicts live ones.
  // A 300-turn flood therefore cannot grow turnsById without bound.
  const MAX_RUNS_KEPT = 50

  it('300 turns: turnsById is bounded to the most recent 50 (no unbounded leak)', () => {
    const conv = newConv()
    const N = 300
    const agentId = getState().agents[0]!.id
    // Distinct, increasing timestamps so "most recent" is well-defined.
    const base = Date.parse('2026-08-22T12:00:00Z')
    const at = (i: number) => new Date(base + i * 1000).toISOString()
    for (let i = 0; i < N; i++) {
      const turnId = `turn_${i}`
      upsertTurn({
        id: turnId,
        threadId: conv,
        agentId,
        userMessageId: `u_${i}`,
        phase: 'done',
        subagentRunIds: [],
        startedAt: at(i),
      })
      upsertTurn({
        // Duplicate upsert must overwrite, not grow the registry.
        id: turnId,
        threadId: conv,
        agentId,
        userMessageId: `u_${i}`,
        phase: 'failed',
        subagentRunIds: [],
        startedAt: at(i),
      })
      appendMessage(conv, {
        id: `u_${i}`,
        threadId: conv,
        role: 'user',
        content: `q ${i}`,
        createdAt: at(i),
      })
      appendMessage(conv, agentMsg(conv, turnId))
      patchMessage(conv, turnId, { content: `a ${i}`, streaming: false })
    }
    flushMessagePatches()

    const turns = getState().turnsById
    expect(Object.keys(turns)).toHaveLength(MAX_RUNS_KEPT)
    // Newest retained, oldest evicted, duplicates overwritten in place.
    expect(turns['turn_299']).toBeDefined()
    expect(turns['turn_250']).toBeDefined()
    expect(turns['turn_249']).toBeUndefined()
    expect(turns['turn_42']).toBeUndefined()
    expect(turns['turn_299']!.phase).toBe('failed')

    const thread = getMessagesForConversation(conv)
    // system opener + N user + N agent bubbles — nothing else ever appears,
    // and no bubble id is ever duplicated across the flood.
    expect(thread).toHaveLength(1 + 2 * N)
    const ids = thread.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
