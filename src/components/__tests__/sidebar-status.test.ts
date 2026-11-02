import { describe, expect, it } from 'vitest'
import { conversationIsLive, conversationSubtitle, conversationTitle, sidebarChromeMenuItems, sidebarOrbPaused, sidebarRosterPlaceholder, sidebarRowMenuItems, sidebarRowText } from '../Sidebar'
import { agentOrbExpression, collectLiveConversationIds } from '../../lib/agents'
import type { Agent, Conversation, Group } from '../../lib/agents'

function agent(id: string, name: string, status: Agent['status']): Agent {
  return {
    id,
    name,
    status,
    region: 'fsn1',
    createdAt: '2026-08-12T12:00:00Z',
    summary: '',
  }
}

const conv = (id: string, agentId: string): Conversation => ({
  id,
  title: 't',
  target: { type: 'agent', agentId },
  createdAt: '2026-08-12T12:00:00Z',
  lastUsedAt: '2026-08-12T12:00:00Z',
})

describe('agentOrbExpression', () => {
  it('uses working only when live, never thinking dots for provisioning', () => {
    expect(agentOrbExpression(agent('a', 'A', 'running'), true)).toBe('working')
    expect(agentOrbExpression(agent('a', 'A', 'provisioning'), false)).toBe('listening')
    expect(agentOrbExpression(agent('a', 'A', 'stopped'), false)).toBe('sleeping')
    expect(agentOrbExpression(agent('a', 'A', 'error'), false)).toBe('error')
    expect(agentOrbExpression(agent('a', 'A', 'running'), false)).toBe('idle')
  })
})

describe('sidebar conversation status (honest idle vs running)', () => {
  const local = agent('inst_local', 'Local Hermes', 'running')
  const profile = agent('profile:research', 'Research', 'running')
  const groups: Group[] = []

  it('uses the agent name as the row title, not the session title', () => {
    expect(conversationTitle(conv('c1', 'inst_local'), [local], groups)).toBe('Local Hermes')
  })

  it('stays silent when idle — the title already names the agent (Grok parity)', () => {
    expect(conversationSubtitle(conv('c1', 'inst_local'), [local], groups)).toBeNull()
  })

  it('shows running when the agent has a live subagent run', () => {
    const live = new Set(['inst_local'])
    expect(conversationSubtitle(conv('c1', 'inst_local'), [local], groups, live)).toBe('working')
  })

  it('shows running for an in-flight conversation even after switching away', () => {
    const liveIds = new Set(['c1'])
    expect(conversationSubtitle(conv('c1', 'inst_local'), [local], groups, undefined, liveIds)).toBe(
      'working',
    )
    expect(conversationSubtitle(conv('c2', 'inst_local'), [local], groups, undefined, liveIds)).toBeNull()
    expect(conversationIsLive(conv('c1', 'inst_local'), undefined, liveIds)).toBe(true)
    expect(conversationIsLive(conv('c2', 'inst_local'), undefined, liveIds)).toBe(false)
  })

  it('omits origin text for profile agents (no "remote" jargon)', () => {
    expect(conversationSubtitle(conv('c1', 'profile:research'), [profile], groups)).toBeNull()
  })

  it('omits origin text for region=remote user agents', () => {
    const news = agent('inst_news', 'NewsBot', 'running')
    news.region = 'remote'
    expect(conversationSubtitle(conv('c1', 'inst_news'), [news], groups)).toBeNull()
  })

  it('shows updating while the linked VM is installing tools', () => {
    const news = agent('inst_news', 'NewsBot', 'running')
    news.region = 'remote'
    expect(
      conversationSubtitle(conv('c1', 'inst_news'), [news], groups, undefined, undefined, 'updating'),
    ).toBe('updating')
  })

  it('falls back to "agent" when the target agent is unknown', () => {
    expect(conversationSubtitle(conv('c1', 'nope'), [local], groups)).toBe('agent')
  })

  it('shows member count for groups', () => {
    const g: Group = {
      id: 'grp1',
      name: 'Ops Desk',
      memberAgentIds: ['a', 'b'],
      primaryAgentId: 'a',
      createdAt: '2026-08-12T12:00:00Z',
    }
    const groupConv: Conversation = {
      id: 'c1',
      title: 't',
      target: { type: 'group', groupId: 'grp1' },
      createdAt: '2026-08-12T12:00:00Z',
      lastUsedAt: '2026-08-12T12:00:00Z',
    }
    expect(conversationSubtitle(groupConv, [local], [g])).toBe('2 members')
  })

  it('shows running for a group conversation that is in-flight after switching away', () => {
    const g: Group = {
      id: 'grp1',
      name: 'Ops Desk',
      memberAgentIds: ['inst_local', 'inst_other'],
      primaryAgentId: 'inst_local',
      createdAt: '2026-08-12T12:00:00Z',
    }
    const groupConv: Conversation = {
      id: 'c-group',
      title: 't',
      target: { type: 'group', groupId: 'grp1' },
      createdAt: '2026-08-12T12:00:00Z',
      lastUsedAt: '2026-08-12T12:00:00Z',
    }
    const liveIds = new Set(['c-group'])
    expect(conversationIsLive(groupConv, undefined, liveIds)).toBe(true)
    expect(conversationSubtitle(groupConv, [local], [g], undefined, liveIds)).toBe(
      '2 members · working',
    )
  })

  it('shows running for a group when a member has a live subagent', () => {
    const g: Group = {
      id: 'grp1',
      name: 'Ops Desk',
      memberAgentIds: ['inst_local', 'inst_other'],
      primaryAgentId: 'inst_local',
      createdAt: '2026-08-12T12:00:00Z',
    }
    const groupConv: Conversation = {
      id: 'c-group',
      title: 't',
      target: { type: 'group', groupId: 'grp1' },
      createdAt: '2026-08-12T12:00:00Z',
      lastUsedAt: '2026-08-12T12:00:00Z',
    }
    const liveSub = new Set(['inst_local'])
    expect(conversationIsLive(groupConv, liveSub, undefined, g.memberAgentIds)).toBe(true)
    expect(conversationSubtitle(groupConv, [local], [g], liveSub)).toBe('2 members · working')
  })
})

describe('sidebarRowText (Grok row parity: title + snippet/time)', () => {
  const local = agent('inst_local', 'Local Hermes', 'running')
  const groups: Group[] = []
  const withPreview = (id: string, agentId: string): Conversation => ({
    ...conv(id, agentId),
    preview: 'Extra tests on PR 10 SHIPed. HEAD is green',
  })

  it('falls back to the stored preview when idle', () => {
    expect(sidebarRowText(withPreview('c1', 'inst_local'), [local], groups)).toMatchObject({
      title: 'Local Hermes',
      sub: 'Extra tests on PR 10 SHIPed. HEAD is green',
    })
  })

  it('prefers live state over a stale preview', () => {
    const live = new Set(['inst_local'])
    expect(sidebarRowText(withPreview('c1', 'inst_local'), [local], groups, live).sub).toBe('working')
  })

  it('stays silent with neither live state nor preview', () => {
    expect(sidebarRowText(conv('c1', 'inst_local'), [local], groups).sub).toBeNull()
  })

  it('carries the Grok-style relative time', () => {
    const c: Conversation = { ...conv('c1', 'inst_local'), lastUsedAt: '2026-08-12T08:41:00' }
    expect(sidebarRowText(c, [local], groups).time).toMatch(/^\d+d ago$/)
  })
})

describe('sidebar orb pause budget (M1: one heavy mascot)', () => {
  it('freezes every row mascot, live or idle — the activity line is the only unpaused orb', () => {
    expect(sidebarOrbPaused(true, true)).toBe(true)
    expect(sidebarOrbPaused(true, false)).toBe(true)
    expect(sidebarOrbPaused(false, true)).toBe(true)
    expect(sidebarOrbPaused(false, false)).toBe(true)
  })

  it('keeps the signature stable for mobile home / featured-row callers', () => {
    // Same budget from MobileHome + FeaturedAgentsRow: still = sidebarOrbPaused(focused, live).
    expect(sidebarOrbPaused(true, true)).toBe(sidebarOrbPaused(false, false))
  })
})

describe('collectLiveConversationIds', () => {
  it('unions in-flight ids with streaming threads', () => {
    const ids = collectLiveConversationIds(['c-send'], {
      'c-stream': [{ streaming: true }],
      'c-done': [{ streaming: false }],
      'c-empty': [],
    })
    expect([...ids].sort()).toEqual(['c-send', 'c-stream'])
  })
})

describe('sidebar context menu models (Grok parity)', () => {
  const agentConv: Conversation = {
    id: 'c1',
    title: 'Flights',
    target: { type: 'agent', agentId: 'inst_local' },
    createdAt: '2026-08-12T12:00:00Z',
    lastUsedAt: '2026-08-12T12:00:00Z',
  }
  const groupConv: Conversation = {
    id: 'c-g',
    title: 'Ops',
    target: { type: 'group', groupId: 'grp1' },
    createdAt: '2026-08-12T12:00:00Z',
    lastUsedAt: '2026-08-12T12:00:00Z',
  }

  it('chrome: omits join; shows new shared room when canCreateGroup; hidden only when count > 0', () => {
    expect(sidebarChromeMenuItems({ hiddenCount: 0 }).map((i) => i.id)).toEqual([])
    expect(sidebarChromeMenuItems({ hiddenCount: 0, canCreateGroup: true }).map((i) => i.label)).toEqual([
      'New shared room…',
    ])
    expect(sidebarChromeMenuItems({ hiddenCount: 3, canCreateGroup: true }).map((i) => i.label)).toEqual([
      'New shared room…',
      'Hidden chats (3)',
    ])
    expect(sidebarChromeMenuItems({ hiddenCount: 2 }).map((i) => i.label)).toEqual(['Hidden chats (2)'])
  })

  it('row: pin/unread/edit/duplicate/copy/hide/delete for an agent', () => {
    expect(sidebarRowMenuItems(agentConv, { hasAgent: true }).map((i) => i.label)).toEqual([
      'Pin',
      'Mark as Unread',
      'Edit Profile',
      'Duplicate',
      'Copy conversation ID',
      'Hide from sidebar',
      'Delete',
    ])
    expect(sidebarRowMenuItems(agentConv, { hasAgent: true }).find((i) => i.id === 'delete')?.danger).toBe(true)
  })

  it('row: Unpin / Mark as Read when pinned and unread', () => {
    const labels = sidebarRowMenuItems(
      { ...agentConv, pinned: true, hasUnread: true },
      { hasAgent: true },
    ).map((i) => i.label)
    expect(labels.slice(0, 2)).toEqual(['Unpin', 'Mark as Read'])
  })

  it('row: omits Duplicate for groups; Edit Profile only when hasAgent', () => {
    const withAgent = sidebarRowMenuItems(groupConv, { hasAgent: true }).map((i) => i.id)
    expect(withAgent).toContain('edit-profile')
    expect(withAgent).not.toContain('duplicate')
    const without = sidebarRowMenuItems(groupConv, { hasAgent: false }).map((i) => i.id)
    expect(without).not.toContain('edit-profile')
    expect(without).not.toContain('duplicate')
  })

  it('row: omits hide/delete when handlers are missing', () => {
    const ids = sidebarRowMenuItems(agentConv, { hasAgent: true, canHide: false, canDelete: false }).map(
      (i) => i.id,
    )
    expect(ids).not.toContain('hide')
    expect(ids).not.toContain('delete')
  })
})

describe('sidebarRosterPlaceholder (loading vs empty)', () => {
  it('shows a loading skeleton while hydrate is in flight with zero items', () => {
    expect(sidebarRosterPlaceholder(0, true)).toBe('loading')
  })

  it('shows true empty only after hydrate settled at zero', () => {
    expect(sidebarRosterPlaceholder(0, false)).toBe('empty')
  })

  it('hides the placeholder when cached/live items already exist', () => {
    expect(sidebarRosterPlaceholder(2, true)).toBeNull()
    expect(sidebarRosterPlaceholder(1, false)).toBeNull()
  })
})

