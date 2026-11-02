#!/usr/bin/env node
/** Drive Plugins → Yours → Tools against a live Electron window (CDP). */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')
const CDP = process.env.CDP || 'http://127.0.0.1:9222'
const OUT = process.env.OUT || '/tmp/maia-plugins-smoke'
fs.mkdirSync(OUT, { recursive: true })

const fail = []
function ok(cond, msg) {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`)
  if (!cond) fail.push(msg)
  return cond
}

const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0]
if (!context) {
  console.error('no CDP context')
  process.exit(1)
}
const page =
  context.pages().find((p) => !p.url().startsWith('devtools://')) || (await context.newPage())
page.setDefaultTimeout(20_000)

try {
  await page.waitForTimeout(800)
  for (const label of ['Skip for now (demo)', 'Skip', 'Not now', 'Close']) {
    const btn = page.getByRole('button', { name: label })
    if (await btn.count()) {
      try {
        await btn.first().click({ timeout: 600 })
      } catch {
        /* overlay already gone */
      }
    }
  }

  const pluginsBtn = page.getByRole('button', { name: 'Plugins' }).first()
  ok(await pluginsBtn.count(), 'sidebar Plugins button')
  await pluginsBtn.click()
  await page.waitForTimeout(400)

  const dialog = page.getByRole('dialog', { name: 'Plugins' })
  ok(await dialog.isVisible(), 'Plugins dialog open')
  await page.screenshot({ path: path.join(OUT, '01-plugins.png') })

  const yours = page.getByRole('button', { name: /Yours/ })
  ok(await yours.count(), 'Yours tab')
  await yours.click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(OUT, '02-yours.png') })

  const gmail = page.getByText('gmail', { exact: true }).first()
  ok(await gmail.count(), 'gmail row')

  const toolsBtns = page.getByRole('button', { name: 'Tools' })
  ok((await toolsBtns.count()) >= 1, 'Tools button')
  await toolsBtns.first().click()
  await page.getByText('Testing…').first().waitFor({ timeout: 8_000 }).catch(() => {})
  await page.getByText('Testing…').first().waitFor({ state: 'hidden', timeout: 50_000 }).catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, '03-tools.png') })

  const body = await dialog.innerText()
  const unreachable = /dashboard, which is unreachable|agent box is down/i.test(body)
  const draft = /create_draft/i.test(body)
  ok(!unreachable, 'no dashboard-unreachable error')
  ok(draft, 'gmail tools listed (create_draft)')

  const githubTools = toolsBtns.nth(1)
  if ((await toolsBtns.count()) > 1) {
    await githubTools.click()
    await page.getByText('Testing…').first().waitFor({ timeout: 8_000 }).catch(() => {})
    await page.getByText('Testing…').first().waitFor({ state: 'hidden', timeout: 50_000 }).catch(() => {})
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(OUT, '04-github.png') })
    const after = await dialog.innerText()
    const ghHit = /list_issues|search_repositories|create_pull_request|get_file_contents|needs sign-in|Tap Auth/i.test(
      after,
    )
    ok(ghHit, 'github tools or needs-auth surfaced')
    console.log('--- github excerpt ---')
    console.log(after.slice(0, 900))
  }

  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(OUT, '05-sidebar.png') })
  const brand = page.locator('aside.nub-sidebar').first()
  const brandText = await brand.innerText()
  ok(/Nub Agent/i.test(brandText), 'sidebar brand label')
  ok(/powered by Maia VM/i.test(brandText), 'sidebar powered-by')
  const staticLogo = await page.locator('aside.nub-sidebar img[alt="Nub Agent"]').count()
  ok(staticLogo === 0, 'static nub-logo.png is gone')
  const mascotSvg = await page.locator('aside.nub-sidebar svg').first().count()
  ok(mascotSvg > 0, 'animated mascot SVG in brand row')

  console.log('--- dialog excerpt ---')
  console.log(body.slice(0, 800))
} catch (err) {
  fail.push(String(err && err.message ? err.message : err))
  try {
    await page.screenshot({ path: path.join(OUT, 'fail.png') })
  } catch {
    /* ignore */
  }
} finally {
  await browser.close()
}

if (fail.length) {
  console.error(`FAILED ${fail.length}: ${fail.join('; ')}`)
  process.exit(1)
}
console.log('OK')
