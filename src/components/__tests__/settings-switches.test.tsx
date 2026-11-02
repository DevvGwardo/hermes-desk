import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NotificationsSetting } from '../NotificationsSetting'
import { PluginSettings } from '../PluginSettings'
import { SettingsStub } from '../SettingsStub'
import { installTestHost } from '../settings/local/test-fixtures'
import { notificationsEnabled } from '../../lib/system-notify'
import { uiSoundsEnabled } from '../../lib/ui-sounds'
import { publishPlugin, dropPlugin } from '../../plugins/areas'
import { setPluginEnabled } from '../../plugins/loader'
import { getLocalPrefs } from '../../lib/local-prefs'

vi.mock('../../plugins/loader', () => ({
  setPluginEnabled: vi.fn(),
  discoverRuntimePlugins: vi.fn(),
}))

beforeEach(() => { window.localStorage.clear() })
afterEach(() => {
  cleanup()
  dropPlugin('settings-switch-fixture')
  delete window.nubAgent
  vi.unstubAllGlobals()
})

describe('consistent Settings toggles', () => {
  it('keeps notification and sound preferences on their existing local stores', () => {
    render(<NotificationsSetting />)
    const notify = screen.getByRole('switch', { name: 'Notify me' })
    const sounds = screen.getByRole('switch', { name: 'Reply sounds' })
    expect(notify.classList.contains('desk-switch')).toBe(true)
    expect(sounds.classList.contains('desk-switch')).toBe(true)
    fireEvent.click(notify)
    expect(notificationsEnabled()).toBe(false)
    expect(notify.textContent).toBe('Off')
    fireEvent.click(sounds)
    expect(uiSoundsEnabled()).toBe(false)
    expect(sounds.textContent).toBe('Off')
  })

  it('still requests browser notification permission only when the user switches it on', async () => {
    window.localStorage.setItem('nub.notifications.v1', 'off')
    const requestPermission = vi.fn(async () => 'granted')
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    render(<NotificationsSetting />)
    expect(requestPermission).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: 'Notify me' }))
    await waitFor(() => expect(requestPermission).toHaveBeenCalledOnce())
    expect(notificationsEnabled()).toBe(true)
  })

  it('keeps plugin toggles focusable while pending and does not submit duplicate changes', async () => {
    publishPlugin({ id: 'settings-switch-fixture', name: 'Fixture plugin', kind: 'disk', status: 'disabled' })
    let finish!: () => void
    vi.mocked(setPluginEnabled).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    render(<PluginSettings />)
    const toggle = screen.getByRole('switch', { name: 'Toggle Fixture plugin' })
    act(() => toggle.focus())
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-busy')).toBe('true')
    expect(toggle.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(toggle)
    fireEvent.click(toggle)
    expect(setPluginEnabled).toHaveBeenCalledExactlyOnceWith('settings-switch-fixture', true)
    await act(async () => {
      publishPlugin({ id: 'settings-switch-fixture', name: 'Fixture plugin', kind: 'disk', status: 'loaded' })
      finish()
    })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.textContent).toBe('On')
    expect(toggle.getAttribute('aria-busy')).toBeNull()
    expect(document.activeElement).toBe(toggle)
  })

  it('keeps the saved skin state visible and blocks further changes until the host responds', async () => {
    const { host } = installTestHost()
    let finish!: (value: Awaited<ReturnType<typeof host.getConfig>>) => void
    host.setConfig.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(<SettingsStub open onClose={vi.fn()} initialPane="appearance" />)
    const toggle = screen.getByRole('switch', { name: 'Messenger skin' })
    await waitFor(() => expect(toggle).toHaveProperty('disabled', false))
    act(() => toggle.focus())
    fireEvent.click(toggle)
    expect(toggle).toHaveProperty('disabled', false)
    expect(toggle.getAttribute('aria-disabled')).toBe('true')
    expect(toggle.getAttribute('aria-busy')).toBe('true')
    expect(document.activeElement).toBe(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.textContent).toBe('On')
    fireEvent.click(toggle)
    expect(host.setConfig).toHaveBeenCalledExactlyOnceWith({ appearance: { messengerSkin: false } })
    const config = await host.getConfig()
    config.appearance.messengerSkin = false
    await act(async () => finish(config))
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.textContent).toBe('Off')
    expect(toggle).toHaveProperty('disabled', false)
    expect(toggle.getAttribute('aria-busy')).toBeNull()
    expect(document.activeElement).toBe(toggle)
  })

  it('gives sidebar sources clear descriptions without changing checkbox semantics or storage', async () => {
    installTestHost()
    render(<SettingsStub open onClose={vi.fn()} initialPane="appearance" />)
    for (const [source, description] of [
      ['desktop', 'Chats created in Hermes Desk.'],
      ['cli', 'Chats started from the command line.'],
      ['cron', 'Sessions created by scheduled jobs.'],
    ]) {
      const checkbox = screen.getByRole('checkbox', { name: `${source} sessions` })
      expect(checkbox.getAttribute('aria-describedby')).toBe(screen.getByText(description).id)
      expect(checkbox.closest('label')?.classList.contains('desk-source-option')).toBe(true)
    }
    fireEvent.click(screen.getByText('Scheduled tasks'))
    expect(getLocalPrefs().sessionSources).toEqual(['desktop', 'cron'])
    fireEvent.click(screen.getByText('CLI'))
    expect(getLocalPrefs().sessionSources).toEqual(['desktop', 'cron', 'cli'])
    expect(screen.getByRole('checkbox', { name: 'desktop sessions' })).toHaveProperty('checked', true)
  })

  it('explains approval choices and marks only the saved choice with a check', async () => {
    const { host } = installTestHost()
    render(<SettingsStub open onClose={vi.fn()} initialPane="agents" />)
    const ask = await screen.findByRole('button', { name: 'Ask first' })
    await waitFor(() => expect(ask.getAttribute('aria-pressed')).toBe('true'))
    const smart = screen.getByRole('button', { name: 'Smart' })
    expect(ask.querySelector('svg')).not.toBeNull()
    expect(smart.querySelector('svg')).toBeNull()
    expect(smart.getAttribute('aria-describedby')).toBe(screen.getByText('Let Hermes decide when to ask.').id)
    fireEvent.click(smart)
    await waitFor(() => expect(smart.getAttribute('aria-pressed')).toBe('true'))
    expect(smart.querySelector('svg')).not.toBeNull()
    expect(ask.querySelector('svg')).toBeNull()
    expect(host.setConfig).toHaveBeenCalledWith({ agent: { profile: 'default', approvalMode: 'smart' } })
  })
})
