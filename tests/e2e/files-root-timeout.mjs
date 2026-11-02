// Hold validated root replies in an owned app, never replace filesystem authority.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const developmentReact = process.argv.includes('--development-react')
const out = path.join(artifacts, `files-root-timeout-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { developmentReact, reducedMotion: true, checks: [], pageErrors: [], failure: null }
let h
process.once('SIGTERM', async () => { await h?.close(); process.exit(143) })
const painted = element => {
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth &&
    rect.top >= 0 && rect.bottom <= innerHeight && element.contains(
      document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
}

try {
  h = await launchHarness({ developmentReact })
  await h.page.emulateMedia({ reducedMotion: 'reduce' })
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  const welcome = h.page.getByRole('dialog', { name: 'Welcome to Hermes Desk', exact: true })
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Start using Hermes Desk', exact: true }).click()
    await welcome.waitFor({ state: 'hidden' })
  }
  await h.send('alpha', 'chat', 'files-root-fixture')
  await h.page.getByText('Local-only and deterministic.', { exact: false }).first().waitFor()
  await waitFor(async () => (await h.app.evaluate(() =>
    globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'fixture turn complete')
  const setup = h.page.getByRole('button', { name: 'Got it', exact: true })
  if (await setup.isVisible()) await setup.click()
  // A resumed chat has an explicit cwd. An unsent fresh chat uses defaultRoot.
  const previousChat = await h.page.evaluate(() => location.hash)
  await h.page.locator('.hd-primary-actions').getByRole('button', { name: 'New chat', exact: true }).click()
  await h.page.waitForFunction(hash => location.hash !== hash, previousChat)
  await h.page.getByRole('heading', { name: 'New chat', exact: true }).waitFor()
  await writeFile(path.join(h.root, 'synthetic-deadline-fixture.txt'), 'Obviously fake file-browser fixture.\n')
  await h.app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers?.get('maia:hermes')
    if (typeof original !== 'function') throw new Error('Owned harness IPC inspection is unavailable')
    const fixture = globalThis.__filesRootFixture = { hold: true, rootCalls: 0, listings: 0, old: [] }
    handlers.set('maia:hermes', async (event, ...args) => {
      // Run the real sender, argument, root and filesystem checks first.
      const result = await original(event, ...args)
      if (args[0] === 'fs' && args[1]?.[0] === 'list') fixture.listings++
      if (args[0] === 'fs' && args[1]?.[0] === 'defaultRoot') {
        fixture.rootCalls++
        if (fixture.hold) return new Promise(resolve => fixture.old.push(() => resolve(result)))
      }
      return result
    })
  })
  await h.page.getByRole('button', { name: 'More chat actions', exact: true }).click()
  const openedAt = Date.now()
  await h.page.getByRole('button', { name: 'Toggle files', exact: true }).click()
  const panel = h.page.locator('[data-side-panel="files"]')
  await panel.getByRole('list', { name: 'Loading files', exact: true }).waitFor()
  await waitFor(() => h.app.evaluate(() => globalThis.__filesRootFixture.rootCalls >= 1), 'held validated root replies')
  await waitFor(() => panel.getByText("Couldn't load your files", { exact: true }).isVisible(), 'root deadline error')
  report.rootTimeoutElapsedMs = Date.now() - openedAt
  assert.equal(await h.app.evaluate(() => globalThis.__filesRootFixture.listings), 0)
  assert.equal(await panel.getByRole('list', { name: 'Loading files', exact: true }).count(), 0)
  const retry = panel.getByRole('button', { name: 'Try again', exact: true })
  assert(await retry.evaluate(painted), 'Root timeout retry must be painted and hit-testable')
  report.checks.push('Unanswered validated root replies reach error and retry, without listing a guessed root')
  report.checks.push('Root-error retry passes viewport painting and hit testing')
  await writeFile(path.join(out, 'root-timeout.png'), await h.page.screenshot())
  await h.app.evaluate(() => { globalThis.__filesRootFixture.hold = false })
  await retry.click()
  await panel.getByText('Synthetic deadline fixture', { exact: true }).waitFor()
  await h.app.evaluate(() => { for (const finish of globalThis.__filesRootFixture.old.splice(0)) finish() })
  await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert(await panel.getByText('Synthetic deadline fixture', { exact: true }).isVisible())
  assert.equal(await panel.getByRole('button', { name: 'Try again', exact: true }).count(), 0)
  report.checks.push('Retry reads the real disposable root and late old replies do not restore an error')
  for (const [width, height] of [[960, 640], [1440, 900]]) {
    await h.app.evaluate(({ BrowserWindow }, size) => {
      const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
      main.setContentSize(...size)
    }, [width, height])
    const refresh = panel.getByRole('button', { name: 'Refresh files', exact: true })
    await waitFor(() => refresh.evaluate(painted), `${width}×${height} file refresh paint`)
    await refresh.click()
    await panel.getByText('Synthetic deadline fixture', { exact: true }).waitFor()
    report.checks.push(`${width}×${height} file refresh is painted, hit-testable and reads the supported root`)
    await writeFile(path.join(out, `files-${width}-${height}.png`), await h.page.screenshot())
  }
  assert.deepEqual(h.consoleErrors, [])
  report.checks.push('No renderer page errors')
} catch (error) {
  report.failure = { message: error.message, stack: error.stack }
  if (h) {
    report.fixture = await h.app.evaluate(() => {
      const fixture = globalThis.__filesRootFixture
      return fixture ? { rootCalls: fixture.rootCalls, listings: fixture.listings, heldReplies: fixture.old.length } : null
    }).catch(() => null)
    report.route = await h.page.evaluate(() => location.hash).catch(() => null)
  }
  process.exitCode = 1
} finally {
  if (h) { report.pageErrors = h.consoleErrors; await h.close() }
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ out, ...report }, null, 2))
}
