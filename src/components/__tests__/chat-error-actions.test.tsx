import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents/types'

beforeAll(() => {
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
  }
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  }
})

afterEach(() => {
  cleanup()
})

const baseProps = {
  messages: [],
  disabled: false,
  sending: false,
  threadKey: 't1',
  liveSubagents: [],
  conversationSubagents: [],
  agentName: () => 'agent',
  onSend: vi.fn(),
  onReact: vi.fn(),
  onChoice: vi.fn(),
  onOpenKanban: vi.fn(),
  onOpenPreview: vi.fn(),
  onOpenHost: vi.fn(),
  onDownloadProject: vi.fn(),
  onOpenFile: vi.fn(),
  onSaveFileToMac: vi.fn(),
  onCopyToBox: vi.fn(),
  onAttachLocalFiles: vi.fn(),
  cwd: '',
  onOpenSettings: vi.fn(),
  onOpenPlugins: vi.fn(),
  onNewAgent: vi.fn(),
  onNewConversation: vi.fn(),
  onSpawnSubagent: vi.fn(),
  onCancelSubagent: vi.fn(),
  onMessageSubagent: vi.fn(),
  agents: [],
  permissionAsk: null,
  onPermission: vi.fn(),
  parentAgentName: 'agent',
  showAgentSpeaker: false,
  onRetryTurn: vi.fn(),
} as unknown as Parameters<typeof ChatPanel>[0]

function thread(reply: Partial<ChatMessage>): ChatMessage[] {
  return [
    { id: 'u1', threadId: 't1', role: 'user', content: 'hello', createdAt: '2026-10-01T00:00:00Z' },
    { id: 'a1', threadId: 't1', role: 'agent', content: '', createdAt: '2026-10-01T00:00:01Z', ...reply },
  ]
}

describe('ChatPanel failed-turn actions', () => {
  it('offers the renew link beside Try again on a lapsed plan', () => {
    render(
      <ChatPanel
        {...baseProps}
        messages={thread({
          content: 'Your Nub plan has ended.',
          error: true,
          errorAction: { label: 'Renew plan', url: 'https://nub.example/nub/plan' },
        })}
      />,
    )
    const renew = screen.getByTestId('turn-error-action')
    expect(renew.textContent).toBe('Renew plan')
    expect(renew.getAttribute('href')).toBe('https://nub.example/nub/plan')
    expect(renew.getAttribute('target')).toBe('_blank')
    expect(screen.getByTestId('retry-turn')).toBeTruthy()
  })

  it('drops a renew link that is not https', () => {
    render(
      <ChatPanel
        {...baseProps}
        messages={thread({
          content: 'Your Nub plan has ended.',
          error: true,
          errorAction: { label: 'Renew plan', url: 'javascript:alert(1)' },
        })}
      />,
    )
    expect(screen.queryByTestId('turn-error-action')).toBeNull()
  })

  it('says why a partial reply stopped, and draws no link cards on it', () => {
    render(
      <ChatPanel
        {...baseProps}
        messages={thread({
          content: 'Watch https://www.youtube.com/watch?v=dQw4w9WgXcQ for the first half',
          error: true,
          errorNote: 'The reply got cut off partway. Try again.',
        })}
      />,
    )
    expect(screen.getByTestId('turn-error-note').textContent).toBe('The reply got cut off partway. Try again.')
    expect(screen.queryByTestId('link-preview')).toBeNull()
  })

  it('still draws link cards on a normal reply', () => {
    render(
      <ChatPanel {...baseProps} messages={thread({ content: 'Watch https://www.youtube.com/watch?v=dQw4w9WgXcQ' })} />,
    )
    expect(screen.getByTestId('link-preview')).toBeTruthy()
  })

  it('ignores a stale note once the turn is no longer an error', () => {
    render(
      <ChatPanel
        {...baseProps}
        messages={thread({ content: 'All done.', errorNote: 'The reply got cut off partway. Try again.' })}
      />,
    )
    expect(screen.queryByTestId('turn-error-note')).toBeNull()
    expect(screen.queryByTestId('retry-turn')).toBeNull()
  })
})
