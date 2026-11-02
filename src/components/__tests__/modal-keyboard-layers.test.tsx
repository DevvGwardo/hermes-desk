import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AppModal } from '../AppModal'
import { CommandPalette } from '../CommandPalette'
import { SettingsStub } from '../SettingsStub'
import { installTestHost } from '../settings/local/test-fixtures'

const inertDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'inert')
beforeEach(() => {
  // JSDOM does not reflect inert; Chromium does, including inherited branches.
  if (!inertDescriptor) Object.defineProperty(HTMLElement.prototype, 'inert', {
    configurable: true,
    get(this: HTMLElement) { return this.hasAttribute('inert') },
    set(this: HTMLElement, value: boolean) { this.toggleAttribute('inert', value) },
  })
  installTestHost()
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  delete window.nubAgent
  window.localStorage.clear()
  if (!inertDescriptor) Reflect.deleteProperty(HTMLElement.prototype, 'inert')
})

function SettingsSearch() {
  const [settings, setSettings] = useState(false)
  const [search, setSearch] = useState(false)
  return <div onKeyDown={(event) => {
    if (event.defaultPrevented || !event.metaKey) return
    if (event.key === ',') setSettings(true)
    if (event.key === 'k') setSearch(true)
  }}>
    <button>Shell trigger</button>
    <SettingsStub open={settings} onClose={() => setSettings(false)} />
    <CommandPalette open={search} onClose={() => setSearch(false)} commands={[]} agents={[]} onJumpToAgent={() => {}} />
  </div>
}

async function openSettingsSearch() {
  render(<SettingsSearch />)
  const trigger = screen.getByRole('button', { name: 'Shell trigger' })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: ',', metaKey: true })
  const settings = await screen.findByRole('dialog', { name: 'Settings' })
  const field = within(settings).getByRole('textbox', { name: 'Search settings' })
  field.focus()
  fireEvent.change(field, { target: { value: 'privacy' } })
  fireEvent.keyDown(field, { key: 'k', metaKey: true })
  const search = await screen.findByRole('dialog', { name: 'Search' })
  const input = within(search).getByRole('combobox', { name: 'Search' })
  await waitFor(() => expect(document.activeElement).toBe(input))
  return { settings, field, search, input }
}

describe('foreground dialog keyboard ownership', () => {
  it('closes Search alone and preserves the underlying Settings query and focus', async () => {
    const { settings, field, input } = await openSettingsSearch()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(field))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(settings)
    expect(field).toHaveProperty('value', 'privacy')
  })

  it('does not let the background Settings trap steal Tab from the Search input', async () => {
    const { input } = await openSettingsSearch()
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    fireEvent(input, event)
    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(input)
  })

  it.each([false, true])('keeps the Search boundary wrap in its own dialog, Shift=%s', async (shiftKey) => {
    const { search, input } = await openSettingsSearch()
    const last = within(search).getByRole('tab', { name: 'Actions' })
    ;(shiftKey ? input : last).focus()
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey })
    expect(document.activeElement).toBe(shiftKey ? last : input)
  })

  it('closes a newly opened Settings above Search without closing the inert Search', async () => {
    render(<SettingsSearch />)
    const trigger = screen.getByRole('button', { name: 'Shell trigger' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'k', metaKey: true })
    const search = await screen.findByRole('dialog', { name: 'Search' })
    const input = within(search).getByRole('combobox', { name: 'Search' })
    await waitFor(() => expect(document.activeElement).toBe(input))
    fireEvent.keyDown(input, { key: ',', metaKey: true })
    const settings = await screen.findByRole('dialog', { name: 'Settings' })
    const field = within(settings).getByRole('textbox', { name: 'Search settings' })
    field.focus()
    fireEvent.keyDown(field, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull())
    expect(screen.getByRole('dialog', { name: 'Search' })).toBe(search)
    expect(document.activeElement).toBe(input)
  })

  it('closes only the front AppModal, then allows its parent to close', async () => {
    function Peers() {
      const [outer, setOuter] = useState(true)
      const [inner, setInner] = useState(false)
      return <>
        <AppModal open={outer} title="Outer" onClose={() => setOuter(false)}>
          <button onClick={() => setInner(true)}>Open inner</button>
        </AppModal>
        <AppModal open={inner} title="Inner" onClose={() => setInner(false)}><button>Inner control</button></AppModal>
      </>
    }
    render(<Peers />)
    fireEvent.click(screen.getByRole('button', { name: 'Open inner' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Inner control' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Inner' })).toBeNull())
    const outer = screen.getByRole('dialog', { name: 'Outer' })
    fireEvent.keyDown(outer, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Outer' })).toBeNull())
  })

  it.each(['modal', 'search'] as const)('respects an already-consumed Escape in %s', (kind) => {
    const onClose = vi.fn()
    render(kind === 'modal'
      ? <AppModal open title="Single" onClose={onClose}><button>Control</button></AppModal>
      : <CommandPalette open onClose={onClose} commands={[]} agents={[]} onJumpToAgent={() => {}} />)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    event.preventDefault()
    fireEvent(window, event)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('consumes an unhandled Escape when closing a single AppModal', () => {
    const onClose = vi.fn()
    render(<AppModal open title="Single" onClose={onClose}><button>Control</button></AppModal>)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    fireEvent(window, event)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it.each(['modal', 'search'] as const)('owns Escape before an earlier shell fallback in %s', (kind) => {
    const fallback = vi.fn()
    const onShellKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('[data-esc-layer]')) {
        event.preventDefault()
        fallback()
      }
    }
    window.addEventListener('keydown', onShellKey)
    try {
      const onClose = vi.fn()
      render(kind === 'modal'
        ? <AppModal open title="Single" onClose={onClose}><button>Control</button></AppModal>
        : <CommandPalette open onClose={onClose} commands={[]} agents={[]} onJumpToAgent={() => {}} />)
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(fallback).not.toHaveBeenCalled()
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', onShellKey)
    }
  })

  it('keeps Settings search Escape as an inner clear action', async () => {
    render(<SettingsSearch />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Shell trigger' }), { key: ',', metaKey: true })
    const settings = await screen.findByRole('dialog', { name: 'Settings' })
    const field = within(settings).getByRole('textbox', { name: 'Search settings' })
    fireEvent.change(field, { target: { value: 'privacy' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(field).toHaveProperty('value', '')
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(settings)
  })
})
