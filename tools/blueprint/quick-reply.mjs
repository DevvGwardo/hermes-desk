// Blueprint check: tapping a quick-reply chip under an agent's message
// ("Draft API client", "Show deploy status", "Skip for now" in the demo)
// sends it as a plain reply and retires the chips. The bubble used to read
// "[choice:c1] Draft API client", and the chips stayed live, so each tap
// sent it again. Desktop-width web app, then the phone.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/quick-reply.mjs
import { APP_URL, assertNubApp, launch, makeReport, phoneHome } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'quick-reply')

async function check(label, phone) {
  const { browser, page } = await launch(report, { phone })
  if (phone) {
    await phoneHome(page)
    await page.locator('.nub-conv-row').filter({ hasText: 'Research Alpha' }).first().click()
  } else {
    await assertNubApp(page)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
  }
  const chip = page.getByRole('button', { name: 'Draft API client', exact: true })
  await chip.first().waitFor({ timeout: 10000 })
  await step(`${label}: a tapped chip posts its words, not a [choice:…] token`, async () => {
    await chip.first().click()
    await page.waitForTimeout(800)
    const raw = await page.getByText(/\[choice:/).count()
    const sent = await page.getByText('Draft API client', { exact: true }).count()
    return { ok: raw === 0 && sent >= 2, detail: `${raw} bubble(s) with a token; "Draft API client" appears ${sent}× (chip + reply)` }
  })
  await step(`${label}: the chips are retired once answered`, async () => {
    const disabled = await chip.first().isDisabled()
    return { ok: disabled, detail: disabled ? 'chips disabled' : 'chips still live' }
  })
  await browser.close()
}

await check('Desktop', false)
await check('Phone', true)
process.exit(finish() ? 0 : 1)
