// Blueprint check: the file preview's "Discard unsaved changes?" prompt
// belongs to the preview that is open. Once a preview with edits has been
// closed (and the edits discarded), Back / Forward and links to a file must
// not ask about those edits again, and a fresh preview still guards its own.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/preview-guard.mjs
import { APP_URL, assertNubApp, launch, makeReport, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'preview-guard')
const { browser, page } = await launch(report, { phone: false })

const FILE = '/opt/data/workspace/README.md'
const preview = () => page.getByRole('dialog', { name: 'README.md' })
const editor = () => preview().locator('textarea')
const settle = (ms = 500) => page.waitForTimeout(ms)

// Every window.confirm the app raises is logged; `answer` says how the
// "user" replies (OK = discard, Cancel = keep editing).
const prompts = []
let answer = 'accept'
page.on('dialog', (d) => {
  prompts.push(d.message())
  void (answer === 'accept' ? d.accept() : d.dismiss())
})

/** Navigate as a link would: same route, plus `preview=<path>`. */
const linkToFile = () =>
  page.evaluate((p) => {
    const [path, q = ''] = (location.hash || '#/').split('?')
    const params = new URLSearchParams(q)
    params.set('preview', p)
    location.hash = `${path}?${params}`
  }, FILE)

async function fresh() {
  await assertNubApp(page)
  await page.evaluate(() => localStorage.clear())
  await page.goto(APP_URL)
  await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
  prompts.length = 0
  answer = 'accept'
}

async function openAndEdit(text) {
  await linkToFile()
  await preview().waitFor({ timeout: 5000 })
  await preview().getByRole('button', { name: 'Edit', exact: true }).click()
  await editor().waitFor({ timeout: 3000 })
  await editor().fill(text)
  await settle(200)
}

await fresh()
await step('Closing a preview with unsaved edits asks once, and Discard closes it', async () => {
  await openAndEdit('# Workspace\n\nA draft I mean to throw away.\n')
  await shot(page, `${report.name}-01-editing`)
  await preview().getByRole('button', { name: 'Close' }).click()
  await settle()
  const open = await preview().isVisible()
  return { ok: prompts.length === 1 && !open, detail: `${prompts.length} prompt(s): ${JSON.stringify(prompts)}; preview ${open ? 'open' : 'closed'}` }
})

await step('Back and Forward after that never ask about the discarded edits', async () => {
  const before = prompts.length
  // Keep editing would strand the user on the old URL, so answer Cancel: a
  // stale prompt then also blocks the hop and shows up as a stuck URL.
  answer = 'dismiss'
  await page.goBack()
  await settle()
  await page.goForward()
  await settle()
  await page.goBack()
  await settle()
  const extra = prompts.slice(before)
  return { ok: extra.length === 0, detail: extra.length ? `${extra.length} stale prompt(s): ${JSON.stringify(extra)}` : 'no prompts' }
})

await step('A link to the file opens it again, without a prompt', async () => {
  const before = prompts.length
  answer = 'dismiss'
  await page.keyboard.press('Escape').catch(() => {})
  await settle()
  if (await preview().isVisible()) {
    // Back/Forward left the preview open; close it cleanly first (no edits).
    await preview().getByRole('button', { name: 'Close' }).click()
    await settle()
  }
  await linkToFile()
  await settle()
  const open = await preview().isVisible()
  const extra = prompts.slice(before)
  await shot(page, `${report.name}-02-reopened`)
  return {
    ok: open && extra.length === 0,
    detail: `preview ${open ? 'open' : 'closed'}; ${extra.length} prompt(s)${extra.length ? `: ${JSON.stringify(extra)}` : ''}`,
  }
})

await step('The reopened preview shows the saved file, not the discarded draft', async () => {
  const text = await preview().innerText({ timeout: 3000 })
  const stale = text.includes('throw away')
  return { ok: !stale && text.includes('Files your agent made'), detail: stale ? 'discarded draft shown' : 'saved text shown' }
})

await fresh()
await step('Fresh edits still guard Close: Keep editing keeps the draft', async () => {
  await openAndEdit('# Workspace\n\nA draft I want to keep.\n')
  answer = 'dismiss'
  await preview().getByRole('button', { name: 'Close' }).click()
  await settle()
  const open = await preview().isVisible()
  const draft = open ? await editor().inputValue() : ''
  return { ok: prompts.length === 1 && open && draft.includes('want to keep'), detail: `${prompts.length} prompt(s); preview ${open ? 'open' : 'closed'}; draft ${draft.includes('want to keep') ? 'kept' : 'lost'}` }
})

await step('Fresh edits still guard Esc', async () => {
  const before = prompts.length
  answer = 'dismiss'
  await editor().press('Escape')
  await settle()
  const open = await preview().isVisible()
  return { ok: prompts.length === before + 1 && open, detail: `${prompts.length - before} prompt(s); preview ${open ? 'open' : 'closed'}` }
})

await step('Fresh edits still guard Back: Keep editing keeps the preview and its URL', async () => {
  const before = prompts.length
  answer = 'dismiss'
  await page.goBack()
  await settle()
  const kept = await preview().isVisible()
  const url = await page.evaluate(() => location.hash.includes('preview='))
  const draft = kept ? await editor().inputValue() : ''
  return {
    ok: prompts.length === before + 1 && kept && url && draft.includes('want to keep'),
    detail: `${prompts.length - before} prompt(s); preview ${kept ? 'open' : 'closed'}; URL ${url ? 'names' : 'lost'} the file; draft ${draft.includes('want to keep') ? 'kept' : 'lost'}`,
  }
})

await step('…and Discard on Close then lets it go', async () => {
  const before = prompts.length
  answer = 'accept'
  await preview().getByRole('button', { name: 'Close' }).click()
  await settle()
  const closed = !(await preview().isVisible())
  return { ok: prompts.length === before + 1 && closed, detail: `${prompts.length - before} prompt(s); preview ${closed ? 'closed' : 'open'}` }
})

await browser.close()
process.exit(finish() ? 0 : 1)
