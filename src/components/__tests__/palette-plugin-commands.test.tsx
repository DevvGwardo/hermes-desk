import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CommandPalette } from '../CommandPalette'
import type { Agent, ChatMessage, Conversation } from '../../lib/agents'

function renderPalette(pluginCommands: Array<{ id: string; label: string; run: () => void }> = []) {
  const onClose = vi.fn()
  const base: Parameters<typeof CommandPalette>[0] = {
    open: true,
    onClose,
    commands: [
      { id: 'core', label: 'Core Command', keywords: [], run: vi.fn() },
      ...pluginCommands,
    ],
    agents: [] as Agent[],
    groups: [],
    conversations: [] as Conversation[],
    hiddenConversations: [],
    messagesByThreadId: {} as Record<string, ChatMessage[]>,
    files: [],
    routines: 'unavailable',
    onJumpToAgent: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenLink: vi.fn(),
    onOpenRoutine: vi.fn(),
    onCreateRoutine: vi.fn(),
    onCreateAgent: vi.fn(),
    onCreateGroup: vi.fn(),
    onOpenFiles: vi.fn(),
    onNewConversation: vi.fn(),
  }
  render(<CommandPalette {...base} />)
  return { onClose }
}

describe('CommandPalette plugin commands', () => {
  it('renders a plugin command and runs it on click', () => {
    const run = vi.fn()
    renderPalette([{ id: 'plugin.new', label: 'Plugin Action', run }])
    expect(screen.getAllByText('Plugin Action').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('Plugin Action'))
    expect(run).toHaveBeenCalled()
  })
})
