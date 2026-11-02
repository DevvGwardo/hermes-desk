// Pip evidence harness. Run: node tools/blueprint/mascot.mjs
// Owns no product code. Failures remain red and carry actionable finding anchors.
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReport, BP_OUT } from './lib/report.mjs'
import { launchHarness, waitFor } from '../../tests/e2e/harness.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(BP_OUT, 'mascot')
const GOLDENS = path.join(ROOT, 'tools/blueprint/goldens/mascot')
const STATES = ['idle', 'thinking', 'tool', 'browsing', 'waiting', 'talking', 'happy', 'error', 'sleep']
const SIZES = [16, 24, 40, 64, 160]
const PALETTES = Object.keys(JSON.parse(readFileSync(path.join(ROOT, 'src/lib/mascot/characters/owl/palette.json'))).agents)
const report = createReport('mascot')
const screenshots = [], findings = [], untested = [], testCorrections = [
  'First execution reached the HUD and timed out because the shared launcher sets NUB_SMOKE (about:blank HUD) and the test looked for the wrong HUD URL. The harness now temporarily clears only that smoke flag for HUD creation, matches ?win=hud, and restores it. Product code is unchanged.',
  'Visual review caught contact sheets and the icon sheet cropped by the viewport. Page captures now use fullPage, and contact-sheet completeness is measured.',
  'Holding the entry bundle also held DOMContentLoaded, so Playwright waited forever for document.fonts.ready on the splash. Its capture now uses the real Electron capturePage after freezing only the splash pulse.',
  'Visual review caught a native splash capture targeting the still-open HUD. The harness now closes the HUD from its authorized renderer, captures the exact main-window URL, and measures capture dimensions.',
  'Coordinator clarified mascot contract §3: reduced motion intentionally permits occasional blinks. The old strictly-static finding is removed; the replacement compares actual non-eye RGBA pixels over 240 deterministic frames.',
]
// Preserve coordinator-visible finding IDs. BP-MASCOT-2 is retired: blinking
// under reduced motion is intended by contract §3, not a product failure.
const findingIds = new Map([
  ['The mascot silhouette crowds or leaves its frame.', 1],
  ['Old mascot remains in sidebar rows instead of Pip.', 3],
  ['Old mascot remains in agent card instead of Pip.', 4],
  ['Old mascot remains in chat header instead of Pip.', 5],
  ['Starter suggestions show near-white text on pale pink chips.', 6],
  ['The Pip HUD still identifies the app as Nub.', 7],
  ['Pip appears in the real pre-React splash', 8],
  ['Renderer logs a failed notifications request while the mascot is displayed.', 9],
])
let nextFindingId = 10
const manifestPath = path.join(GOLDENS, 'manifest.json')
const initialGoldens = !existsSync(manifestPath)
const manifest = initialGoldens ? { version: 1, createdAt: new Date().toISOString(), clockMs: 1200, scale: 2, frames: [] }
  : JSON.parse(readFileSync(manifestPath, 'utf8'))
const goldenIds = new Set([
  ...STATES.flatMap(state => [0, 3, 7].map(p => `${state}-${PALETTES[p]}-160`)),
  'waiting-sage-40', 'happy-honey-16', 'error-mint-64',
])
for (const dir of [OUT, path.join(OUT, 'frames'), path.join(OUT, 'ui'), GOLDENS]) mkdirSync(dir, { recursive: true })
report.report.method = {
  matrix: '9 states × 8 actual owl agent palettes × 16/24/40/64/160 CSS px, DPR 2',
  clock: 'Production createMascot + ManualFrameClock, fixed seed per state/palette/size, 1200ms at 60Hz',
  silhouette: 'Alpha > 32, FX removed only from silhouette analysis; padded raster catches artwork outside the frame',
  contrast: 'WCAG relative luminance, median opaque silhouette pixel versus both #161617 and #1c1c1e; required 3:1',
  face: 'Transformed face/eye boxes at 40px; luminance standard deviation >= 20 and >= 3% dark pixels',
  margin: 'Silhouette >= 1 CSS px from frame edge; wing/ear/helmet tip geometry includes stroke allowance',
  goldens: initialGoldens ? 'First run creates 30 reference frames; creation is not independent regression proof.'
    : `Exact RGBA comparison against 30 baselines first created ${manifest.createdAt ?? 'on this task’s first run'}. Existing baselines are never overwritten.`,
}

function promise(name, ok, detail, anchor, fix, size = 'S', group = name) {
  report.check(name, ok, detail)
  if (ok) return
  let finding = findings.find(item => item.group === group)
  if (!finding) {
    finding = { id: `BP-MASCOT-${findingIds.get(group) ?? nextFindingId++}`, group, userSees: group, anchor, fix, size, evidence: [] }
    findings.push(finding)
  }
  finding.evidence.push({ check: name, measured: detail })
  report.report.checks.at(-1).findingId = finding.id
}
function errors(page, label) {
  page.on('console', message => { if (message.type() === 'error') report.consoleError(`${label}: ${message.text()}`) })
  page.on('pageerror', error => report.consoleError(`${label}: pageerror: ${error.message}`))
}
const hash = data => createHash('sha256').update(data).digest('hex')
function diff(a, b) {
  if (a.length !== b.length) return { changed: Math.max(a.length, b.length), max: 255, mean: 255, dimensionsMismatch: true }
  let changed = 0, sum = 0, max = 0
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); changed += Number(d > 0); sum += d; max = Math.max(max, d) }
  return { changed, max, mean: sum / a.length }
}
function rgbMeanDiff(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      // Composite onto actual messenger charcoal, not arbitrary transparent RGB.
      const av = a[i + c] * a[i + 3] / 255 + 28 * (1 - a[i + 3] / 255)
      const bv = b[i + c] * b[i + 3] / 255 + 28 * (1 - b[i + 3] / 255)
      sum += Math.abs(av - bv)
    }
  }
  return sum / (a.length / 4 * 3)
}
async function decode(page, png) {
  const raw = await page.evaluate(async data => {
    const image = new Image()
    image.src = `data:image/png;base64,${data}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width; canvas.height = image.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let text = ''
    for (let i = 0; i < pixels.length; i += 8192) text += String.fromCharCode(...pixels.subarray(i, i + 8192))
    return btoa(text)
  }, png.toString('base64'))
  return Buffer.from(raw, 'base64')
}
async function screenshot(page, name, caption, locator = page) {
  const file = path.join(OUT, 'ui', `${name}.png`)
  await locator.screenshot({ path: file, animations: 'disabled', ...(locator === page ? { fullPage: true } : {}) })
  const scale = await page.evaluate(() => devicePixelRatio)
  screenshots.push({ path: file, caption, deviceScaleFactor: scale })
  return file
}

// Runs inside the actual mascot lab origin. This adds fixtures, not a duplicate rig.
async function prepareMatrix(page) {
  await page.evaluate(async () => {
    const [{ createMascot }, { ManualFrameClock }, { characters, agentPalettes }] = await Promise.all([
      import('/src/lib/mascot/engine.ts'), import('/src/lib/mascot/frame-clock.ts'), import('/src/lib/mascot/registry.ts'),
    ])
    document.querySelector('main').style.display = 'none'
    const host = document.createElement('section')
    host.id = 'bp-matrix'
    host.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;padding:10px'
    document.body.append(host)
    window.bpMascot = { createMascot, ManualFrameClock, character: characters.owl, palettes: agentPalettes(characters.owl), host, handles: [] }
  })
}
async function matrixState(page, state) {
  await page.evaluate(state => {
    const bp = window.bpMascot
    bp.handles.forEach(handle => handle.destroy()); bp.host.replaceChildren()
    bp.clock = new bp.ManualFrameClock()
    bp.frames = []
    for (const { name, palette } of bp.palettes) for (const size of [16, 24, 40, 64, 160]) {
      const el = document.createElement('span')
      el.style.cssText = `display:inline-block;width:${size}px;height:${size}px;line-height:0`
      bp.host.append(el)
      const handle = bp.createMascot(el, { svg: bp.character.svg, motion: bp.character.motion, state, palette, size,
        seed: `blueprint:${state}:${name}:${size}`, clock: bp.clock, idPrefix: `bp-${state}-${name}-${size}` })
      bp.frames.push({ el, state, palette: name, size, handle })
    }
    bp.handles = bp.frames.map(frame => frame.handle)
  }, state)
  await page.waitForFunction(() => window.bpMascot.clock.subscribers === 40)
  await page.evaluate(() => window.bpMascot.clock.advance(1200))
  return page.evaluate(async () => {
    const bp = window.bpMascot
    const luminance = rgb => {
      const c = rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
    }
    const contrast = (rgb, bg) => { const a = luminance(rgb), b = luminance(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
    const encode = data => {
      let text = ''
      for (let i = 0; i < data.length; i += 8192) text += String.fromCharCode(...data.subarray(i, i + 8192))
      return btoa(text)
    }
    const box = (node, svg, size) => {
      const b = node.getBBox(), m = svg.getScreenCTM().inverse().multiply(node.getScreenCTM())
      const points = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
        .map(([x, y]) => new DOMPoint(x, y).matrixTransform(m))
      return { x: Math.min(...points.map(p => p.x)) * size / 512, y: Math.min(...points.map(p => p.y)) * size / 512,
        right: Math.max(...points.map(p => p.x)) * size / 512, bottom: Math.max(...points.map(p => p.y)) * size / 512 }
    }
    async function raster(svg, size, padded, silhouette) {
      const clone = svg.cloneNode(true)
      if (silhouette) clone.querySelector('[data-mascot-fx]')?.remove()
      // Resolve computed CSS palette variables before serializing into an Image.
      const styles = getComputedStyle(svg)
      clone.innerHTML = clone.innerHTML.replace(/var\((--m-[\w-]+)(?:,\s*([^)]+))?\)/g, (_, key, fallback) => styles.getPropertyValue(key).trim() || fallback)
      clone.removeAttribute('style')
      clone.setAttribute('viewBox', padded ? '-128 -128 768 768' : '0 0 512 512')
      const n = padded ? size * 3 : size * 2
      clone.setAttribute('width', n); clone.setAttribute('height', n)
      const image = new Image()
      image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(clone))))}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = n
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      return { canvas, ctx, pixels: ctx.getImageData(0, 0, n, n).data, n }
    }
    const frames = []
    for (const frame of bp.frames) {
      const { el, size, state, palette } = frame, svg = el.querySelector('svg')
      const image = await raster(svg, size, false, false)
      const silhouette = await raster(svg, size, true, true)
      let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, ink = 0
      const contrasts = [[], []]
      for (let i = 0; i < silhouette.pixels.length; i += 4) {
        if (silhouette.pixels[i + 3] <= 32) continue
        const x = i / 4 % silhouette.n, y = Math.floor(i / 4 / silhouette.n)
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); ink++
        if (silhouette.pixels[i + 3] >= 240) {
          const rgb = [...silhouette.pixels.slice(i, i + 3)]
          contrasts[0].push(contrast(rgb, [22, 22, 23])); contrasts[1].push(contrast(rgb, [28, 28, 30]))
        }
      }
      const offset = size / 2
      const bounds = { x: (minX - offset) / 2, y: (minY - offset) / 2,
        right: (maxX + 1 - offset) / 2, bottom: (maxY + 1 - offset) / 2 }
      const margin = Math.min(bounds.x, bounds.y, size - bounds.right, size - bounds.bottom)
      const face = ['eye-l', 'eye-r', 'lid-l', 'lid-r'].map(name => box(svg.querySelector(`[data-mascot-part="${name}"]`), svg, size))
      const faceBox = { x: Math.min(...face.map(b => b.x)), y: Math.min(...face.map(b => b.y)),
        right: Math.max(...face.map(b => b.right)), bottom: Math.max(...face.map(b => b.bottom)) }
      const samples = []
      for (let y = Math.max(0, Math.floor(faceBox.y * 2)); y < Math.min(size * 2, Math.ceil(faceBox.bottom * 2)); y++) {
        for (let x = Math.max(0, Math.floor(faceBox.x * 2)); x < Math.min(size * 2, Math.ceil(faceBox.right * 2)); x++) {
          const i = (y * size * 2 + x) * 4
          if (image.pixels[i + 3] >= 240) samples.push(image.pixels[i] * .2126 + image.pixels[i + 1] * .7152 + image.pixels[i + 2] * .0722)
        }
      }
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length
      const variance = samples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / samples.length
      const tips = ['wing-l', 'wing-r', 'ear-l', 'ear-r', 'helmet-wing-l', 'helmet-wing-r'].map(name => {
        const b = box(svg.querySelector(`[data-mascot-part="${name}"]`), svg, size)
        return { name, ...b, margin: Math.min(b.x, b.y, size - b.right, size - b.bottom) - 3 * size / 512 }
      })
      const computed = getComputedStyle(svg)
      const primary = computed.getPropertyValue('--m-primary').trim()
      const color = primary.match(/[0-9a-f]{2}/gi).map(v => parseInt(v, 16))
      frames.push({ id: `${state}-${palette}-${size}`, state, palette, size,
        png: image.canvas.toDataURL('image/png').split(',')[1], rgba: encode(image.pixels),
        metrics: { ink, coverage: ink / (size * size * 4), bounds, margin, tips, faceBox,
          faceStddev: Math.sqrt(variance), faceDarkFraction: samples.filter(v => v < 100).length / samples.length,
          contrast: contrasts.map(values => { values.sort((a, b) => a - b); return { median: values[Math.floor(values.length / 2)],
            p10: values[Math.floor(values.length * .1)], fractionAtLeast3: values.filter(v => v >= 3).length / values.length } }),
          computedPrimary: primary, primaryContrast: [[22, 22, 23], [28, 28, 30]].map(bg => contrast(color, bg)) } })
    }
    return frames
  })
}

async function contactSheet(browser, frames, state) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1140 }, deviceScaleFactor: 2 })
  errors(page, 'contact sheet')
  await page.setContent(`<style>body{margin:0;padding:22px;background:#161617;color:#eee;font:13px system-ui}h1{font-size:22px}section{display:flex;align-items:center;gap:12px;margin-bottom:12px}b{width:62px}figure{margin:0;width:205px;display:flex;align-items:center;gap:12px}img{image-rendering:auto}small{color:#aaa}</style><h1>Pip / ${state} / 1200ms / DPR 2</h1>${PALETTES.map(palette => `<section><b>${palette}</b>${frames.filter(f => f.palette === palette).map(f => `<figure><img src="data:image/png;base64,${f.png}" width="${f.size}" height="${f.size}"><small>${f.size}px</small></figure>`).join('')}</section>`).join('')}`)
  await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())))
  const coverage = await page.evaluate(() => ({ count: document.images.length, decoded: [...document.images].filter(i => i.complete && i.naturalWidth > 0).length }))
  promise(`The ${state} contact sheet includes every matrix frame`, coverage.count === 40 && coverage.decoded === 40,
    coverage, 'tools/blueprint/mascot.mjs', 'Keep all forty frames in the full-page inspection sheet.')
  await screenshot(page, `matrix-${state}`, `Every ${state} palette at all five sizes, native CSS size; all 40 frames visible.`, page)
  await page.close()
}

async function runMatrix(browser, page) {
  await prepareMatrix(page)
  const first = new Map(), pairs = []
  for (let pass = 1; pass <= 2; pass++) {
    for (const state of STATES) {
      const frames = await matrixState(page, state)
      for (const frame of frames) {
        const raw = Buffer.from(frame.rgba, 'base64')
        if (pass === 2) {
          const d = diff(first.get(frame.id).raw, raw)
          promise(`Pip renders deterministically: ${frame.id}`, d.max === 0, d,
            'src/lib/mascot/engine.ts:60', 'Keep seeded procedural motion and fixed clock input deterministic.', 'S', 'The same mascot inputs must produce identical pixels.')
          continue
        }
        const png = Buffer.from(frame.png, 'base64')
        writeFileSync(path.join(OUT, 'frames', `${frame.id}.png`), png)
        first.set(frame.id, { ...frame, raw })
        const m = frame.metrics
        promise(`Pip is not blank: ${frame.id}`, m.ink > 0 && m.coverage >= .1,
          { silhouettePixels: m.ink, coverage: m.coverage }, 'src/lib/mascot/engine.ts:43', 'Preserve visible rig artwork in every state.', 'S', 'The mascot is visible in every matrix combination.')
        promise(`Pip has frame margin: ${frame.id}`, m.margin >= 1, { bounds: m.bounds, minimumMarginCssPx: m.margin, required: 1 },
          'src/lib/mascot/characters/owl/motion.json:122', 'Inset the rig or bound the animated pose to retain a 1px margin.', 'S', 'The mascot silhouette crowds or leaves its frame.')
        for (const [i, bg] of ['#161617', '#1c1c1e'].entries()) {
          promise(`Pip contrasts with ${bg}: ${frame.id}`, m.contrast[i].median >= 3 && m.primaryContrast[i] >= 3,
            { background: bg, ...m.contrast[i], computedPrimary: m.computedPrimary, primaryContrast: m.primaryContrast[i], required: 3 },
            'src/lib/mascot/characters/owl/palette.json:12', 'Choose a brighter primary and silhouette fill for the dark messenger backgrounds.', 'S', `The mascot is hard to distinguish from ${bg}.`)
        }
        promise(`Pip wing and ear tips stay inside the frame: ${frame.id}`, m.tips.every(t => t.margin >= 0), m.tips,
          'src/lib/mascot/characters/owl/motion.json:126', 'Reduce wing/helmet rotations or add safe rig inset without clipping overflow.', 'S', 'Wing or ear tips extend outside the mascot frame.')
        if (frame.size === 40) {
          promise(`Pip face remains readable at 40px: ${state}-${frame.palette}`, m.faceStddev >= 20 && m.faceDarkFraction >= .03,
            { faceBox: m.faceBox, luminanceStddev: m.faceStddev, darkFraction: m.faceDarkFraction, requiredStddev: 20, requiredDarkFraction: .03 },
            'src/lib/mascot/characters/owl/rig.svg:73', 'Preserve eye/lid contrast and simplify the face at sidebar size.', 'S', 'The owl face loses its features at sidebar size.')
        }
        if (goldenIds.has(frame.id)) {
          const file = path.join(GOLDENS, `${frame.id}.png`)
          if (initialGoldens) {
            writeFileSync(file, png)
            manifest.frames.push({ id: frame.id, file: `${frame.id}.png`, rgbaSha256: hash(raw), size: frame.size })
          }
          const baseline = existsSync(file) ? await decode(page, readFileSync(file)) : Buffer.alloc(0)
          const d = diff(baseline, raw)
          promise(`Pip matches its golden frame: ${frame.id}`, d.max === 0 && !d.dimensionsMismatch,
            { ...d, createdThisRun: initialGoldens, path: file },
            'src/lib/mascot/characters/owl/rig.svg:1', 'Inspect the regression; do not overwrite baselines merely to make the test pass.', 'S', 'The owl differs from its committed visual reference.')
        }
      }
      if (pass === 1) await contactSheet(browser, frames, state)
    }
  }
  for (const palette of PALETTES) for (let i = 0; i < STATES.length; i++) for (let j = i + 1; j < STATES.length; j++) {
    pairs.push({ palette, a: STATES[i], b: STATES[j], meanAbsDiff255:
      rgbMeanDiff(first.get(`${STATES[i]}-${palette}-160`).raw, first.get(`${STATES[j]}-${palette}-160`).raw) })
  }
  const sorted = pairs.map(p => p.meanAbsDiff255).sort((a, b) => a - b)
  // Initial calibration uses the population median, NOT each pair's minimum.
  // Frozen with the goldens; subsequent runs cannot lower it to hide a regression.
  manifest.stateThreshold255 ??= Math.max(2, sorted[Math.floor(sorted.length / 2)] * .25)
  report.report.method.stateDistinguishability = `160px RGB MAD on #1c1c1e; threshold ${manifest.stateThreshold255.toFixed(6)}/255, initially max(2, 25% of all 288 pairwise median MAD), frozen in manifest.`
  for (const pair of pairs) {
    promise(`Pip states look different: ${pair.palette} ${pair.a}/${pair.b}`, pair.meanAbsDiff255 >= manifest.stateThreshold255,
      { ...pair, threshold255: manifest.stateThreshold255 },
      'src/lib/mascot/characters/owl/motion.json:2', 'Give the two states more distinct head, wing, or face poses.', 'S', 'Two mascot states are visually too similar.')
  }
  report.measure('Matrix frames per pass', first.size, 'frames', 'Nine states × eight palettes × five sizes, sampled at 1200ms; two complete passes.')
  report.measure('State separation minimum / median', [sorted[0], sorted[Math.floor(sorted.length / 2)]], 'MAD / 255', 'All 36 state pairs for each of eight palettes at 160 CSS px.')
  report.measure('Minimum matrix silhouette margin', Math.min(...[...first.values()].map(f => f.metrics.margin)), 'CSS px', 'Padded silhouette raster includes any overflow outside the original viewBox.')
  writeFileSync(path.join(OUT, 'matrix.json'), JSON.stringify([...first.values()].map(({ png, rgba, raw, ...frame }) => frame), null, 2))
  writeFileSync(path.join(OUT, 'state-pairs.json'), JSON.stringify(pairs, null, 2))
  if (initialGoldens) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  promise('Pip has thirty committed golden references', manifest.frames.length === 30 && goldenIds.size === 30,
    { count: manifest.frames.length, createdThisRun: initialGoldens }, manifestPath, 'Restore the expected representative baselines.')
}

async function runPerformance(page, labUrl) {
  await page.goto(`${labUrl}&perf=1`)
  await page.waitForFunction(() => window.mascotLab?.ready && window.mascotLab.stats().subscribers === 13)
  await page.waitForFunction(() => window.mascotLab.stats().frames >= 90)
  await page.evaluate(() => window.mascotLab.resetStats())
  await page.waitForFunction(() => window.mascotLab.stats().frames >= 300, null, { timeout: 15000 })
  const stats = await page.evaluate(() => window.mascotLab.stats())
  promise('One hero and twelve small owls use less than 2ms script per frame', stats.meanMs < 2 && stats.p95Ms < 2,
    { ...stats, requiredMeanAndP95Ms: 2 }, 'src/lib/mascot/frame-clock.ts:34', 'Profile SVG transform writes and avoid extra per-instance work.', 'M')
  promise('One hero and twelve small owls sustain 60fps', stats.fps >= 58, { fps: stats.fps, frames: stats.frames, minimumWithSchedulingTolerance: 58 },
    'src/lib/mascot/frame-clock.ts:34', 'Reduce frame workload; preserve one shared clock for all instances.', 'M')
  for (const [name, value, unit] of [['Script mean', stats.meanMs, 'ms/frame'], ['Script p95', stats.p95Ms, 'ms/frame'], ['Shared clock FPS', stats.fps, 'fps']]) {
    report.measure(name, value, unit, 'Production lab perf=1, 1 × 160px plus 12 × 40px; 90 warm-up + 300 sampled shared-clock frames.')
  }
  await screenshot(page, 'performance', 'Real production lab performance fixture with one hero and twelve small owls.')
  for (const mode of ['offscreen', 'hidden']) {
    await page.evaluate(mode => {
      const gallery = document.querySelector('[data-gallery]')
      gallery.style.transform = mode === 'offscreen' ? 'translateY(3000px)' : ''
      gallery.style.display = mode === 'hidden' ? 'none' : ''
    }, mode)
    await page.waitForFunction(() => window.mascotLab.stats().subscribers === 0)
    const before = await page.evaluate(() => window.mascotLab.stats())
    // A timed observation window measures absence of work, not readiness.
    const after = await page.evaluate(() => new Promise(resolve => setTimeout(() => resolve(window.mascotLab.stats()), 1000)))
    promise(`Pip does no rAF work while ${mode}`, after.frames === before.frames && after.subscribers === 0,
      { beforeFrames: before.frames, afterFrames: after.frames, subscribers: after.subscribers, observationMs: 1000 },
      'src/lib/mascot/visibility.ts:16', 'Unsubscribe invisible instances and cancel the shared rAF when none remain.', 'S')
  }
  await page.evaluate(() => { const el = document.querySelector('[data-gallery]'); el.style.display = ''; el.style.transform = '' })
  await page.waitForFunction(() => window.mascotLab.stats().subscribers === 13)
  promise('Pip resumes when its placements become visible again', true, await page.evaluate(() => window.mascotLab.stats()),
    'src/lib/mascot/engine.ts:200', 'Re-subscribe when IntersectionObserver marks the host visible.')

  await page.goto(`${labUrl}&capture=1&reduced=1`)
  await page.waitForFunction(() => window.mascotLab?.ready && document.querySelector('svg[data-mascot-profile="reduced"]'))
  const changes = await page.evaluate(async () => {
    const svg = document.querySelector('[data-size="160"] svg')
    const size = 320
    const eyeBoxes = ['eye-l', 'eye-r', 'lid-l', 'lid-r'].map(name => {
      const node = svg.querySelector(`[data-mascot-part="${name}"]`)
      const b = node.getBBox(), m = svg.getScreenCTM().inverse().multiply(node.getScreenCTM())
      const points = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
        .map(([x, y]) => new DOMPoint(x, y).matrixTransform(m))
      // Two raster pixels cover eye/lid stroke and antialiasing, not the
      // entire face. Head, brows, beak, wings, body and helmet stay compared.
      return { x: Math.floor(Math.min(...points.map(p => p.x)) * size / 512) - 2,
        y: Math.floor(Math.min(...points.map(p => p.y)) * size / 512) - 2,
        right: Math.ceil(Math.max(...points.map(p => p.x)) * size / 512) + 2,
        bottom: Math.ceil(Math.max(...points.map(p => p.y)) * size / 512) + 2 }
    })
    const mask = new Uint8Array(size * size)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      mask[y * size + x] = Number(eyeBoxes.some(b => x >= b.x && x < b.right && y >= b.y && y < b.bottom))
    }
    async function raster() {
      const clone = svg.cloneNode(true), styles = getComputedStyle(svg)
      clone.innerHTML = clone.innerHTML.replace(/var\((--m-[\w-]+)(?:,\s*([^)]+))?\)/g,
        (_, key, fallback) => styles.getPropertyValue(key).trim() || fallback)
      clone.removeAttribute('style'); clone.setAttribute('width', size); clone.setAttribute('height', size)
      const image = new Image()
      image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(clone))))}`
      await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
      return { pixels: ctx.getImageData(0, 0, size, size).data, png: canvas.toDataURL('image/png').split(',')[1] }
    }
    const initial = await raster()
    let nonEyeChangedFrames = 0, nonEyeChangedChannels = 0, nonEyeMaxDiff255 = 0, blinkFrames = 0, firstBlinkMs = null, blinkPng = null
    for (let ms = 50; ms <= 12000; ms += 50) {
      window.mascotLab.advance(50)
      const current = await raster()
      let eyeChanged = false, nonEyeChanged = false
      for (let i = 0; i < current.pixels.length; i++) {
        const d = Math.abs(current.pixels[i] - initial.pixels[i])
        if (!d) continue
        if (mask[Math.floor(i / 4)]) eyeChanged = true
        else { nonEyeChanged = true; nonEyeChangedChannels++; nonEyeMaxDiff255 = Math.max(nonEyeMaxDiff255, d) }
      }
      if (nonEyeChanged) nonEyeChangedFrames++
      if (eyeChanged) { blinkFrames++; firstBlinkMs ??= ms; blinkPng ??= current.png }
    }
    return { comparedFrames: 240, observedMs: 12000, rasterSize: size, nonEyeChangedFrames, nonEyeChangedChannels, nonEyeMaxDiff255,
      blinkFrames, firstBlinkMs, eyeBoxes, comparedNonEyePixels: mask.filter(value => !value).length,
      reducedProfile: svg.dataset.mascotProfile, initialPng: initial.png, blinkPng }
  })
  const { initialPng, blinkPng, ...pixels } = changes
  writeFileSync(path.join(OUT, 'frames/reduced-motion-before.png'), Buffer.from(initialPng, 'base64'))
  if (blinkPng) writeFileSync(path.join(OUT, 'frames/reduced-motion-blink.png'), Buffer.from(blinkPng, 'base64'))
  promise('Reduced motion: no movement except blinks', pixels.nonEyeMaxDiff255 === 0 && pixels.nonEyeChangedFrames === 0, pixels,
    'src/lib/mascot/engine.ts:130', 'Honor mascot contract §3: freeze every non-eye region while allowing occasional blinks.', 'S',
    'Reduced-motion owls move outside the allowed blink regions.')
  report.measure('Reduced-motion non-eye maximum pixel difference', pixels.nonEyeMaxDiff255, '/255',
    '240 DPR-2 rasters over 12 deterministic seconds; only transformed eye/lid boxes plus 2 raster pixels of stroke/AA allowance excluded.')
  report.report.method.reducedMotion = 'Mascot contract §3, static pose with occasional blinks; actual RGBA pixels outside four eye/lid boxes remain exactly identical.'
  await screenshot(page, 'reduced-motion', 'Reduced profile after 12 deterministic seconds: non-eye pixels compared exactly; occasional blinks are permitted by contract §3.')
}

async function placements(h) {
  const { page, app } = h
  errors(page, 'real app')
  const failedResponses = []
  report.report.failedResponses = failedResponses
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ pathname: new URL(response.url()).pathname, status: response.status() })
  })
  await page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Beta', exact: true }).waitFor()
  const host = await page.evaluate(() => window.nubAgent.host.status())
  report.measure('Spawn to populated fixture roster', performance.now() - h.launchedAt, 'ms', 'Existing isolated launchHarness launchedAt to Alpha/Beta visible buttons; includes real serve startup.')
  promise('Mascot placement evidence comes from real isolated Hermes serve', host.serve.mode === 'spawned' && h.env.HERMES_DESK_E2E_BACKGROUND === '1',
    { serveMode: host.serve.mode, hermesHomeIsTemporary: h.env.HERMES_HOME.startsWith(h.root), background: h.env.HERMES_DESK_E2E_BACKGROUND },
    'tests/e2e/harness.mjs:20', 'Use the existing isolated real-serve launcher without diagnostic adapters.')
  // Existing production hook is not present on this branch. Use real UI instead.
  const hook = await page.evaluate(() => Boolean(window.__hermesDesk))
  report.measure('window.__hermesDesk automation hook available', hook, 'boolean', 'Read from the real App renderer; absent on this branch, interactions use semantic UI/IPC.')
  await page.getByRole('button', { name: 'Alpha', exact: true }).click()
  await page.locator('.hd-agent-card').waitFor()
  await page.locator('.messenger-header-pill').waitFor()
  for (const [name, selector, anchor] of [
    ['sidebar rows', '.hd-agent-row .hd-agent-avatar', 'src/components/AgentCard.tsx:47'],
    ['agent card', '.hd-agent-card .hd-agent-avatar', 'src/components/AgentCard.tsx:47'],
    ['chat header', '.messenger-header-pill', 'src/components/TopBar.tsx:113'],
  ]) {
    const result = await page.locator(selector).evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect(), owl = node.querySelector('[data-character="owl"]')
      const svg = node.querySelector('svg')
      return { owl: Boolean(owl?.querySelector('svg')), anySvg: Boolean(svg), width: box.width, height: box.height,
        renderedKind: owl ? 'owl' : svg ? 'non-owl SVG (FatCatIcon/GrokOrb)' : 'missing',
        title: svg?.querySelector('title')?.textContent ?? null }
    }))
    promise(`Pip renders in ${name}`, result.length > 0 && result.every(row => row.owl && row.width > 0 && row.height > 0), result,
      anchor, 'Replace FatCatIcon at this placement with AgentMascot, preserving the agent palette and presence.', 'S', `Old mascot remains in ${name} instead of Pip.`)
  }
  // Visual inspection caught near-white text on pastel starter chips.
  const starterContrast = await page.locator('[data-testid="chat-starters"] button').evaluateAll(nodes => {
    const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number)
    const luminance = color => rgb(color).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
    return nodes.map(node => {
      const s = getComputedStyle(node), a = luminance(s.color), b = luminance(s.backgroundColor)
      return { label: node.textContent, color: s.color, background: s.backgroundColor, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }
    })
  })
  promise('Starter text noticed during mascot inspection is readable', starterContrast.length > 0 && starterContrast.every(item => item.contrast >= 4.5),
    { values: starterContrast, required: 4.5 }, 'src/index.css:672', 'Give pastel starter chips dark text or change their backgrounds to meet 4.5:1.', 'S',
    'Starter suggestions show near-white text on pale pink chips.')
  await screenshot(page, 'app-placements', 'Actual isolated sidebar, selected agent card, and chat header. This exposes any remaining old mascot placements.')
  await h.send('alpha', 'chat')
  await page.getByRole('group', { name: 'Message actions for Alpha' }).getByText('Local-only and deterministic.', { exact: false }).waitFor()
  promise('Agent chat can stream while mascot placements are mounted', h.model.errors.length === 0 && h.model.requests.length > 0,
    { fakeModelRequests: h.model.requests.length, errors: h.model.errors }, 'src/components/AgentMascot.tsx:55', 'Keep mascot lifecycle independent of chat streaming.', 'S')

  // The production HUD uses showInactive. Contain it offscreen before opening;
  // suppress show/showInactive only for newly created test windows. No app code edit.
  await app.evaluate(({ BrowserWindow }) => {
    const original = BrowserWindow.prototype.showInactive
    const originalShow = BrowserWindow.prototype.show
    const mainIds = new Set(BrowserWindow.getAllWindows().map(win => win.id))
    const smoke = process.env.NUB_SMOKE
    delete process.env.NUB_SMOKE
    globalThis.__bpHudRestore = () => {
      BrowserWindow.prototype.showInactive = original; BrowserWindow.prototype.show = originalShow
      if (smoke !== undefined) process.env.NUB_SMOKE = smoke
    }
    BrowserWindow.prototype.showInactive = function (...args) { if (mainIds.has(this.id)) return original.apply(this, args) }
    BrowserWindow.prototype.show = function (...args) { if (mainIds.has(this.id)) return originalShow.apply(this, args) }
  })
  await page.evaluate(() => window.nubAgent.hud.open())
  const hud = await waitFor(async () => app.windows().find(win => win.url().includes('win=hud')), 'HUD renderer', 20000)
  errors(hud, 'HUD')
  await hud.waitForFunction(() => {
    const el = document.querySelector('[data-character="owl"]')
    return el?.querySelector('svg') && el.getBoundingClientRect().width > 0
  })
  const hudMetrics = await hud.locator('[data-character="owl"]').evaluateAll(nodes => nodes.map(node => {
    const b = node.getBoundingClientRect()
    return { width: b.width, height: b.height, state: node.querySelector('svg')?.dataset.mascotState, profile: node.querySelector('svg')?.dataset.mascotProfile }
  }))
  const native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL().includes('win=hud')).map(win => ({ visible: win.isVisible(), focused: win.isFocused() })))
  promise('Pip renders in the background-only HUD', hudMetrics.length > 0 && hudMetrics.every(m => m.width > 0 && m.height > 0) && native.every(win => !win.visible && !win.focused),
    { placements: hudMetrics, native, diagnostic: 'Test-only wrapper suppresses showing the new HUD; production renderer and preload unchanged.' },
    'src/components/HudShell.tsx:661', 'Render AgentMascot in the HUD without opening a focus-stealing test window.')
  await screenshot(hud, 'hud', 'Real HUD renderer kept hidden by a test-only window-show guard.')
  const hudBrand = await hud.locator('[data-testid="hud-header"]').textContent()
  promise('The mascot HUD identifies itself as Hermes Desk', hudBrand?.trim() === 'Hermes Desk',
    { displayedHeader: hudBrand?.trim() }, 'src/components/HudShell.tsx:760', 'Replace the visible Nub label and Ask Nub placeholder with Hermes Desk/Pip branding.', 'S',
    'The Pip HUD still identifies the app as Nub.')
  const hudBounds = await hud.locator('[data-character="owl"]').evaluateAll(nodes => nodes.map(node => {
    const b = node.getBoundingClientRect()
    return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, viewport: [innerWidth, innerHeight],
      insideViewport: b.x >= 0 && b.y >= 0 && b.right <= innerWidth && b.bottom <= innerHeight }
  }))
  promise('The HUD owl fits inside its native window', hudBounds.every(b => b.insideViewport), hudBounds,
    'src/components/HudShell.tsx:701', 'Keep the owl host inside the collapsed and expanded HUD window geometry.')
  await hud.evaluate(() => window.nubAgent.hud.close())
  await waitFor(async () => !(await page.evaluate(() => window.nubAgent.hud.isOpen())), 'authorized HUD close')
  await app.evaluate(() => globalThis.__bpHudRestore?.())

  // Freeze only bundle delivery on reload, so the real built HTML splash can
  // be observed before React replaces it. Theme and original mark stay intact.
  const pending = []
  await page.route('**/assets/*.js', route => { pending.push(route) })
  const loading = page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  try {
    await page.locator('.nub-splash__mark svg').waitFor()
    const result = await page.locator('.nub-splash__mark svg').evaluate(svg => ({
      title: svg.querySelector('title')?.textContent ?? null,
      description: svg.querySelector('desc')?.textContent ?? null,
      owlGeometry: svg.outerHTML.includes('owl') || svg.outerHTML.includes('pip-'),
      width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height,
    }))
    promise('Pip appears in the real pre-React splash', result.owlGeometry && result.width > 0, result,
      'src/assets/boot-mark.svg:1', 'Keep the generated Pip boot mark in the Vite splash slot.')
    await page.locator('.nub-splash__mark').evaluate(el => { el.style.animation = 'none'; el.style.opacity = '1' })
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio }))
    const image = await app.evaluate(async ({ BrowserWindow }, targetUrl) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === targetUrl)
      const capture = await win.webContents.capturePage()
      return { png: capture.toPNG().toString('base64'), size: capture.getSize(), url: win.webContents.getURL() }
    }, page.url())
    promise('The splash screenshot captures the real main window, not the HUD',
      image.size.width === Math.round(viewport.width * viewport.scale) && image.size.height === Math.round(viewport.height * viewport.scale),
      { captureSize: image.size, viewport, isHudUrl: image.url.includes('win=hud') },
      'tools/blueprint/mascot.mjs', 'Select the exact main renderer for native capture.')
    const file = path.join(OUT, 'ui/splash.png')
    writeFileSync(file, Buffer.from(image.png, 'base64'))
    screenshots.push({ path: file, caption: 'Actual built index.html splash held before the main bundle; only its pulse is frozen for native capture.', deviceScaleFactor: await page.evaluate(() => devicePixelRatio) })
  } finally {
    await page.unroute('**/assets/*.js')
    await Promise.all(pending.map(route => route.continue().catch(() => {})))
    await loading
  }
  report.report.failedResponses = failedResponses
}

async function icons(browser) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 2 })
  errors(page, 'app icon')
  const source = path.join(ROOT, 'build/icon.png')
  const png = readFileSync(source).toString('base64')
  await page.setContent(`<style>body{background:#161617;color:#eee;font:14px system-ui}section{display:flex;align-items:center;gap:16px}canvas{image-rendering:pixelated}</style><h1>Actual build/icon.png / downsampled, not vector replacements</h1>`)
  const measured = await page.evaluate(async png => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode()
    const luminance = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
    const results = []
    for (const size of [16, 32, 128, 512]) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, size, size)
      const p = ctx.getImageData(0, 0, size, size).data
      let occupied = 0, owl = 0; const contrasts = []
      // The icon tile is opaque: alpha alone cannot prove a visible owl. Compare
      // bright owl pixels against the actual dark tile sampled at 20%, 50%.
      const bi = (Math.floor(size * .5) * size + Math.floor(size * .2)) * 4
      const bg = [...p.slice(bi, bi + 3)], bgLuma = luminance(bg)
      for (let i = 0; i < p.length; i += 4) {
        if (p[i + 3] > 32) occupied++
        const lum = luminance([...p.slice(i, i + 3)])
        if (p[i + 3] > 240 && lum > bgLuma + .12) { owl++; contrasts.push((lum + .05) / (bgLuma + .05)) }
      }
      contrasts.sort((a, b) => a - b)
      const median = contrasts[Math.floor(contrasts.length / 2)] ?? 0
      const row = document.createElement('section')
      const label = document.createElement('b'); label.textContent = `${size}px`
      row.append(label, canvas)
      if (size <= 32) { const enlarged = canvas.cloneNode(); enlarged.getContext('2d').drawImage(canvas, 0, 0); enlarged.style.width = `${size * 5}px`; enlarged.style.height = `${size * 5}px`; row.append(enlarged) }
      document.body.append(row)
      results.push({ size, sourceSize: [image.width, image.height], occupiedFraction: occupied / (size * size),
        brightSilhouetteFraction: owl / (size * size), sampledTile: bg, silhouetteContrastMedian: median,
        png: canvas.toDataURL('image/png').split(',')[1] })
    }
    return results
  }, png)
  for (const { png: image, ...m } of measured) {
    writeFileSync(path.join(OUT, 'frames', `app-icon-${m.size}.png`), Buffer.from(image, 'base64'))
    promise(`The app icon is legible and not mostly empty at ${m.size}px`,
      m.occupiedFraction >= .5 && m.brightSilhouetteFraction >= .15 && m.silhouetteContrastMedian >= 3, m,
      'tools/mascot/render-icons.mjs:52', 'Increase the owl footprint or simplify tiny raster features while maintaining tile contrast.', 'S', 'The app icon is too empty or lacks silhouette contrast.')
  }
  await screenshot(page, 'app-icon-sizes', 'Actual PNG at 16/32/128/512px; native and nearest-neighbor enlarged tiny sizes.')
  await page.close()
}

function workerReport() {
  const r = report.report, passed = r.checks.filter(c => c.ok).length
  const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
  const text = `# Hermes Desk blueprint worker: mascot

## Summary
- ${passed}/${r.checks.length} checks pass; ${r.checks.length - passed} failures, ${findings.length} grouped findings. Product code was not changed.
- ${r.method.goldens}
- Measurements are from this run (${r.startedAt}). Real app uses the existing isolated harness with real Hermes serve and deterministic loopback model, no Settings/tab adapters.

## Files
- \`tools/blueprint/mascot.mjs\`
- \`tools/blueprint/goldens/mascot/manifest.json\` and 30 PNG references
- Raw evidence: \`${OUT}\`; machine report: \`${path.join(BP_OUT, 'data/report-mascot.json')}\`

## Run command
\`\`\`sh
cd "${ROOT}"
node tools/blueprint/mascot.mjs
\`\`\`
Requires macOS sandbox-exec, installed Chrome (or CHROMIUM_PATH), existing Hermes checkout (HERMES_E2E_SOURCE override), and installed repository dependencies. BP_OUT overrides evidence output. Visible app launches are explicitly refused. A red product result exits 1.

## Method
${Object.entries(r.method).map(([name, value]) => `- **${name}**: ${value}`).join('\n')}
- Only the initial baseline run creates goldens. Existing files are never overwritten on later runs.
- Contact sheets include every matrix frame; raw 2× PNGs are retained individually.
- Offscreen/hidden checks observe 1000ms with no shared-clock frames; hidden means display:none, not document visibility.
- Script time includes only synchronous shared-clock callbacks, not paint/GPU work. 58fps minimum allows 60Hz scheduling jitter.
- HUD uses a clearly labelled test-only window-show guard so no HUD appears on the desktop. NUB_SMOKE is temporarily cleared only for this creation so the shared harness can load the real HUD rather than about:blank. The pre-React splash is held by bundle delivery interception on the real app reload.

## Checks
${passed}/${r.checks.length} pass.

| Result | User promise | Measured value | Finding |
| --- | --- | --- | --- |
${r.checks.map(c => `| ${c.ok ? 'PASS' : 'FAIL'} | ${escape(c.name)} | ${escape(c.detail)} | ${c.findingId ?? ''} |`).join('\n')}

## Measures
| Measure | Value | Unit | How |
| --- | --- | --- | --- |
${r.measures.map(m => `| ${escape(m.name)} | ${escape(JSON.stringify(m.value))} | ${escape(m.unit)} | ${escape(m.how)} |`).join('\n')}

## Findings
${findings.length ? findings.map(f => `### ${f.id}: ${f.userSees}
- Suspected source: \`${f.anchor}\`.
- Suggested fix (${f.size}): ${f.fix}
- ${f.evidence.length} failing check(s), each listed above with this finding ID and its measured value.
${f.evidence.map(e => `  - **${e.check}**: ${JSON.stringify(e.measured)}`).join('\n')}`).join('\n\n') : 'None.'}

## Screenshots worth putting in the report
${screenshots.map(s => `- \`${s.path}\` (scale ${s.deviceScaleFactor}): ${s.caption}`).join('\n')}

## Harness corrections
${testCorrections.length ? testCorrections.map(item => `- ${item}`).join('\n') : '- None.'}

## Not yet tested
${untested.map(item => `- ${item}`).join('\n')}
`
  writeFileSync(path.join(OUT, 'report.md'), text)
  const target = '/Users/devgwardo/.local/state/warroom/hermes-desk/bp-mascot.report.md'
  mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text)
}

let server, browser, harness
const onSignal = () => { process.exitCode = 130; void harness?.close(); void browser?.close(); void server?.close() }
process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal)
try {
  if (process.env.HERMES_DESK_E2E_VISIBLE === '1') throw new Error('Refusing visible/focus-stealing app launch. Unset HERMES_DESK_E2E_VISIBLE.')
  server = await createServer({ configFile: path.join(ROOT, 'tools/mascot/vite.lab.config.ts'), root: ROOT,
    server: { host: '127.0.0.1', port: 0, strictPort: false }, clearScreen: false })
  await server.listen()
  const address = server.httpServer.address()
  if ([8642, 9119].includes(address.port)) throw new Error('Reserved port selected')
  const origin = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' }), headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' })
  errors(page, 'mascot lab')
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort()
  })
  const labUrl = `${origin}/mascot-lab.html?character=owl`
  await page.goto(`${labUrl}&capture=1`)
  await page.evaluate(() => localStorage.clear()); await page.reload()
  await page.waitForFunction(() => window.mascotLab?.ready)
  await runMatrix(browser, page)
  await runPerformance(page, labUrl)
  await icons(browser)
  await browser.close(); browser = null
  await server.close(); server = null
  harness = await launchHarness()
  await placements(harness)
  for (const error of harness.consoleErrors) if (!report.report.console.some(item => item.includes(error))) report.consoleError(`real app: pageerror: ${error}`)
  untested.push('Full motion-cycle framing beyond the 1200ms matrix sample; additive reactions and cursor-driven extreme gaze.',
    'Document visibilitychange pause, OS minimize/unfocus, and multiple monitors (offscreen and display:none are tested).',
    'Packaged Dock/icns icon, tray icon, installed-app launch, and the legacy BootOrbSplash overlay (pre-React splash is tested).',
    'Perceptual human-recognition studies: pixel contrast, face variance and state MAD are quality proxies, not recognition proof.',
    'Other blueprint workers’ concurrent scripts and the full unrelated test suite are not run by this owned-area harness.')
  promise('The complete mascot evidence sweep can run to completion', true,
    { matrixPasses: 2, matrixFramesPerPass: 360, goldenFrames: 30, placementAreas: ['sidebar rows', 'agent card', 'chat header', 'HUD', 'splash', 'app icon'] },
    'tools/blueprint/mascot.mjs', 'Keep independent evidence phases running even when product checks fail.')
} catch (error) {
  promise('The complete mascot evidence sweep can run to completion', false, { message: error.message, stack: error.stack },
    'tools/blueprint/mascot.mjs', 'Resolve the harness/runtime blocker and rerun; do not claim dependent checks were exercised.', 'M')
  untested.push(`Remaining checks after runtime blocker: ${error.message}`)
} finally {
  try { await harness?.close(); await browser?.close(); await server?.close() }
  catch (error) { promise('Mascot evidence processes tear down cleanly', false, error.message, 'tests/e2e/harness.mjs:147', 'Close only task-owned test resources.') }
  promise('No console errors', report.report.console.length === 0, { count: report.report.console.length, errors: report.report.console, failedResponses: report.report.failedResponses ?? [] },
    'src/lib/hermes-rest.ts:829; electron/serve-auth.cjs:226', 'Handle the unsupported notifications feature probe without a failed network request; investigate why the loopback proxy returns 502.', 'M',
    'Renderer logs a failed notifications request while the mascot is displayed.')
  report.report.findings = findings; report.report.screenshots = screenshots; report.report.notYetTested = untested
  report.finish(); workerReport()
  process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal)
}
