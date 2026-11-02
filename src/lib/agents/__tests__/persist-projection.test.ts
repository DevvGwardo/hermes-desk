import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../logger'
import {
  buildPersistProjection,
  clearPersistedState,
  INLINE_IMAGE_PLACEHOLDER,
  loadPersistedState,
  MAX_PERSIST_PINNED_THREADS,
  MAX_PERSIST_THREADS,
  QUOTA_RETRY_LIMITS,
  savePersistedState,
  stripInlineImages,
  trimPersistMessage,
} from '../persist'
import type { AgentsState } from '../store'
import type { ChatMessage, Conversation } from '../types'

const LEGACY_KEY = 'maia:agents-store:v1'
const META_KEY = 'maia:agents-store:v2'
const THREAD_KEY = (id: string) => `maia:agents-store:v2:t:${id}`

function state(overrides: Partial<AgentsState> = {}): AgentsState {
  return {
    agents: [],
    groups: [],
    conversations: [],
    messagesByThreadId: {},
    subagentsById: {},
    turnsById: {},
    selectedConversationId: null,
    ...overrides,
  }
}

const msg = (patch: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1',
  threadId: 'c1',
  role: 'agent',
  content: 'hi',
  createdAt: '2026-08-13T12:00:00Z',
  ...patch,
})

const conv = (id: string, lastUsedAt: string): Conversation => ({
  id,
  title: id,
  target: { type: 'agent', agentId: 'a1' },
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt,
  hermesSessionId: `s-${id}`,
})

/** N threads; thread i was last used i minutes after the base time. */
function manyThreads(n: number): AgentsState {
  const conversations: Conversation[] = []
  const messagesByThreadId: AgentsState['messagesByThreadId'] = {}
  for (let i = 0; i < n; i++) {
    const id = `c${i}`
    const at = new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString()
    conversations.push(conv(id, at))
    messagesByThreadId[id] = [msg({ id: `m${i}`, threadId: id, createdAt: at })]
  }
  return state({ conversations, messagesByThreadId })
}

const PNG = `data:image/png;base64,${'A'.repeat(5000)}`

afterEach(() => {
  vi.restoreAllMocks()
  // Also clears the session quota latch.
  clearPersistedState()
})

describe('buildPersistProjection thread cap', () => {
  it('keeps messages for only the most recently active threads', () => {
    const s = manyThreads(MAX_PERSIST_THREADS + 10)
    const out = buildPersistProjection(s)
    const kept = Object.keys(out.messagesByThreadId)
    expect(kept).toHaveLength(MAX_PERSIST_THREADS)
    // Newest are the highest indices.
    expect(kept).toContain(`c${MAX_PERSIST_THREADS + 9}`)
    expect(kept).not.toContain('c0')
    // Conversation rows (the sidebar) are never dropped.
    expect(out.conversations).toHaveLength(MAX_PERSIST_THREADS + 10)
  })

  it('always keeps the selected thread even when it is old', () => {
    const s = { ...manyThreads(MAX_PERSIST_THREADS + 5), selectedConversationId: 'c0' }
    const out = buildPersistProjection(s)
    expect(out.messagesByThreadId.c0).toHaveLength(1)
    expect(Object.keys(out.messagesByThreadId)).toHaveLength(MAX_PERSIST_THREADS + 1)
  })

  it('keeps an old thread holding an unsent outbox row', () => {
    const s = manyThreads(MAX_PERSIST_THREADS + 5)
    s.messagesByThreadId.c1 = [msg({ id: 'p', threadId: 'c1', role: 'user', pending: true })]
    const out = buildPersistProjection(s)
    expect(out.messagesByThreadId.c1?.[0]?.pending).toBe(true)
  })

  it('ranks by the newest message when it is newer than lastUsedAt', () => {
    const s = manyThreads(MAX_PERSIST_THREADS + 5)
    s.messagesByThreadId.c0 = [msg({ id: 'x', threadId: 'c0', createdAt: '2027-01-01T00:00:00Z' })]
    const out = buildPersistProjection(s)
    expect(out.messagesByThreadId.c0).toBeDefined()
  })

  it('keeps old pinned threads beyond the recent cap', () => {
    const s = manyThreads(MAX_PERSIST_THREADS + 5)
    s.conversations = s.conversations.map((c) =>
      c.id === 'c0' || c.id === 'c1' ? { ...c, pinned: true } : c,
    )
    const out = buildPersistProjection(s)
    expect(out.messagesByThreadId.c0).toHaveLength(1)
    expect(out.messagesByThreadId.c1).toHaveLength(1)
    expect(out.messagesByThreadId.c2).toBeUndefined()
    expect(Object.keys(out.messagesByThreadId)).toHaveLength(MAX_PERSIST_THREADS + 2)
  })

  it('bounds pinned threads and their messages', () => {
    const n = MAX_PERSIST_THREADS + MAX_PERSIST_PINNED_THREADS + 10
    const s = manyThreads(n)
    // Pin every thread outside the recent window.
    const old = new Set(Array.from({ length: n - MAX_PERSIST_THREADS }, (_, i) => `c${i}`))
    s.conversations = s.conversations.map((c) => (old.has(c.id) ? { ...c, pinned: true } : c))
    const newestPinned = `c${old.size - 1}`
    const at = s.messagesByThreadId[newestPinned]![0]!.createdAt
    s.messagesByThreadId[newestPinned] = Array.from({ length: 250 }, (_, i) =>
      msg({ id: `p${i}`, threadId: newestPinned, createdAt: at }),
    )
    const out = buildPersistProjection(s)
    const kept = Object.keys(out.messagesByThreadId)
    expect(kept).toHaveLength(MAX_PERSIST_THREADS + MAX_PERSIST_PINNED_THREADS)
    expect(out.messagesByThreadId[newestPinned]).toHaveLength(200)
    // The oldest pinned threads fall past the pinned bound.
    expect(kept).not.toContain('c0')
  })

  it('caps messages per thread', () => {
    const msgs = Array.from({ length: 250 }, (_, i) => msg({ id: `m${i}` }))
    const out = buildPersistProjection(state({ messagesByThreadId: { c1: msgs } }))
    expect(out.messagesByThreadId.c1).toHaveLength(200)
    expect(out.messagesByThreadId.c1?.[199]?.id).toBe('m249')
  })
})

describe('inline image stripping', () => {
  it('replaces data: image markdown with a placeholder', () => {
    const out = stripInlineImages(`Here:\n\n![image](${PNG})\n\ndone`)
    expect(out).toBe(`Here:\n\n${INLINE_IMAGE_PLACEHOLDER}\n\ndone`)
    expect(out).not.toContain('base64')
  })

  it('strips titled and <>-wrapped data images whole', () => {
    expect(stripInlineImages(`a ![x](${PNG} "Chart") b`)).toBe(`a ${INLINE_IMAGE_PLACEHOLDER} b`)
    expect(stripInlineImages(`a ![x](${PNG} 'Chart') b`)).toBe(`a ${INLINE_IMAGE_PLACEHOLDER} b`)
    expect(stripInlineImages(`a ![x](<${PNG}> (Chart)) b`)).toBe(`a ${INLINE_IMAGE_PLACEHOLDER} b`)
  })

  it('strips non-base64 data image URLs', () => {
    const svg = `data:image/svg+xml;utf8,${'%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%22%3E'.repeat(3)}%3C%2Fsvg%3E`
    expect(stripInlineImages(`![s](${svg})`)).toBe(INLINE_IMAGE_PLACEHOLDER)
    expect(stripInlineImages(`![s](${svg} "t")`)).toBe(INLINE_IMAGE_PLACEHOLDER)
    expect(stripInlineImages(`raw ${svg} end`)).toBe(`raw ${INLINE_IMAGE_PLACEHOLDER} end`)
    const charset = `data:image/svg+xml;charset=utf-8,${'%3Cpath%20d%3D%22M0%200%22%2F%3E'.repeat(4)}`
    expect(stripInlineImages(charset)).toBe(INLINE_IMAGE_PLACEHOLDER)
  })

  it('keeps https and /opt/data path images', () => {
    const text =
      '![a](https://example.com/a.png) and ![b](/opt/data/cache/screenshots/b.png) MEDIA:/opt/data/c.png'
    expect(stripInlineImages(text)).toBe(text)
  })

  it('strips agent replies but not unstamped user echoes', () => {
    const content = `![image](${PNG})`
    expect(trimPersistMessage(msg({ content })).content).toBe(INLINE_IMAGE_PLACEHOLDER)
    expect(trimPersistMessage(msg({ role: 'user', content })).content).toBe(content)
    expect(
      trimPersistMessage(msg({ role: 'user', content, turnId: 't1' })).content,
    ).toBe(INLINE_IMAGE_PLACEHOLDER)
  })

  it('never writes base64 image data to localStorage', () => {
    savePersistedState(
      state({ messagesByThreadId: { c1: [msg({ content: `look ![image](${PNG})` })] } }),
    )
    const raw = window.localStorage.getItem(THREAD_KEY('c1'))!
    expect(raw).not.toContain('base64')
    expect(window.localStorage.getItem(META_KEY)).not.toContain('base64')
    const loaded = loadPersistedState()
    expect(loaded?.messagesByThreadId.c1?.[0]?.content).toBe(`look ${INLINE_IMAGE_PLACEHOLDER}`)
  })
})

describe('quota handling', () => {
  function quotaError(): DOMException {
    return new DOMException('full', 'QuotaExceededError')
  }

  it('retries once with a smaller projection after a quota error', () => {
    const real = Storage.prototype.setItem
    let calls = 0
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      calls += 1
      if (calls === 1) throw quotaError()
      real.call(this, k, v)
    })
    const s = { ...manyThreads(MAX_PERSIST_THREADS + 5), selectedConversationId: 'c0' }
    savePersistedState(s)
    // The failed thread write, then the reduced set's threads plus the meta.
    expect(calls).toBe(1 + (QUOTA_RETRY_LIMITS.maxThreads + 1) + 1)
    const loaded = loadPersistedState()
    const kept = Object.keys(loaded?.messagesByThreadId ?? {})
    // Selected thread + the reduced recent set.
    expect(kept).toContain('c0')
    expect(kept).toHaveLength(QUOTA_RETRY_LIMITS.maxThreads + 1)
    expect(loaded?.conversations).toHaveLength(MAX_PERSIST_THREADS + 5)
  })

  it('latches the reduced limits and warns once after the first quota error', () => {
    const real = Storage.prototype.setItem
    const writes: Array<{ key: string; size: number }> = []
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      writes.push({ key: k, size: v.length })
      if (writes.length === 1) throw quotaError()
      real.call(this, k, v)
    })
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const s = manyThreads(MAX_PERSIST_THREADS + 5)
    savePersistedState(s)
    const afterFirst = writes.length
    expect(afterFirst).toBe(1 + QUOTA_RETRY_LIMITS.maxThreads + 1)
    // Nothing changed: later saves write nothing (no full rebuild either).
    savePersistedState(s)
    savePersistedState(s)
    expect(writes).toHaveLength(afterFirst)
    // A change goes straight to the reduced projection: one thread key.
    const newest = `c${MAX_PERSIST_THREADS + 4}`
    const grown = {
      ...s,
      messagesByThreadId: {
        ...s.messagesByThreadId,
        [newest]: Array.from({ length: 80 }, (_, i) =>
          msg({ id: `g${i}`, threadId: newest, createdAt: s.conversations.at(-1)!.lastUsedAt }),
        ),
      },
    }
    savePersistedState(grown)
    expect(writes.slice(afterFirst).map((w) => w.key)).toEqual([THREAD_KEY(newest)])
    const loaded = loadPersistedState()
    expect(loaded?.messagesByThreadId[newest]).toHaveLength(QUOTA_RETRY_LIMITS.maxMessagesPerThread)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('warns once when even the reduced store cannot be saved', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quotaError()
    })
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 4; i++) savePersistedState(manyThreads(3))
    // 2 calls on the first save (each fails on its first thread key), then
    // 1 reduced call on each later save.
    expect(Storage.prototype.setItem).toHaveBeenCalledTimes(5)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('clearPersistedState resets the latch', () => {
    let fail = true
    const real = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      if (fail) {
        fail = false
        throw quotaError()
      }
      real.call(this, k, v)
    })
    const s = manyThreads(MAX_PERSIST_THREADS + 5)
    savePersistedState(s)
    expect(Object.keys(loadPersistedState()!.messagesByThreadId)).toHaveLength(
      QUOTA_RETRY_LIMITS.maxThreads,
    )
    clearPersistedState()
    savePersistedState(s)
    expect(Object.keys(loadPersistedState()!.messagesByThreadId)).toHaveLength(MAX_PERSIST_THREADS)
  })

  it('does not throw when the retry also hits the quota', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quotaError()
    })
    expect(() => savePersistedState(manyThreads(3))).not.toThrow()
    expect(Storage.prototype.setItem).toHaveBeenCalledTimes(2)
  })

  it('does not retry on a non-quota error', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    savePersistedState(manyThreads(3))
    expect(Storage.prototype.setItem).toHaveBeenCalledTimes(1)
  })
})

describe('loadPersistedState', () => {
  it('parses each stored key once (no clone round-trip)', () => {
    savePersistedState(manyThreads(3))
    const parse = vi.spyOn(JSON, 'parse')
    const stringify = vi.spyOn(JSON, 'stringify')
    const loaded = loadPersistedState()
    expect(loaded?.conversations).toHaveLength(3)
    // The meta plus one per thread.
    expect(parse).toHaveBeenCalledTimes(1 + 3)
    expect(stringify).not.toHaveBeenCalled()
  })

  it('returns independent state across loads', () => {
    savePersistedState(manyThreads(2))
    const a = loadPersistedState()!
    a.messagesByThreadId.c0![0]!.content = 'mutated'
    const b = loadPersistedState()!
    expect(b.messagesByThreadId.c0?.[0]?.content).toBe('hi')
  })
})

describe('per-thread layout', () => {
  /** Keys written by Storage.prototype.setItem while `fn` runs. */
  function keysWritten(fn: () => void): string[] {
    const spy = vi.spyOn(Storage.prototype, 'setItem')
    fn()
    const keys = spy.mock.calls.map(([k]) => k)
    spy.mockRestore()
    return keys
  }

  function withReply(s: AgentsState, tid: string, id: string): AgentsState {
    const prev = s.messagesByThreadId[tid] ?? []
    return {
      ...s,
      messagesByThreadId: {
        ...s.messagesByThreadId,
        [tid]: [...prev, msg({ id, threadId: tid, createdAt: prev.at(-1)?.createdAt })],
      },
    }
  }

  it('writes one key per kept thread plus the meta', () => {
    const keys = keysWritten(() => savePersistedState(manyThreads(3)))
    expect(keys.sort()).toEqual([META_KEY, THREAD_KEY('c0'), THREAD_KEY('c1'), THREAD_KEY('c2')])
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull()
  })

  it('a settle on one thread writes only that thread key', () => {
    const s = manyThreads(5)
    savePersistedState(s)
    const next = withReply(s, 'c2', 'reply')
    const stringify = vi.spyOn(JSON, 'stringify')
    const keys = keysWritten(() => savePersistedState(next))
    expect(keys).toEqual([THREAD_KEY('c2')])
    // Unchanged threads and the unchanged meta are not re-serialized.
    expect(stringify).toHaveBeenCalledTimes(1)
    expect(loadPersistedState()?.messagesByThreadId.c2?.map((m) => m.id)).toEqual(['m2', 'reply'])
  })

  it('rewrites the meta only when a meta slice or the thread set changes', () => {
    const s = manyThreads(3)
    savePersistedState(s)
    expect(keysWritten(() => savePersistedState({ ...s }))).toEqual([])
    const pinned = { ...s, conversations: s.conversations.map((c) => ({ ...c, pinned: true })) }
    expect(keysWritten(() => savePersistedState(pinned))).toEqual([META_KEY])
    expect(loadPersistedState()?.conversations.every((c) => c.pinned)).toBe(true)
  })

  it('evicts the key of a thread that falls out of the cap', () => {
    const s = manyThreads(MAX_PERSIST_THREADS)
    savePersistedState(s)
    expect(window.localStorage.getItem(THREAD_KEY('c0'))).not.toBeNull()
    // A newer thread pushes c0 (the oldest) out of the recent window.
    const id = 'cnew'
    const at = '2027-01-01T00:00:00.000Z'
    const grown: AgentsState = {
      ...s,
      conversations: [...s.conversations, conv(id, at)],
      messagesByThreadId: {
        ...s.messagesByThreadId,
        [id]: [msg({ id: 'n', threadId: id, createdAt: at })],
      },
    }
    const removed = vi.spyOn(Storage.prototype, 'removeItem')
    const keys = keysWritten(() => savePersistedState(grown))
    expect(keys.sort()).toEqual([META_KEY, THREAD_KEY(id)])
    expect(removed.mock.calls.map(([k]) => k)).toContain(THREAD_KEY('c0'))
    expect(window.localStorage.getItem(THREAD_KEY('c0'))).toBeNull()
    const loaded = loadPersistedState()!
    expect(loaded.messagesByThreadId.c0).toBeUndefined()
    expect(loaded.conversations).toHaveLength(MAX_PERSIST_THREADS + 1)
  })

  it('boot hydrate reads the new layout and the next save writes nothing', () => {
    savePersistedState(manyThreads(3))
    const loaded = loadPersistedState()!
    expect(Object.keys(loaded.messagesByThreadId).sort()).toEqual(['c0', 'c1', 'c2'])
    expect(loaded.conversations).toHaveLength(3)
    expect(keysWritten(() => savePersistedState(loaded))).toEqual([])
    // A change after boot still writes just the thread that changed.
    expect(keysWritten(() => savePersistedState(withReply(loaded, 'c1', 'r')))).toEqual([
      THREAD_KEY('c1'),
    ])
  })

  it('a listed thread whose key is missing loads without messages', () => {
    savePersistedState(manyThreads(3))
    window.localStorage.removeItem(THREAD_KEY('c1'))
    window.localStorage.setItem(THREAD_KEY('c2'), '{not json')
    const loaded = loadPersistedState()!
    expect(Object.keys(loaded.messagesByThreadId)).toEqual(['c0'])
    expect(loaded.conversations).toHaveLength(3)
  })

  it('sweeps thread keys no meta lists', () => {
    savePersistedState(manyThreads(2))
    window.localStorage.setItem(THREAD_KEY('orphan'), '[]')
    loadPersistedState()
    expect(window.localStorage.getItem(THREAD_KEY('orphan'))).toBeNull()
    expect(window.localStorage.getItem(THREAD_KEY('c0'))).not.toBeNull()
  })

  it('clearPersistedState removes every layout key', () => {
    savePersistedState(manyThreads(3))
    window.localStorage.setItem(LEGACY_KEY, '{}')
    clearPersistedState()
    const left = Array.from({ length: window.localStorage.length }, (_, i) =>
      window.localStorage.key(i),
    ).filter((k) => k?.startsWith('maia:agents-store'))
    expect(left).toEqual([])
  })

  it('a quota error on one thread key keeps the threads already written', () => {
    const s = manyThreads(5)
    savePersistedState(s)
    const real = Storage.prototype.setItem
    const keys: string[] = []
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      keys.push(k)
      if (k === THREAD_KEY('c4') && keys.filter((x) => x === k).length === 1) {
        throw new DOMException('full', 'QuotaExceededError')
      }
      real.call(this, k, v)
    })
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    // c4 (newest) fails at full size, then lands in the reduced set.
    savePersistedState(withReply(s, 'c4', 'big'))
    expect(keys).toEqual([THREAD_KEY('c4'), THREAD_KEY('c2'), THREAD_KEY('c3'), THREAD_KEY('c4'), META_KEY])
    const loaded = loadPersistedState()!
    expect(Object.keys(loaded.messagesByThreadId).sort()).toEqual(['c2', 'c3', 'c4'])
    expect(loaded.messagesByThreadId.c4?.map((m) => m.id)).toEqual(['m4', 'big'])
    // Threads past the reduced cap were evicted to free space.
    expect(window.localStorage.getItem(THREAD_KEY('c0'))).toBeNull()
  })
})

describe('legacy single-blob migration', () => {
  function legacyEnvelope(value: AgentsState, savedAt = '2026-09-01T00:00:00.000Z'): string {
    return JSON.stringify({
      slice: 'maia.agents',
      schemaVersion: 1,
      scope: 'client-persisted',
      savedAt,
      value,
    })
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hydrates from the old blob, writes the new layout, then removes the old key', () => {
    vi.useFakeTimers()
    window.localStorage.setItem(LEGACY_KEY, legacyEnvelope(manyThreads(3)))
    const loaded = loadPersistedState()!
    expect(Object.keys(loaded.messagesByThreadId).sort()).toEqual(['c0', 'c1', 'c2'])
    // The rewrite is off the boot path; the old blob stays until it lands.
    expect(window.localStorage.getItem(META_KEY)).toBeNull()
    expect(window.localStorage.getItem(LEGACY_KEY)).not.toBeNull()
    vi.runAllTimers()
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(window.localStorage.getItem(THREAD_KEY('c1'))).not.toBeNull()
    const again = loadPersistedState()!
    expect(again.conversations).toHaveLength(3)
    expect(again.messagesByThreadId.c2?.[0]?.id).toBe('m2')
  })

  it('keeps the old blob when the new layout could not be written', () => {
    vi.useFakeTimers()
    window.localStorage.setItem(LEGACY_KEY, legacyEnvelope(manyThreads(3)))
    loadPersistedState()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.runAllTimers()
    vi.restoreAllMocks()
    expect(window.localStorage.getItem(META_KEY)).toBeNull()
    // Next boot still has the cache.
    expect(loadPersistedState()?.conversations).toHaveLength(3)
  })

  it('a leftover old blob older than the meta is dropped, not loaded', () => {
    savePersistedState(manyThreads(2))
    window.localStorage.setItem(LEGACY_KEY, legacyEnvelope(manyThreads(5), '2000-01-01T00:00:00.000Z'))
    const loaded = loadPersistedState()!
    expect(loaded.conversations).toHaveLength(2)
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull()
  })

  it('an old blob newer than the meta wins (an older build ran since)', () => {
    vi.useFakeTimers()
    savePersistedState(manyThreads(2))
    window.localStorage.setItem(LEGACY_KEY, legacyEnvelope(manyThreads(4), '2999-01-01T00:00:00.000Z'))
    expect(loadPersistedState()?.conversations).toHaveLength(4)
    vi.runAllTimers()
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(loadPersistedState()?.conversations).toHaveLength(4)
  })

  it('clearPersistedState cancels a pending migration write', () => {
    vi.useFakeTimers()
    window.localStorage.setItem(LEGACY_KEY, legacyEnvelope(manyThreads(3)))
    loadPersistedState()
    clearPersistedState()
    vi.runAllTimers()
    expect(window.localStorage.getItem(META_KEY)).toBeNull()
    expect(loadPersistedState()).toBeNull()
  })
})
