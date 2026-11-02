#!/usr/bin/env node
/** Headless walk of Grok-parity reactions + reply-to-message against Vite. */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')
const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const OUT = process.env.OUT || '/tmp/maia-reactions-smoke'
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
  await page.waitForTimeout(300)

  const bubbles = page.locator('.sand-message-action-anchor')
  const n = await bubbles.count()
  ok(n > 0, `message action anchors present (${n})`)
  if (n === 0) throw new Error('no messages to hover')

  const agentBubble = bubbles.last()
  await agentBubble.hover()
  await page.waitForTimeout(150)
  await page.screenshot({ path: path.join(OUT, '01-hover.png') })

  const addReaction = page.getByRole('button', { name: 'Add reaction' })
  ok(await addReaction.isVisible(), 'Add reaction (smiley) on hover')
  ok(await page.getByRole('button', { name: /Reply to / }).isVisible(), 'Reply button on hover')
  ok(await page.getByRole('button', { name: 'More message actions' }).isVisible(), 'More (dots) on hover')

  await addReaction.click()
  await page.waitForTimeout(150)
  for (const emoji of ['👍', '👎', '❤️', '😂', '🎉', '😮']) {
    ok(await page.getByRole('button', { name: emoji }).count(), `quick reaction ${emoji}`)
  }
  ok(await page.getByRole('button', { name: 'More emoji' }).isVisible(), 'More emoji expander')
  await page.screenshot({ path: path.join(OUT, '02-picker.png') })

  await page.getByRole('button', { name: '🎉' }).click()
  await page.waitForTimeout(200)
  ok(await page.getByRole('button', { name: /reacted with 🎉/ }).count(), 'reaction pill after tap')

  await agentBubble.hover()
  await page.getByRole('button', { name: /Reply to / }).click()
  await page.waitForTimeout(150)
  ok(await page.getByRole('button', { name: 'Cancel reply' }).isVisible(), 'composer reply pill')
  await page.screenshot({ path: path.join(OUT, '03-reply-pill.png') })

  const composer = page.getByPlaceholder('Message the agent…')
  await composer.fill('checking the quote')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.waitForTimeout(400)
  ok(
    (await page.getByRole('button', { name: 'Cancel reply' }).count()) === 0,
    'reply pill clears after send',
  )
  ok(await page.getByText('checking the quote').count(), 'reply body visible')
  await page.screenshot({ path: path.join(OUT, '04-sent-reply.png') })

  const settings = page.getByRole('button', { name: /Settings/i }).first()
  if (await settings.count()) {
    await settings.click()
    await page.waitForTimeout(200)
    const appearance = page.getByRole('button', { name: 'Appearance' })
    if (await appearance.count()) {
      await appearance.click()
      await page.waitForTimeout(150)
      ok(await page.getByText('Message reactions').count(), 'Settings → Appearance reactions toggle')
      await page.screenshot({ path: path.join(OUT, '05-settings.png') })
      await page.keyboard.press('Escape')
    }
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, '06-mobile.png') })
} catch (err) {
  fail.push(String(err))
  await page.screenshot({ path: path.join(OUT, 'fail.png') }).catch(() => {})
  console.error(err)
} finally {
  await browser.close()
}

if (fail.length) {
  console.error(`\nFAILED ${fail.length}:\n- ${fail.join('\n- ')}`)
  process.exit(1)
}
console.log(`\nOK · shots in ${OUT}`)
