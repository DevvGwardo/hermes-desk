import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SettingsStub } from '../../SettingsStub'
import { getLocalPrefs } from '../../../lib/local-prefs'
import { installTestHost, testConfig, testStatus } from './test-fixtures'
import { makeDebugBundle } from './DiagnosticsPane'
import { SETTINGS_INDEX, SETTINGS_SECTIONS } from '../../../lib/settings-index'
import { scrubDebugText } from './common'

beforeEach(() => { window.localStorage.clear(); Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); delete window.nubAgent; vi.unstubAllGlobals() })

describe('one local preference store', () => {
  it('writes scratch visibility, agent ordering, hide/restore and session sources to local-prefs', async () => {
    installTestHost()
    render(<SettingsStub open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Show scratch profiles' }))
    expect(getLocalPrefs().showScratch).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }))
    const move = await screen.findByRole('button', { name: 'Move spike-alpha up' })
    fireEvent.click(move)
    expect(getLocalPrefs().pinnedOrder).toEqual(['profile:spike-alpha', 'profile:default'])
    fireEvent.click(screen.getByRole('button', { name: 'Hide spike-alpha' }))
    expect(getLocalPrefs().hiddenProfiles).toEqual(['spike-alpha'])
    fireEvent.click(screen.getByRole('button', { name: 'Restore spike-alpha' }))
    expect(getLocalPrefs().hiddenProfiles).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'cli sessions' }))
    expect(getLocalPrefs().sessionSources).toEqual(['desktop', 'cli'])
  })
  it('stores messenger skin through host settings, not another prefs store', async () => {
    const { host } = installTestHost()
    render(<SettingsStub open onClose={() => {}} initialPane="appearance" />)
    const skin = screen.getByRole('switch', { name: 'Messenger skin' })
    await waitFor(() => expect(skin).toHaveProperty('disabled', false))
    fireEvent.click(skin)
    await waitFor(() => expect(skin.getAttribute('aria-checked')).toBe('false'))
    expect(host.setConfig).toHaveBeenCalledWith({ appearance: { messengerSkin: false } })
  })
  it('keeps model and ui_meta read-only rather than faking a profile save', async () => {
    installTestHost()
    render(<SettingsStub open onClose={() => {}} initialPane="agents" />)
    await screen.findByText('fake-model')
    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveProperty('readOnly', true)
    expect(screen.getByRole('textbox', { name: 'Avatar' })).toHaveProperty('readOnly', true)
    expect(screen.getByRole('link', { name: 'Open memory' }).getAttribute('href')).toContain('profile%3Adefault')
  })
})

describe('profile settings draft ownership', () => {
  it('preserves edited profile fields through refresh and saves their original drafts', async () => {
    const { host } = installTestHost()
    const config = testConfig()
    config.capabilities = { profileEditing: true }
    config.profiles[0]!.avatar = 'original-fixture.png'
    host.getConfig.mockResolvedValue(config)
    render(<SettingsStub open onClose={() => {}} initialPane="agents" />)
    await waitFor(() => expect(screen.getByLabelText('Display name')).toHaveProperty('value', 'Fake Hermes'))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Draft fixture name' } })
    fireEvent.change(screen.getByLabelText('Avatar'), { target: { value: 'draft-fixture.png' } })
    fireEvent.change(screen.getByLabelText('Routine time zone'), { target: { value: 'Asia/Tokyo' } })
    const refreshed = structuredClone(config)
    Object.assign(refreshed.profiles[0]!, { displayName: 'Refreshed fixture name', avatar: 'refreshed-fixture.png', timezone: 'Europe/London', model: 'refreshed-fixture-model' })
    host.getConfig.mockResolvedValue(refreshed)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh profiles' }))
    await screen.findByText('refreshed-fixture-model')
    expect(screen.getByLabelText('Display name')).toHaveProperty('value', 'Draft fixture name')
    expect(screen.getByLabelText('Avatar')).toHaveProperty('value', 'draft-fixture.png')
    expect(screen.getByLabelText('Routine time zone')).toHaveProperty('value', 'Asia/Tokyo')
    fireEvent.click(screen.getByRole('button', { name: 'Save profile appearance' }))
    await waitFor(() => expect(host.setConfig).toHaveBeenCalledWith({ agent: { profile: 'default', uiMeta: { display_name: 'Draft fixture name', avatar: 'draft-fixture.png' } } }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save time zone' })).toHaveProperty('disabled', false))
    fireEvent.click(screen.getByRole('button', { name: 'Save time zone' }))
    await waitFor(() => expect(host.setConfig).toHaveBeenCalledWith({ agent: { profile: 'default', timezone: 'Asia/Tokyo' } }))
  })

  it('updates untouched fields independently without discarding an edited time zone', async () => {
    const { host } = installTestHost()
    const config = testConfig()
    config.capabilities = { profileEditing: true }
    host.getConfig.mockResolvedValue(config)
    render(<SettingsStub open onClose={() => {}} initialPane="agents" />)
    await waitFor(() => expect(screen.getByLabelText('Routine time zone')).toHaveProperty('value', 'UTC'))
    fireEvent.change(screen.getByLabelText('Routine time zone'), { target: { value: 'Asia/Tokyo' } })
    const refreshed = structuredClone(config)
    Object.assign(refreshed.profiles[0]!, { displayName: 'Current fixture name', avatar: 'current-fixture.png', timezone: 'Europe/London', model: 'current-fixture-model' })
    host.getConfig.mockResolvedValue(refreshed)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh profiles' }))
    await screen.findByText('current-fixture-model')
    expect(screen.getByLabelText('Display name')).toHaveProperty('value', 'Current fixture name')
    expect(screen.getByLabelText('Avatar')).toHaveProperty('value', 'current-fixture.png')
    expect(screen.getByLabelText('Routine time zone')).toHaveProperty('value', 'Asia/Tokyo')
  })

  it('resets drafts on profile switches and keeps subsequent saves in the new profile', async () => {
    const { host } = installTestHost()
    const config = testConfig()
    config.capabilities = { profileEditing: true }
    config.profiles[1]!.avatar = 'alpha-fixture.png'
    host.getConfig.mockResolvedValue(config)
    render(<SettingsStub open onClose={() => {}} initialPane="agents" />)
    await waitFor(() => expect(screen.getByLabelText('Display name')).toHaveProperty('value', 'Fake Hermes'))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Default fixture draft' } })
    fireEvent.change(screen.getByLabelText('Routine time zone'), { target: { value: 'Asia/Tokyo' } })
    fireEvent.change(screen.getByLabelText('Agent profile'), { target: { value: 'spike-alpha' } })
    expect(screen.getByLabelText('Display name')).toHaveProperty('value', 'Fake Alpha')
    expect(screen.getByLabelText('Avatar')).toHaveProperty('value', 'alpha-fixture.png')
    expect(screen.getByLabelText('Routine time zone')).toHaveProperty('value', 'America/Chicago')
    fireEvent.click(screen.getByRole('button', { name: 'Save time zone' }))
    await waitFor(() => expect(host.setConfig).toHaveBeenCalledExactlyOnceWith({ agent: { profile: 'spike-alpha', timezone: 'America/Chicago' } }))
  })

  it('does not erase edits typed while native confirmation is pending', async () => {
    const { host } = installTestHost()
    const config = testConfig()
    config.capabilities = { profileEditing: true }
    host.getConfig.mockResolvedValue(config)
    let resolve!: (value: typeof config) => void
    host.setConfig.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    render(<SettingsStub open onClose={() => {}} initialPane="agents" />)
    await waitFor(() => expect(screen.getByLabelText('Display name')).toHaveProperty('value', 'Fake Hermes'))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Submitted fixture name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile appearance' }))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Newer fixture draft' } })
    const saved = structuredClone(config)
    saved.profiles[0]!.displayName = 'Submitted fixture name'
    await act(async () => resolve(saved))
    expect(screen.getByLabelText('Display name')).toHaveProperty('value', 'Newer fixture draft')
    expect(host.setConfig).toHaveBeenCalledExactlyOnceWith({ agent: { profile: 'default', uiMeta: { display_name: 'Submitted fixture name', avatar: '' } } })
  })

  it('tracks a later inventory value after an unchanged draft was saved', async () => {
    const { host } = installTestHost()
    const config = testConfig()
    config.capabilities = { profileEditing: true }
    host.getConfig.mockResolvedValue(config)
    render(<SettingsStub open onClose={() => {}} initialPane="agents" />)
    await waitFor(() => expect(screen.getByLabelText('Display name')).toHaveProperty('value', 'Fake Hermes'))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Saved fixture name' } })
    const saved = structuredClone(config)
    saved.profiles[0]!.displayName = 'Saved fixture name'
    host.setConfig.mockResolvedValueOnce(saved)
    fireEvent.click(screen.getByRole('button', { name: 'Save profile appearance' }))
    await screen.findByText('Saved fixture name')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save profile appearance' })).toHaveProperty('disabled', false))
    const refreshed = structuredClone(saved)
    Object.assign(refreshed.profiles[0]!, { displayName: 'Latest fixture name', model: 'latest-fixture-model' })
    host.getConfig.mockResolvedValue(refreshed)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh profiles' }))
    await screen.findByText('latest-fixture-model')
    await waitFor(() => expect(screen.getByLabelText('Display name')).toHaveProperty('value', 'Latest fixture name'))
  })

  it('keeps profile tools open during metadata refresh and closes them on profile change', async () => {
    const { host, forbidden } = installTestHost()
    const config = testConfig()
    host.getConfig.mockResolvedValue(config)
    render(<SettingsStub open onClose={() => {}} initialPane="agents" />)
    await screen.findByText('fake-model')
    fireEvent.click(screen.getByRole('link', { name: 'Open memory' }))
    await screen.findByText('Memory · default')
    const refreshed = structuredClone(config)
    Object.assign(refreshed.profiles[0]!, { displayName: 'Current fixture name', model: 'current-tools-fixture-model' })
    host.getConfig.mockResolvedValue(refreshed)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh profiles' }))
    await screen.findByText('current-tools-fixture-model')
    expect(screen.getByText('Memory · default')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Agent profile'), { target: { value: 'spike-alpha' } })
    expect(screen.queryByText('Memory · default')).toBeNull()
    expect(forbidden).not.toHaveBeenCalled()
  })
})

describe('workspace and computer preferences', () => {
  it('only changes browsing on a per-profile toggle and shows the MCP diff, backup, status and session restart requirement', async () => {
    const { host } = installTestHost()
    render(<SettingsStub open onClose={() => {}} initialPane="workspace" />)
    const enable = await screen.findByRole('switch', { name: 'Let Fake Alpha browse in Hermes Desk' })
    expect(host.enableBrowserControl).not.toHaveBeenCalled()
    fireEvent.click(enable)
    await screen.findByText(/Browsing enabled for Fake Alpha/)
    expect(host.enableBrowserControl).toHaveBeenCalledWith(['spike-alpha'])
    expect(screen.getByLabelText('Controller config diff').textContent).toContain('hermes-desk:')
    expect(screen.getByText(/Backup:/).textContent).toContain('bak-hermesdesk')
    expect(screen.getByText('MCP browser status: error')).toBeTruthy()
    expect(screen.getByText(/Restart that agent’s Hermes session after enabling or disabling/)).toBeTruthy()
    await waitFor(() => expect(enable.getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(enable)
    await screen.findByText(/Browsing disabled for Fake Alpha/)
    expect(host.disableBrowserControl).toHaveBeenCalledWith(['spike-alpha'])
    await waitFor(() => expect(enable.getAttribute('aria-checked')).toBe('false'))
  })
  it('does not flip browsing state on cancellation or a missing MCP writer', async () => {
    const { host } = installTestHost()
    host.enableBrowserControl.mockResolvedValueOnce({ ok: false, profiles: ['default'], cancelled: true })
    render(<SettingsStub open onClose={() => {}} initialPane="workspace" />)
    const toggle = await screen.findByRole('switch', { name: 'Let Fake Hermes browse in Hermes Desk' })
    fireEvent.click(toggle)
    await screen.findByText('Cancelled. No config changed.')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    host.enableBrowserControl.mockResolvedValueOnce({ ok: false, profiles: ['default'], error: 'MCP config writer is not available. Nothing changed.' })
    fireEvent.click(toggle)
    await screen.findByText('MCP config writer is not available. Nothing changed.')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })
  it('shows ready as an MCP socket status and disables removal when the new host bridge is not merged', async () => {
    const { host, status } = installTestHost()
    status.controller = 'ready'
    const config = testConfig()
    config.workspace.enabledProfiles = ['default']
    host.getConfig.mockResolvedValue(config)
    window.nubAgent = { host: { ...host, disableBrowserControl: undefined } } as unknown as Window['nubAgent']
    render(<SettingsStub open onClose={() => {}} initialPane="workspace" />)
    const toggle = await screen.findByRole('switch', { name: 'Let Fake Hermes browse in Hermes Desk' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle).toHaveProperty('disabled', true)
    expect(screen.getByText('MCP browser status: ready')).toBeTruthy()
    expect(screen.getByText(/MCP browser socket is listening/)).toBeTruthy()
    expect(screen.getByText(/host disable bridge is merged/)).toBeTruthy()
    expect(host.enableBrowserControl).not.toHaveBeenCalled()
  })
  it('writes per-profile website policy and separate tab/download/search patches', async () => {
    const { host } = installTestHost()
    render(<SettingsStub open onClose={() => {}} initialPane="workspace" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save website lists' })).toHaveProperty('disabled', false))
    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace profile' }), { target: { value: 'spike-alpha' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Allowed websites' }), { target: { value: 'example.invalid\n*.docs.invalid' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Blocked websites' }), { target: { value: 'blocked.invalid' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save website lists' }))
    await waitFor(() => expect(host.setConfig).toHaveBeenCalledWith({ workspace: { profiles: { 'spike-alpha': { allow: ['example.invalid', '*.docs.invalid'], deny: ['blocked.invalid'] } } } }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save tab limits' })).toHaveProperty('disabled', false))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tabs per agent' }), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save tab limits' }))
    await waitFor(() => expect(host.setConfig).toHaveBeenCalledWith({ workspace: { maxTabsPerAgent: 4, maxLiveViews: 20 } }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save downloads folder' })).toHaveProperty('disabled', false))
    fireEvent.change(screen.getByRole('textbox', { name: 'Downloads folder' }), { target: { value: '/tmp/fake-downloads' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save downloads folder' }))
    await waitFor(() => expect(host.setConfig).toHaveBeenCalledWith({ workspace: { downloadsDir: '/tmp/fake-downloads' } }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Search engine' })).toHaveProperty('disabled', false))
    fireEvent.change(screen.getByRole('combobox', { name: 'Search engine' }), { target: { value: 'bing' } })
    await waitFor(() => expect(host.setConfig).toHaveBeenCalledWith({ workspace: { searchEngine: 'bing' } }))
    expect(screen.getByRole('button', { name: 'Clear agent lane data' })).toHaveProperty('disabled', true)
  })
  it('labels PiP as a completed-capture preview and saves placement without capturing the Mac', async () => {
    const { host } = installTestHost()
    render(<SettingsStub open onClose={() => {}} initialPane="computer" />)
    const placement = screen.getByRole('combobox', { name: 'PiP placement' })
    await waitFor(() => expect(placement).toHaveProperty('disabled', false))
    fireEvent.change(placement, { target: { value: 'floating' } })
    await waitFor(() => expect(host.setConfig).toHaveBeenCalledWith({ computer: { placement: 'floating' } }))
    expect(screen.getByText(/No live Mac frame source exists/)).toBeTruthy()
    expect(screen.getByText(/does not start screen capture/)).toBeTruthy()
  })
})

describe('redacted diagnostics', () => {
  it('strips secrets and URL paths from logs and debug exports and omits unknown audit fields', () => {
    const status = testStatus()
    status.serve.stderrTail = [
      'api_key=obviously-fake-secret bearer obviously-fake-bearer',
      'https://example.invalid/private?token=obviously-fake-query',
      'verification code: 123456',
      '4111 1111 1111 1111',
    ]
    const text = makeDebugBundle({ status }, [{
      ts: '2026-10-06T12:00:00.000Z', agent: 'default', lane: 'profile:default', tab: 't_a',
      action: 'browser_click', origin: 'https://example.invalid/path', result: 'ok', durationMs: 2,
      ...({ rawContent: 'obviously-fake-page-content' } as object),
    }])
    expect(text).not.toMatch(/obviously-fake|123456|4111|\/private|\/path/)
    expect(text).toContain('browser_click')
    expect(text).toContain('[secret]')
    expect(scrubDebugText('token: "obviously-fake"')).not.toContain('obviously-fake')
    const marker = '-'.repeat(5)
    const label = ['FAKE', 'PRIVATE', 'KEY'].join(' ')
    const pem = `${marker}BEGIN ${label}${marker}\nobviously-fake-key\n${marker}END ${label}${marker}`
    expect(scrubDebugText(pem)).toBe('[secret]')
  })
  it('copies a redacted local bundle to the clipboard without an upload', async () => {
    const { status, forbidden } = installTestHost()
    status.serve.stderrTail = ['password=obviously-fake-secret']
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<SettingsStub open onClose={() => {}} initialPane="diagnostics" />)
    await screen.findByText(/Gateway: up.*Serve:/)
    fireEvent.click(screen.getByRole('button', { name: 'Copy debug bundle' }))
    await screen.findByText('Redacted debug bundle copied. Nothing was uploaded.')
    expect(writeText.mock.calls[0][0]).not.toContain('obviously-fake-secret')
    expect(forbidden).not.toHaveBeenCalled()
  })
})

describe('compatibility and search coverage', () => {
  it('renders a searchable target for every local index entry', async () => {
    installTestHost()
    const { container } = render(<SettingsStub open onClose={() => {}} />)
    for (const section of SETTINGS_SECTIONS) {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: section.label })) })
      if (section.id === 'advanced') {
        await act(async () => {
          const disclosure = screen.getByText('Diagnostics and audit log').closest('details')!
          disclosure.open = true
          fireEvent(disclosure, new Event('toggle'))
        })
      }
      for (const entry of SETTINGS_INDEX.filter((item) => item.section === section.id)) {
        expect(container.querySelector(`[data-setting="${entry.id}"]`), entry.id).toBeTruthy()
      }
    }
  })
  it('ignores an obsolete load response after settings closes and reopens', async () => {
    const { host } = installTestHost()
    let complete: (value: ReturnType<typeof testConfig>) => void = () => {}
    host.getConfig.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const props = { onClose: () => {} }
    const { rerender } = render(<SettingsStub open initialPane="hermes" {...props} />)
    rerender(<SettingsStub open={false} initialPane="hermes" {...props} />)
    rerender(<SettingsStub open initialPane="hermes" {...props} />)
    await screen.findByText('/tmp/obviously-fake-hermes-home')
    const obsolete = testConfig()
    obsolete.hermesHome = '/tmp/obsolete-hermes-home'
    await act(async () => complete(obsolete))
    expect(screen.queryByText('/tmp/obsolete-hermes-home')).toBeNull()
  })
})
