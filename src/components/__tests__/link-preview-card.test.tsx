import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { LinkPreviews, formatAgo, formatCount, formatDuration } from '../LinkPreviewCard'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete window.nubAgent })
describe('formatting', () => {
  it('formats durations, counts and ages', () => {
    expect(formatDuration(147)).toBe('2:27')
    expect(formatDuration(3725)).toBe('1:02:05')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(2751226)).toBe('2.8M')
    expect(formatAgo('2026-10-02T11:59:30Z', Date.parse('2026-10-02T12:00:00Z'))).toBe('just now')
  })
})
describe('local-only link previews', () => {
  it('renders URL-only cards and never requests hosted metadata or embeds', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const preview = vi.fn()
    window.nubAgent = { nubLinkPreview: preview } as unknown as Window['nubAgent']
    render(<LinkPreviews text="https://example.com/page and https://youtu.be/Mgjwq1ZzdPQ" />)
    await Promise.resolve()
    expect(screen.getByTestId('link-preview')).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
    expect(preview).not.toHaveBeenCalled()
    expect(document.querySelector('iframe')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Play/ })).toBeNull()
  })
})
