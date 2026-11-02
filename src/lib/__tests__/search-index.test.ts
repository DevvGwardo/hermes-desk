import { describe, expect, it } from 'vitest'
import type { Agent, ChatMessage, Conversation, Group } from '../agents/types'
import {
  buildSearchRows,
  collectSearchCorpus,
  emptyCopy,
  extractLinks,
  findChatHits,
  highlightSegments,
  shortcutIndex,
  tokenize,
  type SearchIndexInput,
} from '../search-index'

function agent(partial: Partial<Agent> & Pick<Agent, 'id' | 'name'>): Agent {
  return {
    status: 'running',
    region: 'fsn1',
    createdAt: '2026-08-14T00:00:00Z',
    summary: 'A specialist.',
    ...partial,
  }
}

const qa = agent({
  id: 'qa',
  name: 'QA Engineer',
  persona: {
    title: 'QA',
    description: 'Clicks through every new GitHub deploy and reports what breaks.',
  },
})
const re = agent({
  id: 're',
  name: 'Reverse Engineer',
  persona: {
    title: 'Reverse engineer',
    description: 'Reverse-engineer Grok Bot into a buildable product architecture.',
  },
})
const ops = agent({ id: 'ops', name: 'DevOps Engineer', summary: 'Platform + cron.' })

const desk: Group = {
  id: 'grp',
  name: 'Ops Desk',
  memberAgentIds: ['qa', 're'],
  primaryAgentId: 'qa',
  createdAt: '2026-08-14T00:00:00Z',
  summary: 'Shared room',
}

const input: SearchIndexInput = {
  agents: [qa, re, ops],
  hiddenAgents: [agent({ id: 'hid', name: 'Hidden Bot', summary: 'archived specialist' })],
  groups: [desk],
  commands: [
    { id: 'open-kanban', label: 'Open Kanban', keywords: ['board', 'tasks'], detail: 'Board' },
    { id: 'settings', label: 'Settings', keywords: ['prefs'], detail: 'App' },
  ],
  messages: [
    {
      messageId: 'm1',
      conversationId: 'c1',
      conversationTitle: 'Deploy check',
      snippet: 'Happy eyes at 28/40 are a pass now.',
      agentName: 'QA Engineer',
    },
  ],
  files: [{ path: '/opt/data/workspace/app/src/App.tsx', label: 'App.tsx', conversationTitle: 'Deploy check' }],
  links: [{ url: 'https://github.com/DevvGwardo/yeti-trader', conversationTitle: 'Deploy check' }],
  routines: [{ id: 'cron1', name: 'Nightly audit', schedule: '0 2 * * *', enabled: true }],
}

describe('tokenize / extractLinks / shortcutIndex', () => {
  it('splits on punctuation and case', () => {
    expect(tokenize('  Reverse-Engineer  Grok  ')).toEqual(['reverse', 'engineer', 'grok'])
  })

  it('extracts unique http(s) urls and strips trailing punctuation', () => {
    expect(
      extractLinks('see https://example.com/a, and http://127.0.0.1:5173/ plus https://example.com/a.'),
    ).toEqual(['https://example.com/a', 'http://127.0.0.1:5173/'])
  })

  it('assigns ⌘1–⌘9 only', () => {
    expect(shortcutIndex(0)).toBe(1)
    expect(shortcutIndex(8)).toBe(9)
    expect(shortcutIndex(9)).toBeNull()
    expect(shortcutIndex(-1)).toBeNull()
  })
})

describe('findChatHits / highlightSegments', () => {
  const thread = [
    { id: 'u1', role: 'user', content: 'Happy eyes at 28/40 are a pass now.' },
    { id: 'a1', role: 'agent', content: 'Deploy check landed on the cube.' },
    { id: 's1', role: 'system', content: 'Happy eyes internally' },
  ]

  it('returns messages whose content contains every query token', () => {
    expect(findChatHits(thread, 'happy eyes').map((h) => h.messageId)).toEqual(['u1'])
    expect(findChatHits(thread, 'cube').map((h) => h.messageId)).toEqual(['a1'])
    expect(findChatHits(thread, '')).toEqual([])
  })

  it('skips system messages', () => {
    expect(findChatHits(thread, 'internally')).toEqual([])
  })

  it('matches validated GenUI widget text in tool-only and mixed turns while ignoring unvalidated render_ui events', () => {
    const genuiThread: ChatMessage[] = [
      {
        id: 'g-tool-only',
        threadId: 'c1',
        role: 'agent',
        content: '',
        createdAt: '2026-10-13T12:00:00Z',
        toolEvents: [
          {
            tool: 'mcp__hermes_desk__render_ui',
            toolCallId: 'call-1',
            status: 'completed',
            genui: {
              version: 1,
              components: [
                { type: 'stat', title: 'Deploy status', value: '99.98%', detail: 'Canary green' },
                { type: 'table', title: 'Region latency', columns: ['Region', 'p95'], rows: [['us-east', 42]] },
                { type: 'bar_chart', title: 'Token split', unit: 'k', items: [{ label: 'Planner', value: 18 }] },
                { type: 'checklist', title: 'Release gates', items: [{ id: 'g1', label: 'Verify bundle ceiling' }] },
              ],
            },
          },
        ],
      },
      {
        id: 'g-mixed',
        threadId: 'c1',
        role: 'agent',
        content: 'Summary attached below.',
        createdAt: '2026-10-13T12:01:00Z',
        toolEvents: [
          {
            tool: 'render_ui',
            toolCallId: 'call-2',
            status: 'completed',
            genui: {
              version: 1,
              components: [{ type: 'stat', title: 'Cache hit rate', value: '94%' }],
            },
          },
        ],
      },
      {
        id: 'g-unverified',
        threadId: 'c1',
        role: 'agent',
        content: '',
        createdAt: '2026-10-13T12:02:00Z',
        toolEvents: [
          {
            tool: 'render_ui',
            toolCallId: 'call-3',
            status: 'failed',
            args: '{"version":1,"components":[{"type":"stat","title":"Unverified secret","value":"leak"}]}',
            genui: {
              version: 1,
              components: [{ type: 'stat', title: 'Unverified secret', value: 'leak' }],
            },
          },
        ],
      },
    ]

    expect(findChatHits(genuiThread, 'canary green').map((h) => h.messageId)).toEqual(['g-tool-only'])
    expect(findChatHits(genuiThread, 'us-east 42').map((h) => h.messageId)).toEqual(['g-tool-only'])
    expect(findChatHits(genuiThread, 'planner 18').map((h) => h.messageId)).toEqual(['g-tool-only'])
    expect(findChatHits(genuiThread, 'verify bundle ceiling').map((h) => h.messageId)).toEqual(['g-tool-only'])
    expect(findChatHits(genuiThread, 'summary cache 94').map((h) => h.messageId)).toEqual(['g-mixed'])
    expect(findChatHits(genuiThread, 'unverified secret')).toEqual([])
  })

  it('splits text so matching tokens are marked', () => {
    expect(highlightSegments('Happy eyes at 28/40', 'happy')).toEqual([
      { text: 'Happy', hit: true },
      { text: ' eyes at 28/40', hit: false },
    ])
    expect(highlightSegments('nope', 'missing')).toEqual([{ text: 'nope', hit: false }])
    expect(highlightSegments('Hello', '')).toEqual([{ text: 'Hello', hit: false }])
  })
})

describe('emptyCopy', () => {
  it('uses Grok verbatim empty states', () => {
    expect(emptyCopy('all')).toEqual({ label: 'No agents yet' })
    expect(emptyCopy('messages')).toEqual({
      label: 'Search messages',
      hint: 'Type to find messages across your chats.',
    })
    expect(emptyCopy('groups')).toEqual({ label: 'No group chats yet' })
    expect(emptyCopy('files')).toEqual({ label: 'No files yet' })
    expect(emptyCopy('links')).toEqual({ label: 'No links in this chat yet' })
    expect(emptyCopy('routines')).toEqual({
      label: 'No routines yet',
      hint: 'Routines are things your agent does on its own, on a schedule.',
    })
    expect(emptyCopy('actions')).toEqual({ label: 'No actions' })
    expect(emptyCopy('routines', { unavailable: true })).toEqual({
      label: 'Search unavailable',
      hint: 'Try again in a moment.',
    })
  })
})

describe('buildSearchRows', () => {
  it('empty All lists visible agents then actions, not messages', () => {
    const rows = buildSearchRows(input, 'all', '')
    expect(rows.map((r) => r.kind)).toEqual(['agent', 'agent', 'agent', 'action', 'action'])
    expect(rows.filter((r) => r.kind === 'agent').map((r) => r.label)).toEqual([
      'QA Engineer',
      'Reverse Engineer',
      'DevOps Engineer',
    ])
    expect(rows.some((r) => r.kind === 'message')).toBe(false)
    expect(rows.some((r) => r.kind === 'agent' && r.kind === 'agent' && r.hidden)).toBe(false)
  })

  it('empty Messages returns nothing (hint is UI-only)', () => {
    expect(buildSearchRows(input, 'messages', '')).toEqual([])
  })

  it('empty Groups / Files / Links / Routines / Actions list their own items', () => {
    expect(buildSearchRows(input, 'groups', '').map((r) => r.label)).toEqual(['Ops Desk'])
    expect(buildSearchRows(input, 'files', '').map((r) => r.label)).toEqual(['App.tsx'])
    const link = buildSearchRows(input, 'links', '')[0]
    expect(link?.kind).toBe('link')
    if (link?.kind === 'link') expect(link.url).toBe('https://github.com/DevvGwardo/yeti-trader')
    expect(buildSearchRows(input, 'routines', '').map((r) => r.label)).toEqual(['Nightly audit'])
    expect(buildSearchRows(input, 'actions', '').map((r) => r.label)).toEqual(['Open Kanban', 'Settings'])
  })

  it('routine rows carry their origin so same-id jobs stay distinct', () => {
    const rows = buildSearchRows(
      {
        ...input,
        routines: [
          { id: 'abc123', origin: 'remote', name: 'Agent digest' },
          { id: 'abc123', origin: 'hermes', name: 'Host digest' },
        ],
      },
      'routines',
      '',
    )
    expect(rows.map((r) => r.id)).toEqual(['routine:remote:abc123', 'routine:hermes:abc123'])
    expect(rows.map((r) => (r.kind === 'routine' ? r.origin : null))).toEqual(['remote', 'hermes'])
  })

  it('typed query finds a message and a hidden agent', () => {
    const msgs = buildSearchRows(input, 'messages', 'happy eyes')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ kind: 'message', messageId: 'm1', conversationId: 'c1' })

    const hidden = buildSearchRows(input, 'all', 'hidden')
    expect(hidden.some((r) => r.kind === 'agent' && r.hidden && r.label === 'Hidden Bot')).toBe(true)
  })

  it('Agents tab never returns groups', () => {
    const rows = buildSearchRows(input, 'agents', 'ops')
    expect(rows.every((r) => r.kind === 'agent')).toBe(true)
    expect(rows.map((r) => r.label)).toEqual(['DevOps Engineer'])
  })
})

describe('collectSearchCorpus', () => {
  it('pulls messages, vm write paths, and urls from threads', () => {
    const conv: Conversation = {
      id: 'conv_alpha_deploy',
      title: 'Deploy check',
      target: { type: 'agent', agentId: 'qa' },
      createdAt: '2026-08-14T00:00:00Z',
      lastUsedAt: '2026-08-14T00:00:00Z',
    }
    const msg: ChatMessage = {
      id: 'm4',
      threadId: conv.id,
      role: 'agent',
      content: 'Landing is /opt/data/workspace/landing/index.html — preview http://127.0.0.1:5173/',
      createdAt: '2026-08-14T00:00:00Z',
      toolEvents: [
        {
          tool: 'write_file',
          status: 'completed',
          args: '{"file_path":"/opt/data/workspace/landing/index.html"}',
        },
      ],
    }
    const corpus = collectSearchCorpus({
      conversations: [conv],
      messagesByThreadId: { [conv.id]: [msg] },
      agents: [qa],
      groups: [],
    })
    expect(corpus.messages[0]?.snippet).toContain('Landing is')
    expect(corpus.files.map((f) => f.path)).toContain('/opt/data/workspace/landing/index.html')
    expect(corpus.links.map((l) => l.url)).toContain('http://127.0.0.1:5173/')
  })

  it('does not list a folder path as a previewable file', () => {
    const conv: Conversation = {
      id: 'c2',
      title: 'yo. what we building today',
      target: { type: 'agent', agentId: 'qa' },
      createdAt: '2026-08-14T00:00:00Z',
      lastUsedAt: '2026-08-14T00:00:00Z',
    }
    const corpus = collectSearchCorpus({
      conversations: [conv],
      messagesByThreadId: {
        c2: [
          {
            id: 'm',
            threadId: 'c2',
            role: 'agent',
            content: 'Wrote /opt/data/workspace/simple-site/index.html in /opt/data/workspace/simple-site',
            createdAt: '2026-08-14T00:00:00Z',
          },
        ],
      },
      agents: [qa],
      groups: [],
    })
    expect(corpus.files.map((f) => f.path)).toEqual(['/opt/data/workspace/simple-site/index.html'])
  })

  it('truncates message snippets to 180 chars', () => {
    const conv: Conversation = {
      id: 'c3',
      title: 'Long thread',
      target: { type: 'agent', agentId: 'qa' },
      createdAt: '2026-08-14T00:00:00Z',
      lastUsedAt: '2026-08-14T00:00:00Z',
    }
    const long = `${'x'.repeat(300)} http://127.0.0.1:5173/`
    const corpus = collectSearchCorpus({
      conversations: [conv],
      messagesByThreadId: {
        c3: [{ id: 'm', threadId: 'c3', role: 'agent', content: long, createdAt: '2026-08-14T00:00:00Z' }],
      },
      agents: [qa],
      groups: [],
    })
    const normalized = long.replace(/\s+/g, ' ').trim()
    expect(corpus.messages[0]?.snippet).toBe(normalized.slice(0, 180))
    expect(corpus.messages[0]?.snippet).toHaveLength(180)
  })

  it('indexes validated GenUI cards for Command Palette search and synthesizes readable snippets for tool-only turns', () => {
    const conv: Conversation = {
      id: 'c-genui',
      title: 'Telemetry review',
      target: { type: 'agent', agentId: 'qa' },
      createdAt: '2026-10-13T12:00:00Z',
      lastUsedAt: '2026-10-13T12:00:00Z',
    }
    const corpus = collectSearchCorpus({
      conversations: [conv],
      messagesByThreadId: {
        'c-genui': [
          {
            id: 'm-genui-only',
            threadId: 'c-genui',
            role: 'agent',
            content: '',
            createdAt: '2026-10-13T12:00:00Z',
            toolEvents: [
              {
                tool: 'mcp__hermes_desk__render_ui',
                toolCallId: 'ui-1',
                status: 'completed',
                genui: {
                  version: 1,
                  components: [
                    { type: 'stat', title: 'Deploy status', value: '99.98%', detail: 'Canary green' },
                    { type: 'table', title: 'Region latency', columns: ['Region', 'p95'], rows: [['us-east', 42]] },
                  ],
                },
              },
            ],
          },
          {
            id: 'm-genui-failed',
            threadId: 'c-genui',
            role: 'agent',
            content: '',
            createdAt: '2026-10-13T12:01:00Z',
            toolEvents: [
              {
                tool: 'render_ui',
                toolCallId: 'ui-2',
                status: 'failed',
                genui: {
                  version: 1,
                  components: [{ type: 'stat', title: 'Failed card', value: '0' }],
                },
              },
            ],
          },
        ],
      },
      agents: [qa],
      groups: [],
    })
    expect(corpus.messages).toHaveLength(1)
    expect(corpus.messages[0]?.messageId).toBe('m-genui-only')
    expect(corpus.messages[0]?.snippet).toContain('Deploy status: 99.98% (Canary green)')
    const rows = buildSearchRows({ ...input, messages: corpus.messages }, 'messages', 'us-east 42')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'message', conversationId: 'c-genui', messageId: 'm-genui-only' })
  })

  // search-dedupe-attribution: a file/url shared by several chats keeps every
  // chat's attribution, and rows dedupe so ids can never collide.
  it('keeps every chat attribution for a shared file path / url and never collides row ids', () => {
    const mkConv = (id: string, title: string): Conversation => ({
      id,
      title,
      target: { type: 'agent', agentId: 'qa' },
      createdAt: '2026-08-14T00:00:00Z',
      lastUsedAt: '2026-08-14T00:00:00Z',
    })
    const mkMsg = (id: string, threadId: string): ChatMessage => ({
      id,
      threadId,
      role: 'agent',
      content: 'see /opt/data/workspace/app/src/App.tsx https://github.com/DevvGwardo/yeti-trader',
      createdAt: '2026-08-14T00:00:00Z',
      toolEvents: [{ tool: 'write_file', status: 'completed', args: '{"file_path":"/opt/data/workspace/app/src/App.tsx"}' }],
    })
    const corpus = collectSearchCorpus({
      conversations: [mkConv('cA', 'First chat'), mkConv('cB', 'Second chat')],
      messagesByThreadId: { cA: [mkMsg('mA', 'cA')], cB: [mkMsg('mB', 'cB')] },
      agents: [qa],
      groups: [],
    })
    // One row per path/url, but no chat's attribution is dropped.
    expect(corpus.files).toHaveLength(1)
    expect(corpus.files[0]?.conversationTitle).toBe('First chat')
    expect(corpus.files[0]?.conversationTitles).toEqual(['First chat', 'Second chat'])
    expect(corpus.links).toHaveLength(1)
    expect(corpus.links[0]?.conversationTitle).toBe('First chat')
    expect(corpus.links[0]?.conversationTitles).toEqual(['First chat', 'Second chat'])

    const files = [
      { path: '/opt/data/workspace/app/src/App.tsx', label: 'App.tsx', conversationTitle: 'First chat' },
      { path: '/opt/data/workspace/app/src/App.tsx', label: 'App.tsx', conversationTitle: 'Second chat' },
    ]
    const links = [
      { url: 'https://github.com/DevvGwardo/yeti-trader', conversationTitle: 'First chat' },
      { url: 'https://github.com/DevvGwardo/yeti-trader', conversationTitle: 'Second chat' },
    ]
    const rows = buildSearchRows(
      { agents: [], groups: [], commands: [], messages: [], routines: [], files, links },
      'files',
      '',
    )
    expect(rows.map((r) => r.id)).toEqual(['file:/opt/data/workspace/app/src/App.tsx'])
    expect(rows[0]).toMatchObject({ subtitle: 'First chat +1 · /opt/data/workspace/app/src/App.tsx' })

    const linkRows = buildSearchRows(
      { agents: [], groups: [], commands: [], messages: [], routines: [], files: [], links },
      'links',
      '',
    )
    expect(linkRows.map((r) => r.id)).toEqual(['link:https://github.com/DevvGwardo/yeti-trader'])
    expect(linkRows[0]).toMatchObject({ subtitle: 'First chat +1 · https://github.com/DevvGwardo/yeti-trader' })
  })
})

describe('deep message search', () => {
  const conv: Conversation = {
    id: 'conv_deep', title: 'Long reply', target: { type: 'agent', agentId: 'qa' },
    createdAt: '2026-08-14T00:00:00Z', lastUsedAt: '2026-08-14T00:00:00Z',
  }
  const filler = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')
  const msg: ChatMessage = {
    id: 'deep', threadId: conv.id, role: 'agent', createdAt: '2026-08-14T00:00:00Z',
    content: `${filler} the rollback checklist lives in RUNBOOK.md ${filler}`,
  }
  const search = (query: string) => {
    const corpus = collectSearchCorpus({ conversations: [conv], messagesByThreadId: { [conv.id]: [msg] }, agents: [], groups: [] })
    const input: SearchIndexInput = { agents: [], groups: [], commands: [], files: [], links: [], routines: [], messages: corpus.messages }
    return buildSearchRows(input, 'messages', query)
  }

  it('finds words far past the opening and shows them in the result', () => {
    const [row] = search('rollback runbook')
    expect(row?.kind).toBe('message')
    expect(row.label).toMatch(/^…/)
    expect(row.label).toContain('rollback checklist lives in RUNBOOK.md')
    expect(row.label.length).toBeLessThanOrEqual(182)
  })

  it('keeps the opening snippet when the match is already visible there', () => {
    expect(search('word3')[0].label.startsWith('word0 word1')).toBe(true)
  })

  it('still bounds per-message work', () => {
    const far: ChatMessage = { ...msg, id: 'far', content: `${'x'.repeat(5000)} needle` }
    const corpus = collectSearchCorpus({ conversations: [conv], messagesByThreadId: { [conv.id]: [far] }, agents: [], groups: [] })
    expect(corpus.messages[0].haystack?.includes('needle')).toBe(false)
  })
})
