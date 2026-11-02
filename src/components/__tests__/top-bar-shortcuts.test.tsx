import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TopBar } from '../TopBar'

vi.mock('../NotificationsBell', () => ({ NotificationsBell: () => null }))
vi.mock('../HudOrbButton', () => ({ HudOrbButton: () => null }))

afterEach(() => cleanup())

describe('TopBar shortcuts', () => {
  it.each(['messenger', 'classic'] as const)('keeps the workspace toggle available in the %s skin', (skin) => {
    const toggle = vi.fn()
    render(<TopBar agent={null} showInfo={false} onToggleInfo={vi.fn()} skin={skin}
      workspaceOpen onToggleWorkspace={toggle} />)
    const button = screen.getByLabelText('Toggle workspace')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(toggle).toHaveBeenCalledOnce()
  })

  it('suspends history shortcuts while its chat is inactive', () => {
    const back = vi.fn()
    const forward = vi.fn()
    window.addEventListener('maia:go-back', back)
    window.addEventListener('maia:go-forward', forward)
    try {
      const props = { agent: null, showInfo: false, onToggleInfo: vi.fn() }
      const { rerender } = render(<TopBar {...props} active={false} />)
      fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true })
      fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })
      expect(back).not.toHaveBeenCalled()
      expect(forward).not.toHaveBeenCalled()
      rerender(<TopBar {...props} active />)
      fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true })
      fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })
      expect(back).toHaveBeenCalledOnce()
      expect(forward).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('maia:go-back', back)
      window.removeEventListener('maia:go-forward', forward)
    }
  })
})

describe('TopBar stacking', () => {
  it('sits above the chat, so what drops below it (the notifications list) is seen', () => {
    // The glass blur makes the header its own stacking context; without a
    // positioned z-index the chat painted after it covered the open list.
    const { container } = render(<TopBar agent={null} showInfo={false} onToggleInfo={vi.fn()} active />)
    const header = container.querySelector('header')!
    expect(header.className).toMatch(/\brelative\b/)
    expect(header.className).toMatch(/\bz-(\d+|\[\d+\])/)
  })
})
