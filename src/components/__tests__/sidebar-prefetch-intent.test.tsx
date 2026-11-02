/**
 * Sidebar hover / focus intent → transcript prefetch. A pointer resting on
 * a row for HOVER_INTENT_MS warms that conversation; leaving earlier cancels
 * it, so sweeping the pointer down the list fetches nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Sidebar } from '../Sidebar'
import { HOVER_INTENT_MS } from '../../lib/agents/prefetch'
import type { Agent, Conversation, Group } from '../../lib/agents/types'

vi.mock('../../build-env', () => ({ isProdBuild: vi.fn(() => false) }))

beforeEach(() => {
  window.localStorage.clear()
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const conv = (id: string, lastUsedAt: string) =>
  ({
    id,
    title: `Thread ${id}`,
    target: { type: 'agent', agentId: `agent_${id}` },
    lastUsedAt,
    createdAt: '2026-09-07T00:00:00Z',
  }) as Conversation

const agents = ['c1', 'c2', 'c3'].map((id) => ({
  id: `agent_${id}`, name: `Agent ${id}`, status: 'running', region: 'local',
  createdAt: '2026-08-01T00:00:00Z',
} as Agent))

function renderSidebar(onPrefetch?: (id: string) => void) {
  const view = render(
    <Sidebar
      conversations={[conv('c1', '2026-09-07T03:00:00Z'), conv('c2', '2026-09-07T02:00:00Z'), conv('c3', '2026-09-07T01:00:00Z')]}
      agents={agents}
      groups={[] as Group[]}
      selectedConversationId="c1"
      onSelectConversation={() => {}}
      onPrefetchConversation={onPrefetch}
      onNewConversation={() => {}}
      onOpenTarget={() => {}}
      onOpenSettings={() => {}}
    />,
  )
  const row = (id: string) => view.container.querySelector(`li[data-conversation-id="${id}"]`) as HTMLElement
  return { row }
}

describe('sidebar prefetch intent', () => {
  it('a pointer resting on a row prefetches that conversation once', () => {
    const onPrefetch = vi.fn()
    const { row } = renderSidebar(onPrefetch)
    fireEvent.pointerEnter(row('c2'))
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS - 1))
    expect(onPrefetch).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onPrefetch).toHaveBeenCalledTimes(1)
    expect(onPrefetch).toHaveBeenCalledWith('c2')
  })

  it('sweeping across rows prefetches nothing', () => {
    const onPrefetch = vi.fn()
    const { row } = renderSidebar(onPrefetch)
    for (const id of ['c1', 'c2', 'c3']) {
      fireEvent.pointerEnter(row(id))
      act(() => vi.advanceTimersByTime(HOVER_INTENT_MS / 3))
      fireEvent.pointerLeave(row(id))
    }
    act(() => vi.advanceTimersByTime(1000))
    expect(onPrefetch).not.toHaveBeenCalled()
  })

  it('keyboard focus on a row counts as intent', () => {
    const onPrefetch = vi.fn()
    const { row } = renderSidebar(onPrefetch)
    fireEvent.focus(row('c3').querySelector('button')!)
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS))
    expect(onPrefetch).toHaveBeenCalledWith('c3')
  })

  it('without a prefetch handler the rows behave as before', () => {
    const { row } = renderSidebar(undefined)
    fireEvent.pointerEnter(row('c2'))
    act(() => vi.advanceTimersByTime(1000))
    expect(row('c2')).toBeTruthy()
  })
})
