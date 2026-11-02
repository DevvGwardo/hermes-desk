import { describe, expect, it, vi } from 'vitest'

import {
  cachedLinkPreview,
  embedUrl,
  flushLinkPreviewStoreForTest,
  linkTarget,
  loadLinkPreview,
  previewUrlsIn,
  resetLinkPreviewCacheForTest,
  shortLinkLabel,
  youtubeIdFromUrl,
  canEmbedInline,
} from '../link-preview'

describe('local-only link previews', () => {
  it('never calls the removed hosted bridge or persists a preview', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    expect(await loadLinkPreview('https://example.invalid')).toBeNull()
    expect(cachedLinkPreview('https://example.invalid')).toBeUndefined()
    expect(canEmbedInline()).toBe(false)
    flushLinkPreviewStoreForTest()
    resetLinkPreviewCacheForTest()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('previewUrlsIn', () => {
  it('finds markdown, autolink and bare links in order, deduped', () => {
    const text = [
      'Best one: [https://www.youtube.com/watch?v=dQw4w9WgXcQ](https://www.youtube.com/watch?v=dQw4w9WgXcQ) (official).',
      'Also <https://example.com/a> and https://example.org/b.',
      'Again https://example.com/a',
    ].join('\n')
    expect(previewUrlsIn(text)).toEqual([
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://example.com/a',
      'https://example.org/b',
    ])
  })

  it('caps at three', () => {
    const text = [1, 2, 3, 4, 5].map((n) => `https://e${n}.com/`).join(' ')
    expect(previewUrlsIn(text)).toHaveLength(3)
  })

  it('skips markdown images, code and non-https links, keeps bare image links', () => {
    const text = [
      '![shot](https://cdn.example.com/a.png)',
      '`https://inline.example.com/`',
      '```\nhttps://fenced.example.com/\n```',
      'http://plain.example.com/',
      'https://cdn.example.com/photo.jpg',
    ].join('\n')
    expect(previewUrlsIn(text)).toEqual(['https://cdn.example.com/photo.jpg'])
  })

  it('trims trailing punctuation but keeps balanced parens', () => {
    expect(previewUrlsIn('See https://en.wikipedia.org/wiki/Clueless_(film).')).toEqual([
      'https://en.wikipedia.org/wiki/Clueless_(film)',
    ])
    expect(previewUrlsIn('(see https://example.com/x)')).toEqual(['https://example.com/x'])
  })

  it('drops the fragment', () => {
    expect(previewUrlsIn('https://example.com/a#section')).toEqual(['https://example.com/a'])
  })
})

describe('link helpers', () => {
  it('classifies image and pdf links from the path', () => {
    expect(linkTarget('https://a.com/x/photo.JPG?w=2')).toEqual({ kind: 'image', url: 'https://a.com/x/photo.JPG?w=2' })
    expect(linkTarget('https://a.com/docs/My%20Report.pdf')).toEqual({ kind: 'pdf', url: 'https://a.com/docs/My%20Report.pdf', name: 'My Report.pdf' })
    expect(linkTarget('https://a.com/page')).toEqual({ kind: 'page', url: 'https://a.com/page' })
  })

  it('reads YouTube ids like the platform does', () => {
    expect(youtubeIdFromUrl('https://www.youtube.com/watch?v=Mgjwq1ZzdPQ')).toBe('Mgjwq1ZzdPQ')
    expect(youtubeIdFromUrl('https://youtu.be/Mgjwq1ZzdPQ?t=3')).toBe('Mgjwq1ZzdPQ')
    expect(youtubeIdFromUrl('https://www.youtube.com/shorts/Mgjwq1ZzdPQ')).toBe('Mgjwq1ZzdPQ')
    expect(youtubeIdFromUrl('https://www.youtube.com/@channel')).toBeNull()
    expect(youtubeIdFromUrl('https://evil.com/watch?v=Mgjwq1ZzdPQ')).toBeNull()
  })

  it('builds embed URLs only from valid ids', () => {
    const base = { url: 'https://x', kind: 'video', siteName: null, title: null, description: null, image: null } as const
    expect(embedUrl({ ...base, embed: { provider: 'youtube', id: 'Mgjwq1ZzdPQ' } })).toBe(
      'https://www.youtube-nocookie.com/embed/Mgjwq1ZzdPQ?autoplay=1&rel=0&modestbranding=1&playsinline=1',
    )
    expect(embedUrl({ ...base, embed: { provider: 'youtube', id: 'x" onload="' } })).toBeNull()
    expect(embedUrl({ ...base, embed: { provider: 'spotify', type: 'track', id: '4cOdK2wGLETKBW3PvgPWqT' } })).toBe(
      'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT?utm_source=nub',
    )
    expect(embedUrl({ ...base, embed: { provider: 'spotify', type: 'user' as never, id: '4cOdK2wGLETKBW3PvgPWqT' } })).toBeNull()
  })

  it('shortens bare URLs to host + path', () => {
    expect(shortLinkLabel('https://www.youtube.com/watch?v=Mgjwq1ZzdPQ')).toBe('youtube.com/watch…')
    expect(shortLinkLabel('https://en.wikipedia.org/wiki/Clueless')).toBe('en.wikipedia.org/wiki/Clueless')
    expect(shortLinkLabel('https://example.com/')).toBe('example.com')
    expect(shortLinkLabel('https://docs.example.com/a/very/long/path/that/goes/on/and/on')).toBe('docs.example.com/a/very/long/path/t…')
  })
})
