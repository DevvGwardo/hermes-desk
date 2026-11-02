// Real protocol and persisted sessions, with disposable profiles and a fake model.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

export async function runSessionBranchAcceptance() {
  const out = path.join(artifacts, `session-branch-${Date.now()}`)
  await mkdir(out, { recursive: true })
  const report = { checks: [], errors: [], failure: null }
  let h
  try {
    h = await launchHarness({ branchControl: true })
    const settle = async () => waitFor(async () =>
      (await h.app.evaluate(() => globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0,
    'fake turn settled')
    await h.send('alpha', 'chat', 'branch-first')
    const scroller = () => h.page.getByTestId('chat-scroller')
    const first = 'Fake streaming answer for branch-first. Local-only and deterministic.'
    const later = 'Fake streaming answer for branch-later. Local-only and deterministic.'
    await scroller().getByText(first, { exact: true }).waitFor()
    await settle()
    await h.send('alpha', 'chat', 'branch-later')
    await scroller().getByText(later, { exact: true }).waitFor()
    await settle()
    const parentId = await h.app.evaluate(async () => {
      const { sessions } = await globalThis.__hermesDeskE2E.serveClient.call('session.list', {
        profile: 'alpha',
      })
      if (sessions.length !== 1) throw new Error('Expected exactly one disposable parent chat')
      return sessions[0].id
    })
    const parentHash = await h.page.evaluate(() => location.hash)
    const message = scroller().locator('[data-message-id]').filter({ hasText: first }).last()
    await message.locator('.sand-message-action-anchor').click({ button: 'right' })
    const item = h.page.getByRole('menuitem', { name: 'Branch', exact: true })
    await item.focus()
    await h.page.keyboard.press('Enter')
    await h.page.getByText('Creating a separate chat. The parent stays unchanged.', { exact: true }).waitFor({ state: 'hidden' })
    await waitFor(async () => (await h.page.evaluate(() => location.hash)) !== parentHash, 'child selected')
    const childHash = await h.page.evaluate(() => location.hash)
    await scroller().getByText(first, { exact: true }).waitFor()
    assert.equal(await scroller().getByText(later, { exact: true }).count(), 0)
    const traffic = await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc)
    assert(traffic.some(frame => frame.method === 'session.branch' && frame.profile === 'alpha'))
    report.checks.push('Keyboard branch crosses the actual renderer guard and copies only the chosen prefix')
    await h.page.screenshot({ path: path.join(out, 'branched-chat.png') })
    await h.page.getByRole('button', { name: 'Chats', exact: true }).click()
    await h.page.getByRole('list', { name: 'Chats', exact: true }).locator('li')
      .filter({ hasText: 'branch-later' }).getByRole('button').click()
    await scroller().getByText(later, { exact: true }).waitFor()
    report.checks.push('Parent transcript stays unchanged')
    const storedBranch = await h.app.evaluate(async (_electron, parentId) => {
      const client = globalThis.__hermesDeskE2E.serveClient
      return client.call('session.branch_stored', {
        profile: 'alpha', parent_session_id: parentId, source: 'desktop', idempotency_key: 'branch_stored_acceptance',
      })
    }, parentId)
    assert(storedBranch.stored_session_id && storedBranch.stored_session_id !== parentId)
    assert.equal(storedBranch.info.profile_name, 'alpha')
    assert(storedBranch.message_count >= 4)
    report.checks.push('Native stored-parent branch copies the full context without a forced parent resume (lease conflict UI remains unit-tested)')

    // Hold only the harness-owned broker mutation; native backend receives it on release.
    await h.app.evaluate(() => { globalThis.__hermesDeskE2EBranchControl.hold = true })
    await scroller().locator('[data-message-id]').filter({ hasText: later }).last()
      .locator('.sand-message-action-anchor').click({ button: 'right' })
    await h.page.getByRole('menuitem', { name: 'Branch', exact: true }).click()
    await h.page.getByText('Creating a separate chat. The parent stays unchanged.', { exact: true }).waitFor()
    await waitFor(async () => await h.app.evaluate(() => globalThis.__hermesDeskE2EBranchControl.held.length === 1), 'one held branch')
    await h.page.getByRole('navigation', { name: 'Your agents', exact: true })
      .getByRole('button', { name: 'Beta', exact: true }).click()
    const betaHash = await h.page.evaluate(() => location.hash)
    await h.app.evaluate(() => {
      const control = globalThis.__hermesDeskE2EBranchControl
      control.hold = false
      for (const release of control.held.splice(0)) release()
    })
    await h.page.getByText('Creating a separate chat. The parent stays unchanged.', { exact: true }).waitFor({ state: 'hidden' })
    assert.equal(await h.page.evaluate(() => location.hash), betaHash)
    report.checks.push('Slow branch completion does not steal selection after profile navigation')
    await h.restartApp({ newOrigin: true })
    await h.page.getByRole('navigation', { name: 'Your agents', exact: true })
      .getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
    await h.page.evaluate(hash => { location.hash = hash }, childHash)
    await scroller().getByText(first, { exact: true }).waitFor()
    assert.equal(await scroller().getByText(later, { exact: true }).count(), 0)
    await h.page.getByRole('textbox', { name: 'Message the agent' }).fill('E2E:chat branch-continued')
    await h.page.getByRole('textbox', { name: 'Message the agent' }).press('Enter')
    await scroller().getByText('Fake streaming answer for branch-continued. Local-only and deterministic.', { exact: true }).waitFor()
    await settle()
    report.checks.push('Child persists across a changed-origin full app/backend restart and accepts its own continuation')
    await h.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
      main.setSize(760, 560)
    })
    await h.page.screenshot({ path: path.join(out, 'branch-minimum-window.png') })
    assert.deepEqual(h.consoleErrors, [])
    assert.deepEqual(h.model.errors, [])
  } catch (error) { report.failure = error.stack || error.message }
  finally {
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
  const report = await runSessionBranchAcceptance()
  console.log(JSON.stringify(report, null, 2))
  if (report.failure || report.errors.length) process.exitCode = 1
}
