import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../lib/agents'
import {
  computerHandoffIndex,
  fileLocationLabel,
  fileCardsForMessage,
  fileCitationsIn,
  fileRefsFromMessage,
  fileRefsFromMessages,
  isLikelyFilePath,
  relativeVmPath,
} from '../file-refs'

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'content'>): ChatMessage {
  return {
    threadId: 't1',
    role: 'agent',
    createdAt: '2026-08-14T00:00:00Z',
    ...partial,
  }
}

describe('fileRefsFromMessage', () => {
  it('reads write_file JSON even when the reply never names the path', () => {
    const refs = fileRefsFromMessage(
      msg({
        id: '1',
        content: 'Done.',
        toolEvents: [
          {
            tool: 'write_file',
            status: 'completed',
            args: '{"file_path":"/opt/data/workspace/app/src/App.tsx"}',
          },
        ],
      }),
    )
    expect(refs).toEqual([
      {
        path: '/opt/data/workspace/app/src/App.tsx',
        action: 'write',
        source: 'tool',
        lineStart: undefined,
      },
    ])
  })

  it('prefers write over a later read of the same path', () => {
    const refs = fileRefsFromMessages([
      msg({
        id: '1',
        content: '',
        toolEvents: [
          {
            tool: 'write_file',
            status: 'completed',
            args: '{"path":"/opt/data/workspace/app/index.html"}',
          },
        ],
      }),
      msg({
        id: '2',
        content: '',
        toolEvents: [
          {
            tool: 'read_file',
            status: 'completed',
            args: '{"path":"/opt/data/workspace/app/index.html"}',
          },
        ],
      }),
    ])
    expect(refs).toHaveLength(1)
    expect(refs[0].action).toBe('write')
    expect(refs[0].source).toBe('tool')
  })

  it('does not turn a user-mentioned path into a write card', () => {
    const user = msg({
      id: 'u',
      role: 'user',
      content: 'please edit /opt/data/workspace/app/src/App.tsx',
    })
    expect(fileCardsForMessage(user)).toEqual([])
    expect(fileRefsFromMessage(user)).toEqual([])
  })

  it('caps in-chat write chips at 8', () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({
      tool: 'write_file',
      status: 'completed' as const,
      args: `{"path":"/opt/data/workspace/app/f${i}.ts"}`,
    }))
    expect(fileCardsForMessage(msg({ id: '1', content: 'ok', toolEvents: tools }))).toHaveLength(8)
  })
})

describe('computerHandoffIndex', () => {
  it('pins to the first screenshot / computer tool turn', () => {
    const messages = [
      msg({ id: 'u', role: 'user', content: 'show me' }),
      msg({
        id: 'a1',
        content: 'Opening Chromium.',
        toolEvents: [{ tool: 'screenshot', status: 'completed', result: 'saved /opt/data/workspace/qa/01.png' }],
      }),
      msg({ id: 'a2', content: 'Still looking.' }),
    ]
    expect(computerHandoffIndex(messages)).toBe(1)
  })

  it('returns -1 when the agent never used the computer', () => {
    expect(
      computerHandoffIndex([msg({ id: '1', content: 'Wrote /opt/data/workspace/app/src/App.tsx' })]),
    ).toBe(-1)
  })
})

describe('fileCitationsIn', () => {
  it('extracts VM paths and optional line numbers', () => {
    const cites = fileCitationsIn('See /opt/data/workspace/app/src/App.tsx:12 and /opt/data/workspace/app/index.html#L3')
    expect(cites.map((c) => ({ path: c.path, lineStart: c.lineStart }))).toEqual([
      { path: '/opt/data/workspace/app/src/App.tsx', lineStart: 12 },
      { path: '/opt/data/workspace/app/index.html', lineStart: 3 },
    ])
  })
})

describe('relativeVmPath', () => {
  it('strips the workspace root for display', () => {
    expect(relativeVmPath('/opt/data/workspace/app/src/App.tsx')).toBe('app/src/App.tsx')
  })
})

describe('isLikelyFilePath', () => {
  it('accepts files and rejects folders', () => {
    expect(isLikelyFilePath('/opt/data/workspace/simple-site/index.html')).toBe(true)
    expect(isLikelyFilePath('/opt/data/config.yaml')).toBe(true)
    expect(isLikelyFilePath('/opt/data/.env')).toBe(true)
    expect(isLikelyFilePath('/opt/data/workspace/simple-site')).toBe(false)
  })
})

describe('fileLocationLabel', () => {
  it('says Workspace for a file at the workspace root', () => {
    expect(fileLocationLabel('/opt/data/workspace/security-tooling-breakdown.md')).toBe('Workspace')
  })

  it('shows the folder relative to the workspace', () => {
    expect(fileLocationLabel('/opt/data/workspace/reports/q3/summary.md')).toBe('reports/q3')
  })

  it('keeps home-relative folders outside the workspace', () => {
    expect(fileLocationLabel('/opt/data/cache/screenshots/shot.png')).toBe('cache/screenshots')
    expect(fileLocationLabel('/opt/data/SOUL.md')).toBe('Agent home')
  })
})
