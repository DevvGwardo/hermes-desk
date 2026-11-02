import { describe, expect, it } from 'vitest'
import { fileIconFallback, fileIconFor, fileKindLabel } from '../file-icon'

describe('fileIconFor', () => {
  it('maps known extensions to themed glyphs and colors', () => {
    expect(fileIconFor('src/index.ts')).toEqual({
      icon: '🟦',
      color: 'text-[var(--ca-primary)]',
    })
    expect(fileIconFor('main.py').icon).toBe('🐍')
    expect(fileIconFor('assets/logo.png').color).toBe('text-[var(--ca-primary)]')
    expect(fileIconFor('config/app.lock')).toEqual({
      icon: '🔒',
      color: 'text-[var(--ca-warn)]',
    })
  })

  it('is case-insensitive on the extension', () => {
    expect(fileIconFor('README.MD')).toEqual(fileIconFor('readme.md'))
    expect(fileIconFor('photo.JPG').icon).toBe('🖼️')
  })

  it('locks hidden dot-files regardless of extension', () => {
    expect(fileIconFor('.env')).toEqual({ icon: '🔒', color: 'text-[var(--ca-warn)]' })
    expect(fileIconFor('project/.secret.ts').icon).toBe('🔒')
  })

  it('falls back to a neutral document for unknown or missing extensions', () => {
    const fallback = fileIconFallback()
    expect(fileIconFor('Makefile')).toEqual(fallback)
    expect(fileIconFor('data.weird')).toEqual(fallback)
    expect(fileIconFor('folder/')).toEqual(fallback)
  })

  it('uses only the basename of both posix and windows paths', () => {
    // directory named like an image should not win over the real extension
    expect(fileIconFor('/a.png/b.md').icon).toBe('📝')
    expect(fileIconFor('C:\\repo\\app.tsx').icon).toBe('🟦')
    expect(fileIconFor('/tmp/dir.d/x.sh').icon).toBe('🖥️')
  })
})

describe('fileKindLabel', () => {
  it('names the common types in plain words', () => {
    expect(fileKindLabel('/opt/data/workspace/security-tooling-breakdown.md')).toBe('Markdown')
    expect(fileKindLabel('report.PDF')).toBe('PDF')
    expect(fileKindLabel('scrape.py')).toBe('Python')
    expect(fileKindLabel('index.html')).toBe('Web page')
  })

  it('falls back to the extension, or File without one', () => {
    expect(fileKindLabel('notes.weird')).toBe('WEIRD file')
    expect(fileKindLabel('Makefile')).toBe('File')
    expect(fileKindLabel('.env')).toBe('File')
  })
})
