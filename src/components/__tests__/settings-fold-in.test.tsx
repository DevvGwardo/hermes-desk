import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SettingsStub } from '../SettingsStub'
import { installTestHost } from '../settings/local/test-fixtures'

afterEach(() => { cleanup(); delete window.nubAgent })
describe('local settings routing', () => {
  it('reports local section changes to the shell', () => {
    installTestHost()
    const onPaneChange = vi.fn()
    render(<SettingsStub open onClose={() => {}} onPaneChange={onPaneChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    expect(onPaneChange).toHaveBeenCalledWith('workspace')
  })
  it('resolves old local links but never shows platform account/billing panes', () => {
    installTestHost()
    const props = { open: true, onClose: () => {} }
    const { rerender } = render(<SettingsStub {...props} initialPane="capabilities" />)
    expect(screen.getByRole('button', { name: 'Agents' }).getAttribute('aria-current')).toBe('page')
    rerender(<SettingsStub {...props} initialPane="billing" />)
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('button', { name: 'Billing' })).toBeNull()
    rerender(<SettingsStub {...props} initialPane="appearance" />)
    expect(screen.getByRole('button', { name: 'Appearance' }).getAttribute('aria-current')).toBe('page')
  })
})
