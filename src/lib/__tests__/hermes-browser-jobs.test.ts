import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserJob, deleteBrowserJob, getBrowserJob, probeBrowserJobs, steerBrowserJob } from '../hermes-rest'

afterEach(() => { vi.unstubAllGlobals() })
describe('hosted browser jobs are removed', () => {
  it('returns unsupported without a network call; workspace control belongs in main', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await probeBrowserJobs('fake-instance')).toBe(false)
    expect(await createBrowserJob('fake-instance', { goal: 'Synthetic fixture' })).toBeNull()
    expect(await getBrowserJob('fake-instance', 'fake-job')).toBeNull()
    expect(await steerBrowserJob('fake-instance', 'fake-job', { action: 'stop' })).toBe(false)
    expect(await deleteBrowserJob('fake-instance', 'fake-job')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
