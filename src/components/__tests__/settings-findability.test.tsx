import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { SettingsStub } from '../SettingsStub'
import { SETTINGS_INDEX, SETTINGS_SECTIONS, searchSettings } from '../../lib/settings-index'
import { installTestHost } from '../settings/local/test-fixtures'
import { getHomeOnLaunch } from '../../lib/home-prefs'
import type { SettingsPaneRequest } from '../../lib/open-settings'

afterEach(() => { cleanup(); delete window.nubAgent; window.localStorage.clear() })
describe('local settings findability', () => {
  it('starts with everyday preferences and preserves Home without introducing artwork controls', () => {
    installTestHost()
    render(<SettingsStub open onClose={() => {}} />)
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('switch', { name: 'Show Home on launch' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('spinbutton', { name: 'Serve port' })).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'Show Home on launch' }))
    expect(getHomeOnLaunch()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    expect(screen.queryByRole('switch', { name: 'Show Home artwork' })).toBeNull()
  })
  it('indexes real local sections and unique setting ids', () => {
    expect(new Set(SETTINGS_INDEX.map((entry) => entry.id)).size).toBe(SETTINGS_INDEX.length)
    for (const entry of SETTINGS_INDEX) expect(SETTINGS_SECTIONS.some((section) => section.id === entry.section)).toBe(true)
    expect(searchSettings('my audit log')[0].id).toBe('audit')
    expect(searchSettings('restore hidden')[0].id).toBe('agent-order')
    expect(searchSettings('genui')[0]?.id).toBe('controller')
    expect(searchSettings('generated ui')[0]?.id).toBe('controller')
    expect(searchSettings('render_ui')[0]?.id).toBe('controller')
    expect(searchSettings('billing')).toEqual([])
  })
  it('searches across sections and opens the matching setting', () => {
    installTestHost()
    Element.prototype.scrollIntoView = vi.fn()
    render(<SettingsStub open onClose={() => {}} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search settings' }), { target: { value: 'audit log' } })
    fireEvent.click(screen.getByRole('button', { name: /Audit log/ }))
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-current')).toBe('page')
    expect(document.querySelector('[data-setting="audit"]')).toBeTruthy()
  })
  it('finds the opt-in crash capture without enabling it as a side effect', () => {
    installTestHost()
    render(<SettingsStub open onClose={() => {}} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search settings' }), { target: { value: 'crash capture' } })
    fireEvent.click(screen.getByRole('button', { name: /Render troubleshooting/ }))
    expect(document.querySelector('[data-setting="render-capture"]')?.closest('details')?.open).toBe(true)
    expect(screen.getByRole('button', { name: 'Start render capture' }).hasAttribute('disabled')).toBe(false)
  })
  it('keeps search targets expanded when App echoes the selected section into the route', async () => {
    installTestHost()
    function RoutedSettings() {
      const [pane, setPane] = useState<SettingsPaneRequest | null>('general')
      return <SettingsStub open initialPane={pane ?? undefined} onPaneChange={setPane} onClose={() => {}} />
    }
    render(<RoutedSettings />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search settings' }), { target: { value: 'audit log' } })
    fireEvent.click(screen.getByRole('button', { name: /Audit log/ }))
    await waitFor(() => expect(document.querySelector('[data-setting="audit"]')?.closest('details')?.open).toBe(true))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search settings' }), { target: { value: 'serve port' } })
    fireEvent.click(screen.getByRole('button', { name: /Hermes serve/ }))
    expect(screen.getByRole('spinbutton', { name: 'Serve port' }).closest('details')?.open).toBe(true)
  })
  it('lets Escape clear a search without closing, then closes on Escape', () => {
    installTestHost()
    const onClose = vi.fn()
    render(<SettingsStub open onClose={onClose} />)
    const input = screen.getByRole('textbox', { name: 'Search settings' })
    fireEvent.change(input, { target: { value: 'no-such-setting' } })
    expect(screen.getByText(/No settings match/)).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveProperty('value', '')
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('moves through the six sections with arrow keys', () => {
    installTestHost()
    render(<SettingsStub open onClose={() => {}} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'General' }), { key: 'ArrowUp' })
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-current')).toBe('page')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Advanced' }))
  })
})
