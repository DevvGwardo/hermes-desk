import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabSummary } from '../../lib/desktop-bridge'
import { WorkspaceNav } from './WorkspaceNav'

const tab: TabSummary = {
  id: 't_1', laneId: 'profile:scout', title: 'Research',
  url: 'https://research.invalid/', state: 'idle', controller: 'agent',
  createdBy: 'agent', sharedLogin: false, discarded: false, active: true,
  canGoBack: true, canGoForward: false,
}

function setup() {
  const onNavigate = vi.fn()
  const onKeyDown = vi.fn()
  const props = {
    onNavigate, onBack: vi.fn(), onForward: vi.fn(), onReload: vi.fn(),
    onMoveLane: vi.fn(), onGiveToAgent: vi.fn(), onReturnToUser: vi.fn(),
  }
  const view = render(<div onKeyDown={onKeyDown}><WorkspaceNav tab={tab} {...props} /></div>)
  const address = screen.getByRole('textbox', { name: 'Workspace address' }) as HTMLInputElement
  return {
    address, onNavigate, onKeyDown,
    update: (next: TabSummary) => view.rerender(<div onKeyDown={onKeyDown}><WorkspaceNav tab={next} {...props} /></div>),
  }
}

afterEach(cleanup)

describe('WorkspaceNav address drafts', () => {
  it('preserves a typed address while the agent navigates the same tab', () => {
    const { address, update, onNavigate } = setup()
    act(() => address.focus())
    fireEvent.change(address, { target: { value: 'my unfinished search' } })
    update({ ...tab, url: 'https://agent-next.invalid/' })
    expect(address.value).toBe('my unfinished search')
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('keeps an untouched address synchronized, even while focused', () => {
    const { address, update } = setup()
    act(() => address.focus())
    update({ ...tab, url: 'https://agent-next.invalid/' })
    expect(address.value).toBe('https://agent-next.invalid/')
  })

  it('shows the latest actual URL when an unsubmitted draft loses focus', () => {
    const { address, update } = setup()
    act(() => address.focus())
    fireEvent.change(address, { target: { value: 'unfinished search' } })
    update({ ...tab, url: 'https://agent-next.invalid/' })
    act(() => address.blur())
    expect(address.value).toBe('https://agent-next.invalid/')
  })

  it('submits the draft and then tracks the resulting navigation', () => {
    const { address, update, onNavigate } = setup()
    act(() => address.focus())
    fireEvent.change(address, { target: { value: ' my search ' } })
    fireEvent.submit(address.closest('form')!)
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('my search')
    update({ ...tab, url: 'https://search.invalid/results' })
    expect(address.value).toBe('https://search.invalid/results')
  })

  it('resumes synchronization after editing back to the actual URL', () => {
    const { address, update } = setup()
    act(() => address.focus())
    fireEvent.change(address, { target: { value: 'unfinished search' } })
    fireEvent.change(address, { target: { value: tab.url } })
    update({ ...tab, url: 'https://agent-next.invalid/' })
    expect(address.value).toBe('https://agent-next.invalid/')
  })

  it('lets Escape discard a draft without navigating or closing a parent layer', () => {
    const { address, update, onNavigate, onKeyDown } = setup()
    act(() => address.focus())
    fireEvent.change(address, { target: { value: 'unfinished search' } })
    update({ ...tab, url: 'https://agent-next.invalid/' })
    expect(fireEvent.keyDown(address, { key: 'Escape' })).toBe(false)
    expect(address.value).toBe('https://agent-next.invalid/')
    expect(onNavigate).not.toHaveBeenCalled()
    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it('leaves Escape available to the parent when there is no draft', () => {
    const { address, onKeyDown } = setup()
    expect(fireEvent.keyDown(address, { key: 'Escape' })).toBe(true)
    expect(onKeyDown).toHaveBeenCalledOnce()
  })

  it('resets the address when switching tabs, even with an active draft', () => {
    const { address, update } = setup()
    act(() => address.focus())
    fireEvent.change(address, { target: { value: 'unfinished search' } })
    update({ ...tab, id: 't_2', url: 'https://different-tab.invalid/' })
    expect(address.value).toBe('https://different-tab.invalid/')
  })
})

describe('WorkspaceNav address shortcut', () => {
  it.each([{ metaKey: true }, { ctrlKey: true }])('focuses and selects the address for %j', (modifier) => {
    const { address, onNavigate } = setup()
    const trigger = screen.getByRole('button', { name: 'Reload' })
    act(() => trigger.focus())
    expect(fireEvent.keyDown(window, { key: 'l', ...modifier })).toBe(false)
    expect(document.activeElement).toBe(address)
    expect(address.selectionStart).toBe(0)
    expect(address.selectionEnd).toBe(address.value.length)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('selects an existing draft without discarding it', () => {
    const { address } = setup()
    act(() => address.focus())
    fireEvent.change(address, { target: { value: 'unfinished search' } })
    fireEvent.keyDown(window, { key: 'l', metaKey: true })
    expect(address.value).toBe('unfinished search')
    expect(address.selectionStart).toBe(0)
    expect(address.selectionEnd).toBe(address.value.length)
  })

  it('does not steal focus from a modal dialog or an open keyboard layer', () => {
    const { address } = setup()
    const layer = document.createElement('div')
    const control = document.createElement('button')
    layer.append(control)
    document.body.append(layer)
    try {
      for (const modal of [true, false]) {
        layer.removeAttribute('role')
        layer.removeAttribute('aria-modal')
        layer.removeAttribute('data-esc-layer')
        if (modal) { layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-modal', 'true') }
        else layer.setAttribute('data-esc-layer', '')
        act(() => control.focus())
        expect(fireEvent.keyDown(window, { key: 'l', metaKey: true })).toBe(true)
        expect(document.activeElement).toBe(control)
        expect(document.activeElement).not.toBe(address)
      }
    } finally { layer.remove() }
  })

  it('ignores unmodified, alternate, shifted, composing, repeated, and handled keys', () => {
    setup()
    const trigger = screen.getByRole('button', { name: 'Reload' })
    act(() => trigger.focus())
    for (const event of [
      { key: 'l' }, { key: 'x', metaKey: true }, { key: 'l', metaKey: true, altKey: true },
      { key: 'l', metaKey: true, shiftKey: true }, { key: 'l', metaKey: true, isComposing: true },
      { key: 'l', metaKey: true, repeat: true },
    ]) {
      expect(fireEvent.keyDown(window, event)).toBe(true)
      expect(document.activeElement).toBe(trigger)
    }
    const handled = new KeyboardEvent('keydown', { key: 'l', metaKey: true, cancelable: true })
    handled.preventDefault()
    fireEvent(window, handled)
    expect(document.activeElement).toBe(trigger)
  })
})
