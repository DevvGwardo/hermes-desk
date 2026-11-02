// Blueprint check: ⌘K search on the desktop-width web app acts on what was
// typed, even when Enter (or ⌘1) comes faster than the 150 ms search
// debounce. Before, a fast Enter ran the previous query's top row: on the
// Agents and Routines tabs that is the pinned "New Agent" / "Create
// Routine", so a quick search-and-go opened a create flow instead.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/palette-enter.mjs
import { APP_URL, assertNubApp, launch, makeReport, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'palette-enter')
const { browser, page } = await launch(report, { phone: false })

const palette = () => page.getByRole('dialog').filter({ has: page.getByRole('tablist', { name: 'Search category' }) })
const input = () => palette().locator('input').first()
const settle = (ms = 500) => page.waitForTimeout(ms)
/** The open chat's title, from the chat header. */
const activeChat = () => page.evaluate(() => document.querySelector('header h1')?.textContent?.trim() ?? '')
/** Every visible dialog's accessible name, to spot a create flow opening. */
const dialogs = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
      .filter((d) => d.getBoundingClientRect().width > 0)
      .map((d) => d.getAttribute('aria-label') || d.querySelector('h1,h2,h3')?.textContent?.trim() || '?'),
  )
const inputValues = () =>
  page.evaluate(() => [...document.querySelectorAll('[role="dialog"] input')].map((i) => i.value).filter(Boolean))

async function fresh() {
  await assertNubApp(page)
  await page.evaluate(() => localStorage.clear())
  await page.goto(APP_URL)
  await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
  await settle()
}

async function openPalette(tabName) {
  await page.keyboard.press('Meta+k')
  await input().waitFor({ timeout: 5000 })
  if (tabName) await palette().getByRole('tab', { name: tabName, exact: true }).click()
  await settle(300)
}

await fresh()
await step('All: a fast "ops runner" + Enter opens Ops Runner', async () => {
  await openPalette()
  await input().fill('ops runner')
  await page.keyboard.press('Enter')
  await settle()
  const chat = await activeChat()
  const open = await palette().isVisible()
  return { ok: !open && /Ops Runner/.test(chat), detail: `palette ${open ? 'open' : 'closed'}; on ${JSON.stringify(chat.slice(0, 40))}` }
})

await fresh()
await step('Agents: a fast "ops runner" + Enter opens the agent, not "New Agent"', async () => {
  await openPalette('Agents')
  await input().fill('ops runner')
  await page.keyboard.press('Enter')
  await settle()
  const chat = await activeChat()
  const open = await dialogs()
  return { ok: open.length === 0 && /Ops Runner/.test(chat), detail: `dialogs ${JSON.stringify(open)}; on ${JSON.stringify(chat.slice(0, 40))}` }
})
await shot(page, `${report.name}-01-agents-tab`)

await fresh()
await step('Routines: a fast "weekly" + Enter opens Weekly digest, not "Create Routine"', async () => {
  await openPalette('Routines')
  await input().fill('weekly')
  await page.keyboard.press('Enter')
  await settle(800)
  const values = await inputValues()
  return { ok: values.some((v) => /Weekly digest/.test(v)), detail: `editor fields ${JSON.stringify(values.slice(0, 3))}` }
})
await shot(page, `${report.name}-02-routines-tab`)

await fresh()
await step('All: a fast "ops runner" + ⌘1 opens Ops Runner', async () => {
  await openPalette()
  await input().fill('ops runner')
  await page.keyboard.press('Meta+1')
  await settle()
  const chat = await activeChat()
  return { ok: /Ops Runner/.test(chat), detail: `on ${JSON.stringify(chat.slice(0, 40))}` }
})

await fresh()
await step('Unhurried typing still works: "ops runner", a pause, Enter', async () => {
  await openPalette()
  await input().fill('ops runner')
  await settle(400)
  await page.keyboard.press('Enter')
  await settle()
  const chat = await activeChat()
  return { ok: /Ops Runner/.test(chat), detail: `on ${JSON.stringify(chat.slice(0, 40))}` }
})

await browser.close()
process.exit(finish() ? 0 : 1)
