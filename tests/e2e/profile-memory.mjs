import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { artifacts, launchHarness, sandboxPolicy, waitFor } from './harness.mjs'

export async function runProfileMemoryAcceptance() {
  const out = path.join(artifacts, `profile-memory-${Date.now()}`)
  await mkdir(out, { recursive: true })
  const report = { checks: [], errors: [], failure: null }
  let h
  try {
    h = await launchHarness()
    // Electron's clipboard is shared with the user, unlike HOME. Capture this fixture's copy instead.
    await h.app.evaluate(({ clipboard }) => {
      clipboard.writeText = text => { globalThis.__hermesDeskE2ECopiedMemoryCommand = text }
    })
    const files = []
    for (const profile of ['alpha', 'beta']) {
      const directory = path.join(h.env.HERMES_HOME, 'profiles', profile, 'memories')
      assert(directory.startsWith(`${h.root}${path.sep}`))
      await mkdir(directory, { recursive: true })
      for (const name of ['MEMORY.md', 'USER.md']) {
        const content = `${profile.toUpperCase()}_PRIVATE_MEMORY_FIXTURE_${name}\n${profile === 'alpha' ? 'x'.repeat(100) : 'y'.repeat(200)}\n`
        const file = path.join(directory, name)
        await writeFile(file, content)
        files.push({ file, content })
      }
    }
    await h.send('alpha', 'chat', 'memory-alpha')
    await h.page.getByTestId('chat-scroller').getByText('Fake streaming answer for memory-alpha. Local-only and deterministic.', { exact: true }).waitFor()
    await waitFor(async () => (await h.app.evaluate(() => globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'memory fixture turn settled')
    const input = () => h.page.getByRole('textbox', { name: 'Message the agent', exact: true })
    const open = async () => {
      await h.page.getByRole('button', { name: 'Composer menu', exact: true }).click()
      await h.page.getByRole('menuitem', { name: 'Profile skills', exact: true }).click()
      await h.page.getByRole('dialog', { name: 'Profile skills and memory', exact: true }).getByRole('button', { name: 'Memory', exact: true }).click()
    }
    const region = profile => h.page.getByRole('region', { name: `Memory · ${profile}`, exact: true })
    const before = h.model.requests.length
    await input().fill('Keep my existing draft.')
    await open()
    await region('alpha').getByText(/^Built-in memory ·/).waitFor()
    const alphaStatus = await region('alpha').getByText(/^Built-in memory ·/).textContent()
    assert(alphaStatus.includes(`${Buffer.byteLength(files[0].content)} B facts`))
    assert(!(await region('alpha').textContent()).includes('PRIVATE_MEMORY_FIXTURE'))
    await region('alpha').getByRole('button', { name: 'Copy profile CLI command', exact: true }).click()
    await region('alpha').getByText('Command copied. Nothing was run.', { exact: true }).waitFor()
    assert.equal(await h.app.evaluate(() => globalThis.__hermesDeskE2ECopiedMemoryCommand), 'hermes -p alpha')
    await h.page.screenshot({ path: path.join(out, 'alpha-memory-safe-workflow.png') })
    report.checks.push('Real scoped memory endpoint reports Alpha disk sizes without private bodies; copy prepares the explicit profile CLI without running it')
    const status = await promisify(execFile)('/usr/bin/sandbox-exec',
      ['-p', sandboxPolicy(h.root, h.source), path.join(h.root, 'bin/hermes'), '-p', 'alpha', 'memory', 'status'],
      { cwd: h.root, env: h.env, timeout: 30000 })
    assert(status.stdout.includes('Memory status'))
    assert(status.stdout.includes('built-in only'))
    report.checks.push('Copied profile-explicit memory status command executes successfully against the isolated native CLI, without a model call')
    await region('alpha').getByRole('button', { name: 'Prepare memory review in chat', exact: true }).click()
    await waitFor(async () => (await input().inputValue()).includes('Do not add, replace, remove, reset, or configure memory.'), 'memory review draft handoff')
    assert((await input().inputValue()).startsWith('Keep my existing draft.'))
    assert.equal(h.model.requests.length, before)
    assert(await input().evaluate(node => document.activeElement === node))
    await open()
    await region('alpha').getByRole('button', { name: 'Prepare memory review in chat', exact: true }).click()
    await waitFor(async () => await input().isVisible(), 'memory modal closed')
    assert.equal((await input().inputValue()).split('Review this Hermes profile').length, 2)
    report.checks.push('Review preparation preserves and deduplicates the existing draft, focuses its composer, and sends no model request or memory mutation')
    await h.page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Beta', exact: true }).click()
    await open()
    await region('beta').getByText(/^Built-in memory ·/).waitFor()
    const betaStatus = await region('beta').getByText(/^Built-in memory ·/).textContent()
    assert(betaStatus !== alphaStatus)
    assert(betaStatus.includes(`${Buffer.byteLength(files[2].content)} B facts`))
    await h.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:')).setSize(760, 560)
    })
    await h.page.screenshot({ path: path.join(out, 'beta-memory-minimum-window.png') })
    report.checks.push('Beta reports only its own disk usage and CLI guidance at the actual minimum window')
    await h.page.keyboard.press('Escape')
    await h.page.route('**/api/memory?**', route => route.abort('failed'))
    await open()
    await region('beta').getByRole('alert').waitFor()
    assert(!(await region('beta').textContent()).includes('nothing saved yet'))
    await h.page.unroute('**/api/memory?**')
    await region('beta').getByRole('button', { name: 'Retry memory status', exact: true }).click()
    await region('beta').getByText(/^Built-in memory ·/).waitFor()
    report.checks.push('Failed memory status is unavailable, not empty; explicit retry recovers')
    for (const { file, content } of files) assert.equal(await readFile(file, 'utf8'), content)
    assert.equal(h.model.requests.length, before)
    const rpc = await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc)
    assert(!rpc.some(row => row.method.startsWith('learning.')))
    report.checks.push('All disposable memory files remain byte-identical; unsupported learning RPCs and automatic execution are absent')
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
  const report = await runProfileMemoryAcceptance()
  console.log(JSON.stringify(report, null, 2))
  if (report.failure || report.errors.length) process.exitCode = 1
}
