// Blueprint check: on the phone, "Sign in with Telegram" in the full
// Settings sheet (General → Your Nub account) must land on the "Link this
// phone" screen and stay there, and Back from it must not reopen the sheet.
//
// Stream-safe: lib.mjs aborts the pairing request, so no code is minted;
// the screen shows its error state, which is all this check needs.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/phone-signin.mjs
import { launch, makeReport, phoneHome, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'phone-signin')
const { browser, page } = await launch(report, { phone: true })

await phoneHome(page)
const settingsSheet = page.getByRole('dialog', { name: 'Settings' })
const linkScreen = page.getByRole('heading', { name: 'Link this phone' })

await step('Settings opens on General with “Sign in with Telegram”', async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('nub:open-settings', { detail: { pane: 'general' } })))
  await settingsSheet.waitFor({ timeout: 5000 })
  await settingsSheet.getByRole('button', { name: 'Sign in with Telegram' }).waitFor({ timeout: 5000 })
})
await shot(page, `${report.name}-01-settings`)

await step('“Sign in with Telegram” opens “Link this phone”', async () => {
  await settingsSheet.getByRole('button', { name: 'Sign in with Telegram' }).click()
  await linkScreen.waitFor({ timeout: 5000 })
})

await step('…and stays there (no bounce back to Settings)', async () => {
  await page.waitForTimeout(1500)
  const linking = await linkScreen.isVisible()
  const sheet = await settingsSheet.isVisible()
  const settingsScreen = await page.getByTestId('mobile-link-card').isVisible().catch(() => false)
  const where = linking ? 'Link this phone' : sheet ? 'Settings sheet' : settingsScreen ? 'phone Settings screen' : 'somewhere else'
  return { ok: linking && !sheet, detail: `after 1.5 s: ${where}` }
})
await shot(page, `${report.name}-02-after-tap`)

await step('Back from “Link this phone” doesn’t reopen the Settings sheet', async () => {
  if (!(await linkScreen.isVisible())) return { ok: false, detail: 'never reached Link this phone' }
  await page.goBack()
  await page.waitForTimeout(800)
  const sheet = await settingsSheet.isVisible()
  return { ok: !sheet, detail: sheet ? 'Settings sheet is back' : 'sheet stays closed' }
})

// Same button, reached the long way: home → Settings screen → a row that
// opens the sheet → General. The sheet sits one level deeper here.
await phoneHome(page)
await step('From the Settings screen: the sheet’s “Sign in with Telegram” stays on “Link this phone”', async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 3000 })
  await page.getByRole('button', { name: 'Plan & usage', exact: true }).click({ timeout: 4000 })
  await settingsSheet.waitFor({ timeout: 5000 })
  await settingsSheet.getByRole('button', { name: 'General', exact: true }).click()
  await settingsSheet.getByRole('button', { name: 'Sign in with Telegram' }).click({ timeout: 5000 })
  await page.waitForTimeout(1500)
  const linking = await linkScreen.isVisible()
  const sheet = await settingsSheet.isVisible()
  const settingsScreen = await page.getByTestId('mobile-link-card').isVisible().catch(() => false)
  const where = linking ? 'Link this phone' : sheet ? 'Settings sheet' : settingsScreen ? 'phone Settings screen' : 'somewhere else'
  return { ok: linking && !sheet, detail: `after 1.5 s: ${where}` }
})
await shot(page, `${report.name}-03-from-settings-screen`)

await browser.close()
process.exit(finish() ? 0 : 1)
