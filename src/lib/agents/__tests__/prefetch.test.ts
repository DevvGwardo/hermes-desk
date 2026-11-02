import { describe, expect, it } from 'vitest'
import {
  canPrefetchOnThisConnection,
  pickBehindConversations,
  pickWarmConversations,
  runLimited,
  WARM_COUNT,
} from '../prefetch'
import type { Conversation } from '../types'

function conv(id: string, lastUsedAt: string, partial: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: id,
    target: { type: 'agent', agentId: 'inst_1' },
    createdAt: '2026-09-01T00:00:00Z',
    lastUsedAt,
    hermesSessionId: `sess_${id}`,
    ...partial,
  }
}

describe('pickWarmConversations', () => {
  const none = () => false
  it('picks the most recent threads in sidebar order, pinned first, up to WARM_COUNT', () => {
    const list = [
      conv('a', '2026-09-28T01:00:00Z'),
      conv('b', '2026-09-28T05:00:00Z'),
      conv('c', '2026-09-28T03:00:00Z'),
      conv('d', '2026-09-20T00:00:00Z', { pinned: true }),
      conv('e', '2026-09-28T04:00:00Z'),
      conv('f', '2026-09-28T02:00:00Z'),
    ]
    expect(pickWarmConversations(list, { selectedId: null, liveIds: new Set(), hasCachedRows: none })).toEqual([
      'd',
      'b',
      'e',
      'c',
    ])
    expect(WARM_COUNT).toBe(4)
  })

  it('skips the open, hidden, live, cached, group and unsynced threads', () => {
    const list = [
      conv('open', '2026-09-28T09:00:00Z'),
      conv('hidden', '2026-09-28T08:00:00Z', { hiddenFromSidebar: true }),
      conv('live', '2026-09-28T07:00:00Z'),
      conv('cached', '2026-09-28T06:00:00Z'),
      conv('group', '2026-09-28T05:00:00Z', { target: { type: 'group', groupId: 'g' } }),
      conv('local', '2026-09-28T04:00:00Z', { hermesSessionId: undefined }),
      conv('ok', '2026-09-28T03:00:00Z'),
    ]
    expect(
      pickWarmConversations(list, {
        selectedId: 'open',
        liveIds: new Set(['live']),
        hasCachedRows: (id) => id === 'cached',
      }),
    ).toEqual(['ok'])
  })
})

describe('canPrefetchOnThisConnection', () => {
  it('prefetches online, not offline or in data-saver', () => {
    expect(canPrefetchOnThisConnection({ onLine: true })).toBe(true)
    expect(canPrefetchOnThisConnection({ onLine: false })).toBe(false)
    expect(canPrefetchOnThisConnection({ onLine: true, connection: { saveData: true } })).toBe(false)
  })
})

describe('runLimited', () => {
  it('never runs more than `concurrency` at once and survives a failure', async () => {
    let running = 0
    let peak = 0
    const done: number[] = []
    await runLimited([1, 2, 3, 4, 5], 2, async (n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      if (n === 3) throw new Error('boom')
      done.push(n)
    })
    expect(peak).toBe(2)
    expect(done.sort()).toEqual([1, 2, 4, 5])
  })
})

describe('pickBehindConversations', () => {
  const stamped = (id: string, at: string) => [
    { id: `${id}-u`, threadId: id, role: 'user' as const, content: 'q', createdAt: at, turnCreatedAt: at },
    { id: `${id}-a`, threadId: id, role: 'agent' as const, content: 'a', createdAt: at, turnCreatedAt: at },
  ]
  const cache: Record<string, ReturnType<typeof stamped>> = {
    a: stamped('a', '2026-09-28T01:00:00Z'),
    b: stamped('b', '2026-09-28T05:00:00Z'),
    c: stamped('c', '2026-09-28T03:00:00Z'),
  }
  const messagesFor = (id: string) => cache[id] ?? []

  it('picks recent cached threads the sync feed moved past, in sidebar order', () => {
    const list = [
      conv('a', '2026-09-28T06:00:00Z'), // behind
      conv('b', '2026-09-28T05:00:00Z'), // current
      conv('c', '2026-09-28T07:00:00Z'), // behind
      conv('d', '2026-09-28T08:00:00Z'), // no cache: boot warm-up's job
    ]
    expect(pickBehindConversations(list, { selectedId: null, liveIds: new Set(), messagesFor })).toEqual(['c', 'a'])
  })

  it('skips the open, live, hidden, group and already-warmed threads', () => {
    const list = [
      conv('a', '2026-09-28T06:00:00Z'),
      conv('c', '2026-09-28T07:00:00Z'),
    ]
    expect(pickBehindConversations(list, { selectedId: 'c', liveIds: new Set(['a']), messagesFor })).toEqual([])
    expect(
      pickBehindConversations([conv('a', '2026-09-28T06:00:00Z', { hiddenFromSidebar: true })], {
        selectedId: null,
        liveIds: new Set(),
        messagesFor,
      }),
    ).toEqual([])
    expect(
      pickBehindConversations(list, {
        selectedId: null,
        liveIds: new Set(),
        messagesFor,
        skip: (id, at) => id === 'c' && at === '2026-09-28T07:00:00Z',
      }),
    ).toEqual(['a'])
  })

  it('only looks at the WARM_COUNT most recent threads', () => {
    const list = Array.from({ length: WARM_COUNT + 2 }, (_, i) =>
      conv(`n${i}`, `2026-09-28T1${i}:00:00Z`),
    )
    list.push(conv('a', '2026-09-28T06:00:00Z'))
    expect(pickBehindConversations(list, { selectedId: null, liveIds: new Set(), messagesFor })).toEqual([])
  })
})
