/**
 * Headless check for the dashboard fold-in settings tabs against a
 * `vite build --mode web` dist. Seeds a website session via fetch routes
 * so the tabs render with a fixture, an empty key list, and a failed plan card.
 *
 *   node scripts/fold-in-probe.mjs --dir dist
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? def : (process.argv[i + 1] ?? def)
}

const DIR = path.resolve(arg('dir', 'dist'))
const PORT = parseInt(arg('port', '5241'), 10)

const PROFILE = {
  id: 'user-1',
  displayName: 'Ada',
  avatarUrl: 'https://cdn.example/a.png',
  bio: 'hi',
  timezone: 'UTC',
  notificationPrefs: { incidentEmails: true, quotaWarningEmails: true },
  trainOnDataOptIn: false,
}

const OVERVIEW = {
  sources: { plan: 'error', agents: 'ok', invoices: 'ok' },
  plan: null,
  agents: [],
  invoices: [],
  fixPayment: false,
}

function findChrome() {
  const pw = path.join(process.env.HOME || '', 'Library/Caches/ms-playwright')
  try {
    for (const d of fs.readdirSync(pw)) {
      if (!d.startsWith('chromium-')) continue
      for (const sub of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ]) {
        const p = path.join(pw, d, sub)
        if (fs.existsSync(p)) return p
      }
    }
  } catch {
    /* system chrome below */
  }
  const sys = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (fs.existsSync(sys)) return sys
  throw new Error('no chrome found')
}

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      let file = path.join(DIR, decodeURIComponent(url.pathname))
      if (!file.startsWith(DIR)) {
        res.writeHead(403)
        res.end()
        return
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIR, 'index.html')
      const ext = path.extname(file)
      const type = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html'
      res.writeHead(200, { 'Content-Type': type })
      res.end(fs.readFileSync(file))
    })
    server.listen(PORT, '127.0.0.1', () => resolve(server))
  })
}

function fail(msg) {
  console.error(`FOLD_IN_PROBE FAIL ${msg}`)
  process.exit(1)
}

async function openSettings(page, width, height) {
  await page.setViewportSize({ width, height })
  const errors = []
  page.on('pageerror', (err) => errors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  await page.goto(`http://127.0.0.1:${PORT}/#/?settings=1&pane=account`, { waitUntil: 'domcontentloaded' })
  try {
    await page.getByTestId('account-pane').waitFor({ timeout: 8000 })
  } catch (err) {
    const info = await page.evaluate(() => ({
      hash: location.hash,
      width: innerWidth,
      phone: matchMedia('(max-width: 720px), (pointer: coarse) and (max-width: 959px)').matches,
      coarse: matchMedia('(pointer: coarse)').matches,
      cls: document.documentElement.className,
    }))
    const text = await page.locator('body').innerText()
    fail(`account missing ${JSON.stringify(info)}\n${text.slice(0, 800)}`)
  }
  const name = await page.locator('input').first().inputValue()
  if (name !== 'Ada') fail(`account name was ${name}`)
  await page.getByRole('button', { name: 'Billing' }).click()
  await page.getByText('The plan card is unavailable right now.').waitFor({ timeout: 8000 })
  await page.getByText('No agents yet. Create one and it shows up here.').waitFor()
  await page.getByRole('button', { name: 'API keys' }).click()
  await page.getByText('No API keys yet. Create one to call your agent from your own code.').waitFor({ timeout: 8000 })
  const noisy = errors.filter((line) => !/favicon|net::ERR|Failed to load resource/i.test(line))
  if (noisy.length) fail(`console/page errors: ${noisy.slice(0, 4).join(' | ')}`)
}

async function main() {
  if (!fs.existsSync(path.join(DIR, 'index.html'))) fail(`missing ${DIR}/index.html`)
  const server = await serve()
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true })
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      hasTouch: false,
      isMobile: false,
    })
    await context.addInitScript(() => {
      try {
        sessionStorage.setItem(
          'nub:mobile-session',
          JSON.stringify({
            host: 'https://www.maiavm.com',
            instanceId: 'inst-1',
            desktopToken: 'nub_desk_probe',
            pairedAt: '2026-09-21T00:00:00.000Z',
          }),
        )
      } catch {
        /* about:blank */
      }
    })
    await context.route('https://www.maiavm.com/**', (route) => {
      const url = route.request().url()
      let body = {}
      if (url.includes('/api/profile')) body = PROFILE
      else if (url.includes('/api/billing/overview')) body = OVERVIEW
      else if (url.includes('/api/llm/keys')) body = { keys: [] }
      else if (url.includes('/api/llm/usage')) body = { account: null, usage: [], totals: { costUsd: 0 } }
      else if (url.includes('/api/instances')) body = []
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
    })
    const page = await context.newPage()
    await openSettings(page, 1280, 800)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Account' }).waitFor({ timeout: 8000 })
    console.log('FOLD_IN_PROBE ok desktop+mobile')
  } finally {
    await browser.close()
    server.close()
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
