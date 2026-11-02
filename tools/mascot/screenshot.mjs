import { chromium } from 'playwright-core'
import { readdir, mkdir, writeFile, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const states = ['idle', 'thinking', 'tool', 'browsing', 'waiting', 'talking', 'happy', 'error', 'sleep']
const out = resolve(root, value('--out') ?? 'tools/mascot/out')
const port = Number(value('--port') ?? 5188)
const base = value('--url') ?? `http://127.0.0.1:${port}/mascot-lab.html`
let server
let browser

async function findChromium() {
  if (process.env.CHROMIUM_PATH) { await access(process.env.CHROMIUM_PATH); return process.env.CHROMIUM_PATH }
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  for (const entry of (await readdir(cache)).sort().reverse()) {
    if (!entry.startsWith('chromium')) continue
    for (const relative of ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const path = join(cache, entry, relative)
      try { await access(path); return path } catch { /* Try the next installed revision. */ }
    }
  }
  throw new Error('Installed Chromium not found. Set CHROMIUM_PATH to its executable.')
}
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    if (server && server.exitCode !== null) throw new Error(`Lab server exited (${server.exitCode})`)
    try { if ((await fetch(base)).ok) return } catch { /* Startup pending. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Lab did not start: ${base}`)
}
const errors = []
async function open(page, query) {
  const url = new URL(base)
  for (const [key, val] of Object.entries(query)) url.searchParams.set(key, String(val))
  await page.goto(url.href, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.mascotLab?.ready)
  await page.evaluate(() => document.fonts.ready)
}

try {
  await mkdir(out, { recursive: true })
  if (!value('--url')) {
    server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--config', join(root, 'tools/mascot/vite.lab.config.ts'), '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    server.stderr.on('data', chunk => process.stderr.write(chunk))
    // Drain stdout without exposing a visible browser or keeping a pipe full.
    server.stdout.on('data', () => {})
  }
  await waitForServer()
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-gpu'] })
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' })
  page.on('pageerror', error => errors.push(error.message))
  await open(page, { capture: 1 })
  const ids = value('--character') ? [value('--character')] : await page.evaluate(() => window.mascotLab.characterIds)
  const known = await page.evaluate(() => window.mascotLab.characterIds)
  for (const id of ids) if (!known.includes(id)) throw new Error(`Unknown character: ${id}`)
  if (!flag('--perf-only')) {
    for (const id of ids) {
      const dir = join(out, id)
      await mkdir(dir, { recursive: true })
      for (const state of value('--state') ? [value('--state')] : states) {
        await open(page, { capture: 1, character: id, state })
        await page.evaluate(() => window.mascotLab.advance(1200))
        await page.screenshot({ path: join(dir, `${state}.png`), fullPage: true })
        await page.locator('[data-card]').screenshot({ path: join(dir, `${state}-card.png`) })
      }
      await open(page, { capture: 1, character: id, state: 'happy', reduced: 1 })
      await page.evaluate(() => window.mascotLab.advance(1200))
      await page.screenshot({ path: join(dir, 'reduced-motion.png'), fullPage: true })
      await open(page, { capture: 1, character: id })
      await page.evaluate(() => { window.mascotLab.react('approval'); window.mascotLab.advance(450) })
      await page.screenshot({ path: join(dir, 'reaction-approval.png'), fullPage: true })
      console.log(`Screenshots: ${dir}`)
    }
  }
  if (flag('--perf') || flag('--perf-only')) {
    const measurements = []
    for (const id of ids) {
      await open(page, { perf: 1, character: id, state: value('--state') ?? 'thinking' })
      await page.waitForFunction(() => window.mascotLab.stats().subscribers === 13)
      await page.waitForTimeout(1500)
      await page.evaluate(() => window.mascotLab.resetStats())
      await page.waitForFunction(() => window.mascotLab.stats().frames >= 300, undefined, { timeout: 15000 })
      const stats = await page.evaluate(() => window.mascotLab.stats())
      const result = { character: id, fixture: '1 × 160px + 12 × 40px', budgetMs: 2, ...stats, passed: stats.meanMs < 2 && stats.p95Ms < 2 }
      measurements.push(result)
      await page.screenshot({ path: join(out, `perf-${id}.png`), fullPage: true })
      console.log(JSON.stringify(result))
    }
    await writeFile(join(out, 'perf.json'), `${JSON.stringify(measurements, null, 2)}\n`)
    if (measurements.some(result => !result.passed)) throw new Error('Mascot script-time budget exceeded (mean or p95 >= 2ms)')
  }
  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`)
} finally {
  await browser?.close()
  if (server && server.exitCode === null) {
    server.kill('SIGTERM')
    await new Promise(resolve => server.once('exit', resolve))
  }
}
