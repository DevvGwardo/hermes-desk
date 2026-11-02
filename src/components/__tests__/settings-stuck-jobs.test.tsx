import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SettingsStub } from '../SettingsStub'
import { installTestHost } from '../settings/local/test-fixtures'

afterEach(() => { cleanup(); delete window.nubAgent })
describe('restart local serve, never VM jobs', () => {
  it('only asks the host to restart/reconnect serve', async () => {
    const { host, forbidden } = installTestHost()
    render(<SettingsStub open initialPane="hermes" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Restart serve' }))
    await screen.findByText('Serve restart/reconnect requested.')
    expect(host.restartServe).toHaveBeenCalledTimes(1)
    expect(forbidden).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Clear stuck|Restart agent computer/ })).toBeNull()
  })
})
