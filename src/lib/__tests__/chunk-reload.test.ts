import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isChunkLoadError, reloadForStaleChunk } from '../chunk-reload'

describe('isChunkLoadError', () => {
  it('matches the browsers’ stale-chunk messages', () => {
    expect(
      isChunkLoadError(
        new TypeError('Failed to fetch dynamically imported module: https://agent.nub.lol/assets/MobileApp-BnNuwd1C.js'),
      ),
    ).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
  })

  it('ignores ordinary errors', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
  })
})

describe('reloadForStaleChunk', () => {
  const reload = vi.fn()

  beforeEach(() => {
    sessionStorage.clear()
    reload.mockReset()
    vi.stubGlobal('location', { ...window.location, reload })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reloads once, then lets the error through within the window', () => {
    expect(reloadForStaleChunk()).toBe(true)
    expect(reloadForStaleChunk()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
