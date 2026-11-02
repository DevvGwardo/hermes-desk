import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  ICO_SIZES,
  checkIcnsBuffer,
  checkIcoBuffer,
  checkTrayBuffer,
  decodePngPixels,
  parseIcoEntries,
  parseIcnsTypes,
} from './check-icons.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const icoBuf = readFileSync(path.join(root, 'build', 'icon.ico'))
const icnsBuf = readFileSync(path.join(root, 'build', 'icon.icns'))
const trayBuf = readFileSync(path.join(root, 'electron', 'trayTemplate.png'))

describe('Pip app icon consistency', () => {
  it('uses the packaged owl master for the runtime Dock and window icon', () => {
    const hash = file => createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')
    expect(hash('electron/icon.png')).toBe(hash('build/icon.png'))
  })

  it.each([
    ['icon.png', 512],
    ['icon-192.png', 192],
    ['apple-touch-icon.png', 180],
    ['icon-maskable-192.png', 192],
    ['icon-maskable-512.png', 512],
    ['favicon.png', 32],
  ])('renders the owl palette at the correct size in %s', (file, size) => {
    const { width, height, rgba } = decodePngPixels(readFileSync(path.join(root, 'public', file)))
    expect([width, height]).toEqual([size, size])
    let warm = 0
    let transparent = 0
    for (let i = 0; i < rgba.length; i += 4) {
      // Pip's brown feathers and golden helmet, not the old blue/white cat.
      if (rgba[i + 3] > 200 && rgba[i] > 100 && rgba[i] > rgba[i + 1] * 1.1 && rgba[i + 1] > rgba[i + 2] * 1.1) warm++
      if (rgba[i + 3] !== 255) transparent++
    }
    expect(warm / (width * height)).toBeGreaterThan(0.05)
    if (file.includes('maskable')) expect(transparent).toBe(0)
  })

  it('routes the historical icon command to the owl generator', () => {
    expect(readFileSync(path.join(root, 'scripts', 'build-app-icons.mjs'), 'utf8'))
      .toContain("../tools/mascot/render-icons.mjs")
  })
})

describe('checkIcoBuffer', () => {
  it('accepts the rebuilt icon.ico', () => {
    const result = checkIcoBuffer(icoBuf)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.entries.map((e) => e.size)).toEqual(ICO_SIZES)
    for (const e of result.entries) expect(e.bpp).toBe(32)
    expect(result.entries.find((e) => e.size === 256).kind).toBe('PNG')
  })

  it('goes red on a crafted single-entry buffer', () => {
    const bad = Buffer.alloc(6 + 16 + 40)
    bad.writeUInt16LE(0, 0)
    bad.writeUInt16LE(1, 2)
    bad.writeUInt16LE(1, 4)
    bad[6] = 16
    bad[7] = 16
    bad.writeUInt16LE(1, 10)
    bad.writeUInt16LE(32, 12)
    bad.writeUInt32LE(40, 14)
    bad.writeUInt32LE(22, 18)
    const result = checkIcoBuffer(bad)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('missing ico entry'))).toBe(true)
  })

  it('goes red on garbage bytes', () => {
    const result = checkIcoBuffer(Buffer.from('not an icon'))
    expect(result.ok).toBe(false)
    expect(() => parseIcoEntries(Buffer.from('not an icon'))).toThrow()
  })
})

describe('checkIcnsBuffer', () => {
  it('pins the 10-type coverage of icon.icns', () => {
    const result = checkIcnsBuffer(icnsBuf)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(parseIcnsTypes(icnsBuf).length).toBeGreaterThanOrEqual(10)
  })

  it('goes red when a pinned type is dropped', () => {
    const cut = icnsBuf.subarray(0, 4).toString('latin1')
    expect(cut).toBe('icns')
    // minimal icns with only one element: magic + total + one 8-byte entry
    const bad = Buffer.alloc(16)
    bad.write('icns', 0, 'latin1')
    bad.writeUInt32BE(16, 4)
    bad.write('ic10', 8, 'latin1')
    bad.writeUInt32BE(8, 12)
    const result = checkIcnsBuffer(bad)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('missing icns type'))).toBe(true)
  })
})

describe('checkTrayBuffer', () => {
  it('accepts the white alpha silhouette', () => {
    const result = checkTrayBuffer(trayBuf)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.info.hasAlpha).toBe(true)
    expect(Math.max(result.info.width, result.info.height)).toBeLessThanOrEqual(64)
  })

  it('goes red on a buffer without alpha', () => {
    const result = checkTrayBuffer(Buffer.from('not a png'))
    expect(result.ok).toBe(false)
  })

  it('goes red on non-white opaque pixels (white>=0.90 rule)', () => {
    // 2x2 RGBA: 3 opaque red + 1 transparent -> whiteFrac=0
    const red = [255, 0, 0, 255]
    const clear = [0, 0, 0, 0]
    const buf = makeRgbaPng(2, 2, [red, red, red, clear])
    const result = checkTrayBuffer(buf)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('white frac'))).toBe(true)
  })

  it('goes red on a fully-opaque png (no transparency)', () => {
    const white = [255, 255, 255, 255]
    const buf = makeRgbaPng(2, 2, [white, white, white, white])
    const result = checkTrayBuffer(buf)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('no transparency'))).toBe(true)
  })
})

function makeRgbaPng(width, height, pixels) {
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const raw = Buffer.alloc((1 + width * 4) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0 // filter 0 (None)
    for (let x = 0; x < width; x++) {
      const p = pixels[y * width + x]
      const d = y * (1 + width * 4) + 1 + x * 4
      raw[d] = p[0]
      raw[d + 1] = p[1]
      raw[d + 2] = p[2]
      raw[d + 3] = p[3]
    }
  }
  const comp = deflateSync(raw)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'latin1')
    data.copy(out, 8)
    return out // CRC unchecked by the gate parser
  }
  return Buffer.concat([pngMagic, chunk('IHDR', ihdr), chunk('IDAT', comp), chunk('IEND', Buffer.alloc(0))])
}
