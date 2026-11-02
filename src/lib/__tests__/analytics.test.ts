import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyticsConfig, analyticsOptedOut, resetAnalyticsForTests, setAnalyticsOptOut, startAnalytics, track } from '../analytics'

afterEach(() => vi.unstubAllGlobals())
describe('local-only analytics API', () => {
  it('is disabled even with production telemetry settings', () => {
    expect(analyticsConfig({ PROD: true, VITE_POSTHOG_KEY: 'phc_obviously_fake', VITE_POSTHOG_HOST: 'https://example.invalid' })).toBeNull()
    setAnalyticsOptOut(false)
    expect(analyticsOptedOut()).toBe(true)
  })
  it('never sends requests or stores content, including after opting in', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const write = vi.spyOn(Storage.prototype, 'setItem')
    setAnalyticsOptOut(false)
    await startAnalytics()
    track('message_sent', { target: 'fixture' })
    setAnalyticsOptOut(true)
    resetAnalyticsForTests()
    expect(fetch).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
})
