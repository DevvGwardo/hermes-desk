import { describe, it, expect } from 'vitest'
import { isHudWindow, hudSurface } from '../hud'

describe('hud', () => {
  const original = window.location.href

  const setSearch = (s: string) => {
    const url = new URL(window.location.href)
    url.search = s
    window.history.replaceState(null, '', url.toString())
  }

  it('detects ?win=hud', () => {
    setSearch('?win=hud')
    expect(isHudWindow()).toBe(true)
    expect(hudSurface()).toBe('hud')
  })

  it('ignores other wins', () => {
    setSearch('?win=browser')
    expect(isHudWindow()).toBe(false)
    expect(hudSurface()).toBeUndefined()
  })

  it('ignores missing search', () => {
    setSearch('')
    expect(isHudWindow()).toBe(false)
  })

  it('ignores win=hud in hash', () => {
    window.history.replaceState(null, '', `${window.location.pathname}#/?win=hud`)
    expect(isHudWindow()).toBe(false)
    window.history.replaceState(null, '', original)
  })
})
