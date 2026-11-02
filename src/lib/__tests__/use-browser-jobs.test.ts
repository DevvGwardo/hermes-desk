import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useBrowserJobsSupported } from '../use-browser-jobs'

const probeBrowserJobs = vi.fn()

vi.mock('../hermes-rest', () => ({
  probeBrowserJobs: (...a: unknown[]) => probeBrowserJobs(...(a as [])),
}))

describe('useBrowserJobsSupported', () => {
  it('stays false and never probes without a paired instance', () => {
    probeBrowserJobs.mockReset()
    const { result } = renderHook(() => useBrowserJobsSupported(null))
    expect(result.current).toBe(false)
    expect(probeBrowserJobs).not.toHaveBeenCalled()
  })

  it('does not probe the obsolete browser-job route even with a former instance id', async () => {
    probeBrowserJobs.mockReset().mockResolvedValue(true)
    const { result } = renderHook(() => useBrowserJobsSupported('inst-1'))
    expect(result.current).toBe(false)
    await waitFor(() => expect(result.current).toBe(false))
    expect(probeBrowserJobs).not.toHaveBeenCalled()
  })

  it('stays false when the route is absent', async () => {
    probeBrowserJobs.mockReset().mockResolvedValue(false)
    const { result } = renderHook(() => useBrowserJobsSupported('inst-1'))
    expect(probeBrowserJobs).not.toHaveBeenCalled()
    // Let the resolution flush, then confirm fail-closed.
    await waitFor(() => expect(result.current).toBe(false))
    expect(result.current).toBe(false)
  })
})
