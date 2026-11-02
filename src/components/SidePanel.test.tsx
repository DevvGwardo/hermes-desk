import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SidePanel } from './SidePanel'
import { ShellLayoutContext } from '../lib/use-shell-layout'

beforeEach(() => window.localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Workspace SidePanel', () => {
  it('uses the actual navigation budget, and keeps the preferred width when constrained', () => {
    window.localStorage.setItem('nub:side-panel-width:info', '710')
    const view = render(<ShellLayoutContext.Provider value={{ contentWidth: 1440, navigationWidth: 240, textScale: 1 }}>
      <SidePanel id="info" title="Info" onClose={vi.fn()}><div /></SidePanel>
    </ShellLayoutContext.Provider>)
    expect(screen.getByLabelText('Info').getAttribute('data-presentation')).toBe('docked')
    view.rerender(<ShellLayoutContext.Provider value={{ contentWidth: 1024, navigationWidth: 300, textScale: 1 }}>
      <SidePanel id="info" title="Info" onClose={vi.fn()}><div /></SidePanel>
    </ShellLayoutContext.Provider>)
    expect(screen.getByLabelText('Info').getAttribute('data-presentation')).toBe('main')
    expect(window.localStorage.getItem('nub:side-panel-width:info')).toBe('710')
  })
  it('reuses the persisted width without adding a second workspace header or scroller', () => {
    window.localStorage.setItem('nub:side-panel-width:workspace', '710')
    render(<SidePanel id="workspace" title="Workspace" chrome={false} scroll={false} onClose={vi.fn()}><div>Native viewport</div></SidePanel>)
    const aside = screen.getByLabelText('Workspace')
    expect(aside.style.getPropertyValue('--side-panel-w')).toBe(`${Math.min(710, window.innerWidth * 0.7)}px`)
    expect(aside.querySelector('header')).toBeNull()
    expect(screen.getByText('Native viewport').parentElement?.className).toContain('overflow-hidden')
  })
  it('cleans up a resize on unmount and persists only the bounded width', () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const view = render(<SidePanel id="workspace" title="Workspace" onClose={vi.fn()}><div /></SidePanel>)
    fireEvent.pointerDown(screen.getByRole('separator'), { button: 0, clientX: 500 })
    fireEvent.pointerMove(window, { clientX: 980 })
    expect(document.body.style.cursor).toBe('col-resize')
    view.unmount()
    expect(document.body.style.cursor).toBe('')
    expect(Number(window.localStorage.getItem('nub:side-panel-width:workspace'))).toBe(300)
    vi.unstubAllGlobals()
  })
  it('resizes with the keyboard, reports its size, and restores the preferred default', () => {
    const changed = vi.fn()
    render(<SidePanel id="workspace" title="Workspace" defaultWidth={400} onClose={vi.fn()} onWidthChange={changed}><div /></SidePanel>)
    const separator = screen.getByRole('separator')
    expect(separator.tabIndex).toBe(0)
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(separator.getAttribute('aria-valuenow')).toBe('416')
    expect(window.localStorage.getItem('nub:side-panel-width:workspace')).toBe('416')
    fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true })
    expect(separator.getAttribute('aria-valuenow')).toBe('384')
    fireEvent.doubleClick(separator)
    expect(changed).toHaveBeenLastCalledWith(400)
    expect(separator.getAttribute('aria-valuetext')).toBe('400 pixels wide')
  })
})
