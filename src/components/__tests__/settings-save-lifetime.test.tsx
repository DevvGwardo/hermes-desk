import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SettingsStub } from '../SettingsStub'
import { installTestHost, testConfig } from '../settings/local/test-fixtures'

afterEach(() => { cleanup(); delete window.nubAgent; window.localStorage.clear() })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const saveStatus = () => document.querySelector('[data-save-state]')!
const skin = () => screen.getByRole('switch', { name: 'Messenger skin' })
async function ready() {
  await waitFor(() => expect(skin()).toHaveProperty('disabled', false))
}

describe('Settings save ownership and feedback', () => {
  it('announces saving and saved without optimistic state or duplicate writes', async () => {
    const { host } = installTestHost(), pending = deferred<ReturnType<typeof testConfig>>()
    host.setConfig.mockReturnValueOnce(pending.promise)
    render(<SettingsStub open initialPane="appearance" onClose={vi.fn()} />)
    await ready()
    fireEvent.click(skin())
    expect(saveStatus().textContent).toBe('Saving…')
    expect(saveStatus().getAttribute('aria-live')).toBe('polite')
    expect(skin().getAttribute('aria-checked')).toBe('true')
    fireEvent.click(skin())
    expect(host.setConfig).toHaveBeenCalledOnce()
    const saved = testConfig()
    saved.appearance.messengerSkin = false
    await act(async () => pending.resolve(saved))
    expect(saveStatus().textContent).toBe('Saved')
    expect(skin().getAttribute('aria-checked')).toBe('false')
  })

  it('keeps failure feedback visible across sections and allows a safe retry', async () => {
    const { host } = installTestHost()
    host.setConfig.mockRejectedValueOnce(new Error('Synthetic failure: token=obviously-fake-sensitive-value'))
    render(<SettingsStub open initialPane="appearance" onClose={vi.fn()} />)
    await ready()
    fireEvent.click(skin())
    await waitFor(() => expect(saveStatus().textContent).toBe('Save failed'))
    expect(skin().getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('[secret]')
    expect(screen.getByRole('alert').textContent).not.toContain('obviously-fake-sensitive-value')
    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(host.getConfig).toHaveBeenCalledTimes(2))
    expect(saveStatus().textContent).toBe('Save failed')
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }))
    await waitFor(() => expect(saveStatus().textContent).toBe('Saved'))
    expect(host.setConfig).toHaveBeenNthCalledWith(2, { appearance: { messengerSkin: false } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['success', 'failure'] as const)('does not attach an old %s result to reopened Settings', async result => {
    const { host } = installTestHost(), pending = deferred<ReturnType<typeof testConfig>>()
    const fresh = testConfig()
    fresh.appearance.messengerSkin = false
    host.setConfig.mockReturnValueOnce(pending.promise)
    const view = render(<SettingsStub open initialPane="appearance" onClose={vi.fn()} />)
    await ready()
    fireEvent.click(skin())
    view.rerender(<SettingsStub open={false} initialPane="appearance" onClose={vi.fn()} />)
    host.getConfig.mockResolvedValue(fresh)
    view.rerender(<SettingsStub open initialPane="appearance" onClose={vi.fn()} />)
    await waitFor(() => expect(host.getConfig).toHaveBeenCalledTimes(2))
    expect(skin().getAttribute('aria-busy')).toBe('true')
    fireEvent.click(skin())
    expect(host.setConfig).toHaveBeenCalledOnce()
    const published: Array<ReturnType<typeof testConfig>> = []
    const onConfig = (event: Event) => published.push((event as CustomEvent).detail)
    window.addEventListener('hermes-desk:host-config', onConfig)
    try {
      await act(async () => {
        if (result === 'success') pending.resolve(testConfig())
        else pending.reject(new Error('Synthetic obsolete failure'))
      })
      await waitFor(() => expect(skin().getAttribute('aria-checked')).toBe('false'))
      expect(saveStatus().getAttribute('data-save-state')).toBe('idle')
      expect(screen.queryByRole('alert')).toBeNull()
      expect(published.length).toBeGreaterThan(0)
      expect(published.every(config => config.appearance.messengerSkin === false)).toBe(true)
      fireEvent.click(skin())
      await waitFor(() => expect(saveStatus().textContent).toBe('Saved'))
      expect(host.setConfig).toHaveBeenCalledTimes(2)
    } finally { window.removeEventListener('hermes-desk:host-config', onConfig) }
  })

  it('rejects a pre-save refresh that completes after the acknowledged write', async () => {
    const { host } = installTestHost(), oldRead = deferred<ReturnType<typeof testConfig>>()
    render(<SettingsStub open initialPane="appearance" onClose={vi.fn()} />)
    await ready()
    host.getConfig.mockReturnValueOnce(oldRead.promise)
    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(host.getConfig).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    fireEvent.click(skin())
    await waitFor(() => expect(saveStatus().textContent).toBe('Saved'))
    await act(async () => oldRead.resolve(testConfig()))
    expect(skin().getAttribute('aria-checked')).toBe('false')
    expect(saveStatus().textContent).toBe('Saved')
  })

  it('clears completed save feedback when Settings is closed and reopened', async () => {
    installTestHost()
    const view = render(<SettingsStub open initialPane="appearance" onClose={vi.fn()} />)
    await ready()
    fireEvent.click(skin())
    await waitFor(() => expect(saveStatus().textContent).toBe('Saved'))
    view.rerender(<SettingsStub open={false} initialPane="appearance" onClose={vi.fn()} />)
    view.rerender(<SettingsStub open initialPane="appearance" onClose={vi.fn()} />)
    expect(saveStatus().getAttribute('data-save-state')).toBe('idle')
  })

  it.each(['close', 'unmount'])('handles a late write after %s without publishing its obsolete response', async action => {
    const { host } = installTestHost(), pending = deferred<ReturnType<typeof testConfig>>()
    host.setConfig.mockReturnValueOnce(pending.promise)
    const view = render(<SettingsStub open initialPane="appearance" onClose={vi.fn()} />)
    await ready()
    fireEvent.click(skin())
    if (action === 'close') view.rerender(<SettingsStub open={false} initialPane="appearance" onClose={vi.fn()} />)
    else view.unmount()
    const current = testConfig()
    current.appearance.messengerSkin = false
    host.getConfig.mockResolvedValue(current)
    const published = vi.fn()
    window.addEventListener('hermes-desk:host-config', published)
    try {
      await act(async () => pending.resolve(testConfig()))
      if (action === 'unmount') expect(published).not.toHaveBeenCalled()
      else {
        await waitFor(() => expect(published).toHaveBeenCalledOnce())
        expect((published.mock.calls[0]![0] as CustomEvent).detail.appearance.messengerSkin).toBe(false)
      }
    } finally { window.removeEventListener('hermes-desk:host-config', published) }
  })
})
