// Blueprint check: a chat message's right-click menu (react, reply, copy…)
// works from the keyboard. It used to stay open on Esc, never took focus,
// and its items were plain buttons inside role="menu". Desktop-width web
// app; also with Agent info open, where Esc must close the menu, not Info.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/message-menu.mjs
import { APP_URL, assertNubApp, launch, makeReport } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'message-menu')
const { browser, page } = await launch(report, { phone: false })
const menu = () => page.getByRole('menu', { name: 'Message actions' })
const info = () => page.locator('[data-side-panel="info"]')
const settle = (ms = 400) => page.waitForTimeout(ms)
const focusAt = () =>
  page.evaluate(() => {
    const a = document.activeElement
    if (!a || a === document.body) return 'body'
    return `${a.getAttribute('role') ?? a.tagName.toLowerCase()}:${(a.getAttribute('aria-label') ?? a.textContent ?? '').trim().slice(0, 24)}`
  })

async function fresh(withInfo = false) {
  await assertNubApp(page)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
  await settle(600)
  if (withInfo) {
    await page.getByRole('button', { name: 'Info', exact: true }).click()
    await info().waitFor({ timeout: 5000 })
  }
}
const bubble = () => page.locator('.sand-message-action-anchor').last()

await fresh()
await step('Right-click opens the menu with focus on its first item', async () => {
  await bubble().click({ button: 'right' })
  await menu().waitFor({ timeout: 3000 })
  await settle(200)
  const f = await focusAt()
  return { ok: f.startsWith('menuitem'), detail: `focus on ${f}` }
})
await step('Its items are menu items', async () => {
  const items = await menu().getByRole('menuitem').count()
  const buttons = await menu().locator('button').count()
  return { ok: items > 0 && items === buttons, detail: `${items} menuitem(s) of ${buttons} button(s)` }
})
await step('Arrow Down moves to the next item', async () => {
  const before = await focusAt()
  await page.keyboard.press('ArrowDown')
  const after = await focusAt()
  return { ok: after.startsWith('menuitem') && after !== before, detail: `${before} → ${after}` }
})
await step('Esc closes it', async () => {
  await page.keyboard.press('Escape')
  await settle()
  const open = await menu().isVisible()
  const f = await focusAt()
  return { ok: !open && f !== 'body', detail: `menu ${open ? 'open' : 'closed'}; focus on ${f}` }
})

await fresh(true)
await step('With Agent info open, Esc closes the menu and leaves Info', async () => {
  await bubble().click({ button: 'right' })
  await menu().waitFor({ timeout: 3000 })
  await page.keyboard.press('Escape')
  await settle()
  const open = await menu().isVisible()
  const i = await info().isVisible()
  return { ok: !open && i, detail: `menu ${open ? 'open' : 'closed'}, Info ${i ? 'open' : 'closed'}` }
})

await browser.close()
process.exit(finish() ? 0 : 1)
