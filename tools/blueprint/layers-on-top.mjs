// Blueprint check: every floating layer, once open, is really on top.
// Hit-tests five points inside each (document.elementFromPoint), because
// aria-expanded, a bounding box or Playwright's "visible" all pass while a
// layer is painted under something else (#248: the desktop notifications
// list sat under the chat). Desktop-width web app, then the phone.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/layers-on-top.mjs
import { APP_URL, assertNubApp, launch, makeReport, phoneHome } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'layers-on-top')
let { browser, page } = await launch(report, { phone: false })

/** Hit-test five points inside the first visible match of `sel`. */
const onTop = (sel) =>
  page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    if (!el) return { ok: false, detail: `nothing matches ${sel}` }
    const r = el.getBoundingClientRect()
    const pts = [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]
      .map(([x, y]) => [Math.min(innerWidth - 1, r.left + r.width * x), Math.min(innerHeight - 1, r.top + r.height * y)])
    const misses = pts.filter(([x, y]) => !el.contains(document.elementFromPoint(x, y)))
    const top = misses[0] ? document.elementFromPoint(misses[0][0], misses[0][1]) : null
    return {
      ok: misses.length === 0,
      detail: `${pts.length - misses.length}/${pts.length} points on it${top ? `; covered by ${top.tagName.toLowerCase()}.${String(top.className).split(' ')[0]}` : ''}`,
    }
  }, sel)

async function fresh(seedNotifications = false) {
  await assertNubApp(page)
  await page.evaluate((seed) => {
    localStorage.clear()
    if (seed) localStorage.setItem('maia:notifications:v1', JSON.stringify([{ id: 'bp-1', kind: 'routine', title: 'Morning briefing ran', at: '2026-10-06T06:00:00Z', read: false }]))
  }, seedNotifications)
  await page.reload()
  await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(500)
}
const row = () => page.getByRole('navigation').getByText('Research Alpha', { exact: true }).first()

const LAYERS = [
  ['the notifications list', true, async () => page.getByTestId('notifications-bell').click(), '[data-testid="notifications-popover"]'],
  ['a chat row\'s menu', false, async () => row().click({ button: 'right' }), '[role="menu"]'],
  ['"Delete conversation?"', false, async () => {
    await row().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  }, '[role="alertdialog"]'],
  ['an agent\'s profile card', false, async () => page.locator('[data-agent-chip]').first().click(), '[data-testid="agent-profile-card"]'],
  ['⌘K search', false, async () => page.keyboard.press('Meta+k'), '[role="dialog"][aria-label="Search"]'],
  ['a file preview', false, async () => page.evaluate(() => { location.hash = '#/?preview=' + encodeURIComponent('/opt/data/workspace/README.md') }), '[role="dialog"][aria-label="README.md"]'],
  ['Agent info', false, async () => page.getByRole('button', { name: 'Info', exact: true }).click(), '[data-side-panel="info"]'],
  ['Files', false, async () => page.getByRole('button', { name: 'Files', exact: true }).click(), '[data-side-panel="files"]'],
  ['Connect apps', false, async () => page.getByRole('button', { name: /Connect apps/ }).click(), '[role="dialog"]'],
  ['Settings', false, async () => page.keyboard.press('Meta+,'), '[role="dialog"][aria-label="Settings"]'],
]

for (const [name, seed, open, sel] of LAYERS) {
  await step(`${name} is on top once open`, async () => {
    await fresh(seed)
    await open()
    await page.waitForTimeout(700)
    return onTop(sel)
  })
}

await browser.close()

// The phone: its own bell list, a chat row's long-press menu, search and
// the "Create new" sheet.
;({ browser, page } = await launch(report, { phone: true }))
async function phoneFresh(seed = false) {
  await assertNubApp(page)
  await page.evaluate((seed) => {
    localStorage.clear()
    if (seed) localStorage.setItem('maia:notifications:v1', JSON.stringify([{ id: 'bp-1', kind: 'routine', title: 'Morning briefing ran', at: '2026-10-06T06:00:00Z', read: false }]))
  }, seed)
  await phoneHome(page)
  await page.waitForTimeout(400)
}
const PHONE = [
  ['Phone: the notifications list', true, async () => page.locator('[data-testid="notifications-bell"]:visible').first().click(), '[data-testid="notifications-popover"]'],
  ['Phone: a chat row\'s menu', false, async () => page.locator('.nub-conv-row').first().click({ button: 'right' }), '[role="menu"]'],
  ['Phone: search', false, async () => page.getByRole('button', { name: 'Search', exact: true }).first().click(), '[role="dialog"][aria-label="Search"]'],
  ['Phone: the "Create new" sheet', false, async () => page.getByRole('button', { name: 'Add', exact: true }).first().click(), '[role="dialog"][aria-label="Create new"]'],
]
for (const [name, seed, open, sel] of PHONE) {
  await step(`${name} is on top once open`, async () => {
    await phoneFresh(seed)
    await open()
    await page.waitForTimeout(700)
    return onTop(sel)
  })
}
await browser.close()
process.exit(finish() ? 0 : 1)
