import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ToolChipRow, type ToolChipEvent } from './ToolChipRow'
import { MessengerComposer } from './MessengerComposer'
import { SidebarCreateActions } from '../SidebarCreateActions'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents/types'

afterEach(cleanup)

describe('Tool activity attention', () => {
  const event = (status: ToolChipEvent['status']): ToolChipEvent => ({
    tool: 'terminal', status, args: '{"command":"fixture-check"}',
  })
  it('reveals a failed tool by default and keeps its failure visible when collapsed', () => {
    render(<ToolChipRow events={[event('completed'), event('failed')]} />)
    expect(screen.getByRole('list', { name: 'Tool activity' })).toBeVisible()
    expect(screen.getByRole('img', { name: 'Failed' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse tool activity' }))
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand tool activity' })).toHaveTextContent('2 steps · 1 failed')
  })
  it('keeps successful technical detail collapsed, but running work expanded', () => {
    const view = render(<ToolChipRow events={[event('completed')]} />)
    expect(screen.queryByRole('list')).toBeNull()
    view.rerender(<ToolChipRow events={[event('running')]} />)
    expect(screen.getByRole('list', { name: 'Tool activity' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Collapse tool activity' })).toHaveTextContent('Working')
  })
  it('describes Hermes Desk render_ui and namespaced browser steps truthfully', () => {
    const view = render(<ToolChipRow events={[
      { tool: 'mcp__hermes_desk__render_ui', toolCallId: 'gen-1', status: 'running' },
      { tool: 'mcp__hermes_desk__browser_navigate', toolCallId: 'nav-1', status: 'completed', args: '{"url":"https://example.com/docs"}' },
    ]} />)
    expect(screen.getByText('Rendering generated UI')).toBeVisible()
    expect(screen.getByText('Browsed example.com')).toBeVisible()
    view.rerender(<ToolChipRow events={[
      { tool: 'mcp__hermes_desk__render_ui', toolCallId: 'gen-1', status: 'completed' },
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand tool activity' }))
    expect(screen.getByText('Rendered generated UI')).toBeVisible()
  })
})

describe('Composer keyboard continuity', () => {
  function setup() {
    const emoji = vi.fn()
    render(<MessengerComposer input={<textarea aria-label="Message" defaultValue="Keep this draft" />}
      hasText profile="local" model="model" onCommands={vi.fn()} onEmoji={emoji}
      onStartDictate={vi.fn()} onStopDictate={vi.fn()} dictateStatus="unavailable" />)
    return emoji
  }
  it('returns focus to the draft after choosing an emoji without losing text', () => {
    const emoji = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Add emoji' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert 👍' }))
    expect(emoji).toHaveBeenCalledWith('👍')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this draft')
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('moves menu focus with arrows and restores the trigger on Escape', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Add emoji' }))
    expect(screen.getByRole('menuitem', { name: 'Insert ☺' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Insert 👍' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Add emoji' })).toHaveFocus()
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('restores the command-menu button, not the identically named menu container', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Composer menu' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Composer menu' })).toHaveFocus()
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

it('exposes only supported creation actions and keeps shared-room creation direct', () => {
  const room = vi.fn()
  const view = render(<SidebarCreateActions compact={false} onNewConversation={vi.fn()} onCreateGroup={room} />)
  fireEvent.click(screen.getByRole('button', { name: 'New shared room' }))
  expect(room).toHaveBeenCalledOnce()
  view.rerender(<SidebarCreateActions compact={false} onNewConversation={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'New shared room' })).toBeNull()
})

describe('Tool-only GenUI bubble Copy and Reply fallbacks', () => {
  it('copies validated GenUI widget summaries and populates Reply quote snippets on tool-only bubbles', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const onSend = vi.fn()
    const genuiMsg: ChatMessage = {
      id: 'genui-turn-1',
      threadId: 'conv-1',
      fromAgentId: 'profile:alpha',
      role: 'agent',
      content: '',
      createdAt: '2026-10-13T12:00:00Z',
      toolEvents: [
        {
          tool: 'mcp__hermes_desk__render_ui',
          toolCallId: 'call-ui-1',
          status: 'completed',
          genui: {
            version: 1,
            components: [
              { type: 'stat', title: 'Deploy status', value: '99.98%', detail: 'Canary green' },
              { type: 'checklist', title: 'Next steps', items: [{ id: 's1', label: 'Promote release' }] },
            ],
          },
        },
      ],
    }

    render(
      <ChatPanel
        skin="messenger"
        threadKey="conv-1"
        messages={[genuiMsg]}
        onSend={onSend}
        agentName={() => 'Alpha'}
      />,
    )

    const group = screen.getByRole('group', { name: 'Message actions for Alpha' })
    fireEvent.pointerEnter(group)

    const copyBtn = screen.getByRole('button', { name: 'Copy' })
    fireEvent.click(copyBtn)
    expect(writeText).toHaveBeenCalledWith(
      'Deploy status: 99.98% (Canary green) · Next steps: Promote release',
    )

    const replyBtn = screen.getByRole('button', { name: 'Reply to Alpha' })
    fireEvent.click(replyBtn)
    const composer = screen.getByRole('textbox', { name: 'Message the agent' })
    fireEvent.change(composer, { target: { value: 'Looks good, ship it' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith(
      'Looks good, ship it',
      expect.objectContaining({
        replyTo: {
          id: 'genui-turn-1',
          role: 'agent',
          snippet: 'Deploy status: 99.98% (Canary green) · Next steps: Promote release',
        },
      }),
    )
  })

  it('never exposes Copy or Reply snippets from failed or running render_ui events', () => {
    Element.prototype.scrollIntoView = vi.fn()
    const failedMsg: ChatMessage = {
      id: 'genui-failed-1',
      threadId: 'conv-1',
      fromAgentId: 'profile:alpha',
      role: 'agent',
      content: '',
      createdAt: '2026-10-13T12:05:00Z',
      toolEvents: [
        {
          tool: 'mcp__hermes_desk__render_ui',
          toolCallId: 'call-ui-fail',
          status: 'failed',
          genui: {
            version: 1,
            components: [{ type: 'stat', title: 'Secret metric', value: 'Do not copy' }],
          },
        },
      ],
    }

    render(
      <ChatPanel
        skin="messenger"
        threadKey="conv-1"
        messages={[failedMsg]}
        onSend={vi.fn()}
        agentName={() => 'Alpha'}
      />,
    )

    const group = screen.getByRole('group', { name: 'Message actions for Alpha' })
    fireEvent.pointerEnter(group)
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
  })

  it('prepares a GenUI discovery prompt from the Composer menu and /genui slash command', () => {
    Element.prototype.scrollIntoView = vi.fn()
    render(
      <ChatPanel
        skin="messenger"
        threadKey="conv-genui-draft"
        messages={[]}
        onSend={vi.fn()}
        agentName={() => 'Alpha'}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Composer menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Prepare GenUI card' }))

    const composer = screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement
    expect(composer.value).toContain('mcp__hermes_desk__render_ui')
    expect(composer.value).toContain('tool_search')
  })
})
