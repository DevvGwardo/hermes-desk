import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeBrowserJobs } from '../hermes-rest'

afterEach(() => vi.unstubAllGlobals())
describe('retired hosted browser jobs', () => {
  it('reports unavailable without any network request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await probeBrowserJobs('fake-agent')).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})
