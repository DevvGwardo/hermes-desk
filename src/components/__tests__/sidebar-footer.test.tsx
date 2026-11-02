import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Sidebar } from '../Sidebar'
import type { RosterAgent, RosterConversation } from '../../lib/agents/roster'

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false, addEventListener() {}, removeEventListener() {},
  })))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const agent: RosterAgent = {
  id: 'profile:fake', name: 'Fake Hermes', status: 'running', region: 'local',
  createdAt: '2026-10-06', summary: '', model: 'fake-local-model',
}
const conv: RosterConversation = {
  id: 'fake-conv', title: 'Fake', target: { type: 'agent', agentId: agent.id },
  createdAt: '2026-10-06', lastUsedAt: '2026-10-06',
}
function show(extra: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const handlers = { onOpenSettings: vi.fn(), onOpenSearch: vi.fn(),
    onCreateAgent: vi.fn(), onEditProfile: vi.fn(), onOpenMarketplace: vi.fn() }
  render(<Sidebar agents={[agent]} groups={[]} conversations={[conv]} selectedConversationId={conv.id}
    onSelectConversation={vi.fn()} onNewConversation={vi.fn()} onOpenTarget={vi.fn()}
    {...handlers} {...extra} />)
  return handlers
}

describe('Hermes Desk sidebar chrome', () => {
  it.each([240, 180])('keeps creation to one direct chat action at sidebar width %s', (width) => {
    window.localStorage.setItem('maia:sidebarWidth', String(width))
    const onNewConversation = vi.fn()
    show({ onNewConversation })
    expect(screen.queryByRole('button', { name: 'New shared room' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'More creation options' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(onNewConversation).toHaveBeenCalledOnce()
  })

  it('uses the existing palette and AgentEditor callbacks directly', () => {
    const handlers = show()
    expect(screen.getByText('Hermes Desk')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }))
    expect(handlers.onOpenSearch).toHaveBeenCalledOnce()
    expect(handlers.onCreateAgent).toHaveBeenCalledOnce()
  })
  it('shows Settings without platform account, usage, billing or marketplace entries', () => {
    const handlers = show()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(handlers.onOpenSettings).toHaveBeenCalledOnce()
    expect(handlers.onOpenMarketplace).not.toHaveBeenCalled()
    for (const name of ['Account and settings', 'Account', 'Usage', 'Billing', 'Connect apps', 'Invite']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })
  it('restores the animated selected-agent card, its presence, and its info action', () => {
    const handlers = show({ activityByAgent: { [agent.id]: { waitingApproval: true } } })
    expect(screen.getByText('fake-local-model')).toBeTruthy()
    expect(screen.getByText('fake-local-model').title).toContain('not this chat’s reported session model')
    expect(screen.getByText('Waiting for your approval')).toBeTruthy()
    expect(screen.getByText('Waiting for approval')).toBeTruthy()
    const card = screen.getByRole('button', { name: 'About Fake Hermes' })
    expect(card.querySelector('[data-orb-motion="engine"]')).not.toBeNull()
    fireEvent.click(card)
    expect(handlers.onEditProfile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open agent info' }))
    expect(handlers.onEditProfile).toHaveBeenCalledWith(conv.id)
  })
  it('supports an explicit AgentInfo callback when integrated without a conversation', () => {
    const onOpenAgentInfo = vi.fn()
    show({ conversations: [], selectedConversationId: null, selectedAgentId: agent.id, onOpenAgentInfo })
    fireEvent.click(screen.getByRole('button', { name: 'About Fake Hermes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open agent info' }))
    expect(onOpenAgentInfo).toHaveBeenCalledWith(agent.id)
  })
  it('opens agent info directly from the animated compact card', () => {
    window.localStorage.setItem('maia:sidebarWidth', '180')
    const handlers = show()
    const card = screen.getByRole('button', { name: 'About Fake Hermes' })
    expect(card.querySelector('[data-orb-motion="engine"]')).not.toBeNull()
    expect(card.querySelector('.hd-agent-avatar')?.getAttribute('style')).toContain('width: 36px')
    fireEvent.click(card)
    expect(handlers.onEditProfile).toHaveBeenCalledWith(conv.id)
    expect(screen.queryByRole('button', { name: 'Open agent info' })).toBeNull()
  })
  it('renders unknown connectors safely when no preload exists', () => {
    show()
    expect(screen.getByLabelText('HERMES: unknown')).toBeTruthy()
    expect(screen.getByLabelText('BROWSER: unknown')).toBeTruthy()
    expect(screen.getByLabelText('COMPUTER: unknown')).toBeTruthy()
  })
})

describe('sidebar activity while Hermes connects', () => {
  it('retries soon when Hermes is up but not yet connected, then shows previews', async () => {
    vi.useFakeTimers()
    const sidebarActivity = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ fake: { preview: 'Synthetic latest reply', hasSessions: true } })
    ;(window as unknown as { nubAgent?: unknown }).nubAgent = { host: {
      sidebarActivity,
      status: vi.fn(async () => ({ serve: { state: 'up' } })),
      onStatus: vi.fn(() => () => {}),
    } }
    try {
      show({ conversations: [] })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(sidebarActivity).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(sidebarActivity).toHaveBeenCalledTimes(2)
      expect(screen.getByText('Synthetic latest reply')).toBeTruthy()
    } finally {
      delete (window as unknown as { nubAgent?: unknown }).nubAgent
      vi.useRealTimers()
    }
  })
})
