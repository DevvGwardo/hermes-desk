import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import { disposePluginContributions, registerContribution } from '../../plugins/areas'
import { COMPOSER_AREAS } from '../../lib/plugins/types'
import type { ChatMessage } from '../../lib/agents'
import { resetDraftsForTests } from '../../lib/composer-drafts'

beforeEach(resetDraftsForTests)

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
  disposePluginContributions('mid')
})

const baseProps = {
  messages: [] as ChatMessage[],
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
}

describe('ChatPanel composer middleware', () => {
  function delayedRewrite() {
    let resolve!: (value: { text: string }) => void
    const pending = new Promise<{ text: string }>((finish) => { resolve = finish })
    const handler = vi.fn(() => pending)
    registerContribution({
      id: 'mid:delayed',
      area: COMPOSER_AREAS.middleware,
      data: { handler },
    })
    return { handler, resolve }
  }

  const box = () => screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement

  it('does not erase a newer draft when a delayed rewrite finishes', async () => {
    const pending = delayedRewrite()
    const onSend = vi.fn()
    render(<ChatPanel {...baseProps} onSend={onSend} />)
    fireEvent.change(box(), { target: { value: 'First message' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    fireEvent.change(box(), { target: { value: 'A newer unsent draft' } })
    await act(async () => pending.resolve({ text: 'First message [rewritten]' }))
    expect(onSend).toHaveBeenCalledWith('First message [rewritten]', undefined)
    expect(box().value).toBe('A newer unsent draft')
  })

  it('cancels a delayed submission when switching conversations and retains both drafts', async () => {
    const pending = delayedRewrite()
    const onSend = vi.fn()
    const view = render(<ChatPanel {...baseProps} onSend={onSend} />)
    fireEvent.change(box(), { target: { value: 'First chat draft' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    view.rerender(<ChatPanel {...baseProps} threadKey="t2" onSend={onSend} />)
    fireEvent.change(box(), { target: { value: 'Second chat draft' } })
    await act(async () => pending.resolve({ text: 'First chat draft [rewritten]' }))
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe('Second chat draft')
    view.rerender(<ChatPanel {...baseProps} onSend={onSend} />)
    expect(box().value).toBe('First chat draft')
  })

  it('does not send a delayed submission after the connection becomes unavailable', async () => {
    const pending = delayedRewrite()
    const onSend = vi.fn()
    const view = render(<ChatPanel {...baseProps} onSend={onSend} />)
    fireEvent.change(box(), { target: { value: 'Keep this on disconnect' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    view.rerender(<ChatPanel {...baseProps} onSend={onSend} readOnly />)
    await act(async () => pending.resolve({ text: 'Keep this on disconnect' }))
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe('Keep this on disconnect')
  })

  it('does not send after its composer unmounts', async () => {
    const pending = delayedRewrite()
    const onSend = vi.fn()
    const view = render(<ChatPanel {...baseProps} onSend={onSend} />)
    fireEvent.change(box(), { target: { value: 'Unsubmitted after close' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    view.unmount()
    await act(async () => pending.resolve({ text: 'Unsubmitted after close' }))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not run the same pending submission twice on repeated Enter', async () => {
    const pending = delayedRewrite()
    const onSend = vi.fn()
    render(<ChatPanel {...baseProps} onSend={onSend} />)
    fireEvent.change(box(), { target: { value: 'Send once' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await act(async () => pending.resolve({ text: 'Send once' }))
    expect(pending.handler).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('rewrites the draft before onSend when a middleware is registered', async () => {
    registerContribution({
      id: 'mid:rewrite',
      area: COMPOSER_AREAS.middleware,
      data: { handler: async (d) => ({ text: `${d.text} [handoff]` }) },
    })
    const onSend = vi.fn()
    render(<ChatPanel {...baseProps} onSend={onSend} />)

    const input = screen.getByPlaceholderText(/message|Send|prompt/i)
    fireEvent.change(input, { target: { value: '@researcher look at this' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    await new Promise((r) => setTimeout(r, 30))
    expect(onSend).toHaveBeenCalledWith('@researcher look at this [handoff]', undefined)
  })

  it('passes through unchanged when no middleware is registered', async () => {
    const onSend = vi.fn()
    render(<ChatPanel {...baseProps} onSend={onSend} />)

    const input = screen.getByPlaceholderText(/message|Send|prompt/i)
    fireEvent.change(input, { target: { value: 'plain message' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    await new Promise((r) => setTimeout(r, 20))
    expect(onSend).toHaveBeenCalledWith('plain message', undefined)
  })

  it('still sends when middleware throws', async () => {
    registerContribution({
      id: 'mid:bad',
      area: COMPOSER_AREAS.middleware,
      data: { handler: async () => { throw new Error('boom') } },
    })
    const onSend = vi.fn()
    render(<ChatPanel {...baseProps} onSend={onSend} />)

    const input = screen.getByPlaceholderText(/message|Send|prompt/i)
    fireEvent.change(input, { target: { value: 'still sends' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    await new Promise((r) => setTimeout(r, 20))
    expect(onSend).toHaveBeenCalledWith('still sends', undefined)
  })
})
