import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadSectionCollapsed,
  saveSectionCollapsed,
  type SidebarSectionId,
} from '../Sidebar'

describe('sidebar section collapse (Grok data-sidebar-group parity)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults every section to expanded', () => {
    expect(loadSectionCollapsed('pinned')).toBe(false)
    expect(loadSectionCollapsed('conversations')).toBe(false)
  })

  it('persists collapse per section independently', () => {
    saveSectionCollapsed('pinned', true)
    expect(loadSectionCollapsed('pinned')).toBe(true)
    expect(loadSectionCollapsed('conversations')).toBe(false)
    saveSectionCollapsed('conversations', true)
    expect(loadSectionCollapsed('conversations')).toBe(true)
    saveSectionCollapsed('pinned', false)
    expect(loadSectionCollapsed('pinned')).toBe(false)
    expect(loadSectionCollapsed('conversations')).toBe(true)
  })

  it('survives a storage round-trip (reload simulation)', () => {
    saveSectionCollapsed('conversations', true)
    const raw = window.localStorage.getItem('maia:sidebarSections')
    expect(raw).toBeTruthy()
    // Re-parse as a fresh session would.
    const parsed = JSON.parse(raw as string) as Record<SidebarSectionId, boolean>
    expect(parsed.conversations).toBe(true)
    expect(parsed.pinned).toBeUndefined()
  })

  it('ignores corrupt storage', () => {
    window.localStorage.setItem('maia:sidebarSections', '{not json')
    expect(loadSectionCollapsed('conversations')).toBe(false)
  })
})
