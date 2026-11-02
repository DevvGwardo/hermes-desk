import { describe, expect, it } from 'vitest'
import {
  INLINE_IMAGE_MAX_BYTES,
  dataUrlBytes,
  fitWithin,
  inlineImageDataUrl,
  isShrinkableImage,
  shrinkImageToFit,
} from '../image-prep'

describe('fitWithin', () => {
  it('scales the long edge down, keeping the aspect ratio', () => {
    expect(fitWithin(4032, 3024, 1568)).toEqual({ width: 1568, height: 1176 })
    expect(fitWithin(1170, 2532, 1568)).toEqual({ width: 725, height: 1568 })
  })

  it('never upscales', () => {
    expect(fitWithin(800, 600, 1568)).toEqual({ width: 800, height: 600 })
  })
})

describe('image-prep', () => {
  it('only re-encodes formats the canvas keeps intact', () => {
    expect(isShrinkableImage('image/jpeg')).toBe(true)
    expect(isShrinkableImage('image/png')).toBe(true)
    expect(isShrinkableImage('image/gif')).toBe(false)
    expect(isShrinkableImage('image/svg+xml')).toBe(false)
  })

  it('counts the bytes a data URL carries', () => {
    expect(dataUrlBytes('data:image/png;base64,AAAA')).toBe(3)
  })

  it('sends a small picture inline as-is', async () => {
    const url = await inlineImageDataUrl(new File(['png'], 's.png', { type: 'image/png' }))
    expect(url).toMatch(/^data:image\/png;base64,/)
  })

  it('never inlines SVG or non-images', async () => {
    expect(await inlineImageDataUrl(new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }))).toBeNull()
    expect(await inlineImageDataUrl(new File(['x'], 'a.txt', { type: 'text/plain' }))).toBeNull()
  })

  it('falls back to null when the picture cannot be decoded here', async () => {
    const big = new File([new Uint8Array(INLINE_IMAGE_MAX_BYTES + 1)], 'big.jpg', { type: 'image/jpeg' })
    expect(await inlineImageDataUrl(big)).toBeNull()
    expect(await shrinkImageToFit(big, 1024)).toBeNull()
  })

  it('returns the file itself when it already fits', async () => {
    const f = new File(['x'], 'a.jpg', { type: 'image/jpeg' })
    expect(await shrinkImageToFit(f, 1024)).toBe(f)
  })
})
