import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { Sidebar } from '../Sidebar'
import type { RosterAgent, RosterConversation } from '../../lib/agents/roster'

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false, addEventListener() {}, removeEventListener() {},
  })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const agents: RosterAgent[] = ['a', 'b'].map((name) => ({
  id: `profile:${name}`, name, status: 'running', region: 'local', summary: '', createdAt: '2026-10-06',
}))
const conv = (id: string, agentId: string): RosterConversation => ({
  id, title: id, target: { type: 'agent', agentId }, createdAt: '2026-10-06', lastUsedAt: '2026-10-06',
})
function show(extra: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return render(<Sidebar agents={agents} groups={[]} conversations={[
    conv('a1', agents[0].id), conv('a2', agents[0].id), conv('b1', agents[1].id),
  ]} selectedConversationId="a2" onSelectConversation={vi.fn()} onNewConversation={vi.fn()}
    onOpenTarget={vi.fn()} onOpenSettings={vi.fn()} {...extra} />)
}

describe('agent roster selection and live state', () => {
  it('renders one row per agent and one highlight for any of its conversations', () => {
    const view = show()
    expect(view.container.querySelectorAll('li[data-agent-id]')).toHaveLength(2)
    const cards = screen.getAllByTestId('sidebar-selection')
    expect(cards).toHaveLength(1)
    expect(cards[0].closest('li')?.getAttribute('data-agent-id')).toBe(agents[0].id)
  })
  it('compact rail uses the same agent selection and unread total', () => {
    window.localStorage.setItem('maia:sidebarWidth', '180')
    show({ conversations: [
      { ...conv('a1', agents[0].id), unreadCount: 2 },
      { ...conv('a2', agents[0].id), hasUnread: true },
    ] })
    const nav = screen.getByRole('navigation', { name: 'Your agents' })
    expect(nav.className).toContain('hd-agent-roster')
    const cards = within(nav).getAllByTestId('sidebar-rail-selection')
    expect(cards).toHaveLength(1)
    expect(cards[0].closest('li')?.getAttribute('data-agent-id')).toBe(agents[0].id)
    expect(within(nav).getByLabelText('3 unread')).toBeTruthy()
  })
  it('shows browsing on an unselected agent, not merely the open conversation', () => {
    show({ activityByAgent: { [agents[1].id]: {
      liveTool: { name: 'browser_navigate', url: 'https://en.wikipedia.org/wiki/Fake' },
    } } })
    expect(screen.getByText('Browsing en.wikipedia.org')).toBeTruthy()
    expect(screen.getByText('Browsing en.wikipedia.org').closest('li')?.getAttribute('data-agent-id')).toBe(agents[1].id)
  })
  it('group work contributes presence to each member without adding a group profile row', () => {
    show({ groups: [{
      id: 'fake-group', name: 'Fake group', memberAgentIds: agents.map((a) => a.id),
      primaryAgentId: agents[0].id, createdAt: '2026-10-06',
    }], conversations: [
      conv('a1', agents[0].id),
      { ...conv('group-conv', agents[0].id), target: { type: 'group', groupId: 'fake-group' } },
    ], selectedConversationId: 'a1', liveConversationIds: new Set(['group-conv']) })
    expect(screen.getAllByText('Working…')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Fake group' })).toBeNull()
  })
})
