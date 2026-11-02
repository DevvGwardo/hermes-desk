// Blueprint check: the demo's Agent info shows what a real agent's does.
// Real agents live on a VM (`region: 'remote'`); the demo agents carried old
// Hetzner region names, so Agent info treated them as local and hid their
// routines count and the agent-only sections.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/demo-agent-info.mjs
import { APP_URL, assertNubApp, launch, makeReport, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'demo-agent-info')
const { browser, page } = await launch(report, { phone: false })
await assertNubApp(page)
await page.evaluate(() => localStorage.clear())
await page.goto(APP_URL)
await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
await page.getByRole('button', { name: 'Info', exact: true }).first().click()
const routines = page.getByTestId('agent-routines')
await routines.waitFor({ timeout: 6000 })
await page.waitForTimeout(1200)

await step('Agent info counts the agent\'s own routines', async () => {
  const text = (await page.getByTestId('agent-routines-summary').innerText()).trim()
  return { ok: /^\d+ routines? · \d+ active$/.test(text) && !/^0 /.test(text), detail: `“${text}”` }
})
await step('The count matches the Routines page', async () => {
  const text = (await page.getByTestId('agent-routines-summary').innerText()).trim()
  const n = Number(text.split(' ')[0])
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await page.keyboard.press('Meta+k')
  await page.getByRole('tab', { name: 'Routines' }).click()
  await page.waitForTimeout(500)
  const listed = await page.getByRole('option').count()
  await page.keyboard.press('Escape')
  return { ok: n > 0 && n <= listed, detail: `Agent info ${n}; ⌘K Routines lists ${listed} (all agents)` }
})
await step('No section says the agent can\'t be reached', async () => {
  await page.getByRole('button', { name: 'Info', exact: true }).first().click()
  await routines.waitFor({ timeout: 6000 })
  await page.waitForTimeout(1200)
  const panel = page.locator('[role="dialog"], aside').filter({ has: routines }).last()
  const body = await panel.innerText()
  const bad = body.match(/can’t reach|couldn’t load|failed to fetch|offline/i)
  await shot(page, 'demo-agent-info')
  return { ok: !bad, detail: bad ? `“${bad[0]}”` : 'none' }
})
await browser.close()
process.exit(finish() ? 0 : 1)
