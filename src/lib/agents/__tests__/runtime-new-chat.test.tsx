import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../active-transport', () => ({ getActiveTransport: async () => ({ transport: { subscribe: () => () => {} } }), resetActiveTransport: () => {} }))
vi.mock('../useBootWarmup', () => ({ useBootWarmup: () => {}, useBehindWarmup: () => {} }))
vi.mock('../audit-log', () => ({ auditRowsFromTransportEvent: () => [], appendAuditRows: () => {} }))
vi.mock('../../hermes-agents', () => ({ syncRosterToHermes: async () => {}, syncDesktopAgentToHermes: async () => {} }))
vi.mock('../../avatar-intent', () => ({ maybeApplyAvatarIntent: () => {} }))
vi.mock('../../subagent-continue', () => ({ startDelegateContinuations: () => () => {}, continueAfterSubagent: () => {} }))
import { getState, resetStore, setState } from '../store'
import { useAgentRuntime } from '../useAgentRuntime'
import { setPendingToolPermission } from '../tool-permission'

beforeEach(() => {
  resetStore()
  const createdAt = '2026-10-07T00:00:00Z'
  setState({
    agents: [{ id: 'fixture', name: 'Synthetic agent', status: 'running', region: 'local', summary: '', createdAt }],
    conversations: [{ id: 'existing', title: 'Older work', target: { type: 'agent', agentId: 'fixture' }, createdAt, lastUsedAt: createdAt }],
    selectedConversationId: 'existing', messagesByThreadId: { existing: [] },
  })
})
afterEach(() => { cleanup(); setPendingToolPermission(null) })

it('keeps the selected approval visible when another conversation asks and restores it on selection', async () => {
  const view = renderHook(() => useAgentRuntime())
  await act(async () => {})
  act(() => {
    setPendingToolPermission({ id: 'first', conversationId: 'existing', sessionId: 'one', choices: ['once'], status: 'pending' })
    view.result.current.newConversation({ type: 'agent', agentId: 'fixture' })
  })
  const second = getState().selectedConversationId!
  act(() => {
    setPendingToolPermission({ id: 'second', conversationId: second, sessionId: 'two', choices: ['deny'], status: 'pending' })
    view.result.current.handleSelect('existing')
  })
  expect(view.result.current.permissionAsk?.id).toBe('first')
  act(() => view.result.current.handleSelect(second))
  expect(view.result.current.permissionAsk?.id).toBe('second')
})

it('New chat creates a fresh conversation without changing the configured agent', async () => {
  const view = renderHook(() => useAgentRuntime())
  await act(async () => {})
  const agents = getState().agents
  act(() => { view.result.current.newConversation({ type: 'agent', agentId: 'fixture' }) })
  const fresh = getState().selectedConversationId
  expect(fresh).not.toBe('existing')
  expect(getState().conversations).toHaveLength(2)
  expect(getState().agents).toBe(agents)
  expect(getState().messagesByThreadId[fresh!].filter(message => message.role === 'user' || message.role === 'agent')).toEqual([])
  act(() => view.result.current.handleSelect('existing'))
  expect(getState().selectedConversationId).toBe('existing')
  expect(getState().conversations).toHaveLength(2)
})

it('agent selection resumes a visible chat, but never silently revives a hidden one', async () => {
  const view = renderHook(() => useAgentRuntime())
  await act(async () => {})
  act(() => view.result.current.openWithTarget({ type: 'agent', agentId: 'fixture' }))
  expect(getState().selectedConversationId).toBe('existing')
  expect(getState().conversations).toHaveLength(1)
  act(() => setState({ conversations: getState().conversations.map(chat => ({ ...chat, hiddenFromSidebar: true })) }))
  act(() => view.result.current.openWithTarget({ type: 'agent', agentId: 'fixture' }))
  expect(getState().selectedConversationId).not.toBe('existing')
  expect(getState().conversations.find(chat => chat.id === 'existing')?.hiddenFromSidebar).toBe(true)
})
