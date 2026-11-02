// Supported shell shortcuts in a disposable, unfocused Electron app.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const developmentReact = process.argv.includes('--development-react')
const coldDialogs = process.argv.includes('--cold-dialogs')
const skinOrder = process.argv.includes('--classic-first') ? ['classic', 'messenger'] : ['messenger', 'classic']
const out = path.join(artifacts, `modal-keyboard-layers-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { developmentReact, coldDialogs, skinOrder, reducedMotion: true, checks: [], paintOrder: [], pageErrors: [], renderLoopWarnings: 0, failure: null }
let h
let releaseColdChunk = () => {}
process.once('SIGTERM', async () => { releaseColdChunk(); await h?.close(); process.exit(143) })
const painted = element => {
  const rect = element.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth &&
    rect.top >= 0 && rect.bottom <= innerHeight && element.contains(hit)
}

try {
  h = await launchHarness({ developmentReact })
  await h.page.emulateMedia({ reducedMotion: 'reduce' })
  h.page.on('console', message => {
    if (/Maximum update depth|getSnapshot should be cached|Minified React error #185/i.test(message.text())) report.renderLoopWarnings++
  })
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  const welcome = h.page.getByRole('dialog', { name: 'Welcome to Hermes Desk', exact: true })
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Start using Hermes Desk', exact: true }).click()
    await welcome.waitFor({ state: 'hidden' })
  }
  await h.send('alpha', 'chat', 'keyboard-layer-fixture')
  await h.page.getByText('Local-only and deterministic.', { exact: false }).first().waitFor()
  await waitFor(async () => (await h.app.evaluate(() =>
    globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'fixture turn complete')
  const setup = h.page.getByRole('button', { name: 'Got it', exact: true })
  if (await setup.isVisible()) await setup.click()
  const settings = h.page.getByRole('dialog', { name: 'Settings', exact: true })
  const search = h.page.getByRole('dialog', { name: 'Search', exact: true })
  const settingsField = settings.getByRole('textbox', { name: 'Search settings', exact: true })
  const searchInput = search.getByRole('combobox', { name: 'Search', exact: true })
  if (!coldDialogs) {
    // Batch 11 isolates keyboard ownership from shared-Suspense cold loading.
    await h.page.keyboard.press('Meta+k')
    await search.waitFor()
    await waitFor(async () => await searchInput.evaluate(element => document.activeElement === element), 'initial Search focus')
    await h.page.keyboard.press('Escape')
    await search.waitFor({ state: 'hidden' })
  }
  report.dialogChunksPreloaded = !coldDialogs
  let coldChunkHeld = false
  if (coldDialogs) {
    const pendingChunk = new Promise(resolve => { releaseColdChunk = resolve })
    await h.page.route(/\/assets\/CommandPalette-[^/]+\.js$/, async route => {
      coldChunkHeld = true
      report.delayedRendererChunk = path.basename(new URL(route.request().url()).pathname)
      await pendingChunk
      await route.continue()
    })
  }

  for (const skinName of skinOrder) {
    await h.page.keyboard.press('Meta+,')
    await settings.waitFor()
    await settings.getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Appearance', exact: true }).click()
    const skin = settings.getByRole('switch', { name: 'Messenger skin', exact: true })
    const expected = String(skinName === 'messenger')
    if (await skin.getAttribute('aria-checked') !== expected) await skin.click()
    await waitFor(async () => await skin.getAttribute('aria-checked') === expected && await skin.isEnabled(),
      `acknowledged ${skinName} skin`)
    await h.page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    for (const viewport of [{ width: 960, height: 640 }, { width: 1440, height: 900 }]) {
      await h.app.evaluate(({ BrowserWindow }, size) => {
        const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
        main.setSize(size.width, size.height)
      }, viewport)
      const label = `${skinName}-${viewport.width}x${viewport.height}`
      report.step = { skinName, viewport, flow: 'Search over Settings' }
      await h.page.keyboard.press('Meta+,')
      await settings.waitFor()
      await settingsField.fill('privacy')
      await h.page.keyboard.press('Meta+k')
      if (coldDialogs && !report.coldChunkReleased) {
        await waitFor(() => coldChunkHeld, 'actual original cold Search chunk request')
        await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        assert(await settingsField.evaluate(painted), 'Open Settings must remain painted and interactive while the new chunk waits')
        assert(await settingsField.evaluate(element => document.activeElement === element), 'Cold Search loading must retain existing Settings focus')
        assert.equal(await settingsField.inputValue(), 'privacy')
        report.checks.push('Actual held cold Search chunk preserves existing Settings paint, focus and query')
        releaseColdChunk()
        report.coldChunkReleased = true
      }
      await search.waitFor()
      await waitFor(async () => await searchInput.evaluate(element => document.activeElement === element), 'foreground Search focus')
      assert(await searchInput.evaluate(painted), 'Foreground Search input must be painted and hit-testable')
      await writeFile(path.join(out, `${label}-search.png`), await h.page.screenshot())
      await h.page.keyboard.press('Escape')
      await search.waitFor({ state: 'hidden' })
      assert(await settings.isVisible(), 'Search Escape must retain the underlying Settings')
      assert.equal(await settingsField.inputValue(), 'privacy')
      assert(await settingsField.evaluate(element => document.activeElement === element), 'Search Escape must restore Settings focus')
      report.checks.push(`${label}: Search Escape preserves Settings query and restores its focus`)

      await h.page.keyboard.press('Meta+k')
      await search.waitFor()
      await waitFor(async () => await searchInput.evaluate(element => document.activeElement === element), 'reopened Search focus')
      await h.page.keyboard.press('Tab')
      assert(await search.getByRole('tab', { name: 'All', exact: true })
        .evaluate(element => document.activeElement === element), 'Tab from Search must not jump to background Settings')
      const lastTab = search.getByRole('tab', { name: 'Actions', exact: true })
      await lastTab.focus()
      await h.page.keyboard.press('Tab')
      assert(await searchInput.evaluate(element => document.activeElement === element), 'Search forward wrap must stay in Search')
      await h.page.keyboard.press('Shift+Tab')
      assert(await lastTab.evaluate(element => document.activeElement === element), 'Search backward wrap must stay in Search')
      report.checks.push(`${label}: ordinary Tab and both boundary wraps stay in Search`)
      await h.page.keyboard.press('Escape')
      await search.waitFor({ state: 'hidden' })
      await settingsField.focus()
      await h.page.keyboard.press('Escape')
      assert.equal(await settingsField.inputValue(), '')
      assert(await settings.isVisible())
      await h.page.keyboard.press('Escape')
      await settings.waitFor({ state: 'hidden' })
      report.checks.push(`${label}: Settings clears its inner search before a later Escape closes it`)

      report.step.flow = 'Settings over Search'
      await h.page.keyboard.press('Meta+k')
      await search.waitFor()
      await waitFor(async () => await searchInput.evaluate(element => document.activeElement === element), 'Search focus before Settings')
      await h.page.keyboard.press('Meta+,')
      await settings.waitFor()
      assert(await settingsField.evaluate(painted), 'Foreground Settings input must be painted and hit-testable')
      assert(await search.evaluate(element => Boolean(element.closest('[inert]'))), 'Background Search must remain inert')
      const order = await settings.evaluate(element => ({
        foregroundZ: Number(getComputedStyle(element.parentElement).zIndex),
        backgroundZ: Number(getComputedStyle(document.querySelector('[role="dialog"][aria-label="Search"]').parentElement).zIndex),
      }))
      report.paintOrder.push({ label, ...order })
      assert(order.foregroundZ > order.backgroundZ, 'Active Settings must paint above the inert Search, not only win hit testing')
      await writeFile(path.join(out, `${label}-settings.png`), await h.page.screenshot())
      await settingsField.focus()
      await h.page.keyboard.press('Escape')
      await settings.waitFor({ state: 'hidden' })
      assert(await search.isVisible(), 'Settings Escape must retain the underlying Search')
      assert(await searchInput.evaluate(element => document.activeElement === element), 'Settings Escape must restore Search focus')
      await h.page.keyboard.press('Escape')
      await search.waitFor({ state: 'hidden' })
      report.checks.push(`${label}: foreground Settings closes alone and restores Search focus`)
    }
  }
  assert.deepEqual(h.consoleErrors, [])
  assert.equal(report.renderLoopWarnings, 0)
  report.checks.push('No renderer page errors or render-loop warnings')
} catch (error) {
  releaseColdChunk()
  report.failure = { message: error.message, stack: error.stack }
  if (h) {
    report.failureContext = await h.page.evaluate(() => ({
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(element => ({
        name: element.getAttribute('aria-label'), inert: Boolean(element.closest('[inert]')),
      })),
      focusedDialog: document.activeElement?.closest('[role="dialog"]')?.getAttribute('aria-label') ?? null,
      focusedLabel: document.activeElement?.getAttribute('aria-label') ?? null,
    }))
    await writeFile(path.join(out, 'failure.png'), await h.page.screenshot())
  }
  process.exitCode = 1
} finally {
  releaseColdChunk()
  if (h) {
    report.pageErrors = h.consoleErrors
    if (coldDialogs) await h.page.unrouteAll({ behavior: 'wait' })
    await h.close()
  }
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ out, ...report }, null, 2))
}
