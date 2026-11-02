import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testConfig } from '../components/settings/local/test-fixtures'
import type { HostConfig } from './desktop-bridge'
import { publishHostConfig, useHostConfig } from './host-config'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('shared host config', () => {
  it('loads persisted config and observes settings updates without local persistence', async () => {
    const config = testConfig()
    const getConfig = vi.fn(async () => config)
    vi.stubGlobal('nubAgent', { host: { getConfig } })
    const { result } = renderHook(useHostConfig)
    await waitFor(() => expect(result.current).toEqual(config))
    const updated = { ...config, appearance: { messengerSkin: false } }
    act(() => publishHostConfig(updated))
    expect(result.current).toEqual(updated)
    expect(getConfig).toHaveBeenCalledOnce()
  })

  it('does not let a late initial read overwrite a saved setting', async () => {
    let resolve: (value: HostConfig) => void = () => {}
    vi.stubGlobal('nubAgent', { host: { getConfig: () => new Promise<HostConfig>((yes) => { resolve = yes }) } })
    const { result } = renderHook(useHostConfig)
    const config = testConfig()
    const updated = { ...config, appearance: { messengerSkin: false } }
    act(() => publishHostConfig(updated))
    await act(async () => resolve(config))
    expect(result.current).toEqual(updated)
  })

  it('retains null when the bridge is missing or unavailable', async () => {
    vi.stubGlobal('nubAgent', undefined)
    const missing = renderHook(useHostConfig)
    expect(missing.result.current).toBeNull()
    missing.unmount()
    vi.stubGlobal('nubAgent', { host: { getConfig: vi.fn().mockRejectedValue(new Error('fake private detail')) } })
    const unavailable = renderHook(useHostConfig)
    await act(async () => {})
    expect(unavailable.result.current).toBeNull()
  })
})
