import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleShellShortcut, installShellShortcuts } from './shortcuts'

afterEach(() => document.body.replaceChildren())

function actions() {
  return { selectAgent: vi.fn(), openTab: vi.fn(), stopAll: vi.fn() }
}

describe('Hermes Desk keyboard map', () => {
  it.each([1, 2, 9])('selects agent %i', (number) => {
    const callbacks = actions()
    const event = new KeyboardEvent('keydown', { key: String(number), metaKey: true, cancelable: true })
    expect(handleShellShortcut(event, callbacks)).toBe(true)
    expect(callbacks.selectAgent).toHaveBeenCalledWith(number - 1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('opens user and selected-agent tabs and interrupts all lanes', () => {
    const callbacks = actions()
    handleShellShortcut(new KeyboardEvent('keydown', { key: 't', metaKey: true }), callbacks)
    handleShellShortcut(new KeyboardEvent('keydown', { key: 'T', metaKey: true, shiftKey: true }), callbacks)
    handleShellShortcut(new KeyboardEvent('keydown', { key: '.', metaKey: true }), callbacks)
    expect(callbacks.openTab.mock.calls).toEqual([['user'], ['agent']])
    expect(callbacks.stopAll).toHaveBeenCalledOnce()
  })

  it.each(['input', 'textarea', 'select', 'div'])('respects %s text entry, but keeps stop and tabs available', (tag) => {
    const callbacks = actions()
    const off = installShellShortcuts(callbacks)
    const field = document.createElement(tag)
    if (tag === 'div') field.setAttribute('contenteditable', 'true')
    document.body.append(field)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true }))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true }))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true }))
    expect(callbacks.selectAgent).not.toHaveBeenCalled()
    expect(callbacks.stopAll).toHaveBeenCalledOnce()
    expect(callbacks.openTab).toHaveBeenCalledWith('user')
    off()
    field.dispatchEvent(new KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true }))
    expect(callbacks.stopAll).toHaveBeenCalledOnce()
  })

  it('ignores plain, composing, repeated, alt-modified and already consumed keys', () => {
    const callbacks = actions()
    for (const options of [{}, { metaKey: true, isComposing: true }, { metaKey: true, repeat: true }, { metaKey: true, altKey: true }]) {
      expect(handleShellShortcut(new KeyboardEvent('keydown', { key: '1', ...options }), callbacks)).toBe(false)
    }
    const consumed = new KeyboardEvent('keydown', { key: '1', metaKey: true, cancelable: true })
    consumed.preventDefault()
    expect(handleShellShortcut(consumed, callbacks)).toBe(false)
    expect(callbacks.selectAgent).not.toHaveBeenCalled()
  })
})
