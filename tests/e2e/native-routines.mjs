import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

export async function runNativeRoutinesAcceptance() {
  const out = path.join(artifacts, `native-routines-${Date.now()}`)
  await mkdir(out, { recursive: true })
  const report = { checks: [], errors: [], failure: null }
  let h
  try {
    h = await launchHarness()
    // Creating a routine is a schedule change, so main asks natively first.
    // Answer only that prompt as the user would; any other prompt stays a refusal.
    await h.app.evaluate(({ dialog }) => {
      globalThis.__routineConsents = []
      dialog.showMessageBox = async (_win, options) => {
        const approve = /configuration or task change/.test(options.message) && /^POST \/api\/cron\/jobs(?:\?|\n)/.test(options.detail)
        globalThis.__routineConsents.push({ message: options.message, approved: approve })
        return { response: approve ? 1 : 0 }
      }
    })
    await h.send('alpha', 'chat', 'native-routine-bootstrap')
    await h.page.getByTestId('chat-scroller').getByText('Fake streaming answer for native-routine-bootstrap. Local-only and deterministic.', { exact: true }).waitFor()
    await h.page.getByRole('button', { name: 'Routines', exact: true }).click()
    const api = (route, method = 'GET', body) => h.page.evaluate(async ({ route, method, body }) => {
      const { baseUrl } = await window.nubAgent.serveConfig()
      const response = await fetch(`${baseUrl}${route}`, { method, headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), credentials: 'omit' })
      return { status: response.status, data: await response.json() }
    }, { route, method, body })
    await h.page.getByRole('button', { name: 'New routine', exact: true }).click()
    const dialog = h.page.getByRole('dialog', { name: 'New routine', exact: true })
    await dialog.getByLabel('Agent profile', { exact: true }).selectOption('profile:alpha')
    await dialog.getByLabel('Instruction', { exact: true }).fill('E2E:chat native-routine-execution')
    await dialog.getByLabel('Name', { exact: true }).fill('Native Alpha fixture')
    await dialog.getByRole('switch', { name: 'Active', exact: true }).click()
    await dialog.getByRole('button', { name: 'Create Routine', exact: true }).focus()
    await h.page.keyboard.press('Enter')
    await dialog.waitFor({ state: 'hidden' })
    const alpha = (await api('/api/cron/jobs?profile=alpha')).data
    const rows = Array.isArray(alpha) ? alpha : alpha.jobs
    assert.equal(rows.length, 1)
    const job = rows[0]
    assert.equal(job.profile, 'alpha')
    assert.equal(job.enabled, false)
    const beta = (await api('/api/cron/jobs?profile=beta')).data
    assert.equal((Array.isArray(beta) ? beta : beta.jobs).length, 0)
    assert.equal(await h.page.evaluate(() => localStorage.getItem('maia:routines:v1')), null)
    assert.deepEqual(await h.app.evaluate(() => globalThis.__routineConsents.map(entry => entry.approved)), [true])
    report.checks.push('Keyboard creation asks native consent once, then saves one native Alpha job, atomically paused, with no Beta job or local fallback')
    const count = h.model.requests.length
    await h.page.getByRole('button', { name: 'Run Native Alpha fixture now', exact: true }).click()
    await waitFor(async () => {
      const result = await api(`/api/cron/jobs/${job.id}/runs?profile=alpha`)
      return result.status === 200 && result.data.runs?.some(run => !run.is_active && ['cron_complete', 'agent_close'].includes(run.end_reason))
    }, 'native cron result', 90000)
    assert(h.model.requests.length > count)
    const requests = h.model.requests.slice(count)
    assert(requests.some(request => JSON.stringify(request.body).includes('E2E:chat native-routine-execution')))
    assert(requests.every(request => !JSON.stringify(request.body).includes('You are the beta local E2E fixture agent.')))
    await h.page.getByRole('button', { name: /^Native Alpha fixture,/ }).click()
    const saved = h.page.getByRole('dialog', { name: 'Native Alpha fixture', exact: true })
    await saved.getByRole('tab', { name: 'Results', exact: true }).click()
    await saved.getByText('Fake streaming answer for native-routine-execution. Local-only and deterministic.', { exact: false }).waitFor()
    await h.page.screenshot({ path: path.join(out, 'native-alpha-result.png') })
    report.checks.push('Run now uses the real native cron executor and selected profile; native results are visible in the existing Results tab')
    await h.page.keyboard.press('Escape')
    await h.page.reload()
    await h.page.getByRole('button', { name: /^Native Alpha fixture,/ }).waitFor()
    report.checks.push('Job and outcome persist across renderer reload')

    // A separate new one-shot has no previous repeat completions. No synthetic ticker.
    await h.page.getByRole('button', { name: 'New routine', exact: true }).click()
    await dialog.getByLabel('Agent profile', { exact: true }).selectOption('profile:alpha')
    await dialog.getByLabel('Instruction', { exact: true }).fill('E2E:chat native-scheduled-execution')
    await dialog.getByLabel('Name', { exact: true }).fill('Scheduled Alpha fixture')
    await dialog.getByRole('button', { name: 'Advanced', exact: false }).click()
    await dialog.getByLabel('Custom schedule', { exact: true }).fill(new Date(Date.now() + 15000).toISOString())
    await dialog.getByRole('checkbox', { name: 'Run once, then stop', exact: true }).check()
    await dialog.getByRole('button', { name: 'Create Routine', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const jobs = (await api('/api/cron/jobs?profile=alpha')).data
    const scheduled = (Array.isArray(jobs) ? jobs : jobs.jobs).find(row => row.name === 'Scheduled Alpha fixture')
    assert(scheduled)
    assert.equal(scheduled.repeat.times, 1)
    await waitFor(async () => {
      const result = await api(`/api/cron/jobs/${scheduled.id}/runs?profile=alpha`)
      return result.status === 200 && result.data.runs?.some(run => !run.is_active && ['cron_complete', 'agent_close'].includes(run.end_reason))
    }, 'real desktop-owned scheduled occurrence', 100000)
    report.checks.push('The actual desktop-owned Hermes ticker executes the due Alpha occurrence without Run now or a synthetic scheduler')
    await h.restartApp()
    await h.page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
    const history = await api(`/api/cron/jobs/${job.id}/runs?profile=alpha`)
    assert.equal(history.status, 200)
    assert(history.data.runs.length >= 1)
    const scheduledHistory = await api(`/api/cron/jobs/${scheduled.id}/runs?profile=alpha`)
    assert.equal(scheduledHistory.status, 200)
    assert(scheduledHistory.data.runs.length >= 1)
    report.checks.push('Native run ledger survives full app/backend restart, including the scheduled occurrence')
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
  const report = await runNativeRoutinesAcceptance()
  console.log(JSON.stringify(report, null, 2))
  if (report.failure || report.errors.length) process.exitCode = 1
}
