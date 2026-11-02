/**
 * The local sidebar has no platform, account or marketplace affordances.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
  window.localStorage.clear()
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

function renderSidebar() {
  const onOpenMarketplace = vi.fn()
  render(
    <Sidebar
      conversations={[conv]}
      agents={agents}
      groups={[] as Group[]}
      selectedConversationId="conv_1"
      onSelectConversation={() => {}}
      onNewConversation={() => {}}
      onOpenTarget={() => {}}
      onOpenSettings={vi.fn()}
    />,
  )
  return { onOpenMarketplace }
}

describe('Sidebar without the main nav', () => {
  it('has no hosted or marketplace entries at full width', () => {
    const { onOpenMarketplace } = renderSidebar()
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
    for (const label of ['Routines', 'Files', 'Tasks', 'Skills & apps', 'Connect apps', 'Account and settings']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
    expect(screen.queryByTestId('open-marketplace')).toBeNull()
    expect(onOpenMarketplace).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Local connectors')).toBeTruthy()
  })

  it('the collapsed rail also excludes marketplace actions', () => {
    window.localStorage.setItem('maia:sidebarWidth', '180')
    const { onOpenMarketplace } = renderSidebar()
    expect(screen.queryByTestId('sidebar-rail-nav-routines')).toBeNull()
    expect(screen.queryByTestId('sidebar-rail-connect-apps')).toBeNull()
    expect(onOpenMarketplace).not.toHaveBeenCalled()
  })
})
