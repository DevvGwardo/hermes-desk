import { act, render, renderHook } from '@testing-library/react'
import { memo } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const persistSpy = vi.hoisted(() => ({ fast: vi.fn(), slow: vi.fn() }))
vi.mock('../persist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persist')>()
  return {
    ...actual,
    schedulePersist: (...args: Parameters<typeof actual.schedulePersist>) => {
      persistSpy.fast(...args)
      return actual.schedulePersist(...args)
    },
    scheduleSlowPersist: (...args: Parameters<typeof actual.scheduleSlowPersist>) => {
      persistSpy.slow(...args)
      return actual.scheduleSlowPersist(...args)
    },
  }
})

// useAgentRuntime resolves a transport on mount; a silent stub keeps the
// render-count test to the store.
vi.mock('../active-transport', () => ({
  getActiveTransport: async () => ({
    transport: { subscribe: () => () => {} },
    mode: 'mock',
    source: 'test',
  }),
  resetActiveTransport: () => {},
}))
// The audit-log effect lazily imports agent-rest on mount, which drags in
// vm-fs-http → mobile/session → platform. On a loaded runner that chain
// finished loading after this file's environment was torn down
// (EnvironmentTeardownError, #223's first CI run); nothing here needs it.
vi.mock('../../agent-rest', () => ({ isHostedAgent: async () => false }))

import {
  appendMessage,
  flushMessagePatches,
  getLiveMessage,
  getState,
  getStructuralState,
  patchMessage,
  removeMessage,
  resetStore,
  setState,
  subscribe,
} from '../store'
import { useLiveMessage, useLiveMessages } from '../useLiveMessage'
import { useAgentRuntime } from '../useAgentRuntime'
import type { ChatMessage } from '../types'

function openThread(): string {
  const id = getState().selectedConversationId!
  expect(id).toBeTruthy()
  return id
}

function startReply(threadId: string, content = ''): ChatMessage {
  const reply: ChatMessage = {
    id: `reply_${Math.random().toString(36).slice(2)}`,
    threadId,
    role: 'agent',
    content,
    createdAt: new Date().toISOString(),
    streaming: true,
  }
  appendMessage(threadId, reply)
  return reply
}

function tick(threadId: string, id: string, content: string): void {
  patchMessage(threadId, id, { content })
  flushMessagePatches()
}

function stored(threadId: string, id: string): ChatMessage {
  return getState().messagesByThreadId[threadId]!.find((m) => m.id === id)!
}

beforeEach(() => {
  resetStore({ seed: true })
  persistSpy.fast.mockClear()
  persistSpy.slow.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('setState no-op (D12)', () => {
  it('skips notify and persist for an empty patch', () => {
    const listener = vi.fn()
    const unsub = subscribe(listener)
    const before = getState()
    setState({})
    setState(() => ({}))
    expect(listener).not.toHaveBeenCalled()
    expect(persistSpy.fast).not.toHaveBeenCalled()
    expect(getState()).toBe(before)
    unsub()
  })

  it('skips when every key is identity-equal (updater returned prev)', () => {
    const listener = vi.fn()
    const unsub = subscribe(listener)
    // The conversation-sync snapshot path: `next === prev ? {} : next`, and
    // removeMessage's "nothing to remove" branch returns `prev` itself.
    setState((prev) => prev)
    setState((prev) => ({ conversations: prev.conversations, agents: prev.agents }))
    removeMessage(openThread(), 'no-such-message')
    expect(listener).not.toHaveBeenCalled()
    expect(persistSpy.fast).not.toHaveBeenCalled()
    unsub()
  })

  it('still notifies and persists a real change', () => {
    const listener = vi.fn()
    const unsub = subscribe(listener)
    setState((prev) => ({ conversations: [...prev.conversations] }))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(persistSpy.fast).toHaveBeenCalledTimes(1)
    unsub()
  })
})

describe('structural snapshot (D5)', () => {
  it('a content-only tick moves state but not the structural snapshot', () => {
    const tid = openThread()
    const reply = startReply(tid, 'Hel')
    const shell = getStructuralState()
    expect(shell).toBe(getState())
    tick(tid, reply.id, 'Hello')
    tick(tid, reply.id, 'Hello wor')
    expect(getStructuralState()).toBe(shell)
    expect(stored(tid, reply.id).content).toBe('Hello wor')
    const shellCopy = getStructuralState().messagesByThreadId[tid]!.find((m) => m.id === reply.id)!
    expect(shellCopy.content).toBe('Hel')
    expect(getLiveMessage(shellCopy).content).toBe('Hello wor')
  })

  it('the first token is structural (Working… → Typing…)', () => {
    const tid = openThread()
    const reply = startReply(tid)
    const shell = getStructuralState()
    tick(tid, reply.id, 'H')
    expect(getStructuralState()).not.toBe(shell)
    expect(getStructuralState()).toBe(getState())
  })

  it('tool events and the settle catch the snapshot up and clear live rows', () => {
    const tid = openThread()
    const reply = startReply(tid, 'a')
    tick(tid, reply.id, 'ab')
    const shellCopy = getStructuralState().messagesByThreadId[tid]!.find((m) => m.id === reply.id)!
    patchMessage(tid, reply.id, { toolEvents: [{ tool: 'terminal', status: 'running' }] })
    expect(getStructuralState()).toBe(getState())
    expect(getLiveMessage(shellCopy)).toBe(shellCopy)

    tick(tid, reply.id, 'abc')
    patchMessage(tid, reply.id, { streaming: false })
    expect(getStructuralState()).toBe(getState())
    expect(stored(tid, reply.id)).toMatchObject({ content: 'abc', streaming: false })
  })

  it('a replaced (not extended) text is structural', () => {
    const tid = openThread()
    const reply = startReply(tid, 'draft')
    const shell = getStructuralState()
    tick(tid, reply.id, 'final')
    expect(getStructuralState()).not.toBe(shell)
  })

  it('a thread with a typed answer stays structural (split reply rows)', () => {
    const tid = openThread()
    const reply = startReply(tid, 'Question one?')
    appendMessage(tid, {
      id: 'typed',
      threadId: tid,
      role: 'user',
      content: 'yes',
      createdAt: new Date().toISOString(),
      answerAt: { replyId: reply.id, offset: 13, tail: 'one?' },
    })
    const shell = getStructuralState()
    tick(tid, reply.id, 'Question one? More')
    expect(getStructuralState()).not.toBe(shell)
  })

  it('never substitutes a derived row whose text is not a prefix', () => {
    const tid = openThread()
    const reply = startReply(tid, 'abc')
    tick(tid, reply.id, 'abcdef')
    const shellCopy = getStructuralState().messagesByThreadId[tid]!.find((m) => m.id === reply.id)!
    const derived = { ...shellCopy, content: 'zz' }
    expect(getLiveMessage(derived)).toBe(derived)
  })

  it('a content-only tick still notifies subscribers (state is truthful)', () => {
    const tid = openThread()
    const reply = startReply(tid, 'a')
    const listener = vi.fn()
    const unsub = subscribe(listener)
    tick(tid, reply.id, 'ab')
    expect(listener).toHaveBeenCalledTimes(1)
    unsub()
  })
})

describe('render counts while a reply streams (D5)', () => {
  it('useAgentRuntime does not re-render on content-only ticks; the row does', async () => {
    const tid = openThread()
    let shellRenders = 0
    const { result } = renderHook(() => {
      shellRenders += 1
      return useAgentRuntime()
    })
    await act(async () => {})
    // After mount: the boot pass settles streaming flags left by a reload.
    let reply!: ChatMessage
    act(() => {
      reply = startReply(tid, 'Hi')
    })
    const live = result.current.messages.find((m) => m.id === reply.id)!
    expect(live).toBeTruthy()

    let rowRenders = 0
    const Row = memo(function Row({ m }: { m: ChatMessage }) {
      rowRenders += 1
      return <span data-testid="row">{useLiveMessage(m).content}</span>
    })
    const view = render(<Row m={live} />)
    const shellBefore = shellRenders
    const rowBefore = rowRenders

    let text = 'Hi'
    for (let i = 0; i < 20; i++) {
      text += ` ${i}`
      act(() => tick(tid, reply.id, text))
    }
    expect(shellRenders).toBe(shellBefore)
    expect(rowRenders - rowBefore).toBe(20)
    expect(view.getByTestId('row').textContent).toBe(text)

    // Settling is structural: the shell sees the final text exactly once.
    act(() => patchMessage(tid, reply.id, { streaming: false }))
    expect(shellRenders).toBe(shellBefore + 1)
    expect(result.current.messages.find((m) => m.id === reply.id)).toMatchObject({
      content: text,
      streaming: false,
    })
  })

  it('rows that are not streaming do not re-render on a tick', () => {
    const tid = openThread()
    const settled: ChatMessage = {
      id: 'settled',
      threadId: tid,
      role: 'agent',
      content: 'done',
      createdAt: new Date().toISOString(),
    }
    appendMessage(tid, settled)
    const reply = startReply(tid, 'x')
    let renders = 0
    function Row({ m }: { m: ChatMessage }) {
      renders += 1
      return <span>{useLiveMessage(m).content}</span>
    }
    const MemoRow = memo(Row)
    render(<MemoRow m={stored(tid, 'settled')} />)
    const before = renders
    act(() => tick(tid, reply.id, 'xy'))
    act(() => tick(tid, reply.id, 'xyz'))
    expect(renders).toBe(before)
  })

  it('useLiveMessages keeps list identity until a row grows', () => {
    const tid = openThread()
    const reply = startReply(tid, 'a')
    const list = getStructuralState().messagesByThreadId[tid]!
    const { result } = renderHook(() => useLiveMessages(list))
    expect(result.current).toBe(list)
    act(() => tick(tid, reply.id, 'ab'))
    const grown = result.current
    expect(grown).not.toBe(list)
    expect(grown.find((m) => m.id === reply.id)!.content).toBe('ab')
    act(() => setState((prev) => prev))
    expect(result.current).toBe(grown)
  })
})
