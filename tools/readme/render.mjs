import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = await mkdtemp(join(tmpdir(), 'hermes-desk-artwork-'))
const captures = [
  ['banner', 800, 1],
  ['architecture', 1120, 1],
  ['workspace', 1200, 1],
  ['states', 720, 6],
  ['palettes', 720, 6],
]
const mascotSource = 'src/lib/mascot/characters/owl/rig.svg'
const motionSource = 'src/lib/mascot/characters/owl/motion.json'
const paletteSource = 'src/lib/mascot/characters/owl/palette.json'
const sources = Object.fromEntries(await Promise.all([mascotSource, motionSource, paletteSource].map(async path =>
  [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
const manifest = { sources, captures: [] }
const errors = []
let server
let browser

async function chromiumPath() {
  if (process.env.CHROMIUM_PATH) {
    await access(process.env.CHROMIUM_PATH)
    return process.env.CHROMIUM_PATH
  }
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  for (const entry of (await readdir(cache)).sort().reverse()) {
    if (!entry.startsWith('chromium')) continue
    for (const relative of [
      'chrome-headless-shell-mac-arm64/chrome-headless-shell',
      'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    ]) {
      const path = join(cache, entry, relative)
      try { await access(path); return path } catch { /* Check the next installed binary. */ }
    }
  }
  throw new Error('Set CHROMIUM_PATH to an installed Chromium executable.')
}

try {
  await mkdir(output, { recursive: true })
  server = await createServer({
    configFile: false, root,
    optimizeDeps: { entries: ['tools/readme/artwork.html', 'tools/design/mockups.html'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  await server.listen()
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw new Error('No loopback server address.')
  browser = await chromium.launch({ executablePath: await chromiumPath(), headless: true })
  const page = await browser.newPage({ deviceScaleFactor: 1, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol)) return route.continue()
    errors.push(`Unexpected remote asset request: ${url.origin}`)
    return route.abort('blockedbyclient')
  })
  for (const [view, height, expectedOwls] of captures) {
    await page.setViewportSize({ width: 1600, height })
    await page.goto(`http://127.0.0.1:${address.port}/tools/readme/artwork.html?view=${view}`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => window.readmeArtwork?.ready)
    const metrics = await page.evaluate(() => {
      const artwork = document.getElementById('artwork')
      const bounds = artwork.getBoundingClientRect()
      const textOverflow = [...artwork.querySelectorAll('h1, h2, p, .pill, .eyebrow')].filter(el => {
        const rect = el.getBoundingClientRect()
        return rect.left < bounds.left || rect.right > bounds.right || rect.top < bounds.top || rect.bottom > bounds.bottom || el.scrollWidth > el.clientWidth + 1
      }).map(el => el.textContent)
      const nativeOwls = [...artwork.querySelectorAll('.owl')].map(el => ({
        state: el.dataset.state, palette: el.dataset.palette,
        parts: el.querySelectorAll('[data-mascot-part]').length,
        hasHelmet: Boolean(el.querySelector('[data-mascot-part="helmet"]')),
        hasSatchel: Boolean(el.querySelector('[data-mascot-part="satchel"]')),
        profile: el.querySelector('svg')?.dataset.mascotProfile,
      }))
      const iframe = artwork.querySelector('iframe')
      return {
        width: bounds.width, height: bounds.height, textOverflow, nativeOwls,
        previewOwlCount: iframe ? iframe.contentDocument.querySelectorAll('[data-character="owl"]').length : 0,
        previewReady: iframe ? Boolean(iframe.contentWindow.deskDesign?.ready) : true,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      }
    })
    if (metrics.width !== 1600 || metrics.height !== height || metrics.horizontalOverflow || metrics.textOverflow.length ||
        metrics.nativeOwls.length !== expectedOwls || !metrics.previewReady ||
        metrics.nativeOwls.some(owl => !owl.hasHelmet || !owl.hasSatchel || owl.parts < 25 || owl.profile !== 'reduced') ||
        (view === 'workspace' && metrics.previewOwlCount < 6)) {
      throw new Error(`${view} failed artwork checks: ${JSON.stringify(metrics)}`)
    }
    if (errors.length) throw new Error(errors.join('\n'))
    const file = `hermes-desk-${view}.png`
    await page.locator('#artwork').screenshot({ path: join(output, file), animations: 'disabled' })
    const first = await readFile(join(output, file))
    const repeat = join(tmpdir(), `hermes-desk-${process.pid}-${view}-repeat.png`)
    await page.locator('#artwork').screenshot({ path: repeat, animations: 'disabled' })
    const deterministic = first.equals(await readFile(repeat))
    await unlink(repeat)
    if (!deterministic) throw new Error(`${view} changed between frozen captures.`)
    manifest.captures.push({ file, ...metrics, deterministic, sha256: createHash('sha256').update(first).digest('hex') })
    console.log(`Rendered ${file}: ${metrics.width}x${metrics.height}, ${metrics.nativeOwls.length + metrics.previewOwlCount} real Pip instances`)
  }
  if (errors.length) throw new Error(errors.join('\n'))
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (process.argv.includes('--promote')) {
    const promoted = join(root, 'docs/readme')
    await mkdir(promoted, { recursive: true })
    for (const file of [...manifest.captures.map(capture => capture.file), 'manifest.json']) {
      await copyFile(join(output, file), join(promoted, file))
    }
    console.log(`Promoted five verified images: ${promoted}`)
  }
  console.log(`Verified artwork and source hashes: ${output}`)
} finally {
  await browser?.close()
  await server?.close()
}
