// Blueprint check: with a side panel open (Agent info), Esc closes the small
// layer on top of it first (the notifications list, an agent's profile
// card) and leaves the panel, on the desktop-width web app. The app's own
// Esc handler runs first (capture phase) and used to close the panel
// underneath instead. The demo has no notifications, so the detail drawer
// is covered by a unit test.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/esc-layers.mjs
import { APP_URL, assertNubApp, launch, makeReport, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'esc-layers')
const { browser, page } = await launch(report, { phone: false })

const info = () => page.locator('[data-side-panel="info"]')
const popover = () => page.getByTestId('notifications-popover')
const card = () => page.getByTestId('agent-profile-card')
const drawer = () => page.getByTestId('notification-detail')
const settle = (ms = 400) => page.waitForTimeout(ms)
const state = async (name, layer) => {
  const l = await layer().isVisible()
  const i = await info().isVisible()
  return { l, i, text: `${name} ${l ? 'open' : 'closed'}, Info ${i ? 'open' : 'closed'}` }
}

async function withInfo() {
  await assertNubApp(page)
  await page.evaluate(() => localStorage.clear())
  await page.goto(APP_URL)
  await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: 'Info', exact: true }).click()
  await info().waitFor({ timeout: 5000 })
  await settle()
}

await withInfo()
await step('Info + notifications list: Esc closes the list, not Info', async () => {
  await page.getByTestId('notifications-bell').click()
  await popover().waitFor({ timeout: 3000 })
  // Into the list, as a keyboard user would be.
  await page.keyboard.press('Tab')
  const inside = await popover().evaluate((el) => el.contains(document.activeElement))
  await page.keyboard.press('Escape')
  await settle()
  const s = await state('list', popover)
  if (!inside) return { ok: false, detail: `Tab didn't reach the list; ${s.text}` }
  return { ok: !s.l && s.i, detail: s.text }
})
await step('…and focus goes back to the bell', async () => {
  const id = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
  return { ok: id === 'notifications-bell', detail: `focus on ${id ?? document.activeElement}` }
})

await withInfo()
await step('Info + an agent\'s profile card: Esc closes the card, not Info', async () => {
  await page.locator('[data-agent-chip]').first().click()
  await card().waitFor({ timeout: 3000 })
  await shot(page, `${report.name}-card`)
  await page.keyboard.press('Escape')
  await settle()
  const s = await state('card', card)
  return { ok: !s.l && s.i, detail: s.text }
})

await withInfo()
await step('Info alone: Esc still closes Info', async () => {
  await page.keyboard.press('Escape')
  await settle()
  const open = await info().isVisible()
  return { ok: !open, detail: open ? 'Info still open' : 'Info closed' }
})

await browser.close()
process.exit(finish() ? 0 : 1)
