// Drives the mascot lab's Stage mode headless: clip frame strips, flights to every perch,
// landing accuracy, path continuity and frame-time while flying (motion v2 §5).
// Usage: node tools/mascot/stage.mjs [--url http://127.0.0.1:5188/mascot-lab.html] [--out tools/mascot/out/stage] [--clips a,b]
import { chromium } from 'playwright-core'
import { mkdir, readdir, access, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const base = value('--url') ?? 'http://127.0.0.1:5188/mascot-lab.html'
const out = resolve(root, value('--out') ?? 'tools/mascot/out/stage')

async function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  for (const entry of (await readdir(cache)).sort().reverse()) {
    if (!entry.startsWith('chromium')) continue
    for (const rel of ['chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      try { await access(join(cache, entry, rel)); return join(cache, entry, rel) } catch { /* next */ }
    }
  }
  throw new Error('Chromium not found; set CHROMIUM_PATH')
}

await mkdir(out, { recursive: true })
const browser = await chromium.launch({ executablePath: await findChromium(), headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
await page.goto(`${base}?mode=stage&character=owl`)
await page.waitForFunction(() => window.mascotStage)
await page.evaluate(() => { const floor = document.querySelector('.stage-floor'); window.scrollTo(0, floor.getBoundingClientRect().top + scrollY - 150) })
// Autonomy off while measuring.
await page.locator('label', { hasText: 'Autonomous idle' }).first().locator('input').uncheck()
await page.waitForTimeout(400)

const report = { clips: {}, flights: [], errors }
const heroBox = async () => page.locator('[data-stage-home]').boundingBox()

// 1. Clip strips: 6 frames per clip around the hero.
const clipNames = (value('--clips') ?? '').split(',').filter(Boolean)
const all = clipNames.length ? clipNames : await page.evaluate(() => [...document.querySelectorAll('[data-clip]')].map(b => b.dataset.clip))
for (const name of all) {
  if (['fly', 'glide', 'hover'].includes(name)) continue
  const box = await heroBox()
  const clip = { x: box.x - 90, y: box.y - 110, width: box.width + 180, height: box.height + 160 }
  const duration = await page.evaluate(n => { void window.mascotStage.play(n); return 0 }, name)
  void duration
  const frames = []
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(i === 0 ? 60 : 300)
    frames.push(await page.screenshot({ clip, path: join(out, `clip-${name}-${i}.png`) }))
  }
  report.clips[name] = frames.length
  await page.waitForTimeout(900)
}

// 2. Flights: sample the flight container every frame; check continuity and landing accuracy.
async function sampleFlight(trigger, label) {
  await page.evaluate(() => {
    window.__samples = []
    const loop = () => {
      const c = document.querySelector('[data-mascot-flight]')
      if (c && c.isConnected) {
        const m = new DOMMatrixReadOnly(getComputedStyle(c).transform)
        window.__samples.push({ t: performance.now(), x: m.m41, y: m.m42 })
      }
      window.__raf = requestAnimationFrame(loop)
    }
    loop()
  })
  const shots = []
  const done = page.evaluate(trigger)
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(260)
    const file = join(out, `flight-${label}-${i}.png`)
    await page.screenshot({ path: file })
    shots.push(file)
  }
  const result = await done
  const data = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__samples })
  let maxStep = 0
  for (let i = 1; i < data.length; i++) maxStep = Math.max(maxStep, Math.hypot(data[i].x - data[i - 1].x, data[i].y - data[i - 1].y))
  const stats = await page.evaluate(() => {
    const t = document.querySelector('.stage-readout').innerText
    return t.replace(/\s+/g, ' ')
  })
  return { label, result, frames: data.length, maxStepPx: Math.round(maxStep * 10) / 10, stats }
}
for (const [index, path] of [[0, 'arc'], [1, 'swoop'], [2, 'loop'], [3, 'direct']]) {
  const flight = await sampleFlight(`window.mascotStage.flyTo(${index}, { path: '${path}', speed: 640 })`, `${index}-${path}`)
  // Landing accuracy: feet (root pivot 256,444 of 512) against the perch's top edge.
  flight.landing = await page.evaluate(i => {
    const perch = document.querySelectorAll('.stage-perch')[i]
    const svg = document.querySelector('[data-mascot-location] ') ?? null
    const hero = [...document.querySelectorAll('svg[data-mascot-location]')].find(s => s.dataset.mascotLocation !== 'home') ?? svg
    const r = hero.getBoundingClientRect()
    const feetY = r.top + 444 / 512 * r.height
    return { location: hero.dataset.mascotLocation, edgeDelta: Math.round((feetY - perch.getBoundingClientRect().top) * 100) / 100 }
  }, index)
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(out, `perched-${index}.png`) })
  report.flights.push(flight)
}
report.flights.push(await sampleFlight('window.mascotStage.goHome()', 'home'))
await page.waitForTimeout(400)
report.home = await page.evaluate(() => window.mascotStage.location())

// 3. Perf: hero flying while twelve 40px mascots idle with autonomy.
await page.locator('label', { hasText: 'Autonomous idle' }).first().locator('input').check()
const perf = await page.evaluate(async () => {
  const { mascotFrameClock } = await import('/src/lib/mascot/frame-clock.ts')
  mascotFrameClock.resetStats()
  await window.mascotStage.flyToPoint(innerWidth * 0.75, innerHeight * 0.4, 'loop')
  const s = mascotFrameClock.stats()
  await window.mascotStage.goHome()
  return s
})
report.perf = perf
// 4. Particles burst + cap.
report.particles = await page.evaluate(async () => {
  for (let i = 0; i < 20; i++) window.mascotStage.emit('confetti', 40)
  return window.mascotStage.particles()
})
await page.waitForTimeout(150)
await page.screenshot({ path: join(out, 'particles.png') })
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
await browser.close()
