// Real Electron + Hermes + loopback model. Drop only terminal/delta notifications in the
// disposable renderer relay; the backend and its authoritative replay stay untouched.
// Usage: node tests/e2e/reply-recovery.mjs [--watchdog-only] [--development-react]
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const out = path.join(artifacts, `reply-recovery-${Date.now()}`)
await mkdir(out, { recursive: true })
const developmentReact = process.argv.includes('--development-react')
const report = { developmentReact, checks: {}, errors: [] }
const check = (name, ok, detail) => {
  report.checks[name] = { ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) }
  assert(ok, name)
}
let h
try {
  h = await launchHarness({ developmentReact })
  const { page } = h
  await page.getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
  const welcome = page.getByRole('dialog', { name: 'Welcome to Hermes Desk', exact: true })
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Start using Hermes Desk', exact: true }).click()
    await welcome.waitFor({ state: 'hidden' })
  }
  await h.send('alpha', 'chat')
  await page.getByText('Fake streaming answer for alpha. Local-only and deterministic.', { exact: true }).first().waitFor()
  await page.getByTestId('stop-turn').waitFor({ state: 'hidden' })

  await h.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
    const send = window.webContents.send.bind(window.webContents)
    const session = globalThis.__hermesDeskE2ERpc.findLast(frame => frame.method === 'prompt.submit').sessionId
    globalThis.__replyRecovery = { session, drop: false, dropped: [] }
    window.webContents.send = (channel, ...args) => {
      const payload = args[0]
      if (globalThis.__replyRecovery.drop && payload?.type === 'message' && typeof payload.data === 'string') {
        try {
          const frame = JSON.parse(payload.data)
          const event = frame.method === 'event' ? frame.params : null
          if (event?.session_id === session &&
              ['message.delta', 'message.interim', 'tool.complete', 'message.complete'].includes(event.type)) {
            globalThis.__replyRecovery.dropped.push({ type: event.type, seq: event.seq })
            return
          }
        } catch {}
      }
      return send(channel, ...args)
    }
  })
  const calls = method => h.app.evaluate((_electron, method) =>
    globalThis.__hermesDeskE2ERpc.filter(frame => frame.method === method).length, method)
  const idle = () => h.app.evaluate(async () => {
    const { sessions } = await globalThis.__hermesDeskE2E.serveClient.call('session.active_list', { profile: 'alpha' })
    return sessions.find(item => item.id === globalThis.__replyRecovery.session)?.status === 'idle'
  })
  async function loseCompletion(label) {
    await h.app.evaluate(() => { globalThis.__replyRecovery.drop = true; globalThis.__replyRecovery.dropped = [] })
    await h.send('alpha', 'tabs', label)
    await waitFor(() => h.app.evaluate(() => globalThis.__replyRecovery.dropped.some(event =>
      event.type === 'message.complete')), 'dropped real backend completion', 30000)
    await waitFor(idle, 'backend session idle')
    check(`${label}: the backend finished but the renderer still offers Stop`, await page.getByTestId('stop-turn').isVisible())
    await h.app.evaluate(() => { globalThis.__replyRecovery.drop = false })
  }

  if (!process.argv.includes('--watchdog-only')) {
    const beforeSubmits = await calls('prompt.submit')
    const beforeInterrupts = await calls('session.interrupt')
    await loseCompletion('lost-send-fixture')
    await h.send('alpha', 'chat', 'recovered-send-fixture')
    await page.getByText('Fake streaming answer for recovered-send-fixture. Local-only and deterministic.', { exact: true })
      .first().waitFor({ timeout: 15000 })
    await page.getByTestId('stop-turn').waitFor({ state: 'hidden' })
    check('an idle rejected steer becomes exactly one new submit',
      await calls('prompt.submit') === beforeSubmits + 2 && await calls('session.steer') === 1)
    check('the recovered send is echoed only once',
      await page.getByText('E2E:chat recovered-send-fixture', { exact: true }).count() === 1)
    check('the follow-up recovery never interrupts an existing turn', await calls('session.interrupt') === beforeInterrupts)
  }

  // Accelerate only the existing production idle deadline, not request timeouts or
  // model work. The pre-deadline assertion above exercises the rejected-send path.
  await page.evaluate(() => {
    const setTimeout = window.setTimeout.bind(window)
    window.__replyRecoveryWatchdogs = 0
    window.setTimeout = (callback, ms, ...args) => {
      if (ms === 120_000) {
        window.__replyRecoveryWatchdogs++
        ms = 2500
      }
      return setTimeout(callback, ms, ...args)
    }
  })
  const beforeWatchInterrupts = await calls('session.interrupt')
  const beforeWatchSubmits = await calls('prompt.submit')
  const beforeReplay = await calls('session.events.since')
  await loseCompletion('lost-watch-fixture')
  await page.getByTestId('stop-turn').waitFor({ state: 'hidden', timeout: 15000 })
  check('the idle watchdog retrieves the missed terminal event',
    await calls('session.events.since') > beforeReplay &&
    await page.evaluate(() => window.__replyRecoveryWatchdogs > 0))
  check('watchdog recovery restores the finished answer',
    await page.getByText(/^Lane lost-watch-fixture:/).count() > 0)
  check('watchdog recovery neither interrupts nor resubmits a completed turn',
    await calls('session.interrupt') === beforeWatchInterrupts && await calls('prompt.submit') === beforeWatchSubmits + 1)
  check('no renderer or local fake-model errors', h.consoleErrors.length === 0 && h.model.errors.length === 0)
  await page.screenshot({ path: path.join(out, 'recovered.png') })
} catch (error) {
  report.failure = String(error.stack ?? error)
} finally {
  report.errors = h?.consoleErrors ?? []
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ out, ...report }, null, 2))
  await h?.close()
  if (report.failure || Object.values(report.checks).some(result => !result.ok)) process.exitCode = 1
}
