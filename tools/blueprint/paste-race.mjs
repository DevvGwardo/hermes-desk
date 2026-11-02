// Blueprint check: a code you paste on the sign-in screen stays yours. While
// "Getting a code…" is still loading you can paste your own code; when the
// slow request answered, it replaced yours with a fresh one (or, if it
// failed, put up an error and stopped polling your code). The platform's
// start route is answered here after 3 s. Phone sign-in in the demo
// (APP_URL), web sign-in against a production build (WEB_URL, see
// sign-in-screens.mjs for build and serve commands).
//
//   node tools/blueprint/paste-race.mjs
import { launch, makeReport, phoneHome } from './lib.mjs'

const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:4329/'
const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'paste-race')
const MINE = 'AB3D-EF7H'
const THEIRS = 'ZZZZ-ZZZZ'

/** Answer the start route late: with a fresh code, or not at all. */
async function slowStart(page, ok) {
  await page.route('**/api/nub/desktop/auth/start**', async (r) => {
    await new Promise((res) => setTimeout(res, 3000))
    if (!ok) return r.abort()
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: THEIRS, pollInterval: 2, expiresAt: new Date(Date.now() + 600_000).toISOString() }) })
  })
  await page.route('**/api/nub/desktop/auth/poll**', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'pending', pollInterval: 2 }) }),
  )
}
/** The screen's text with code separators and spaces normalised ("AB3D – EF7H" → "AB3D-EF7H"). */
const shows = (page) => page.evaluate(() => document.body.innerText.replace(/\s*[–—-]\s*/g, '-'))

for (const [label, ok] of [['the slow request answers', true], ['the slow request fails', false]]) {
  {
    const { browser, page } = await launch(report, { phone: true })
    await slowStart(page, ok)
    await phoneHome(page)
    await step(`Phone: a pasted code stays after ${label}`, async () => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('nub:open-settings', { detail: { pane: 'general' } })))
      await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Sign in with Telegram' }).click({ timeout: 5000 })
      await page.getByRole('button', { name: 'I have a code' }).click({ timeout: 5000 })
      await page.locator('textarea, input').filter({ hasNot: page.locator('[type=hidden]') }).last().fill(MINE)
      await page.getByRole('button', { name: 'Use this code' }).click()
      await page.waitForTimeout(4500)
      const t = await shows(page)
      // Still on the pasted code: it shows, the late one doesn't, and no error replaced it.
      const mine = t.includes(MINE) && !t.includes(THEIRS) && !/Can.t reach|took too long/.test(t)
      return { ok: mine, detail: mine ? `still on ${MINE}` : `screen now: ${t.includes(THEIRS) ? `shows ${THEIRS}` : /Can.t reach|took too long/.test(t) ? 'an error' : t.slice(0, 80).replace(/\s+/g, ' ')}` }
    })
    await browser.close()
  }
  {
    const { browser, page } = await launch(report, { phone: false })
    await slowStart(page, ok)
    await page.goto(WEB)
    await step(`Web: a pasted code stays after ${label}`, async () => {
      await page.getByRole('button', { name: /I have a code/ }).click({ timeout: 10000 })
      await page.locator('#web-paste').fill(MINE)
      await page.getByRole('button', { name: 'Use this code' }).click()
      await page.waitForTimeout(4500)
      const t = await shows(page)
      // Still on the pasted code: it shows, the late one doesn't, and no error replaced it.
      const mine = t.includes(MINE) && !t.includes(THEIRS) && !/Can.t reach|took too long/.test(t)
      return { ok: mine, detail: mine ? `still on ${MINE}` : `screen now: ${t.includes(THEIRS) ? `shows ${THEIRS}` : /Can.t reach|took too long/.test(t) ? 'an error' : t.slice(0, 80).replace(/\s+/g, ' ')}` }
    })
    await browser.close()
  }
}

process.exit(finish() ? 0 : 1)
