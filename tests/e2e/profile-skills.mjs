// Real profile-scoped serve reads and native skill_view. No live model or hub installation.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

export async function runProfileSkillsAcceptance() {
  const out = path.join(artifacts, `profile-skills-${Date.now()}`)
  await mkdir(out, { recursive: true })
  const report = { checks: [], errors: [], failure: null }
  let h, releaseHeld
  try {
    h = await launchHarness()
    for (const profile of ['alpha', 'beta']) {
      const home = path.join(h.env.HERMES_HOME, 'profiles', profile)
      assert(home.startsWith(`${h.root}${path.sep}`))
      for (const name of ['imessage', 'desk-needs-key']) {
        const folder = path.join(home, 'skills', 'local', name)
        await mkdir(folder, { recursive: true })
        await writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: A disposable Mac-only ${profile} skill fixture\nplatforms: [darwin]\n${name === 'desk-needs-key' ? 'required_environment_variables: [DESK_FIXTURE_MISSING_KEY]\n' : ''}---\n# ${name}\n${profile.toUpperCase()}_ONLY_SKILL_EVIDENCE\nInspect only. Do not run commands, install dependencies or contact services.\n`)
      }
    }
    await h.send('alpha', 'chat', 'skills-bootstrap')
    await h.page.getByTestId('chat-scroller').getByText('Fake streaming answer for skills-bootstrap. Local-only and deterministic.', { exact: true }).waitFor()
    const settle = async () => waitFor(async () =>
      (await h.app.evaluate(() => globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0,
    'skill turn settled')
    await settle()
    const open = async () => {
      await h.page.getByRole('button', { name: 'Composer menu', exact: true }).click()
      await h.page.getByRole('menuitem', { name: 'Profile skills', exact: true }).click()
      await h.page.getByRole('dialog', { name: 'Profile skills and memory', exact: true }).waitFor()
    }
    const inspect = async name => {
      await h.page.getByLabel('Search installed skills', { exact: true }).fill(name)
      await h.page.getByRole('button', { name: `Inspect ${name}`, exact: true }).click()
      await h.page.getByText('Declared requirements, not checked', { exact: true }).waitFor()
    }
    const input = () => h.page.getByRole('textbox', { name: 'Message the agent', exact: true })
    await input().fill('E2E:skill imessage\nReview my existing task')
    const before = h.model.requests.length
    await open()
    await inspect('imessage')
    await h.page.getByText('Read skill instructions', { exact: true }).click()
    await h.page.locator('pre').filter({ hasText: 'ALPHA_ONLY_SKILL_EVIDENCE' }).waitFor()
    assert.equal(await h.page.getByText('BETA_ONLY_SKILL_EVIDENCE', { exact: false }).count(), 0)
    await h.page.screenshot({ path: path.join(out, 'alpha-skill-inspection.png') })
    report.checks.push('Contextual composer action reads Alpha’s actual Mac skill and instructions over the authenticated REST bridge')
    await inspect('desk-needs-key')
    await h.page.getByText('DESK_FIXTURE_MISSING_KEY', { exact: true }).waitFor()
    report.checks.push('Prerequisites are declared, not falsely marked ready; no secret values or automatic setup')
    await inspect('imessage')
    await h.page.getByRole('button', { name: 'Prepare in chat', exact: true }).focus()
    await h.page.keyboard.press('Enter')
    await waitFor(async () => (await input().inputValue()).includes('First load it with skill_view'), 'skill draft handoff')
    assert((await input().inputValue()).startsWith('E2E:skill imessage\nReview my existing task'))
    assert.equal(h.model.requests.length, before, 'Preparation unexpectedly ran a model')
    assert(await input().evaluate(node => document.activeElement === node), 'Composer focus was not restored')
    report.checks.push('Keyboard Prepare preserves the task, focuses its composer and does not execute')
    await input().press('Enter')
    await h.page.getByTestId('chat-scroller').getByText('ALPHA_ONLY_SKILL_EVIDENCE', { exact: false }).waitFor()
    await settle()
    const toolResults = h.model.requests.flatMap(request => request.body.messages.filter(message => message.role === 'tool'))
    assert(toolResults.some(message => JSON.stringify(message.content).includes('ALPHA_ONLY_SKILL_EVIDENCE')))
    assert(!toolResults.some(message => JSON.stringify(message.content).includes('BETA_ONLY_SKILL_EVIDENCE')))
    assert(h.model.responses.some(response => response.message?.tool_calls?.some(call => call.function.name === 'skill_view')))
    report.checks.push('After explicit Send, the fake model invokes the real Hermes skill_view and receives only Alpha’s native result')
    const chatHash = await h.page.evaluate(() => location.hash)
    await h.page.reload()
    await h.page.getByTestId('chat-scroller').getByText('ALPHA_ONLY_SKILL_EVIDENCE', { exact: false }).waitFor()
    report.checks.push('Native skill result persists in the transcript across renderer reload')

    // Delay one real content read; switching profile invalidates its UI owner.
    let holdOnce = true
    const held = new Promise(resolve => { releaseHeld = resolve })
    await h.page.route('**/api/skills/content?**', async route => {
      const delayed = holdOnce && new URL(route.request().url()).searchParams.get('profile') === 'alpha'
      if (delayed) {
        holdOnce = false
        await held
      }
      try { await route.continue() }
      catch (error) {
        // A closed view's timed-out fetch may already have canceled this held route.
        if (!delayed || !/already handled|closed/i.test(error.message)) report.errors.push(error.message)
      }
    })
    await open()
    await h.page.getByLabel('Search installed skills', { exact: true }).fill('imessage')
    await h.page.getByRole('button', { name: 'Inspect imessage', exact: true }).click()
    await h.page.getByText('Loading skill instructions…', { exact: true }).waitFor()
    await h.page.keyboard.press('Escape')
    await h.page.getByRole('navigation', { name: 'Your agents', exact: true })
      .getByRole('button', { name: 'Beta', exact: true }).click()
    await open()
    await inspect('imessage')
    await h.page.getByText('Read skill instructions', { exact: true }).click()
    await h.page.locator('pre').filter({ hasText: 'BETA_ONLY_SKILL_EVIDENCE' }).waitFor()
    releaseHeld()
    await h.page.unroute('**/api/skills/content?**')
    assert.equal(await h.page.locator('pre').filter({ hasText: 'ALPHA_ONLY_SKILL_EVIDENCE' }).count(), 0)
    report.checks.push('Close/reopen and profile switching discard a slow obsolete Alpha read')
    await h.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:')).setSize(760, 560)
    })
    await h.page.screenshot({ path: path.join(out, 'beta-skills-minimum-window.png') })
    await h.page.keyboard.press('Escape')

    await h.page.route('**/api/skills?**', route => route.abort('failed'))
    await open()
    await h.page.getByRole('alert').getByText('Could not reach this profile’s skills.', { exact: false }).waitFor()
    await h.page.unroute('**/api/skills?**')
    await h.page.getByRole('button', { name: 'Retry skills', exact: true }).click()
    await h.page.getByRole('button', { name: 'Inspect imessage', exact: true }).waitFor()
    report.checks.push('A failed native read shows unavailable, not empty or saved, and explicit retry recovers')
    await h.page.keyboard.press('Escape')
    await h.page.evaluate(() => window.nubAgent.host.restartServe())
    await waitFor(async () => (await h.page.evaluate(() => window.nubAgent.host.status())).serve.mode === 'spawned', 'fixture backend restarted')
    await open()
    await inspect('imessage')
    report.checks.push('Profile discovery reloads successfully after restarting only the disposable backend')
    await h.page.keyboard.press('Escape')
    await h.restartApp()
    await h.page.getByRole('navigation', { name: 'Your agents', exact: true })
      .getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
    await h.page.evaluate(hash => { location.hash = hash }, chatHash)
    await h.page.getByTestId('chat-scroller').getByText('ALPHA_ONLY_SKILL_EVIDENCE', { exact: false }).waitFor()
    report.checks.push('Persisted native skill result survives a full app/backend restart')
    assert.deepEqual(h.consoleErrors, [])
    assert.deepEqual(h.model.errors, [])
  } catch (error) {
    report.failure = error.stack || error.message
    if (h) await h.page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
  } finally {
    releaseHeld?.()
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
  const report = await runProfileSkillsAcceptance()
  console.log(JSON.stringify(report, null, 2))
  if (report.failure || report.errors.length) process.exitCode = 1
}
