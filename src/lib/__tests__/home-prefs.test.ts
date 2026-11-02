import { afterEach, describe, expect, it, vi } from 'vitest'
import { getHomeOnLaunch, HOME_ON_LAUNCH_KEY, setHomeOnLaunch, subscribeHomeOnLaunch } from '../home-prefs'
import { launchHash } from '../router'

afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear() })

describe('home on launch preference', () => {
  it('defaults on and round-trips through its own key', () => {
    expect(getHomeOnLaunch()).toBe(true)
    setHomeOnLaunch(false)
    expect(window.localStorage.getItem(HOME_ON_LAUNCH_KEY)).toBe('false')
    expect(getHomeOnLaunch()).toBe(false)
    setHomeOnLaunch(true)
    expect(getHomeOnLaunch()).toBe(true)
  })
  it('notifies subscribers, including cross-window writes', () => {
    const listener = vi.fn()
    const off = subscribeHomeOnLaunch(listener)
    setHomeOnLaunch(false)
    window.dispatchEvent(new StorageEvent('storage', { key: HOME_ON_LAUNCH_KEY }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }))
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    setHomeOnLaunch(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })
  it('keeps the in-memory value when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota') })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Private mode') })
    setHomeOnLaunch(false)
    expect(getHomeOnLaunch()).toBe(false)
    setHomeOnLaunch(true)
    expect(getHomeOnLaunch()).toBe(true)
  })
})

describe('launchHash', () => {
  it('opens Home only for a bare launch with the preference on', () => {
    expect(launchHash('', true)).toBe('#/home')
    expect(launchHash('#/', true)).toBe('#/home')
    expect(launchHash('', false)).toBe('')
  })
  it('never rewrites a deep link', () => {
    for (const hash of ['#/c/c1', '#/agent/a1', '#/routines', '#/?settings=1&pane=general', '#/home?c=c1']) {
      expect(launchHash(hash, true)).toBe(hash)
    }
  })
})
