import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { access, copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const out = join(root, 'tools/design/out')
const promoted = join(root, 'docs/plans/design-mockups')
const config = join(root, 'tools/design/vite.config.ts')
let port
const promote = process.argv.includes('--promote')
let server
let browser
const errors = []
const manifest = []

async function findChromium() {
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
      try { await access(path); return path } catch { /* Try next installed binary. */ }
    }
  }
  throw new Error('Installed Chromium not found. Set CHROMIUM_PATH to its executable.')
}
async function load(page, view, viewport) {
  await page.setViewportSize(viewport)
  await page.goto(`http://127.0.0.1:${port}/tools/design/mockups.html?view=${view}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.deskDesign?.ready)
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => {
    // A fixture is deliberately static. Capture never opens Electron or fetches remote content.
    const styles = document.createElement('style')
    styles.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'
    document.head.append(styles)
  })
}
async function validate(page, name) {
  const metrics = await page.evaluate(() => {
    const root = document.querySelector('[data-capture]')
    const controls = [...root.querySelectorAll('button, input, textarea, summary')]
    const smallTargets = controls.filter(el => {
      const rect = el.getBoundingClientRect()
      // Display:none responsive overflow controls are not pointer targets.
      return rect.width > 0 && rect.height > 0 && (rect.width < 28 || rect.height < 28)
    }).map(el => ({ label: el.getAttribute('aria-label') ?? el.textContent, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }))
    const unlabeledButtons = [...root.querySelectorAll('button')].filter(el => !(el.getAttribute('aria-label') || el.textContent.trim())).length
    return {
      iconCount: window.deskDesign.iconCount,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      smallTargets, unlabeledButtons,
      palette: [0, 1, 2, 3, 4].map(i => getComputedStyle(root).getPropertyValue(`--desk-surface-${i}`).trim()),
    }
  })
  if (metrics.horizontalOverflow || metrics.smallTargets.length || metrics.unlabeledButtons) {
    throw new Error(`${name} failed layout/accessibility checks: ${JSON.stringify(metrics)}`)
  }
  const reload = page.getByRole('button', { name: 'Reload', exact: true })
  const ask = page.getByRole('button', { name: 'Ask Hermes about this page', exact: true })
  const more = page.getByRole('button', { name: 'More browser actions', exact: true })
  await reload.focus()
  await page.keyboard.press('ArrowRight')
  const next = await ask.isVisible() ? ask : more
  if (!await next.evaluate(button => document.activeElement === button)) {
    throw new Error(`${name}: toolbar did not skip hidden controls`)
  }
  await page.keyboard.press('End')
  if (!await more.evaluate(button => document.activeElement === button)) {
    throw new Error(`${name}: toolbar End navigation failed`)
  }
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.mouse.move(0, 0)
  await reload.hover()
  const tooltip = page.getByRole('tooltip').filter({ hasText: 'Reload' })
  await tooltip.waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await tooltip.waitFor({ state: 'detached' })
  await page.mouse.move(0, 0)
  manifest.push({ name, ...metrics, keyboardNavigation: true, tooltipEscape: true })
}

try {
  await mkdir(out, { recursive: true })
  // Select a free loopback port without stopping other workers' running labs.
  server = await createServer({ configFile: config, server: { host: '127.0.0.1', port: 5192, strictPort: false } })
  await server.listen()
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw new Error('Design lab has no TCP address')
  port = address.port
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true })
  const page = await browser.newPage({ deviceScaleFactor: 2, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  // Reject unexpected remote requests; the embedded site is invented and entirely local.
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    return ['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)
      ? route.continue() : route.abort('blockedbyclient')
  })
  for (const [width, height] of [[1440, 900], [1024, 700]]) {
    const name = `hermes-desk-${width}x${height}.png`
    await load(page, 'full', { width, height })
    await validate(page, name)
    await page.screenshot({ path: join(out, name) })
    console.log(`Rendered ${name}`)
  }
  await load(page, 'surfaces', { width: 1440, height: 1200 })
  await validate(page, 'hermes-desk-surfaces.png')
  await page.screenshot({ path: join(out, 'hermes-desk-surfaces.png'), fullPage: true })
  for (const id of ['sidebar', 'chat', 'tools', 'workspace', 'settings', 'states', 'primitives']) {
    await page.locator(`[data-surface="${id}"]`).screenshot({ path: join(out, `surface-${id}.png`) })
  }
  await page.locator('[data-surface="chat"] .chat-header').screenshot({ path: join(out, 'surface-chat-header.png') })
  await page.locator('[data-surface="chat"] .composer').screenshot({ path: join(out, 'surface-composer.png') })
  await page.locator('[data-surface="workspace"] .workspace-status').screenshot({ path: join(out, 'surface-status-bar.png') })
  await page.locator('[data-surface="workspace"] .pip').screenshot({ path: join(out, 'surface-computer.png') })
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify({ errors, captures: manifest }, null, 2)}\n`)
  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`)
  if (promote) {
    await mkdir(promoted, { recursive: true })
    for (const name of ['hermes-desk-1440x900.png', 'hermes-desk-1024x700.png', 'hermes-desk-surfaces.png']) {
      await copyFile(join(out, name), join(promoted, name))
    }
    console.log(`Promoted three reviewed mockups to ${promoted}`)
  }
  console.log(`Headless captures and layout checks: ${out}`)
} finally {
  await browser?.close()
  await server?.close()
}
