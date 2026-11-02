import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Sidebar } from './Sidebar'
import { getLocalPrefs, updateLocalPrefs } from '../lib/local-prefs'
import { getState, setState } from '../lib/agents/store'
import { setPendingToolPermission } from '../lib/agents/tool-permission'
import type { RosterAgent, RosterConversation } from '../lib/agents/roster'

const sidebarCss = readFileSync(resolve(process.cwd(), 'src/styles/skin-messenger-sidebar.css'), 'utf8')

const originalState = getState()
beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false, addEventListener() {}, removeEventListener() {},
  })))
  setState({ messagesByThreadId: {} })
})
afterEach(() => {
  cleanup()
  setState(originalState)
  setPendingToolPermission(null)
  vi.unstubAllGlobals()
})
const agents: RosterAgent[] = ['fake-a', 'fake-b', 'session-fake'].map((name) => ({
  id: `profile:${name}`, hermesProfile: name, name, status: 'running',
  region: 'local', createdAt: '2026-10-06', summary: '',
}))
const conv = (id: string, agentId: string, date: string, extra = {}): RosterConversation => ({
  id, title: 'Fake conversation', target: { type: 'agent', agentId },
  createdAt: date, lastUsedAt: date, ...extra,
})
function show(extra: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const handlers = { onSelectConversation: vi.fn(), onNewConversation: vi.fn(),
    onOpenTarget: vi.fn(), onOpenSettings: vi.fn(), onMarkRead: vi.fn() }
  const view = render(<Sidebar agents={agents} groups={[]} conversations={[
    conv('fake-a1', agents[0].id, '2026-10-06T10:00:00Z'),
    conv('fake-b1', agents[1].id, '2026-10-06T11:00:00Z'),
  ]} selectedConversationId="fake-a1" {...handlers} {...extra} />)
  const order = () => [...view.container.querySelectorAll('li[data-agent-id]')].map((row) => row.getAttribute('data-agent-id'))
  return { ...view, ...handlers, order }
}

describe('Hermes profile roster', () => {
  it('lists profiles with no conversations and hides scratch profiles by default', () => {
    const view = show({ conversations: [], selectedConversationId: null })
    expect(view.order()).toEqual([agents[0].id, agents[1].id])
    fireEvent.click(screen.getByRole('button', { name: agents[1].name }))
    expect(view.onOpenTarget).toHaveBeenCalledWith({ type: 'agent', agentId: agents[1].id })
    expect(view.onSelectConversation).not.toHaveBeenCalled()
    act(() => { updateLocalPrefs({ showScratch: true }) })
    expect(view.order()).toHaveLength(3)
  })
  it('sums unread across conversations and shows the newest preview across sources', () => {
    show({ conversations: [
      conv('fake-a1', agents[0].id, '2026-10-06T09:00:00Z', { hasUnread: true, unreadCount: 2, preview: 'Older' }),
      conv('fake-a2', agents[0].id, '2026-10-06T10:00:00Z', { unreadCount: 3, preview: '**Latest from CLI**', source: 'cli' }),
    ] })
    expect(screen.getByLabelText('5 unread')).toBeTruthy()
    expect(screen.getByText('Latest from CLI')).toBeTruthy()
    expect(screen.queryByText('Older')).toBeNull()
  })
  it('opens a desktop conversation and marks only that session read', () => {
    const view = show({ selectedConversationId: null, conversations: [
      conv('fake-desktop', agents[0].id, '2026-10-06T09:00:00Z', { source: 'desktop' }),
      conv('fake-cli', agents[0].id, '2026-10-06T11:00:00Z', { source: 'cli' }),
    ] })
    fireEvent.click(screen.getByRole('button', { name: agents[0].name }))
    expect(view.onSelectConversation).toHaveBeenCalledWith('fake-desktop')
    expect(view.onMarkRead).toHaveBeenCalledWith('fake-desktop')
    act(() => { updateLocalPrefs({ sessionSources: ['cli'] }) })
    fireEvent.click(screen.getByRole('button', { name: agents[0].name }))
    expect(view.onSelectConversation).toHaveBeenLastCalledWith('fake-cli')
  })
  it('preserves the selected session instead of jumping to a newer one for the same agent', () => {
    const view = show({ conversations: [
      conv('fake-a1', agents[0].id, '2026-10-06T09:00:00Z'),
      conv('fake-a2', agents[0].id, '2026-10-06T11:00:00Z'),
    ] })
    fireEvent.click(screen.getByRole('button', { name: agents[0].name }))
    expect(view.onSelectConversation).toHaveBeenCalledWith('fake-a1')
  })
  it('persists drag reorder and retains that order after remount', () => {
    const view = show()
    expect(view.order()).toEqual([agents[1].id, agents[0].id])
    const from = view.container.querySelector(`li[data-agent-id="${agents[0].id}"]`)!
    const to = view.container.querySelector(`li[data-agent-id="${agents[1].id}"]`)!
    fireEvent.dragStart(from)
    fireEvent.dragOver(to)
    fireEvent.drop(to)
    expect(getLocalPrefs().pinnedOrder).toEqual([agents[0].id, agents[1].id])
    expect(view.order()).toEqual([agents[0].id, agents[1].id])
    view.unmount()
    expect(show().order()).toEqual([agents[0].id, agents[1].id])
  })
  it('offers keyboard reorder with Alt+ArrowUp and ignores external drops', () => {
    const view = show()
    fireEvent.keyDown(screen.getByRole('button', { name: agents[0].name }), { key: 'ArrowUp', altKey: true })
    expect(view.order()).toEqual([agents[0].id, agents[1].id])
    fireEvent.drop(view.container.querySelector('li[data-agent-id]')!)
    expect(view.order()).toEqual([agents[0].id, agents[1].id])
  })
  it('prioritizes real tool activity and approvals over the latest preview', () => {
    setState({ messagesByThreadId: { 'fake-a1': [{
      id: 'fake-message', threadId: 'fake-a1', role: 'agent', content: '', createdAt: '2026-10-06',
      streaming: true, toolEvents: [{ tool: 'browser_navigate', status: 'running',
        args: '{"url":"https://en.wikipedia.org/wiki/Fake"}' }],
    }] } })
    show({ conversations: [
      conv('fake-a1', agents[0].id, '2026-10-06', { preview: 'Finished researching', last_activity_description: 'Finished researching' }),
    ] })
    expect(screen.getByText('Browsing en.wikipedia.org')).toBeTruthy()
    // The row's aria-label hides its content from screen readers; status rides in its description.
    expect(screen.getByRole('button', { name: agents[0].name }).getAttribute('aria-description'))
      .toBe('Browsing en.wikipedia.org')
    act(() => {
      setState({ messagesByThreadId: {} })
      setPendingToolPermission({ id: 'fake-approval', conversationId: 'fake-a1', sessionId: 'fake-session',
        choices: ['once', 'deny'], status: 'pending' })
    })
    expect(screen.queryByText('Finished researching')).toBeNull()
    expect(screen.queryByText('Browsing en.wikipedia.org')).toBeNull()
    expect(screen.getByText('Waiting for your approval')).toBeTruthy()
    act(() => { setPendingToolPermission(null) })
    expect(screen.getByText('Finished researching')).toBeTruthy()
  })
  it('adds the orchestrator crown', () => {
    show({ agents: [{ ...agents[0], orchestrator: true }] })
    expect(screen.getByLabelText('Orchestrator')).toBeTruthy()
  })
  it('scopes the skin and its selected-row color without leaking CSS selectors', () => {
    const view = show()
    expect(view.container.querySelector('aside')?.getAttribute('data-skin')).toBe('messenger')
    expect(sidebarCss).toContain('background: #2c2c2e')
    const selectors = sidebarCss.match(/[^{}]+\{/g) ?? []
    for (const selector of selectors) {
      if (!selector.trim().startsWith('@')) expect(selector).toContain('[data-skin="messenger"]')
    }
  })
})
