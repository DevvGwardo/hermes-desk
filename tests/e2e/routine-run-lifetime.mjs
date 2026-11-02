// Local draft persistence with real sends and validated host-list replies held.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const developmentReact = process.argv.includes('--development-react')
const out = path.join(artifacts, `routine-run-lifetime-${Date.now()}`)
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
const readSaved = () => h.page.evaluate(() => JSON.parse(localStorage.getItem('maia:routines:v1')).jobs[0])

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
  await h.send('alpha', 'chat', 'routine-run-fixture')
  await h.page.getByText('Local-only and deterministic.', { exact: false }).first().waitFor()
  await waitFor(async () => (await h.app.evaluate(() =>
    globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'fixture turn complete')
  const setup = h.page.getByRole('button', { name: 'Got it', exact: true })
  if (await setup.isVisible()) await setup.click()

  await h.app.evaluate(({ BrowserWindow }) => {
    const fixture = globalThis.__routineRunFixture = {
      holdSends: false, holdLists: false, sends: [], lists: [], sendReleases: 0, listReleases: 0, listCalls: 0,
    }
    const http = process.getBuiltinModule('http')
    const end = http.ServerResponse.prototype.end
    http.ServerResponse.prototype.end = function (...args) {
      // Only finish of the app-owned cron GET is delayed. Original bearer,
      // route, peer and upstream-response checks have already run.
      if (this.req?.method === 'GET' && this.req.url?.split('?')[0] === '/api/cron/jobs' &&
          this.getHeader('Access-Control-Allow-Origin') === '*') {
        fixture.listCalls++
        if (fixture.holdLists) {
          fixture.lists.push(() => end.apply(this, args))
          return this
        }
      }
      return end.apply(this, args)
    }
    const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
    const send = main.webContents.send.bind(main.webContents)
    main.webContents.send = (channel, payload, ...rest) => {
      if (channel === 'maia:serveSocketEvent' && payload?.type === 'message' && fixture.holdSends) {
        let frame
        try { frame = JSON.parse(payload.data) } catch { /* unrelated relay frame */ }
        const request = frame && globalThis.__hermesDeskE2ERpc.find(call =>
          call.socket === payload.id && call.id === frame.id && call.method === 'prompt.submit')
        if (request && !frame.method && Object.hasOwn(frame, 'result')) {
          // Preserve the real accepted-send reply; no result or authority is replaced.
          fixture.sends.push(() => send(channel, payload, ...rest))
          return
        }
      }
      return send(channel, payload, ...rest)
    }
  })

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
    const job = {
      id: `rt-synthetic-${skin}-overlap`, origin: 'local', name: `Synthetic ${skin} routine`,
      prompt: `E2E:chat ${skin}-routine-original`, schedule: 'every 1h', enabled: true,
      agentId: 'profile:alpha', lastRunAt: null, nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
    }
    const edits = { name: `Synthetic saved ${skin} routine`, prompt: `E2E:chat ${skin}-routine-saved`, enabled: false }
    await h.page.evaluate(job => localStorage.setItem('maia:routines:v1',
      JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), jobs: [job] })), job)
    await h.page.getByRole('button', { name: 'Routines', exact: true }).click()
    await h.page.getByRole('heading', { name: 'Routines', exact: true }).waitFor()
    await h.app.evaluate(() => { globalThis.__routineRunFixture.holdSends = true })
    await h.page.getByRole('button', { name: `Run ${job.name} now`, exact: true }).click()
    await waitFor(() => h.app.evaluate(() => globalThis.__routineRunFixture.sends.length === 1), 'held accepted prompt reply')
    await h.page.getByRole('button', { name: new RegExp(`^${job.name},`) }).click()
    const dialog = h.page.getByRole('dialog', { name: job.name, exact: true })
    await dialog.waitFor()
    await dialog.getByLabel('Instruction', { exact: true }).fill(edits.prompt)
    await dialog.getByLabel('Name', { exact: true }).fill(edits.name)
    await dialog.getByRole('switch', { name: 'Active', exact: true }).click()
    await h.app.evaluate(() => { globalThis.__routineRunFixture.holdLists = true })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await waitFor(() => h.app.evaluate(() => globalThis.__routineRunFixture.lists.length >= 1), 'held validated editor refresh')
    assert.equal((await readSaved()).prompt, edits.prompt)
    assert.equal((await readSaved()).enabled, false)
    await h.app.evaluate(() => {
      const fixture = globalThis.__routineRunFixture
      fixture.holdSends = false
      const release = fixture.sends.shift()
      if (!release) throw new Error('No owned prompt reply')
      fixture.sendReleases++
      release()
    })
    await waitFor(async () => Boolean((await readSaved()).lastRunAt), 'recorded local run completion')
    const saved = await readSaved()
    for (const [key, value] of Object.entries(edits)) assert.equal(saved[key], value, `Current saved ${key} must survive`)
    assert.equal(saved.agentId, job.agentId)
    assert.equal(saved.schedule, job.schedule)
    assert.equal(Date.parse(saved.nextRunAt) - Date.parse(saved.lastRunAt), 3_600_000,
      'The next local occurrence must be exactly one interval after its recorded completion')
    assert(h.model.requests.some(request => request.body.messages.some(message =>
      message.role === 'user' && typeof message.content === 'string' && message.content.includes(job.prompt))),
    'The real original instruction must reach the fake model')
    report.checks.push(`${skin}: accepted original run cannot overwrite the newer saved instruction, name or paused state`)
    report.checks.push(`${skin}: the next occurrence uses the exact completion-time interval anchor`)
    await h.app.evaluate(() => {
      const fixture = globalThis.__routineRunFixture
      fixture.holdLists = false
      for (const release of fixture.lists.splice(0)) { fixture.listReleases++; release() }
    })
    await dialog.waitFor({ state: 'hidden' })
    await h.page.getByRole('button', { name: 'Routines', exact: true }).click()
    const resume = h.page.getByRole('switch', { name: `Resume ${edits.name}`, exact: true })
    await resume.waitFor()
    for (const [width, height] of [[960, 640], [1440, 900]]) {
      await h.app.evaluate(({ BrowserWindow }, size) => {
        const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
        main.setContentSize(...size)
      }, [width, height])
      await waitFor(() => resume.evaluate(painted), `${skin} ${width}×${height} paused switch paint`)
      assert.equal(await resume.getAttribute('aria-checked'), 'false')
      await writeFile(path.join(out, `${skin}-${width}-${height}.png`), await h.page.screenshot())
      report.checks.push(`${skin} ${width}×${height}: the saved paused routine is painted and hit-testable`)
    }
    await h.page.getByRole('button', { name: 'Alpha', exact: true }).click()
    await waitFor(async () => (await h.app.evaluate(() =>
      globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'routine fixture turn complete')
  }
  report.fixture = await h.app.evaluate(() => {
    const fixture = globalThis.__routineRunFixture
    return { sendReleases: fixture.sendReleases, listReleases: fixture.listReleases,
      listCalls: fixture.listCalls, pendingSends: fixture.sends.length, pendingLists: fixture.lists.length }
  })
  assert.equal(report.fixture.sendReleases, 2)
  assert(report.fixture.listReleases >= 2)
  assert.equal(report.fixture.pendingSends, 0)
  assert.equal(report.fixture.pendingLists, 0)
  assert.deepEqual(h.consoleErrors, [])
  assert.equal(report.renderLoopWarnings, 0)
  report.checks.push('Original prompt and cron-list boundaries remain active; no renderer errors or render-loop warnings')
} catch (error) {
  report.failure = { message: error.message, stack: error.stack }
  if (h) {
    report.saved = await readSaved().catch(() => null)
    report.fixture = await h.app.evaluate(() => {
      const fixture = globalThis.__routineRunFixture
      return fixture ? { sendReleases: fixture.sendReleases, listReleases: fixture.listReleases,
        listCalls: fixture.listCalls, pendingSends: fixture.sends.length, pendingLists: fixture.lists.length } : null
    }).catch(() => null)
    await writeFile(path.join(out, 'failure.png'), await h.page.screenshot()).catch(() => {})
  }
  process.exitCode = 1
} finally {
  if (h) { report.pageErrors = h.consoleErrors; await h.close() }
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ out, ...report }, null, 2))
}
