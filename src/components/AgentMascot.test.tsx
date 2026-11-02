import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { AgentMascot, agentColor, type AgentMascotPresence } from './AgentMascot'
import * as engine from '../lib/mascot/engine'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('AgentMascot', () => {
  it.each([
    ['idle', 'idle'], ['thinking', 'thinking'], ['tool', 'tool'], ['browsing', 'browsing'],
    ['waiting-approval', 'waiting'], ['talking', 'talking'], ['happy', 'happy'],
    ['error', 'error'], ['sleep', 'sleep'], ['offline', 'sleep'],
  ] as Array<[AgentMascotPresence, string]>)('maps %s to the owl %s state', async (presence, state) => {
    const view = render(<AgentMascot agentId="runner" presence={presence} />)
    await waitFor(() => expect(view.container.querySelector('svg')!.dataset.mascotState).toBe(state))
    const svg = view.container.querySelector('svg')!
    expect(svg.dataset.mascotState).toBe(state)
    expect(view.container.querySelector('[data-character]')!.getAttribute('data-character')).toBe('owl')
    expect(svg.dataset.mascotProfile).toBe('small')
    expect(svg.style.getPropertyValue('--m-primary')).toBe(agentColor('runner'))
    expect((svg.parentElement as HTMLElement).style.opacity).toBe(presence === 'offline' ? '0.45' : '')
  })

  it('has an isolated, colour-consistent SSR fallback and optional accessible title', () => {
    const profile = { id: 'runner', ui_meta: { accent_color: '#abcdef' } }
    const html = renderToString(<AgentMascot agentId="other" profile={profile} presence="thinking" title="Runner" />)
    expect(html).toContain('aria-label="Runner"')
    expect(html).toContain('--m-primary:#abcdef')
    expect(html).toContain('data-character="owl"')
    expect(html).not.toContain('undefined')
  })

  it('updates the existing engine and uses the same colour as the exported helper', () => {
    const profile = { id: 'profile:runner', ui_meta: { accent_color: '#123456' } }
    const view = render(<AgentMascot agentId="runner" profile={profile} />)
    const svg = view.container.querySelector('svg')!
    view.rerender(<AgentMascot agentId="runner" profile={{ ...profile }} presence="tool" size={84} className="pip" />)
    expect(view.container.querySelector('svg')).toBe(svg)
    expect(svg.style.getPropertyValue('--m-primary')).toBe(agentColor(profile))
    expect(svg.dataset.mascotState).toBe('tool')
    expect(svg.style.width).toBe('84px')
    expect(svg.parentElement!.className).toBe('pip')
  })

  it('delegates OS reduced-motion and respects live preference changes', () => {
    let change: (() => void) | undefined
    const query = { matches: true, addEventListener: vi.fn((_name, cb) => { change = cb }), removeEventListener: vi.fn() }
    vi.stubGlobal('matchMedia', vi.fn(() => query))
    const view = render(<AgentMascot agentId="runner" size={84} lookAtCursor reaction="approval" />)
    const svg = view.container.querySelector('svg')!
    expect(svg.dataset.mascotProfile).toBe('reduced')
    query.matches = false
    change!()
    expect(svg.dataset.mascotProfile).toBe('full')
    view.unmount()
    expect(query.removeEventListener).toHaveBeenCalled()
  })

  it('fires reactions once per change, never again on a presence change, and cleans up', () => {
    const original = engine.createMascot
    const react = vi.fn()
    const destroy = vi.fn()
    vi.spyOn(engine, 'createMascot').mockImplementation((el, options) => {
      const handle = original(el, options)
      return { ...handle, react, destroy: () => { destroy(); handle.destroy() } }
    })
    const view = render(<AgentMascot agentId="runner" reaction="message" size={84} />)
    expect(react).toHaveBeenCalledExactlyOnceWith('message')
    view.rerender(<AgentMascot agentId="runner" reaction="message" presence="talking" size={84} />)
    expect(react).toHaveBeenCalledTimes(1)
    view.rerender(<AgentMascot agentId="runner" reaction={null} size={84} />)
    view.rerender(<AgentMascot agentId="runner" reaction="message" size={84} />)
    expect(react).toHaveBeenCalledTimes(2)
    view.rerender(<AgentMascot agentId="runner" reaction="approval" presence="offline" size={84} />)
    expect(react).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
