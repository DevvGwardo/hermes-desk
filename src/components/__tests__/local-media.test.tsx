import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LocalMedia } from '../LocalMedia'
import { resetChatImagesForTests } from '../../lib/chat-images'

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
afterEach(() => { cleanup(); resetChatImagesForTests(); delete window.nubAgent; vi.restoreAllMocks() })
describe('local audio and video', () => {
  it('reads audio through local IPC only after Play', async () => {
    const hermes = vi.fn(async () => ({ ok: true, data: 'data:audio/mpeg;base64,SUQz' }))
    window.nubAgent = { hermes } as unknown as Window['nubAgent']
    const { container } = render(<LocalMedia path="/fake/project/fixture.mp3" />)
    expect(hermes).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Play/ }))
    await waitFor(() => expect(container.querySelector('audio')).toBeTruthy())
    expect(hermes).toHaveBeenCalledWith('fs', ['read-data-url', '/fake/project/fixture.mp3'])
    expect(container.querySelector('audio')?.getAttribute('src')).toMatch(/^(blob:|data:audio\/)/)
    expect(container.querySelector('iframe')).toBeNull()
  })
  it('does not read unplayed video automatically', () => {
    const hermes = vi.fn()
    window.nubAgent = { hermes } as unknown as Window['nubAgent']
    render(<LocalMedia path="/fake/project/fixture.mp4" />)
    expect(hermes).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Play/ })).toBeTruthy()
  })
  it('streams through a scoped desktop media URL and releases it when closed', async () => {
    const open = vi.fn(async () => 'hd-media://fixture/media')
    const release = vi.fn(async () => {})
    const hermes = vi.fn()
    window.nubAgent = { media: { open, release }, hermes } as unknown as Window['nubAgent']
    const { container, unmount } = render(<LocalMedia path="/fake/project/large.mp4" />)
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Play large.mp4' }))
    await waitFor(() => expect(container.querySelector('video')?.getAttribute('src')).toBe('hd-media://fixture/media'))
    expect(open).toHaveBeenCalledExactlyOnceWith('/fake/project/large.mp4')
    expect(hermes).not.toHaveBeenCalled()
    unmount()
    expect(release).toHaveBeenCalledExactlyOnceWith('hd-media://fixture/media')
  })
  it('shows an actionable decoder failure rather than leaving a blank player', async () => {
    window.nubAgent = { media: { open: async () => 'hd-media://fixture/media', release: async () => {} } } as unknown as Window['nubAgent']
    const { container } = render(<LocalMedia path="/fake/project/damaged.mp4" autoLoad />)
    await waitFor(() => expect(container.querySelector('video')).toBeTruthy())
    fireEvent.error(container.querySelector('video')!)
    expect(screen.getByRole('alert').textContent).toMatch(/codec|damaged/i)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
  it('does not bypass a refused streaming request with a legacy filesystem read', async () => {
    const hermes = vi.fn()
    window.nubAgent = { media: { open: async () => { throw new Error('outside home') }, release: async () => {} }, hermes } as unknown as Window['nubAgent']
    render(<LocalMedia path="/outside/denied.mp4" autoLoad />)
    await screen.findByRole('alert')
    expect(hermes).not.toHaveBeenCalled()
  })
  it('releases a source that arrives after its player has closed', async () => {
    let resolve!: (url: string) => void
    const release = vi.fn(async () => {})
    window.nubAgent = { media: { open: () => new Promise<string>(r => { resolve = r }), release } } as unknown as Window['nubAgent']
    const { unmount } = render(<LocalMedia path="/fake/clip.mp4" autoLoad />)
    unmount()
    resolve('hd-media://late/media')
    await waitFor(() => expect(release).toHaveBeenCalledExactlyOnceWith('hd-media://late/media'))
  })
  it('never reuses the previous source when switching files and previews do not autoplay', async () => {
    const release = vi.fn(async () => {})
    window.nubAgent = { media: { open: async (path: string) => `hd-media://fixture/${path.split('/').at(-1)}`, release } } as unknown as Window['nubAgent']
    const { container, rerender, unmount } = render(<LocalMedia path="/fake/first.mp4" autoLoad />)
    await waitFor(() => expect(container.querySelector('video')?.src).toContain('first.mp4'))
    expect(container.querySelector('video')?.hasAttribute('autoplay')).toBe(false)
    rerender(<LocalMedia path="/fake/second.mp4" autoLoad />)
    expect(container.querySelector('video')).toBeNull()
    await waitFor(() => expect(container.querySelector('video')?.src).toContain('second.mp4'))
    expect(release).toHaveBeenCalledWith('hd-media://fixture/first.mp4')
    unmount()
    expect(release).toHaveBeenCalledWith('hd-media://fixture/second.mp4')
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled()
  })
  it('pauses playback when navigating away', async () => {
    // Resolve the source inside act so React commits the player AND flushes
    // its passive effect (the hashchange listener) before we navigate. Under
    // full-suite load, an un-awaited resolve could surface the <video> to
    // findBy* before that effect ran, and the event was missed.
    let resolve!: (url: string) => void
    window.nubAgent = { media: { open: () => new Promise<string>(r => { resolve = r }), release: async () => {} } } as unknown as Window['nubAgent']
    render(<LocalMedia path="/fake/clip.mp4" autoLoad />)
    await act(async () => { resolve('hd-media://fixture/media') })
    expect(screen.getByLabelText('clip.mp4')).toBeTruthy()
    window.dispatchEvent(new Event('hashchange'))
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce()
  })
})
