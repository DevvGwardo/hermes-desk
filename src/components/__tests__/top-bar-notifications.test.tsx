import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TopBar } from '../TopBar'

vi.mock('../HudOrbButton', () => ({ HudOrbButton: () => null }))

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

function header(skin: 'messenger' | 'classic') {
  render(<TopBar agent={null} showInfo={false} onToggleInfo={vi.fn()} skin={skin} />)
  const more = screen.getByRole('button', { name: 'More chat actions' })
  fireEvent.click(more)
  const menu = screen.getByRole('dialog', { name: 'More chat actions' })
  const bell = screen.getByRole('button', { name: 'Notifications' })
  return { more, menu, bell }
}

describe('TopBar nested notification dismissal', () => {
  it.each([
    ['messenger', 'bell'], ['messenger', 'filter'],
    ['classic', 'bell'], ['classic', 'filter'],
  ] as const)('closes only Notifications before its parent menu in %s from the %s', (skin, target) => {
    const { more, menu, bell } = header(skin)
    const escaped = vi.fn()
    window.addEventListener('keydown', escaped)
    try {
      fireEvent.click(bell)
      const origin = target === 'bell' ? bell : screen.getByTestId('notifications-filter-all')
      origin.focus()
      fireEvent.keyDown(origin, { key: 'Escape' })
      expect(screen.queryByTestId('notifications-popover')).toBeNull()
      expect(menu).toBeInTheDocument()
      expect(more).toHaveAttribute('aria-expanded', 'true')
      expect(bell).toHaveFocus()
      expect(escaped).not.toHaveBeenCalled()

      fireEvent.keyDown(bell, { key: 'Escape' })
      expect(menu).not.toBeInTheDocument()
      expect(more).toHaveAttribute('aria-expanded', 'false')
      expect(more).toHaveFocus()
      expect(escaped).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', escaped)
    }
  })

  it.each(['messenger', 'classic'] as const)('focuses the plain menu and closes it on the first Escape in %s', skin => {
    const { more, menu } = header(skin)
    const origin = screen.getByRole('button', { name: 'Go back' })
    expect(origin).toHaveFocus()
    fireEvent.keyDown(origin, { key: 'Escape' })
    expect(menu).not.toBeInTheDocument()
    expect(more).toHaveFocus()
  })

  it.each(['messenger', 'classic'] as const)('retains document-level notification dismissal in %s', skin => {
    const { menu, bell } = header(skin)
    fireEvent.click(bell)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('notifications-popover')).toBeNull()
    expect(menu).toBeInTheDocument()
    expect(bell).toHaveFocus()
  })
})
