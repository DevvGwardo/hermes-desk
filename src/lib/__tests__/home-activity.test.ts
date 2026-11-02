import { describe, expect, it } from 'vitest'
import { buildHomeActivity, homeGreeting, homeSection, homeSummary } from '../home-activity'
import type { RosterAgent, RosterConversation } from '../agents/roster'
import type { ChatMessage, Group } from '../agents/types'

const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime()
const at = (daysAgo: number, hour = 10) => {
  const d = new Date(NOW)
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}
const agent = (id: string, name: string, extra: Partial<RosterAgent> = {}): RosterAgent => ({
  id, name, hermesProfile: id.replace('profile:', ''), status: 'running', region: 'local', summary: '', createdAt: at(30), ...extra,
} as RosterAgent)
const conv = (id: string, agentId: string, lastUsedAt: string, extra: Partial<RosterConversation> = {}): RosterConversation => ({
  id, title: `Chat ${id}`, target: { type: 'agent', agentId }, createdAt: lastUsedAt, lastUsedAt, ...extra,
})
const agents = [agent('profile:ada', 'Ada'), agent('profile:bo', 'Bo')]

describe('buildHomeActivity', () => {
  it('sorts newest first into day buckets and picks the newest agent as focus', () => {
    const result = buildHomeActivity({ agents, groups: [], now: NOW, conversations: [
      conv('old', 'profile:ada', at(20)), conv('wk', 'profile:ada', at(3)),
      conv('yd', 'profile:bo', at(1)), conv('td', 'profile:bo', at(0, 14)),
    ] })
    expect(result.sections.map((s) => [s.id, s.items.map((i) => i.conversationId)])).toEqual([
      ['today', ['td']], ['yesterday', ['yd']], ['week', ['wk']], ['earlier', ['old']],
    ])
    expect(result.total).toBe(4)
    expect(result.focusAgentId).toBe('profile:bo')
    expect(result.sections[0].items[0]).toMatchObject({ who: 'Bo', title: 'Chat td', when: '1h ago' })
  })

  it('pins waiting chats to Needs you on the agent’s newest thread', () => {
    const result = buildHomeActivity({ agents, groups: [], now: NOW,
      activityByAgent: { 'profile:ada': { waitingApproval: true }, 'profile:bo': { waitingClarify: true } },
      conversations: [conv('a1', 'profile:ada', at(2)), conv('a2', 'profile:ada', at(0, 9)), conv('b1', 'profile:bo', at(1))] })
    expect(result.sections[0]).toMatchObject({ id: 'needs-you', label: 'Needs you' })
    expect(result.sections[0].items.map((i) => [i.conversationId, i.needs])).toEqual([['a2', 'approval'], ['b1', 'answer']])
    expect(result.needsCount).toBe(2)
    expect(result.sections.flatMap((s) => s.items).filter((i) => i.conversationId === 'a2')).toHaveLength(1)
  })

  it('drops hidden, placeholder, hidden-profile, scratch and orphan threads', () => {
    const result = buildHomeActivity({ now: NOW, groups: [],
      agents: [...agents, agent('profile:session-x', 'Scratch')], prefs: { hiddenProfiles: ['bo'] },
      conversations: [
        conv('ok', 'profile:ada', at(0)), conv('dup', 'profile:ada', at(0)), conv('dup', 'profile:ada', at(0)),
        conv('hid', 'profile:ada', at(0), { hiddenFromSidebar: true }), conv('ph', 'profile:ada', at(0), { placeholder: true }),
        conv('bo', 'profile:bo', at(0)), conv('scr', 'profile:session-x', at(0)), conv('gone', 'profile:missing', at(0)),
      ] })
    expect(result.sections.flatMap((s) => s.items).map((i) => i.conversationId).sort()).toEqual(['dup', 'ok'])
  })

  it('limits the recent rows but keeps the full total', () => {
    const conversations = Array.from({ length: 20 }, (_, i) => conv(`c${i}`, 'profile:ada', at(0, 1 + (i % 12))))
    const result = buildHomeActivity({ agents, groups: [], conversations, now: NOW, limit: 5 })
    expect(result.sections.flatMap((s) => s.items)).toHaveLength(5)
    expect(result.total).toBe(20)
  })

  it('derives titles, previews, live state and unread counts', () => {
    const messages = { m: [
      { id: '1', threadId: 'm', role: 'user', content: 'hi', createdAt: at(0) },
      { id: '2', threadId: 'm', role: 'agent', content: '**Booked** the [table](https://x.invalid)', createdAt: at(0) },
    ] as ChatMessage[] }
    const result = buildHomeActivity({ agents, groups: [], now: NOW, messagesByThreadId: messages,
      liveConversationIds: new Set(['live']),
      activityByAgent: { 'profile:bo': { live: true, liveTool: { name: 'terminal', status: 'running' } } },
      conversations: [
        conv('m', 'profile:ada', at(0, 13), { title: 'New conversation', unreadCount: 3 }),
        conv('p', 'profile:ada', at(0, 12), { preview: 'x'.repeat(300), hasUnread: true }),
        conv('live', 'profile:bo', at(0, 14), { preview: 'stale preview' }),
        conv('echo', 'profile:ada', at(0, 11), { title: 'Plan the trip', preview: 'Plan the trip' }),
      ] })
    const byId = Object.fromEntries(result.sections.flatMap((s) => s.items).map((i) => [i.conversationId, i]))
    expect(byId.m).toMatchObject({ title: 'Ada', preview: 'Booked the table', unread: 3, live: false })
    expect(byId.p.preview).toHaveLength(140)
    expect(byId.p.unread).toBe(1)
    expect(byId.live).toMatchObject({ live: true, preview: 'Running terminal' })
    expect(byId.echo.preview).toBe('')
    expect(result.liveCount).toBe(1)
  })

  it('uses validated GenUI widget summaries when the newest turn is a tool-only render_ui reply', () => {
    const messages: Record<string, ChatMessage[]> = {
      genui: [
        { id: '1', threadId: 'genui', role: 'user', content: 'Show release readiness', createdAt: at(0, 12) },
        {
          id: '2',
          threadId: 'genui',
          role: 'agent',
          content: '',
          createdAt: at(0, 13),
          toolEvents: [
            {
              tool: 'mcp__hermes_desk__render_ui',
              toolCallId: 'ui-ok',
              status: 'completed',
              genui: {
                version: 1,
                components: [
                  { type: 'stat', title: 'Release readiness', value: 'Green', detail: 'All gates passed' },
                  { type: 'checklist', title: 'Next steps', items: [{ id: 's1', label: 'Tag release' }] },
                ],
              },
            },
          ],
        },
        {
          id: '3',
          threadId: 'genui',
          role: 'agent',
          content: '',
          createdAt: at(0, 14),
          toolEvents: [
            {
              tool: 'render_ui',
              toolCallId: 'ui-failed',
              status: 'failed',
              genui: {
                version: 1,
                components: [{ type: 'stat', title: 'Broken card', value: 'Ignore me' }],
              },
            },
          ],
        },
      ],
    }
    const result = buildHomeActivity({
      agents,
      groups: [],
      now: NOW,
      messagesByThreadId: messages,
      conversations: [conv('genui', 'profile:ada', at(0, 14), { title: 'Show release readiness' })],
    })
    expect(result.sections[0].items[0]?.preview).toBe(
      'Release readiness: Green (All gates passed) · Next steps: Tag release',
    )
  })

  it('names group rooms and uses their primary agent for the avatar', () => {
    const group: Group = { id: 'g1', name: 'Launch room', memberAgentIds: ['profile:ada', 'profile:bo'], primaryAgentId: 'profile:bo', createdAt: at(9) }
    const result = buildHomeActivity({ agents, groups: [group], now: NOW, conversations: [
      { id: 'gc', title: 'Plan', target: { type: 'group', groupId: 'g1' }, createdAt: at(0), lastUsedAt: at(0) },
    ] })
    expect(result.sections[0].items[0]).toMatchObject({ who: 'Launch room', agentId: 'profile:bo', groupId: 'g1' })
  })

  it('falls back to the first visible agent with no conversations', () => {
    expect(buildHomeActivity({ agents, groups: [], conversations: [], now: NOW })).toMatchObject({
      sections: [], total: 0, focusAgentId: 'profile:ada',
    })
    expect(buildHomeActivity({ agents: [], groups: [], conversations: [], now: NOW }).focusAgentId).toBeNull()
  })
})

describe('home copy', () => {
  it('buckets by local calendar day', () => {
    expect(homeSection(new Date(2026, 9, 7, 0, 1).getTime(), NOW)).toBe('today')
    expect(homeSection(new Date(2026, 9, 6, 23, 59).getTime(), NOW)).toBe('yesterday')
    expect(homeSection(new Date(2026, 9, 1, 12).getTime(), NOW)).toBe('week')
    expect(homeSection(new Date(2026, 8, 20).getTime(), NOW)).toBe('earlier')
  })
  it('greets by time of day', () => {
    expect(homeGreeting(new Date(2026, 9, 7, 8).getTime())).toBe('Good morning')
    expect(homeGreeting(new Date(2026, 9, 7, 13).getTime())).toBe('Good afternoon')
    expect(homeGreeting(new Date(2026, 9, 7, 22).getTime())).toBe('Good evening')
    expect(homeGreeting(new Date(2026, 9, 7, 2).getTime())).toBe('Good evening')
  })
  it('summarises what needs attention first', () => {
    expect(homeSummary({ needsCount: 1, liveCount: 2, total: 5 })).toBe('1 chat needs you')
    expect(homeSummary({ needsCount: 2, liveCount: 0, total: 5 })).toBe('2 chats need you')
    expect(homeSummary({ needsCount: 0, liveCount: 1, total: 5 }, 'Ada')).toBe('Ada is working on something')
    expect(homeSummary({ needsCount: 0, liveCount: 3, total: 5 })).toBe('3 chats in progress')
    expect(homeSummary({ needsCount: 0, liveCount: 0, total: 5 })).toBe('All caught up')
    expect(homeSummary({ needsCount: 0, liveCount: 0, total: 0 })).toBe('No activity yet')
  })
})
