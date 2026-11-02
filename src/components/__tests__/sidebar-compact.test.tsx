/**
 * Sidebar compact rail: collapsing to MIN width (⌘B / toggle) swaps the
 * squeezed conversation list for an icons-only orb rail. Orbs share the
 * row's display state (selection, live, unread) via describeConv, so the
 * two modes can never drift apart.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Sidebar } from '../Sidebar'
import type { Agent, Conversation, Group } from '../../lib/agents/types'

vi.mock('../../build-env', () => ({ isProdBuild: vi.fn(() => false) }))

const compactCss = readFileSync(resolve(__dirname, '../../styles/sidebar-compact.css'), 'utf8')
let compactStyle: HTMLStyleElement
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })))
  window.localStorage.clear()
  compactStyle = document.createElement('style')
  compactStyle.textContent = compactCss
  document.head.append(compactStyle)
})

afterEach(() => {
  cleanup()
  compactStyle.remove()
  vi.unstubAllGlobals()
})

function conv(partial: Partial<Conversation>): Conversation {
  return {
    id: 'conv_1',
    title: null,
    preview: null,
    target: { type: 'agent', agentId: 'inst_nub' },
    pinned: false,
    hasUnread: false,
    hiddenFromSidebar: false,
    lastUsedAt: '2026-09-07T00:00:00Z',
    createdAt: '2026-09-07T00:00:00Z',
    ...partial,
  } as Conversation
}

const baseAgents: Agent[] = [
  {
    id: 'inst_nub',
    name: 'Nub',
    status: 'running',
    region: 'remote',
    createdAt: '2026-08-01T00:00:00Z',
  } as Agent,
]

function renderSidebar(onSelect: (id: string) => void, extra: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return render(
    <Sidebar
      conversations={[conv({})]}
      agents={baseAgents}
      groups={[] as Group[]}
      selectedConversationId="conv_1"
      onSelectConversation={onSelect}
      onNewConversation={() => {}}
      onOpenTarget={() => {}}
      onOpenSettings={() => {}}
      onOpenSearch={() => {}}
      hiddenConversations={[]}
      {...extra}
    />,
  )
}

describe('sidebar compact rail', () => {
  it('renders the full list at default width', () => {
    renderSidebar(() => {})
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Your agents' })).toBeTruthy()
    expect(screen.getByText('Hermes Desk')).toBeTruthy()
  })

  it('swaps to the icons-only rail at MIN width', () => {
    window.localStorage.setItem('maia:sidebarWidth', '180')
    renderSidebar(() => {})
    // Text chrome is gone; the orb rail takes over.
    expect(screen.queryByText('Settings')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Account and settings' })).toBeNull()
    expect(screen.queryByText('Search')).toBeNull()
    const nav = screen.getByRole('navigation', { name: 'Your agents' })
    expect(nav).toBeTruthy()
    // Rail is 60px, not the squeezed 180px list.
    expect(screen.getByRole('complementary').getAttribute('style')).toContain('60')
  })

  it('selects the conversation from the orb', () => {
    window.localStorage.setItem('maia:sidebarWidth', '180')
    const onSelect = vi.fn()
    renderSidebar(onSelect)
    fireEvent.click(screen.getByRole('button', { name: 'Nub' }))
    expect(onSelect).toHaveBeenCalledWith('conv_1')
  })

  it('offers expand + settings + search as labelled icon buttons', () => {
    window.localStorage.setItem('maia:sidebarWidth', '180')
    renderSidebar(() => {})
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Manage agents' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New agent' })).toBeNull()
  })

  it.each(['messenger', 'classic'] as const)('centers compact avatars without an empty text column in %s', (skin) => {
    window.localStorage.setItem('maia:sidebarWidth', '180')
    renderSidebar(() => {}, { skin })
    const row = screen.getByRole('button', { name: 'Nub' })
    expect(getComputedStyle(row.querySelector('.desk-list-row-content')!).display).toBe('none')
    expect(row.querySelector('.hd-agent-avatar')?.getAttribute('style')).toContain('width: 36px')
    expect(getComputedStyle(row).gap).toBe('0px')
  })

  it('overlays large unread counts and the orchestrator marker without pushing the avatar out of the rail', () => {
    window.localStorage.setItem('maia:sidebarWidth', '180')
    renderSidebar(() => {}, {
      agents: [{ ...baseAgents[0], orchestrator: true }],
      conversations: [{ ...conv({ hasUnread: true }), unreadCount: 128 }],
    })
    const row = screen.getByRole('button', { name: 'Nub' })
    const avatar = row.querySelector('.hd-rail-avatar')!
    expect(within(avatar as HTMLElement).getByLabelText('128 unread').textContent).toBe('99+')
    expect(within(avatar as HTMLElement).getByLabelText('Orchestrator')).toBeTruthy()
    expect(row.querySelector('.desk-list-row-trailing')).toBeNull()
    expect(getComputedStyle(screen.getByLabelText('128 unread')).position).toBe('absolute')
  })

  it('uses icon-only connectors and centered settings/restore controls while compact', () => {
    window.localStorage.setItem('maia:sidebarWidth', '180')
    renderSidebar(() => {})
    for (const name of ['HERMES', 'BROWSER', 'COMPUTER']) {
      const connector = screen.getByLabelText(`${name}: unknown`)
      expect(connector.querySelector('svg')).not.toBeNull()
      expect(connector.textContent).toBe('')
    }
    expect(getComputedStyle(screen.getByRole('button', { name: 'Settings' })).justifyContent).toBe('center')
    expect(getComputedStyle(screen.getByRole('button', { name: 'Hidden agents' })).width).toBe('100%')
    const connection = screen.getByText('Checking Hermes connection…').closest('[role="status"]')!
    expect(getComputedStyle(connection.querySelector('.hd-status-dot')!).width).toBe('5px')
    expect(connection.querySelector('.hd-status-dot')?.getAttribute('aria-hidden')).toBe('true')
    expect(getComputedStyle(screen.getByLabelText('COMPUTER: unknown').querySelector('.hd-status-dot')!).height).toBe('5px')
  })

  it('restores full row text, inline badges and connector labels on expansion', () => {
    window.localStorage.setItem('maia:sidebarWidth', '180')
    renderSidebar(() => {}, {
      conversations: [{ ...conv({ hasUnread: true }), unreadCount: 3 }],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    const row = screen.getByRole('button', { name: 'Nub' })
    expect(getComputedStyle(row.querySelector('.desk-list-row-content')!).display).not.toBe('none')
    expect(within(row.querySelector('.desk-list-row-trailing')! as HTMLElement).getByLabelText('3 unread')).toBeTruthy()
    expect(screen.getByText('HERMES')).toBeTruthy()
    expect(screen.getByText('BROWSER')).toBeTruthy()
    expect(screen.getByText('COMPUTER')).toBeTruthy()
    expect(screen.getByRole('complementary').style.width).toBe('240px')
  })
})
