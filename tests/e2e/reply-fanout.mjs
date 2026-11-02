// Real Hermes fans one session out to the main chat and a disposable HUD socket.
// No user sessions, credentials, or external model calls are used.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const out = path.join(artifacts, `reply-fanout-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { checks: [], errors: [] }
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
  await page.getByTestId('stop-turn').waitFor({ state: 'hidden' })
  const sessionId = await h.app.evaluate(() =>
    globalThis.__hermesDeskE2ERpc.findLast(frame => frame.method === 'prompt.submit').sessionId)
  const storedId = await h.app.evaluate(async (_electron, sessionId) => {
    const { sessions } = await globalThis.__hermesDeskE2E.serveClient.call('session.active_list', { profile: 'alpha' })
    return sessions.find(session => session.id === sessionId)?.session_key
  }, sessionId)
  assert(storedId, 'The fixture must have a durable session id')

  await page.evaluate(() => window.nubAgent.hud.open())
  await h.app.evaluate(async ({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    const hud = windows.find(window => window.getTitle() === 'Nub — HUD')
    const main = windows.find(window => window.webContents.getURL().startsWith('http://127.0.0.1:'))
    if (!hud || !main) throw new Error('The disposable windows were not created')
    // NUB_SMOKE deliberately loads about:blank for HUDs. Load only this
    // fixture's app shell, without enabling native shortcuts or OS input.
    hud.setPosition(-20000, -20000)
    await hud.loadURL(`${new URL(main.webContents.getURL()).origin}/?win=hud#/`)
    hud.hide()
  })
  const hud = await waitFor(() => h.app.windows().find(window => window.url().includes('win=hud')), 'disposable HUD')
  await hud.waitForFunction(() => Boolean(window.nubAgent?.serveSocket))
  await hud.evaluate(async sessionId => {
    const id = 'renderer_fanout_fixture'
    const state = window.__replyFanout = { open: false, runtimeId: null, errorCode: null, events: [] }
    window.nubAgent.serveSocket.onEvent(event => {
      if (event.id !== id) return
      if (event.type === 'open') state.open = true
      if (event.type !== 'message') return
      for (const line of event.data.split('\n').filter(Boolean)) {
        const frame = JSON.parse(line)
        if (frame.id === 'fanout-resume') {
          state.runtimeId = frame.result?.session_id
          state.errorCode = frame.error?.code ?? null
        }
        if (frame.method === 'event' && frame.params?.session_id === sessionId) {
          const { type, seq, payload } = frame.params
          state.events.push({ type, seq, text: payload?.text })
        }
      }
    })
    const result = await window.nubAgent.serveSocket.open({ id, path: '/api/ws' })
    if (!result.ok) throw new Error('The disposable HUD socket did not open')
  }, sessionId)
  await hud.waitForFunction(() => window.__replyFanout.open)
  await hud.evaluate(async storedId => {
    const result = await window.nubAgent.serveSocket.send('renderer_fanout_fixture', JSON.stringify({
      jsonrpc: '2.0', id: 'fanout-resume', method: 'session.resume',
      params: { session_id: storedId, profile: 'alpha', omit_messages: true },
    }))
    if (!result.ok) throw new Error('The disposable HUD could not resume the fixture session')
  }, storedId)
  await hud.waitForFunction(() => window.__replyFanout.runtimeId || window.__replyFanout.errorCode !== null)
  assert.deepEqual(await hud.evaluate(() => ({
    runtimeId: window.__replyFanout.runtimeId, errorCode: window.__replyFanout.errorCode,
  })), { runtimeId: sessionId, errorCode: null })
  report.checks.push('main chat and HUD attach to the same real Hermes runtime session')
  await hud.evaluate(() => { window.__replyFanout.events = [] })
  const before = await h.app.evaluate(() => globalThis.__hermesDeskE2EEvents.length)

  await h.send('alpha', 'chat', 'fanout-fixture')
  const expected = 'Fake streaming answer for fanout-fixture. Local-only and deterministic.'
  await hud.waitForFunction(() => window.__replyFanout.events.some(event => event.type === 'message.complete'))
  await page.getByTestId('chat-scroller').getByText(expected, { exact: true }).waitFor()
  await page.getByTestId('stop-turn').waitFor({ state: 'hidden' })
  const received = await hud.evaluate(() => window.__replyFanout.events)
  assert.equal(received.filter(event => event.type === 'message.delta').map(event => event.text).join(''), expected)
  assert.equal(received.filter(event => event.type === 'message.complete').length, 1)
  assert.equal(received.find(event => event.type === 'message.complete').text, expected)
  report.checks.push('both windows receive the complete streamed answer and terminal event')
  const observed = await h.app.evaluate((_electron, { before, sessionId }) =>
    globalThis.__hermesDeskE2EEvents.slice(before).filter(event => event.sessionId === sessionId), { before, sessionId })
  assert.equal(observed.length, new Set(observed.map(event => event.seq)).size)
  report.checks.push('main-process event subscribers see each shared sequence only once')
  assert.deepEqual(h.consoleErrors, [])
  assert.deepEqual(h.model.errors, [])
  await page.screenshot({ path: path.join(out, 'reply.png') })
} catch (error) {
  report.failure = String(error.stack ?? error)
} finally {
  report.errors = h?.consoleErrors ?? []
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ out, ...report }, null, 2))
  await h?.close()
  if (report.failure) process.exitCode = 1
}
