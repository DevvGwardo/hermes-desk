// Blueprint check: keyboard focus around ⌘K search on the desktop-width web
// app. Closing it gives focus back to where it was, so the next keystrokes
// land in the composer again. While open, Tab and Shift+Tab stay inside
// the dialog, and the dialog says it's modal. A pick that opens something
// (the routine editor) keeps that surface's focus.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/palette-focus.mjs
import { APP_URL, assertNubApp, launch, makeReport } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'palette-focus')
const { browser, page } = await launch(report, { phone: false })

const palette = () => page.getByRole('dialog', { name: 'Search' })
const composer = () => page.getByPlaceholder('Message the agent…')
const settle = (ms = 400) => page.waitForTimeout(ms)
/** Where focus is: "composer", "body", "search" (inside the palette) or a tag. */
const focusAt = () =>
  page.evaluate(() => {
    const a = document.activeElement
    if (!a || a === document.body) return 'body'
    if (a.closest('[role="dialog"][aria-label="Search"]')) return 'search'
    if (a.getAttribute('placeholder') === 'Message the agent…') return 'composer'
    const d = a.closest('[role="dialog"]')
    return d ? `dialog:${d.getAttribute('aria-label') ?? '?'}` : `${a.tagName.toLowerCase()}:${(a.textContent ?? '').trim().slice(0, 20)}`
  })

async function fresh() {
  await assertNubApp(page)
  await page.evaluate(() => localStorage.clear())
  await page.goto(APP_URL)
  await composer().waitFor({ timeout: 20000 })
  await settle()
}

await fresh()
await step('Esc from search puts focus back in the composer', async () => {
  await composer().click()
  await page.keyboard.press('Meta+k')
  await palette().waitFor({ timeout: 5000 })
  await settle(200)
  await page.keyboard.press('Escape')
  await settle()
  const at = await focusAt()
  return { ok: at === 'composer' && !(await palette().isVisible()), detail: `focus on ${at}` }
})
await step('…so typing right after lands in the composer', async () => {
  await page.keyboard.type('hello')
  const v = await composer().inputValue()
  return { ok: v.includes('hello'), detail: `composer holds ${JSON.stringify(v)}` }
})

await fresh()
await step('A click outside closes search and also restores focus', async () => {
  await composer().click()
  await page.keyboard.press('Meta+k')
  await palette().waitFor({ timeout: 5000 })
  await page.mouse.click(20, 880)
  await settle()
  const at = await focusAt()
  return { ok: at === 'composer' && !(await palette().isVisible()), detail: `focus on ${at}` }
})

await fresh()
await step('Search says it is modal', async () => {
  await page.keyboard.press('Meta+k')
  await palette().waitFor({ timeout: 5000 })
  return { ok: (await palette().getAttribute('aria-modal')) === 'true', detail: `aria-modal=${await palette().getAttribute('aria-modal')}` }
})
await step('Tab, 15 times, never leaves search', async () => {
  const seen = []
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab')
    seen.push(await focusAt())
  }
  const out = seen.filter((s) => s !== 'search')
  return { ok: out.length === 0, detail: out.length ? `left to ${JSON.stringify([...new Set(out)])}` : 'stayed inside' }
})
await step('Shift+Tab, 15 times, never leaves search', async () => {
  const seen = []
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Shift+Tab')
    seen.push(await focusAt())
  }
  const out = seen.filter((s) => s !== 'search')
  return { ok: out.length === 0, detail: out.length ? `left to ${JSON.stringify([...new Set(out)])}` : 'stayed inside' }
})

await fresh()
await step('Picking a routine keeps focus in the routine editor it opens', async () => {
  await composer().click()
  await page.keyboard.press('Meta+k')
  await palette().waitFor({ timeout: 5000 })
  await palette().getByRole('tab', { name: 'Routines', exact: true }).click()
  await palette().getByRole('combobox').fill('weekly')
  await settle(400)
  await page.keyboard.press('Enter')
  await settle(800)
  const at = await focusAt()
  return { ok: at !== 'composer' && at !== 'body' && at !== 'search', detail: `focus on ${at}` }
})

await browser.close()
process.exit(finish() ? 0 : 1)
