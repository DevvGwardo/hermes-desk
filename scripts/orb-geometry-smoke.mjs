import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.setDefaultTimeout(8000)
await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(900)
for (const label of ['Skip for now (demo)', 'Skip', 'Not now', 'Close', 'Cancel', 'Maybe later']) {
  const btn = page.getByRole('button', { name: label })
  if (await btn.count()) { try { await btn.first().click({ timeout: 800 }) } catch {} }
}
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
const g = await page.evaluate(() => {
  const row = document.querySelector('[data-conversation-id]')
  if (!row) return { error: 'no rows' }
  const btn = row.querySelector('button')
  const svg = row.querySelector('svg')
  const title = row.querySelector('.sidebar-title-fade')
  const sub = row.querySelector('span.block.truncate.text-\\[11px\\]') || row.querySelectorAll('span')[3]
  const dot = row.querySelector('.status-pulse, .absolute.right-0\\.5')
  const rb = row.getBoundingClientRect()
  const bb = btn.getBoundingClientRect()
  const sb = svg ? svg.getBoundingClientRect() : null
  const tb = title ? title.getBoundingClientRect() : null
  const subb = sub ? sub.getBoundingClientRect() : null
  const db = dot ? dot.getBoundingClientRect() : null
  const out = { row: { x: rb.x, y: rb.y, w: rb.width, h: rb.height }, btn: { y: bb.y, h: bb.height } }
  if (sb) out.svg = { x: sb.x, y: sb.y, w: sb.width, h: sb.height, cy: sb.y + sb.height / 2 }
  if (tb) out.title = { y: tb.y, h: tb.height, cy: tb.y + tb.height / 2 }
  if (subb) out.sub = { y: subb.y, h: subb.height }
  if (db) out.dot = { x: db.x, y: db.y, w: db.width, h: db.height }
  // vertical centers
  out.centers = { svg: sb ? sb.y + sb.height/2 : null, title: tb ? tb.y + tb.height/2 : null, sub: subb ? subb.y + subb.height/2 : null }
  return out
})
console.log(JSON.stringify(g, null, 1))
await browser.close()
