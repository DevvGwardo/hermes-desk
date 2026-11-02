// Blueprint check: a slash command typed out in full runs that command.
// "/new" is a prefix of "/new-agent", which the list puts first, and the
// highlight resets to the top row on every keystroke, so "/new" + Enter
// opened the agent creator (on the web: "Connect with Telegram") instead
// of a new conversation. Desktop-width web app.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/slash-exact.mjs
import { APP_URL, assertNubApp, launch, makeReport } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'slash-exact')
const { browser, page } = await launch(report, { phone: false })
const composer = () => page.getByPlaceholder('Message the agent…')
const menuRows = () =>
  page.evaluate(() => [...document.querySelectorAll('.font-mono')].map((e) => e.textContent ?? '').filter((t) => t.startsWith('/')))
const dialogs = () =>
  page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map((d) => d.getAttribute('aria-label') || d.querySelector('h1,h2')?.textContent || '?'))

async function fresh() {
  await assertNubApp(page)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(500)
}
async function type(cmd) {
  await composer().click()
  await composer().fill(cmd)
  await page.waitForTimeout(300)
}

await fresh()
await step('"/new" lists New conversation first', async () => {
  await type('/new')
  const rows = await menuRows()
  return { ok: rows[0] === '/new', detail: `menu: ${rows.join(' ')}` }
})
await step('…and Enter doesn\'t open the agent creator', async () => {
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  const d = await dialogs()
  const draft = await composer().inputValue()
  return { ok: d.length === 0 && draft === '', detail: `dialogs ${JSON.stringify(d)}; draft ${JSON.stringify(draft)}` }
})

await fresh()
await step('"/new-agent" + Enter still opens the agent creator', async () => {
  await type('/new-agent')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  const d = await dialogs()
  return { ok: d.length === 1, detail: `dialogs ${JSON.stringify(d)}` }
})

await fresh()
await step('"/ne" (a prefix) still lists both, in list order', async () => {
  await type('/ne')
  const rows = await menuRows()
  return { ok: rows.join(' ') === '/new-agent /new', detail: `menu: ${rows.join(' ')}` }
})

await browser.close()
process.exit(finish() ? 0 : 1)
