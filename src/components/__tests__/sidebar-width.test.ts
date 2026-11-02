import { beforeEach, describe, expect, it } from 'vitest'
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
  toggleCompactSidebarWidth,
} from '../Sidebar'

describe('sidebar width', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('clamps below min, above max, and rounds', () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_WIDTH_MIN)
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_WIDTH_MAX)
    expect(clampSidebarWidth(241.6)).toBe(242)
  })

  it('falls back to default for non-finite values', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT)
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_WIDTH_DEFAULT)
  })

  it('loads the default when nothing is stored', () => {
    expect(loadSidebarWidth()).toBe(SIDEBAR_WIDTH_DEFAULT)
  })

  it('persists a clamped width and reloads it', () => {
    saveSidebarWidth(360)
    expect(loadSidebarWidth()).toBe(360)
    saveSidebarWidth(12)
    expect(loadSidebarWidth()).toBe(SIDEBAR_WIDTH_MIN)
  })

  it('⌘B compact toggles min width and restores the previous width', () => {
    expect(toggleCompactSidebarWidth(360)).toBe(SIDEBAR_WIDTH_MIN)
    expect(toggleCompactSidebarWidth(SIDEBAR_WIDTH_MIN)).toBe(360)
    expect(toggleCompactSidebarWidth(SIDEBAR_WIDTH_MIN)).toBe(360)
  })
})
