import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

describe('page cards in chat', () => {
  it('does not offer Take over or a screenshot project card', () => {
    render(
      <ChatPanel
        messages={[
          msg({ id: 'u1', role: 'user', content: 'show the page' }),
          msg({
            id: 'a1',
            role: 'agent',
            content: 'Here is the desktop.',
            toolEvents: [
              {
                tool: 'screenshot',
                status: 'completed',
                result: 'saved screenshot /opt/data/workspace/qa/01_app.png',
              },
            ],
          }),
          msg({ id: 'u2', role: 'user', content: 'thanks' }),
        ]}
        threadKey="t1"
        onSend={() => {}}
        onOpenPreview={() => {}}
        onDownloadProject={() => {}}
        onOpenHost={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Take over the computer' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open page' })).toBeNull()
    expect(screen.queryByText('Page screenshot')).toBeNull()
  })

  it('opens the side page from an HTML card', () => {
    const onOpenPreview = vi.fn()
    render(
      <ChatPanel
        messages={[
          msg({
            id: 'a1',
            role: 'agent',
            content: 'Wrote /opt/data/workspace/landing/index.html',
          }),
        ]}
        threadKey="t1"
        cwd="/opt/data/workspace"
        onSend={() => {}}
        onOpenPreview={onOpenPreview}
        onDownloadProject={() => {}}
        onOpenHost={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(onOpenPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'html',
        entryFile: '/opt/data/workspace/landing/index.html',
      }),
    )
  })

  it('opens a live Vite server from the chat card', () => {
    const onOpenPreview = vi.fn()
    render(
      <ChatPanel
        messages={[
          msg({
            id: 'a1',
            role: 'agent',
            content: 'VITE v6 ready — Local: http://127.0.0.1:5173/',
            toolEvents: [
              {
                tool: 'terminal',
                status: 'completed',
                args: 'npm create vite@latest /opt/data/workspace/todo -- --template react',
                result: 'VITE v6 ready — Local: http://127.0.0.1:5173/',
              },
            ],
          }),
        ]}
        threadKey="t1"
        cwd="/opt/data/workspace"
        onSend={() => {}}
        onOpenPreview={onOpenPreview}
        onDownloadProject={() => {}}
        onOpenHost={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(onOpenPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'vite',
        port: 5173,
      }),
    )
  })
})
