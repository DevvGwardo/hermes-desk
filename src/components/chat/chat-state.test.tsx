import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTurnControls } from './useTurnControls'
import { useThreadGroups } from './useThreadGroups'
import type { ChatMessage } from '../../lib/agents/types'

afterEach(cleanup)

describe('chat state interfaces', () => {
  it('keeps row controls stable while routing to the newest handlers', async () => {
    const first = vi.fn()
    const latest = vi.fn()
    const { result, rerender } = renderHook(({ handler }) =>
      useTurnControls('room', 'root', handler), { initialProps: { handler: first } })
    const retry = result.current.retryTransportTurn
    const stop = result.current.stopRunningTurn
    rerender({ handler: latest })
    expect(result.current.retryTransportTurn).toBe(retry)
    expect(result.current.stopRunningTurn).toBe(stop)
    await act(async () => retry())
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledOnce()
  })

  it('retains structural indexes but uses fresh streaming reply content', () => {
    const root: ChatMessage = { id: 'root', threadId: 'room', role: 'user', content: 'Question', createdAt: '2026-10-10T00:00:00Z' }
    const reply: ChatMessage = { ...root, id: 'reply', role: 'agent', content: '',
      replyTo: { id: root.id, role: root.role, snippet: root.content, thread: true } }
    const { result, rerender } = renderHook(({ messages }) => useThreadGroups(messages), {
      initialProps: { messages: [root, reply] },
    })
    const index = result.current.rootIdByMessage
    const counts = result.current.repliesByRoot
    const streaming = { ...reply, content: 'New streamed text' }
    rerender({ messages: [root, streaming] })
    expect(result.current.rootIdByMessage).toBe(index)
    expect(result.current.repliesByRoot).toBe(counts)
    expect(result.current.threadGroupsMemo[0]!.replies[0]).toBe(streaming)
    expect(result.current.topLevel).toEqual([root])
  })
})
