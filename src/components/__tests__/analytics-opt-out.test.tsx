import { describe, expect, it } from 'vitest'
import { SETTINGS_INDEX, searchSettings } from '../../lib/settings-index'

describe('no local telemetry setting', () => {
  it('does not offer analytics or model-training controls for nonexistent services', () => {
    expect(SETTINGS_INDEX.some((entry) => ['analytics', 'train-data'].includes(entry.id))).toBe(false)
    expect(searchSettings('share usage analytics')).toEqual([])
    expect(searchSettings('help improve the model')).toEqual([])
  })
})
