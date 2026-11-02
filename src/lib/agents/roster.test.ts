import { describe, expect, it } from 'vitest'
import {
  activityLine, latestConversation, LONG_RUN_NOTIFICATION_MS, presenceFor, reorderRoster,
  shouldNotify, sortRoster, unreadFor, type RosterAgent, type RosterConversation,
} from './roster'

const agent = (id: string): RosterAgent => ({
  id: `profile:${id}`, name: id, hermesProfile: id, status: 'running', region: 'local',
  summary: '', createdAt: '2026-10-01T00:00:00Z',
})
const conv = (id: string, agentId: string, at: string, extra = {}): RosterConversation => ({
  id, title: id, target: { type: 'agent', agentId: `profile:${agentId}` },
  createdAt: at, lastUsedAt: at, ...extra,
})
const now = Date.parse('2026-10-06T12:00:00Z')

describe('sortRoster', () => {
  it('pins first in user order, then recent activity, without mutating input', () => {
    const agents = ['a', 'b', 'c', 'd'].map(agent)
    const conversations = [conv('1', 'a', '2026-10-06'), conv('2', 'b', '2026-10-05')]
    expect(sortRoster(agents, conversations, { pinnedOrder: ['profile:d', 'profile:c'] })
      .map((a) => a.name)).toEqual(['d', 'c', 'a', 'b'])
    expect(agents.map((a) => a.name)).toEqual(['a', 'b', 'c', 'd'])
  })
  it('hides profiles by name or id and excludes scratch unless enabled', () => {
    const agents = ['a', 'b', 'session-fake'].map(agent)
    expect(sortRoster(agents, [], { hiddenProfiles: ['a'] }).map((a) => a.name)).toEqual(['b'])
    expect(sortRoster(agents, [], { hiddenProfiles: ['profile:b'], showScratch: true })
      .map((a) => a.name)).toEqual(['a', 'session-fake'])
  })
  it('uses all sources and lastActivityAt, with deterministic invalid-time ties', () => {
    const conversations = [conv('1', 'a', 'invalid'), conv('2', 'b', '2026-10-01', {
      source: 'cron', lastActivityAt: '2026-10-06',
    })]
    expect(sortRoster(['a', 'b'].map(agent), conversations).map((a) => a.name)).toEqual(['b', 'a'])
    expect(latestConversation('profile:b', conversations)?.id).toBe('2')
  })
})

describe('unreadFor', () => {
  it('sums all sessions once, ignores groups/other agents, and respects explicit read state', () => {
    const conversations = [
      conv('1', 'a', '', { hasUnread: true, unreadCount: 3 }),
      conv('2', 'a', '', { unread: 2 }),
      conv('3', 'a', '', { hasUnread: false, unreadCount: 9 }),
      conv('4', 'b', '', { hasUnread: true }),
      conv('5', 'a', '', { target: { type: 'group', groupId: 'g' }, unreadCount: 100 }),
    ]
    expect(unreadFor('profile:a', [...conversations, conversations[0]])).toBe(5)
  })
  it('normalizes booleans, negative, fractional and non-finite counts', () => {
    expect(unreadFor('profile:a', [
      conv('1', 'a', '', { hasUnread: true, unreadCount: 0 }),
      conv('2', 'a', '', { unread: true }),
      conv('3', 'a', '', { unreadCount: -5 }),
      conv('4', 'a', '', { unreadCount: NaN }),
      conv('5', 'a', '', { unreadCount: 2.9 }),
    ])).toBe(4)
  })
})

describe('activity and presence', () => {
  it('prioritizes a live browser tool and displays only its hostname', () => {
    const activity = {
      liveTool: { name: 'browser_navigate', url: 'https://fake-user:fake-password@en.wikipedia.org/wiki/Fake?q=fake-token' },
      lastActivityDescription: 'Old activity', lastActivityAt: '2026-10-06T11:00:00Z',
    }
    expect(activityLine(activity, now)).toBe('Browsing en.wikipedia.org')
    expect(presenceFor(activity)).toBe('browsing')
  })
  it('formats terminal tools, malformed browser URLs and ordinary tools', () => {
    expect(activityLine({ liveTool: { name: 'terminal' } }, now)).toBe('Running terminal')
    expect(activityLine({ liveTool: { name: 'browser_click', url: 'not a url' } }, now)).toBe('Browsing the web')
    expect(activityLine({ liveTool: { name: 'unknown_tool' } }, now)).toBe('Working')
    expect(presenceFor({ liveTool: { name: 'terminal' } })).toBe('tool')
  })
  it('ignores completed tools, then uses description ahead of time', () => {
    const activity = {
      liveTool: { name: 'browser_navigate', status: 'completed' },
      lastActivityDescription: '  Finished\nresearch  ', lastActivityAt: '2026-10-06T11:00:00Z',
    }
    expect(activityLine(activity, now)).toBe('Finished research')
    expect(presenceFor(activity)).toBe('idle')
  })
  it('formats relative times and tolerates absent/invalid/future values', () => {
    expect(activityLine({ lastActivityAt: '2026-10-06T11:58:00Z' }, now)).toBe('2m ago')
    expect(activityLine({ lastActivityAt: '2026-10-06T10:00:00Z' }, now)).toBe('2h ago')
    expect(activityLine({ lastActivityAt: '2026-10-04T12:00:00Z' }, now)).toBe('2d ago')
    expect(activityLine({ lastActivityAt: '2026-10-07T12:00:00Z' }, now)).toBe('Just now')
    expect(activityLine({ lastActivityAt: 'invalid' }, now)).toBe('')
    expect(activityLine({}, now)).toBe('')
  })
  it('approval and clarify presence outrank live tools and thinking', () => {
    expect(presenceFor({ waitingApproval: true, liveTool: { name: 'browser' } })).toBe('waiting-approval')
    expect(presenceFor({ waitingClarify: true, thinking: true })).toBe('waiting-approval')
    expect(presenceFor({ live: true })).toBe('thinking')
    expect(presenceFor({ thinking: true })).toBe('thinking')
    expect(presenceFor({})).toBe('idle')
  })
})

describe('reorderRoster', () => {
  it('moves in either direction, pins displayed order and retains hidden pins', () => {
    expect(reorderRoster(['a', 'b', 'c'], 'c', 'a', ['hidden'])).toEqual(['c', 'a', 'b', 'hidden'])
    expect(reorderRoster(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
  })
  it('ignores no-op and foreign drags', () => {
    expect(reorderRoster(['a', 'b'], 'x', 'b', ['p'])).toEqual(['p'])
    expect(reorderRoster(['a', 'b'], 'a', 'a', ['p'])).toEqual(['p'])
  })
})

describe('notification policy', () => {
  it('notifies approvals and clarify questions', () => {
    expect(shouldNotify({ kind: 'approval' })).toBe(true)
    expect(shouldNotify({ kind: 'clarify' })).toBe(true)
  })
  it('notifies only long completed runs while unfocused', () => {
    const event = { kind: 'finished' as const, startedAt: new Date(now).toISOString(),
      finishedAt: new Date(now + LONG_RUN_NOTIFICATION_MS).toISOString(), windowFocused: false }
    expect(shouldNotify(event)).toBe(true)
    expect(shouldNotify({ ...event, windowFocused: true })).toBe(false)
    expect(shouldNotify({ ...event, finishedAt: new Date(now + 1000).toISOString() })).toBe(false)
    expect(shouldNotify({ ...event, startedAt: 'invalid' })).toBe(false)
  })
})
