import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import FilePreview from '../FilePreview'
import { LocalMedia as VmMedia } from '../LocalMedia'
import { downloadVmFile } from '../FileCard'
import { ChatPanel } from '../ChatPanel'
import { resetChatImagesForTests } from '../../lib/chat-images'
import { StrictMode } from 'react'

/** Files the stubbed desktop bridge serves: bytes (data URL), text, or an error. */
const FILES: Record<string, { dataUrl?: string; text?: string; error?: string }> = {}

beforeEach(() => {
  ;(window as unknown as { nubAgent: unknown }).nubAgent = {
    hermes: (_kind: string, args: string[]) => {
      const [verb, path = ''] = args
      const f = FILES[path]
      if (verb === 'read-data-url') {
        if (f?.error) return Promise.resolve({ ok: false, error: f.error })
        return Promise.resolve(f?.dataUrl ? { ok: true, data: f.dataUrl } : { ok: false, error: 'ENOENT' })
      }
      if (verb === 'read-text') {
        return Promise.resolve(f?.text !== undefined ? { ok: true, data: { content: f.text } } : { ok: false, error: 'ENOENT' })
      }
      if (verb === 'stat') return Promise.resolve({ ok: true, data: { isDirectory: false, size: 10, mtimeMs: 0 } })
      return Promise.resolve({ ok: false, error: 'unsupported' })
    },
  }
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  resetChatImagesForTests()
  for (const k of Object.keys(FILES)) delete FILES[k]
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
})

describe('file preview of binaries', () => {
  it('uses native Save a copy without reading or falling back to base64', async () => {
    const saveAs = vi.fn(async () => true)
    const read = vi.spyOn(window.nubAgent!, 'hermes')
    window.nubAgent!.localFiles = { saveAs, pickMedia: vi.fn(), releaseImport: vi.fn() }
    expect(await downloadVmFile('/Users/me/large.mp4')).toBeNull()
    expect(saveAs).toHaveBeenCalledWith('/Users/me/large.mp4')
    expect(read).not.toHaveBeenCalled()
    saveAs.mockRejectedValueOnce(new Error('refused'))
    expect(await downloadVmFile('/Users/me/large.mp4')).toContain('Could not save')
    expect(read).not.toHaveBeenCalled()
  })

  it('retains an imported preview across StrictMode replay and releases it when closed', async () => {
    const releaseImport = vi.fn(async () => {})
    window.nubAgent!.localFiles = { saveAs: vi.fn(), pickMedia: vi.fn(), releaseImport }
    FILES['/Users/me/imported.mp4'] = { dataUrl: 'data:video/mp4;base64,AAAAIGZ0eXA=' }
    const view = render(<StrictMode><FilePreview open filePath="/Users/me/imported.mp4" onClose={() => {}} /></StrictMode>)
    await waitFor(() => expect(document.querySelector('video')).toBeTruthy())
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(releaseImport).not.toHaveBeenCalled()
    view.rerender(<StrictMode><FilePreview open={false} filePath="/Users/me/imported.mp4" onClose={() => {}} /></StrictMode>)
    await waitFor(() => expect(releaseImport).toHaveBeenCalledWith('/Users/me/imported.mp4'))
  })
  it('never shows a zip as text or offers to edit it', async () => {
    FILES['/Users/me/site.zip'] = { text: 'PK\u0003\u0004garbled' }
    render(<FilePreview open filePath="/Users/me/site.zip" onClose={() => {}} />)
    expect(screen.getByText('No preview for this kind of file.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download site.zip' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByText(/garbled/)).toBeNull()
  })

  it('plays audio in the preview', async () => {
    FILES['/Users/me/voice.mp3'] = { dataUrl: 'data:application/octet-stream;base64,SUQzBAAAAAAA' }
    render(<FilePreview open filePath="/Users/me/voice.mp3" onClose={() => {}} />)
    await waitFor(() => expect(document.querySelector('audio')).toBeTruthy())
    const audio = document.querySelector('audio')!
    expect(audio.getAttribute('src')).toMatch(/^blob:/)
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})

describe('audio and video in the chat', () => {
  it('reads nothing until Play, then plays in place', async () => {
    const read = vi.fn()
    FILES['/Users/me/clip.mp4'] = { dataUrl: 'data:video/mp4;base64,AAAAIGZ0eXA=' }
    const bridge = (window as unknown as { nubAgent: { hermes: (k: string, a: string[]) => Promise<unknown> } }).nubAgent
    const orig = bridge.hermes
    bridge.hermes = (k, a) => {
      read(a[0])
      return orig(k, a)
    }
    render(<VmMedia path="/Users/me/clip.mp4" />)
    expect(read).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play clip.mp4' })))
    const video = await screen.findByLabelText('clip.mp4')
    expect(video.tagName).toBe('VIDEO')
    expect(video.hasAttribute('autoplay')).toBe(true)
  })

  it('says a file is too big to play instead of offering a retry that cannot work', async () => {
    FILES['/Users/me/long.mov'] = { error: 'File too large' }
    const onDownload = vi.fn()
    render(<VmMedia path="/Users/me/long.mov" onDownload={onDownload} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play long.mov' })))
    expect(await screen.findByText(/exceeds the 10 MB preview limit/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(onDownload).toHaveBeenCalledWith('/Users/me/long.mov')
  })
})

describe('downloads', () => {
  it('explains a file too big to download instead of "try again"', async () => {
    FILES['/Users/me/big.zip'] = { error: 'File too large' }
    expect(await downloadVmFile('/Users/me/big.zip')).toMatch(/Over 10 MB, too big to download here/)
  })
})

function dataTransfer(entries: Array<{ file: File; dir?: boolean }>) {
  return {
    types: ['Files'],
    files: entries.map((e) => e.file),
    items: entries.map((e) => ({
      kind: 'file',
      getAsFile: () => e.file,
      webkitGetAsEntry: () => ({ isDirectory: Boolean(e.dir), name: e.file.name }),
    })),
    dropEffect: 'none',
  }
}

describe('dropping files on the chat', () => {
  it('shows a drop target over the whole chat, and names a dropped folder instead of failing to read it', () => {
    const onAttachLocalFiles = vi.fn()
    render(<ChatPanel messages={[]} threadKey="t1" onSend={() => {}} onAttachLocalFiles={onAttachLocalFiles} />)
    const chat = document.querySelector('section')!
    const dt = dataTransfer([{ file: new File(['a'], 'notes.txt') }, { file: new File([''], 'photos'), dir: true }])
    fireEvent.dragEnter(chat, { dataTransfer: dt })
    expect(screen.getByTestId('chat-drop-overlay')).toBeTruthy()
    fireEvent.drop(chat, { dataTransfer: dt })
    expect(screen.queryByTestId('chat-drop-overlay')).toBeNull()
    expect(onAttachLocalFiles.mock.calls[0]![0].map((f: File) => f.name)).toEqual(['notes.txt'])
    const folder = screen.getByTestId('composer-attachments').querySelector('li[data-status="failed"]')!
    expect(folder.getAttribute('aria-label')).toMatch(/^photos, Folders can’t be sent/)
  })

  it('ignores a drag that carries no files (text being moved)', () => {
    render(<ChatPanel messages={[]} threadKey="t1" onSend={() => {}} onAttachLocalFiles={vi.fn()} />)
    fireEvent.dragEnter(document.querySelector('section')!, { dataTransfer: { types: ['text/plain'] } })
    expect(screen.queryByTestId('chat-drop-overlay')).toBeNull()
  })
})

describe('Play waits for the reader', () => {
  it('a video card is a button until pressed', async () => {
    render(<VmMedia path="/Users/me/x.webm" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play x.webm' })).toBeTruthy())
  })
})
