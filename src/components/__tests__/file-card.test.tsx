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

describe('in-chat file cards', () => {
  it('opens FilePreview from a write_file JSON path with no path in the reply', () => {
    const onOpenFile = vi.fn()
    render(
      <ChatPanel
        messages={[
          msg({ id: 'u1', role: 'user', content: 'add the app file' }),
          msg({
            id: 'a1',
            role: 'agent',
            content: 'Done.',
            toolEvents: [
              {
                tool: 'write_file',
                status: 'completed',
                args: '{"file_path":"/opt/data/workspace/app/src/App.tsx"}',
              },
            ],
          }),
        ]}
        threadKey="t1"
        onSend={() => {}}
        onOpenFile={onOpenFile}
      />,
    )
    expect(screen.getByText('App.tsx')).toBeTruthy()
    expect(screen.queryByText('Preview')).toBeNull()
    fireEvent.click(screen.getByText('App.tsx'))
    expect(onOpenFile).toHaveBeenCalledWith('/opt/data/workspace/app/src/App.tsx')
  })

  it('keeps the project Preview card when the write is index.html', () => {
    render(
      <ChatPanel
        messages={[
          msg({
            id: 'a1',
            role: 'agent',
            content: 'Done.',
            toolEvents: [
              {
                tool: 'write_file',
                status: 'completed',
                args: '{"file_path":"/opt/data/workspace/landing/index.html"}',
              },
            ],
          }),
        ]}
        threadKey="t1"
        onSend={() => {}}
        onOpenFile={() => {}}
        onOpenPreview={() => {}}
        onDownloadProject={() => {}}
        onOpenHost={() => {}}
      />,
    )
    expect(screen.getByText('index.html')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Preview landing (HTML)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy()
  })
})
