// Blueprint check: on the desktop-width web shell, the Plugins (⌘⇧M) and
// Hermes tools (⌘⇧W) panels don't exist, so their shortcuts and deep links
// must not leave an invisible panel behind — one that lands in the URL and
// eats the next Esc meant for what is actually on screen.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/web-panels.mjs
import { APP_URL, assertNubApp, launch, makeReport, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'web-panels')
const { browser, page } = await launch(report, { phone: false })

await assertNubApp(page)
await page.evaluate(() => localStorage.clear())
await page.goto(APP_URL)
await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
await page.waitForTimeout(600)

const settingsNav = () => page.getByRole('navigation', { name: 'Settings sections' })
const openSettings = async () => {
  await page.evaluate(() => { location.hash = '#/?settings=1' })
  await settingsNav().waitFor({ timeout: 5000 })
}
const hash = () => page.evaluate(() => location.hash)

for (const [combo, label, param] of [
  ['Meta+Shift+M', '⌘⇧M (Plugins)', 'mcp=1'],
  ['Meta+Shift+W', '⌘⇧W (Hermes tools)', 'tools='],
]) {
  await step(`Web: ${label} leaves the URL alone`, async () => {
    await page.evaluate(() => { location.hash = '' })
    await page.waitForTimeout(300)
    await page.keyboard.press(combo)
    await page.waitForTimeout(400)
    const h = await hash()
    return { ok: !h.includes(param), detail: `hash ${JSON.stringify(h)}` }
  })
  await step(`Web: Esc after ${label} still closes Settings`, async () => {
    await openSettings()
    await page.keyboard.press(combo)
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    const open = await settingsNav().isVisible()
    return { ok: !open, detail: open ? 'Settings still open: Esc went to a hidden panel' : 'Settings closed' }
  })
  await page.keyboard.press('Escape')
}

for (const [deepLink, label] of [
  ['#/?settings=1&mcp=1', 'Plugins'],
  ['#/?settings=1&tools=skills', 'Hermes tools'],
]) {
  await step(`Web: a Settings link that also names ${label} still closes on Esc`, async () => {
    await page.evaluate((h) => { location.hash = h }, deepLink)
    await settingsNav().waitFor({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    const open = await settingsNav().isVisible()
    return { ok: !open, detail: open ? 'Settings still open: Esc went to a hidden panel' : 'Settings closed' }
  })
  await page.keyboard.press('Escape')
}

await page.evaluate(() => { location.hash = '' })
await page.waitForTimeout(400)
await shot(page, `${report.name}-01-home`)
await browser.close()
process.exit(finish() ? 0 : 1)
