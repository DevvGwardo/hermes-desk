/* Verify the create-agent → editor flow (Grok parity):
 * 1. Click "+ New agent" in sidebar → AgentEditor modal appears
 * 2. Fill name + pick a shape/color → live preview updates
 * 3. Create → agent + first conversation exist, editor closed
 */
import { chromium } from 'playwright-core'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173/'
const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.nub-root', { timeout: 10000 })

// 1. Open the editor from the sidebar "+ New agent" button
const newAgentBtn = page.locator('button', { hasText: '+ New agent' }).first()
await newAgentBtn.click()
await page.waitForSelector('[role="dialog"][aria-label="Create agent"]', { timeout: 5000 })
check('editor opens from "+ New agent"', true)

// 2. Type a name → Create button enables
await page.fill('input[placeholder="Bob"]', 'Eddy')
const createBtn = page.locator('button', { hasText: 'Create agent' })
check('Create button enabled after name', await createBtn.isEnabled())

// 3. Pick a shape + color; preview should reflect the chosen color
await page.locator('[role="dialog"] button[title="hex"]').click()
await page.locator('[role="dialog"] button[title="#c8f542"]').click()
const previewFg = await page
  .locator('[role="dialog"] svg')
  .first()
  .evaluate((svg) => {
    const parent = svg.parentElement
    return parent ? getComputedStyle(parent).getPropertyValue('--fg').trim() : ''
  })
check('preview mascot reflects chosen color', previewFg === '#c8f542', `fg=${previewFg}`)

// 4. Cancel closes WITHOUT creating an agent
await page.locator('[role="dialog"] button', { hasText: 'Cancel' }).click()
await page.waitForSelector('[role="dialog"][aria-label="Create agent"]', { state: 'detached', timeout: 3000 })
const noEddy = await page.evaluate(() => !document.body.innerText.includes('Eddy'))
check('Cancel closes editor, no agent created', noEddy)

// 5. Reopen, fill, Create → agent + conversation appear, editor closes
await newAgentBtn.click()
await page.fill('input[placeholder="Bob"]', 'Eddy')
await createBtn.click()
await page.waitForSelector('[role="dialog"][aria-label="Create agent"]', { state: 'detached', timeout: 5000 })
await page.waitForFunction(() => document.body.innerText.includes('Eddy'), { timeout: 5000 })
const editorClosed = (await page.locator('[role="dialog"][aria-label="Create agent"]').count()) === 0
check('Create closes editor and agent appears in sidebar', editorClosed)

// 6. Conversation opened for the new agent (TopBar title)
const topTitle = await page.locator('header h1').innerText()
check('conversation opened for new agent', topTitle === 'Eddy', `title=${topTitle}`)

// 7. Picker "create <name>" row → editor opens prefilled with the typed name
await page.locator('button[title="New conversation"]').first().click()
await page.waitForSelector('input[placeholder="Search or create Bots"]', { timeout: 5000 })
await page.fill('input[placeholder="Search or create Bots"]', 'Zed Bot')
await page.waitForFunction(() => document.body.innerText.includes('Create "Zed Bot"'), { timeout: 3000 })
await page.locator('button', { hasText: 'Create "Zed Bot"' }).click()
await page.waitForSelector('[role="dialog"][aria-label="Create agent"]', { timeout: 5000 })
const prefilled = await page.inputValue('input[placeholder="Bob"]')
check('picker create row prefills editor name', prefilled === 'Zed Bot', `prefilled=${prefilled}`)
await page.locator('[role="dialog"] button', { hasText: 'Cancel' }).click()
await page.waitForSelector('[role="dialog"][aria-label="Create agent"]', { state: 'detached', timeout: 3000 })

check('zero page errors', errors.length === 0, errors.join(' | '))
await browser.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
