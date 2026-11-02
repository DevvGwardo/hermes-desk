// Blueprint check: on the phone with a keyboard (a tablet, a keyboard
// case, the Android app on a Chromebook), a chat row's long-press menu
// takes focus, moves with the arrow keys and closes on Esc, giving focus
// back to the row. It used to ignore Esc entirely and never take focus.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/phone-row-menu.mjs
import { launch, makeReport, phoneHome } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'phone-row-menu')
const { browser, page } = await launch(report, { phone: true })
const menu = () => page.getByRole('menu')
const focusAt = () =>
  page.evaluate(() => {
    const a = document.activeElement
    if (!a || a === document.body) return 'body'
    return `${a.getAttribute('role') ?? a.tagName.toLowerCase()}:${(a.textContent ?? '').trim().slice(0, 24)}`
  })

await phoneHome(page)
const row = page.locator('.nub-conv-row').first()
await step('Opening a row\'s menu puts focus on its first item', async () => {
  await row.focus()
  await row.click({ button: 'right' })
  await menu().waitFor({ timeout: 3000 })
  await page.waitForTimeout(200)
  const f = await focusAt()
  return { ok: f.startsWith('menuitem'), detail: `focus on ${f}` }
})
await step('Arrow Down moves to the next item', async () => {
  const before = await focusAt()
  await page.keyboard.press('ArrowDown')
  const after = await focusAt()
  return { ok: after.startsWith('menuitem') && after !== before, detail: `${before} → ${after}` }
})
await step('Esc closes it and gives focus back to the row', async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const open = await menu().isVisible()
  const f = await focusAt()
  const onRow = await row.evaluate((el) => el === document.activeElement)
  return { ok: !open && onRow, detail: `menu ${open ? 'open' : 'closed'}; focus on ${f}` }
})
await step('…and the home list is still there (Esc took one layer only)', async () => {
  const home = await row.isVisible()
  return { ok: home, detail: home ? 'home list showing' : 'home list gone' }
})

await browser.close()
process.exit(finish() ? 0 : 1)
