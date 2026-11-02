#!/usr/bin/env node
/** Headless walk of the Grok-parity Search palette against the running Vite server. */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')
const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const OUT = process.env.OUT || '/tmp/maia-search-smoke'
fs.mkdirSync(OUT, { recursive: true })

const fail = []
function ok(cond, msg) {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`)
  if (!cond) fail.push(msg)
  return cond
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.setDefaultTimeout(8000)

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  // Dismiss Telegram / first-run overlays if present.
  const skipDemo = page.getByRole('button', { name: 'Skip for now (demo)' })
  if (await skipDemo.count()) {
    await skipDemo.click({ force: true })
    await page.waitForTimeout(400)
  }
  for (const label of ['Skip', 'Not now', 'Close', 'Cancel', 'Maybe later']) {
    const btn = page.getByRole('button', { name: label })
    if (await btn.count()) {
      try {
        await btn.first().click({ timeout: 800 })
      } catch {}
    }
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  const searchBtn = page.getByRole('button', { name: 'Search' }).first()
  ok(await searchBtn.count(), 'sidebar Search button exists')
  await searchBtn.click()
  await page.waitForTimeout(200)

  const dialog = page.getByRole('dialog', { name: 'Search' })
  ok(await dialog.isVisible(), 'palette dialog opens from sidebar Search')
  await page.screenshot({ path: path.join(OUT, '01-open.png') })

  for (const name of ['All', 'Messages', 'Agents', 'Groups', 'Files', 'Links', 'Routines', 'Actions']) {
    ok(await page.getByRole('tab', { name }).count(), `tab ${name}`)
  }

  const allOptions = page.getByRole('option')
  const allCount = await allOptions.count()
  ok(allCount > 0, `All tab lists rows (${allCount})`)

  await page.getByRole('tab', { name: 'Messages' }).click()
  ok(await page.getByText('Search messages').count(), 'Messages empty hint title')
  ok(await page.getByText('Type to find messages across your chats.').count(), 'Messages empty hint body')

  const input = page.getByPlaceholder('Search')
  await input.fill('deploy')
  await page.waitForTimeout(250)
  const msgHits = await page.getByRole('option').count()
  ok(msgHits > 0, `typed Messages query returns rows (${msgHits})`)
  if (msgHits > 0) {
    await page.getByRole('option').first().click()
    await page.waitForTimeout(300)
    ok(!(await dialog.isVisible().catch(() => false)), 'selecting a message closes the palette')
    await page.getByRole('button', { name: 'Search' }).first().click()
    await page.waitForTimeout(200)
  }

  await page.getByPlaceholder('Search').fill('')
  await page.waitForTimeout(200)
  await page.getByRole('tab', { name: 'Agents' }).click()
  const agentRows = await page.getByRole('option').count()
  ok(agentRows > 0, `Agents tab lists roster (${agentRows})`)
  await page.getByText('Draft Writer').click()
  await page.waitForTimeout(250)
  ok(await page.getByText(/Draft Writer|Long-form|Careful writer/i).count(), 'agent row opens that agent')
  await page.getByRole('button', { name: 'Search' }).first().click()
  await page.waitForTimeout(200)

  await page.getByRole('tab', { name: 'Groups' }).click()
  await page.waitForTimeout(100)
  await page.screenshot({ path: path.join(OUT, '02-groups.png') })

  await page.getByRole('tab', { name: 'Files' }).click()
  await page.waitForTimeout(100)
  await page.screenshot({ path: path.join(OUT, '03-files.png') })
  if (await page.getByText('index.html').count()) {
    await page.getByText('index.html').first().click()
    await page.waitForTimeout(300)
    ok(
      (await page.getByRole('dialog').count()) > 0 || (await page.getByText(/index\.html/i).count()) > 0,
      'file row opens a preview',
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    await page.getByRole('button', { name: 'Search' }).first().click()
    await page.waitForTimeout(200)
  }

  await page.getByRole('tab', { name: 'Links' }).click()
  await page.waitForTimeout(100)
  await page.screenshot({ path: path.join(OUT, '04-links.png') })

  await page.getByRole('tab', { name: 'Routines' }).click()
  await page.waitForTimeout(400)
  const createRoutine = page.getByText('Create Routine')
  ok(await createRoutine.count(), 'Routines tab offers Create Routine')
  await createRoutine.first().click()
  await page.waitForTimeout(250)
  ok(await page.getByPlaceholder('Name this routine').count(), 'routine editor name field')
  ok(
    await page.getByPlaceholder('What should this routine do each time it runs?').count(),
    'routine editor instruction field',
  )
  await page.getByPlaceholder('Name this routine').fill('Morning brief')
  await page.getByPlaceholder('What should this routine do each time it runs?').fill('Summarize overnight work.')
  await page.getByRole('button', { name: 'Create Routine' }).click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Search' }).first().click()
  await page.waitForTimeout(200)
  await page.getByRole('tab', { name: 'Routines' }).click()
  await page.waitForTimeout(250)
  ok(await page.getByText('Morning brief').count(), 'new routine appears in Routines tab')

  await page.getByRole('tab', { name: 'Actions' }).click()
  const actionRows = await page.getByRole('option').count()
  ok(actionRows > 0, `Actions tab lists commands (${actionRows})`)
  await page.screenshot({ path: path.join(OUT, '05-actions.png') })

  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  ok(!(await dialog.isVisible().catch(() => false)), 'Escape closes palette')

  await page.keyboard.press('Meta+k')
  await page.waitForTimeout(200)
  ok(await page.getByRole('dialog', { name: 'Search' }).isVisible(), '⌘K reopens palette')

  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 900, height: 800 })
  await page.getByRole('button', { name: 'Search' }).first().click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(OUT, '06-narrow.png') })
  const tablist = page.getByRole('tablist', { name: 'Search category' })
  ok(await tablist.isVisible(), 'tab strip still visible at 900px')
} catch (err) {
  fail.push(String(err?.stack || err))
  console.error(err)
  try {
    await page.screenshot({ path: path.join(OUT, 'error.png') })
  } catch {}
} finally {
  await browser.close()
}

console.log(`\nshots: ${OUT}`)
if (fail.length) {
  console.error(`FAILED ${fail.length}`)
  process.exit(1)
}
console.log('OK')
