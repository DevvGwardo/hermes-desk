import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SettingsStub } from '../SettingsStub'
import { installTestHost } from '../settings/local/test-fixtures'

afterEach(() => { cleanup(); delete window.nubAgent })
describe('local settings load errors, no billed usage', () => {
  it('shows host load failure without falling back to a billed ledger', async () => {
    const { host, forbidden } = installTestHost()
    host.getConfig.mockRejectedValue(new Error('Unavailable'))
    render(<SettingsStub open onClose={() => {}} />)
    await screen.findByText('Could not read local settings. Try again.')
    expect(forbidden).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Plan & usage' })).toBeNull()
  })
  it('stays usable when the W2 host config bridge is not merged yet', async () => {
    delete window.nubAgent
    render(<SettingsStub open initialPane="hermes" onClose={() => {}} />)
    await screen.findByText(/Local settings bridge is unavailable/)
    expect(screen.getByRole('button', { name: 'Save serve preferences' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Appearance' })).toBeTruthy()
  })
})
