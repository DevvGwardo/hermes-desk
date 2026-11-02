import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ChatSessionContext } from './ChatSessionContext'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents/types'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const props = { profile: 'backend-eng', configuredModel: 'configured-model', configuredProvider: 'custom',
  open: true, onToggle: vi.fn() }
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(navigator, 'clipboard') })

describe('chat model and profile details', () => {
  it('keeps footer metadata on a solid token surface rather than an indeterminate wallpaper', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/chat/chat-session-context.css'), 'utf8')
    expect(/\.chat-session-context-toggle\s*\{([^}]+)\}/.exec(css)?.[1]).toContain('background: var(--ca-card)')
  })
  it('distinguishes the reported session route from the configured default and shows offline provenance', () => {
    const { rerender } = render(<ChatSessionContext {...props} />)
    const details = () => within(screen.getByRole('region', { name: 'Chat model and profile details' }))
    expect(details().getByText('configured-model')).toBeTruthy()
    expect(details().getByText('Custom endpoint')).toBeTruthy()
    rerender(<ChatSessionContext {...props} route={{ model: 'vendor/session-model', provider: 'nous' }} offline />)
    expect(details().getByText('vendor/session-model')).toBeTruthy()
    expect(details().getByText('Nous Research')).toBeTruthy()
    expect(details().getByText('Last reported · offline')).toBeTruthy()
    expect(screen.queryByText('configured-model')).toBeNull()
    expect(details().getByText(/not necessarily local/)).toBeTruthy()
  })

  it('copies only the scoped CLI command and reports clipboard failure honestly', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<ChatSessionContext {...props} attention />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy command' })))
    expect(writeText).toHaveBeenCalledWith('hermes -p backend-eng model')
    expect(screen.getByText('Command copied')).toBeTruthy()
    writeText.mockRejectedValueOnce(new Error('Denied'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy command' })))
    expect(screen.getByText(/Could not copy/)).toBeTruthy()
    expect(screen.getByText(/Choose an available model/)).toBeTruthy()
  })

  it('does not carry an old copy acknowledgment into another profile', async () => {
    let resolve!: () => void
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: () => new Promise<void>(r => { resolve = r }) } })
    const { rerender } = render(<ChatSessionContext {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
    rerender(<ChatSessionContext {...props} profile="default" />)
    await act(async () => resolve())
    expect(screen.queryByText('Command copied')).toBeNull()
    expect(screen.getByText('hermes model')).toBeTruthy()
  })

  it('uses the native clipboard bridge when browser clipboard permission is unavailable', async () => {
    const previous = window.nubAgent
    const writeText = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { nubAgent: unknown }).nubAgent = { clipboard: { writeText } }
    try {
      render(<ChatSessionContext {...props} />)
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy command' })))
      expect(writeText).toHaveBeenCalledWith('hermes -p backend-eng model')
      expect(screen.getByText('Command copied')).toBeTruthy()
    } finally { window.nubAgent = previous }
  })

  it('closes with Escape and returns focus to the disclosure', () => {
    const onToggle = vi.fn()
    render(<ChatSessionContext {...props} onToggle={onToggle} />)
    const copy = screen.getByRole('button', { name: 'Copy command' })
    copy.focus()
    fireEvent.keyDown(copy, { key: 'Escape' })
    expect(onToggle).toHaveBeenCalledWith(false)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Chat model and profile' }))
  })
})

describe('chat route integration', () => {
  it.each(['classic', 'messenger'] as const)('provides scoped recovery without sending or leaking details across chats (%s)', skin => {
    Element.prototype.scrollIntoView = vi.fn()
    const onSend = vi.fn()
    const message: ChatMessage = { id: 'failed', threadId: 'first', role: 'agent',
      content: "Model 'old' isn't available on Nous Portal", error: true, createdAt: '2026-10-10T12:00:00Z' }
    const common = { skin, profile: 'backend-eng', onSend, messages: [message],
      modelRoute: { model: 'old', provider: 'nous' } }
    const { rerender } = render(<ChatPanel {...common} threadKey="first" />)
    const toggle = screen.getByRole('button', { name: 'Chat model and profile' })
    expect(toggle.textContent).toContain('Model needs attention')
    fireEvent.click(toggle)
    expect(screen.getByRole('region', { name: 'Chat model and profile details' }).textContent)
      .toContain('hermes -p backend-eng model')
    expect(onSend).not.toHaveBeenCalled()
    rerender(<ChatPanel {...common} threadKey="second" profile="default" messages={[]} />)
    expect(screen.queryByRole('region', { name: 'Chat model and profile details' })).toBeNull()
  })
})
