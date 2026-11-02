// Blueprint check: a message's action toolbar (react, reply, copy…) shows
// for the message being pointed at or focused, and hides again. Tabbing
// through a chat used to open each message's toolbar for good: focus set
// it, nothing cleared it, and the bars piled up over the messages above.
// Desktop-width web app.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/message-toolbar.mjs
import { APP_URL, assertNubApp, launch, makeReport, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'message-toolbar')
const { browser, page } = await launch(report, { phone: false })
const openBars = () => page.locator('.sand-message-action-anchor--menu-open').count()

await assertNubApp(page)
await page.evaluate(() => localStorage.clear())
await page.reload()
await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
await page.waitForTimeout(800)
const anchors = page.locator('.sand-message-action-anchor')

await step('Pointing at a message shows its toolbar, and moving away hides it', async () => {
  const n = await anchors.count()
  if (n < 2) return { ok: false, detail: `${n} messages with actions` }
  await anchors.nth(n - 1).hover()
  await page.waitForTimeout(300)
  const on = await openBars()
  await page.mouse.move(5, 450)
  await page.waitForTimeout(300)
  const off = await openBars()
  return { ok: on === 1 && off === 0, detail: `${on} open while pointing, ${off} after` }
})

await step('Tabbing through the chat leaves at most one toolbar open', async () => {
  await page.mouse.move(5, 450)
  await anchors.first().focus()
  const seen = []
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab')
    seen.push(await openBars())
  }
  await shot(page, `${report.name}-after-tabbing`)
  const most = Math.max(...seen)
  return { ok: most <= 1, detail: `open toolbars while tabbing: ${seen.join(' ')}` }
})

await step('Leaving the chat (focus in the composer) leaves none open', async () => {
  await page.getByPlaceholder('Message the agent…').focus()
  await page.waitForTimeout(300)
  const n = await openBars()
  return { ok: n === 0, detail: `${n} open` }
})

await browser.close()
process.exit(finish() ? 0 : 1)
