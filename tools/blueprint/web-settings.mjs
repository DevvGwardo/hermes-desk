// Blueprint check: on the desktop-width web app, the Settings tab on screen
// is always the one the URL names (App.tsx promises "the URL always names
// the pane on screen"), including after closing Settings on one tab and
// reopening it, so a reload or a shared link lands on the same tab.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/web-settings.mjs
import { APP_URL, assertNubApp, launch, makeReport, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'web-settings')
const { browser, page } = await launch(report, { phone: false })

const settings = () => page.getByRole('dialog', { name: 'Settings' })
const nav = () => page.getByRole('navigation', { name: 'Settings sections' })
const settle = (ms = 500) => page.waitForTimeout(ms)
const PANES = { general: 'General', usage: 'Plan & usage', connections: 'Chat apps', skills: 'Skills', privacy: 'Safety', help: 'Help' }

/** The tab marked current, and the pane the URL names (General when none). */
async function onScreenVsUrl() {
  const current = await nav().locator('button[aria-current="page"]').first().textContent()
  const hash = await page.evaluate(() => location.hash)
  const pane = new URLSearchParams(hash.split('?')[1] ?? '').get('pane')
  const named = PANES[pane ?? 'general'] ?? pane
  return { current: current?.trim(), named, hash }
}

await assertNubApp(page)
await page.evaluate(() => localStorage.clear())
await page.goto(APP_URL)
await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })

await step('Picking a tab puts it in the URL', async () => {
  await page.keyboard.press('Meta+,')
  await nav().waitFor({ timeout: 5000 })
  await nav().getByRole('button', { name: 'Chat apps', exact: true }).click()
  await settle()
  const s = await onScreenVsUrl()
  return { ok: s.current === 'Chat apps' && s.named === 'Chat apps', detail: `on screen ${s.current}, URL names ${s.named}` }
})

await step('Closing and reopening Settings: the tab on screen is the one the URL names', async () => {
  await settings().getByRole('button', { name: /^Close/ }).first().click()
  await settings().waitFor({ state: 'hidden', timeout: 5000 })
  await settle()
  await page.keyboard.press('Meta+,')
  await nav().waitFor({ timeout: 5000 })
  await settle()
  const s = await onScreenVsUrl()
  return { ok: s.current === s.named, detail: `on screen ${s.current}, URL names ${s.named}` }
})
await shot(page, `${report.name}-01-reopened`)

await step('…and a reload shows that same tab', async () => {
  const before = await onScreenVsUrl()
  await page.reload()
  await nav().waitFor({ timeout: 15000 })
  await settle()
  const after = await onScreenVsUrl()
  return { ok: after.current === before.current, detail: `${before.current} → ${after.current} after reload` }
})

await step('A link to a pane still opens that pane', async () => {
  await page.evaluate(() => { location.hash = '#/?settings=1&pane=privacy' })
  await settle()
  const s = await onScreenVsUrl()
  return { ok: s.current === 'Safety', detail: `on screen ${s.current}` }
})

await browser.close()
process.exit(finish() ? 0 : 1)
