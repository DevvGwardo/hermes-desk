#!/usr/bin/env node
/** Tier-1 electron smokes: drive the REAL app window through gates G1–G4.
 *  Usage: node eval/run-electron-smokes.mjs [--mode=dev|packaged]  (default dev) */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, ROOT } from './lib/electron-app.mjs'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'electron')
fs.mkdirSync(OUT, { recursive: true })

const fail = []
function ok(cond, msg) {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`)
  if (!cond) fail.push(msg)
  return cond
}

const modeArg = process.argv.find((a) => a.startsWith('--mode='))
const mode = modeArg ? modeArg.split('=')[1] : 'dev'
if (mode !== 'dev' && mode !== 'packaged') {
  console.error(`unknown --mode=${mode} (expected dev|packaged)`)
  process.exit(2)
}
console.log(`electron smokes — mode: ${mode}\n`)

const h = await launchApp({ mode })
const gateResults = {}

try {
  const page = h.getPage()

  /* ── G1: boot reaches interactive state with zero uncaught pageerrors ── */
  try {
    await h.waitForAppReady(page)
    await page.screenshot({ path: path.join(OUT, '01-boot.png') })
    const errs = h.collectedErrors()
    const pageErrs = errs.filter((e) => e.kind === 'pageerror')
    // Local Hermes serve (127.0.0.1:<port>) is usually not running during evals;
    // the app degrades to offline banners by design, so refused connections to
    // localhost are tolerated here. Any other console error still fails G1.
    const consoleErrs = errs.filter(
      (e) => e.kind === 'console-error' && !/net::ERR_CONNECTION_REFUSED/.test(e.text)
    )
    const connRefused = errs.filter(
      (e) => e.kind === 'console-error' && /net::ERR_CONNECTION_REFUSED/.test(e.text)
    )
    ok(true, 'window opened, renderer reached interactive state')
    for (const e of consoleErrs.slice(0, 5)) console.log(`      console error: ${e.text.split('\n')[0]}`)
    if (connRefused.length) console.log(`      (tolerated ${connRefused.length} offline-backend connection errors)`)
    ok(pageErrs.length === 0, `zero uncaught pageerrors during boot (${pageErrs.length})`)
    ok(consoleErrs.length === 0, `zero renderer console errors during boot (${consoleErrs.length})`)
    gateResults.G1 = pageErrs.length === 0 && consoleErrs.length === 0
  } catch (err) {
    console.log(`  ✗ G1 boot: ${String(err?.message || err).split('\n')[0]}`)
    fail.push('G1 boot failed')
    gateResults.G1 = false
  }

  /* ── G2: sidebar + ⌘K command palette opens/closes ── */
  try {
    let g2 = true
    const searchBtn = page.getByRole('button', { name: 'Search' }).first()
    g2 = ok(await searchBtn.count() > 0 && (await searchBtn.isVisible()), 'sidebar renders with Search button') && g2

    await page.keyboard.press('Meta+k')
    await page.waitForTimeout(300)
    const dialog = page.getByRole('dialog', { name: 'Search' })
    g2 = ok(await dialog.isVisible(), '⌘K opens the command palette') && g2
    await page.screenshot({ path: path.join(OUT, '02-command-palette.png') })

    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    const closedByEscape = !(await dialog.isVisible().catch(() => false))
    g2 = ok(closedByEscape, 'Escape closes the palette') && g2
    gateResults.G2 = g2
  } catch (err) {
    console.log(`  ✗ G2 palette: ${String(err?.stack || err).split('\n')[0]}`)
    fail.push('G2 palette failed')
    gateResults.G2 = false
  }

  /* ── G3: Settings version label matches package.json ── */
  try {
    await page.getByRole('button', { name: 'Settings' }).first().click()
    const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
    await settingsDialog.waitFor({ state: 'visible', timeout: 8000 })

    // Version label arrives via IPC after maia:updateCheck (network fetch in
    // main can take up to its 8s timeout), so allow a generous wait.
    const versionLabel = settingsDialog.getByText(/^Version\s+\S/).first()
    await versionLabel.waitFor({ state: 'visible', timeout: 12000 })
    const labelText = ((await versionLabel.textContent()) || '').trim()
    const shown = labelText.match(/^Version\s+(\S+)/)?.[1]
    const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
    ok(shown === expected, `settings version label matches package.json (shown=${shown}, expected=${expected})`)

    await page.screenshot({ path: path.join(OUT, '03-settings.png') })
    await settingsDialog.getByRole('button', { name: 'Close' }).click()
    await page.waitForTimeout(300)
    ok(!(await settingsDialog.isVisible().catch(() => false)), 'Settings closes via Close button')
    gateResults.G3 = shown === expected
  } catch (err) {
    console.log(`  ✗ G3 settings: ${String(err?.stack || err).split('\n')[0]}`)
    fail.push('G3 settings failed')
    gateResults.G3 = false
  }

  /* ── G4: chat composer accepts typed text ── */
  try {
    const composer = page.locator('textarea[placeholder^="Message"]').first()
    await composer.waitFor({ state: 'visible', timeout: 8000 })
    await composer.click()
    await composer.fill('eval smoke')
    await page.waitForTimeout(200)
    const value = await composer.inputValue()
    ok(value === 'eval smoke', `composer accepts typed text (value=${JSON.stringify(value)})`)
    await page.screenshot({ path: path.join(OUT, '04-composer.png') })
    gateResults.G4 = value === 'eval smoke'
  } catch (err) {
    console.log(`  ✗ G4 composer: ${String(err?.stack || err).split('\n')[0]}`)
    fail.push('G4 composer failed')
    gateResults.G4 = false
  }
} catch (err) {
  fail.push(String(err?.stack || err))
  console.error(err)
  try {
    const page = h.getPage()
    await page.screenshot({ path: path.join(OUT, 'error.png') })
  } catch {}
} finally {
  await h.close()
}

console.log(`\nsummary:`)
for (const g of ['G1', 'G2', 'G3', 'G4']) {
  console.log(`  ${g}: ${gateResults[g] ? 'PASS' : 'FAIL'}`)
}
console.log(`shots: ${OUT}`)
if (fail.length || Object.values(gateResults).some((v) => v === undefined)) {
  console.error(`FAILED ${fail.length}`)
  process.exit(1)
}
console.log('OK')
