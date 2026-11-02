// Real-app proof for the Home page: isolated Electron + Hermes + fake model.
// A bare launch opens Home (compact Pip, recent activity, no sidebar); every way
// out returns the full shell; activity from a real chat shows up when Home reopens.
// Usage: node tests/e2e/home-page.mjs   (artifacts: tests/e2e/artifacts/home/)
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

const out = path.join(artifacts, 'home')
await mkdir(out, { recursive: true })
delete process.env.HERMES_DESK_E2E_VISIBLE
const h = await launchHarness({ home: true })
const report = { checks: {}, errors: [] }
const check = (name, ok, detail) => { report.checks[name] = { ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) } }
async function shot(name) {
  const image = await h.app.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
    return (await main.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(path.join(out, `${name}.png`), Buffer.from(image, 'base64'))
}
async function dismissWelcome() {
  const skip = h.page.getByRole('button', { name: 'Skip setup' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
}
const layout = () => h.page.evaluate(() => {
  const box = (el) => { const r = el?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null }
  const home = document.querySelector('main[aria-label="Home"]')
  return {
    hash: location.hash, viewport: innerWidth,
    home: box(home), mascot: box(home?.querySelector('.hd-home-mascot [data-character="owl"]')),
    primary: box(home?.querySelector('.hd-home-cta')),
    sidebar: box(document.querySelector('.hd-sidebar')),
    rows: [...document.querySelectorAll('.hd-home-row')].map(row => row.textContent),
  }
})
try {
  const { page } = h
  const home = page.getByRole('main', { name: 'Home' })
  await home.waitFor({ timeout: 45000 })
  // Pip leads with whoever is active once the roster is in; before that the button waits disabled.
  await waitFor(() => page.getByRole('button', { name: 'Start a session' }).isEnabled().catch(() => false), 'roster loaded', 45000)
  await page.waitForTimeout(1500)
  await dismissWelcome()

  // 1. Home makes the next action prominent, with Pip retained as a compact companion.
  const first = await layout()
  check('bare launch routes to #/home', first.hash.startsWith('#/home'), first.hash)
  check('sidebar is hidden on Home', !first.sidebar || first.sidebar.w === 0, first.sidebar)
  check('Pip remains compact and near the top', first.mascot && first.mascot.w >= 72 &&
    first.mascot.w <= 112 && first.mascot.y < 200, first.mascot)
  check('the primary action is above the fold', first.primary && first.primary.y < 320, first.primary)
  await shot('01-home-launch')

  // 2. A fresh session uses the existing picker, then returns to the selected agent's chat.
  await page.getByRole('button', { name: 'Start a session' }).click()
  const picker = page.getByRole('dialog', { name: 'New chat', exact: true })
  await picker.waitFor()
  check('Start a session opens the agent picker', await picker.isVisible())
  await picker.getByRole('button', { name: 'Alpha', exact: true }).click()
  await picker.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  const shell = await layout()
  check('Start a session restores the shell', !shell.home && shell.sidebar?.w > 0, shell)
  await h.send('alpha', 'chat')
  await page.locator('[data-message-id] .ca-bubble[data-side="start"]').first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(800)
  await shot('02-chat')

  // 3. Home reopens from the sidebar with the new activity listed.
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await home.waitFor()
  await waitFor(async () => (await layout()).rows.length > 0, 'home activity row', 15000)
  await page.waitForTimeout(600)
  const back = await layout()
  check('sidebar Home button reopens Home', back.hash.startsWith('#/home') && (!back.sidebar || back.sidebar.w === 0), back.hash)
  check('the chat appears under Recent activity', back.rows.some(text => /Alpha/.test(text)), back.rows)
  await shot('03-home-activity')

  // 3b. History stays out of the way until requested, without losing its heatmap.
  check('activity history starts collapsed', await page.locator('.hd-home-history').getAttribute('open') === null)
  await page.getByText('Activity history', { exact: true }).click()
  const today = await waitFor(() => page.evaluate(() => {
    const d = new Date()
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const cell = document.querySelector(`.hd-heat-cell[data-day="${key}"]`)
    return cell && Number(cell.getAttribute('data-count')) > 0 ? { level: cell.getAttribute('data-level'), count: cell.getAttribute('data-count') } : null
  }), 'today on the heatmap', 10000)
  check('heatmap marks today as active', today && Number(today.level) > 0, today)
  const grid = await page.evaluate(() => {
    const svg = document.querySelector('.hd-heat-grid')
    const card = svg?.closest('.hd-home-card')
    const r = svg?.getBoundingClientRect(), c = card?.getBoundingClientRect()
    return r && c ? { svgRight: r.right, cardRight: c.right, weeks: document.querySelectorAll('.hd-heat-cell').length / 7 } : null
  })
  check('heatmap fits inside its card', grid && grid.svgRight <= grid.cardRight, grid)
  await page.locator('.hd-heat').scrollIntoViewIfNeeded()
  await page.locator('.hd-heat-cell[data-level]:not([data-level="0"])').last().hover()
  await page.waitForTimeout(250)
  check('hovering a day shows its tooltip', /chat/.test(await page.locator('.hd-heat-tip').textContent().catch(() => '')))
  await shot('03b-home-heatmap')

  // 4. A row opens that chat in the full app.
  await page.locator('.hd-home-row').first().click()
  await page.getByRole('textbox', { name: 'Message the agent' }).waitFor()
  const chat = await layout()
  check('activity row opens the chat', chat.hash.startsWith('#/c/') && !chat.home && chat.sidebar?.w > 0, chat.hash)
  check('the reply is still on screen', await page.locator('[data-message-id] .ca-bubble[data-side="start"]').count() > 0)

  // 5. Continue opens that same chat; All conversations genuinely opens the archive.
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await home.waitFor()
  await page.getByRole('button', { name: 'Continue recent chat', exact: true }).click()
  await page.getByRole('textbox', { name: 'Message the agent' }).waitFor()
  check('Continue recent chat opens the exact recent thread', (await layout()).hash === chat.hash)
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await home.waitFor()
  await page.getByRole('button', { name: 'All conversations' }).click()
  await page.getByRole('heading', { name: 'Chats', exact: true }).waitFor()
  const archive = await layout()
  check('All conversations opens Chats in the shell', archive.hash.startsWith('#/chats') && !archive.home && archive.sidebar?.w > 0, archive.hash)

  report.errors = h.consoleErrors
  check('no renderer errors', h.consoleErrors.length === 0, h.consoleErrors.slice(0, 5))
} catch (error) {
  report.failure = String(error.stack ?? error)
  try { await shot('99-failure') } catch { /* best effort */ }
} finally {
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await h.close()
  if (report.failure || Object.values(report.checks).some(c => !c.ok)) process.exitCode = 1
}
