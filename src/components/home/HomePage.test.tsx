import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'
import { HomePage, HOME_MASCOT_SIZE } from './HomePage'
import type { RosterAgent, RosterConversation } from '../../lib/agents/roster'

afterEach(cleanup)

const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime()
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString()
const agent = (id: string, name: string): RosterAgent => ({
  id, name, hermesProfile: id.replace('profile:', ''), status: 'running', region: 'local', summary: '', createdAt: iso(500),
} as RosterAgent)
const ada = agent('profile:ada', 'Ada')
const bo = agent('profile:bo', 'Bo')
const conv = (id: string, a: RosterAgent, hoursAgo: number, extra: Partial<RosterConversation> = {}): RosterConversation => ({
  id, title: `Chat ${id}`, target: { type: 'agent', agentId: a.id }, createdAt: iso(hoursAgo), lastUsedAt: iso(hoursAgo), ...extra,
})

function setup(props: Partial<ComponentProps<typeof HomePage>> = {}) {
  const handlers = {
    onOpenConversation: vi.fn(), onOpenAgent: vi.fn(), onOpenApp: vi.fn(),
    onCreateAgent: vi.fn(), onOpenSearch: vi.fn(), onOpenSettings: vi.fn(),
  }
  render(<HomePage agents={[ada, bo]} groups={[]} now={NOW} {...handlers}
    conversations={[conv('c1', ada, 1, { preview: 'Drafted **three** replies' }), conv('c2', bo, 30)]} {...props} />)
  return handlers
}

describe('HomePage', () => {
  it('keeps Pip alongside the greeting and recent work', () => {
    setup()
    const main = screen.getByRole('main', { name: 'Home' })
    const mascot = main.querySelector('.hd-home-mascot [data-character="owl"]') as HTMLElement
    expect(mascot).toBeTruthy()
    expect(mascot.style.width).toBe(`${HOME_MASCOT_SIZE}px`)
    expect(screen.getByRole('heading', { level: 1, name: 'Good afternoon' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('All caught up')
    expect(main.querySelector('.hd-home-mascot')!.getAttribute('data-presence')).toBe('idle')
  })

  it('lists recent activity by day with previews and opens a conversation', () => {
    const h = setup()
    const today = screen.getByRole('list', { name: 'Today' })
    const row = within(today).getByRole('button', { name: /Chat c1/ })
    expect(row.textContent).toContain('Drafted three replies')
    expect(row.textContent).toContain('Ada')
    expect(row.textContent).toContain('1h ago')
    expect(screen.getByRole('list', { name: 'Yesterday' })).toBeTruthy()
    fireEvent.click(row)
    expect(h.onOpenConversation).toHaveBeenCalledWith('c1')
  })

  it('surfaces validated GenUI widget summaries in recent activity for tool-only replies', () => {
    setup({
      conversations: [conv('c-genui', ada, 1)],
      messagesByThreadId: {
        'c-genui': [{
          id: 'm1', threadId: 'c-genui', role: 'agent', content: '', createdAt: iso(1),
          toolEvents: [{
            tool: 'mcp__hermes_desk__render_ui', toolCallId: 'ui-1', status: 'completed',
            genui: { version: 1, components: [{ type: 'stat', title: 'Smoke suite', value: '14/14 passed' }] },
          }],
        }],
      },
    })
    const today = screen.getByRole('list', { name: 'Today' })
    expect(within(today).getByRole('button', { name: /Chat c-genui/ }).textContent).toContain('Smoke suite: 14/14 passed')
  })

  it('starts a session with the focus agent, any agent chip, or returns to the app', () => {
    const h = setup({ conversations: [] })
    const start = screen.getByRole('button', { name: 'Start a session' })
    expect(document.activeElement).toBe(start)
    fireEvent.click(start)
    expect(h.onOpenAgent).toHaveBeenCalledWith('profile:ada')
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Start with an agent' })).getByRole('button', { name: 'Talk to Bo' }))
    expect(h.onOpenAgent).toHaveBeenLastCalledWith('profile:bo')
    fireEvent.click(screen.getByRole('button', { name: 'All conversations' }))
    expect(h.onOpenApp).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(h.onOpenSearch).toHaveBeenCalledOnce()
    expect(h.onOpenSettings).toHaveBeenCalledOnce()
  })

  it('continues the latest chat and keeps activity statistics collapsed after recent work', () => {
    const h = setup()
    const primary = screen.getByRole('button', { name: 'Continue recent chat' })
    expect(primary).toHaveFocus()
    fireEvent.click(primary)
    expect(h.onOpenConversation).toHaveBeenCalledWith('c1')
    const history = document.querySelector('.hd-home-history')!
    expect(history).not.toHaveAttribute('open')
    expect(history.previousElementSibling).toBe(screen.getByRole('region', { name: 'Recent activity' }))
  })

  it('routes the primary action to an approval, ahead of newer ordinary work', () => {
    const h = setup({ activityByAgent: { 'profile:bo': { waitingApproval: true } } })
    fireEvent.click(screen.getByRole('button', { name: 'Review approval' }))
    expect(h.onOpenConversation).toHaveBeenCalledWith('c2')
  })

  it('reviews the exact older chat that owns an approval, not that agent’s newer chat', () => {
    const h = setup({ conversations: [conv('old', ada, 4), conv('new', ada, 1)],
      activityByAgent: { 'profile:ada': { waitingApproval: true } },
      pendingPermissions: [{ id: 'ask', conversationId: 'old', sessionId: 'runtime', choices: ['once', 'deny'], status: 'pending' }],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review approval' }))
    expect(h.onOpenConversation).toHaveBeenCalledWith('old')
    expect(within(screen.getByRole('list', { name: 'Needs you' })).getAllByRole('button')).toHaveLength(1)
  })

  it('reviews a shared-room approval using its owning conversation', () => {
    const h = setup({
      groups: [{ id: 'room', name: 'Research room', primaryAgentId: ada.id, memberAgentIds: [ada.id, bo.id], createdAt: iso(1) }],
      conversations: [{ id: 'room-chat', title: 'Shared task', target: { type: 'group', groupId: 'room' }, createdAt: iso(1), lastUsedAt: iso(1) }],
      pendingPermissions: [{ id: 'ask', conversationId: 'room-chat', sessionId: 'runtime', memberId: bo.id, choices: ['once', 'deny'], status: 'pending' }],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review approval' }))
    expect(h.onOpenConversation).toHaveBeenCalledWith('room-chat')
  })

  it('uses the real new-chat picker when supplied, rather than resuming an old session', () => {
    const start = vi.fn()
    const h = setup({ conversations: [], onStartSession: start })
    fireEvent.click(screen.getByRole('button', { name: 'Start a session' }))
    expect(start).toHaveBeenCalledOnce()
    expect(h.onOpenAgent).not.toHaveBeenCalled()
  })

  it('pins chats waiting on the user and reflects it in the mascot and summary', () => {
    setup({ activityByAgent: { 'profile:bo': { waitingApproval: true } } })
    const needs = screen.getByRole('list', { name: 'Needs you' })
    expect(within(needs).getByRole('button', { name: /Chat c2/ }).textContent).toContain('Waiting for your approval')
    expect(screen.getByRole('status').textContent).toBe('1 chat needs you')
  })

  it('uses live mascot presence and marks live and unread rows', () => {
    setup({
      mascotStates: { 'profile:ada': 'thinking' }, liveConversationIds: new Set(['c1']),
      conversations: [conv('c1', ada, 1), conv('c2', bo, 2, { unreadCount: 2 })],
    })
    expect(document.querySelector('.hd-home-mascot')!.getAttribute('data-presence')).toBe('thinking')
    expect(screen.getByRole('img', { name: 'Working now' })).toBeTruthy()
    expect(screen.getByLabelText('2 unread')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Ada is working on something')
  })

  it('offers Show all conversations only when rows were cut', () => {
    const many = Array.from({ length: 14 }, (_, i) => conv(`m${i}`, ada, i + 1))
    const h = setup({ conversations: many })
    fireEvent.click(screen.getByRole('button', { name: 'Show all conversations' }))
    expect(h.onOpenApp).toHaveBeenCalledOnce()
    cleanup()
    setup()
    expect(screen.queryByRole('button', { name: 'Show all conversations' })).toBeNull()
  })

  it('shows loading, empty and no-agent states', () => {
    setup({ conversations: [], hydrating: true })
    expect(screen.getByRole('region', { name: 'Recent activity' }).getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Catching up on your activity…')
    cleanup()
    setup({ conversations: [] })
    expect(screen.getByText(/Nothing here yet/)).toBeTruthy()
    cleanup()
    setup({ agents: [], conversations: [], hydrating: true })
    expect((screen.getByRole('button', { name: 'Start a session' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    const h = setup({ agents: [], conversations: [] })
    expect(screen.queryByRole('navigation', { name: 'Start with an agent' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Create an agent' }))
    expect(h.onCreateAgent).toHaveBeenCalledOnce()
  })

  it('shows the offline banner and an offline mascot', () => {
    setup({ offline: true, onRetry: vi.fn(async () => {}), onDiagnostics: vi.fn() })
    expect(document.querySelector('.hd-home-mascot')!.getAttribute('data-presence')).toBe('offline')
    expect(document.querySelector('.hd-home-summary')!.textContent).toContain('Hermes is offline')
    expect(screen.getAllByRole('status').length).toBeGreaterThan(1)
  })

  it('allows reading recent work offline but disables starting a new session', () => {
    const start = vi.fn()
    const h = setup({ offline: true, onStartSession: start })
    fireEvent.click(screen.getByRole('button', { name: 'Continue recent chat' }))
    expect(h.onOpenConversation).toHaveBeenCalledWith('c1')
    expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled()
  })
})
