import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { QueuedMessageItem } from '../../lib/agents'

// jsdom stubs required by the component tree (see STATE.md).
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
  sending: true,
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
} as unknown as Parameters<typeof ChatPanel>[0]

const items: QueuedMessageItem[] = [
  { id: 'q1', text: 'first parked message', enqueuedAt: '2026-09-07T00:00:00Z' },
  { id: 'q2', text: 'second parked message', enqueuedAt: '2026-09-07T00:00:01Z' },
]

describe('ChatPanel queued-messages popover', () => {
  it('badge opens a popover listing the parked sends in order', () => {
    render(
      <ChatPanel {...baseProps} queuedCount={2} queuedItems={items} onRemoveQueued={vi.fn()} />,
    )
    const badge = screen.getByRole('button', { name: /2 messages waiting behind the current reply/ })
    fireEvent.click(badge)
    const dialog = screen.getByRole('dialog', { name: 'Queued messages' })
    expect(dialog.getAttribute('data-role')).toBe('queued-popover')
    expect(screen.getByText('first parked message')).toBeTruthy()
    expect(screen.getByText('second parked message')).toBeTruthy()
  })

  it('remove button calls onRemoveQueued with the item id', () => {
    const onRemoveQueued = vi.fn()
    render(
      <ChatPanel {...baseProps} queuedCount={2} queuedItems={items} onRemoveQueued={onRemoveQueued} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /2 messages waiting/ }))
    const removes = screen.getAllByRole('button', { name: 'Remove queued message' })
    expect(removes).toHaveLength(2)
    fireEvent.click(removes[0]!)
    expect(onRemoveQueued).toHaveBeenCalledWith('q1')
  })

  it('Escape closes the popover', () => {
    render(
      <ChatPanel {...baseProps} queuedCount={1} queuedItems={[items[0]!]} onRemoveQueued={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /1 message waiting/ }))
    expect(screen.getByRole('dialog', { name: 'Queued messages' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Queued messages' })).toBeNull()
  })

  it('without item details or remove support the badge stays inert (non-interactive)', () => {
    render(<ChatPanel {...baseProps} queuedCount={2} queuedItems={[]} />)
    // No items surfaced by the transport and no remove handler the badge can
    // rely on → plain span, no popover on click.
    const badge = screen.getByText('2 queued')
    expect(badge.tagName).toBe('SPAN')
    fireEvent.click(badge)
    expect(screen.queryByRole('dialog', { name: 'Queued messages' })).toBeNull()
  })

  it('no queued messages means no badge at all', () => {
    render(<ChatPanel {...baseProps} queuedCount={0} queuedItems={[]} />)
    expect(screen.queryByText(/queued/)).toBeNull()
  })
})
