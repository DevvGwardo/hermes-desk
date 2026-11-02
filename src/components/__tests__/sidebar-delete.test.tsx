/** Local profile rows can only be hidden, never deleted. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Sidebar } from '../Sidebar'
import { getLocalPrefs, updateLocalPrefs } from '../../lib/local-prefs'
import type { RosterAgent, RosterConversation } from '../../lib/agents/roster'

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false, addEventListener() {}, removeEventListener() {},
  })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const agent: RosterAgent = {
  id: 'profile:fake', hermesProfile: 'fake', name: 'Fake Hermes',
  status: 'running', region: 'local', summary: '', createdAt: '2026-10-06',
}
const conv: RosterConversation = {
  id: 'fake-conv', title: '', target: { type: 'agent', agentId: agent.id },
  createdAt: '2026-10-06', lastUsedAt: '2026-10-06',
}
function show() {
  const onDeleteConversation = vi.fn()
  const onHideConversation = vi.fn()
  const view = render(<Sidebar agents={[agent]} groups={[]} conversations={[conv]}
    selectedConversationId={conv.id} onSelectConversation={vi.fn()} onNewConversation={vi.fn()}
    onOpenTarget={vi.fn()} onOpenSettings={vi.fn()}
    onDeleteConversation={onDeleteConversation} onHideConversation={onHideConversation} />)
  return { ...view, onDeleteConversation, onHideConversation }
}

describe('profile hide and restore', () => {
  it('offers safe profile actions, leaving profiles and conversations intact', () => {
    const handlers = show()
    fireEvent.contextMenu(screen.getByRole('button', { name: agent.name }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Pin', 'Hide', 'Agent details'])
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()
    expect(document.querySelector('[data-esc-layer]')).not.toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
    expect(screen.queryByRole('button', { name: agent.name })).toBeNull()
    expect(getLocalPrefs().hiddenProfiles).toEqual(['fake'])
    expect(handlers.onDeleteConversation).not.toHaveBeenCalled()
    expect(handlers.onHideConversation).not.toHaveBeenCalled()
    expect(conv.id).toBe('fake-conv')
  })
  it('restores a hidden agent without modifying its sessions', () => {
    updateLocalPrefs({ hiddenProfiles: ['fake'] })
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Hidden agents' }))
    fireEvent.click(screen.getByRole('menuitem', { name: agent.name }))
    expect(screen.getByRole('button', { name: agent.name })).toBeTruthy()
    expect(getLocalPrefs().hiddenProfiles).toEqual([])
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('persists profile hiding across sidebar remounts', () => {
    const view = show()
    fireEvent.contextMenu(screen.getByRole('button', { name: agent.name }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
    view.unmount()
    show()
    expect(screen.queryByRole('button', { name: agent.name })).toBeNull()
  })
  it('pins and unpins the profile, not its conversation', () => {
    show()
    fireEvent.contextMenu(screen.getByRole('button', { name: agent.name }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }))
    expect(getLocalPrefs().pinnedOrder).toEqual([agent.id])
    fireEvent.contextMenu(screen.getByRole('button', { name: agent.name }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin' }))
    expect(getLocalPrefs().pinnedOrder).toEqual([])
  })
  it('opens the same safe menu with the keyboard and Escape dismisses it', () => {
    show()
    fireEvent.keyDown(screen.getByRole('button', { name: agent.name }), { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('the existing hidden-chats command opens the restore menu', () => {
    updateLocalPrefs({ hiddenProfiles: ['fake'] })
    show()
    act(() => { window.dispatchEvent(new CustomEvent('maia:open-hidden-chats')) })
    expect(screen.getByRole('menu', { name: 'Hidden agents' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()
  })
  it('outside pointer-down dismisses the profile menu', () => {
    show()
    fireEvent.contextMenu(screen.getByRole('button', { name: agent.name }))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
