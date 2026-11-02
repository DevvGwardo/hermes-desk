import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { listDirMock, readDataUrlMock } = vi.hoisted(() => ({
  listDirMock: vi.fn(),
  readDataUrlMock: vi.fn(),
}))
vi.mock('../../lib/files-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/files-source')>()
  return { ...actual, listDir: listDirMock, readDataUrl: readDataUrlMock, downloadBlob: async () => null, downloadLink: async () => null }
})

import { FileCardStack, isFolderPath } from '../FileCard'
import { closeViewer, useViewerState } from '../../lib/image-viewer'
import { resetChatImagesForTests } from '../../lib/chat-images'
import { fileCardsForMessage } from '../../lib/file-refs'
import { folderWithin, onOpenFilesRequest } from '../../lib/open-files'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

beforeEach(() => {
  listDirMock.mockReset()
  readDataUrlMock.mockReset().mockResolvedValue(PNG)
})
afterEach(() => {
  cleanup()
  closeViewer()
  resetChatImagesForTests()
})

function ViewerProbe() {
  const view = useViewerState()
  return <output data-testid="viewer">{view ? view.items.map((i) => i.name).join(',') : 'closed'}</output>
}

describe('file cards you can use', () => {
  it('the feedback reply: the workspace root gets no card, the folder opens to show its files', async () => {
    const reply = 'Here is how far the test got. Files are in /opt/data/workspace/sticker-test/ and /opt/data/:'
    const cards = fileCardsForMessage({ id: 'a', threadId: 't', role: 'agent', content: reply, createdAt: '' })
    expect(cards.map((c) => c.path)).toEqual(['/opt/data/workspace/sticker-test/'])

    listDirMock.mockResolvedValue([
      { name: 'bluecat_sticker.png', path: '/opt/data/workspace/sticker-test/bluecat_sticker.png', isDirectory: false },
      { name: 'notes.md', path: '/opt/data/workspace/sticker-test/notes.md', isDirectory: false },
      { name: '.cache', path: '/opt/data/workspace/sticker-test/.cache', isDirectory: true },
    ])
    const onOpen = vi.fn()
    render(
      <>
        <FileCardStack files={cards} onOpen={onOpen} />
        <ViewerProbe />
      </>,
    )
    const folder = screen.getByRole('button', { name: /sticker-test/ })
    expect(folder.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      fireEvent.click(folder)
    })
    expect(listDirMock).toHaveBeenCalledWith('/opt/data/workspace/sticker-test')
    // The sticker shows as a picture; hidden entries are left out.
    const thumb = await screen.findByRole('img', { name: 'bluecat_sticker.png' })
    await waitFor(() => expect(thumb.getAttribute('src')).toMatch(/^blob:/))
    expect(screen.queryByText('.cache')).toBeNull()
    // A picture opens in the full-screen viewer, not the file preview.
    fireEvent.click(screen.getByTitle('bluecat_sticker.png'))
    expect(screen.getByTestId('viewer').textContent).toBe('bluecat_sticker.png')
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('notes.md'))
    expect(onOpen).toHaveBeenLastCalledWith('/opt/data/workspace/sticker-test/notes.md')
    expect(screen.getByRole('button', { name: 'Download notes.md' })).toBeTruthy()
  })

  it('a document card shows a visible View button that opens the file', () => {
    const onOpen = vi.fn()
    const path = '/opt/data/workspace/patent_test_report.md'
    render(<FileCardStack files={[{ path, action: 'write', source: 'heuristic' }]} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: 'View patent_test_report.md' }))
    expect(onOpen).toHaveBeenCalledWith(path)
  })

  it('an image the agent wrote shows as the picture, with a download button', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<FileCardStack files={[{ path: '/opt/data/workspace/out/cat.png', action: 'write', source: 'heuristic' }]} onOpen={vi.fn()} />)
    const img = await screen.findByRole('img', { name: 'cat.png' })
    await waitFor(() => expect(img.getAttribute('src')).toMatch(/^blob:/))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download cat.png' }))
    })
    expect(click).toHaveBeenCalled()
    click.mockRestore()
  })

  it('a folder that cannot be listed says why', async () => {
    listDirMock.mockRejectedValue(new Error('Link your agent to browse files.'))
    render(<FileCardStack files={[{ path: '/opt/data/workspace/out/', action: 'write', source: 'heuristic' }]} onOpen={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /out/ }))
    })
    expect(await screen.findByText(/isn't connected to your agent anymore/)).toBeTruthy()
  })

  it('a big folder says what it hides and opens Files right there', async () => {
    const dir = '/opt/data/workspace/shots'
    listDirMock.mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => ({ name: `doc${i}.md`, path: `${dir}/doc${i}.md`, isDirectory: false })),
    )
    const asked: Array<string | undefined> = []
    const off = onOpenFilesRequest((f) => asked.push(f))
    render(<FileCardStack files={[{ path: `${dir}/`, action: 'read', source: 'heuristic' }]} onOpen={() => {}} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /shots/ }))
    })
    expect(await screen.findByText(/Showing 12 of 15 items/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'See them all in Files' }))
    off()
    expect(asked).toEqual([`${dir}/`])
    expect(folderWithin('/opt/data/workspace', `${dir}/`)).toBe(dir)
    expect(folderWithin('/opt/data/workspace', '/etc/')).toBe('/opt/data/workspace')
  })

  it('tells folders from files', () => {
    expect(isFolderPath('/opt/data/workspace/sticker-test/')).toBe(true)
    expect(isFolderPath('/opt/data/workspace/sticker-test')).toBe(true)
    expect(isFolderPath('/opt/data/workspace/sticker-test/bluecat_sticker.png')).toBe(false)
    // Known extensionless files are files, not folders.
    expect(isFolderPath('/opt/data/workspace/README')).toBe(false)
    expect(isFolderPath('/opt/data/workspace/app/Dockerfile')).toBe(false)
  })
})
