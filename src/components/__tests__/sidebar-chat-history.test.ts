import { describe, expect, it } from 'vitest'
import { sidebarChromeMenuItems, sidebarRowMenuItems } from '../Sidebar'

describe('sidebar chat-history entry points', () => {
  it('offers Chat history in the sidebar menu only when available', () => {
    expect(sidebarChromeMenuItems({ hiddenCount: 0, canOpenChatHistory: true }).map((i) => i.id)).toEqual([
      'chat-history',
    ])
    expect(sidebarChromeMenuItems({ hiddenCount: 0 }).map((i) => i.id)).toEqual([])
  })

  it('offers Export chat on a row only when allowed', () => {
    const conv = { pinned: false, hasUnread: false, target: { type: 'agent' as const, agentId: 'a' } }
    expect(sidebarRowMenuItems(conv, { canExport: true }).map((i) => i.id)).toContain('export-chat')
    expect(sidebarRowMenuItems(conv).map((i) => i.id)).not.toContain('export-chat')
  })
})
