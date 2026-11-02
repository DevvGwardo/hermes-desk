import { describe, expect, it } from 'vitest'
import { MAX_INLINE_IMAGE_DATA_URL_CHARS } from '../reply-media'
import { liftHtmlImages, markdownVmImagePaths, safeImageUrl, vmImagePath } from '../safe-image-url'

describe('safeImageUrl', () => {
  it('accepts https, local, nub-vm, blob, and data:image', () => {
    expect(safeImageUrl('https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/cloudflare.svg')).toContain(
      'cdn.jsdelivr.net',
    )
    expect(safeImageUrl('/favicon.png')).toBe('/favicon.png')
    expect(safeImageUrl('nub-vm://shot/1.png')).toBe('nub-vm://shot/1.png')
    expect(safeImageUrl('blob:nub-vm/abc')).toBe('blob:nub-vm/abc')
    expect(safeImageUrl('data:image/png;base64,iVBORw0KGgo=')).toMatch(/^data:image\/png/)
  })

  it('rejects script, file, http, credentials, and non-image data', () => {
    expect(safeImageUrl('javascript:alert(1)')).toBeNull()
    expect(safeImageUrl('file:///etc/passwd')).toBeNull()
    expect(safeImageUrl('http://evil.example/x.png')).toBeNull()
    expect(safeImageUrl('https://user:pass@cdn.example/x.png')).toBeNull()
    expect(safeImageUrl('//cdn.example/x.png')).toBeNull()
    expect(safeImageUrl('data:text/html;base64,PHNjcmlwdD4=')).toBeNull()
    expect(safeImageUrl('')).toBeNull()
  })
})

describe('liftHtmlImages', () => {
  it('turns a safe HTML img into markdown and drops onerror', () => {
    const out = liftHtmlImages(
      '## Cloudflare\n<img src="https://www.cloudflare.com/favicon.ico" alt="Cloudflare" onerror="alert(1)">',
    )
    expect(out).toBe('## Cloudflare\n![Cloudflare](https://www.cloudflare.com/favicon.ico)')
  })

  it('strips javascript and file imgs', () => {
    expect(liftHtmlImages('<img src="javascript:alert(1)" alt="x">')).toBe('')
    expect(liftHtmlImages('<img src="file:///tmp/x.png">')).toBe('')
  })
})

describe('safeImageUrl hardening (B-2, B-4)', () => {
  it('refuses svg data URLs, like the inline reply path', () => {
    expect(safeImageUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBeNull()
    expect(safeImageUrl('data:image/SVG+XML;base64,PHN2Zz48L3N2Zz4=')).toBeNull()
    expect(safeImageUrl('data:image/jpeg;base64,/9j/4AAQ')).toMatch(/^data:image\/jpeg/)
  })

  it('refuses data URLs over the shared 2 MB cap', () => {
    const prefix = 'data:image/png;base64,'
    expect(safeImageUrl(prefix + 'A'.repeat(MAX_INLINE_IMAGE_DATA_URL_CHARS - prefix.length))).not.toBeNull()
    expect(safeImageUrl(prefix + 'A'.repeat(MAX_INLINE_IMAGE_DATA_URL_CHARS - prefix.length + 1))).toBeNull()
  })

  it('accepts nub-vm file URLs only for MEDIA-eligible image paths', () => {
    expect(safeImageUrl('nub-vm://file/opt/data/workspace/site/shot.png')).toBe(
      'nub-vm://file/opt/data/workspace/site/shot.png',
    )
    expect(safeImageUrl('nub-vm://file/opt/data/cache/screenshots/a%20b.jpg')).not.toBeNull()
  })

  it('refuses nub-vm file URLs for private, traversal, non-image, or out-of-root paths', () => {
    const bad = [
      'nub-vm://file/opt/data/.hermes/config.yaml',
      'nub-vm://file/opt/data/.hermes/avatar.png',
      'nub-vm://file/opt/data/config.yaml',
      'nub-vm://file/opt/data/workspace/.env.png',
      'nub-vm://file/opt/data/workspace/../.hermes/x.png',
      'nub-vm://file/opt/data/workspace/%2e%2e/.hermes/x.png',
      'nub-vm://file/opt/data/%2Ehermes/x.png',
      'nub-vm://file/etc/passwd',
      'nub-vm://file/root/x.png',
      'nub-vm://file/opt/data/workspace/x.svg',
      'nub-vm://FILE/opt/data/.hermes/config.yaml',
      'nub-vm:///file/opt/data/.hermes/config.yaml',
      'nub-vm:file/opt/data/.hermes/config.yaml',
      'nub-vm://x@file:1/opt/data/.hermes/config.yaml',
      'nub-vm://%66ile/opt/data/.hermes/config.yaml',
      'nub-vm://file\\opt\\data\\.hermes\\x.png',
      'nub-vm://file/opt/data/%zz.png',
    ]
    for (const url of bad) expect(safeImageUrl(url), url).toBeNull()
  })

  it('leaves non-file nub-vm hosts alone', () => {
    expect(safeImageUrl('nub-vm://computer/screenshot')).toBe('nub-vm://computer/screenshot')
    expect(safeImageUrl('nub-vm://shot/1.png')).toBe('nub-vm://shot/1.png')
  })
})

describe('vmImagePath', () => {
  it('maps agent-computer image URLs to their path', () => {
    expect(vmImagePath('/opt/data/workspace/a.png')).toBe('/opt/data/workspace/a.png')
    expect(vmImagePath('file:///opt/data/workspace/a%20b.jpg')).toBe('/opt/data/workspace/a b.jpg')
    expect(vmImagePath('nub-vm://file/opt/data/cache/x.webp?t=1')).toBe('/opt/data/cache/x.webp')
  })

  it('refuses anything a MEDIA tag could not show', () => {
    for (const bad of [
      '/opt/data/.hermes/avatar.png',
      '/opt/data/workspace/../.hermes/x.png',
      'file:///opt/data/workspace/%2e%2e/.hermes/x.png',
      '/opt/data/workspace/page.svg',
      'file:///etc/passwd',
      '/tmp/shot.png',
      'https://example.com/opt/data/a.png',
    ]) {
      expect(vmImagePath(bad), bad).toBeNull()
    }
  })
})

describe('markdownVmImagePaths', () => {
  it('lists agent-computer pictures shown as markdown or HTML images', () => {
    const text = [
      '![Chart](/opt/data/workspace/chart.png)',
      '<img src="nub-vm://file/opt/data/a.jpg" alt="a">',
      '![web](https://example.com/x.png)',
      'plain path /opt/data/workspace/other.png',
    ].join('\n')
    expect(markdownVmImagePaths(text)).toEqual(['/opt/data/workspace/chart.png', '/opt/data/a.jpg'])
  })
})
