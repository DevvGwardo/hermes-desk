// Repeated chat updates and clipboard failures in an isolated, unfocused app.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const developmentReact = process.argv.includes('--development-react')
const out = path.join(artifacts, `runtime-console-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { developmentReact, checks: [], notificationRequests: 0, renderLoopWarnings: 0, renderLoopDiagnostics: [], failure: null }
let h

try {
  h = await launchHarness({ developmentReact, captureRenderLoops: true })
  const diagnosticState = await h.app.evaluate(() => globalThis.__hermesDeskE2ERenderLoops)
  assert(diagnosticState.attached > 0, 'First-warning diagnostics must attach before renderer boot')
  assert.equal(diagnosticState.attachmentFailures, 0, 'First-warning diagnostics must not silently fail')
  h.page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/notifications')) report.notificationRequests += 1
  })
  h.page.on('console', message => {
    if (/Maximum update depth|getSnapshot should be cached|Minified React error #185/i.test(message.text())) {
      report.renderLoopWarnings += 1
    }
  })
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  if (developmentReact) {
    const reactBundle = await h.page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').find(entry => /\/assets\/react-.*\.js$/.test(entry.name))?.name
      if (!url) return ''
      return await (await fetch(url)).text()
    })
    assert(reactBundle.includes('Maximum update depth exceeded'), 'React development diagnostics must be enabled')
  }
  const skip = h.page.getByRole('button', { name: 'Skip setup' })
  if (await skip.isVisible()) await skip.click()

  for (let i = 0; i < 12; i += 1) {
    const replies = h.page.locator('.ca-bubble[data-side="start"]')
    const before = await replies.count()
    await h.send('alpha', 'chat', `runtime-${i}`)
    await waitFor(async () => await replies.count() > before, 'fixture reply')
    await h.page.getByTestId('stop-turn').waitFor({ state: 'hidden', timeout: 30000 })
  }
  assert.equal(report.renderLoopWarnings, 0)
  assert.deepEqual(h.consoleErrors, [])
  report.checks.push('Twelve streamed replies settle without renderer errors')

  const bell = h.page.getByTestId('notifications-bell')
  const popover = h.page.getByTestId('notifications-popover')
  const openNotifications = async () => {
    if (!(await bell.isVisible())) await h.page.getByRole('button', { name: 'More chat actions', exact: true }).click()
    await bell.click()
    await popover.waitFor()
  }
  await openNotifications()
  const notificationMenu = h.page.getByRole('dialog', { name: 'More chat actions', exact: true })
  const notificationFilter = popover.getByTestId('notifications-filter-all')
  assert(await notificationFilter.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 &&
      rect.right <= innerWidth && rect.bottom <= innerHeight &&
      element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
  }), 'Notification filter must be painted within the viewport and hit-testable')
  await notificationFilter.click()
  await h.page.keyboard.press('Escape')
  await popover.waitFor({ state: 'hidden' })
  assert(await notificationMenu.isVisible(), 'Inner Escape must retain the More menu')
  assert(await bell.evaluate(element => document.activeElement === element), 'Inner Escape must return focus to Notifications')
  await openNotifications()
  report.notificationRequests = await h.app.evaluate(() => globalThis.__hermesDeskE2ENetwork
    .filter(entry => entry.type === 'request' && new URL(entry.url).pathname.startsWith('/api/notifications')).length)
  assert.equal(report.notificationRequests, 0)
  await h.page.keyboard.press('Escape')
  await popover.waitFor({ state: 'hidden' })
  assert(await notificationMenu.isVisible(), 'Reopened Notifications must retain its parent on Escape')
  await h.page.keyboard.press('Escape')
  await notificationMenu.waitFor({ state: 'hidden' })
  assert(await h.page.getByRole('button', { name: 'More chat actions', exact: true })
    .evaluate(element => document.activeElement === element), 'Outer Escape must return focus to More chat actions')
  report.checks.push('Opening and refreshing the bell makes no legacy notification requests')
  report.checks.push('Nested notification Escape closes one layer at a time and restores keyboard focus')

  await h.page.evaluate(() => {
    window.__browserClipboardWrites = 0
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => {
        window.__browserClipboardWrites += 1
        return Promise.reject(new DOMException('Fixture permission denial', 'NotAllowedError'))
      } },
    })
  })
  // Stub only this disposable Electron process. Never touch the system clipboard.
  await h.app.evaluate(({ clipboard }) => {
    globalThis.__runtimeCopy = { calls: 0, fail: true, text: null }
    clipboard.writeText = text => {
      globalThis.__runtimeCopy.calls += 1
      if (globalThis.__runtimeCopy.fail) throw new Error('Fixture clipboard unavailable')
      globalThis.__runtimeCopy.text = text
    }
  })
  const row = h.page.locator('.sand-message-action-anchor[data-msg-role="agent"]').last()
  await row.hover()
  await row.getByRole('button', { name: 'Copy', exact: true }).click()
  await row.getByRole('status').getByText('Could not copy. Select the text and copy it manually.').waitFor()
  assert.equal(await row.getByRole('button', { name: 'Copied', exact: true }).count(), 0)
  assert.deepEqual(h.consoleErrors, [])
  report.checks.push('Native clipboard failure is caught and never reports a successful copy')

  await h.app.evaluate(() => { globalThis.__runtimeCopy.fail = false })
  await row.getByRole('button', { name: 'Copy', exact: true }).click()
  await row.getByRole('button', { name: 'Copied', exact: true }).waitFor()
  assert.equal(await row.getByRole('status').count(), 0)
  const copied = await h.app.evaluate(() => ({
    calls: globalThis.__runtimeCopy.calls,
    hasText: typeof globalThis.__runtimeCopy.text === 'string' && globalThis.__runtimeCopy.text.length > 0,
  }))
  assert.deepEqual(copied, { calls: 2, hasText: true })
  assert.equal(await h.page.evaluate(() => window.__browserClipboardWrites), 0)
  report.checks.push('The main-window write bridge succeeds while browser clipboard permission remains denied')

  await h.page.getByRole('button', { name: 'Beta', exact: true }).click()
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).click()
  await h.page.getByRole('textbox', { name: 'Message the agent' }).fill('Fixture draft after switching')
  assert.equal(report.renderLoopWarnings, 0)
  assert.deepEqual(h.consoleErrors, [])
  report.checks.push('Switching threads and editing a draft leave the renderer stable')

  const replies = h.page.locator('.ca-bubble[data-side="start"]')
  for (let i = 0; i < 3; i += 1) {
    await h.page.getByRole('button', { name: 'Beta', exact: true }).click()
    const before = await replies.count()
    await h.send('beta', 'chat', `beta-${i}`)
    await waitFor(async () => await replies.count() > before, 'second saved fixture chat')
    await h.page.getByTestId('stop-turn').waitFor({ state: 'hidden', timeout: 30000 })
  }
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).click()
  for (let reload = 0; reload < 3; reload += 1) {
    await h.page.reload()
    await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
    for (let switchChat = 0; switchChat < 8; switchChat += 1) {
      const alpha = switchChat % 2 === 0
      report.transcriptStep = { reload, switchChat, profile: alpha ? 'alpha' : 'beta', expectedReplies: alpha ? 12 : 3 }
      await h.page.getByRole('button', { name: alpha ? 'Alpha' : 'Beta', exact: true }).click()
      await waitFor(async () => await replies.count() === (alpha ? 12 : 3), 'saved transcript restored')
      assert.equal(report.renderLoopWarnings, 0)
      assert.deepEqual(h.consoleErrors, [])
    }
  }
  assert.equal(report.notificationRequests, 0)
  const captured = await h.app.evaluate(() => globalThis.__hermesDeskE2ERenderLoops)
  report.renderLoopWarnings = Math.max(report.renderLoopWarnings, captured.warnings)
  report.renderLoopDiagnostics = captured.first
  assert.equal(captured.attachmentFailures, 0)
  assert.equal(report.renderLoopWarnings, 0)
  report.checks.push('Three reloads and twenty-four switches restore saved transcripts without a render loop')
} catch (error) {
  report.failure = error.message
  if (h) {
    const captured = await h.app.evaluate(() => globalThis.__hermesDeskE2ERenderLoops)
    report.renderLoopWarnings = Math.max(report.renderLoopWarnings, captured.warnings)
    report.renderLoopDiagnostics = captured.first
    report.failureContext = await h.page.evaluate(() => ({
      hash: location.hash,
      replies: document.querySelectorAll('.ca-bubble[data-side="start"]').length,
      emptyReplies: [...document.querySelectorAll('.ca-bubble[data-side="start"]')]
        .filter(element => !element.textContent.trim()).length,
      loadingTranscript: Boolean(document.querySelector('[data-testid="transcript-sync"]')),
    }))
    report.activeTurns = await h.app.evaluate(() => globalThis.__hermesDeskE2E.serveClient.getActiveTurns())
    report.rpc = await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc.slice(-30))
  }
  process.exitCode = 1
} finally {
  await h?.close()
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ out, ...report }, null, 2))
}
