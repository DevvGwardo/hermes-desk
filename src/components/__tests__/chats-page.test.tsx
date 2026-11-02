import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatsPage } from '../ChatsPage'
import type { RosterAgent, RosterConversation } from '../../lib/agents/roster'

afterEach(cleanup)
const createdAt = '2026-10-07T10:00:00Z'
const agents: RosterAgent[] = ['review', 'research'].map(id => ({ id, name: id, status: 'running', region: 'local', summary: '', createdAt }))
const conversations: RosterConversation[] = Array.from({ length: 35 }, (_, i) => ({
  id: `fixture-${i}`, title: `Task ${i}`, target: { type: 'agent', agentId: agents[i % 2].id },
  preview: i === 20 ? 'Find this release checklist' : 'Synthetic preview', createdAt, lastUsedAt: createdAt,
}))

it('searches older chats, filters by agent, and continues the exact selected chat', () => {
  const open = vi.fn()
  render(<ChatsPage agents={agents} conversations={conversations} groups={[]} prefs={{}} onOpenConversation={open} onNewChat={vi.fn()} />)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'release checklist' } })
  fireEvent.click(screen.getByRole('button', { name: /Task 20/ }))
  expect(open).toHaveBeenCalledWith('fixture-20')
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'research' } })
  expect(screen.getByText('No matching chats')).toBeTruthy()
})

it('loads the archive incrementally, keeps pinned work first, and omits locally hidden chats', () => {
  const chats = conversations.map((chat, i) => ({ ...chat, pinned: i === 34, hiddenFromSidebar: i === 33 }))
  render(<ChatsPage agents={agents} conversations={chats} groups={[]} prefs={{}} onOpenConversation={vi.fn()} onNewChat={vi.fn()} />)
  const rows = screen.getByRole('list', { name: 'Chats' }).querySelectorAll('li')
  expect(rows).toHaveLength(30)
  expect(rows[0].textContent).toContain('Task 34')
  fireEvent.click(screen.getByRole('button', { name: 'Show more chats' }))
  expect(screen.getByRole('list', { name: 'Chats' }).querySelectorAll('li')).toHaveLength(34)
  expect(screen.queryByRole('button', { name: /Task 33/ })).toBeNull()
})

it('offers shared-room creation beside New chat without changing either action', () => {
  const onNewChat = vi.fn(), onCreateGroup = vi.fn()
  render(<ChatsPage agents={agents} conversations={[]} groups={[]} prefs={{}}
    onOpenConversation={vi.fn()} onNewChat={onNewChat} onCreateGroup={onCreateGroup} />)
  fireEvent.click(screen.getByRole('button', { name: 'New shared room' }))
  expect(onCreateGroup).toHaveBeenCalledOnce()
  expect(onNewChat).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  expect(onNewChat).toHaveBeenCalledOnce()
  expect(onCreateGroup).toHaveBeenCalledOnce()
})

it('omits shared-room creation when the capability is unavailable', () => {
  render(<ChatsPage agents={agents} conversations={[]} groups={[]} prefs={{}}
    onOpenConversation={vi.fn()} onNewChat={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'New shared room' })).toBeNull()
})
