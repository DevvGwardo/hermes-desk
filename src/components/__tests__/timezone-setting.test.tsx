import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TimezoneSetting } from '../TimezoneSetting'
import { installTestHost } from '../settings/local/test-fixtures'

afterEach(() => { cleanup(); delete window.nubAgent })
describe('local routine timezone', () => {
  it('reads and writes only the selected profile through host config', async () => {
    const { host, forbidden } = installTestHost()
    render(<TimezoneSetting active profile="spike-alpha" />)
    await screen.findByText(/America\/Chicago/)
    expect(host.getConfig).toHaveBeenCalled()
    expect(host.setConfig).not.toHaveBeenCalled()
    expect(forbidden).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Routine time zone'), { target: { value: ' Europe/London ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save time zone' }))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Saved Europe/London for spike-alpha. New sessions pick up the change.')
    expect(host.setConfig).toHaveBeenCalledExactlyOnceWith({ agent: { profile: 'spike-alpha', timezone: 'Europe/London' } })
    expect(forbidden).not.toHaveBeenCalled()
  })
  it('rejects invalid zones before requesting a native write and preserves a cancelled draft', async () => {
    const { host } = installTestHost()
    render(<TimezoneSetting active profile="spike-alpha" />)
    await screen.findByText(/America\/Chicago/)
    fireEvent.change(screen.getByLabelText('Routine time zone'), { target: { value: 'Invalid/Zone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save time zone' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Use an IANA time zone, for example Europe/London.')
    expect(host.setConfig).not.toHaveBeenCalled()
    host.setConfig.mockRejectedValueOnce(new Error('Cancelled. No profile config changed.'))
    fireEvent.change(screen.getByLabelText('Routine time zone'), { target: { value: 'Asia/Tokyo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save time zone' }))
    await screen.findByText(/Cancelled/)
    expect(screen.getByLabelText('Routine time zone')).toHaveProperty('value', 'Asia/Tokyo')
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('fences duplicate submissions and delayed saves across profile switches', async () => {
    const { host } = installTestHost()
    let finish!: () => void
    host.setConfig.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ profiles: [] } as unknown as Awaited<ReturnType<typeof host.getConfig>>)
    }))
    const view = render(<TimezoneSetting active profile="spike-alpha" />)
    await screen.findByText(/America\/Chicago/)
    const save = screen.getByRole('button', { name: 'Save time zone' })
    act(() => { fireEvent.click(save); fireEvent.click(save) })
    expect(host.setConfig).toHaveBeenCalledOnce()
    view.rerender(<TimezoneSetting active profile="default" />)
    await waitFor(() => expect(screen.getByLabelText('Routine time zone')).toHaveProperty('value', 'UTC'))
    await act(async () => finish())
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByLabelText('Routine time zone')).toHaveProperty('value', 'UTC')
  })
  it('never offers a device-only save when the host bridge is absent', () => {
    delete window.nubAgent
    render(<TimezoneSetting active />)
    expect((screen.getByRole('button', { name: 'Save time zone' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
