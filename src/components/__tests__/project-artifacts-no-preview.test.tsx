import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents'

function msg(
  partial: Pick<ChatMessage, 'id' | 'role' | 'content'> & Partial<ChatMessage>,
): ChatMessage {
  return {
    threadId: 't1',
    createdAt: '2026-08-14T12:00:00Z',
    ...partial,
  }
}

/** Prod shape: App passes onDownloadProject/onOpenHost but no onOpenPreview. */
describe('artifact cards without a preview handler (prod shape)', () => {
  it('renders Download/Host cards with no Open-page button', () => {
    const onDownloadProject = vi.fn()
    const onOpenHost = vi.fn()
    const { unmount } = render(
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
        onDownloadProject={onDownloadProject}
        onOpenHost={onOpenHost}
      />,
    )
    try {
      const download = screen.getByRole('button', { name: 'Download' })
      const host = screen.getByRole('button', { name: 'Publish' })
      expect(download).toBeTruthy()
      expect(host).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Open page' })).toBeNull()
      fireEvent.click(download)
      expect(onDownloadProject).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'html' }),
      )
      fireEvent.click(host)
      expect(onOpenHost).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'html' }),
      )
    } finally {
      unmount()
      cleanup()
    }
  })
})
