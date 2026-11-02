import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PrivacySafetyPane } from '../PrivacySafetyPane'
import { installTestHost, testConfig } from '../settings/local/test-fixtures'

afterEach(() => { cleanup(); delete window.nubAgent })
describe('profile-scoped approvals', () => {
  it('reads and writes the selected profile instead of the default profile', async () => {
    const { host } = installTestHost()
    render(<PrivacySafetyPane active profile="spike-alpha" />)
    const smart = screen.getByRole('button', { name: 'Smart' })
    await waitFor(() => expect(smart.getAttribute('aria-pressed')).toBe('true'))
    fireEvent.click(screen.getByRole('button', { name: 'Ask first' }))
    await screen.findByText('Saved on local Hermes. No restart needed.')
    expect(host.setConfig).toHaveBeenCalledWith({ agent: { profile: 'spike-alpha', approvalMode: 'manual' } })
  })
  it('never selects or allows changes to an unknown approval mode', async () => {
    const { host } = installTestHost()
    const config = testConfig()
    config.profiles[0].approvalMode = null
    host.getConfig.mockResolvedValue(config)
    render(<PrivacySafetyPane active />)
    await screen.findByText(/Approval mode unavailable/)
    for (const name of ['Ask first', 'Smart', 'Always allow']) {
      const button = screen.getByRole('button', { name })
      expect(button.getAttribute('aria-pressed')).toBe('false')
      expect(button).toHaveProperty('disabled', true)
    }
    expect(host.setConfig).not.toHaveBeenCalled()
  })
})
