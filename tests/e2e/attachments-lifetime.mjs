// Native-selected synthetic files, with only validated replies held in an owned app.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const developmentReact = process.argv.includes('--development-react')
const out = path.join(artifacts, `attachments-lifetime-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { developmentReact, reducedMotion: true, checks: [], pageErrors: [], renderLoopWarnings: 0, failure: null }
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
  h.page.on('console', message => {
    if (/Maximum update depth|getSnapshot should be cached|Minified React error #185/i.test(message.text())) report.renderLoopWarnings++
  })
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  const welcome = h.page.getByRole('dialog', { name: 'Welcome to Hermes Desk', exact: true })
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Start using Hermes Desk', exact: true }).click()
    await welcome.waitFor({ state: 'hidden' })
  }
  await h.send('alpha', 'chat', 'native-attachment-fixture')
  await h.page.getByText('Local-only and deterministic.', { exact: false }).first().waitFor()
  await waitFor(async () => (await h.app.evaluate(() =>
    globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'fixture turn complete')
  const setup = h.page.getByRole('button', { name: 'Got it', exact: true })
  if (await setup.isVisible()) await setup.click()

  const name = 'synthetic-attachment-lifetime.txt'
  const selectedPath = path.join(h.root, name)
  await writeFile(selectedPath, 'Obviously synthetic attachment lifecycle fixture.\n')
  await h.app.evaluate(({ dialog, ipcMain }, selectedPath) => {
    const original = ipcMain._invokeHandlers?.get('hd:attachments:pickAndUpload')
    if (typeof original !== 'function') throw new Error('Owned attachment handler inspection is unavailable')
    const fixture = globalThis.__attachmentFixture = { pending: [], calls: [], dialogs: 0, releases: 0 }
    const originalDialog = dialog.showOpenDialog.bind(dialog)
    dialog.showOpenDialog = async (...args) => {
      if (args[1]?.title !== 'Attach files to this Hermes chat') return originalDialog(...args)
      fixture.dialogs++
      return { canceled: false, filePaths: [selectedPath] }
    }
    ipcMain._invokeHandlers.set('hd:attachments:pickAndUpload', async (event, ...args) => {
      // Original sender/profile/session, bounded reads and upload validation run first.
      const result = await original(event, ...args)
      fixture.calls.push({
        profile: args[0].profile, files: result.files.map(file => file.name),
        stagedNames: result.files.map(file => file.path.split('/').at(-1)), failed: Boolean(result.error),
      })
      return new Promise((resolve, reject) => fixture.pending.push({ resolve: () => resolve(result), reject }))
    })
  }, selectedPath)

  const input = h.page.getByRole('textbox', { name: 'Message the agent', exact: true })
  const attach = h.page.getByRole('button', { name: 'Attach a file', exact: true })
  const send = h.page.getByRole('button', { name: 'Send', exact: true })
  const held = () => waitFor(() => h.app.evaluate(() => globalThis.__attachmentFixture.pending.length === 1), 'held validated attachment reply')
  const release = async (fail = false) => {
    await h.app.evaluate((_electron, fail) => {
      const fixture = globalThis.__attachmentFixture
      const pending = fixture.pending.shift()
      if (!pending) throw new Error('No owned attachment reply to release')
      fixture.releases++
      if (fail) pending.reject(new Error('Obviously synthetic delayed attachment failure'))
      else pending.resolve()
    }, fail)
    await waitFor(() => attach.isEnabled(), 'picker completion')
  }

  for (const skin of ['messenger', 'classic']) {
    if (skin === 'classic') {
      await h.page.keyboard.press('Meta+,')
      const settings = h.page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.waitFor()
      await settings.getByRole('navigation', { name: 'Settings sections' })
        .getByRole('button', { name: 'Appearance', exact: true }).click()
      const toggle = settings.getByRole('switch', { name: 'Messenger skin', exact: true })
      if (await toggle.getAttribute('aria-checked') === 'true') await toggle.click()
      await waitFor(async () => await toggle.getAttribute('aria-checked') === 'false', 'acknowledged classic skin')
      await h.page.keyboard.press('Escape')
      await settings.waitFor({ state: 'hidden' })
    }
    await h.page.getByRole('button', { name: 'Alpha', exact: true }).click()
    await input.fill(`E2E:chat ${skin}-native-attachment`)
    const draft = await input.inputValue()
    const promptsBefore = await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc.filter(call => call.method === 'prompt.submit').length)
    report.sequence = { skin, promptsBefore }
    await attach.click()
    await held()
    assert(await send.isDisabled(), `${skin} Send must wait for this chat's native attachment`)
    assert(await attach.isDisabled(), `${skin} picker must remain single-flight`)
    await input.press('Enter')
    assert.equal(await input.inputValue(), draft)
    assert.equal(await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc.filter(call => call.method === 'prompt.submit').length), promptsBefore)
    await release()
    const stagedName = await h.app.evaluate(() => globalThis.__attachmentFixture.calls.at(-1).stagedNames[0])
    assert(stagedName, 'The validated upload must report its actual stored filename')
    await h.page.getByTestId('composer-attachments').getByText(name, { exact: true }).waitFor()
    assert.equal(await input.inputValue(), draft)
    assert.equal(await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc.filter(call => call.method === 'prompt.submit').length), promptsBefore)
    report.checks.push(`${skin}: native-pending Send/Enter cannot omit the file, clear the draft or auto-send`)
    for (const [width, height] of [[960, 640], [1440, 900]]) {
      await h.app.evaluate(({ BrowserWindow }, size) => {
        const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
        main.setContentSize(...size)
      }, [width, height])
      await waitFor(() => send.evaluate(painted), `${skin} ${width}×${height} ready Send paint`)
      await waitFor(() => attach.evaluate(painted), `${skin} ${width}×${height} picker paint`)
      report.checks.push(`${skin} ${width}×${height}: ready Send and picker are painted and hit-testable`)
      await writeFile(path.join(out, `${skin}-${width}-${height}.png`), await h.page.screenshot())
    }
    await send.click()
    report.sequence.clickedSend = true
    await waitFor(() => h.app.evaluate((_electron, before) =>
      globalThis.__hermesDeskE2ERpc.filter(call => call.method === 'prompt.submit').length === before + 1, promptsBefore), 'explicit attached message')
    await waitFor(() => h.model.requests.some(request => request.body.messages.some(message =>
      message.role === 'user' && typeof message.content === 'string' &&
      message.content.includes(draft) && message.content.includes(stagedName))), 'attachment note reaches the fake model')
    await waitFor(async () => await h.page.getByTestId('composer-attachments').count() === 0, 'sent chip removed')
    await waitFor(async () => (await h.app.evaluate(() =>
      globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'attached fixture turn complete')
    report.checks.push(`${skin}: explicit Send submits once with the attachment note and clears the sent chip`)

    await attach.click()
    await held()
    await h.page.getByRole('button', { name: 'Beta', exact: true }).click()
    await input.fill(`E2E:chat ${skin}-separate-thread`)
    assert(await send.isEnabled(), 'Another chat must remain sendable')
    await release(true)
    assert.equal(await h.page.getByText('Could not attach that file. Check Hermes and try again.', { exact: true }).count(), 0)
    await h.page.getByRole('button', { name: 'Alpha', exact: true }).click()
    await h.page.getByText('Could not attach that file. Check Hermes and try again.', { exact: true }).waitFor()
    await attach.click()
    await held()
    assert.equal(await h.page.getByText('Could not attach that file. Check Hermes and try again.', { exact: true }).count(), 0)
    await release()
    await h.page.getByTestId('composer-attachments').getByText(name, { exact: true }).waitFor()
    assert.equal(await h.page.getByText('Could not attach that file. Check Hermes and try again.', { exact: true }).count(), 0)
    await h.page.getByRole('button', { name: `Remove ${name}`, exact: true }).click()
    report.checks.push(`${skin}: late failure stays on its chat and retry clears obsolete feedback`)
  }
  report.fixture = await h.app.evaluate(() => {
    const fixture = globalThis.__attachmentFixture
    return { calls: fixture.calls, dialogs: fixture.dialogs, releases: fixture.releases, pending: fixture.pending.length }
  })
  assert(report.fixture.calls.every(call => call.profile === 'alpha' && call.files.length === 1 && !call.failed))
  assert.equal(report.fixture.dialogs, 6)
  assert.equal(report.fixture.calls.length, 6)
  assert.equal(report.fixture.releases, 6)
  assert.equal(report.fixture.pending, 0)
  assert.deepEqual(h.consoleErrors, [])
  assert.equal(report.renderLoopWarnings, 0)
  report.checks.push('Original native boundary and real disposable upload remain active; no renderer errors or render-loop warnings')
} catch (error) {
  report.failure = { message: error.message, stack: error.stack }
  if (h) {
    report.route = await h.page.evaluate(() => location.hash).catch(() => null)
    report.rpc = await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc.slice(-30)).catch(() => null)
    report.failureContext = await h.page.evaluate(() => ({
      draft: document.querySelector('[aria-label="Message the agent"]')?.value,
      attachments: document.querySelector('[data-testid="composer-attachments"]')?.textContent,
      sendDisabled: document.querySelector('[aria-label="Send"]')?.disabled,
      alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
    })).catch(() => null)
    await writeFile(path.join(out, 'failure.png'), await h.page.screenshot()).catch(() => {})
    report.fixture = await h.app.evaluate(() => {
      const fixture = globalThis.__attachmentFixture
      return fixture ? { calls: fixture.calls, dialogs: fixture.dialogs, pending: fixture.pending.length } : null
    }).catch(() => null)
  }
  process.exitCode = 1
} finally {
  if (h) { report.pageErrors = h.consoleErrors; await h.close() }
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ out, ...report }, null, 2))
}
