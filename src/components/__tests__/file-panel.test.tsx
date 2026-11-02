import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { textMock, writeMock } = vi.hoisted(() => ({ textMock: vi.fn(), writeMock: vi.fn() }))
vi.mock('../../lib/files-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/files-source')>()
  return { ...actual, readText: textMock, writeText: writeMock, canEditFile: (p: string) => p.startsWith('/opt/data/workspace/'), readDataUrl: async () => { throw new Error('fs read failed (502)') }, downloadBlob: async () => null, downloadLink: async () => null }
})

import { FilePanel } from '../FilePanel'
import { resetFileTextCacheForTests } from '../../lib/file-text-cache'

afterEach(() => {
  cleanup()
  textMock.mockReset()
  writeMock.mockReset()
  resetFileTextCacheForTests()
})

describe('FilePanel editing', () => {
  const path = '/opt/data/workspace/notes.txt'

  it('edits a text file and saves it', async () => {
    textMock.mockResolvedValue('Buy milk')
    writeMock.mockResolvedValue(undefined)
    render(<FilePanel filePath={path} onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const box = screen.getByLabelText('Edit notes.txt') as HTMLTextAreaElement
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(box, { target: { value: 'Buy milk and eggs' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(writeMock).toHaveBeenCalledWith(path, 'Buy milk and eggs'))
    expect(await screen.findByText('Buy milk and eggs')).toBeTruthy()
    expect(screen.queryByLabelText('Edit notes.txt')).toBeNull()
  })

  it('asks before closing with unsaved changes', async () => {
    textMock.mockResolvedValue('Buy milk')
    const onClose = vi.fn()
    render(<FilePanel filePath={path} onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Edit notes.txt'), { target: { value: 'changed' } })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect((screen.getByLabelText('Edit notes.txt') as HTMLTextAreaElement).value).toBe('changed')
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows why a save failed and keeps the draft', async () => {
    textMock.mockResolvedValue('Buy milk')
    writeMock.mockRejectedValue(new Error('fs write failed (403)'))
    render(<FilePanel filePath={path} onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Edit notes.txt'), { target: { value: 'eggs' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Couldn’t save/)).toBeTruthy()
    expect((screen.getByLabelText('Edit notes.txt') as HTMLTextAreaElement).value).toBe('eggs')
  })

  it('no Edit for a file it could not save', async () => {
    textMock.mockResolvedValue('{}')
    render(<FilePanel filePath="/opt/data/config.json" onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Copy content' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull())
  })
})

describe('FilePanel', () => {
  it('renders nothing without a file', () => {
    render(<FilePanel filePath={null} onClose={() => {}} />)
    expect(document.querySelector('[data-file-panel]')).toBeNull()
  })

  it('shows the markdown, does not re-read on a re-render, and closes on X and Escape', async () => {
    textMock.mockResolvedValue('# Patent report\n\nAll good.')
    const onClose = vi.fn()
    const path = '/opt/data/workspace/patent_test_report.md'
    const { rerender } = render(<FilePanel filePath={path} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('All good.')).toBeTruthy())
    rerender(<FilePanel filePath={path} onClose={onClose} />)
    expect(textMock).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('draws an HTML file as a sandboxed page and toggles to its source', async () => {
    textMock.mockResolvedValue('<!doctype html><h1>Hello page</h1>')
    const { container } = render(<FilePanel filePath="/opt/data/workspace/lola.html" onClose={() => {}} />)
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy())
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toContain('Hello page')
    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('<h1>Hello page</h1>')
  })

  it('shows a plain read error with Try again instead of hanging on Loading', async () => {
    textMock.mockRejectedValueOnce(new Error('fs read failed (502)')).mockResolvedValueOnce('Back again')
    render(<FilePanel filePath="/opt/data/workspace/notes.txt" onClose={() => {}} />)
    await screen.findByText("Couldn't open this file")
    expect(screen.getByText(/asleep or restarting/)).toBeTruthy()
    expect(screen.queryByText(/502/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('Back again')
  })

  it('says a picture cannot be shown in plain words, with a download', async () => {
    render(<FilePanel filePath="/opt/data/workspace/cat.png" onClose={() => {}} />)
    await screen.findByText("Can't show this picture here")
    expect(screen.queryByText(/renderer|Unable to preview/)).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Download' }).length).toBe(1)
  })

  it('offers a download for a file it cannot show', () => {
    render(<FilePanel filePath="/opt/data/workspace/archive.zip" onClose={() => {}} />)
    expect(screen.getByText("Can't show this file here")).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
  })

  it('reads the file again on every open and on Refresh, so an edit by the agent shows', async () => {
    const path = '/opt/data/workspace/report.md'
    textMock.mockResolvedValueOnce('Old intro.').mockResolvedValueOnce('New intro.').mockResolvedValueOnce('Newest intro.')
    const { rerender } = render(<FilePanel filePath={path} onClose={() => {}} />)
    await screen.findByText('Old intro.')
    rerender(<FilePanel filePath={null} onClose={() => {}} />)
    rerender(<FilePanel filePath={path} onClose={() => {}} />)
    await screen.findByText('New intro.')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await screen.findByText('Newest intro.')
    expect(textMock).toHaveBeenCalledTimes(3)
  })

  it('titles the panel with the plain name the Files list uses', async () => {
    textMock.mockResolvedValue('{}')
    render(<FilePanel filePath="/opt/data/workspace/leon_profile.json" onClose={() => {}} />)
    expect(screen.getByText('Leon profile')).toBeTruthy()
    expect(screen.getByText('leon_profile.json · in Workspace')).toBeTruthy()
  })

  it('wraps plain text instead of scrolling sideways, and never opens an HTML page in a new tab', async () => {
    textMock.mockResolvedValue('a long line of log output')
    const { container, rerender } = render(<FilePanel filePath="/opt/data/workspace/run.log" onClose={() => {}} />)
    await screen.findByText('a long line of log output')
    expect(container.querySelector('pre[data-wrap]')).toBeTruthy()
    textMock.mockResolvedValue('<h1>Hi</h1>')
    rerender(<FilePanel filePath="/opt/data/workspace/site.html" onClose={() => {}} />)
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Open in new tab' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    expect(screen.getByRole('button', { name: 'Open in new tab' })).toBeTruthy()
  })

  it('says when copying fails instead of doing nothing', async () => {
    textMock.mockResolvedValue('notes')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } })
    render(<FilePanel filePath="/opt/data/workspace/notes.md" onClose={() => {}} />)
    await screen.findByText('notes')
    fireEvent.click(screen.getByRole('button', { name: 'Copy content' }))
    expect(await screen.findByText(/Couldn't copy here/)).toBeTruthy()
  })
})
