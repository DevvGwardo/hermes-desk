import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentAvatar, AgentCard, agentColor } from './AgentCard'
import { agentColor as mascotColor } from './AgentMascot'
import type { AgentPresence, RosterAgent } from '../lib/agents/roster'

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false, addEventListener() {}, removeEventListener() {},
  })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const agent: RosterAgent = {
  id: 'profile:fake', name: 'Fake Hermes', summary: '', status: 'running',
  createdAt: '2026-10-06', region: 'local', model: 'fake-model',
}

describe('selected agent card', () => {
  it('uses a stable palette color and ignores invalid CSS colors', () => {
    const accented = { ...agent, ui_meta: { display_name: agent.name, accent_color: '#aabbcc' } }
    const invalid = { ...agent, ui_meta: { display_name: agent.name, accent_color: 'url(https://fake.invalid)' } }
    expect(agentColor(agent)).toBe(mascotColor(agent, agent.id))
    expect(agentColor(accented)).toBe('#aabbcc')
    expect(agentColor(invalid)).toBe(mascotColor(agent, agent.id))
  })
  it.each([
    ['idle', 'Idle'], ['thinking', 'Thinking'], ['tool', 'Using a tool'],
    ['browsing', 'Browsing'], ['waiting-approval', 'Waiting for approval'],
  ] as [AgentPresence, string][])('displays %s presence, model and info action', (presence, text) => {
    const onOpenInfo = vi.fn()
    render(<AgentCard agent={agent} presence={presence} onOpenInfo={onOpenInfo} />)
    expect(screen.getByText(text)).toBeTruthy()
    expect(screen.getByText('fake-model')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'About Fake Hermes' }))
    expect(onOpenInfo).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open agent info' }))
    expect(onOpenInfo).toHaveBeenCalledOnce()
  })
  it('uses a local ui_meta avatar and falls back to the orb on load failure', () => {
    const view = render(<AgentAvatar agent={{ ...agent, ui_meta: { avatar: '/fake-avatar.png' } }} />)
    const image = view.container.querySelector('img')!
    expect(image.getAttribute('src')).toBe('hd-avatar://fake/')
    fireEvent.error(image)
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.querySelector('svg')).not.toBeNull()
  })
  it('does not load hosted image URLs', () => {
    const view = render(<AgentAvatar agent={{ ...agent, ui_meta: { avatar: 'https://fake.invalid/avatar.png' } }} />)
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.querySelector('svg')).not.toBeNull()
  })
  it('retries a changed local avatar after a previous source fails', () => {
    const view = render(<AgentAvatar agent={{ ...agent, ui_meta: { avatar: '/fake-one.png' } }} />)
    fireEvent.error(view.container.querySelector('img')!)
    view.rerender(<AgentAvatar agent={{ ...agent, ui_meta: { avatar: '/fake-two.png' } }} />)
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('hd-avatar://fake/')
  })
  it('reloads a changed avatar without sending its file path to the protocol', () => {
    const view = render(<AgentAvatar agent={{ ...agent, ui_meta: { avatar: 'one.png' } }} />)
    const image = view.container.querySelector('img')
    view.rerender(<AgentAvatar agent={{ ...agent, ui_meta: { avatar: 'two.png' } }} />)
    expect(view.container.querySelector('img')).not.toBe(image)
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('hd-avatar://fake/')
  })
  it('keeps the compact card centered and opens agent info without squeezing an inline disclosure into the rail', () => {
    const onOpenInfo = vi.fn()
    render(<AgentCard agent={agent} presence="idle" compact onOpenInfo={onOpenInfo} />)
    const button = screen.getByRole('button', { name: 'About Fake Hermes' })
    expect(button.style.justifyContent).toBe('center')
    expect(button.style.width).toBe('100%')
    expect(button.style.padding).toBe('8px 0px')
    expect(button.querySelector('.hd-agent-avatar')?.getAttribute('style')).toContain('width: 36px')
    expect(button.hasAttribute('aria-expanded')).toBe(false)
    fireEvent.click(button)
    expect(onOpenInfo).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Open agent info' })).toBeNull()
  })
})
