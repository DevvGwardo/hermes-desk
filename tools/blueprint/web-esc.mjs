// Blueprint check: on the desktop-width web app, Esc closes the top layer.
// A modal (here Settings) opened while Agent info is showing sits above it,
// so the first Esc closes the modal and leaves Info; the next Esc closes
// Info.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/web-esc.mjs
import { APP_URL, assertNubApp, launch, makeReport, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'web-esc')
const { browser, page } = await launch(report, { phone: false })

const info = () => page.locator('[data-side-panel="info"]')
const modal = (name) => page.getByRole('dialog', { name })
const settle = (ms = 500) => page.waitForTimeout(ms)
const state = async (name) => {
  const m = await modal(name).isVisible()
  const i = await info().isVisible()
  return { m, i, text: `${name} ${m ? 'open' : 'closed'}, Info ${i ? 'open' : 'closed'}` }
}

async function freshWithInfo() {
  await assertNubApp(page)
  await page.evaluate(() => localStorage.clear())
  await page.goto(APP_URL)
  await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: 'Info', exact: true }).click()
  await info().waitFor({ timeout: 5000 })
  await settle()
}

await freshWithInfo()
await step('Info + Settings: the first Esc closes Settings, not Info', async () => {
  await page.keyboard.press('Meta+,')
  await modal('Settings').waitFor({ timeout: 5000 })
  await settle()
  await page.keyboard.press('Escape')
  await settle()
  const s = await state('Settings')
  return { ok: !s.m && s.i, detail: s.text }
})
await shot(page, `${report.name}-01-after-esc`)
await step('…and the next Esc closes Info', async () => {
  await modal('Settings').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
  await page.keyboard.press('Escape')
  await settle()
  const s = await state('Settings')
  return { ok: !s.m && !s.i, detail: s.text }
})

await freshWithInfo()
await step('Info alone: Esc still closes Info', async () => {
  await page.keyboard.press('Escape')
  await settle()
  const open = await info().isVisible()
  return { ok: !open, detail: open ? 'Info still open' : 'Info closed' }
})

await browser.close()
process.exit(finish() ? 0 : 1)
