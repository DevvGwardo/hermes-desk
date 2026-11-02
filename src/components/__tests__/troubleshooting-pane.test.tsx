import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TroubleshootingPane } from '../TroubleshootingPane'
import { installTestHost } from '../settings/local/test-fixtures'

afterEach(() => { cleanup(); delete window.nubAgent })
describe('local help', () => {
  it('uses diagnostics instead of uploading a problem report', async () => {
    const { host, forbidden } = installTestHost()
    render(<TroubleshootingPane />)
    await screen.findByText(/Gateway: up/)
    expect(host.status).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Send report' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy debug bundle' })).toBeTruthy()
    expect(forbidden).not.toHaveBeenCalled()
  })
})
