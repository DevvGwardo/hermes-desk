// Blueprint check: touch targets on the phone's Routines screen, Files
// panel (buttons and tabs) and the chat's file cards. Each control must answer a tap anywhere
// in a 44 × 44px square around its centre (hit-tested with elementFromPoint,
// so an invisible hit area counts, as it does for a finger), and the
// controls must still work when tapped near that edge.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/phone-touch.mjs
import { launch, makeReport, phoneHome, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'phone-touch')
const { browser, page } = await launch(report, { phone: true })
const btn = (name) => page.getByRole('button', { name, exact: true })

/** Sample the four edge midpoints of a 44px square around the control. */
async function hitArea(locator) {
  const handle = await locator.elementHandle({ timeout: 5000 })
  return page.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const pts = [[cx - 21, cy], [cx + 21, cy], [cx, cy - 21], [cx, cy + 21]]
    const missed = pts.filter(([x, y]) => !el.contains(document.elementFromPoint(x, y))).length
    return { ok: missed === 0, detail: `drawn ${Math.round(r.width)}×${Math.round(r.height)}px, ${4 - missed}/4 edge taps land` }
  }, handle)
}

await phoneHome(page)
await btn('Routines').click()
const firstRow = page.locator('[data-routine-id]').first()
await firstRow.waitFor({ timeout: 6000 })
await page.waitForTimeout(800)

await step('Routines: “New routine” is at least 44px tall', async () => {
  const box = await btn('New routine').boundingBox()
  return { ok: Boolean(box && box.height >= 44), detail: box ? `${Math.round(box.height)}px tall` : 'not found' }
})
await step('Routines: “Run now” answers taps across 44 × 44px', () => hitArea(firstRow.getByRole('button', { name: /^Run .* now$/ })))
await step('Routines: the pause switch answers taps across 44 × 44px', () => hitArea(firstRow.getByRole('switch')))
await step('Routines: the switch still looks like a switch (36 × 20px track)', async () => {
  const box = await firstRow.getByRole('switch').boundingBox()
  return { ok: Boolean(box && Math.round(box.width) === 36 && Math.round(box.height) === 20), detail: box ? `${Math.round(box.width)}×${Math.round(box.height)}px` : 'not found' }
})
await step('Routines: a tap 18px above the switch’s centre toggles it', async () => {
  const sw = firstRow.getByRole('switch')
  const before = await sw.getAttribute('aria-checked')
  const box = await sw.boundingBox()
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2 - 18)
  await page.waitForTimeout(800)
  const after = await sw.getAttribute('aria-checked')
  if (after !== before) await sw.click() // put it back
  return { ok: after !== before, detail: `aria-checked ${before} → ${after}` }
})
await shot(page, `${report.name}-01-routines`)
await page.goBack()
await page.waitForTimeout(600)

await btn('Files').click()
const closeFiles = page.getByRole('button', { name: 'Close files' })
await closeFiles.waitFor({ timeout: 5000 })
await page.waitForTimeout(800)
await step('Files: Refresh answers taps across 44 × 44px', () => hitArea(page.getByRole('button', { name: 'Refresh files' })))
await step('Files: Close answers taps across 44 × 44px', () => hitArea(closeFiles))
await step('Files: every tab is at least 44px tall', async () => {
  const boxes = await Promise.all(['All', 'Photos', 'Docs', 'Sites'].map((n) => page.getByRole('tab', { name: n }).boundingBox()))
  const min = Math.min(...boxes.map((b) => (b ? b.height : 0)))
  return { ok: min >= 44, detail: `shortest ${Math.round(min)}px` }
})
await step('Files: the tabs still switch', async () => {
  await page.getByRole('tab', { name: 'Docs' }).click()
  const on = await page.getByRole('tab', { name: 'Docs' }).getAttribute('aria-selected')
  await page.getByRole('tab', { name: 'All' }).click()
  return { ok: on === 'true', detail: `Docs aria-selected=${on}` }
})
await shot(page, `${report.name}-02-files`)
await step('Files: a tap 18px below Close’s centre closes Files', async () => {
  const box = await closeFiles.boundingBox()
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2 + 18)
  await page.waitForTimeout(800)
  const open = await closeFiles.isVisible()
  return { ok: !open, detail: open ? 'Files still open' : 'Files closed' }
})

// Chat: the file card under an agent reply (View pill + Download button).
await phoneHome(page)
await page.locator('.nub-conv-row', { hasText: 'Research Alpha' }).click()
const card = page.locator('[data-file-card]').first()
await card.waitFor({ timeout: 8000 })
await card.scrollIntoViewIfNeeded()
await page.waitForTimeout(800)
await step('Chat: a file card’s View answers taps across 44 × 44px', () => hitArea(card.getByRole('button', { name: /^View / })))
await step('Chat: a file card’s Download answers taps across 44 × 44px', () => hitArea(card.getByRole('button', { name: /^Download / })))
await shot(page, `${report.name}-03-chat-file-card`)
await step('Chat: the “from <agent>” chip is at least 24px tall (WCAG 2.5.8)', async () => {
  const chip = page.locator('.nub-agent-chip').first()
  if (!(await chip.count())) return { ok: false, detail: 'no agent chip in this chat' }
  await chip.scrollIntoViewIfNeeded()
  const box = await chip.boundingBox()
  const h = Math.round(box?.height ?? 0)
  return { ok: h >= 24, detail: `${h}px tall, ${Math.round(box?.width ?? 0)}px wide` }
})
await step('Chat: View still opens the file', async () => {
  await card.getByRole('button', { name: /^View / }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ timeout: 6000 })
  return { ok: true, detail: 'preview opened' }
})

await browser.close()
process.exit(finish() ? 0 : 1)
