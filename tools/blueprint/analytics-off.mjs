// Blueprint check: the offline demo never talks to PostHog. Analytics only
// starts in a production build with a key (src/lib/analytics.ts), so a dev
// or demo session must send nothing — even while doing the things that are
// tracked (sending a message, creating a routine) — and Settings → Safety
// must not show a "Share usage analytics" switch that would do nothing here.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/analytics-off.mjs
import { APP_URL, assertNubApp, launch, makeReport, phoneHome } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'analytics-off')
const POSTHOG = /posthog|\/ingest\//i

async function watch(page) {
  const hits = []
  page.on('request', (r) => {
    if (POSTHOG.test(r.url())) hits.push(new URL(r.url()).host)
  })
  return hits
}

{
  const { browser, page } = await launch(report, { phone: false })
  const hits = await watch(page)
  await assertNubApp(page)
  await page.evaluate(() => localStorage.clear())
  await page.goto(APP_URL)
  await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
  await step('Desktop: sending a message in the demo', async () => {
    const box = page.getByPlaceholder(/Message/).first()
    await box.fill('hello from the harness')
    await box.press('Enter')
    await page.waitForTimeout(1500)
  })
  await step('Desktop: creating a routine in the demo', async () => {
    await page.evaluate(() => { location.hash = '#/routines' })
    await page.getByRole('button', { name: 'New routine', exact: true }).click({ timeout: 8000 })
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox').first().fill('Harness check routine')
    await dialog.locator('textarea').first().fill('Say hi.')
    await dialog.getByRole('button', { name: /^(Create Routine|Save)$/ }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 5000 })
  })
  await step('Desktop: Safety has no analytics switch in the demo', async () => {
    await page.evaluate(() => { location.hash = '#/?settings=1&pane=privacy' })
    await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ timeout: 5000 })
    await page.waitForTimeout(500)
    const shown = await page.getByRole('switch', { name: 'Share usage analytics' }).count()
    return { ok: shown === 0, detail: shown ? 'switch shown' : 'hidden' }
  })
  await step('Desktop: no request to PostHog', () => ({ ok: hits.length === 0, detail: `${hits.length} request(s)` }))
  await browser.close()
}
{
  const { browser, page } = await launch(report, { phone: true })
  const hits = await watch(page)
  await phoneHome(page)
  await step('Phone: opening a chat and Settings → Safety in the demo', async () => {
    await page.locator('.nub-conv-row').first().click()
    await page.waitForTimeout(800)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('nub:open-settings', { detail: { pane: 'privacy' } })))
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ timeout: 5000 })
  })
  await step('Phone: no request to PostHog', () => ({ ok: hits.length === 0, detail: `${hits.length} request(s)` }))
  await browser.close()
}
await step('No outside request was even attempted to PostHog', () => {
  const blocked = report.blockedHosts.filter((h) => /posthog/i.test(h))
  return { ok: blocked.length === 0, detail: blocked.length ? 'attempted' : 'none' }
})
process.exit(finish() ? 0 : 1)
