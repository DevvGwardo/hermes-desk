import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SettingsStub } from '../SettingsStub'
import { installTestHost } from '../settings/local/test-fixtures'

afterEach(() => { cleanup(); delete window.nubAgent })
describe('source-installed local app', () => {
  it('shows local versions but never calls an update server', async () => {
    installTestHost()
    const update = vi.fn()
    render(<SettingsStub open initialPane="hermes" onClose={() => {}} onCheckForUpdates={update} updateChecking />)
    await screen.findByText(/fake-version/)
    expect(screen.queryByRole('button', { name: /Check for updates|Install update/ })).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })
})
