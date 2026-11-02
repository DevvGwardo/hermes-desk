// Blueprint check: the "Connect with Telegram" dialog behaves as the modal
// it says it is (aria-modal). It used to leave focus on the page behind
// it, so Tab walked the dimmed sidebar and typing went into the composer;
// its error wasn't announced. In the unlinked demo, /new-agent opens it.
// Desktop-width web app.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/telegram-focus.mjs
import { APP_URL, assertNubApp, launch, makeReport } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'telegram-focus')
const { browser, page } = await launch(report, { phone: false })
const dialog = () => page.getByRole('dialog', { name: 'Connect with Telegram' })
const composer = () => page.getByPlaceholder('Message the agent…')
const inDialog = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-label="Connect with Telegram"]'))

await assertNubApp(page)
await page.evaluate(() => localStorage.clear())
await page.reload()
await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
await page.waitForTimeout(500)

await step('Opening it moves focus into the dialog', async () => {
  await composer().click()
  await composer().fill('/new-agent')
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')
  await dialog().waitFor({ timeout: 5000 })
  await page.waitForTimeout(400)
  return { ok: await inDialog(), detail: (await inDialog()) ? 'focus inside' : `focus on ${await page.evaluate(() => document.activeElement?.tagName.toLowerCase())}` }
})
await step('Tab, 10 times, never leaves it', async () => {
  let out = 0
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab')
    if (!(await inDialog())) out++
  }
  return { ok: out === 0, detail: out ? `${out}/10 presses landed behind it` : 'stayed inside' }
})
await step('Its error is announced (role=alert)', async () => {
  const alerts = await dialog().getByRole('alert').count()
  const text = alerts ? (await dialog().getByRole('alert').first().innerText()).slice(0, 50) : ''
  return { ok: alerts > 0, detail: alerts ? `“${text}”` : 'no alert role' }
})
await step('Esc closes it and puts focus back in the composer', async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const open = await dialog().isVisible()
  const back = await composer().evaluate((el) => el === document.activeElement)
  return { ok: !open && back, detail: `dialog ${open ? 'open' : 'closed'}; focus ${back ? 'in the composer' : 'elsewhere'}` }
})

await browser.close()
process.exit(finish() ? 0 : 1)
