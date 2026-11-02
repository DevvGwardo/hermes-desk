import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../lib/agents'
import { fileCardsForMessage } from '../file-refs'
import { screenshotPathsFromMessage } from '../project-artifacts'
import {
  MAX_INLINE_IMAGE_DATA_URL_CHARS,
  MAX_REPLY_MEDIA_IMAGES,
  extractReplyMedia,
  isRenderableInlineDataUrl,
  IMAGE_SHARE_NOTE,
  withImageShareNote,
} from '../reply-media'

const SHOT = '/opt/data/cache/screenshots/browser_screenshot_ab12.png'

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'content'>): ChatMessage {
  return {
    threadId: 't1',
    role: 'agent',
    createdAt: '2026-09-27T00:00:00Z',
    ...partial,
  }
}

describe('extractReplyMedia', () => {
  it('recognizes quoted absolute local video paths without admitting traversal or secrets', () => {
    const path = '/Users/example/.video-tools/output/my clip.mp4'
    expect(extractReplyMedia(`Ready. MEDIA:"${path}"`).media).toEqual([path])
    for (const path of ['/Users/example/../secret.mp4', '/Users/example/.env.mp4', '//host/clip.mp4']) {
      expect(extractReplyMedia(`MEDIA:${path}`).media).toEqual([])
    }
  })
  it('strips a plain tag and keeps underscores in the path', () => {
    expect(extractReplyMedia(`Here it is MEDIA:${SHOT}`)).toEqual({ text: 'Here it is', images: [SHOT], inline: [], media: [] })
  })

  it('leaves a sentence-final period behind', () => {
    expect(extractReplyMedia(`Here it is MEDIA:${SHOT}.`)).toEqual({ text: 'Here it is.', images: [SHOT], inline: [], media: [] })
  })

  it('keeps an underscore-heavy screenshot filename whole', () => {
    const p = '/opt/data/cache/screenshots/browser__screenshot_2026_09_27__ab_12_.png'
    expect(extractReplyMedia(`Done: MEDIA:${p} _(full page)_`)).toEqual({
      text: 'Done: _(full page)_',
      images: [p],
      inline: [],
      media: [],
    })
    expect(extractReplyMedia(`_MEDIA:${p}_`).images).toEqual([p])
  })

  it('handles backticked and bold-wrapped tags', () => {
    expect(extractReplyMedia('Shot: `MEDIA:/opt/data/a.png` done')).toEqual({
      text: 'Shot: done',
      images: ['/opt/data/a.png'],
      inline: [],
      media: [],
    })
    expect(extractReplyMedia('**MEDIA:/opt/data/x_y.png**')).toEqual({ text: '', images: ['/opt/data/x_y.png'], inline: [], media: [] })
    expect(extractReplyMedia('see MEDIA:`/opt/data/b.jpeg` ok').images).toEqual(['/opt/data/b.jpeg'])
  })

  it('reads a quoted path with spaces, case-insensitively', () => {
    expect(extractReplyMedia('media: "/opt/data/my shot.JPG" there')).toEqual({
      text: 'there',
      images: ['/opt/data/my shot.JPG'],
      inline: [],
      media: [],
    })
  })

  it('collects multiple tags, deduped', () => {
    const out = extractReplyMedia('One MEDIA:/opt/data/a.png\ntwo MEDIA:/opt/data/b.webp, again MEDIA:/opt/data/a.png')
    expect(out.images).toEqual(['/opt/data/a.png', '/opt/data/b.webp'])
    expect(out.text).toBe('One\ntwo, again')
  })

  it('renders a non-image tag as the bare path in backticks', () => {
    expect(extractReplyMedia('Report: MEDIA:/opt/data/workspace/report.pdf')).toEqual({
      text: 'Report: `/opt/data/workspace/report.pdf`',
      images: [],
      inline: [],
      media: [],
    })
  })

  it('does not show images outside /opt/data or with .. segments', () => {
    expect(extractReplyMedia('MEDIA:/tmp/a.png and MEDIA:/opt/data/../etc/a.png')).toEqual({
      text: '`/tmp/a.png` and `/opt/data/../etc/a.png`',
      images: [],
      inline: [],
      media: [],
    })
  })

  it('never shows svg, agent config or secrets as images', () => {
    expect(extractReplyMedia('MEDIA:/opt/data/a.svg').text).toBe('`/opt/data/a.svg`')
    for (const p of ['/opt/data/.hermes/shot.png', '/opt/data/workspace/.env.png', '/opt/data/config.yaml']) {
      expect(extractReplyMedia(`MEDIA:${p}`)).toEqual({ text: `\`${p}\``, images: [], inline: [], media: [] })
    }
  })

  it('pulls inlined base64 images out of the text', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const gif = 'data:image/gif;base64,R0lGOD+/'
    expect(extractReplyMedia(`Here ![image](${png}) and\n\n![x](${gif})\n\nbye`)).toEqual({
      text: 'Here and\n\nbye',
      images: [],
      inline: [
        { dataUrl: png, mime: 'image/png' },
        { dataUrl: gif, mime: 'image/gif' },
      ],
      media: [],
    })
    // svg data URLs are not images here.
    const svg = '![x](data:image/svg+xml;base64,PHN2Zz4=)'
    expect(extractReplyMedia(svg)).toEqual({ text: svg, images: [], inline: [], media: [] })
  })

  it('shares the cap between paths and inline images', () => {
    const inline = Array.from({ length: 4 }, (_, i) => `![i](data:image/png;base64,AA${i}=)`).join(' ')
    const out = extractReplyMedia(`${inline} MEDIA:/opt/data/a.png MEDIA:/opt/data/b.png MEDIA:/opt/data/c.png`)
    expect(out.inline).toHaveLength(4)
    expect(out.images).toEqual(['/opt/data/a.png', '/opt/data/b.png'])
    expect(out.text).toBe('`/opt/data/c.png`')
  })

  it('collapses the blank lines a removed tag leaves', () => {
    expect(extractReplyMedia('Line1\n\nMEDIA:/opt/data/a.png\n\nLine2').text).toBe('Line1\n\nLine2')
  })

  it('caps images; extra ones stay as bare paths', () => {
    const tags = Array.from({ length: MAX_REPLY_MEDIA_IMAGES + 1 }, (_, i) => `MEDIA:/opt/data/${i}.png`)
    const out = extractReplyMedia(tags.join('\n'))
    expect(out.images).toHaveLength(MAX_REPLY_MEDIA_IMAGES)
    expect(out.text).toBe(`\`/opt/data/${MAX_REPLY_MEDIA_IMAGES}.png\``)
  })

  it('is safe on partial streaming text and untouched text', () => {
    expect(extractReplyMedia('partial MEDIA:/opt/data/cache/scr')).toEqual({
      text: 'partial `/opt/data/cache/scr`',
      images: [],
      inline: [],
      media: [],
    })
    expect(extractReplyMedia('almost MEDIA:').text).toBe('almost MEDIA:')
    const md = '  indented\n    - nested  two  \n'
    expect(extractReplyMedia(md)).toEqual({ text: md, images: [], inline: [], media: [] })
    expect(extractReplyMedia('')).toEqual({ text: '', images: [], inline: [], media: [] })
  })
})

describe('MEDIA tags in a message', () => {
  it('yields one VmShot path and no file card for the image', () => {
    const m = msg({ id: 'm1', content: `Here it is MEDIA:${SHOT}` })
    expect(screenshotPathsFromMessage(m)).toEqual([SHOT])
    expect(fileCardsForMessage(m)).toEqual([])
  })

  it('shows a quoted path with spaces as a shot', () => {
    const m = msg({ id: 'm2', content: 'Done MEDIA:"/opt/data/my shot.png"' })
    expect(screenshotPathsFromMessage(m)).toEqual(['/opt/data/my shot.png'])
  })

  it('drops the card even when a tool event also names the image', () => {
    const m = msg({
      id: 'm3',
      content: `MEDIA:${SHOT}`,
      toolEvents: [{ tool: 'write_file', args: JSON.stringify({ path: SHOT }) } as NonNullable<ChatMessage['toolEvents']>[number]],
    })
    expect(screenshotPathsFromMessage(m)).toEqual([SHOT])
    expect(fileCardsForMessage(m).map((r) => r.path)).not.toContain(SHOT)
  })

  it('keeps a file card for a non-image MEDIA path', () => {
    const m = msg({ id: 'm4', content: 'MEDIA:/opt/data/workspace/report.pdf' })
    expect(fileCardsForMessage(m).map((r) => r.path)).toEqual(['/opt/data/workspace/report.pdf'])
  })

  it('still shows a bare /opt/data image path with no tag', () => {
    const m = msg({ id: 'm6', content: `Saved ${SHOT} for you` })
    expect(screenshotPathsFromMessage(m)).toEqual([SHOT])
  })

  it('shows no shot for a refused private path', () => {
    const m = msg({ id: 'm7', content: 'MEDIA:/opt/data/.hermes/x.png' })
    expect(screenshotPathsFromMessage(m)).toEqual([])
  })

  it('never reads MEDIA tags from user messages', () => {
    const m = msg({ id: 'm5', role: 'user', content: `MEDIA:${SHOT}` })
    expect(fileCardsForMessage(m)).toEqual([])
  })
})

describe('inline image byte cap (B-1)', () => {
  const prefix = 'data:image/png;base64,'

  it('keeps an inline image at the cap and drops one over it', () => {
    const atCap = prefix + 'A'.repeat(MAX_INLINE_IMAGE_DATA_URL_CHARS - prefix.length)
    expect(extractReplyMedia(`ok ![s](${atCap})`).inline).toEqual([{ dataUrl: atCap, mime: 'image/png' }])

    const over = prefix + 'A'.repeat(MAX_INLINE_IMAGE_DATA_URL_CHARS - prefix.length + 1)
    const out = extractReplyMedia(`before ![s](${over}) after`)
    expect(out.inline).toEqual([])
    // The megabytes of base64 do not fall through as text either.
    expect(out.text).toBe('before after')
  })

  it('stays fast on a huge unterminated data URL', () => {
    const huge = `![s](${prefix}${'A'.repeat(8_000_000)}`
    const t0 = Date.now()
    const out = extractReplyMedia(huge)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(out.inline).toEqual([])
  })

  it('isRenderableInlineDataUrl enforces raster-only and the cap', () => {
    expect(isRenderableInlineDataUrl(`${prefix}iVBORw0KGgo=`)).toBe(true)
    expect(isRenderableInlineDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
    expect(isRenderableInlineDataUrl(prefix + 'A'.repeat(MAX_INLINE_IMAGE_DATA_URL_CHARS))).toBe(false)
  })
})

describe('withImageShareNote', () => {
  it('appends the MEDIA: note, or sends it alone', () => {
    expect(withImageShareNote('')).toBe(IMAGE_SHARE_NOTE)
    expect(withImageShareNote('You are Chief.')).toBe(`You are Chief.\n\n${IMAGE_SHARE_NOTE}`)
  })

  it('teaches the exact tag shape extractReplyMedia renders', () => {
    expect(IMAGE_SHARE_NOTE).toMatch(/never \/tmp/)
    expect(IMAGE_SHARE_NOTE).toMatch(/other file .* \/opt\/data\/workspace\//)
    const reply = 'Here it is.\nMEDIA:/opt/data/workspace/screenshot.png'
    expect(extractReplyMedia(reply).images).toEqual(['/opt/data/workspace/screenshot.png'])
  })
})
