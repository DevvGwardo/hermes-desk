// Real Desk and Hermes, changing only harness-owned profile configurations.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

export async function runProfileModelFollowAcceptance() {
  const out = path.join(artifacts, `profile-model-follow-${Date.now()}`)
  await mkdir(out, { recursive: true })
  const report = { checks: [], failure: null, errors: [] }
  let h
  try {
    h = await launchHarness()
    await h.page.getByRole('navigation', { name: 'Your agents', exact: true })
      .getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
    const send = async (profile, label, model) => {
      await h.send(profile, 'chat', label)
      await h.page.getByTestId('chat-scroller')
        .getByText(`Fake streaming answer for ${label}. Local-only and deterministic.`, { exact: true }).waitFor()
      await waitFor(async () => (await h.app.evaluate(() =>
        globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0,
      'fixture turn completes', 10000)
      const receipt = h.model.requests.findLast(r => r.body.tools &&
        r.body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes(`E2E:chat ${label}`)))
      assert(receipt, 'Missing fixture model request')
      assert.equal(receipt.body.model, model)
    }
    const selectModel = async model => {
      const config = path.join(h.env.HERMES_HOME, 'profiles', 'alpha', 'config.yaml')
      assert(config.startsWith(`${h.root}${path.sep}`), 'Never edit a real profile')
      const yaml = await readFile(config, 'utf8')
      assert(/^  default: .+$/m.test(yaml))
      await writeFile(config, yaml.replace(/^  default: .+$/m, `  default: ${model}`))
    }
    await send('alpha', 'profile-before', 'hermes-desk-fake')
    await selectModel('hermes-desk-fake-cli-warm')
    await send('alpha', 'profile-warm', 'hermes-desk-fake-cli-warm')
    report.checks.push('An open Desk chat follows an external profile model selection')
    await h.page.getByRole('button', { name: 'Chat model and profile', exact: true }).click()
    const details = () => h.page.getByRole('region', { name: 'Chat model and profile details', exact: true })
    await details().getByText('hermes-desk-fake-cli-warm', { exact: true }).waitFor()
    await details().getByText('hermes -p alpha model', { exact: true }).waitFor()
    await details().getByText('Custom endpoint', { exact: true }).waitFor()
    await h.page.screenshot({ path: path.join(out, 'chat-model-profile.png') })
    report.checks.push('The UI displays Hermes-reported session model/provider and the scoped recovery command')
    await h.page.getByRole('button', { name: 'Close model details', exact: true }).click()
    const avatar = h.page.getByTestId('chat-scroller').getByRole('button', { name: 'About Alpha', exact: true }).last()
    await avatar.click()
    const card = h.page.getByRole('dialog', { name: 'About Alpha', exact: true })
    await card.waitFor()
    await card.getByRole('button', { name: 'Close Alpha profile', exact: true }).waitFor()
    await h.page.keyboard.press('Escape')
    await card.waitFor({ state: 'hidden' })
    assert(await avatar.evaluate(node => document.activeElement === node))
    report.checks.push('A chat avatar opens the actual agent card and Escape restores keyboard focus')
    await send('beta', 'profile-island', 'hermes-desk-fake')
    report.checks.push('Changing Alpha does not change Beta')
    await selectModel('hermes-desk-fake-cli-cold')
    await h.restartApp({ newOrigin: true })
    await h.page.getByRole('navigation', { name: 'Your agents', exact: true })
      .getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
    await send('alpha', 'profile-cold', 'hermes-desk-fake-cli-cold')
    report.checks.push('A restored Desk chat follows the new profile, not its stored model')
    await h.page.getByRole('button', { name: 'Chat model and profile', exact: true }).click()
    await details().getByText('hermes-desk-fake-cli-cold', { exact: true }).waitFor()
    report.checks.push('Restored chat UI updates its reported model rather than showing the saved roster default')
    const traffic = await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc)
    assert(traffic.some(frame => frame.method === 'session.resume' &&
      frame.profile === 'alpha' && frame.followProfileConfig === true))
    report.checks.push('The opt-in passes the actual Electron renderer RPC guard')
    assert.deepEqual(h.model.errors, [])
    assert.deepEqual(h.consoleErrors, [])
  } catch (error) {
    report.failure = error.stack || error.message
  } finally {
    if (h) {
      report.errors.push(...h.model.errors, ...h.consoleErrors)
      try {
        await writeFile(path.join(out, 'electron.log'), h.logs.join(''))
        report.models = h.model.requests.map(r => ({ model: r.body.model, stream: r.body.stream }))
      } finally {
        try { await h.close() } catch (error) { report.errors.push(error.message) }
      }
    }
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  }
  return report
}
