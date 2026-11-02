// Blueprint feature pass: mobile parity. The phone shell (src/mobile/MobileApp.tsx)
// at 390×844 must reach what the desktop-width web shell offers: Routines,
// deep links, the full Settings panes, notifications, find in chat, files,
// hidden chats and Agent info's routine links. One check per promise.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/mobile-parity.mjs          (APP_URL / BP_OUT override)
import { launch, makeReport, noSideScroll, phoneHome, shot } from './lib.mjs'

const NAME = process.env.BP_NAME ?? 'mobile-parity'
const { report, check, step, finish } = makeReport(NAME)
const { browser, page } = await launch(report, { phone: true })
const btn = (name) => page.getByRole('button', { name, exact: true })
const settle = (ms = 400) => page.waitForTimeout(ms)
const routinesPage = () => page.getByTestId('routines-page')
const home = () => page.locator('.nub-conv-row').first()
const atHome = async () =>
  (await home().isVisible()) && (await page.getByRole('dialog').count()) === 0
const backHome = async () => {
  // The phone shell mirrors its layers (screens and sheets) into browser
  // history: Back is the same path as the iOS swipe and the Android key.
  for (let i = 0; i < 6 && !(await atHome()); i++) {
    await page.goBack()
    await settle()
  }
  if (!(await atHome())) throw new Error('could not get back to the home list')
}

const t0 = Date.now()
await phoneHome(page)
report.perf.homeReadyMs = Date.now() - t0
await settle(600)
await shot(page, `${NAME}-01-home`)

// ------------------------------------------------------------------ home
await step('Home lists the demo conversations', async () => {
  const n = await page.locator('.nub-conv-row').count()
  return { ok: n >= 3, detail: `${n} rows` }
})
await step('Home has a notifications bell', () => page.getByRole('button', { name: /^Notifications/ }).first().isVisible())
await step('Home has a Routines shortcut', () => btn('Routines').isVisible())
await step('Home has a Files shortcut', () => btn('Files').isVisible())
await step('Home fits 390px (no sideways scroll)', () => noSideScroll(page))

// --------------------------------------------------------------- routines
await step('Routines opens full screen from home', async () => {
  await btn('Routines').click({ timeout: 3000 })
  await routinesPage().waitFor({ timeout: 6000 })
})
await settle(800)
await shot(page, `${NAME}-02-routines`)
await step('Routines back link is a 44px touch target', async () => {
  const box = await btn('Back').boundingBox()
  return { ok: Boolean(box && box.height >= 44), detail: box ? `${Math.round(box.height)}px tall` : 'missing' }
})
await step('Routines lists the agent’s routines', async () => {
  const n = await page.locator('[data-routine-id]').count()
  return { ok: n >= 2, detail: `${n} routines` }
})
await step('The switch pauses a routine in place', async () => {
  await page.getByRole('switch', { name: 'Pause Morning briefing' }).click({ timeout: 3000 })
  await page.getByRole('switch', { name: 'Resume Morning briefing' }).waitFor({ timeout: 6000 })
})
await step('Routines fits 390px (no sideways scroll)', async () => (await routinesPage().isVisible()) && noSideScroll(page))
await step('New routine opens the editor', async () => {
  await btn('New routine').click({ timeout: 3000 })
  await page.getByLabel('Instruction').waitFor({ timeout: 6000 })
})
await settle(500)
await shot(page, `${NAME}-03-routine-editor`)
await step('A routine made on the phone lands in the list', async () => {
  await page.getByLabel('Name').fill('Phone check-in')
  await page.getByLabel('Instruction').fill('Tell me what changed since this morning.')
  await page.getByRole('button', { name: 'Create Routine' }).click({ timeout: 3000 })
  await routinesPage().getByText('Phone check-in').waitFor({ timeout: 6000 })
})
await step('Back from Routines returns home', async () => {
  if (!(await routinesPage().isVisible())) return { ok: false, detail: 'Routines was never open' }
  await page.goBack()
  await home().waitFor({ timeout: 4000 })
  return !(await routinesPage().isVisible())
})

// ------------------------------------------------------------- deep links
await step('#/routines opens Routines', async () => {
  await page.evaluate(() => { location.hash = '#/routines' })
  await routinesPage().waitFor({ timeout: 5000 })
})
await backHome().catch(() => {})
await step('#/c/<id> opens that conversation', async () => {
  await page.evaluate(() => { location.hash = '#/c/conv_ops_ready' })
  await page.locator('.nub-mobile-chat-bar h1', { hasText: 'Ops Runner' }).waitFor({ timeout: 5000 })
})
await backHome().catch(() => {})
await step('#/?settings=1&pane=connections opens Settings at Chat apps', async () => {
  await page.evaluate(() => { location.hash = '#/?settings=1&pane=connections' })
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.waitFor({ timeout: 5000 })
  const tab = dialog.getByRole('button', { name: 'Chat apps', exact: true })
  return { ok: (await tab.getAttribute('aria-current')) === 'page', detail: 'Chat apps tab is current' }
})
await settle(600)
await shot(page, `${NAME}-04-settings-connections`)
await step('Settings tabs fit 390px (no sideways scroll)', async () => (await page.getByRole('dialog', { name: 'Settings' }).isVisible()) && noSideScroll(page))
await backHome().catch(() => {})

// --------------------------------------------------------------- settings
await step('Settings lists Plan & usage, Chat apps, Skills, Safety and Help', async () => {
  await btn('Settings').click({ timeout: 3000 })
  for (const name of ['Plan & usage', 'Chat apps', 'Skills', 'Safety', 'Help']) {
    await btn(name).waitFor({ timeout: 4000 })
  }
})
await step('Settings links are full-width rows ≥48px', async () => {
  const boxes = await Promise.all(['Plan & usage', 'Chat apps', 'Skills', 'Safety', 'Help'].map((n) => btn(n).boundingBox()))
  const min = Math.min(...boxes.map((b) => (b ? b.height : 0)))
  const wide = boxes.every((b) => b && b.width >= 300)
  return { ok: min >= 48 && wide, detail: `shortest ${Math.round(min)}px, all ≥300px wide: ${wide}` }
})
await shot(page, `${NAME}-05-settings`)
await step('Safety opens the full Safety pane', async () => {
  await btn('Safety').click({ timeout: 3000 })
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.waitFor({ timeout: 5000 })
  return (await dialog.getByRole('button', { name: 'Safety', exact: true }).getAttribute('aria-current')) === 'page'
})
await backHome().catch(() => {})
await step('“See usage” requests land on Plan & usage', async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('nub:open-settings', { detail: { pane: 'usage' } })))
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.waitFor({ timeout: 5000 })
  return (await dialog.getByRole('button', { name: 'Plan & usage', exact: true }).getAttribute('aria-current')) === 'page'
})
await backHome().catch(() => {})

// ------------------------------------------------------------------- chat
await step('Opening a conversation shows the chat', async () => {
  await page.locator('.nub-conv-row', { hasText: 'Research Alpha' }).click()
  await page.locator('.nub-mobile-chat-bar').waitFor({ timeout: 5000 })
})
await settle(800)
await shot(page, `${NAME}-06-chat`)
await step('Chat header opens Find in chat', async () => {
  await btn('Find in chat').click({ timeout: 3000 })
  await page.getByRole('textbox', { name: 'Find in chat' }).waitFor({ timeout: 4000 })
})
await step('Find in chat matches text in the thread', async () => {
  await page.getByRole('textbox', { name: 'Find in chat' }).fill('deploy')
  await settle(500)
  const counter = (await page.getByTestId('find-count').innerText()).trim()
  const hits = counter.match(/^(\d+)\/(\d+)$/)
  return { ok: Boolean(hits && Number(hits[2]) > 0), detail: `${counter || 'empty'} matches` }
})
await step('Find closes with “Done” on a phone (no Esc key)', async () => {
  const label = (await page.getByRole('button', { name: 'Close find' }).innerText()).trim()
  return { ok: label === 'Done', detail: `reads “${label}”` }
})
await shot(page, `${NAME}-07-find`)
await page.keyboard.press('Escape')
await step('Chat header opens the Files browser', async () => {
  await btn('Files').click({ timeout: 3000 })
  // FilesPanel is a side panel (full screen on a phone).
  await page.locator('aside', { hasText: 'Everything you and your agent saved' }).waitFor({ timeout: 5000 })
})
await shot(page, `${NAME}-08-files`)
await page.goBack()
await settle()
await step('Chat fits 390px (no sideways scroll)', async () => (await page.locator('.nub-mobile-chat-bar').isVisible()) && noSideScroll(page))
await step('Agent info links to Routines', async () => {
  await page.getByRole('button', { name: 'Agent info' }).click({ timeout: 3000 })
  await page.getByTestId('agent-routines').getByRole('button', { name: 'Manage' }).click({ timeout: 5000 })
  await routinesPage().waitFor({ timeout: 5000 })
})
await backHome().catch(() => {})

// ----------------------------------------------------------- hidden chats
await step('A hidden chat can be brought back from home', async () => {
  await page.locator('.nub-conv-row', { hasText: 'Ops Runner' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Hide/ }).click({ timeout: 4000 })
  await settle()
  if (await page.locator('.nub-conv-row', { hasText: 'Ops Runner' }).count()) return { ok: false, detail: 'row still listed after Hide' }
  await page.getByRole('button', { name: /^Hidden chats/ }).click({ timeout: 4000 })
  await page.getByRole('dialog', { name: 'Hidden chats' }).getByRole('button', { name: /^Show/ }).first().click({ timeout: 4000 })
  await settle()
  await page.keyboard.press('Escape')
  await page.locator('.nub-conv-row', { hasText: 'Ops Runner' }).waitFor({ timeout: 4000 })
})

await shot(page, `${NAME}-09-home-after`)
const ok = finish()
await browser.close()
process.exit(ok ? 0 : 1)
