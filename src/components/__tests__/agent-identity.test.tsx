import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentIdentityContext, AgentNameChip, type AgentIdentity } from '../agent-identity'
import { AgentProfileCard, type AgentProfile } from '../AgentProfileCard'
import { MessageBody } from '../MessageBody'

afterEach(cleanup)

// The nubcat engine reads prefers-reduced-motion; jsdom has no matchMedia.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

const identity = (openProfile = vi.fn()): AgentIdentity => ({
  lookOf: (id) => (id === 'penny' ? { body: '#ffd7e6', eye: '#4a2c6b', picked: true } : null),
  nameOf: (id) => (id === 'penny' ? 'Penny' : id),
  openProfile,
})

describe('AgentNameChip', () => {
  it("draws the agent's colors and opens its profile card", () => {
    const open = vi.fn()
    render(
      <AgentIdentityContext.Provider value={identity(open)}>
        <AgentNameChip agentId="penny" />
      </AgentIdentityContext.Provider>,
    )
    const chip = screen.getByRole('button', { name: /penny/i })
    expect(chip.getAttribute('style')).toMatch(/background-color: rgba\(255, 215, 230, 0\.4\d+\)/)
    fireEvent.click(chip)
    expect(open).toHaveBeenCalledWith('penny', chip)
  })

  it('hands its body colour to the dark-mode re-tint', () => {
    render(
      <AgentIdentityContext.Provider value={identity(vi.fn())}>
        <AgentNameChip agentId="penny" />
      </AgentIdentityContext.Provider>,
    )
    expect(screen.getByRole('button', { name: /penny/i }).style.getPropertyValue('--chip-body')).not.toBe('')
  })

  it('is plain text without a provider', () => {
    render(<AgentNameChip agentId="bob" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('bob')).toBeTruthy()
  })
})

describe('mention chips in messages', () => {
  it("take the member's colors and open its card", () => {
    const open = vi.fn()
    render(
      <AgentIdentityContext.Provider value={identity(open)}>
        <MessageBody content="On it. @Penny draft it." variant="plain" mentions={[{ id: 'penny', name: 'Penny' }]} />
      </AgentIdentityContext.Provider>,
    )
    const chip = screen.getByRole('button', { name: '@Penny' })
    expect(chip.getAttribute('style')).toContain('color: rgb(74, 44, 107)')
    expect(chip.style.getPropertyValue('--chip-body')).not.toBe('')
    fireEvent.click(chip)
    expect(open).toHaveBeenCalledWith('penny', chip)
  })
})

describe('AgentProfileCard', () => {
  const profile: AgentProfile = {
    id: 'penny',
    name: 'Penny',
    title: 'Copywriter',
    description: 'Writes landing-page copy.',
    chief: true,
    look: { body: '#ffd7e6', eye: '#4a2c6b', picked: true },
    liveText: 'using web search',
    known: true,
  }

  it('shows who the agent is and what it is doing, and its actions work', () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const onMessage = vi.fn()
    const onMention = vi.fn()
    const onClose = vi.fn()
    render(<AgentProfileCard profile={profile} anchor={anchor} onClose={onClose} onMessage={onMessage} onMention={onMention} />)
    const card = screen.getByTestId('agent-profile-card')
    // Marked so the app-level Esc (App.tsx) yields to the card's own handler.
    expect(card.hasAttribute('data-esc-layer')).toBe(true)
    expect(card.textContent).toContain('Penny')
    expect(card.textContent).toContain('Copywriter')
    expect(card.textContent).toContain('Leads this room')
    expect(card.textContent).toContain('Writes landing-page copy.')
    expect(screen.getByTestId('agent-profile-live').textContent).toBe('Using web search here')
    fireEvent.click(screen.getByRole('button', { name: '@Mention' }))
    expect(onMention).toHaveBeenCalledWith('Penny')
    fireEvent.click(screen.getByRole('button', { name: 'Message' }))
    expect(onMessage).toHaveBeenCalledWith('penny')
    anchor.remove()
  })

  it('closes on Escape, and a member from another device has no Message action', () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const onClose = vi.fn()
    render(
      <AgentProfileCard profile={{ ...profile, known: false, description: undefined, liveText: null }} anchor={anchor} onClose={onClose} onMessage={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull()
    expect(screen.getByTestId('agent-profile-card').textContent).toContain('Set up on another device.')
    expect(screen.getByTestId('agent-profile-live').textContent).toBe('Idle in this chat')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    anchor.remove()
  })
})

describe('dark mode chip colours', () => {
  it('index.css re-tints agent and mention chips in dark mode, with ink text', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'index.css'), 'utf8')
    const rule = css.match(/html\[data-theme='dark'\] \.nub-agent-chip\[style\],\s*html\[data-theme='dark'\] \.nub-mention\[style\] \{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule![1]).toContain('var(--chip-body)')
    expect(rule![1]).toContain('color: var(--ca-ink) !important')
  })
})

