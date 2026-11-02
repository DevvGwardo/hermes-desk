import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron } from 'playwright-core'
import { startFakeModel } from '../fake-model/server.mjs'
import { startFixture } from './fixture.mjs'
import { isolatedEnvironment, repo, seed, waitFor } from './harness.mjs'
import { inspectHermesRuntime, snapshotHermesRuntime } from './hermes-runtime.mjs'
import { assertCompletionPreviewRoute, assertPackagedBuildMatches,
  completionPreviewSandboxDenials } from './completion-preview-provenance.mjs'

const require = createRequire(import.meta.url)
const run = promisify(execFile)
const sha256 = data => createHash('sha256').update(data).digest('hex')
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

// Confinement applies to Electron and all descendants, not just Hermes.
export function packagedSandbox(root, source, bundle, home = os.homedir(), artifactRoot = '') {
  assert(!/[\\"]/.test(root + source + bundle + home + artifactRoot), 'Unsupported sandbox path')
  return `(version 1)(allow default)
    ; macOS refuses setuid ps inside seatbelt. Only this immutable, read-only
    ; system binary may escape, so production's PGID/UID peer check stays real.
    (allow process-exec (literal "/bin/ps") (with no-sandbox))
    (deny file-read-data file-write* (subpath "${home}"))
    (allow file-read-data (subpath "${bundle}") (subpath "${source}"))
    (deny file-read-data (literal "${path.join(source, '.env')}"))
    (allow file-read-data file-write* (subpath "${root}"))
    ${artifactRoot ? `(allow file-read-data file-write* (subpath "${artifactRoot}"))` : ''}
    (deny network-outbound (remote ip "*:*"))
    (allow network-outbound (remote ip "localhost:*"))
    (deny network-outbound (remote ip "localhost:8642") (remote ip "localhost:9119"))
    (deny network-bind (local ip "*:*"))
    (allow network-bind (local ip "localhost:*"))
    (deny network-bind (local ip "localhost:8642") (local ip "localhost:9119"))`
}

export async function launchPackagedHarness(out, {
  bundle = path.join(repo, 'release/mac-arm64/Hermes Desk.app'),
  source = path.join(os.homedir(), '.hermes/hermes-agent'),
  expectedRenderer,
} = {}) {
  assert.equal(process.platform, 'darwin')
  assertCompletionPreviewRoute(bundle, expectedRenderer)
  bundle = await realpath(bundle)
  source = await realpath(source)
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
  const asar = path.join(bundle, 'Contents/Resources/app.asar')
  const executable = path.join(bundle, 'Contents/MacOS/Hermes Desk')
  const asarHash = sha256(await readFile(asar))
  // Assert the evidence targets the current renderer/main, not an old build.
  const archive = require('@electron/asar')
  await assertPackagedBuildMatches({ bundle, asar, archive, expectedRenderer, workingRoot: repo })
  const runtime = await inspectHermesRuntime(source)
  // Keep the MCP Unix socket below Darwin's 104-byte sockaddr_un limit.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hd-p-')))
  const env = isolatedEnvironment(root, source, { visible: true })
  // Deliberately bogus dev origin: a packaged app must ignore it.
  env.VITE_DEV_SERVER_URL = 'http://127.0.0.1:1/not-the-packaged-renderer'
  let fixture, model, app, page, closing
  const logs = [], errors = [], identities = [], network = []
  const servePids = new Set()
  const harness = { root, env, source, bundle, logs, errors, identities, network }
  async function backendPid() {
    if (!page || page.isClosed()) return
    const host = await page.evaluate(() => window.nubAgent.host.status())
    if (host.serve.state !== 'up') return
    const { stdout } = await run('/usr/sbin/lsof',
      ['-nP', '-a', `-iTCP:${host.serve.port}`, '-sTCP:LISTEN', '-Fp'])
    const pids = stdout.trim().split('\n').filter(line => line.startsWith('p')).map(line => Number(line.slice(1)))
    assert.equal(pids.length, 1)
    servePids.add(pids[0])
    return pids[0]
  }
  async function closeApp() {
    if (!app) return
    await backendPid().catch(() => {})
    const old = app
    app = null
    await Promise.race([old.close(), delay(5000).then(() => old.process().kill('SIGKILL'))])
  }
  async function dispose() {
    const failures = []
    try { await closeApp() } catch (error) { failures.push(error.message) }
    try {
      const recorded = await readFile(path.join(root, 'serve-pids.txt'), 'utf8')
      for (const pid of recorded.trim().split('\n').filter(Boolean)) servePids.add(Number(pid))
    } catch (error) { if (error.code !== 'ENOENT') failures.push(error.message) }
    for (const pid of servePids) {
      try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') failures.push(error.message) }
    }
    for (const service of [model, fixture]) {
      try { await service?.close() } catch (error) { failures.push(error.message) }
    }
    try {
      assert.equal(sha256(await readFile(asar)), asarHash, 'Packaged archive changed during smoke')
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
      if (expectedRenderer !== undefined) await assertPackagedBuildMatches({ bundle, asar, archive, expectedRenderer, workingRoot: repo })
    } catch (error) { failures.push(error.message) }
    await rm(root, { recursive: true, force: true })
    assert.deepEqual(failures, [], 'Packaged cleanup failed')
  }
  harness.close = () => closing ||= dispose()
  try {
    const snapshot = await snapshotHermesRuntime(runtime, root)
    fixture = await startFixture()
    model = await startFakeModel({ fixtureUrl: fixture.url })
    Object.assign(harness, { fixture, model })
    await seed(root, env, model.url)
    await mkdir(path.join(root, 'bin'))
    await writeFile(path.join(root, 'bin/hermes'),
      `#!/bin/sh\nif [ "$1" = serve ]; then printf '%s\\n' "$$" >> ${quote(path.join(root, 'serve-pids.txt'))}; fi\nexec ${quote(snapshot.python)} -B ${quote(path.join(source, 'hermes'))} "$@"\n`, { mode: 0o700 })
    const policy = path.join(root, 'sandbox.sb')
    await writeFile(policy, packagedSandbox(root, source, bundle, os.homedir(), out) +
      (expectedRenderer === undefined ? '' : completionPreviewSandboxDenials(expectedRenderer, bundle)))
    const cli = await run('/usr/bin/sandbox-exec',
      ['-f', policy, path.join(root, 'bin/hermes'), '--version'], { env, cwd: root, timeout: 30000 })
    logs.push(cli.stdout, cli.stderr)
    const launcher = path.join(root, 'launch-packaged')
    await writeFile(launcher,
      `#!/bin/sh\nexec /usr/bin/sandbox-exec -f ${quote(policy)} ${quote(executable)} "$@"\n`, { mode: 0o700 })
    // No wrapper imports main, swaps assets, injects hostDeps or enables packaged dev.
    async function launch() {
      if (expectedRenderer !== undefined) await assertPackagedBuildMatches({ bundle, asar, archive, expectedRenderer, workingRoot: repo })
      // macOS forbids Chromium reinitializing seatbelt inside sandbox-exec.
      // The outer OS sandbox still confines every process. This is functional
      // packaged evidence, not proof of Chromium's default sandbox startup.
      app = await electron.launch({ executablePath: launcher,
        args: ['--no-sandbox', '--mute-audio', `--user-data-dir=${path.join(root, 'userData')}`], cwd: root, env, timeout: 45000 })
      app.process().stdout.on('data', data => logs.push(data.toString()))
      app.process().stderr.on('data', data => logs.push(data.toString()))
      const identity = await app.evaluate(({ app }) => ({
        packaged: app.isPackaged, executable: process.execPath, appPath: app.getAppPath(),
        home: process.getBuiltinModule('os').homedir(), userData: app.getPath('userData'),
        appData: app.getPath('appData'), argv: process.argv, version: process.versions.electron,
      }))
      assert.equal(identity.packaged, true)
      assert.equal(identity.executable, executable)
      assert.equal(identity.appPath, asar)
      assert.equal(identity.home, root)
      assert.equal(identity.userData, path.join(root, 'userData'))
      assert(!identity.argv.includes('--enable-packaged-dev'))
      page = await waitFor(() => app.windows().find(win => win.url().startsWith(pathToFileURL(`${asar}/dist/index.html`).href)),
        'packaged file renderer')
      page.setDefaultTimeout(20000)
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text())
      })
      page.on('requestfailed', request => network.push({ url: request.url(), failure: request.failure()?.errorText }))
      page.on('response', response => {
        if (response.status() >= 400) network.push({ url: response.url(), status: response.status() })
      })
      identity.renderer = page.url()
      identity.asarSha256 = asarHash
      identities.push(identity)
      await waitFor(async () => (await page.evaluate(() => window.nubAgent.host.status())).serve.state === 'up',
        'packaged native backend', 45000)
      // First launch keeps the actual Home preference, unlike the dev harness.
      if (await page.getByRole('button', { name: 'All conversations', exact: true }).isVisible())
        await page.getByRole('button', { name: 'All conversations', exact: true }).click()
      await page.getByRole('navigation', { name: 'Your agents', exact: true })
        .getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
      await backendPid()
      Object.assign(harness, { app, page })
    }
    await launch()
    harness.restartApp = async () => { await closeApp(); await launch() }
    harness.restartServe = async () => {
      const oldPid = await backendPid()
      await page.evaluate(() => window.nubAgent.host.restartServe())
      await waitFor(async () => (await page.evaluate(() => window.nubAgent.host.status())).serve.state === 'up',
        'packaged backend restarted', 45000)
      assert.notEqual(await backendPid(), oldPid)
    }
    harness.send = async (profile, scenario, label = profile) => {
      await page.getByRole('navigation', { name: 'Your agents', exact: true })
        .getByRole('button', { name: profile === 'alpha' ? 'Alpha' : 'Beta', exact: true }).click()
      const input = page.getByRole('textbox', { name: 'Message the agent', exact: true })
      await input.fill(`E2E:${scenario} ${label}`)
      await waitFor(() => page.getByRole('button', { name: 'Send', exact: true }).isEnabled(),
        'packaged transport accepts send')
      await input.press('Enter')
    }
    return harness
  } catch (error) {
    try {
      if (page && !page.isClosed()) {
        const host = await page.evaluate(() => window.nubAgent?.host.status()).catch(() => null)
        const pids = (await readFile(path.join(root, 'serve-pids.txt'), 'utf8')).trim().split('\n').map(Number)
        await page.screenshot({ path: path.join(out, 'launch-failure.png') }).catch(() => {})
        await writeFile(path.join(out, 'launch-state.json'), JSON.stringify({
          identities, errors, network, body: await page.locator('body').innerText(),
          host,
          peerInspection: await app.evaluate(async (_electron, { port, pids }) => {
            const cp = process.getBuiltinModule('child_process')
            const run = (bin, args) => new Promise(resolve => cp.execFile(bin, args,
              { timeout: 2000, maxBuffer: 65536 }, (error, stdout, stderr) =>
                resolve({ error: error?.message, stdout, stderr })))
            const probe = await new Promise(resolve => {
              const request = process.getBuiltinModule('http').get(`http://127.0.0.1:${port}/api/status`,
                response => { response.resume(); resolve({ status: response.statusCode }) })
              request.on('error', error => resolve({ error: error.message }))
              request.setTimeout(2000, () => { request.destroy(); resolve({ timeout: true }) })
            })
            return { probe, lsof: await run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-Fpun']),
              processes: await run('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,pgid=,uid=']) }
          }, { port: host?.serve.port, pids }).catch(error => ({ error: error.message })),
        }, null, 2))
      }
      await writeFile(path.join(out, 'launch-failure.txt'), `${error.stack}\n${logs.join('')}`)
    } finally { await harness.close() }
    throw error
  }
}
