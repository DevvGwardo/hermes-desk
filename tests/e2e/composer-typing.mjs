// Composer typing in a disposable profile. Never reads or edits real drafts.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const out = path.join(artifacts, `composer-typing-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { checks: [], failure: null }
let h

try {
  h = await launchHarness({ developmentReact: true })
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).click()
  const input = h.page.getByRole('textbox', { name: 'Message the agent' })
  await waitFor(async () => await input.isEnabled(), 'composer enabled')
  await h.page.evaluate(() => {
    window.__typingChanges = []
    let previous = null
    const sample = () => {
      const input = document.querySelector('textarea[aria-label="Message the agent"]')
      const state = JSON.stringify({ hash: location.hash, length: input?.value.length,
        focused: input === document.activeElement, disabled: input?.disabled })
      if (state !== previous) window.__typingChanges.push(JSON.parse(state))
      previous = state
      window.__typingFrame = requestAnimationFrame(sample)
    }
    sample()
  })
  const draft = 'A fixture draft that should remain visible throughout ordinary typing.'
  await input.pressSequentially(draft, { delay: 75 })
  assert.equal(await input.inputValue(), draft)
  await input.press('Shift+Enter')
  await input.pressSequentially('A second line, still unsent.', { delay: 75 })
  assert.equal(await input.inputValue(), `${draft}\nA second line, still unsent.`)
  report.checks.push('Ordinary typing and a multiline draft stay visible')

  const send = h.page.getByRole('button', { name: 'Send', exact: true })
  await waitFor(async () => await send.isEnabled(), 'connected draft')
  await h.page.evaluate(() => {
    window.__healthyStatusCount = 0
    window.__offTypingHost = window.nubAgent.host.onStatus(status => {
      if (status.serve.state === 'up') window.__healthyStatusCount += 1
    })
  })
  // Deliver the same healthy host updates production broadcasts. REST uses
  // a different local proxy port; these updates must not close the socket.
  await h.app.evaluate(({ BrowserWindow }) => {
    const status = globalThis.__hermesDeskE2E.hermesHost.status()
    const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
    for (let poll = 0; poll < 3; poll += 1) main.webContents.send('hd:host:status-changed', status)
  })
  await waitFor(async () => await h.page.evaluate(() => window.__healthyStatusCount >= 3), 'healthy status updates')
  assert.equal(await send.isEnabled(), true, 'Healthy status updates must not disconnect the renderer')
  assert.equal(await input.evaluate(element => element === document.activeElement), true)
  report.checks.push('Healthy host updates keep the renderer connected despite the separate REST proxy port')

  // A host restart exercises the real connecting/connected transitions.
  // Use the keyboard directly afterward: locator typing would silently refocus
  // the textarea and conceal the user's lost-focus bug.
  await h.page.evaluate(() => window.nubAgent.host.restartServe())
  await waitFor(async () => await h.page.getByRole('button', { name: 'Send', exact: true }).isEnabled(),
    'send enabled after reconnect')
  assert.equal(await input.inputValue(), `${draft}\nA second line, still unsent.`)
  assert.equal(await input.evaluate(element => element === document.activeElement), true,
    'Reconnecting must not boot the user out of the composer')
  await h.page.keyboard.type(' Continued after reconnect.')
  assert.equal(await input.inputValue(), `${draft}\nA second line, still unsent. Continued after reconnect.`)
  report.checks.push('A connecting/connected cycle preserves focus, draft, and continued keyboard input')

  await input.fill('E2E:chat typing-check')
  await input.press('Enter')
  await waitFor(async () => (await input.inputValue()) === '', 'draft cleared after send')
  await input.pressSequentially('Another fixture draft while the previous reply arrives.', { delay: 100 })
  assert.equal(await input.inputValue(), 'Another fixture draft while the previous reply arrives.')
  report.checks.push('Typing during a streamed reply retains the next draft')

  await h.page.getByRole('button', { name: 'Beta', exact: true }).click()
  await input.pressSequentially('A separate fixture draft for Beta.', { delay: 75 })
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).click()
  assert.equal(await input.inputValue(), 'Another fixture draft while the previous reply arrives.')
  await h.page.getByRole('button', { name: 'Beta', exact: true }).click()
  assert.equal(await input.inputValue(), 'A separate fixture draft for Beta.')
  assert.deepEqual(h.consoleErrors, [])
  report.checks.push('Switching conversations preserves both drafts without renderer errors')
} catch (error) {
  report.failure = error.message
  process.exitCode = 1
} finally {
  if (h) {
    report.changes = await h.page.evaluate(() => {
      cancelAnimationFrame(window.__typingFrame)
      window.__offTypingHost?.()
      return window.__typingChanges
    }).catch(() => [])
  }
  await h?.close()
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ out, checks: report.checks, failure: report.failure }, null, 2))
}
