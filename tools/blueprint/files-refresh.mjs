// Blueprint check: Refresh in the Files panel reloads the listing and
// keeps what's typed in its search box (and the filtered list). Opening
// another folder still starts with an empty search. Desktop-width web app
// and the phone.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/files-refresh.mjs
import { APP_URL, assertNubApp, launch, makeReport, phoneHome } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'files-refresh')
const settle = (page, ms = 600) => page.waitForTimeout(ms)

async function check(label, phone) {
  const { browser, page } = await launch(report, { phone })
  const search = () => page.getByRole('searchbox', { name: 'Search files' })
  if (phone) {
    await phoneHome(page)
  } else {
    await assertNubApp(page)
    await page.evaluate(() => localStorage.clear())
    await page.goto(APP_URL)
    await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
  }
  await page.getByRole('button', { name: 'Files', exact: true }).first().click()
  await search().waitFor({ timeout: 6000 })
  await settle(page)
  // Scoped to the panel holding the search box; rows show the name without
  // its extension ("README"), so match the start.
  const panel = () => page.locator(':is(aside, [role="dialog"])', { has: search() }).last()
  const listed = (name) => panel().getByText(new RegExp(`^${name}`, "i")).first().isVisible()

  await step(`${label}: Refresh keeps the search and its filtered list`, async () => {
    await search().fill('read')
    await settle(page, 300)
    const before = { readme: await listed('README'), landing: await listed('landing') }
    await page.getByRole('button', { name: 'Refresh files' }).click()
    await settle(page)
    const q = await search().inputValue()
    const after = { readme: await listed('README'), landing: await listed('landing') }
    return {
      ok: q === 'read' && after.readme && !after.landing && before.readme && !before.landing,
      detail: `search ${JSON.stringify(q)}; README ${after.readme ? 'listed' : 'gone'}, landing ${after.landing ? 'listed' : 'filtered out'}`,
    }
  })
  await step(`${label}: opening a folder still starts with an empty search`, async () => {
    await search().fill('')
    await panel().getByText(/^landing/).first().click()
    await settle(page)
    const q = await search().inputValue()
    return { ok: q === '' && (await listed('index')), detail: `search ${JSON.stringify(q)}; index ${await listed('index') ? 'listed' : 'missing'}` }
  })
  await browser.close()
}

await check('Desktop', false)
await check('Phone', true)
process.exit(finish() ? 0 : 1)
