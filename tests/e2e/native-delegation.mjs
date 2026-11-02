import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

export async function runNativeDelegationAcceptance() {
  const out = path.join(artifacts, `native-delegation-${Date.now()}`)
  await mkdir(out, { recursive: true })
  const report = { checks: [], errors: [], failure: null }
  let h
  try {
    h = await launchHarness()
    const region = () => h.page.getByRole('region', { name: 'Native delegated tasks', exact: true })
    const open = async () => {
      if (!await region().isVisible())
        await h.page.getByRole('button', { name: 'Chat model and profile', exact: true }).click()
      await region().getByRole('button', { name: /^(Inspect|Refresh) delegated tasks$/ }).click()
      await h.page.getByRole('button', { name: 'Refresh delegated tasks', exact: true }).waitFor()
    }
    await h.send('alpha', 'delegate', 'alpha-owned')
    await waitFor(() => h.model.requests.some(row => JSON.stringify(row.body.messages).includes('E2E:delegatechild alpha-owned')), 'real child model request')
    await open()
    const child = region().getByRole('button', { name: 'E2E:delegatechild alpha-owned isolated native child', exact: true })
    await child.waitFor()
    await child.click()
    await region().getByRole('button', { name: 'Read live transcript', exact: true }).click()
    await waitFor(async () => (await region().textContent()).includes('Live transcript'), 'native tail response')
    await region().getByRole('textbox').fill('Keep this isolated and do not run any tools.')
    await region().getByRole('button', { name: 'Queue steering', exact: true }).click()
    await region().getByText(/Steering queued, not confirmed delivered/).waitFor()
    assert.equal(await region().getByRole('textbox').inputValue(), '')
    await h.page.screenshot({ path: path.join(out, 'native-owned-child.png') })
    report.checks.push('Real delegate_task creates a native child; owning chat lists/tails it and queues scoped steering with honest acceptance feedback')
    const alpha = await h.app.evaluate(async () => {
      const rpc = globalThis.__hermesDeskE2ERpc.find(row => row.method === 'subagent.list' && row.profile === 'alpha')
      const data = await globalThis.__hermesDeskE2E.serveClient.call('subagent.list', { profile: 'alpha', session_id: rpc.sessionId })
      const child = data.subagents.find(row => typeof row.subagent_id === 'string' && row.goal?.includes('alpha-owned'))
      if (!child) throw new Error('Expected a native live child handle')
      return { sessionId: rpc.sessionId, childId: child.subagent_id }
    })
    await h.page.keyboard.press('Escape')
    await h.send('beta', 'chat', 'beta-no-delegates')
    await h.page.getByTestId('chat-scroller').getByText('Fake streaming answer for beta-no-delegates. Local-only and deterministic.', { exact: true }).waitFor()
    await open()
    await region().getByText('No live delegated children reported for this chat.', { exact: true }).waitFor()
    assert(!(await region().textContent()).includes('alpha-owned'))
    const denied = await h.app.evaluate(async (_electron, alpha) => {
      const rpc = globalThis.__hermesDeskE2ERpc.find(row => row.method === 'subagent.list' && row.profile === 'beta')
      const client = globalThis.__hermesDeskE2E.serveClient
      const params = { profile: 'beta', session_id: rpc.sessionId, subagent_id: alpha.childId }
      return {
        tail: await client.call('subagent.tail', params),
        stop: await client.call('subagent.interrupt', params),
        steer: await client.call('subagent.steer', { ...params, text: 'Foreign control fixture' }),
        alpha: await client.call('subagent.list', { profile: 'alpha', session_id: alpha.sessionId }),
      }
    }, alpha)
    assert.equal(denied.tail.available, false)
    assert.equal(denied.tail.text, '')
    assert.equal(denied.stop.found, false)
    assert.equal(denied.steer.status, 'rejected')
    assert(denied.alpha.subagents.some(row => row.subagent_id === alpha.childId))
    report.checks.push('Real backend denies Beta tail/steer/interrupt of Alpha’s still-live child, without affecting the child')
    await h.page.keyboard.press('Escape')
    await h.page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Alpha', exact: true }).click()
    await open()
    await child.click()
    await region().getByRole('button', { name: 'Request stop', exact: true }).click()
    await region().getByText(/Stop requested.*not completion/).waitFor()
    h.model.releaseDelegate('alpha-owned')
    await waitFor(async () => {
      const button = h.page.getByRole('button', { name: 'Refresh delegated tasks', exact: true })
      if (!(await button.isEnabled())) return false
      await button.click()
      return (await region().textContent()).includes('No live delegated children reported')
    }, 'stopped child leaves real roster')
    report.checks.push('Scoped hard interrupt acknowledged; child disappears without being inferred successful')
    await h.page.keyboard.press('Escape')
    const completeCount = await h.app.evaluate(() => globalThis.__hermesDeskE2EEvents.filter(row => row.name === 'subagent.complete').length)
    await h.send('alpha', 'delegate', 'alpha-completed')
    await waitFor(() => h.model.releaseDelegate('alpha-completed'), 'successful native child ready')
    await waitFor(async () => (await h.app.evaluate(() => globalThis.__hermesDeskE2EEvents.filter(row => row.name === 'subagent.complete'))).slice(completeCount)
      .some(row => row.status === 'completed'), 'native child completion event')
    assert(h.model.responses.some(row => row.message?.content === 'Native delegated child alpha-completed completed.'))
    await h.page.getByTestId('chat-scroller').getByText('Native delegated child alpha-completed completed.', { exact: true }).waitFor()
    report.checks.push('A second native child completes normally and emits a real completed event after its deterministic model response')
    await h.send('alpha', 'delegate', 'alpha-restart')
    await waitFor(() => h.model.requests.some(row => JSON.stringify(row.body.messages).includes('E2E:delegatechild alpha-restart')), 'live restart child created')
    await open()
    await region().getByRole('button', { name: 'E2E:delegatechild alpha-restart isolated native child', exact: true }).click()
    const scoped = await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc.filter(row => row.method.startsWith('subagent.')))
    assert(scoped.length >= 4)
    assert(scoped.every(row => row.sessionId && ['alpha', 'beta'].includes(row.profile)))
    assert(!(await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc)).some(row => row.method === 'delegation.status'))
    report.checks.push('Beta reports only its own roster; every native read/control carries an owned runtime id and profile, never global delegation.status')
    await h.page.evaluate(() => window.nubAgent.host.restartServe())
    await waitFor(async () => (await h.page.evaluate(() => window.nubAgent.host.status())).serve.mode === 'spawned', 'delegation backend restart')
    await waitFor(async () => await h.page.getByRole('button', { name: 'Refresh delegated tasks', exact: true }).isEnabled(), 'delegation reattached')
    const interruptsBefore = (await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc)).filter(row => row.method === 'subagent.interrupt').length
    await region().getByRole('button', { name: 'Request stop', exact: true }).click()
    await region().getByText(/Request unavailable or acknowledgment lost/).waitFor()
    assert.equal((await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc)).filter(row => row.method === 'subagent.interrupt').length, interruptsBefore)
    await h.page.getByRole('button', { name: 'Refresh delegated tasks', exact: true }).click()
    await region().getByText('No live delegated children reported for this chat.', { exact: true }).waitFor()
    report.checks.push('Restart during a live child fences its retired inspector generation before any stop RPC; fresh snapshot does not resurrect process-local work as a durable job')
    const hash = await h.page.evaluate(() => location.hash)
    await h.restartApp()
    await h.page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
    await h.page.evaluate(hash => { location.hash = hash }, hash)
    await h.page.getByTestId('chat-scroller').getByText('Native delegated child alpha-completed completed.', { exact: true }).waitFor()
    await open()
    await region().getByText('No live delegated children reported for this chat.', { exact: true }).waitFor()
    report.checks.push('Completed native result remains in the persisted parent chat after full app/backend restart; live handles are inspected anew')
    assert.deepEqual(h.consoleErrors, [])
    assert.deepEqual(h.model.errors, [])
  } catch (error) {
    report.failure = error.stack || error.message
    if (h) await h.page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
  } finally {
    if (h) {
      report.errors.push(...h.consoleErrors, ...h.model.errors)
      await writeFile(path.join(out, 'electron.log'), h.logs.join(''))
      try { await h.close() } catch (error) { report.errors.push(error.message) }
    }
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  }
  return { ...report, out }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runNativeDelegationAcceptance()
  console.log(JSON.stringify(report, null, 2))
  if (report.failure || report.errors.length) process.exitCode = 1
}
