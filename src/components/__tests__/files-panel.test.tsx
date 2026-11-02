import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { listMock, linkMock } = vi.hoisted(() => ({ listMock: vi.fn(), linkMock: vi.fn() }))
vi.mock('../../lib/files-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/files-source')>()
  return {
    ...actual,
    isFilesAvailable: () => true,
    listDir: listMock,
    readDataUrl: async () => 'data:image/png;base64,iVBORw0KGgo=',
    downloadLink: linkMock,
  }
})

import FilesPanel, { crumbsFor, fileKindLabel } from '../FilesPanel'

const ROOT = '/opt/data/workspace'

afterEach(() => {
  cleanup()
  listMock.mockReset()
  linkMock.mockReset()
})

describe('FilesPanel', () => {
  it('shows plain names, puts folders last, opens files, and walks into and out of folders', async () => {
    listMock.mockImplementation(async (dir: string) =>
      dir === ROOT
        ? [
            { name: 'reports', path: `${ROOT}/reports`, isDirectory: true },
            { name: 'trip_notes.md', path: `${ROOT}/trip_notes.md`, isDirectory: false },
          ]
        : [{ name: 'q3.pdf', path: `${ROOT}/reports/q3.pdf`, isDirectory: false }],
    )
    const onOpenFile = vi.fn()
    render(<FilesPanel open cwd={ROOT} onClose={() => {}} onOpenFile={onOpenFile} />)

    const reports = await screen.findByText('reports')
    const names = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(names[0]).toContain('Trip notes')
    expect(names[1]).toContain('reports')
    expect(screen.getByText('Document')).toBeTruthy()
    expect(screen.queryByText('trip_notes.md')).toBeNull()

    fireEvent.click(screen.getByText('Trip notes'))
    expect(onOpenFile).toHaveBeenCalledWith(`${ROOT}/trip_notes.md`)

    fireEvent.click(reports)
    await screen.findByText('Q3')
    expect(screen.getByText('PDF')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Up one folder' }))
    await screen.findByText('Trip notes')
  })

  it('groups by day, newest first, and filters by tab', async () => {
    const now = Date.now()
    listMock.mockResolvedValue([
      { name: 'old.html', path: `${ROOT}/old.html`, isDirectory: false, modifiedAt: now - 40 * 86_400_000 },
      { name: 'PXL_20260927_1.jpg', path: `${ROOT}/PXL_20260927_1.jpg`, isDirectory: false, modifiedAt: now - 1000 },
      { name: 'data.json', path: `${ROOT}/data.json`, isDirectory: false, modifiedAt: now - 2000 },
    ])
    render(<FilesPanel open cwd={ROOT} onClose={() => {}} onOpenFile={() => {}} />)
    await screen.findByText('Today')
    expect(screen.getByText('Earlier')).toBeTruthy()
    const names = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(names[0]).toContain('Photo')
    expect(names[1]).toContain('Data')
    expect(names[2]).toContain('Old')

    fireEvent.click(screen.getByRole('tab', { name: 'Photos' }))
    expect(screen.getByRole('button', { name: 'Photo' })).toBeTruthy()
    expect(screen.queryByText('Old')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Sites' }))
    expect(screen.getByText('Old')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Photo' })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Docs' }))
    expect(screen.getByText('No documents yet')).toBeTruthy()
  })

  it('filters the folder by search', async () => {
    listMock.mockResolvedValue([
      { name: 'cat.png', path: `${ROOT}/cat.png`, isDirectory: false },
      { name: 'dog.png', path: `${ROOT}/dog.png`, isDirectory: false },
    ])
    render(<FilesPanel open cwd={ROOT} onClose={() => {}} onOpenFile={() => {}} />)
    await screen.findByText('Cat')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search files' }), { target: { value: 'dog' } })
    expect(screen.queryByText('Cat')).toBeNull()
    expect(screen.getByText('Dog')).toBeTruthy()
  })

  it('Refresh reloads the folder and keeps the search', async () => {
    listMock.mockResolvedValue([
      { name: 'cat.png', path: `${ROOT}/cat.png`, isDirectory: false },
      { name: 'dog.png', path: `${ROOT}/dog.png`, isDirectory: false },
    ])
    render(<FilesPanel open cwd={ROOT} onClose={() => {}} onOpenFile={() => {}} />)
    await screen.findByText('Cat')
    const search = screen.getByRole('searchbox', { name: 'Search files' }) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'dog' } })
    const calls = listMock.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }))
    await waitFor(() => expect(listMock.mock.calls.length).toBe(calls + 1))
    expect(search.value).toBe('dog')
    expect(screen.queryByText('Cat')).toBeNull()
    expect(screen.getByText('Dog')).toBeTruthy()
  })

  it('shows files from this chat on top, newest first', async () => {
    listMock.mockResolvedValue([])
    render(
      <FilesPanel
        open
        cwd={ROOT}
        onClose={() => {}}
        onOpenFile={() => {}}
        recentFiles={[
          { path: `${ROOT}/a.txt`, label: 'a.txt' },
          { path: `${ROOT}/b.txt`, label: 'b.txt' },
        ]}
      />,
    )
    await screen.findByText('From this chat')
    const names = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(names[0]).toContain('B')
    expect(names[1]).toContain('A')
  })

  it('offers a retry when the folder cannot be read', async () => {
    listMock.mockRejectedValueOnce(new Error('Instance has no SSH address')).mockResolvedValueOnce([])
    render(<FilesPanel open cwd={ROOT} onClose={() => {}} onOpenFile={() => {}} />)
    await screen.findByText("Couldn't load your files")
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/asleep or restarting/)).toBeTruthy()
    expect(screen.queryByText(/SSH/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByText('No files yet')).toBeTruthy())
  })
})

describe('saving a file', () => {
  it('shows it is saving until the download starts, then says why it failed', async () => {
    listMock.mockResolvedValue([{ name: 'q3.pdf', path: `${ROOT}/q3.pdf`, isDirectory: false }])
    let fail!: (err: Error) => void
    linkMock.mockReturnValue(new Promise((_, reject) => (fail = reject)))
    render(<FilesPanel open cwd={ROOT} onClose={() => {}} onOpenFile={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save Q3' }))
    const busy = screen.getByRole('button', { name: 'Saving Q3' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(screen.getByText('Saving to this device…')).toBeTruthy()
    fail(new Error('download failed (502)'))
    await screen.findByText('Could not download — try again')
    expect((screen.getByRole('button', { name: 'Save Q3' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('helpers', () => {
  it('names file kinds plainly', () => {
    expect(fileKindLabel('/x/photo.JPG')).toBe('Image')
    expect(fileKindLabel('/x/run.py')).toBe('Code')
    expect(fileKindLabel('/x/Makefile')).toBe('File')
  })

  it('builds crumbs below the root only', () => {
    expect(crumbsFor(ROOT, `${ROOT}/a/b`).map((c) => c.label)).toEqual(['Files', 'a', 'b'])
    expect(crumbsFor(ROOT, ROOT).map((c) => c.label)).toEqual(['Files'])
  })

  it('keeps folders on every tab and says what is missing right here', async () => {
    listMock.mockResolvedValue([
      { name: 'reports', path: `${ROOT}/reports`, isDirectory: true },
      { name: 'cat.png', path: `${ROOT}/cat.png`, isDirectory: false },
    ])
    render(<FilesPanel open cwd={ROOT} onClose={() => {}} onOpenFile={() => {}} />)
    await screen.findByText('reports')
    fireEvent.click(screen.getByRole('tab', { name: 'Docs' }))
    expect(screen.getByText('reports')).toBeTruthy()
    expect(screen.getByText(/No documents right here/)).toBeTruthy()
  })
})
