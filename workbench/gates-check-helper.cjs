// Gate-check helpers: each export runs a scripted browser check and prints a
// single decisive line. Used by GATES.md CHECK lines.
const path = require('path')
const fs = require('fs')

const PW = process.env.HOME + '/Library/Caches/ms-playwright'
function chromePath() {
  const dirs = fs.readdirSync(PW).filter(d => d.startsWith('chromium-')).sort().reverse()
  for (const d of dirs) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
      const p = path.join(PW, d, arch, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('no chromium found under ' + PW)
}
async function withPage(fn) {
  const { chromium } = require('/Users/devgwardo/maiavm-desktop/node_modules/playwright-core')
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  try { return await fn(page, browser) } finally { await browser.close() }
}

// G1: gaze must update without remounting the svg
async function gazeNoRemount() {
  const r = await withPage(async page => {
    let remounts
    await page.goto('file://' + path.join(__dirname, 'index.html'), { waitUntil: 'load' })
    await page.waitForTimeout(600)
    remounts = await page.evaluate(async () => {
      const before = document.querySelectorAll('#gaze-holder svg').length
      for (let i = 0; i < 10; i++) window.__setGaze(100 + i * 30, 200 + i * 10)
      await new Promise(r => setTimeout(r, 300))
      const after = document.querySelectorAll('#gaze-holder svg').length
      return { before, after, delta: Math.abs(after - before) }
    })
    return `remounts:${remounts.delta}`
  })
  console.log(r)
}

// G2: perf results include gated rows with fps numbers
async function gatedPerf() {
  const r = await withPage(async page => {
    await page.goto('file://' + path.join(__dirname, 'index.html'), { waitUntil: 'load' })
    await page.waitForFunction(() => window.__PERF_RESULTS && window.__PERF_RESULTS.some(x => x.gated), null, { timeout: 60000 })
    return page.evaluate(() => {
      const gated = window.__PERF_RESULTS.filter(x => x.gated)
      return `gated rows: ${gated.length}, fps: ${gated.map(g => g.fps).join('/')}`
    })
  })
  console.log(r)
}

// G3: table has blink column AND sorting reorders rows
async function tableColumns() {
  const r = await withPage(async page => {
    await page.goto('file://' + path.join(__dirname, 'index.html'), { waitUntil: 'load' })
    await page.waitForTimeout(500)
    return page.evaluate(() => {
      const ths = [...document.querySelectorAll('#data-table th')].map(t => t.textContent.trim())
      const hasBlink = ths.some(t => t.includes('blink'))
      // sort by cycle and confirm first row changes vs default state order
      const before = document.querySelector('#data-tbody tr td').textContent
      document.querySelector('#data-table th[data-col="cycle"]').click()
      const after = document.querySelector('#data-tbody tr td').textContent
      return `blink col: ${hasBlink}; sort: ${before} -> ${after} (${before !== after ? 'reordered' : 'SAME'})`
    })
  })
  console.log(r)
}

// G8: sweep every interactive control, count errors
async function errorSweep() {
  let errs = 0
  await withPage(async page => {
    page.on('pageerror', () => errs++)
    page.on('pageerror', e => console.error('[err]', String(e).slice(0, 120)))
    await page.goto('file://' + path.join(__dirname, 'index.html'), { waitUntil: 'load' })
    await page.waitForFunction(() => !!window.__PERF_RESULTS || false, null, { timeout: 90000 }).catch(() => {})
    // stage controls
    for (const sel of ['#state-sel', '#shape-sel']) {
      const opts = await page.$$(sel + ' option')
      for (const o of opts.slice(0, 6)) {
        await page.selectOption(sel, await o.getAttribute('value'))
        await page.waitForTimeout(80)
      }
    }
    for (const btn of ['btn-burst', 'btn-spin', 'btn-bounce', 'btn-pause', 'btn-light']) {
      await page.click('#' + btn); await page.waitForTimeout(60)
    }
    // sort every column both directions
    for (const key of ['state', 'group', 'cycle', 'blink', 'poses', 'pattern', 'fxloop']) {
      await page.click(`#data-table th[data-col="${key}"]`)
      await page.click(`#data-table th[data-col="${key}"]`)
    }
    // gaze
    await page.mouse.move(400, 400); await page.mouse.move(800, 300)
    // click some data-table states to load into stage
    const cells = await page.$$('#data-tbody td:first-child')
    for (const c of cells.slice(0, 5)) { await c.click(); await page.waitForTimeout(50) }
  })
  console.log(`errors:${errs}`)
}

module.exports = { gazeNoRemount, gatedPerf, tableColumns, errorSweep }
if (require.main === module) {
  const fn = process.argv[2]
  if (!fn || !module.exports[fn]) { console.error('usage: node gates-check-helper.cjs <gazeNoRemount|gatedPerf|tableColumns|errorSweep>'); process.exit(1) }
  module.exports[fn]().catch(e => { console.error(e); process.exit(1) })
}
