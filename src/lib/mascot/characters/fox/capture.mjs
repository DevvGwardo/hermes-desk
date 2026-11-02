import { createServer } from 'node:http'
import { mkdir, readFile, access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const out = resolve(root, 'tools/mascot/out/fox')
const assetBase = '/src/lib/mascot/characters/fox/'
const routes = new Map([
  ['/tools/mascot/preview-fox.html', ['tools/mascot/preview-fox.html', 'text/html']],
  ...['rig.svg', 'motion.json', 'palette.json'].map(name => [
    assetBase + name,
    ['src/lib/mascot/characters/fox/' + name, name.endsWith('.svg') ? 'image/svg+xml' : 'application/json'],
  ]),
])
const executablePath = process.env.CHROMIUM_PATH ?? resolve(
  process.env.HOME,
  'Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell',
)
await access(executablePath)
await mkdir(out, { recursive: true })
const server = createServer(async (req, res) => {
  const asset = routes.get(new URL(req.url, 'http://localhost').pathname)
  if (!asset) { res.writeHead(404); res.end('Not found'); return }
  try {
    const body = await readFile(resolve(root, asset[0]))
    res.writeHead(200, { 'Content-Type': asset[1] })
    res.end(body)
  } catch {
    res.writeHead(500)
    res.end('Preview asset could not be loaded')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1380, height: 1500 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/tools/mascot/preview-fox.html`)
  await page.waitForFunction(() => window.foxPreview?.ready)
  const behaviour = await page.evaluate(() => {
    const snapshot = () => [...document.querySelectorAll('.rig [transform], .rig [id^="mouth-"]')]
      .map(node => `${node.id}:${node.getAttribute('transform')}:${node.getAttribute('display')}`).join('|')
    window.foxPreview.seek(0.73)
    const first = snapshot()
    window.foxPreview.seek(2.3)
    const changed = snapshot() !== first
    window.foxPreview.seek(0.73)
    const deterministic = snapshot() === first
    window.foxPreview.setReduced(true)
    window.foxPreview.seek(0.3)
    const reducedFirst = snapshot()
    window.foxPreview.seek(1.6)
    const reducedStatic = snapshot() === reducedFirst
    const reducedHasNoFx = [...document.querySelectorAll('.rig svg > g[aria-hidden]')].every(group => !group.children.length)
    window.foxPreview.setReduced(false)
    const palettePaints = new Set([...document.querySelectorAll('.palette-card [id$="fox-fur"] stop:first-child')]
      .map(stop => getComputedStyle(stop).stopColor))
    const oneMouthEach = [...document.querySelectorAll('.rig svg')].every(svg =>
      [...svg.querySelectorAll('[id^="mouth-"]')].filter(node => node.getAttribute('display') !== 'none').length === 1)
    return { changed, deterministic, reducedStatic, reducedHasNoFx, distinctPalettes: palettePaints.size, oneMouthEach }
  })
  for (const [key, value] of Object.entries(behaviour)) {
    assert.equal(value, key === 'distinctPalettes' ? 8 : true, `Preview behaviour: ${key}`)
  }
  await page.evaluate(() => window.foxPreview.seek(1.25))
  const overflow = await page.evaluate(() => {
    const overflow = []
    for (let sample = 0; sample < 60; sample++) {
      const time = 0.21 + sample * 0.17
      window.foxPreview.seek(time)
      for (const rig of document.querySelectorAll('.state-card .rig')) {
        const frame = rig.querySelector('svg').getBoundingClientRect()
        const art = rig.querySelector('#part-root').getBoundingClientRect()
        if (art.left < frame.left - 1 || art.top < frame.top - 1 || art.right > frame.right + 1 || art.bottom > frame.bottom + 1) {
          overflow.push({
            state: rig.closest('[data-state]').dataset.state, size: frame.width, time,
            margins: [art.left - frame.left, art.top - frame.top, frame.right - art.right, frame.bottom - art.bottom],
          })
        }
      }
    }
    window.foxPreview.seek(1.25)
    return overflow
  })
  if (overflow.length) throw new Error(`Clipped state poses: ${JSON.stringify(overflow)}`)
  await page.screenshot({ path: resolve(out, 'overview.png'), fullPage: true })
  await page.locator('.hero').screenshot({ path: resolve(out, 'hero.png') })
  for (const state of await page.evaluate(() => window.foxPreview.states)) {
    await page.evaluate(state => { window.foxPreview.setState(state); window.foxPreview.seek(1.25) }, state)
    await page.locator('#hero').screenshot({ path: resolve(out, `${state}-320.png`) })
    await page.locator(`[data-state="${state}"]`).screenshot({ path: resolve(out, `${state}-160-40.png`) })
    await page.locator('#small .rig').screenshot({ path: resolve(out, `${state}-40-retina.png`) })
  }
  for (const time of [0.25, 0.75, 1.75, 2.75]) {
    await page.evaluate(time => window.foxPreview.seek(time), time)
    await page.locator('[data-state="sleep"]').screenshot({ path: resolve(out, `sleep-t${time}.png`) })
    await page.locator('[data-state="happy"]').screenshot({ path: resolve(out, `happy-t${time}.png`) })
    await page.locator('[data-state="browsing"]').screenshot({ path: resolve(out, `browsing-t${time}.png`) })
  }
  await page.evaluate(() => { window.foxPreview.seek(1.25); window.foxPreview.setReduced(true) })
  await page.locator('#states').screenshot({ path: resolve(out, 'reduced-motion.png') })
  await page.evaluate(() => { window.foxPreview.setReduced(false); window.foxPreview.setPalette(0) })
  await page.locator('#states').screenshot({ path: resolve(out, 'sky-states.png') })
  await page.locator('#palettes').screenshot({ path: resolve(out, 'agent-palettes.png') })
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`Headless screenshots: ${out}\nNo browser errors; deterministic seek, reduced motion, isolated palettes, and single-mouth visibility pass.\n1,080 sampled state/size bounds fit the SVG viewport.`)
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
