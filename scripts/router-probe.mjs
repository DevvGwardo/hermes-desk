// router-probe.mjs — headless proof for WEBAPP Phase 2 routing.
// Serves a --mode web build, seeds a linked session, and proves:
//   1. deep link opens the panel (hash → state)
//   2. state syncs back to the URL without clobbering (state → URL)
//   3. browser back closes the panel (history works)
//   4. reload with the hash restores the panel (survives reload)
//
// Usage:
//   node scripts/router-probe.mjs --dir /tmp/nub-web-main [--port 5231]
// Exit 0 on all green, 1 with ROUTER_PROBE FAIL <step> otherwise.

import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import fs from 'node:fs'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? def : (process.argv[i + 1] ?? def)
}

const DIR = path.resolve(arg('dir', '/tmp/nub-web-main'))
const PORT = parseInt(arg('port', '5231'), 10)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        let file = path.join(DIR, decodeURIComponent(url.pathname))
        if (url.pathname === '/' || !existsSync(file) || !fs.statSync(file).isFile()) {
          file = path.join(DIR, 'index.html') // SPA fallback (mirrors vercel.json)
        }
        const body = readFileSync(file)
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
        res.end(body)
      } catch (e) {
        res.writeHead(500)
        res.end(String(e))
      }
    })
    server.listen(PORT, '127.0.0.1', () => resolve(server))
  })
}

function findChrome() {
  const pw = path.join(process.env.HOME || '', 'Library/Caches/ms-playwright')
  try {
    for (const d of fs.readdirSync(pw)) {
      if (!d.startsWith('chromium-')) continue
      for (const sub of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']) {
        const p = path.join(pw, d, sub)
        if (fs.existsSync(p)) return p
      }
    }
  } catch { /* fall through */ }
  const sys = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (fs.existsSync(sys)) return sys
  throw new Error('no chrome found (ms-playwright cache or /Applications/Google Chrome)')
}

function fail(step, detail) {
  console.error(`ROUTER_PROBE FAIL ${step}${detail ? ' — ' + detail : ''}`)
  process.exit(1)
}

async function main() {
  const server = await serve()
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true })
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    // Seed a linked session BEFORE page scripts run (skips the WebConnect gate).
    // Guarded: the init script also runs on about:blank (back-navigation
    // target), where storage access throws SecurityError.
    await ctx.addInitScript(() => {
      try {
        window.sessionStorage.setItem('nub:mobile-session', JSON.stringify({
          host: 'https://www.maiavm.com',
          pairedAt: new Date().toISOString(),
        }))
      } catch { /* about:blank — no storage, nothing to seed */ }
    })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))

    // 0. bare base first, so goBack() below is same-document (about:blank
    //    would unload the app and fake the back-button assertion).
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
    try {
      await page.waitForSelector('text=CONVERSATIONS', { timeout: 25000 })
    } catch { fail('boot', 'app shell never mounted on bare base') }

    // 1. deep link opens the panel
    await page.goto(`http://127.0.0.1:${PORT}/#/?settings=1`, { waitUntil: 'load' })
    try {
      await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 25000 })
    } catch { fail('deep-link', 'settings dialog never mounted') }
    console.log('ROUTER_PROBE 1/4 deep-link opens panel ok')

    // 2. state syncs back without clobbering
    const hash = await page.evaluate(() => window.location.hash)
    if (!hash.includes('settings=1')) fail('url-sync', `hash lost the flag: ${hash}`)
    console.log(`ROUTER_PROBE 2/4 url-sync ok (${hash})`)

    // 3. browser back closes the panel (same-document: the app must still
    //    be mounted — guards against an unload-away false pass)
    await page.goBack()
    try {
      await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { state: 'detached', timeout: 10000 })
    } catch { fail('back-button', 'settings dialog survived history.back()') }
    const stillBooted = await page.evaluate(() => document.body.innerText.includes('CONVERSATIONS'))
    if (!stillBooted) fail('back-button', 'back unloaded the app (about:blank) — not a same-document close')
    console.log('ROUTER_PROBE 3/4 back-button closes panel ok')

    // 3b. forward reopens it (history works both ways)
    await page.goForward()
    try {
      await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 10000 })
    } catch { fail('forward-button', 'settings dialog did not reopen on history.forward()') }
    console.log('ROUTER_PROBE 3b/4 forward-button reopens panel ok')

    // 4. reload with the hash restores the panel
    await page.goto(`http://127.0.0.1:${PORT}/#/?settings=1`, { waitUntil: 'load' })
    await page.reload({ waitUntil: 'load' })
    try {
      await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 25000 })
    } catch { fail('reload', 'settings dialog missing after reload with hash') }
    console.log('ROUTER_PROBE 4/4 reload restores panel ok')

    const fatal = errors.filter((e) => !/favicon|net::/i.test(e))
    if (fatal.length) fail('page-errors', fatal.slice(0, 3).join(' | '))
    console.log('ROUTER_PROBE done ok')
  } finally {
    await browser.close().catch(() => {})
    server.close()
  }
}

main().catch((e) => fail('harness', e.message))
