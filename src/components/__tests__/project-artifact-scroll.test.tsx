import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents'

beforeEach(() => {
  cleanup()
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      addEventListener: () => {},
      removeListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

function msg(
  partial: Pick<ChatMessage, 'id' | 'role' | 'content'> & Partial<ChatMessage>,
): ChatMessage {
  return {
    threadId: 't1',
    createdAt: '2026-08-14T12:00:00Z',
    ...partial,
  }
}

describe('project artifact cards in the transcript', () => {
  it('renders cards inside the overflowing transcript, not docked beside it', () => {
    render(
      <ChatPanel
        messages={[
          msg({ id: 'u1', role: 'user', content: 'make a landing page' }),
          msg({
            id: 'a1',
            role: 'agent',
            content: 'Wrote /opt/data/workspace/landing/index.html',
          }),
        ]}
        threadKey="t1"
        cwd="/opt/data/workspace"
        onSend={() => {}}
        onOpenPreview={() => {}}
        onDownloadProject={() => {}}
        onOpenHost={() => {}}
      />,
    )
    const title = screen.getByRole('button', { name: 'Preview landing (HTML)' })
    const stack = title.closest('[data-project-artifacts]')
    const scroller = title.closest('.overflow-y-auto')
    expect(stack).toBeTruthy()
    expect(scroller).toBeTruthy()
    expect(scroller?.contains(stack)).toBe(true)
    expect(scroller?.className).toMatch(/\bisolate\b/)
    expect(screen.getByText('make a landing page').closest('.overflow-y-auto')).toBe(scroller)
  })

  it('keeps cards on the creating turn when a follow-up starts Working…', () => {
    render(
      <ChatPanel
        messages={[
          msg({ id: 'u1', role: 'user', content: 'make a landing page' }),
          msg({
            id: 'a1',
            role: 'agent',
            content: 'Wrote /opt/data/workspace/landing/index.html',
          }),
          msg({ id: 'u2', role: 'user', content: 'Good morning.' }),
          msg({ id: 'a2', role: 'agent', content: '', streaming: true }),
        ]}
        threadKey="t1"
        cwd="/opt/data/workspace"
        sending
        onSend={() => {}}
        onOpenPreview={() => {}}
        onDownloadProject={() => {}}
        onOpenHost={() => {}}
      />,
    )
    const stack = screen.getByRole('button', { name: 'Preview landing (HTML)' }).closest('[data-project-artifacts]')
    const followUp = screen.getByText('Good morning.')
    expect(stack).toBeTruthy()
    const position = stack!.compareDocumentPosition(followUp)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
