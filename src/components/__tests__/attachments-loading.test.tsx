import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const readDataUrl = vi.fn<(path: string) => Promise<string>>()
vi.mock('../../lib/files-source', () => ({
  readDataUrl: (p: string) => readDataUrl(p),
  // Not linked: a failed read is not retried automatically.
  isFilesAvailable: () => false,
}))

import { AttachmentTray, MessageAttachments } from '../Attachments'
import { resetChatImagesForTests } from '../../lib/chat-images'
import { closeViewer, useViewerState } from '../../lib/image-viewer'

afterEach(() => {
  cleanup()
  closeViewer()
  readDataUrl.mockReset()
  resetChatImagesForTests()
})

describe('sent picture loading', () => {
  it('holds its place with a shimmer, and offers Retry when the read fails', async () => {
    let fail!: (e: Error) => void
    readDataUrl.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)))
    render(
      <MessageAttachments align="end" items={[{ id: 'a', name: 'shot.png', kind: 'image', path: '/w/shot-1.png' }]} />,
    )
    expect(screen.getByRole('status', { name: 'Loading shot.png' })).toBeTruthy()
    await act(async () => fail(new Error('offline')))
    expect(screen.getByText("Couldn't load the picture")).toBeTruthy()

    // Retry reads again (the failure was not cached) and shows the picture.
    readDataUrl.mockResolvedValueOnce('data:image/png;base64,AAAA')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry loading shot.png' })))
    expect(readDataUrl).toHaveBeenCalledTimes(2)
    expect(screen.getByAltText('shot.png').getAttribute('src')).toMatch(/^blob:/)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('reads a picture shown twice only once', async () => {
    readDataUrl.mockResolvedValue('data:image/png;base64,AAAA')
    const items = [{ id: 'a', name: 'same.png', kind: 'image' as const, path: '/w/same.png' }]
    await act(async () => {
      render(
        <>
          <MessageAttachments align="end" items={items} />
          <MessageAttachments align="end" items={items} />
        </>,
      )
    })
    expect(screen.getAllByAltText('same.png')).toHaveLength(2)
    expect(readDataUrl).toHaveBeenCalledTimes(1)
  })
})

function ViewerProbe() {
  const view = useViewerState()
  return <output data-testid="probe">{view ? `${view.index}/${view.items.length}` : 'closed'}</output>
}

describe('several pictures sent together', () => {
  it('share a grid of four, the last tile counting the rest, and all open in the viewer', async () => {
    readDataUrl.mockResolvedValue('data:image/png;base64,AAAA')
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      name: `p${i}.png`,
      kind: 'image' as const,
      path: `/w/p${i}.png`,
    }))
    await act(async () => {
      render(
        <div className="overflow-y-auto">
          <MessageAttachments align="end" items={[...items, { id: 'f', name: 'notes.pdf', kind: 'file', path: '/w/notes.pdf' }]} />
          <ViewerProbe />
        </div>,
      )
    })
    expect(screen.getByTestId('sent-image-grid')).toBeTruthy()
    // Only the four visible tiles are read; the rest wait for the viewer.
    expect(readDataUrl).toHaveBeenCalledTimes(4)
    expect(screen.getAllByRole('img')).toHaveLength(4)
    expect(screen.getByText('+2')).toBeTruthy()
    expect(screen.getByText('notes.pdf')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'View p1.png full size' }))
    expect(screen.getByTestId('probe').textContent).toBe('1/6')
  })
})

describe('files you sent', () => {
  it('open in the file preview', () => {
    const onOpenFile = vi.fn()
    render(
      <MessageAttachments
        align="end"
        onOpenFile={onOpenFile}
        items={[{ id: 'f', name: 'plan.pdf', kind: 'file', path: '/opt/data/workspace/plan.pdf', size: 2048 }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /plan\.pdf/ }))
    expect(onOpenFile).toHaveBeenCalledWith('/opt/data/workspace/plan.pdf')
  })
})

describe('composer tray pictures', () => {
  it('open full size, walking only the attached pictures', () => {
    render(
      <>
        <AttachmentTray
          onRemove={() => {}}
          items={[
            { id: 'a', name: 'one.png', kind: 'image', status: 'ready', thumb: 'blob:one' },
            { id: 'b', name: 'two.png', kind: 'image', status: 'uploading', thumb: 'blob:two' },
            { id: 'c', name: 'notes.txt', kind: 'file', status: 'ready' },
          ]}
        />
        <ViewerProbe />
      </>,
    )
    // Viewable even while it uploads.
    fireEvent.click(screen.getByRole('button', { name: 'View two.png' }))
    expect(screen.getByTestId('probe').textContent).toBe('1/2')
  })
})
