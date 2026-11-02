// Metadata-only settings races in the disposable, unfocused Electron harness.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, repo, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const developmentReact = process.argv.includes('--development-react')
const out = path.join(artifacts, `secrets-lifetime-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { developmentReact, reducedMotion: true, checks: [], pageErrors: [], renderLoopWarnings: 0, failure: null }
let h
process.once('SIGTERM', async () => { await h?.close(); process.exit(143) })
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
  await h.send('alpha', 'chat', 'metadata-fixture')
  await h.page.getByText('Local-only and deterministic.', { exact: false }).first().waitFor()
  await waitFor(async () => (await h.app.evaluate(() =>
    globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'fixture turn complete')
  const setup = h.page.getByRole('button', { name: 'Got it', exact: true })
  if (await setup.isVisible()) await setup.click()
  await h.app.evaluate((_electron, adapterPath) => {
    // Only this owned process's metadata dependency changes. IPC sender gates,
    // native confirmation, credential resolution and clipboard methods stay intact.
    const localRequire = process.getBuiltinModule('module').createRequire(`${process.cwd()}/entry.cjs`)
    const adapter = localRequire(adapterPath)
    const fixture = globalThis.__secretsMetadataFixture = { calls: 0, hold: true, failNext: false, old: [] }
    adapter.metadata = () => {
      fixture.calls++
      if (fixture.hold) return new Promise(resolve => fixture.old.push(resolve))
      if (fixture.failNext) { fixture.failNext = false; throw new Error('Synthetic metadata status failed') }
      return { state: 'ready', vaults: [{ id: 'synthetic-new-vault', name: 'Synthetic current vault' }] }
    }
  }, path.join(repo, 'electron/secrets-op.cjs'))
  await h.page.keyboard.press('Meta+,')
  const dialog = h.page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.waitFor()
  const navigation = dialog.getByRole('navigation', { name: 'Settings sections' })
  await navigation.getByRole('button', { name: 'Privacy & permissions', exact: true }).click()
  const refresh = dialog.getByRole('button', { name: 'Refresh 1Password status', exact: true })
  await waitFor(() => h.app.evaluate(() => globalThis.__secretsMetadataFixture.calls >= 1), 'held initial metadata reads')
  await refresh.scrollIntoViewIfNeeded()
  assert(await refresh.evaluate(painted), 'Messenger Refresh must be painted and hit-testable')
  report.initialMetadataReads = await h.app.evaluate(() => {
    const fixture = globalThis.__secretsMetadataFixture
    fixture.hold = false
    return fixture.old.length
  })
  await refresh.click()
  await dialog.getByText('Status: ready', { exact: true }).waitFor()
  await dialog.getByRole('option', { name: 'Synthetic current vault', exact: true }).waitFor({ state: 'attached' })
  await h.app.evaluate(() => {
    for (const resolve of globalThis.__secretsMetadataFixture.old.splice(0)) resolve({
      state: 'locked', vaults: [{ id: 'synthetic-old-vault', name: 'Synthetic obsolete vault' }],
    })
  })
  await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert(await dialog.getByText('Status: ready', { exact: true }).isVisible(), 'Old reads cannot replace explicitly refreshed status')
  assert.equal(await dialog.getByRole('option', { name: 'Synthetic obsolete vault', exact: true }).count(), 0)
  report.checks.push('Held initial reads cannot overwrite explicitly refreshed status or vaults')
  report.checks.push('Messenger Refresh is painted within the viewport and passes hit testing')
  for (const skinName of ['messenger', 'classic']) {
    if (skinName === 'classic') {
      await navigation.getByRole('button', { name: 'Appearance', exact: true }).click()
      const skin = dialog.getByRole('switch', { name: 'Messenger skin', exact: true })
      if (await skin.getAttribute('aria-checked') === 'true') await skin.click()
      await waitFor(async () => await skin.getAttribute('aria-checked') === 'false', 'acknowledged classic skin')
      await navigation.getByRole('button', { name: 'Privacy & permissions', exact: true }).click()
      await dialog.getByText('Status: ready', { exact: true }).waitFor()
      await refresh.scrollIntoViewIfNeeded()
      assert(await refresh.evaluate(painted), 'Classic Refresh must be painted and hit-testable')
      report.checks.push('Classic Refresh is painted within the viewport and passes hit testing')
    }
    await h.app.evaluate(() => { globalThis.__secretsMetadataFixture.failNext = true })
    await refresh.click()
    await dialog.getByRole('status').filter({ hasText: 'Synthetic metadata status failed' }).waitFor()
    await refresh.click()
    await waitFor(async () => await refresh.isEnabled(), `${skinName} metadata refresh completion`)
    assert.equal(await dialog.getByRole('status').filter({ hasText: 'Synthetic metadata status failed' }).count(), 0)
    assert(await dialog.getByText('Status: ready', { exact: true }).isVisible())
    report.checks.push(`${skinName} metadata failure is shown, then cleared after a successful retry`)
    await writeFile(path.join(out, `${skinName}-settings.png`), await h.page.screenshot())
  }
  assert.deepEqual(h.consoleErrors, [])
  assert.equal(report.renderLoopWarnings, 0)
  report.checks.push('No renderer page errors or render-loop warnings')
} catch (error) {
  report.failure = { message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  if (h) { report.pageErrors = h.consoleErrors; await h.close() }
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ out, ...report }, null, 2))
}
