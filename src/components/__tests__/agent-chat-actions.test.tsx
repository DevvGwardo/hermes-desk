import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentProfileCard, type AgentProfile } from '../AgentProfileCard'
import { ChatPanel } from '../ChatPanel'
import type { Agent, ChatMessage } from '../../lib/agents/types'

afterEach(cleanup)
beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(),
    removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }))
})
const agent: Agent = { id: 'profile:alpha', hermesProfile: 'alpha', name: 'Alpha', status: 'running',
  region: 'local', createdAt: '2026-10-10T00:00:00Z', summary: 'A local specialist.' }
const profile: AgentProfile = { id: agent.id, name: agent.name, known: true, chief: false, look: null, liveText: null }
const message: ChatMessage = { id: 'reply', threadId: 'room', role: 'agent', fromAgentId: agent.id,
  content: 'Alpha result.', createdAt: '2026-10-10T00:00:00Z' }

function CardFixture({ anchor, onMention }: { anchor: HTMLElement; onMention?: () => void }) {
  const [open, setOpen] = useState(true)
  return open ? <AgentProfileCard profile={profile} anchor={anchor} onClose={() => setOpen(false)}
    onMention={onMention} /> : null
}

describe('agent card keyboard and action ownership', () => {
  it('offers explicit dismissal and restores focus on Escape', () => {
    const anchor = document.createElement('button')
    document.body.append(anchor)
    const { unmount } = render(<CardFixture anchor={anchor} />)
    const close = screen.getByRole('button', { name: 'Close Alpha profile' })
    close.focus()
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(anchor)
    unmount()
    anchor.remove()
  })

  it('does not steal the composer focus after Mention', () => {
    const anchor = document.createElement('button')
    const composer = document.createElement('textarea')
    document.body.append(anchor, composer)
    const { unmount } = render(<CardFixture anchor={anchor} onMention={() => composer.focus()} />)
    fireEvent.click(screen.getByRole('button', { name: '@Mention' }))
    expect(document.activeElement).toBe(composer)
    expect(screen.queryByRole('dialog')).toBeNull()
    unmount()
    anchor.remove()
    composer.remove()
  })

  it('keeps its position attached to the agent chip as the transcript scrolls', () => {
    const anchor = document.createElement('button')
    document.body.append(anchor)
    let left = 50
    anchor.getBoundingClientRect = () => ({ left, top: 20, bottom: 40, right: left + 50,
      width: 50, height: 20, x: left, y: 20, toJSON: () => ({}) })
    const { unmount } = render(<CardFixture anchor={anchor} />)
    const card = screen.getByRole('dialog')
    expect(card.style.left).toBe('50px')
    left = 90
    fireEvent.scroll(window)
    expect(card.style.left).toBe('90px')
    unmount()
    anchor.remove()
  })
})

describe('agent cards within a chat', () => {
  function renderChat(extra: Partial<Parameters<typeof ChatPanel>[0]> = {}) {
    Element.prototype.scrollIntoView = vi.fn()
    const props = { messages: [message], threadKey: 'room', onSend: vi.fn(), agents: [agent],
      agentName: () => 'Alpha', showAgentSpeaker: true, mentionMembers: [{ id: agent.id, name: 'Alpha' }], ...extra }
    const view = render(<ChatPanel {...props} />)
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-agent-chip="profile:alpha"], [aria-label="About Alpha"]')!)
    return { ...view, props }
  }

  it.each([false, true])('never inserts a mention into a read-only or disabled composer (readOnly=%s)', readOnly => {
    renderChat({ readOnly, disabled: !readOnly })
    expect(within(screen.getByRole('dialog', { name: 'About Alpha' })).queryByRole('button', { name: '@Mention' })).toBeNull()
  })

  it('does not offer a room mention for a former member and closes on chat changes', async () => {
    const { rerender, props } = renderChat({ mentionMembers: [{ id: 'profile:beta', name: 'Beta' }] })
    const card = within(screen.getByRole('dialog', { name: 'About Alpha' }))
    expect(card.queryByRole('button', { name: '@Mention' })).toBeNull()
    expect(card.getByText('No longer in this room')).toBeTruthy()
    await act(async () => rerender(<ChatPanel {...props} threadKey="other" />))
    expect(screen.queryByRole('dialog', { name: 'About Alpha' })).toBeNull()
  })

  it('keeps focus in the room draft after a valid mention', () => {
    renderChat()
    fireEvent.click(within(screen.getByRole('dialog', { name: 'About Alpha' })).getByRole('button', { name: '@Mention' }))
    const composer = screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement
    expect(composer.value).toContain('@Alpha ')
    expect(document.activeElement).toBe(composer)
  })

  it('reports work in a direct chat instead of calling a running agent idle', () => {
    renderChat({ showAgentSpeaker: false, starterAgent: agent, sending: true, mentionMembers: [] })
    expect(screen.getByTestId('agent-profile-live').textContent).toBe('Working on your request here')
  })
})
