// Blueprint check: the sidebar's "Delete conversation?" dialog on the
// desktop-width web app. It opens with Cancel focused, so Enter there must
// cancel (the delete is synced everywhere and can't be undone). Esc closes
// the dialog before any panel behind it, and the deliberate paths (Delete
// focused + Enter, a click on Delete) still delete.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/delete-confirm.mjs
import { APP_URL, assertNubApp, launch, makeReport, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'delete-confirm')
const { browser, page } = await launch(report, { phone: false })

const CHAT = 'Research Alpha'
const dialog = () => page.getByRole('alertdialog', { name: 'Delete conversation' })
const info = () => page.locator('[data-side-panel="info"]')
const row = () => page.getByRole('navigation').getByText(CHAT, { exact: true })
const settle = (ms = 400) => page.waitForTimeout(ms)
const listed = async () => (await row().count()) > 0

async function fresh() {
  await assertNubApp(page)
  await page.evaluate(() => localStorage.clear())
  await page.goto(APP_URL)
  await row().first().waitFor({ timeout: 20000 })
  await settle()
}

async function askToDelete() {
  await row().first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await dialog().waitFor({ timeout: 3000 })
  await settle(200)
}

await fresh()
await step('Delete asks first, with Cancel focused', async () => {
  await askToDelete()
  await shot(page, `${report.name}-01-asking`)
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
  return { ok: focused === 'Cancel' && (await listed()), detail: `focus on ${JSON.stringify(focused)}` }
})

await step('The question names the chat as the sidebar shows it', async () => {
  const text = (await dialog().innerText()).replace(/\s+/g, ' ')
  const quoted = text.match(/“([^”]*)”/)?.[1] ?? ''
  return { ok: quoted === CHAT, detail: `quotes ${JSON.stringify(quoted.slice(0, 50))}` }
})

await step('Enter on the focused Cancel cancels, and keeps the chat', async () => {
  await page.keyboard.press('Enter')
  await settle()
  const open = await dialog().isVisible()
  const kept = await listed()
  await shot(page, `${report.name}-02-after-enter`)
  return { ok: !open && kept, detail: `dialog ${open ? 'open' : 'closed'}; ${CHAT} ${kept ? 'kept' : 'DELETED'}` }
})

await fresh()
await step('Esc cancels, and keeps the chat', async () => {
  await askToDelete()
  await page.keyboard.press('Escape')
  await settle()
  const open = await dialog().isVisible()
  return { ok: !open && (await listed()), detail: `dialog ${open ? 'open' : 'closed'}` }
})

await fresh()
await step('With Agent info open, Esc closes the dialog first and leaves Info', async () => {
  await page.getByRole('button', { name: 'Info', exact: true }).click()
  await info().waitFor({ timeout: 5000 })
  await askToDelete()
  await page.keyboard.press('Escape')
  await settle()
  const open = await dialog().isVisible()
  const infoOpen = await info().isVisible()
  return { ok: !open && infoOpen, detail: `dialog ${open ? 'open' : 'closed'}, Info ${infoOpen ? 'open' : 'closed'}` }
})
await step('…and the next Esc closes Info, with the chat still there', async () => {
  if (await dialog().isVisible()) await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.keyboard.press('Escape')
  await settle()
  const infoOpen = await info().isVisible()
  return { ok: !infoOpen && (await listed()), detail: `Info ${infoOpen ? 'open' : 'closed'}` }
})

await fresh()
await step('With Agent info open, Esc closes the row menu first and leaves Info', async () => {
  await page.getByRole('button', { name: 'Info', exact: true }).click()
  await info().waitFor({ timeout: 5000 })
  await row().first().click({ button: 'right' })
  const menu = page.getByRole('menuitem', { name: 'Delete', exact: true })
  await menu.waitFor({ timeout: 3000 })
  await page.keyboard.press('Escape')
  await settle()
  const open = await menu.isVisible()
  const infoOpen = await info().isVisible()
  return { ok: !open && infoOpen, detail: `menu ${open ? 'open' : 'closed'}, Info ${infoOpen ? 'open' : 'closed'}` }
})

await fresh()
await step('Tab to Delete, then Enter, deletes', async () => {
  await askToDelete()
  await page.keyboard.press('Tab')
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
  await page.keyboard.press('Enter')
  await settle()
  const gone = !(await listed())
  return { ok: focused === 'Delete' && gone && !(await dialog().isVisible()), detail: `focus on ${JSON.stringify(focused)}; ${CHAT} ${gone ? 'deleted' : 'kept'}` }
})

await fresh()
await step('A click on Delete deletes', async () => {
  await askToDelete()
  await dialog().getByRole('button', { name: 'Delete', exact: true }).click()
  await settle()
  const gone = !(await listed())
  return { ok: gone, detail: `${CHAT} ${gone ? 'deleted' : 'kept'}` }
})

await browser.close()
process.exit(finish() ? 0 : 1)
