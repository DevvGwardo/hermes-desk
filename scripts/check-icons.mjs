#!/usr/bin/env node
// Gate for the rebuilt app-icon assets (see scripts/build-icons.mjs).
//
// Fails the build if build/icon.ico drifts from its pinned shape
// (entries 16/24/32/48/64/128/256, 32-bit+alpha, 256 PNG-compressed),
// if build/icon.icns loses type coverage, or if
// electron/trayTemplate.png stops being a small white alpha silhouette
// (macOS template image — dark-mode safe).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const ICO_PATH = join(ROOT, 'build', 'icon.ico')
export const ICNS_PATH = join(ROOT, 'build', 'icon.icns')
export const TRAY_PATH = join(ROOT, 'electron', 'trayTemplate.png')

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
// 10 pinned image types in build/icon.icns (11 entries on disk: 10 image + `info`);
// regression pin, not a spec claim. Any rebuild that drops a size trips this gate.
export const EXPECTED_ICNS_TYPES = ['ic12', 'ic07', 'ic13', 'ic08', 'ic04', 'ic14', 'ic09', 'ic05', 'ic10', 'ic11']
export const TRAY_MAX_DIM = 64

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Parse the ICO directory table. Throws on truncated/bad-magic buffers. */
export function parseIcoEntries(buf) {
  if (buf.length < 6) throw new Error(`ico too short: ${buf.length}`)
  const reserved = buf.readUInt16LE(0)
  const type = buf.readUInt16LE(2)
  const count = buf.readUInt16LE(4)
  if (reserved !== 0 || type !== 1) throw new Error(`bad ico header: reserved=${reserved} type=${type}`)
  if (count === 0 || 6 + count * 16 > buf.length) throw new Error(`bad ico count: ${count}`)
  const entries = []
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16
    const size = buf[o] === 0 ? 256 : buf[o]
    const planes = buf.readUInt16LE(o + 4)
    const bpp = buf.readUInt16LE(o + 6)
    const bytes = buf.readUInt32LE(o + 8)
    const offset = buf.readUInt32LE(o + 12)
    if (offset + bytes > buf.length) throw new Error(`ico entry ${size} out of bounds`)
    const magic = buf.subarray(offset, offset + 8)
    const kind = magic[0] === 0x89 && magic[1] === 0x50 ? 'PNG' : 'BMP'
    entries.push({ size, planes, bpp, bytes, offset, kind })
  }
  return entries
}

export function checkIcoEntries(entries) {
  const errors = []
  const sizes = entries.map((e) => e.size)
  for (const s of ICO_SIZES) {
    if (!sizes.includes(s)) errors.push(`missing ico entry: ${s}x${s}`)
  }
  for (const s of sizes) {
    if (!ICO_SIZES.includes(s)) errors.push(`unexpected ico entry: ${s}x${s}`)
  }
  for (const e of entries) {
    if (e.bpp !== 32) errors.push(`ico ${e.size}x${e.size}: bpp=${e.bpp} want 32`)
    if (e.planes !== 1) errors.push(`ico ${e.size}x${e.size}: planes=${e.planes} want 1`)
  }
  const big = entries.find((e) => e.size === 256)
  if (big && big.kind !== 'PNG') errors.push('ico 256x256: want PNG-compressed, got BMP')
  return { ok: errors.length === 0, errors }
}

export function checkIcoBuffer(buf) {
  try {
    const entries = parseIcoEntries(buf)
    const result = checkIcoEntries(entries)
    result.entries = entries
    return result
  } catch (err) {
    return { ok: false, errors: [String(err.message || err)], entries: [] }
  }
}

/** Parse ICNS element table. Throws on bad magic/truncation. */
export function parseIcnsTypes(buf) {
  if (buf.length < 8) throw new Error(`icns too short: ${buf.length}`)
  if (buf.subarray(0, 4).toString('latin1') !== 'icns') throw new Error('bad icns magic')
  const total = buf.readUInt32BE(4)
  if (total !== buf.length) throw new Error(`icns length mismatch: header=${total} actual=${buf.length}`)
  const types = []
  let o = 8
  while (o + 8 <= buf.length) {
    const type = buf.subarray(o, o + 4).toString('latin1')
    const len = buf.readUInt32BE(o + 4)
    if (len < 8 || o + len > buf.length) throw new Error(`bad icns element ${JSON.stringify(type)} len=${len}`)
    types.push({ type, length: len })
    o += len
  }
  return types
}

export function checkIcnsBuffer(buf) {
  try {
    const types = parseIcnsTypes(buf)
    const names = types.map((t) => t.type)
    const errors = []
    for (const t of EXPECTED_ICNS_TYPES) {
      if (!names.includes(t)) errors.push(`missing icns type: ${t}`)
    }
    const result = { ok: errors.length === 0, errors, types }
    return result
  } catch (err) {
    return { ok: false, errors: [String(err.message || err)], types: [] }
  }
}

/** IHDR-only parse: dimensions, bit depth, color type, alpha presence. */
export function parsePngInfo(buf) {
  if (buf.length < 29 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('bad png magic')
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') throw new Error('png missing IHDR')
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const bitDepth = buf[24]
  const colorType = buf[25]
  if (bitDepth !== 8) throw new Error(`png bitDepth=${bitDepth} want 8`)
  if (![2, 6].includes(colorType)) throw new Error(`png colorType=${colorType} want 2/6`)
  return { width, height, bitDepth, colorType, hasAlpha: colorType === 6 }
}

function unfilterRow(filter, row, prev, channels) {
  const out = Buffer.from(row)
  const stride = channels
  for (let i = 0; i < row.length; i++) {
    const a = i >= stride ? out[i - stride] : 0
    const b = prev ? prev[i] : 0
    const c = i >= stride && prev ? prev[i - stride] : 0
    let v = row[i]
    if (filter === 1) v += a
    else if (filter === 2) v += b
    else if (filter === 3) v += (a + b) >> 1
    else if (filter === 4) {
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    out[i] = v & 0xff
  }
  return out
}

/** Decode 8-bit RGB/RGBA PNGs to raw RGBA pixels. Throws on bad data. */
export function decodePngPixels(buf) {
  const info = parsePngInfo(buf)
  const channels = info.colorType === 6 ? 4 : 3
  const idat = []
  let o = 8
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o)
    const type = buf.subarray(o + 4, o + 8).toString('latin1')
    const data = buf.subarray(o + 8, o + 8 + len)
    if (type === 'IDAT') idat.push(data)
    if (type === 'IEND') break
    o += 12 + len
  }
  if (!idat.length) throw new Error('png has no IDAT')
  const raw = inflateSync(Buffer.concat(idat))
  const rowLen = 1 + info.width * channels
  if (raw.length !== rowLen * info.height) throw new Error('png IDAT size mismatch')
  const rgba = Buffer.alloc(info.width * info.height * 4)
  let prev = null
  for (let y = 0; y < info.height; y++) {
    const row = raw.subarray(y * rowLen + 1, (y + 1) * rowLen)
    const f = raw[y * rowLen]
    if (f > 4) throw new Error(`png bad filter: ${f}`)
    const cur = unfilterRow(f, row, prev, channels)
    prev = cur
    for (let x = 0; x < info.width; x++) {
      const d = (y * info.width + x) * 4
      const s = x * channels
      rgba[d] = cur[s]
      rgba[d + 1] = cur[s + 1]
      rgba[d + 2] = cur[s + 2]
      rgba[d + 3] = channels === 4 ? cur[s + 3] : 0xff
    }
  }
  return { ...info, rgba }
}

export function checkTrayBuffer(buf) {
  let dec
  try {
    dec = decodePngPixels(buf)
  } catch (err) {
    return { ok: false, errors: [String(err.message || err)], info: null }
  }
  const errors = []
  if (!dec.hasAlpha) errors.push('tray png: missing alpha channel')
  if (Math.max(dec.width, dec.height) > TRAY_MAX_DIM) {
    errors.push(`tray png: ${dec.width}x${dec.height} exceeds ${TRAY_MAX_DIM}px`)
  }
  let opaque = 0
  let white = 0
  for (let i = 0; i < dec.rgba.length; i += 4) {
    if (dec.rgba[i + 3] > 10) {
      opaque += 1
      if (dec.rgba[i] > 200 && dec.rgba[i + 1] > 200 && dec.rgba[i + 2] > 200) white += 1
    }
  }
  const total = dec.width * dec.height
  const transparent = total - opaque
  if (opaque === 0) errors.push('tray png: fully transparent')
  if (transparent === 0) errors.push('tray png: no transparency (want silhouette with alpha bg)')
  const whiteFrac = opaque ? white / opaque : 0
  if (opaque > 0 && whiteFrac < 0.9) errors.push(`tray png: white frac=${whiteFrac.toFixed(2)} want >= 0.90`)
  const info = { width: dec.width, height: dec.height, hasAlpha: dec.hasAlpha, opaque, transparent, whiteFrac }
  return { ok: errors.length === 0, errors, info }
}

export function checkIconFiles(icoPath = ICO_PATH, icnsPath = ICNS_PATH, trayPath = TRAY_PATH) {
  const errors = []
  const summary = {}
  for (const [label, path] of [['ico', icoPath], ['icns', icnsPath], ['tray', trayPath]]) {
    if (!existsSync(path)) errors.push(`missing ${path}`)
    else summary[label] = statSync(path).size
  }
  if (errors.length) return { ok: false, errors, summary }
  const ico = checkIcoBuffer(readFileSync(icoPath))
  const icns = checkIcnsBuffer(readFileSync(icnsPath))
  const tray = checkTrayBuffer(readFileSync(trayPath))
  for (const r of [ico, icns, tray]) {
    for (const e of r.errors) errors.push(e)
  }
  return { ok: errors.length === 0, errors, summary, ico, icns, tray }
}

const invoked = process.argv[1] && process.argv[1].endsWith('check-icons.mjs')
if (invoked) {
  const result = checkIconFiles()
  if (!result.ok) {
    console.error('ICON_FAIL')
    for (const err of result.errors.slice(0, 20)) console.error(' -', err)
    if (result.errors.length > 20) console.error(` - … ${result.errors.length - 20} more`)
    process.exit(1)
  }
  const icoSizes = result.ico.entries.map((e) => e.size).join(',')
  const tray = result.tray.info
  console.log(`ICON_OK ico entries=${result.ico.entries.length} sizes=${icoSizes} bytes=${result.summary.ico}`)
  console.log(`ICON_OK icns types=${result.icns.types.length} bytes=${result.summary.icns}`)
  console.log(
    `ICON_OK tray ${tray.width}x${tray.height} rgba opaque=${tray.opaque} white=${tray.whiteFrac.toFixed(2)} bytes=${result.summary.tray}`,
  )
}
