// Whole-app QA harness: boots the vite dev server, captures every screen/state
// of the REAL app into workbench/out/app_screens/, plus the UiLab gallery.
const { chromium } = require('playwright-core')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')

const ROOT = path.resolve(__dirname, '..', '..')
const OUT = path.join(__dirname, '..', 'out', 'app_screens')
const PORT = 5193
const BASE = `http://127.0.0.1:${PORT}`

function waitForServer(url, timeoutMs = 30000) {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const probe = () => {
      http.get(url + '/?labprobe', res => { res.resume(); resolve() })
        .on('error', () => {
          if (Date.now() - t0 > timeoutMs) reject(new Error('vite dev server did not start'))
          else setTimeout(probe, 500)
        })
    }
    probe()
  })
}

function chromePath() {
  const PW = process.env.HOME + '/Library/Caches/ms-playwright'
  for (const d of fs.readdirSync(PW).filter(x => x.startsWith('chromium-')).sort().reverse()) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
      const p = path.join(PW, d, arch, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('no chromium')
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  // reuse a dev server if one is already on the port
  let vite = null
  try {
    await waitForServer(BASE, 1500)
    console.log('reusing running dev server on', PORT)
  } catch {
    vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: 'ignore',
      detached: true,
    })
    await waitForServer(BASE)
    console.log('vite dev server up on', PORT)
  }

  const browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

  async function shot(name, opts = {}) {
    await page.waitForTimeout(opts.settle ?? 1200)
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: !!opts.fullPage })
    console.log('shot:', name)
  }

  // ── UI Lab (dev-gated gallery of live components) ──
  await page.goto(`${BASE}/?lab=1`, { waitUntil: 'networkidle' })
  await shot('lab_full_gallery', { settle: 1800, fullPage: true })
  // individual lab cards (scroll to each section for a focused shot)
  const labCards = await page.$$('section')
  for (let i = 0; i < Math.min(labCards.length, 9); i++) {
    try {
      await labCards[i].scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
      await labCards[i].screenshot({ path: path.join(OUT, `lab_card_${String(i).padStart(2,'0')}.png`) })
      console.log(`shot: lab_card_${i}`)
    } catch {}
  }

  // ── main app shell states (dev server runs the app itself) ──
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await shot('app_shell_initial')

  // command palette overlay
  await page.keyboard.press('Meta+k').catch(() => {})
  await page.keyboard.press('Control+k').catch(() => {})
  await page.waitForTimeout(600)
  await shot('app_command_palette')

  // narrow viewport (mobile-ish shell)
  await page.setViewportSize({ width: 480, height: 860 })
  await page.waitForTimeout(800)
  await shot('app_shell_narrow')

  await browser.close()

  // ── mascot workbench page (already exists) as an app-asset screen ──
  const b2 = await chromium.launch({ executablePath: chromePath(), headless: true })
  const p2 = await b2.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 })
  await p2.goto('file://' + path.join(__dirname, 'gallery.html'), { waitUntil: 'load' })
  await p2.waitForTimeout(1500)
  await p2.screenshot({ path: path.join(OUT, 'component_gallery.png'), fullPage: true })
  console.log('shot: component_gallery')
  await b2.close()

  if (vite) process.kill(-vite.pid)
  console.log('done:', fs.readdirSync(OUT).length, 'screenshots in out/app_screens/')
}

main().catch(e => { console.error(e); process.exit(1) })
