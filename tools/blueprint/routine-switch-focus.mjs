// Blueprint check: on the Routines page, pausing or resuming a routine from
// the keyboard keeps focus on its switch. The row moves between the Active
// and Paused lists, and the switch was disabled while the change was sent,
// so focus used to fall to the page and the next Tab started over from the
// top. Desktop-width web app and the phone (with a keyboard).
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/routine-switch-focus.mjs
import { APP_URL, assertNubApp, launch, makeReport, phoneHome } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'routine-switch-focus')
const NAME = 'Morning briefing'
const settle = (page, ms = 700) => page.waitForTimeout(ms)
/** Where focus is, and which section the routine is listed under. */
const where = (page) =>
  page.evaluate((name) => {
    const a = document.activeElement
    const row = a?.closest('[data-routine-id]')
    const section = [...document.querySelectorAll('section[aria-label]')].find((s) =>
      [...s.querySelectorAll('[data-routine-id]')].some((r) => r.textContent?.includes(name)),
    )
    return {
      focus: !a || a === document.body ? 'body' : `${a.getAttribute('role') ?? a.tagName.toLowerCase()}:${a.getAttribute('aria-label') ?? ''}`,
      onOwnRow: !!row?.textContent?.includes(name) && a?.getAttribute('role') === 'switch',
      section: section?.getAttribute('aria-label') ?? 'not listed',
    }
  }, NAME)

async function check(label, phone) {
  const { browser, page } = await launch(report, { phone })
  if (phone) {
    await phoneHome(page)
    await page.getByRole('button', { name: 'Routines', exact: true }).click()
  } else {
    await assertNubApp(page)
    await page.evaluate(() => localStorage.clear())
    await page.goto(`${APP_URL}#/routines`)
  }
  await page.getByText(NAME).first().waitFor({ timeout: 20000 })
  await settle(page)
  await step(`${label}: Space on "Pause ${NAME}" keeps focus on its switch`, async () => {
    await page.getByRole('switch', { name: `Pause ${NAME}` }).focus()
    await page.keyboard.press('Space')
    await settle(page)
    const w = await where(page)
    return { ok: w.onOwnRow && /^Paused/.test(w.section), detail: `focus on ${w.focus}; listed under ${w.section}` }
  })
  await step(`${label}: …and Space again resumes it, focus still there`, async () => {
    await page.keyboard.press('Space')
    await settle(page)
    const w = await where(page)
    return { ok: w.onOwnRow && /^Active/.test(w.section), detail: `focus on ${w.focus}; listed under ${w.section}` }
  })
  await browser.close()
}

await check('Desktop', false)
await check('Phone', true)
process.exit(finish() ? 0 : 1)
