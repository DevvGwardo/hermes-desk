import { describe, expect, it } from 'vitest'
import {
  clipActivityText,
  describeToolActivity,
  firstWord,
  formatActivityElapsed,
  liveActivityFromMessages,
  resolveToolWhere,
  mapStoreToolStatus,
  outlineDetails,
  outlineIcon,
  outlineItemsFromMessages,
  outlineLabel,
  outlinePreview,
  prettyToolName,
  upsertToolEvent,
  verbToMarkState,
  holdLiveActivity,
  nextOutlineTabId,
  ACTIVITY_HOLD_MS,
} from '../agents/tool-activity'
import type { ChatMessage } from '../agents/types'
import { hostMachinePhrase } from '../host-label'

describe('prettyToolName (lSn)', () => {
  it('strips ToolCall and splits camelCase', () => {
    expect(prettyToolName('terminalToolCall')).toBe('Terminal')
    expect(prettyToolName('ReadFile')).toBe('Read File')
  })
  it('spaces snake_case hermes names and strips hermes-desk MCP prefixes', () => {
    expect(prettyToolName('web_search')).toBe('Web search')
    expect(prettyToolName('mcp__hermes_desk__render_ui')).toBe('Render UI')
    expect(prettyToolName('mcp_hermes_desk_browser_navigate')).toBe('Browser navigate')
  })
})

describe('firstWord (Sve)', () => {
  it('returns the first space token (Grok Sve)', () => {
    expect(firstWord('ran ls -la\n2 files')).toBe('ran')
    expect(firstWord('  src/lib/agents/types.ts\n42')).toBe('src/lib/agents/types.ts')
    expect(firstWord('')).toBe('')
    expect(firstWord(undefined)).toBe('')
  })

  it('splits on any whitespace: multiline input never embeds a newline', () => {
    expect(firstWord('hello\nworld')).toBe('hello')
    expect(firstWord('one\ntwo\nthree')).toBe('one')
    expect(firstWord('a\tb')).toBe('a')
    expect(firstWord('  indented\r\nline')).toBe('indented')
    const token = firstWord('foo\nbar baz')
    expect(token).toBe('foo')
    expect(token).not.toContain('\n')
  })
})

describe('clipActivityText (XCe)', () => {
  it('caps at 60 characters', () => {
    const long = 'Connecting to a third party app that has a very long name indeed'
    expect(clipActivityText(long).length).toBeLessThanOrEqual(60)
    expect(clipActivityText(long).endsWith('…')).toBe(true)
    expect(clipActivityText('Searching the web')).toBe('Searching the web')
  })
})

describe('describeToolActivity (dse)', () => {
  it('maps grok + hermes names to spoken sentences', () => {
    expect(describeToolActivity('WebSearch').text).toBe('Searching the web')
    expect(describeToolActivity('web_search').text).toBe('Searching the web')
    expect(describeToolActivity('WebFetch').text).toBe('Reading the web')
    expect(describeToolActivity('ReadFile').text).toBe('Reading file')
    expect(describeToolActivity('bash').text).toBe('Running commands')
    expect(describeToolActivity('BoxShell', { detail: 'draft.sh' }).text).toBe('Drafting the file')
    expect(describeToolActivity('GenerateImage').text).toBe('Generating a photo')
    expect(describeToolActivity('SendToAgent', { targetName: 'Research' }).text).toBe('Messaging Research')
    expect(describeToolActivity('SendToAgent', { targetName: 'Research' }).markState).toBe('sending')
    expect(describeToolActivity('ExternalRead').text).toBe('Reading file')
    expect(describeToolActivity('ExternalShell').text).toBe('On your computer')
    expect(describeToolActivity('AwaitShell').text).toBe('Waiting on a command')
    expect(describeToolActivity('CheckSubagent').text).toBe('Waiting on another agent')
    expect(describeToolActivity('CallMcpTool').text).toBe('Connecting to a third party app')
    expect(describeToolActivity('browser_click').text).toBe('Browsing the web')
    expect(describeToolActivity('mcp__hermes_desk__browser_navigate').text).toBe('Browsing the web')
    expect(describeToolActivity('render_ui')).toEqual({
      verb: 'generating',
      text: 'Rendering generated UI',
      markState: 'loading',
    })
    expect(describeToolActivity('mcp__hermes_desk__render_ui').text).toBe('Rendering generated UI')
    expect(describeToolActivity('mcp_hermes-desk_render_ui').text).toBe('Rendering generated UI')
    expect(describeToolActivity('Screenshot').verb).toBe('on-its-computer')
    expect(describeToolActivity(null).text).toBe('Working')
    expect(describeToolActivity('mystery_tool').text).toBe('Working')
  })

  it('linked cube + terminal → On the VM; local externalshell → On the host', () => {
    expect(describeToolActivity('terminal', { where: 'vm' }).text).toBe('On the VM')
    expect(describeToolActivity('bash', { where: 'vm' }).text).toBe('On the VM')
    expect(describeToolActivity('ExternalShell', { where: 'mac' }).text).toBe(`On ${hostMachinePhrase()}`)
    expect(describeToolActivity('bash').text).toBe('Running commands')
    expect(describeToolActivity('ExternalShell').text).toBe('On your computer')
    expect(resolveToolWhere({ linked: true })).toBe('vm')
    expect(resolveToolWhere({ transportWhere: 'mac' })).toBe('mac')
    expect(resolveToolWhere({ linked: true, transportWhere: 'mac' })).toBe('vm')
  })
  it('maps verbs onto mark states (tln)', () => {
    expect(verbToMarkState('searching')).toBe('searching')
    expect(verbToMarkState('generating')).toBe('loading')
    expect(verbToMarkState('messaging')).toBe('orbit')
    expect(verbToMarkState('sending')).toBe('sending')
    expect(describeToolActivity(undefined, { kind: 'thinking' }).markState).toBe('thinking')
  })
})

describe('outline item helpers', () => {
  it('uses wrench / loading / x icons by status', () => {
    expect(outlineIcon({ id: '1', kind: 'tool-call', name: 'bash', status: 'completed' })).toBe('wrench')
    expect(outlineIcon({ id: '1', kind: 'tool-call', name: 'bash', status: 'pending' })).toBe('loading')
    expect(outlineIcon({ id: '1', kind: 'tool-call', name: 'bash', status: 'failed' })).toBe('x')
    expect(outlineIcon({ id: '1', kind: 'thinking' })).toBe('thinking')
    expect(outlineIcon({ id: '1', kind: 'assistant-text' })).toBe('sparkle')
  })
  it('labels tool-calls with pretty names and others with You/Thinking/Agent', () => {
    expect(outlineLabel({ id: '1', kind: 'tool-call', name: 'ReadFile' })).toBe('Read File')
    expect(outlineLabel({ id: '1', kind: 'user' })).toBe('You')
    expect(outlineLabel({ id: '1', kind: 'assistant-text' })).toBe('Agent')
  })
  it('preview is first word; details are unlabeled summary only', () => {
    const item = {
      id: '1',
      kind: 'tool-call' as const,
      name: 'WebSearch',
      summary: 'Found 3 results\nmore',
      status: 'completed' as const,
    }
    expect(outlinePreview(item)).toBe('Found')
    expect(outlineDetails(item)).toEqual([{ text: 'Found 3 results\nmore' }])
    expect(outlineDetails({ id: '2', kind: 'tool-call', name: 'bash' })).toEqual([])
  })
  it('maps store running → pending', () => {
    expect(mapStoreToolStatus('running')).toBe('pending')
    expect(mapStoreToolStatus('failed')).toBe('failed')
    expect(mapStoreToolStatus('completed')).toBe('completed')
  })
})

const msg = (partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content'>): ChatMessage => ({
  threadId: 't1',
  createdAt: '2026-08-12T12:00:00Z',
  ...partial,
})

describe('liveActivityFromMessages', () => {
  it('is none when idle', () => {
    expect(liveActivityFromMessages([msg({ id: 'a', role: 'agent', content: 'hi' })], false).mode).toBe('none')
  })
  it('says Working… while sending with no tools', () => {
    const live = liveActivityFromMessages([], true)
    expect(live.mode).toBe('working')
    expect(live.text).toBe('Working…')
  })
  it('says Typing… while streaming assistant text', () => {
    const live = liveActivityFromMessages(
      [msg({ id: 'a', role: 'agent', content: 'Hello', streaming: true })],
      true,
    )
    expect(live.mode).toBe('typing')
    expect(live.text).toBe('Typing…')
  })
  it('uses the spoken verb for a running tool', () => {
    const live = liveActivityFromMessages(
      [
        msg({
          id: 'a',
          role: 'agent',
          content: '',
          streaming: true,
          toolEvents: [{ tool: 'web_search', status: 'running' }],
        }),
      ],
      true,
    )
    expect(live.text).toBe('Searching the web')
    expect(live.markState).toBe('searching')
  })
  it('says Typing… after a completed tool while text is still streaming', () => {
    const live = liveActivityFromMessages(
      [
        msg({
          id: 'a',
          role: 'agent',
          content: 'Here is',
          streaming: true,
          toolEvents: [{ tool: 'web_search', status: 'completed', summary: 'Found 3' }],
        }),
      ],
      true,
    )
    expect(live.text).toBe('Typing…')
    expect(live.mode).toBe('typing')
  })
})

describe('outlineItemsFromMessages', () => {
  it('flattens user, tools, then assistant text — skips system/subagent', () => {
    const items = outlineItemsFromMessages([
      msg({ id: 'u', role: 'user', content: 'go' }),
      msg({
        id: 'a',
        role: 'agent',
        content: 'Done.',
        toolEvents: [
          { tool: 'terminalToolCall', label: 'terminalToolCall', status: 'completed', summary: 'ran ls' },
        ],
      }),
      msg({ id: 's', role: 'system', content: 'note' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'tool-call', 'assistant-text'])
    expect(items[1]?.name).toBe('terminalToolCall')
    expect(items[1]?.status).toBe('completed')
  })
  it('inserts thinking before tools and keeps duplicate tool ids unique', () => {
    const items = outlineItemsFromMessages([
      msg({
        id: 'a',
        role: 'agent',
        content: 'ok',
        reasoning: 'plan the search',
        toolEvents: [
          { tool: 'bash', status: 'completed' },
          { tool: 'bash', status: 'completed' },
        ],
      }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['thinking', 'tool-call', 'tool-call', 'assistant-text'])
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
  })
})

describe('upsertToolEvent', () => {
  it('merges running → completed for the same toolCallId', () => {
    const once = upsertToolEvent(
      [] as { tool: string; toolCallId?: string; status: string; summary?: string }[],
      { tool: 'bash', toolCallId: 't1', status: 'running' },
    )
    const twice = upsertToolEvent(once, {
      tool: 'bash',
      toolCallId: 't1',
      status: 'completed',
      summary: 'ok',
    })
    expect(twice).toHaveLength(1)
    expect(twice[0]?.status).toBe('completed')
    expect(twice[0]?.summary).toBe('ok')
  })
})

describe('formatActivityElapsed (nJn)', () => {
  it('hides under a minute and formats m / h', () => {
    expect(formatActivityElapsed(59_000)).toBeNull()
    expect(formatActivityElapsed(60_000)).toBe('1m')
    expect(formatActivityElapsed(3_600_000)).toBe('1h')
    expect(formatActivityElapsed(3_660_000)).toBe('1h 1m')
  })
})

describe('holdLiveActivity (Apt 800ms)', () => {
  const working = { mode: 'working' as const, text: 'Working…', markState: 'working' as const }
  const searching = {
    mode: 'working' as const,
    text: 'Searching the web',
    markState: 'searching' as const,
    tool: 'web_search',
  }
  const none = { mode: 'none' as const, text: '', markState: 'idle' as const }

  it('holds the first verb and queues a hop under 800ms', () => {
    const start = holdLiveActivity({ shown: working, shownAtMs: 0, queued: null }, searching, 100)
    expect(start.shown.text).toBe('Working…')
    expect(start.queued?.text).toBe('Searching the web')
  })
  it('promotes immediately after the hold window', () => {
    const next = holdLiveActivity({ shown: working, shownAtMs: 0, queued: null }, searching, ACTIVITY_HOLD_MS)
    expect(next.shown.text).toBe('Searching the web')
    expect(next.queued).toBeNull()
  })
  it('drops to none immediately when the turn ends', () => {
    const next = holdLiveActivity({ shown: working, shownAtMs: 0, queued: searching }, none, 50)
    expect(next.shown.mode).toBe('none')
  })
})

describe('nextOutlineTabId (ySn)', () => {
  const ids = ['parent', 'run_a', 'run_b']
  it('wraps with arrows and jumps with Home/End', () => {
    expect(nextOutlineTabId(ids, 'parent', 'ArrowRight')).toBe('run_a')
    expect(nextOutlineTabId(ids, 'run_b', 'ArrowRight')).toBe('parent')
    expect(nextOutlineTabId(ids, 'parent', 'ArrowLeft')).toBe('run_b')
    expect(nextOutlineTabId(ids, 'run_a', 'Home')).toBe('parent')
    expect(nextOutlineTabId(ids, 'parent', 'End')).toBe('run_b')
    expect(nextOutlineTabId(['parent'], 'parent', 'ArrowRight')).toBeNull()
  })
})
