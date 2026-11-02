import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Sidebar } from '../Sidebar'

const css = readFileSync(resolve(__dirname, '../../styles/sidebar-controls.css'), 'utf8')
const shellCss = readFileSync(resolve(__dirname, '../../styles/shell-layout.css'), 'utf8')
let style: HTMLStyleElement
beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false, addEventListener() {}, removeEventListener() {},
  })))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  style = document.createElement('style')
  style.textContent = css + shellCss
  document.head.append(style)
})
afterEach(() => {
  cleanup()
  style.remove()
  vi.unstubAllGlobals()
})

function show(extra: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const handlers = {
    onNewConversation: vi.fn(), onOpenSearch: vi.fn(),
    onOpenHome: vi.fn(), onOpenChats: vi.fn(), onOpenRoutines: vi.fn(),
  }
  const view = render(<Sidebar agents={[]} groups={[]} conversations={[]} selectedConversationId={null}
    onSelectConversation={vi.fn()} onOpenTarget={vi.fn()} onOpenSettings={vi.fn()}
    {...handlers} {...extra} />)
  return { ...view, ...handlers }
}

describe('simplified sidebar controls', () => {
  it.each([240, 180])('offers one direct creation action without a dropdown at width %s', width => {
    window.localStorage.setItem('maia:sidebarWidth', String(width))
    const handlers = show()
    const chat = screen.getByRole('button', { name: 'New chat' })
    expect(chat.closest('.hd-primary-actions')?.querySelectorAll('button')).toHaveLength(1)
    expect(chat.hasAttribute('aria-haspopup')).toBe(false)
    expect(screen.queryByRole('button', { name: 'More creation options' })).toBeNull()
    expect(screen.queryByText('New shared room')).toBeNull()
    fireEvent.click(chat)
    expect(handlers.onNewConversation).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it.each(['messenger', 'classic'] as const)('consolidates labeled destinations into one row and preserves callbacks in %s', skin => {
    const handlers = show({ skin, destination: 'chats' })
    const nav = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(getComputedStyle(nav).flexDirection).toBe('row')
    expect(nav.closest('.hd-sidebar-top')?.querySelector('.hd-primary-actions')).not.toBeNull()
    for (const [name, callback] of [
      ['Home', handlers.onOpenHome], ['Chats', handlers.onOpenChats], ['Routines', handlers.onOpenRoutines],
    ] as const) {
      const row = within(nav).getByRole('button', { name })
      expect(row.getAttribute('aria-current')).toBe(name === 'Chats' ? 'page' : null)
      expect(row.querySelector('svg')?.getAttribute('width')).toBe('18')
      expect(getComputedStyle(row).minHeight).toBe('44px')
      expect(getComputedStyle(row).flexDirection).toBe('column')
      expect(row.querySelector('span')?.textContent).toBe(name)
      fireEvent.click(row)
      expect(callback).toHaveBeenCalledOnce()
    }
  })

  it.each([196, 240, 480])('keeps the expanded header and destination strip dense at width %s', width => {
    window.localStorage.setItem('maia:sidebarWidth', String(width))
    show()
    const sidebar = screen.getByRole('complementary')
    const top = sidebar.querySelector('.hd-sidebar-top')!
    expect(getComputedStyle(top).flexShrink).toBe('0')
    expect(getComputedStyle(top.querySelector('header')!).height).toBe('32px')
    expect(getComputedStyle(screen.getByRole('button', { name: 'New chat' })).minHeight).toBe('36px')
    expect(getComputedStyle(screen.getByRole('navigation', { name: 'Main navigation' })).flexDirection).toBe('row')
    expect(sidebar.getAttribute('data-compact')).toBe('false')
  })

  it('places Search in the header with a portalled keyboard tooltip', () => {
    const handlers = show()
    const search = screen.getByRole('button', { name: 'Search' })
    expect(search.closest('header')?.textContent).toBe('Hermes Desk')
    act(() => search.focus())
    expect(screen.getByRole('tooltip').textContent).toBe('Search⌘K')
    expect(screen.getByRole('complementary').contains(screen.getByRole('tooltip'))).toBe(false)
    fireEvent.click(search)
    expect(handlers.onOpenSearch).toHaveBeenCalledOnce()
  })

  it('disables Search when no handler is available and omits unavailable destinations', () => {
    show({ onOpenSearch: undefined, onOpenHome: undefined, onOpenRoutines: undefined })
    expect((screen.getByRole('button', { name: 'Search' }) as HTMLButtonElement).disabled).toBe(true)
    const nav = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(within(nav).getAllByRole('button').map(button => button.textContent)).toEqual(['Chats'])
  })

  it.each(['messenger', 'classic'] as const)('centers compact creation and navigation controls in %s', skin => {
    window.localStorage.setItem('maia:sidebarWidth', '180')
    show({ skin, destination: 'home' })
    const navStyle = getComputedStyle(screen.getByRole('navigation', { name: 'Main navigation' }))
    expect(navStyle.flexDirection).toBe('column')
    expect(navStyle.padding).toBe('0px')
    for (const name of ['New chat', 'Home', 'Chats', 'Routines']) {
      const button = screen.getByRole('button', { name })
      expect(getComputedStyle(button).justifyContent).toBe('center')
    }
    expect(screen.getByRole('button', { name: 'New chat' }).textContent).toBe('')
    expect(getComputedStyle(screen.getByRole('button', { name: 'New chat' })).borderRadius).toBe('var(--desk-radius-sm)')
    expect(screen.getByRole('button', { name: 'Home' }).textContent).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(screen.getByRole('button', { name: 'New chat' }).textContent).toBe('New chat')
    expect(screen.getByRole('button', { name: 'Home' }).textContent).toBe('Home')
  })

  it('retains a portalled, keyboard-accessible label for compact New chat', () => {
    window.localStorage.setItem('maia:sidebarWidth', '180')
    show()
    act(() => screen.getByRole('button', { name: 'New chat' }).focus())
    expect(screen.getByRole('tooltip').textContent).toBe('New chat')
    expect(screen.getByRole('complementary').contains(screen.getByRole('tooltip'))).toBe(false)
  })
})
