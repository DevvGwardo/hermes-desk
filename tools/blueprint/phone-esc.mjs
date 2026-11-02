// Blueprint check: Esc on the phone shell with a keyboard (tablets, phones
// with a keyboard case, the Android app on a Chromebook). The Routines back
// link promises "Back · Esc", and desktop closes Files on Esc. One Esc must
// close exactly one layer: a file preview over Files closes first.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/phone-esc.mjs
import { launch, makeReport, phoneHome, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'phone-esc')
const { browser, page } = await launch(report, { phone: true })

const btn = (name) => page.getByRole('button', { name, exact: true })
const settle = (ms = 600) => page.waitForTimeout(ms)
const routinesPage = () => page.getByTestId('routines-page')
const filesPanel = () => page.locator('aside', { hasText: 'Everything you and your agent saved' })
const previewText = () => page.getByText('Files your agent made live here.')
const atHome = () => page.locator('.nub-conv-row').first().isVisible()

await phoneHome(page)

await step('Routines: the back link promises Esc', async () => {
  await btn('Routines').click()
  await routinesPage().waitFor({ timeout: 6000 })
  const title = await page.getByRole('button', { name: 'Back', exact: true }).getAttribute('title')
  return { ok: /Esc/.test(title ?? ''), detail: `title “${title}”` }
})
await step('Routines: Esc goes back home', async () => {
  await page.keyboard.press('Escape')
  await settle()
  const home = await atHome()
  const still = await routinesPage().isVisible()
  return { ok: home && !still, detail: still ? 'still on Routines' : 'home' }
})

// Each scenario starts from a fresh home, so one failure can't cascade.
await phoneHome(page)
await step('Files: Esc closes Files', async () => {
  await btn('Files').click()
  await filesPanel().waitFor({ timeout: 5000 })
  await settle(400)
  await page.keyboard.press('Escape')
  await settle()
  const open = await filesPanel().isVisible()
  return { ok: !open && (await atHome()), detail: open ? 'Files still open' : 'home' }
})

await phoneHome(page)
await step('Files + preview: one Esc closes only the preview', async () => {
  await btn('Files').click()
  await filesPanel().getByText('README', { exact: true }).click({ timeout: 5000 })
  await previewText().waitFor({ timeout: 6000 })
  await page.keyboard.press('Escape')
  await settle()
  const preview = await previewText().isVisible()
  const files = await filesPanel().isVisible()
  return { ok: !preview && files, detail: `preview ${preview ? 'open' : 'closed'}, Files ${files ? 'open' : 'closed'}` }
})
await shot(page, `${report.name}-01-files-after-esc`)
await step('…and the next Esc closes Files', async () => {
  await page.keyboard.press('Escape')
  await settle()
  const files = await filesPanel().isVisible()
  return { ok: !files && (await atHome()), detail: files ? 'Files still open' : 'home' }
})

await phoneHome(page)
await step('Home: Esc leaves the home list alone', async () => {
  await page.keyboard.press('Escape')
  await settle()
  const home = await atHome()
  return { ok: home, detail: home ? 'still home' : 'left home' }
})

await browser.close()
process.exit(finish() ? 0 : 1)
