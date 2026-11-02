// Real local scoped REST write in a disposable HOME, never a live profile or provider.
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const out = path.join(artifacts, `timezone-setting-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { checks: [], failure: null }
let h
try {
  h = await launchHarness()
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  await h.page.keyboard.press('Meta+,')
  const settings = h.page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Agents', exact: true }).click()
  await settings.getByLabel('Agent profile', { exact: true }).selectOption('alpha')
  const input = settings.getByLabel('Routine time zone', { exact: true })
  await input.waitFor()
  const target = path.join(h.root, '.hermes/profiles/alpha/config.yaml')
  const sibling = path.join(h.root, '.hermes/profiles/beta/config.yaml')
  const before = await readFile(target, 'utf8'), siblingBefore = await readFile(sibling, 'utf8')
  await h.app.evaluate(({ dialog }) => {
    globalThis.__timezoneConfirmations = []
    globalThis.__timezoneAccept = false
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1)
      globalThis.__timezoneConfirmations.push({
        defaultId: options.defaultId, cancelId: options.cancelId,
        scoped: options.message === 'Update alpha?' && options.detail.startsWith('timezone: Europe/London'),
      })
      return { response: globalThis.__timezoneAccept ? 1 : 0 }
    }
  })
  await input.fill('Invalid/Zone')
  await settings.getByRole('button', { name: 'Save time zone', exact: true }).click()
  await settings.getByRole('alert').filter({ hasText: 'Use an IANA time zone' }).waitFor()
  assert.equal(await h.app.evaluate(() => globalThis.__timezoneConfirmations.length), 0)
  report.checks.push('Invalid zones do not request native confirmation or config writes')

  await input.fill('Europe/London')
  await settings.getByRole('button', { name: 'Save time zone', exact: true }).click()
  await settings.getByRole('alert').filter({ hasText: 'not saved' }).waitFor()
  assert.equal(await readFile(target, 'utf8'), before)
  assert.equal(await input.inputValue(), 'Europe/London')
  report.checks.push('Native cancellation preserves the config and editable draft')

  await h.app.evaluate(() => { globalThis.__timezoneAccept = true })
  await settings.getByRole('button', { name: 'Save time zone', exact: true }).click()
  await settings.getByRole('status').filter({ hasText: 'Saved Europe/London for alpha' }).waitFor()
  const zones = await h.page.evaluate(async () => {
    const config = await window.nubAgent.host.getConfig()
    return config.profiles.map(profile => ({ name: profile.name, timezone: profile.timezone }))
  })
  assert.equal(zones.find(profile => profile.name === 'alpha')?.timezone, 'Europe/London')
  assert.equal(await readFile(sibling, 'utf8'), siblingBefore)
  assert.notEqual(await readFile(target, 'utf8'), before)
  const backups = (await readdir(path.dirname(target))).filter(name => name.startsWith('config.yaml.bak-hermesdesk-'))
  assert(backups.length > 0)
  assert.equal(await readFile(path.join(path.dirname(target), backups.at(-1)), 'utf8'), before)
  assert.deepEqual(await h.app.evaluate(() => globalThis.__timezoneConfirmations), [
    { defaultId: 0, cancelId: 0, scoped: true }, { defaultId: 0, cancelId: 0, scoped: true },
  ])
  assert.equal(h.model.requests.length, 0)
  assert.deepEqual(h.consoleErrors, [])
  report.checks.push('Confirmed UI save reaches real profile-scoped config REST, retains a backup, and leaves the sibling unchanged')
  report.checks.push('No model requests or renderer errors')
} catch (error) {
  report.failure = error.message
  if (h) report.saveErrors = await h.page.getByRole('alert').allTextContents()
  process.exitCode = 1
} finally {
  await h?.close()
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ out, ...report }, null, 2))
}
