import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

export async function runSessionContextAcceptance() {
  const out = path.join(artifacts, `session-context-${Date.now()}`)
  await mkdir(out, { recursive: true })
  const report = { checks: [], errors: [], failure: null }
  let h
  try {
    h = await launchHarness({ contextControl: true })
    for (const profile of ['alpha', 'beta']) {
      const memory = path.join(h.env.HERMES_HOME, 'profiles', profile, 'memories')
      assert(memory.startsWith(`${h.root}${path.sep}`))
      await mkdir(memory, { recursive: true })
      await writeFile(path.join(memory, 'MEMORY.md'), `${profile.toUpperCase()}_CONTEXT_FIXTURE\nThe user likes careful local-only verification.\n`)
    }
    const turn = async profile => {
      await h.send(profile, 'chat', `context-${profile}`)
      await h.page.getByTestId('chat-scroller').getByText(`Fake streaming answer for context-${profile}. Local-only and deterministic.`, { exact: true }).waitFor()
      await waitFor(async () => (await h.app.evaluate(() => globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'context turn settled')
    }
    const open = async () => {
      await h.page.getByRole('button', { name: 'Chat model and profile', exact: true }).click()
      await h.page.getByRole('region', { name: 'Chat model and profile details', exact: true }).waitFor()
    }
    const inspect = async () => {
      await h.page.getByRole('button', { name: 'Inspect chat context', exact: true }).focus()
      await h.page.keyboard.press('Enter')
      await h.page.getByRole('button', { name: 'Refresh chat context', exact: true }).waitFor()
    }
    await turn('alpha')
    const before = h.model.requests.length
    await open()
    await inspect()
    const native = h.page.getByRole('region', { name: 'Native chat context', exact: true })
    await native.getByText('Memory', { exact: true }).waitFor()
    await native.getByText('Instruction files · re-derived manifest', { exact: true }).click()
    await native.getByText('SOUL.md', { exact: true }).waitFor()
    assert((await native.textContent()).includes('/profiles/alpha/SOUL.md'))
    assert(!(await native.textContent()).includes('/profiles/beta/'))
    assert.equal(h.model.requests.length, before, 'Context inspection called the model')
    assert(!(await native.textContent()).includes('ALPHA_CONTEXT_FIXTURE'), 'Memory contents leaked into the manifest')
    await h.page.screenshot({ path: path.join(out, 'alpha-native-context.png') })
    report.checks.push('Keyboard inspection traverses the owned authenticated socket to real native context_breakdown; Alpha’s scope and memory category are visible without another model call or file bodies')
    await h.page.getByRole('button', { name: 'Refresh chat context', exact: true }).focus()
    await h.page.keyboard.press('Escape')
    assert(await h.page.getByRole('button', { name: 'Chat model and profile', exact: true }).evaluate(node => document.activeElement === node))
    report.checks.push('Escape closes context and restores keyboard focus')
    await turn('beta')
    await open()
    await inspect()
    await native.getByText('Instruction files · re-derived manifest', { exact: true }).click()
    await native.getByText('SOUL.md', { exact: true }).waitFor()
    assert((await native.textContent()).includes('/profiles/beta/SOUL.md'))
    assert(!(await native.textContent()).includes('/profiles/alpha/'))
    await h.page.keyboard.press('Escape')
    await h.app.evaluate(() => { globalThis.__hermesDeskE2EContextControl.hold = true })
    await open()
    await h.page.getByRole('button', { name: 'Inspect chat context', exact: true }).click()
    await waitFor(async () => (await h.app.evaluate(() => globalThis.__hermesDeskE2EContextControl.held.length)) === 1, 'held native context read')
    await h.page.keyboard.press('Escape')
    await h.page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Alpha', exact: true }).click()
    await open()
    await h.app.evaluate(() => {
      const control = globalThis.__hermesDeskE2EContextControl
      control.hold = false
      for (const release of control.held.splice(0)) release()
    })
    await inspect()
    await native.getByText('Instruction files · re-derived manifest', { exact: true }).click()
    await native.getByText('SOUL.md', { exact: true }).waitFor()
    assert((await native.textContent()).includes('/profiles/alpha/SOUL.md'))
    assert(!(await native.textContent()).includes('/profiles/beta/'))
    report.checks.push('Beta’s delayed native read cannot populate a reopened Alpha inspector')
    await h.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:')).setSize(760, 560)
    })
    await h.page.screenshot({ path: path.join(out, 'context-minimum-window.png') })
    await h.page.keyboard.press('Escape')
    await h.page.evaluate(() => window.nubAgent.host.restartServe())
    await waitFor(async () => (await h.page.evaluate(() => window.nubAgent.host.status())).serve.mode === 'spawned', 'context backend restarted')
    await open()
    await waitFor(async () => await h.page.getByRole('button', { name: 'Inspect chat context', exact: true }).isEnabled(), 'context backend reattached')
    await inspect()
    assert(await native.getByText(/Categories are estimates/).isVisible())
    report.checks.push('Reattachment uses native session ownership after fixture backend restart; unavailable/estimated agent data is not presented as empty memory')
    const alphaHash = await h.page.evaluate(() => location.hash)
    await h.restartApp()
    await h.page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
    await h.page.evaluate(hash => { location.hash = hash }, alphaHash)
    await h.page.getByTestId('chat-scroller').getByText('Fake streaming answer for context-alpha. Local-only and deterministic.', { exact: true }).waitFor()
    await open()
    await inspect()
    report.checks.push('Persisted chat resumes after full app/backend restart and supports fresh context inspection')
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
  const report = await runSessionContextAcceptance()
  console.log(JSON.stringify(report, null, 2))
  if (report.failure || report.errors.length) process.exitCode = 1
}
