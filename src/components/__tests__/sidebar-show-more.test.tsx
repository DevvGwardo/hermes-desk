/**
 * Sidebar "Show more conversations" (list paging) a11y: an accessible name
 * that says what it loads, aria-disabled (not `disabled`) while loading so
 * keyboard focus survives, and one fetch per click burst.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Sidebar } from '../Sidebar'
import type { Agent, Conversation, Group } from '../../lib/agents/types'

vi.mock('../../build-env', () => ({ isProdBuild: vi.fn(() => false) }))

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const conv = {
  id: 'conv_1',
  title: 'Hello',
  target: { type: 'agent', agentId: 'inst_nub' },
  lastUsedAt: '2026-09-07T00:00:00Z',
  createdAt: '2026-09-07T00:00:00Z',
} as Conversation

const agents = [
  { id: 'inst_nub', name: 'Nub', status: 'running', region: 'remote', createdAt: '2026-08-01T00:00:00Z' } as Agent,
]

function renderSidebar(props: { loading?: boolean; onLoadMore: () => unknown }) {
  return render(
    <Sidebar
      conversations={[conv]}
      agents={agents}
      groups={[] as Group[]}
      selectedConversationId="conv_1"
      onSelectConversation={() => {}}
      onNewConversation={() => {}}
      onOpenTarget={() => {}}
      onOpenSettings={() => {}}
      conversationsHasMore
      conversationsLoadingMore={props.loading ?? false}
      onLoadMoreConversations={props.onLoadMore}
    />,
  )
}

describe('sidebar Show more conversations', () => {
  it('names what it loads', () => {
    renderSidebar({ onLoadMore: vi.fn() })
    expect(screen.getByRole('button', { name: 'Show more conversations' })).toBeTruthy()
  })

  it('stays focusable while loading and ignores clicks', () => {
    const onLoadMore = vi.fn()
    renderSidebar({ loading: true, onLoadMore })
    const btn = screen.getByTestId('sidebar-show-more')
    expect(btn.hasAttribute('disabled')).toBe(false)
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    btn.focus()
    fireEvent.click(btn)
    expect(onLoadMore).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(btn)
  })

  it('a double-click before the loading flag lands fetches once', () => {
    const onLoadMore = vi.fn(() => new Promise<void>(() => {}))
    renderSidebar({ onLoadMore })
    const btn = screen.getByTestId('sidebar-show-more')
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })
})
