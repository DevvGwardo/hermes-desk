import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SettingsStub } from '../SettingsStub'
import { installTestHost } from '../settings/local/test-fixtures'
import { getApprovalMode, setApprovalMode } from '../../lib/agents/tool-permission'

beforeEach(() => { window.localStorage.clear(); setApprovalMode('ask'); Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); delete window.nubAgent; vi.unstubAllGlobals() })

describe('local settings safety', () => {
  it('applies approvals live only through local host config, with no VM restart fallback', async () => {
    const { host, forbidden } = installTestHost()
    render(<SettingsStub open onClose={() => {}} initialPane="agents" />)
    const allow = await screen.findByRole('button', { name: 'Always allow' })
    await waitFor(() => expect(allow).toHaveProperty('disabled', false))
    fireEvent.click(allow)
    await screen.findByText('Saved on local Hermes. No restart needed.')
    expect(host.setConfig).toHaveBeenCalledWith({ agent: { profile: 'default', approvalMode: 'off' } })
    expect(getApprovalMode()).toBe('yolo')
    expect(host.restartServe).not.toHaveBeenCalled()
    expect(forbidden).not.toHaveBeenCalled()
  })
  it('leaves approval mode unchanged on a failed local write instead of invoking a platform API', async () => {
    const { host, forbidden } = installTestHost()
    host.setConfig.mockRejectedValue(new Error('Local serve unavailable'))
    render(<SettingsStub open onClose={() => {}} initialPane="agents" />)
    const smart = await screen.findByRole('button', { name: 'Smart' })
    await waitFor(() => expect(smart).toHaveProperty('disabled', false))
    fireEvent.click(smart)
    await screen.findByText('Local serve unavailable')
    expect(getApprovalMode()).toBe('ask')
    expect(forbidden).not.toHaveBeenCalled()
  })
  it('shows exactly six local sections and no billed ledger, accounts, messaging, or telemetry controls', async () => {
    const { forbidden } = installTestHost()
    const fetch = vi.fn(() => Promise.reject(new Error('Network forbidden')))
    vi.stubGlobal('fetch', fetch)
    render(<SettingsStub open onClose={() => {}} />)
    const names = ['General', 'Agents', 'Workspace', 'Privacy & permissions', 'Appearance', 'Advanced']
    expect(within(screen.getByRole('navigation', { name: 'Settings sections' })).getAllByRole('button')).toHaveLength(6)
    for (const name of names) expect(screen.getByRole('button', { name })).toBeTruthy()
    for (const gone of ['Account', 'Billing', 'Keys', 'Plan & usage', 'Chat apps', 'Usage']) expect(screen.queryByRole('button', { name: gone })).toBeNull()
    for (const name of names) fireEvent.click(screen.getByRole('button', { name }))
    await waitFor(() => expect(forbidden).not.toHaveBeenCalled())
    expect(fetch).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toMatch(/Share usage analytics|Help improve the model|billed/i)
  })
})
