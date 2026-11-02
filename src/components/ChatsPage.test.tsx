import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ChatsPage } from './ChatsPage'
import type { RosterAgent, RosterConversation } from '../lib/agents/roster'

afterEach(cleanup)
const agent: RosterAgent = { id: 'alpha', name: 'Alpha', status: 'running', region: 'local', summary: '', createdAt: '2026-10-11' }
const chats: RosterConversation[] = [
  { id: 'agent-chat', title: 'Agent notes', target: { type: 'agent', agentId: 'alpha' }, createdAt: '2026-10-11', lastUsedAt: '2026-10-11' },
  { id: 'room-chat', title: 'Team notes', target: { type: 'group', groupId: 'room' }, createdAt: '2026-10-11', lastUsedAt: '2026-10-11' },
]
it('distinguishes shared rooms from individual chats without losing search or open actions', () => {
  const open = vi.fn()
  const { rerender } = render(<ChatsPage agents={[agent]} groups={[{ id: 'room', name: 'Research team', memberAgentIds: ['alpha'], primaryAgentId: 'alpha', createdAt: '2026-10-11' }]}
    conversations={chats} prefs={{}} onNewChat={vi.fn()} onOpenConversation={open} />)
  const list = screen.getByRole('list', { name: 'Chats' })
  expect(within(list).getAllByRole('button')).toHaveLength(2)
  fireEvent.change(screen.getByRole('combobox', { name: 'Chat type' }), { target: { value: 'room' } })
  expect(within(list).getAllByRole('button')).toHaveLength(1)
  const room = within(list).getByRole('button', { name: /Team notes/ })
  expect(room.textContent).toContain('Shared room · Research team')
  fireEvent.click(room)
  expect(open).toHaveBeenCalledWith('room-chat')
  fireEvent.change(screen.getByRole('combobox', { name: 'Chat type' }), { target: { value: 'agent' } })
  expect(within(list).getByRole('button', { name: /Agent notes/ })).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search chats' }), { target: { value: 'unmatched' } })
  expect(screen.getByRole('heading', { name: 'No matching chats' })).toBeTruthy()
  rerender(<ChatsPage agents={[agent]} groups={[]} conversations={[chats[0]]} prefs={{}} onNewChat={vi.fn()} onOpenConversation={open} />)
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search chats' }), { target: { value: '' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Chat type' }), { target: { value: 'room' } })
  expect(screen.getByRole('heading', { name: 'No shared rooms yet' })).toBeTruthy()
  expect(screen.getByText('Create a shared room to work with multiple agents.')).toBeTruthy()
})

it('renders and filters tool-only GenUI turn previews when messagesByThreadId is provided', () => {
  render(<ChatsPage agents={[agent]} groups={[]} conversations={[chats[0]]} prefs={{}}
    messagesByThreadId={{
      'agent-chat': [{
        id: 'm-genui', threadId: 'agent-chat', role: 'agent', content: '', createdAt: '2026-10-11T12:00:00Z',
        toolEvents: [{
          tool: 'mcp__hermes_desk__render_ui', toolCallId: 'call-1', status: 'completed',
          genui: { version: 1, components: [{ type: 'stat', title: 'Canary health', value: '100%', detail: 'Zero regressions' }] },
        }],
      }],
    }}
    onNewChat={vi.fn()} onOpenConversation={vi.fn()} />)
  const list = screen.getByRole('list', { name: 'Chats' })
  expect(within(list).getByRole('button', { name: /Agent notes/ }).textContent).toContain('Canary health: 100% (Zero regressions)')
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search chats' }), { target: { value: 'zero regressions' } })
  expect(within(list).getByRole('button', { name: /Agent notes/ })).toBeTruthy()
})
