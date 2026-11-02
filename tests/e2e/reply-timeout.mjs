// Real Electron + Hermes + loopback model, with only the renderer idle timer accelerated.
// Usage: node tests/e2e/reply-timeout.mjs
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const out = path.join(artifacts, `reply-timeout-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { checks: {}, errors: [] }
const check = (name, ok, detail) => {
  report.checks[name] = { ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) }
  assert(ok, name)
}
let h
try {
  h = await launchHarness()
  const { page } = h
  await page.getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
  const welcome = page.getByRole('dialog', { name: 'Welcome to Hermes Desk', exact: true })
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Start using Hermes Desk', exact: true }).click()
    await welcome.waitFor({ state: 'hidden' })
  }
  await h.send('alpha', 'chat')
  await page.getByText('Fake streaming answer for alpha. Local-only and deterministic.', { exact: true }).first().waitFor()
  await waitFor(() => h.app.evaluate(() => globalThis.__hermesDeskE2EEvents.some(event =>
    event.name === 'message.complete')), 'warm-up completion')

  // The production deadline stays two minutes. Test the actual native relay faster.
  await page.evaluate(() => {
    const setTimeout = window.setTimeout.bind(window)
    window.__replyWatchdog = { accelerated: 0 }
    window.setTimeout = (callback, ms, ...args) => {
      if (ms === 120_000) {
        window.__replyWatchdog.accelerated++
        ms = 2000
      }
      return setTimeout(callback, ms, ...args)
    }
  })
  const interrupts = () => h.app.evaluate(() =>
    globalThis.__hermesDeskE2ERpc.filter(frame => frame.method === 'session.interrupt'))
  const beforeLong = (await interrupts()).length
  await h.send('alpha', 'watchdog')
  const longStarted = Date.now()
  await page.getByText(/Long-running reply finished\./).first().waitFor({ timeout: 45000 })
  await page.getByTestId('stop-turn').waitFor({ state: 'hidden' })
  const elapsed = Date.now() - longStarted
  check('live updates keep the real reply alive beyond the accelerated idle limit',
    elapsed > 2000 && (await interrupts()).length === beforeLong, { elapsed, interrupts: (await interrupts()).length - beforeLong })
  check('native test used the actual stream watchdog',
    await page.evaluate(() => window.__replyWatchdog.accelerated > 0))

  const beforeSilent = (await interrupts()).length
  const beforeSilentProbes = await h.app.evaluate(() =>
    globalThis.__hermesDeskE2ERpc.filter(frame => frame.method === 'session.active_list').length)
  const beforeSilentEvents = await h.app.evaluate(() => globalThis.__hermesDeskE2EEvents.length)
  const beforeSilentRows = await page.locator('[data-message-id] .ca-bubble[data-side="start"]').count()
  await h.send('alpha', 'stop', 'silent-fixture')
  await waitFor(() => h.app.evaluate((_electron, before) =>
    globalThis.__hermesDeskE2ERpc.filter(frame => frame.method === 'session.active_list').length >= before + 3,
  beforeSilentProbes), 'three watchdog liveness probes', 15000)
  check('a quiet backend-confirmed working reply survives repeated idle deadlines',
    (await interrupts()).length === beforeSilent && await page.getByTestId('stop-turn').isVisible() &&
    await page.getByText(/The turn timed out after two minutes without updates/).count() === 0)

  await page.getByTestId('stop-turn').click()
  await waitFor(async () => (await interrupts()).length === beforeSilent + 1, 'one explicit profile-scoped Stop interrupt')
  await waitFor(() => h.app.evaluate(() => globalThis.__hermesDeskE2EEvents.some(event =>
    event.name === 'message.complete' && event.status === 'interrupted')), 'native interrupted completion')
  await page.getByTestId('stop-turn').waitFor({ state: 'hidden' })
  const timeoutInterrupt = (await interrupts()).at(-1)
  check('explicit Stop interrupts the quiet reply exactly once in its own profile',
    timeoutInterrupt.profile === 'alpha' && (await interrupts()).length === beforeSilent + 1)
  const afterSilentRows = await page.locator('[data-message-id] .ca-bubble[data-side="start"]').count()
  const replyIds = await page.locator('[data-message-id] .ca-bubble[data-side="start"]').evaluateAll(bubbles =>
    bubbles.map(bubble => bubble.closest('[data-message-id]')?.getAttribute('data-message-id')))
  const lateEvents = await h.app.evaluate((_electron, index) =>
    globalThis.__hermesDeskE2EEvents.slice(index).map(({ name, status }) => ({ name, status })), beforeSilentEvents)
  const replyKinds = await page.locator('[data-message-id] .ca-bubble[data-side="start"]').evaluateAll(bubbles =>
    bubbles.map(bubble => ({ timedOut: /turn timed out/i.test(bubble.textContent), interrupted: /interrupted/i.test(bubble.textContent) })))
  check('the late interrupted completion does not create a second reply',
    afterSilentRows === beforeSilentRows + 1, { beforeSilentRows, afterSilentRows, replyIds, replyKinds, lateEvents })
  check('the failed reply is retryable and does not claim overload',
    await page.getByTestId('retry-turn').isVisible() &&
    await page.getByText(/may be overloaded/).count() === 0)

  const beforeManual = (await interrupts()).length
  await h.send('alpha', 'stop', 'manual-stop-fixture')
  await page.getByTestId('stop-turn').click()
  await waitFor(async () => (await interrupts()).length === beforeManual + 1, 'manual Stop interrupt')
  await page.getByTestId('stop-turn').waitFor({ state: 'hidden' })
  check('manual Stop remains independent of the idle watchdog',
    (await interrupts()).length === beforeManual + 1)
  check('no renderer or local fake-model errors',
    h.consoleErrors.length === 0 && h.model.errors.length === 0)
} catch (error) {
  report.failure = String(error.stack ?? error)
} finally {
  report.errors = h?.consoleErrors ?? []
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ out, ...report }, null, 2))
  await h?.close()
  if (report.failure || Object.values(report.checks).some(result => !result.ok)) process.exitCode = 1
}
