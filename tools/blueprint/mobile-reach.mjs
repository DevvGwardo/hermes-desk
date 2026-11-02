// Blueprint feature pass 2: the rest of the phone roadmap. Search across
// messages (the desktop palette), chat history, the task board, Marketplace
// routine recipes, routine templates and delivery targets, the Files browser
// with previews, run history output, invite links and keyboard shortcuts —
// all at 390×844 against the offline demo. One check per promise.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/mobile-reach.mjs
import { APP_URL, launch, makeReport, noSideScroll, phoneHome, shot } from './lib.mjs'

const NAME = process.env.BP_NAME ?? 'mobile-reach'
const { report, step, finish } = makeReport(NAME)
const { browser, page } = await launch(report, { phone: true })
const btn = (name) => page.getByRole('button', { name, exact: true })
const dialog = (name) => page.getByRole('dialog', { name })
const settle = (ms = 400) => page.waitForTimeout(ms)
const home = () => page.locator('.nub-conv-row').first()
const atHome = async () => (await home().isVisible()) && (await page.getByRole('dialog').count()) === 0
const backHome = async () => {
  for (let i = 0; i < 6 && !(await atHome()); i++) {
    await page.goBack()
    await settle()
  }
  if (!(await atHome())) throw new Error('could not get back to the home list')
}

await phoneHome(page)
await settle(600)

// ------------------------------------------------------------------ search
await step('Home Search opens the full search', async () => {
  await btn('Search').click()
  await dialog('Search').waitFor({ timeout: 5000 })
})
await step('Search finds a message inside a chat', async () => {
  await dialog('Search').getByRole('combobox', { name: 'Search' }).fill('deploy summary')
  await settle(600)
  const hits = await page.getByRole('option').count()
  return { ok: hits > 0, detail: `${hits} results` }
})
await settle(300)
await shot(page, `${NAME}-01-search`)
await step('Search fits 390px (no sideways scroll)', async () => (await dialog('Search').isVisible()) && noSideScroll(page))
await step('Search hides desktop ⌘ hints on a phone', async () => {
  const shown = await page.locator('[role="listbox"] kbd').evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== 'none').length)
  return { ok: shown === 0, detail: `${shown} visible hints` }
})
await step('Picking a message result opens its chat', async () => {
  const hit = page.getByRole('option').filter({ hasText: /deploy summary/i }).last()
  await hit.click()
  await page.locator('.nub-mobile-chat-bar').waitFor({ timeout: 5000 })
  return { ok: !(await dialog('Search').isVisible()), detail: (await page.locator('.nub-mobile-chat-bar h1').innerText()).trim() }
})
await step('The jump lands the matching message on screen', async () => {
  await settle(1500) // past the thread's settle (cards, pictures)
  const box = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-message-id]')].find((e) => /latest deploy summary/i.test(e.textContent || ''))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight }
  })
  return { ok: Boolean(box && box.top >= 0 && box.bottom <= box.vh), detail: box ? `message at ${box.top}–${box.bottom}px of ${box.vh}px` : 'message not rendered' }
})
await backHome().catch(() => {})

// ---------------------------------------------------------------- keyboard
await step('⌘K opens search (tablet keyboard)', async () => {
  await page.keyboard.press('Meta+k')
  await dialog('Search').waitFor({ timeout: 4000 })
})
await page.keyboard.press('Escape')
await settle()
await step('⌘, opens Settings', async () => {
  await page.keyboard.press('Meta+,')
  await page.locator('.nub-mobile-chat-bar h1', { hasText: 'Settings' }).waitFor({ timeout: 4000 })
})
await backHome().catch(() => {})

// ------------------------------------------------------------ chat history
await step('Home has a Chat history shortcut', () => btn('Chat history').isVisible())
await step('Chat history lists the agent’s conversations', async () => {
  await btn('Chat history').click()
  await dialog('Chat history').waitFor({ timeout: 5000 })
  await dialog('Chat history').getByText('Book a table for Friday').waitFor({ timeout: 5000 })
})
await step('Chat history search narrows the list', async () => {
  await dialog('Chat history').getByRole('searchbox', { name: 'Search chats' }).fill('table')
  await settle(900)
  const deploy = await dialog('Chat history').getByText('Deploy summary for the week').count()
  const table = await dialog('Chat history').getByText('Book a table for Friday').count()
  return { ok: table > 0 && deploy === 0, detail: `table ${table}, deploy ${deploy}` }
})
await shot(page, `${NAME}-02-history`)
await step('Chat history fits 390px (no sideways scroll)', async () => (await dialog('Chat history').isVisible()) && noSideScroll(page))
await backHome().catch(() => {})

// --------------------------------------------------------------- task board
await step('Home has a Tasks shortcut', () => btn('Tasks').isVisible())
await step('Every home shortcut is fully on screen', async () => {
  const boxes = await page.locator('.nub-mobile-shortcut').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [r.left, r.right]))
  const vw = page.viewportSize().width
  const off = boxes.filter(([l, r]) => l < 0 || r > vw).length
  return { ok: boxes.length >= 4 && off === 0, detail: `${boxes.length} shortcuts, ${off} cut off` }
})
await step('Tasks opens the board with the agent’s tasks', async () => {
  await btn('Tasks').click()
  await dialog('Tasks').waitFor({ timeout: 5000 })
  await dialog('Tasks').getByText('Ship the landing page').waitFor({ timeout: 6000 })
})
await step('A task made on the phone lands on the board', async () => {
  await dialog('Tasks').getByRole('button', { name: '+ Task' }).click()
  await dialog('Tasks').getByRole('textbox', { name: 'Task title' }).fill('Check the phone build')
  await dialog('Tasks').getByRole('button', { name: 'Create task' }).click()
  await dialog('Tasks').getByText('Check the phone build').waitFor({ timeout: 6000 })
})
await shot(page, `${NAME}-03-tasks`)
await step('Tasks fits 390px (no sideways scroll)', async () => (await dialog('Tasks').isVisible()) && noSideScroll(page))
await step('Task board stacks its columns on a phone', async () => {
  const lefts = await dialog('Tasks').locator('.rounded-xl.bg-\\[var\\(--ca-primary-soft\\)\\]').evaluateAll((els) =>
    els.filter((e) => getComputedStyle(e).display !== 'none').map((e) => Math.round(e.getBoundingClientRect().left)),
  )
  return { ok: lefts.length >= 2 && new Set(lefts).size === 1, detail: `${lefts.length} visible columns at x=${[...new Set(lefts)].join(',')}` }
})
await backHome().catch(() => {})

// ------------------------------------------------- marketplace → routine
await step('A Marketplace routine recipe opens the editor pre-filled', async () => {
  await btn('Add').click()
  await page.getByTestId('mobile-open-marketplace').click()
  await page.getByRole('button', { name: 'Use Morning briefing' }).first().click({ timeout: 6000 })
  const name = page.getByLabel('Name')
  await name.waitFor({ timeout: 5000 })
  const value = await name.inputValue()
  return { ok: value === 'Morning briefing', detail: `name “${value}”` }
})
await shot(page, `${NAME}-04-recipe`)
await step('The routine editor offers the agent’s delivery targets', async () => {
  const select = page.getByLabel('Send results to')
  await select.waitFor({ timeout: 5000 })
  await page.waitForFunction(() => {
    const s = document.querySelector('select[aria-label="Send results to"]')
    return s && !s.disabled && s.options.length > 1
  }, null, { timeout: 5000 })
  const options = await select.locator('option').allInnerTexts()
  return { ok: options.some((o) => /Telegram/.test(o)), detail: options.join(' · ') }
})
await backHome().catch(() => {})

// ----------------------------------------------------- templates + history
await step('A routine template creates a routine', async () => {
  await btn('Routines').click()
  await page.getByTestId('routines-page').waitFor({ timeout: 5000 })
  await page.locator('[data-routine-id]').nth(1).waitFor({ timeout: 5000 })
  const before = await page.locator('[data-routine-id]').count()
  await btn('New routine').click()
  await page.getByRole('button', { name: 'Start from a template' }).click({ timeout: 5000 })
  await page.getByRole('list', { name: 'Routine templates' }).getByRole('button').filter({ hasText: 'Weekly digest' }).click({ timeout: 6000 })
  await page.getByRole('button', { name: 'Create Routine' }).click({ timeout: 5000 })
  await page.waitForFunction((n) => document.querySelectorAll('[data-routine-id]').length > n, before, { timeout: 6000 })
  return { ok: true, detail: `${before} → ${await page.locator('[data-routine-id]').count()} routines` }
})
await step('Run history shows a run’s output', async () => {
  if (await page.getByRole('dialog').count()) await page.goBack()
  await settle()
  await page.locator('[data-routine-id="demo-morning"] button').first().click({ timeout: 5000 })
  // A routine that has run opens on Results with the newest run's report
  // (the tab was called History before #200).
  const results = page.getByTestId('routine-tab-results').or(page.getByTestId('routine-tab-history'))
  if (await results.count()) await results.first().click({ timeout: 5000 })
  await page.getByText('Two deploys finished, both healthy.').first().waitFor({ timeout: 6000 })
})
await shot(page, `${NAME}-05-run-output`)
await backHome().catch(() => {})

// ------------------------------------------------------------------ files
const filesPanel = () => page.locator('aside', { hasText: 'Everything you and your agent saved' })
await step('Files lists the agent’s workspace', async () => {
  await btn('Files').click()
  await filesPanel().waitFor({ timeout: 5000 })
  await filesPanel().getByText('README', { exact: true }).waitFor({ timeout: 5000 })
})
await step('A file opens in the preview', async () => {
  await filesPanel().getByText('README', { exact: true }).click()
  await page.getByText('Files your agent made live here.').waitFor({ timeout: 6000 })
})
await shot(page, `${NAME}-06-file-preview`)
await backHome().catch(() => {})

// ------------------------------------------------------------- invite link
await step('An invite link opens the invite screen on a phone', async () => {
  await page.goto(`${APP_URL}#/invite/ABCD-2345`)
  await page.getByText(/invite/i).first().waitFor({ timeout: 8000 })
  return { ok: (await page.locator('.nub-conv-row').count()) === 0, detail: 'invite screen, not the chat list' }
})
await settle(800)
await shot(page, `${NAME}-07-invite`)

const ok = finish()
await browser.close()
process.exit(ok ? 0 : 1)
