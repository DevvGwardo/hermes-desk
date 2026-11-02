import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SettingsStub } from '../SettingsStub'
import { installTestHost } from '../settings/local/test-fixtures'

afterEach(() => { cleanup(); delete window.nubAgent })
describe('settings never fetch secret values', () => {
  it('marks provider and per-origin approval gaps honestly as read-only', () => {
    const { forbidden } = installTestHost()
    render(<SettingsStub open onClose={() => {}} initialPane="secrets" />)
    expect(screen.getByText('Status: unavailable')).toBeTruthy()
    expect(screen.getByText('Origin consent metadata is unavailable.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh 1Password status' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('combobox', { name: 'Default vault' })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: /Copy value|Create secret/ })).toBeNull()
    expect(forbidden).not.toHaveBeenCalled()
  })
})
