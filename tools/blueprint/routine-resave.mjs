// Blueprint check: a second save in the routine editor sends what changed
// since the first. After "Save & run now" (which saves, then runs), the
// editor stays open on Results; flipping Active back and pressing Save must
// still reach the agent, not be compared against the copy the editor
// opened with. Checked against the demo agent's own routine list (left and
// re-entered, so the page re-reads it), on the desktop-width web app.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/routine-resave.mjs
import { APP_URL, assertNubApp, launch, makeReport, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'routine-resave')
const { browser, page } = await launch(report, { phone: false })

const NAME = 'Morning briefing'
const editor = () => page.getByRole('dialog').filter({ has: page.getByRole('tab', { name: 'Settings' }) })
const settle = (ms = 500) => page.waitForTimeout(ms)
/** Which section of the Routines page lists the routine ("Active (1)", "Paused (1)"). */
const sectionOf = () =>
  page.evaluate((name) => {
    for (const s of document.querySelectorAll('section[aria-label]')) {
      if ([...s.querySelectorAll('[data-routine-id]')].some((r) => r.textContent?.includes(name))) return s.getAttribute('aria-label')
    }
    return 'not listed'
  }, NAME)
const go = (hash) =>
  page.evaluate((h) => {
    location.hash = h
  }, hash)

async function routinesPage() {
  await go('#/routines')
  await page.getByText(NAME).first().waitFor({ timeout: 8000 })
  await settle()
}
/** Leave and come back, so the page re-reads the agent's list. */
async function reread() {
  await go('#/')
  await settle(400)
  await routinesPage()
}
async function openSettings() {
  await page.locator('[data-routine-id]').filter({ hasText: NAME }).first().click()
  await editor().waitFor({ timeout: 5000 })
  await editor().getByRole('tab', { name: 'Settings' }).click()
  await settle(300)
}

await assertNubApp(page)
await page.evaluate(() => localStorage.clear())
await page.goto(APP_URL)
await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
await routinesPage()

await step(`${NAME} starts Active`, async () => {
  const s = await sectionOf()
  return { ok: /^Active/.test(s ?? ''), detail: s }
})

await step('Active off, then "Save & run now": saves and starts a run, editor stays on Results', async () => {
  await openSettings()
  await editor().getByRole('switch', { name: 'Active' }).click()
  await editor().getByRole('button', { name: 'Save & run now' }).click()
  await editor().getByRole('tab', { name: 'Results', selected: true }).waitFor({ timeout: 5000 })
  await settle()
  return { ok: true, detail: 'saved and started; editor on Results' }
})

await step('…the editor no longer offers to save what it just saved', async () => {
  await editor().getByRole('tab', { name: 'Settings' }).click()
  await settle(300)
  const label = (await editor().getByRole('button', { name: /run now/i }).first().innerText()).trim()
  return { ok: label === 'Run now', detail: `button reads ${JSON.stringify(label)}` }
})

await step('Active back on, then Save, resumes it on the agent', async () => {
  await editor().getByRole('switch', { name: 'Active' }).click()
  await editor().getByRole('button', { name: 'Save', exact: true }).click()
  await editor().waitFor({ state: 'hidden', timeout: 5000 })
  await reread()
  const s = await sectionOf()
  await shot(page, `${report.name}-after`)
  return { ok: /^Active/.test(s ?? ''), detail: `listed under ${s}` }
})

await step('A schedule changed and then changed back is sent back too', async () => {
  // Same baseline problem, on the schedule: save 08:00 via Save & run now,
  // then the original time with Save; the agent must end on the original.
  await openSettings()
  const before = await page.evaluate((name) => [...document.querySelectorAll('[data-routine-id]')].find((r) => r.textContent?.includes(name))?.textContent ?? '', NAME)
  const time = editor().locator('input[type="time"]').first()
  if (!(await time.count())) return { ok: false, detail: 'no time field in the editor' }
  const original = await time.inputValue()
  const other = original === '08:00' ? '07:00' : '08:00'
  await time.fill(other)
  await editor().getByRole('button', { name: 'Save & run now' }).click()
  await editor().getByRole('tab', { name: 'Results', selected: true }).waitFor({ timeout: 5000 })
  await editor().getByRole('tab', { name: 'Settings' }).click()
  await editor().locator('input[type="time"]').first().fill(original)
  await editor().getByRole('button', { name: 'Save', exact: true }).click()
  await editor().waitFor({ state: 'hidden', timeout: 5000 })
  await reread()
  await openSettings()
  const now = await editor().locator('input[type="time"]').first().inputValue()
  await page.keyboard.press('Escape')
  return { ok: now === original, detail: `opened at ${original}, set ${other} then ${original}; agent has ${now}${before ? '' : ''}` }
})

await browser.close()
process.exit(finish() ? 0 : 1)
