import { StrictMode, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useBootWarmup } from '../useBootWarmup'
import { WARM_DELAY_MS } from '../prefetch'
import { resetStore, setHydrateStatus, setState } from '../store'
import type { Conversation } from '../types'

const prefetchTranscript = vi.fn(async (_id: string) => true)
vi.mock('../active-transport', () => ({
  getActiveTransport: async () => ({ transport: { prefetchTranscript } }),
}))

const conv = (id: string, at: string): Conversation =>
  ({ id, title: id, target: { type: 'agent', agentId: `a_${id}` }, hermesSessionId: `s_${id}`, createdAt: at, lastUsedAt: at }) as Conversation

const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>

beforeEach(() => {
  vi.useFakeTimers()
  resetStore()
  prefetchTranscript.mockClear()
  setState({
    conversations: [conv('open', '2026-09-29T10:00:00Z'), conv('b', '2026-09-29T09:00:00Z'), conv('c', '2026-09-29T08:00:00Z')],
    selectedConversationId: 'open',
    messagesByThreadId: {},
  })
})
afterEach(() => {
  vi.useRealTimers()
})

const idle = { rosterHydrating: false, conversationsHydrating: false }

describe('useBootWarmup', () => {
  // StrictMode's dev remount (the other lifecycle bug) does not replay under
  // this test renderer — it was verified in the dev app instead.
  it('warms the recent uncached threads once hydration has settled', async () => {
    renderHook(() => useBootWarmup({ selectedConversationId: 'open', ...idle }), { wrapper: strict })
    await vi.advanceTimersByTimeAsync(WARM_DELAY_MS + 10)
    expect(prefetchTranscript.mock.calls.map((c) => c[0])).toEqual(['b', 'c'])
  })

  it('waits while hydration that began after the first render is still running', async () => {
    // First render: flags false (hydration has not started yet).
    renderHook(() => useBootWarmup({ selectedConversationId: 'open', ...idle }), { wrapper: strict })
    setHydrateStatus({ rosterHydrating: true })
    await vi.advanceTimersByTimeAsync(WARM_DELAY_MS + 1_000)
    expect(prefetchTranscript).not.toHaveBeenCalled()
    setHydrateStatus({ rosterHydrating: false })
    await vi.advanceTimersByTimeAsync(300)
    expect(prefetchTranscript).toHaveBeenCalledTimes(2)
  })

  it('runs once per runtime', async () => {
    const { rerender } = renderHook((p: { sel: string }) => useBootWarmup({ selectedConversationId: p.sel, ...idle }), {
      initialProps: { sel: 'open' },
    })
    await vi.advanceTimersByTimeAsync(WARM_DELAY_MS + 10)
    rerender({ sel: 'b' })
    await vi.advanceTimersByTimeAsync(WARM_DELAY_MS + 10)
    expect(prefetchTranscript).toHaveBeenCalledTimes(2)
  })

  it('skips threads that already have cached rows', async () => {
    setState({ messagesByThreadId: { b: [{ id: 'm', threadId: 'b', role: 'agent', content: 'hi', createdAt: '2026-09-29T09:00:00Z' }] } })
    renderHook(() => useBootWarmup({ selectedConversationId: 'open', ...idle }))
    await vi.advanceTimersByTimeAsync(WARM_DELAY_MS + 10)
    expect(prefetchTranscript.mock.calls.map((c) => c[0])).toEqual(['c'])
  })
})
