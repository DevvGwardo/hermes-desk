// Blueprint walkthrough: a recorded phone tour of the parity work at 390×844
// (mock mode, outside network blocked). Writes blueprint-out/mp4/phone-walk.webm;
// `media.py mp4` turns it into the page's 540-wide mp4.
//
//   node tools/blueprint/walk.mjs
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import { APP_URL, BP, assertNubApp } from './lib.mjs'

const LOCAL = /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/|data:|blob:|about:)/
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  recordVideo: { dir: `${BP}/mp4/raw`, size: { width: 390, height: 844 } },
})
await ctx.route((url) => !LOCAL.test(url.href), (route) => route.abort())
const page = await ctx.newPage()
const pause = (ms = 900) => page.waitForTimeout(ms)
const btn = (name) => page.getByRole('button', { name, exact: true })

await assertNubApp(page)
await page.evaluate(() => localStorage.clear())
await page.goto(APP_URL)
await btn('Preview without linking').click({ timeout: 20000 })
await page.locator('.nub-conv-row').first().waitFor()
await pause(1400)

// Routines: list, pause in place, back.
await btn('Routines').click()
await page.getByTestId('routines-page').waitFor()
await pause(1300)
await page.getByRole('switch', { name: 'Pause Morning briefing' }).click()
await pause(1200)
await page.getByRole('switch', { name: 'Resume Morning briefing' }).click()
await pause(1000)
await page.goBack()
await pause(900)

// Chat: find in chat, then Agent info → Routines.
await page.locator('.nub-conv-row', { hasText: 'Research Alpha' }).click()
await page.locator('.nub-mobile-chat-bar').waitFor()
await pause(1000)
await btn('Find in chat').click()
await page.getByRole('textbox', { name: 'Find in chat' }).pressSequentially('deploy', { delay: 90 })
await pause(1300)
await page.getByRole('button', { name: 'Close find' }).click()
await pause(600)
await page.getByRole('button', { name: 'Agent info' }).click()
await pause(1300)
await page.goBack()
await pause(500)
await page.goBack()
await pause(800)

// Settings: the full desktop panes, as a tab strip.
await btn('Settings').click()
await pause(1000)
await btn('Chat apps').click()
await page.getByRole('dialog', { name: 'Settings' }).waitFor()
await pause(1200)
await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Safety', exact: true }).click()
await pause(1500)
await page.goBack()
await pause(500)
await page.goBack()
await pause(800)

// Search across chats, then the task board.
await btn('Search').click()
await page.getByRole('combobox', { name: 'Search' }).pressSequentially('deploy summary', { delay: 70 })
await pause(1200)
await page.getByRole('option').filter({ hasText: /deploy summary/i }).last().click()
await page.locator('.nub-mobile-chat-bar').waitFor()
await pause(1300)
await page.goBack()
await pause(800)
await btn('Tasks').click()
await page.getByRole('dialog', { name: 'Tasks' }).getByText('Ship the landing page').waitFor()
await pause(1800)

const video = page.video()
await ctx.close()
await browser.close()
const raw = await video.path()
fs.renameSync(raw, `${BP}/mp4/phone-walk.webm`)
console.log('wrote', `${BP}/mp4/phone-walk.webm`)
