// Blueprint check: on the phone, a file preview is the top layer, so Back
// (the browser button, Android's back, the iOS swipe — all one history pop)
// closes it first and leaves the Files panel underneath; the next Back closes
// Files. A preview must never outlive the panel it was opened from.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/phone-preview.mjs
import { launch, makeReport, phoneHome, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'phone-preview')
const { browser, page } = await launch(report, { phone: true })

const btn = (name) => page.getByRole('button', { name, exact: true })
const filesPanel = () => page.locator('aside', { hasText: 'Everything you and your agent saved' })
const previewText = () => page.getByText('Files your agent made live here.')
const settle = (ms = 600) => page.waitForTimeout(ms)
const state = async () => {
  const preview = await previewText().isVisible()
  const files = await filesPanel().isVisible()
  const home = await page.locator('.nub-conv-row').first().isVisible()
  return { preview, files, home, text: `preview ${preview ? 'open' : 'closed'}, Files ${files ? 'open' : 'closed'}` }
}

await phoneHome(page)

await step('Files opens a file in the preview', async () => {
  await btn('Files').click()
  await filesPanel().getByText('README', { exact: true }).click({ timeout: 5000 })
  await previewText().waitFor({ timeout: 6000 })
})
await shot(page, `${report.name}-01-preview`)

await step('Back closes the preview first, leaving Files open', async () => {
  await page.goBack()
  await settle()
  const s = await state()
  return { ok: !s.preview && s.files, detail: s.text }
})
await shot(page, `${report.name}-02-after-back`)

await step('The next Back closes Files and returns home', async () => {
  await page.goBack()
  await settle()
  const s = await state()
  return { ok: !s.preview && !s.files && s.home, detail: `${s.text}, home ${s.home ? 'showing' : 'hidden'}` }
})

await step('Closing the preview with its own button still keeps Files open', async () => {
  await btn('Files').click()
  await filesPanel().getByText('README', { exact: true }).click({ timeout: 5000 })
  await previewText().waitFor({ timeout: 6000 })
  await page.getByRole('dialog').getByRole('button', { name: /^Close/ }).first().click()
  await settle()
  const s = await state()
  return { ok: !s.preview && s.files, detail: s.text }
})

await step('…and Back from there closes Files, with no preview left behind', async () => {
  await page.goBack()
  await settle()
  const s = await state()
  return { ok: !s.preview && !s.files && s.home, detail: `${s.text}, home ${s.home ? 'showing' : 'hidden'}` }
})

await browser.close()
process.exit(finish() ? 0 : 1)
