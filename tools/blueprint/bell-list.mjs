// Blueprint check: the notifications list can be seen and read. On the
// desktop-width web app the open list was drawn *under* the chat (the glass
// header is its own stacking context with no z-index), so the bell opened
// an invisible list unless a side panel happened to be open. And the bell
// tells screen readers how many are unread: its aria-label replaced the
// badge's text, so the count was never announced. The demo has no
// notifications, so two unread ones are seeded in the bell's local cache.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/bell-list.mjs
import { APP_URL, assertNubApp, launch, makeReport, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'bell-list')
const SEED = [
  { id: 'bp-1', kind: 'routine', title: 'Morning briefing ran', at: '2026-10-06T06:00:00Z', read: false },
  { id: 'bp-2', kind: 'agent', title: 'Ops Runner replied', at: '2026-10-06T06:01:00Z', read: false },
]

/** Is the open list really on top? Hit-test a few points inside it. */
const listOnTop = (page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-testid="notifications-popover"]')].find((e) => e.getBoundingClientRect().width > 0)
    if (!el) return { ok: false, detail: 'no list' }
    const r = el.getBoundingClientRect()
    const pts = [[0.5, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]].map(([x, y]) => [r.left + r.width * x, r.top + r.height * y])
    const hits = pts.filter(([x, y]) => el.contains(document.elementFromPoint(x, y))).length
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { ok: hits === pts.length, detail: `${hits}/${pts.length} points hit the list${hits < pts.length ? `; on top: ${top?.tagName.toLowerCase()}.${String(top?.className ?? '').split(' ')[0]}` : ''}` }
  })

async function open(phone) {
  const { browser, page } = await launch(report, { phone })
  await assertNubApp(page)
  await page.evaluate((seed) => {
    localStorage.clear()
    localStorage.setItem('maia:notifications:v1', JSON.stringify(seed))
  }, SEED)
  await page.reload()
  if (phone) await page.getByRole('button', { name: 'Preview without linking' }).click({ timeout: 20000 })
  else await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(600)
  const bell = page.locator('[data-testid="notifications-bell"]:visible').first()
  return { browser, page, bell }
}
/** The bell's accessible name, as a screen reader gets it (the label wins over text). */
const nameOf = async (bell) => (await bell.ariaSnapshot()).match(/button "([^"]*)"/)?.[1] ?? '(no name)'

for (const [label, phone, withInfo] of [['Desktop', false, false], ['Desktop with Agent info open', false, true], ['Phone', true, false]]) {
  const { browser, page, bell } = await open(phone)
  if (withInfo) {
    await page.getByRole('button', { name: 'Info', exact: true }).click()
    await page.locator('[data-side-panel="info"]').waitFor({ timeout: 5000 })
  }
  if (!withInfo) {
    await step(`${label}: the bell's name says 2 unread`, async () => {
      const badge = (await page.locator('[data-testid="notifications-unread-dot"]:visible').first().innerText()).trim()
      const n = await nameOf(bell)
      return { ok: /2 unread/.test(n) && badge === '2', detail: `badge shows ${badge}; name ${JSON.stringify(n)}` }
    })
  }
  await step(`${label}: the open list is on top, not under the chat`, async () => {
    await bell.click()
    await page.waitForTimeout(500)
    if (!withInfo) await shot(page, `${report.name}-${phone ? 'phone' : 'desktop'}`)
    return listOnTop(page)
  })
  if (!withInfo) {
    await step(`${label}: after Mark all read the name drops the count`, async () => {
      await page.locator('[data-testid="notifications-mark-read"]:visible').first().click({ timeout: 5000 })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      const n = await nameOf(bell)
      return { ok: !/unread/.test(n) && /Notifications/.test(n), detail: `name ${JSON.stringify(n)}` }
    })
  }
  await browser.close()
}

process.exit(finish() ? 0 : 1)
