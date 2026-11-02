// Blueprint check: the notifications bell's popover closes on Esc (it's a
// disclosure: keyboard users otherwise have no way out but Tab-hunting for
// the bell), returns focus to the bell, and Esc with it closed does nothing
// else. Desktop width and the phone shell.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/bell-esc.mjs
import { APP_URL, assertNubApp, launch, makeReport, phoneHome, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'bell-esc')
const settle = (page, ms = 400) => page.waitForTimeout(ms)

async function bellChecks(page, label) {
  const bell = page.getByTestId('notifications-bell')
  const popover = page.getByTestId('notifications-popover')
  await step(`${label}: the bell opens its list`, async () => {
    await bell.click()
    await popover.waitFor({ timeout: 5000 })
    return { ok: (await bell.getAttribute('aria-expanded')) === 'true', detail: `aria-expanded=${await bell.getAttribute('aria-expanded')}` }
  })
  await step(`${label}: Esc closes the list`, async () => {
    // From inside the list, the way a keyboard user gets there.
    await popover.locator('button').first().focus()
    await page.keyboard.press('Escape')
    await settle(page)
    const open = await popover.isVisible()
    return { ok: !open, detail: open ? 'list still open' : 'closed' }
  })
  await step(`${label}: focus goes back to the bell`, async () => {
    const onBell = await bell.evaluate((el) => document.activeElement === el)
    return { ok: onBell, detail: onBell ? 'bell focused' : 'focus elsewhere' }
  })
}

{
  const { browser, page } = await launch(report, { phone: false })
  await assertNubApp(page)
  await page.evaluate(() => localStorage.clear())
  await page.goto(APP_URL)
  await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
  await settle(page, 600)
  await bellChecks(page, 'Desktop')
  await shot(page, `${report.name}-01-desktop`)
  await browser.close()
}
{
  const { browser, page } = await launch(report, { phone: true })
  await phoneHome(page)
  await settle(page, 600)
  await bellChecks(page, 'Phone')
  await step('Phone: Esc after closing leaves the home list alone', async () => {
    await page.keyboard.press('Escape')
    await settle(page)
    const home = await page.locator('.nub-conv-row').first().isVisible()
    return { ok: home, detail: home ? 'still home' : 'left home' }
  })
  await browser.close()
}
process.exit(finish() ? 0 : 1)
