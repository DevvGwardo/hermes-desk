import { describe, expect, it, vi } from 'vitest'
import { isSettingsPaneRequest, onOpenSettingsRequest, requestOpenSettings, settingsSectionFor } from '../open-settings'

describe('local settings deep links', () => {
  it('delivers local pane requests and unsubscribes', () => {
    const callback = vi.fn()
    const off = onOpenSettingsRequest(callback)
    requestOpenSettings('workspace'); requestOpenSettings()
    expect(callback.mock.calls).toEqual([['workspace'], [undefined]])
    off(); requestOpenSettings('hermes')
    expect(callback).toHaveBeenCalledTimes(2)
  })
  it('rejects platform and unknown requests, even though old source callers still compile', () => {
    const callback = vi.fn()
    const off = onOpenSettingsRequest(callback)
    for (const pane of ['billing', 'account', 'keys', 'usage', 'connections'] as const) {
      expect(isSettingsPaneRequest(pane)).toBe(false)
      requestOpenSettings(pane)
    }
    expect(callback.mock.calls).toEqual(Array.from({ length: 5 }, () => [undefined]))
    expect(isSettingsPaneRequest('__proto__')).toBe(false)
    expect(isSettingsPaneRequest(null)).toBe(false)
    off()
  })
  it('preserves old deep links and focuses their targets in six task-oriented sections', () => {
    expect(settingsSectionFor('privacy').section).toBe('privacy')
    expect(settingsSectionFor('troubleshooting')).toEqual({ section: 'advanced', focus: 'connector-log' })
    expect(settingsSectionFor('diagnostics')).toEqual({ section: 'advanced', focus: 'connector-log' })
    expect(settingsSectionFor('hermes')).toEqual({ section: 'advanced', focus: 'hermes-home' })
    expect(settingsSectionFor('secrets')).toEqual({ section: 'privacy', focus: 'onepassword' })
    expect(settingsSectionFor('computer')).toEqual({ section: 'privacy', focus: 'pip' })
    expect(settingsSectionFor('capabilities').section).toBe('agents')
    for (const pane of ['general', 'agents', 'workspace', 'privacy', 'appearance', 'advanced'] as const) {
      expect(isSettingsPaneRequest(pane)).toBe(true)
      expect(settingsSectionFor(pane)).toEqual({ section: pane, focus: null })
    }
  })
})
