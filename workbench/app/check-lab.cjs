// check-lab.cjs — gate checks for the whole-app workbench
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..', '..')

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
async function withPage(fn) {
  const { chromium } = require('/Users/devgwardo/maiavm-desktop/node_modules/playwright-core')
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  try { return await fn(page, browser) } finally { await browser.close() }
}

async function labPanel() {
  // boots the dev server briefly and confirms the lab renders its surfaces
  const { spawn } = require('child_process')
  const http = require('http')
  const PORT = 5194, BASE = `http://127.0.0.1:${PORT}`
  const up = () => new Promise((res, rej) => {
    const t0 = Date.now()
    const probe = () => http.get(BASE, r => { r.resume(); res() }).on('error', () =>
      Date.now() - t0 > 25000 ? rej(new Error('no server')) : setTimeout(probe, 400))
    probe()
  })
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true })
  try {
    await up()
    const n = await withPage(async page => {
      let errs = 0
      page.on('pageerror', () => errs++)
      await page.goto(BASE + '/?lab=1', { waitUntil: 'networkidle' })
      await page.waitForTimeout(1500)
      if (errs) throw new Error(`${errs} page errors in lab`)
      return page.evaluate(() => document.querySelectorAll('section').length)
    })
    console.log(`lab renders:${n} surfaces`)
  } finally {
    try { process.kill(-vite.pid) } catch {}
  }
}

async function gallery() {
  const n = await withPage(async page => {
    await page.goto('file://' + path.join(__dirname, 'gallery.html'), { waitUntil: 'load' })
    await page.waitForFunction(() => document.querySelectorAll('.card').length > 20)
    return page.evaluate(() => document.querySelectorAll('.card').length)
  })
  console.log(`gallery surfaces rendered:${n}`)
}

async function prodGate() {
  // build prod renderer bundle and prove the Lab is absent from the chunk graph
  execSync('npx tsc -b && npx vite build --outDir /tmp/maia-prod-check --emptyOutDir', { cwd: ROOT, stdio: 'ignore' })
  const dir = '/tmp/maia-prod-check'
  let hits = []
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.js')) {
      const s = fs.readFileSync(p, 'utf8')
      if (s.includes('UiLab') || s.includes('War Room') /* fixture data only exists in the lab */) hits.push(path.basename(p))
    }
  })
  walk(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`lab-in-prod:${hits.length === 0 ? 'false' : 'true ' + hits.join(',')}`)
}

async function verifyShots() {
  const { chromium } = require('/Users/devgwardo/maiavm-desktop/node_modules/playwright-core')
  // pixel-variance blank check via canvas in the browser (no numpy dep)
  const files = fs.readdirSync(path.join(__dirname, '..', 'out', 'app_screens')).filter(f => f.endsWith('.png'))
  let blank = 0
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  const page = await browser.newPage()
  for (const f of files) {
    const b64 = fs.readFileSync(path.join(__dirname, '..', 'out', 'app_screens', f)).toString('base64')
    const std = await page.evaluate(async src => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + src
      await new Promise(r => { img.onload = r; img.onerror = r })
      const c = document.createElement('canvas'); c.width = 100; c.height = 60
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, 100, 60)
      const d = ctx.getImageData(0, 0, 100, 60).data
      let sum = 0, sum2 = 0, n = d.length
      for (let i = 0; i < n; i += 4) { const v = d[i]; sum += v; sum2 += v * v }
      const mean = sum / (n / 4)
      return Math.sqrt(sum2 / (n / 4) - mean * mean)
    }, b64)
    if (std < 3) blank++
  }
  await browser.close()
  console.log(`shots:${files.length} blank:${blank}`)
}

const fn = process.argv[2]
const map = { 'lab-panel': labPanel, gallery, 'prod-gate': prodGate, 'verify-shots': verifyShots }
if (!fn || !map[fn]) { console.error('usage: node check-lab.cjs <lab-panel|gallery|prod-gate|verify-shots>'); process.exit(1) }
map[fn]().catch(e => { console.error(e); process.exit(1) })
