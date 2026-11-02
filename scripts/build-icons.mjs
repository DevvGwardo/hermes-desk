// Reproducible Windows .ico generator — no ad-hoc icon editors.
//
// Rebuilds build/icon.ico from the 1024px master build/icon.png with entries
// 16/24/32/48/64/128/256, 32-bit+alpha throughout, 256 PNG-compressed.
// The master itself is never modified. Idempotent: same input -> same bytes.
//
//   node scripts/build-icons.mjs
//
// Primary path shells out to python3+PIL (manual ICO writer, fully
// deterministic); falls back to ImageMagick if PIL is unavailable.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'build', 'icon.png')
const DST = join(ROOT, 'build', 'icon.ico')
const SIZES = [16, 24, 32, 48, 64, 128, 256]

const PY = [
  'import io, struct, sys',
  'from PIL import Image',
  'src, dst = sys.argv[1], sys.argv[2]',
  'sizes = [int(x) for x in sys.argv[3].split(",")]',
  'master = Image.open(src).convert("RGBA")',
  'blobs = []',
  'for s in sizes:',
  '    img = master.resize((s, s), Image.LANCZOS)',
  '    if s >= 256:',
  '        buf = io.BytesIO()',
  '        img.save(buf, format="PNG")',
  '        blobs.append(buf.getvalue())',
  '    else:',
  '        px = img.tobytes("raw", "BGRA")',
  '        row = s * 4',
  '        xor = b"".join(px[(s - 1 - y) * row:(s - y) * row] for y in range(s))',
  '        androw = ((s + 31) // 32) * 4',
  '        andmask = b"\\x00" * (androw * s)',
  '        dib = struct.pack("<IiiHHIIiiII", 40, s, s * 2, 1, 32, 0, len(xor) + len(andmask), 0, 0, 0, 0)',
  '        blobs.append(dib + xor + andmask)',
  'out = bytearray(struct.pack("<HHH", 0, 1, len(sizes)))',
  'off = 6 + 16 * len(sizes)',
  'for s, b in zip(sizes, blobs):',
  '    w = 0 if s == 256 else s',
  '    out += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(b), off)',
  '    off += len(b)',
  'for b in blobs:',
  '    out += b',
  'open(dst, "wb").write(bytes(out))',
].join('\n')

function parseIco(buf) {
  const count = buf.readUInt16LE(4)
  const rows = []
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16
    const w = buf[o] === 0 ? 256 : buf[o]
    const size = buf.readUInt32LE(o + 8)
    const imgOff = buf.readUInt32LE(o + 12)
    const magic = buf.subarray(imgOff, imgOff + 8)
    const kind = magic[0] === 0x89 && magic[1] === 0x50 ? 'PNG' : 'BMP'
    rows.push({ size: w, bpp: buf.readUInt16LE(o + 6), bytes: size, kind })
  }
  return rows
}

function printTable(rows, bytes) {
  for (const r of rows) console.log(`  ${r.size}x${r.size} bpp=${r.bpp} bytes=${r.bytes} ${r.kind}`)
  console.log(`total ${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}…`)
}

function tryPython() {
  const r = spawnSync('python3', ['-', SRC, DST, SIZES.join(',')], {
    input: PY,
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  return r.status === 0
}

function tryMagick() {
  const bin = spawnSync('which', ['magick']).status === 0 ? 'magick' : 'convert'
  const r = spawnSync(bin, [SRC, '-define', `icon:auto-resize=${SIZES.join(',')}`, DST], { stdio: 'inherit' })
  return r.status === 0
}

let ok = false
try {
  // Probe PIL first so the fallback only runs when needed.
  const probe = spawnSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' })
  ok = probe.status === 0 ? tryPython() : tryMagick()
} catch {
  ok = false
}
if (!ok) {
  console.error('[build-icons] FAILED: need python3+PIL or ImageMagick')
  process.exit(1)
}
const bytes = readFileSync(DST)
console.log(`[build-icons] ${DST} entries:`)
printTable(parseIco(bytes), bytes)
