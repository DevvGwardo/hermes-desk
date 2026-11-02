import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getLocalPrefs, LOCAL_PREFS_KEY, saveLocalPrefs, subscribeLocalPrefs, updateLocalPrefs,
} from './local-prefs'

beforeEach(() => {
  window.localStorage.clear()
  saveLocalPrefs({ pinnedOrder: [], hiddenProfiles: [], showScratch: false, sessionSources: ['desktop'] })
})

describe('local UI preferences', () => {
  it('defaults to desktop sessions and hides scratch profiles', () => {
    expect(getLocalPrefs()).toEqual({ pinnedOrder: [], hiddenProfiles: [], showScratch: false, sessionSources: ['desktop'] })
    expect(getLocalPrefs()).toBe(getLocalPrefs())
  })
  it('writes a versioned persist-style envelope and round-trips all fields', () => {
    updateLocalPrefs({ pinnedOrder: ['profile:fake'], hiddenProfiles: ['fake-hidden'],
      showScratch: true, sessionSources: ['desktop', 'cli', 'cron'] })
    const env = JSON.parse(window.localStorage.getItem(LOCAL_PREFS_KEY)!)
    expect(env).toMatchObject({ slice: 'hermes-desk.local-prefs', schemaVersion: 1, scope: 'client-persisted' })
    expect(env.value).toEqual(getLocalPrefs())
    expect(typeof env.savedAt).toBe('string')
  })
  it('normalizes duplicates and malformed fields while allowing an empty source filter', () => {
    window.localStorage.setItem(LOCAL_PREFS_KEY, JSON.stringify({
      slice: 'hermes-desk.local-prefs', schemaVersion: 1, scope: 'client-persisted',
      value: { pinnedOrder: ['a', 'a', 7, ''], hiddenProfiles: null, showScratch: 'true', sessionSources: [] },
    }))
    expect(getLocalPrefs()).toEqual({ pinnedOrder: ['a'], hiddenProfiles: [], showScratch: false, sessionSources: [] })
  })
  it('falls back on corrupt and version-stale envelopes with stable snapshots', () => {
    for (const raw of ['{broken', '{"schemaVersion":99,"value":{}}', 'null']) {
      window.localStorage.setItem(LOCAL_PREFS_KEY, raw)
      expect(getLocalPrefs().sessionSources).toEqual(['desktop'])
      expect(getLocalPrefs()).toBe(getLocalPrefs())
    }
  })
  it('updates subscribers and stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const off = subscribeLocalPrefs(listener)
    updateLocalPrefs({ showScratch: true })
    expect(listener).toHaveBeenCalledOnce()
    off()
    updateLocalPrefs({ showScratch: false })
    expect(listener).toHaveBeenCalledOnce()
  })
  it('observes cross-window writes and storage clear events', () => {
    const listener = vi.fn()
    const off = subscribeLocalPrefs(listener)
    window.dispatchEvent(new StorageEvent('storage', { key: LOCAL_PREFS_KEY }))
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }))
    expect(listener).toHaveBeenCalledTimes(2)
    off()
  })
  it('keeps in-memory changes when storage reads or writes are unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota') })
    updateLocalPrefs({ hiddenProfiles: ['fake'] })
    expect(getLocalPrefs().hiddenProfiles).toEqual(['fake'])
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Private mode') })
    expect(getLocalPrefs()).toBe(getLocalPrefs())
    expect(getLocalPrefs().hiddenProfiles).toEqual(['fake'])
  })
})
