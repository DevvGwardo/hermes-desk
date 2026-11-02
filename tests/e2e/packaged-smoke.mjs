import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifacts, waitFor } from './harness.mjs'
import { launchPackagedHarness } from './packaged-harness.mjs'

export async function runPackagedSmoke(options = {}) {
  const out = path.join(artifacts, `packaged-smoke-${Date.now()}`)
  await mkdir(out, { recursive: true })
  const report = { checks: [], errors: [], evidence: {}, failure: null,
    limitation: 'Functional packaged smoke uses --no-sandbox inside an outer macOS sandbox; default Chromium sandbox startup and real-provider use are not verified.' }
  let h
  const shot = name => h.page.screenshot({ path: path.join(out, `${name}.png`) })
  const scroller = () => h.page.getByTestId('chat-scroller')
  const answer = label => scroller().getByText(`Fake streaming answer for ${label}. Local-only and deterministic.`, { exact: true })
  const api = (route, method = 'GET', body) => h.page.evaluate(async ({ route, method, body }) => {
    const { baseUrl } = await window.nubAgent.serveConfig()
    const response = await fetch(`${baseUrl}${route}`, { method, headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), credentials: 'omit' })
    return { status: response.status, data: await response.json() }
  }, { route, method, body })
  const observe = () => h.page.evaluate(() => {
    window.__packagedEvents = []
    window.nubAgent.serveSocket.onEvent(event => {
      if (event.type !== 'message') return
      for (const line of event.data.split('\n').filter(Boolean)) {
        try {
          const frame = JSON.parse(line)
          const name = frame.method === 'event' ? frame.params?.type : frame.method
          if (name) window.__packagedEvents.push({ name, at: Date.now(),
            sessionId: frame.params?.session_id, status: frame.params?.payload?.status })
        } catch {}
      }
    })
  })
  const events = () => h.page.evaluate(() => window.__packagedEvents)
  const settled = () => waitFor(async () => await h.page.getByTestId('stop-turn').count() === 0 &&
    await h.page.getByRole('button', { name: 'Send', exact: true }).count() > 0,
    'chat turn settled')
  try {
    h = await launchPackagedHarness(out, options)
    report.evidence.requestedBundle = options.bundle || null
    report.evidence.resolvedBundle = h.bundle
    await observe()
    report.checks.push('Signed unchanged .app runs packaged main/preload and file://app.asar/dist renderer, ignoring the dev-server environment')
    assert.equal((await h.page.evaluate(() => window.nubAgent.host.status())).controller, 'ready')
    assert.equal((await h.page.evaluate(() => window.nubAgent.host.status())).gateway.state, 'down')
    report.checks.push('Disposable HOME/userData and native peer authentication reach a spawned backend; existing gateway is blocked and MCP socket is ready')
    await h.send('alpha', 'chat', 'packaged-alpha')
    await answer('packaged-alpha').waitFor()
    await settled()
    assert((await events()).some(event => event.name === 'message.delta'))
    assert.equal(await h.page.getByRole('main', { name: 'Home', exact: true }).count(), 0)
    await shot('01-packaged-chat')
    report.checks.push('Early Home exit stays on a visible Alpha chat after hydration, with real streamed events and deterministic local model output')

    const input = () => h.page.getByRole('textbox', { name: 'Message the agent', exact: true })
    await input().fill('Preserve this packaged draft.')
    await h.page.getByRole('button', { name: 'Home', exact: true }).click()
    await h.page.getByRole('main', { name: 'Home', exact: true }).waitFor()
    await h.page.getByRole('button', { name: 'All conversations', exact: true }).click()
    await h.page.getByRole('heading', { name: 'Chats', exact: true }).waitFor()
    await h.page.getByRole('list', { name: 'Chats', exact: true })
      .getByRole('button', { name: /^E2E:chat packaged-alpha/ }).click()
    await answer('packaged-alpha').waitFor()
    assert.equal(await input().inputValue(), 'Preserve this packaged draft.')
    await input().fill('')
    await h.send('beta', 'chat', 'packaged-beta')
    await answer('packaged-beta').waitFor()
    await settled()
    assert.equal(await answer('packaged-alpha').count(), 0)
    await h.page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Alpha', exact: true }).click()
    await answer('packaged-alpha').waitFor()
    report.checks.push('Home navigation retains the draft; Alpha/Beta chats remain separate with no transcript crosstalk')

    const stopAt = Date.now()
    await h.send('alpha', 'stop', 'packaged-stop')
    await waitFor(() => h.model.requests.some(row => row.body.stream &&
      row.body.messages.some(message => message.role === 'user' && message.content === 'E2E:stop packaged-stop')), 'slow native model turn')
    await h.page.keyboard.press('Meta+.')
    await waitFor(async () => (await events()).some(event => event.name === 'message.complete' && event.status === 'interrupted' && event.at >= stopAt),
      'real interrupted completion', 15000)
    report.evidence.stopMs = Date.now() - stopAt
    await settled()
    await h.send('alpha', 'chat', 'packaged-after-stop')
    await answer('packaged-after-stop').waitFor()
    await settled()
    report.checks.push('Command-period reaches a real interrupted completion, releases the composer, and allows a subsequent native turn without the inherited Stop timeout')

    await h.page.getByRole('button', { name: 'Routines', exact: true }).click()
    await h.page.getByRole('button', { name: 'New routine', exact: true }).click()
    const dialog = h.page.getByRole('dialog', { name: 'New routine', exact: true })
    await dialog.getByLabel('Agent profile', { exact: true }).selectOption('profile:alpha')
    await dialog.getByLabel('Instruction', { exact: true }).fill('E2E:chat packaged-routine')
    await dialog.getByLabel('Name', { exact: true }).fill('Packaged Alpha fixture')
    await dialog.getByRole('switch', { name: 'Active', exact: true }).click()
    await dialog.getByRole('button', { name: 'Create Routine', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const data = (await api('/api/cron/jobs?profile=alpha')).data
    const job = (Array.isArray(data) ? data : data.jobs).find(row => row.name === 'Packaged Alpha fixture')
    assert(job && job.profile === 'alpha' && job.enabled === false)
    const beta = (await api('/api/cron/jobs?profile=beta')).data
    assert.equal((Array.isArray(beta) ? beta : beta.jobs).length, 0)
    assert.equal(await h.page.evaluate(() => localStorage.getItem('maia:routines:v1')), null)
    await h.page.getByRole('button', { name: 'Run Packaged Alpha fixture now', exact: true }).click()
    await waitFor(async () => {
      const result = await api(`/api/cron/jobs/${job.id}/runs?profile=alpha`)
      return result.status === 200 && result.data.runs?.some(run => !run.is_active && ['cron_complete', 'agent_close'].includes(run.end_reason))
    }, 'packaged native cron result', 90000)
    await h.page.getByRole('button', { name: /^Packaged Alpha fixture,/ }).click()
    const saved = h.page.getByRole('dialog', { name: 'Packaged Alpha fixture', exact: true })
    await saved.getByRole('tab', { name: 'Results', exact: true }).click()
    await saved.getByText('Fake streaming answer for packaged-routine. Local-only and deterministic.', { exact: false }).waitFor()
    await shot('02-packaged-routine')
    await h.page.keyboard.press('Escape')
    report.checks.push('Packaged UI creates one atomically paused native Alpha routine, runs it through native cron, and displays the durable result without a local fallback')

    await h.send('alpha', 'delegate', 'packaged-owned')
    await waitFor(() => h.model.requests.some(row => JSON.stringify(row.body.messages).includes('E2E:delegatechild packaged-owned')), 'native delegated child')
    const region = () => h.page.getByRole('region', { name: 'Native delegated tasks', exact: true })
    const inspect = async () => {
      if (!await region().isVisible()) await h.page.getByRole('button', { name: 'Chat model and profile', exact: true }).click()
      await region().getByRole('button', { name: /^(Inspect|Refresh) delegated tasks$/ }).click()
    }
    await inspect()
    await region().getByRole('button', { name: 'E2E:delegatechild packaged-owned isolated native child', exact: true }).click()
    await region().getByRole('button', { name: 'Read live transcript', exact: true }).click()
    await region().getByText('Live transcript', { exact: false }).waitFor()
    await region().getByRole('textbox').fill('Keep this local and do not run tools.')
    await region().getByRole('button', { name: 'Queue steering', exact: true }).click()
    await region().getByText(/Steering queued, not confirmed delivered/).waitFor()
    await region().getByRole('button', { name: 'Request stop', exact: true }).click()
    await region().getByText(/Stop requested.*not completion/).waitFor()
    h.model.releaseDelegate('packaged-owned')
    await waitFor(async () => {
      const refresh = region().getByRole('button', { name: 'Refresh delegated tasks', exact: true })
      if (!await refresh.isEnabled()) return false
      await refresh.click()
      return (await region().textContent()).includes('No live delegated children reported')
    }, 'stopped child leaves native roster')
    await h.page.keyboard.press('Escape')
    report.checks.push('Packaged native delegation lists/tails an owned child, queues scoped steering, and requests stop with honest acknowledgment feedback')

    await h.send('alpha', 'delegate', 'packaged-completed')
    await waitFor(() => h.model.releaseDelegate('packaged-completed'), 'completed native child gate')
    await waitFor(async () => (await events()).some(event => event.name === 'subagent.complete' && event.status === 'completed'), 'completed native child event')
    await settled()
    report.evidence.eventsBeforeReload = await events()
    await h.page.reload()
    await h.page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Alpha', exact: true }).waitFor()
    await observe()
    const notice = scroller().locator('details').filter({
      hasText: 'Subagent Task Completed: E2E:delegatechild packaged-completed isolated native child',
    })
    const raw = notice.locator('pre')
    await notice.waitFor()
    assert.equal(await notice.evaluate(node => node.open), false)
    assert.equal(await raw.isVisible(), false)
    assert((await raw.textContent()).includes('Native delegated child packaged-completed completed.'))
    assert.equal(await notice.locator('.ca-bubble').count(), 0)
    await notice.locator('summary').click()
    await raw.waitFor()
    assert.equal(await notice.locator('pre a, pre img, pre script').count(), 0)
    await shot('03-packaged-native-notice')
    await notice.locator('summary').click()
    report.checks.push('A genuine async delegation completion hydrates as a compact system notice; raw native output starts collapsed and expands as plain text, not a user bubble')

    const hash = await h.page.evaluate(() => location.hash)
    const oldProxy = (await h.page.evaluate(() => window.nubAgent.serveConfig())).baseUrl
    const errorStart = h.errors.length, networkStart = h.network.length, restartAt = Date.now()
    await h.restartServe()
    await waitFor(async () => (await events()).some(event => event.name === 'gateway.ready' && event.at >= restartAt),
      'renderer native socket reattached', 30000)
    await h.send('alpha', 'chat', 'packaged-after-backend-restart')
    await answer('packaged-after-backend-restart').waitFor()
    await settled()
    const recoveredErrors = h.errors.slice(errorStart), recoveredRequests = h.network.slice(networkStart)
    assert(recoveredErrors.every(error => error === 'Failed to load resource: net::ERR_CONNECTION_REFUSED'))
    assert(recoveredRequests.every(row => row.url.startsWith(`${oldProxy}/`) && row.failure === 'net::ERR_CONNECTION_REFUSED'))
    report.evidence.expectedRestartErrors = { errors: recoveredErrors, requests: recoveredRequests }
    h.errors.splice(errorStart, recoveredErrors.length)
    report.checks.push('Backend restart reauthenticates a new native process and the packaged composer resumes real chat')
    await h.restartApp()
    await observe()
    await h.page.evaluate(hash => { location.hash = hash }, hash)
    await answer('packaged-alpha').waitFor()
    await answer('packaged-after-backend-restart').waitFor()
    const history = await api(`/api/cron/jobs/${job.id}/runs?profile=alpha`)
    assert.equal(history.status, 200)
    assert(history.data.runs.length >= 1)
    await inspect()
    await region().getByText('No live delegated children reported for this chat.', { exact: true }).waitFor()
    await h.page.keyboard.press('Escape')
    await shot('04-packaged-restarted')
    report.checks.push('Full packaged app/backend restart preserves chat and native routine results; process-local child handles do not resurrect')
    assert.deepEqual(h.errors, [])
    assert.deepEqual(h.model.errors, [])
    assert(!h.logs.join('').match(/Maximum update depth|Too many re-renders|render-process-gone|interrupt.*timed out/i))
    report.checks.push('No unexpected captured renderer errors, render-loop warnings, renderer crashes, or Stop timeouts; any refused reads on the deliberately retired REST proxy are recorded separately')
  } catch (error) {
    report.failure = error.stack || error.message
    if (h) {
      await shot('failure').catch(() => {})
      report.evidence.failureBody = await h.page.locator('body').innerText().catch(() => '')
    }
  } finally {
    if (h) {
      report.errors.push(...h.errors, ...h.model.errors)
      report.evidence.identities = h.identities
      report.evidence.network = h.network
      report.evidence.modelRequests = h.model.requests.length
      report.evidence.events = await events().catch(() => [])
      await writeFile(path.join(out, 'electron.log'), h.logs.join(''))
      try { await h.close() } catch (error) { report.errors.push(error.message) }
    }
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  }
  return { ...report, out }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runPackagedSmoke()
  console.log(JSON.stringify(report, null, 2))
  if (report.failure || report.errors.length) process.exitCode = 1
}
