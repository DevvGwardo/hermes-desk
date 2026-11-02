// Blueprint check: the routine editor's two-step delete. "Delete" asks
// "Delete this routine?" first; that question belongs to the routine it was
// asked about. Closing the editor any way (Esc, Cancel) and opening another
// routine — or a new one — must show a plain Delete again, never a primed
// confirm that deletes on one tap.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/routine-editor.mjs
import { APP_URL, assertNubApp, launch, makeReport, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'routine-editor')
const { browser, page } = await launch(report, { phone: false })

await assertNubApp(page)
await page.evaluate(() => localStorage.clear())
await page.goto(APP_URL)
await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
await page.evaluate(() => { location.hash = '#/routines' })
await page.locator('[data-routine-id]').nth(1).waitFor({ timeout: 10000 })

const dialog = page.getByRole('dialog')
const confirmGroup = () => dialog.getByRole('group', { name: 'Confirm delete' })
const openRow = async (i) => {
  await page.locator('[data-routine-id]').nth(i).locator('button').first().click()
  await dialog.waitFor({ timeout: 5000 })
  await page.waitForTimeout(300)
  // A routine that has run opens on Results; Delete lives on Settings.
  const settings = dialog.getByTestId('routine-tab-settings')
  if (await settings.count()) {
    await settings.click()
    await page.waitForTimeout(200)
  }
}
const closedEditor = async () => {
  await dialog.waitFor({ state: 'hidden', timeout: 5000 })
  await page.waitForTimeout(300)
}
const rowCount = () => page.locator('[data-routine-id]').count()

const before = await rowCount()

await step('Delete asks first, without deleting', async () => {
  await openRow(0)
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  const asked = await confirmGroup().isVisible()
  return { ok: asked, detail: asked ? '“Delete this routine?” shown' : 'no confirm shown' }
})
await shot(page, `${report.name}-01-confirm`)

await step('Esc after Delete closes the editor', async () => {
  await page.keyboard.press('Escape')
  await closedEditor()
  return true
})

await step('The next routine opens with a plain Delete, not a primed confirm', async () => {
  await openRow(1)
  const primed = await confirmGroup().isVisible()
  return { ok: !primed, detail: primed ? '“Delete this routine?” already showing' : 'plain Delete' }
})
await shot(page, `${report.name}-02-next-routine`)

await step('Cancel after Delete also clears the question', async () => {
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await confirmGroup().waitFor({ timeout: 3000 })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await closedEditor()
  await openRow(0)
  const primed = await confirmGroup().isVisible()
  await page.keyboard.press('Escape')
  await closedEditor()
  return { ok: !primed, detail: primed ? 'confirm survived Cancel' : 'plain Delete' }
})

await step('“Keep” backs out of the question and keeps the routine', async () => {
  await openRow(0)
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await dialog.getByRole('button', { name: 'Keep', exact: true }).click()
  const back = await dialog.getByRole('button', { name: 'Delete', exact: true }).isVisible()
  await page.keyboard.press('Escape')
  await closedEditor()
  const after = await rowCount()
  return { ok: back && after === before, detail: `${before} → ${after} routines` }
})

await step('No routine was deleted by any of the above', async () => {
  const after = await rowCount()
  return { ok: after === before, detail: `${before} → ${after} routines` }
})

await browser.close()
process.exit(finish() ? 0 : 1)
