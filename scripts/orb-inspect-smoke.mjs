import { createRequire } from 'node:module'
import fs from 'node:fs'
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
await page.screenshot({ path: '/tmp/maia-sidebar-now.png' })
const orbs = await page.evaluate(() => {
  const out = []
  for (const s of Array.from(document.querySelectorAll('.nub-sidebar svg')).slice(0, 8)) {
    const rect = s.getBoundingClientRect()
    const style = s.getAttribute('style') || ''
    const wrapperStyle = s.parentElement?.getAttribute('style') || ''
    const fill = s.querySelector('path, circle, rect')?.getAttribute('fill') || ''
    out.push({ w: Math.round(rect.width), h: Math.round(rect.height), fill, style: style.slice(0, 100), wrapper: wrapperStyle.slice(0, 100) })
  }
  return out
})
console.log(JSON.stringify(orbs, null, 1))
await browser.close()
