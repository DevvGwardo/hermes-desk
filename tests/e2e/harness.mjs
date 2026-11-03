import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron } from 'playwright-core'
import { startFakeModel, FIXTURE_VALUE as FAKE_PASSWORD, PAGE_TITLE } from '../fake-model/server.mjs'
import { startFixture } from './fixture.mjs'
import { inspectHermesRuntime, snapshotHermesRuntime } from './hermes-runtime.mjs'

const require = createRequire(import.meta.url)
const { planEnable, apply } = require('../../electron/local/mcp/config-writer.cjs')
export const repo = fileURLToPath(new URL('../../', import.meta.url))
export const artifacts = path.join(repo, 'tests/e2e/artifacts')

export function isolatedEnvironment(root, source, { visible = process.env.HERMES_DESK_E2E_VISIBLE === '1' } = {}) {
  return {
    HOME: root, HERMES_HOME: path.join(root, '.hermes'),
    HERMES_DESK_HERMES_HOME: path.join(root, '.hermes'),
    HERMES_DESK_E2E: '1', HERMES_DISABLE_LAZY_INSTALLS: '1',
    HERMES_DESK_E2E_BACKGROUND: visible ? '0' : '1',
    HERMES_RUNTIME_DIR: path.join(root, 'runtime'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'), TMPDIR: root,
    PATH: `${path.join(root, 'bin')}:${path.join(source, 'venv/bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PYTHONPATH: source, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
    LANG: 'en_US.UTF-8', DO_NOT_TRACK: '1', CUA_TELEMETRY_DISABLED: '1', NUB_SMOKE: '1',
  }
}

export function sandboxPolicy(root, source) {
  assert(!/[\\"]/.test(root + source), 'Unsupported sandbox path')
  return `(version 1)(allow default)
    (deny file-write* (subpath "${path.dirname(source)}"))
    (deny file-read-data (subpath "${path.dirname(source)}"))
    (allow file-read-data (subpath "${source}"))
    (deny file-read-data (literal "${path.join(source, '.env')}"))
    (deny network-outbound (remote ip "*:*"))
    (allow network-outbound (remote ip "localhost:*"))
    (deny network-bind (local ip "*:*"))
    (allow network-bind (local ip "localhost:*"))
    (deny network-bind (local ip "localhost:8642") (local ip "localhost:9119"))`
}

export async function waitFor(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(30)
  }
  throw new Error(`Timed out: ${label}`)
}

async function command(bin, args, options) {
  const child = spawn(bin, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120000)
  try {
    const [code] = await once(child, 'close')
    assert.equal(code, 0, output)
    return output
  } finally { clearTimeout(timeout) }
}

async function staticServer(directory) {
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' }
  const server = http.createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://local.invalid').pathname)
    const file = path.resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!file.startsWith(`${directory}${path.sep}`)) return response.writeHead(403).end()
    try {
      response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream')
      response.end(await readFile(file))
    } catch { response.writeHead(404).end() }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    } }
}

export async function seed(root, env, modelUrl, { onboarding = true } = {}) {
  for (const profile of ['default', 'alpha', 'beta', 'session-e2e-scratch']) {
    const home = profile === 'default' ? env.HERMES_HOME : path.join(env.HERMES_HOME, 'profiles', profile)
    await mkdir(home, { recursive: true })
    await writeFile(path.join(home, 'config.yaml'), `model:
  provider: custom
  default: hermes-desk-fake
  base_url: ${modelUrl}
  api_mode: chat_completions
agent:
  max_turns: 8
browser:
  record_sessions: false
approvals:
  mode: manual
memory:
  enabled: false
curator:
  enabled: false
cron:
  enabled: false
compression:
  enabled: false
session_naming:
  enabled: false
tools:
  tool_search:
    enabled: "off"
mcp_discovery_timeout: 10
mcp_servers: {}
`)
    await writeFile(path.join(home, '.env'), `OPENAI_API_KEY=obviously-fake-local-model-key\nOPENAI_BASE_URL=${modelUrl}\n`)
    await writeFile(path.join(home, 'SOUL.md'), `You are the ${profile} local E2E fixture agent.\n`)
    await writeFile(path.join(home, 'profile.yaml'), `ui_meta:\n  display_name: ${profile === 'default' ? 'Fixture Default' : profile === 'alpha' ? 'Alpha' : profile === 'beta' ? 'Beta' : 'Scratch Fixture'}\n`)
  }
  await mkdir(path.join(root, 'userData'), { recursive: true })
  await writeFile(path.join(root, 'userData/settings.json'),
    // Onboarding is a first-run modal; the isolated profile has already been "set up".
    JSON.stringify({ workspace: { enabledProfiles: ['alpha', 'beta'] }, onboarding: { completed: onboarding } }))
}

/** Same-origin pre-boot script (the CSP allows no inline script) that turns Home off. */
async function disableHomeOnLaunch(directory) {
  await writeFile(path.join(directory, 'e2e-home-off.js'),
    "try { localStorage.setItem('hermes-desk:home-on-launch', 'false') } catch (e) {}\n")
  const index = path.join(directory, 'index.html')
  const html = await readFile(index, 'utf8')
  assert(html.includes('<script src="./theme-boot.js"></script>'), 'renderer index.html changed shape')
  await writeFile(index, html.replace('<script src="./theme-boot.js"></script>',
    '<script src="./e2e-home-off.js"></script><script src="./theme-boot.js"></script>'))
}

export async function launchHarness({ source = process.env.HERMES_E2E_SOURCE ||
  path.join(os.homedir(), '.hermes/hermes-agent'), diagnosticSettingsAdapter = false, diagnosticSeedTabs = false,
  home = false, developmentReact = false, captureRenderLoops = false, holdStartupSessions = false, settingsSaveControl = false,
  branchControl = false, contextControl = false, onboarding = true } = {}) {
  assert.equal(process.platform, 'darwin', 'The E2E harness requires the macOS sandbox')
  source = await realpath(source)
  const installedRuntime = await inspectHermesRuntime(source)
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hd-e2e-')))
  const artifactDir = path.join(artifacts, diagnosticSeedTabs ? 'diagnostic-seeded'
    : diagnosticSettingsAdapter ? 'diagnostic' : 'golden')
  await mkdir(artifactDir, { recursive: true })
  const env = isolatedEnvironment(root, source)
  let fixture, model, renderer, app
  const logs = [], consoleErrors = [], servePids = new Set()
  const cleanups = []
  let closing
  function close() {
    if (!closing) closing = dispose()
    return closing
  }
  async function dispose() {
    const errors = []
    try {
      const pids = await readFile(path.join(root, 'serve-pids.txt'), 'utf8')
      for (const pid of pids.trim().split('\n').filter(Boolean)) servePids.add(Number(pid))
    } catch (error) { if (error.code !== 'ENOENT') errors.push(error.message) }
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup() } catch (error) { errors.push(error.message) }
    }
    // The host owns a detached process group. Reap it even if Electron crashes.
    for (const pid of servePids) {
      try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') errors.push(error.message) }
    }
    await rm(root, { recursive: true, force: true })
    assert.deepEqual(errors, [], 'Harness cleanup failed')
  }
  try {
    const runtime = await snapshotHermesRuntime(installedRuntime, root)
    fixture = await startFixture()
    cleanups.push(() => fixture.close())
    model = await startFakeModel({ fixtureUrl: fixture.url })
    cleanups.push(() => model.close())
    await seed(root, env, model.url, { onboarding })
    await mkdir(path.join(root, 'bin'))
    const shQuote = value => `'${value.replaceAll("'", "'\\''")}'`
    await writeFile(path.join(root, 'bin/hermes'), `#!/bin/sh\nexec ${shQuote(runtime.python)} -B ${shQuote(path.join(source, 'hermes'))} "$@"\n`, { mode: 0o700 })
    const buildOutput = await command(process.execPath,
      [path.join(repo, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', path.join(root, 'renderer')],
      { cwd: repo, env: { HOME: root, PATH: process.env.PATH, TMPDIR: root,
        ...(developmentReact ? { NODE_ENV: 'development' } : {}) } })
    // Existing flows start on the messenger shell. `home: true` keeps the real launch page.
    if (!home) await disableHomeOnLaunch(path.join(root, 'renderer'))
    renderer = await staticServer(path.join(root, 'renderer'))
    const firstRenderer = renderer
    cleanups.push(() => firstRenderer.close())
    env.VITE_DEV_SERVER_URL = renderer.url
    // Wrapper-only main access. No production global, IPC, auth bypass, or app.isPackaged override.
    const entry = path.join(root, 'entry.cjs')
    const bootPath = path.join(repo, 'electron/local/boot.cjs')
    await writeFile(entry, `const { app } = require('electron')
const assert = require('node:assert/strict')
app.setPath('userData', ${JSON.stringify(path.join(root, 'userData'))})
app.setPath('appData', ${JSON.stringify(root)})
app.setPath('logs', ${JSON.stringify(path.join(root, 'logs'))})
globalThis.__hermesDeskE2ENetwork = []
globalThis.__hermesDeskE2ERpc = []
${captureRenderLoops ? `globalThis.__hermesDeskE2ERenderLoops = require(${JSON.stringify(path.join(repo, 'tests/e2e/render-loop-diagnostics.cjs'))})
  .install(app, ${JSON.stringify(renderer.url)})` : ''}
globalThis.__hermesDeskE2EHoldSessions = ${JSON.stringify(holdStartupSessions)}
globalThis.__hermesDeskE2EHeldSessions = []
globalThis.__hermesDeskE2EBranchControl = ${JSON.stringify(branchControl)} ? { hold: false, held: [] } : null
globalThis.__hermesDeskE2EContextControl = ${JSON.stringify(contextControl)} ? { hold: false, held: [] } : null
globalThis.__hermesDeskE2EReleaseSessions = () => {
  globalThis.__hermesDeskE2EHoldSessions = false
  const held = globalThis.__hermesDeskE2EHeldSessions.splice(0)
  for (const release of held) release()
  return held.length
}
${settingsSaveControl ? `
const { ipcMain } = require('electron')
const handle = ipcMain.handle.bind(ipcMain)
globalThis.__hermesDeskE2ESaveControl = { next: null, writes: 0, release: null }
ipcMain.handle = (channel, handler) => handle(channel, channel !== 'hd:host:setConfig' ? handler : async (...args) => {
  const control = globalThis.__hermesDeskE2ESaveControl
  control.writes++
  const next = control.next
  control.next = null
  if (next === 'hold') await new Promise(resolve => { control.release = resolve })
  if (next === 'fail') throw new Error('Synthetic settings save failed. Try again.')
  return handler(...args)
})
` : ''}
const serveAuth = require(${JSON.stringify(path.join(repo, 'electron/serve-auth.cjs'))})
const createBroker = serveAuth.createServeSocketBroker
serveAuth.createServeSocketBroker = options => {
  const broker = createBroker(options)
  const send = broker.send
  broker.send = (sender, payload) => {
    const context = globalThis.__hermesDeskE2EContextControl
    if (context?.hold && payload.data.split('\\n').some(line => {
      try { return JSON.parse(line).method === 'session.context_breakdown' } catch { return false }
    })) {
      context.held.push(() => send(sender, payload))
      return { ok: true }
    }
    const branch = globalThis.__hermesDeskE2EBranchControl
    if (branch?.hold && payload.data.split('\\n').some(line => {
      try { return ['session.branch', 'session.branch_stored'].includes(JSON.parse(line).method) } catch { return false }
    })) {
      branch.held.push(() => send(sender, payload))
      return { ok: true }
    }
    for (const line of payload.data.split('\\n').filter(Boolean)) {
      try {
        const frame = JSON.parse(line)
        if (frame.method) globalThis.__hermesDeskE2ERpc.push({ at: Date.now(), socket: payload.id,
          id: frame.id, method: frame.method, sessionId: frame.params?.session_id,
          profile: frame.params?.profile, followProfileConfig: frame.params?.follow_profile_config })
        if (['deny', 'once', 'session', 'always'].includes(frame.result?.choice))
          globalThis.__hermesDeskE2ERpc.push({ at: Date.now(), socket: payload.id,
            method: 'approval.response', requestId: frame.id, choice: frame.result.choice })
      } catch {}
    }
    if (globalThis.__hermesDeskE2EHoldSessions && payload.data.split('\\n').some(line => {
      try { return JSON.parse(line).method === 'session.list' } catch { return false }
    })) {
      globalThis.__hermesDeskE2EHeldSessions.push(() => send(sender, payload))
      return { ok: true }
    }
    return send(sender, payload)
  }
  return broker
}
app.on('web-contents-created', (_event, contents) => {
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url)
    const cancel = !['file:', 'data:', 'devtools:', 'about:', 'blob:'].includes(url.protocol) &&
      !(url.hostname === '127.0.0.1' && ['http:', 'ws:'].includes(url.protocol))
    globalThis.__hermesDeskE2ENetwork.push({type:'request',url:details.url,cancel})
    callback({cancel})
  })
  contents.on('did-fail-load', (_event, code, description, url) =>
    globalThis.__hermesDeskE2ENetwork.push({type:'failed',code,description,url}))
  contents.on('before-mouse-event', (_event, input) => {
    const lanes = globalThis.__hermesDeskE2E?.ws?.lanes
    const tab = lanes?.allLanes().flatMap(lane=>lanes.listTabs(lane.id)).find(tab=>tab.webContents===contents)
    if (tab) globalThis.__hermesDeskE2ENetwork.push({type:'mouse',event:input.type,
      lane:tab.laneId,agentActing:tab.state==='agent-acting'})
  })
})
${diagnosticSettingsAdapter ? `
const mcpPath = ${JSON.stringify(path.join(repo, 'electron/local/mcp/index.cjs'))}
const mcp = require(mcpPath)
const registerMcp = mcp.registerMcp
mcp.registerMcp = ctx => registerMcp({...ctx, getConfig: () =>
  JSON.parse(require('node:fs').readFileSync(${JSON.stringify(path.join(root, 'userData/settings.json'))}, 'utf8'))})
` : ''}
const bootPath = ${JSON.stringify(bootPath)}
const boot = require(bootPath)
require.cache[bootPath].exports = ctx => {
  const spawn = require('node:child_process').spawn
  globalThis.__hermesDeskE2EServeChildren = []
  ctx.appPath = ${JSON.stringify(repo)}
  ctx.hostDeps = { spawn(...args) {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', ${JSON.stringify(sandboxPolicy(root, source))}, args[0], ...args[1]], args[2])
    globalThis.__hermesDeskE2EServeChildren.push(child)
    require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'serve-pids.txt'))}, child.pid + '\\n')
    console.log('E2E_SERVE_PID:' + child.pid)
    return child
  } }
  globalThis.__hermesDeskE2ECrashServe = () => {
    const children = globalThis.__hermesDeskE2EServeChildren.filter(child =>
      child.exitCode === null && child.signalCode === null)
    assert.equal(children.length, 1, 'Only the fixture-owned live backend may be killed')
    const child = children[0]
    assert(Number.isInteger(child.pid) && child.pid > 1)
    process.kill(-child.pid, 'SIGKILL')
    return child.pid
  }
  const result = globalThis.__hermesDeskE2E = boot(ctx)
  globalThis.__hermesDeskE2EHostStates = []
  result.hermesHost.onStatus(status => globalThis.__hermesDeskE2EHostStates.push({
    at: Date.now(), state: status.serve.state, detail: status.serve.detail }))
  globalThis.__hermesDeskE2EEvents = []
  globalThis.__hermesDeskE2ECursor = []
  const overlay = result.ws?.parts?.overlay
  if (overlay) {
    const waitFrame = overlay.waitFrame.bind(overlay)
    overlay.waitFrame = async () => {
      await waitFrame()
      const wc = require('electron').webContents.getAllWebContents().find(wc=>wc.getURL().endsWith('/overlay.html'))
      const cursor = await wc.executeJavaScript(
        "({opacity:document.querySelector('#cursor').style.opacity,label:document.querySelector('#label span').textContent})")
      cursor.visible = require('electron').BrowserWindow.fromWebContents(wc)?.isVisible() ?? null
      globalThis.__hermesDeskE2ECursor.push(cursor)
      if (cursor.opacity === '1') require('node:fs').writeFileSync(
        ${JSON.stringify(path.join(root, 'ghost-cursor.png'))}, (await wc.capturePage()).toPNG())
    }
  }
  result.serveClient.onEvent((name, params) => {
    globalThis.__hermesDeskE2EEvents.push({name, at: Date.now(), sessionId: params.session_id,
      seq: params.seq, status: params.payload?.status,
      text: name === 'message.complete' ? params.payload?.text : undefined,
      epoch: name === 'gateway.ready' ? (params.payload?.replay_epoch ?? params.replay_epoch) : undefined})
  })
  return result
}
require(${JSON.stringify(path.join(repo, 'electron/main.cjs'))})
`)
    const binary = require('electron')
    const launchedAt = performance.now()
    app = await electron.launch({ executablePath: binary, args: [entry], cwd: root, env, timeout: 45000 })
    app.process().stdout.on('data', data => {
      const line = data.toString()
      logs.push(line)
      for (const match of line.matchAll(/E2E_SERVE_PID:(\d+)/g)) servePids.add(Number(match[1]))
    })
    app.process().stderr.on('data', data => logs.push(data.toString()))
    cleanups.push(async () => {
      const closing = app.close()
      await Promise.race([closing, delay(5000).then(() => app.process().kill('SIGKILL'))])
    })
    let page = await waitFor(async () => {
      const windows = app.windows()
      for (const win of windows) if (win.url().startsWith(renderer.url)) return win
    }, 'app renderer')
    page.setDefaultTimeout(20000)
    page.on('pageerror', error => consoleErrors.push(error.message))
    const entries = await app.evaluate(() => {
      const boot = globalThis.__hermesDeskE2E
      return ['alpha', 'beta'].map(profile => [profile, boot.mcp.configEntryFor(profile)])
    })
    for (const [profile, entry] of entries) apply(planEnable({ hermesHome: env.HERMES_HOME, profile, entry }))
    const priorNetwork = []
    const harness = { app, page, root, env, fixture, model, logs, consoleErrors, buildOutput, launchedAt, artifactDir,
      source, runtimeKind: installedRuntime.kind,
      python: runtime.environment ? path.join(runtime.environment, 'bin/python') : runtime.python,
      entries, close,
      async network() { return [...priorNetwork, ...await app.evaluate(() => globalThis.__hermesDeskE2ENetwork)] },
      async crashServe() {
        return app.evaluate(() => globalThis.__hermesDeskE2ECrashServe())
      },
      async restartApp({ newOrigin = false } = {}) {
        // Keep only this fixture's userData, HOME and fake services, not an Electron or backend process.
        const oldPid = app.process().pid
        priorNetwork.push(...await app.evaluate(() => globalThis.__hermesDeskE2ENetwork))
        await app.close()
        if (newOrigin) {
          const next = await staticServer(path.join(root, 'renderer'))
          assert.notEqual(next.url, renderer.url)
          renderer = next
          cleanups.push(() => next.close())
          env.VITE_DEV_SERVER_URL = next.url
        }
        app = await electron.launch({ executablePath: binary, args: [entry], cwd: root, env, timeout: 45000 })
        assert.notEqual(app.process().pid, oldPid)
        app.process().stdout.on('data', data => {
          const line = data.toString()
          logs.push(line)
          for (const match of line.matchAll(/E2E_SERVE_PID:(\d+)/g)) servePids.add(Number(match[1]))
        })
        app.process().stderr.on('data', data => logs.push(data.toString()))
        page = await waitFor(() => app.windows().find(win => win.url().startsWith(renderer.url)), 'restarted app renderer')
        page.setDefaultTimeout(20000)
        page.on('pageerror', error => consoleErrors.push(error.message))
        const nextEntries = await app.evaluate(() => ['alpha', 'beta'].map(profile =>
          [profile, globalThis.__hermesDeskE2E.mcp.configEntryFor(profile)]))
        for (const [profile, next] of nextEntries) apply(planEnable({ hermesHome: env.HERMES_HOME, profile, entry: next }))
        Object.assign(harness, { app, page, entries: nextEntries })
      },
      async capture(name) {
        const image = await app.evaluate(async ({ BrowserWindow }) => {
          const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
          return (await main.webContents.capturePage()).toPNG().toString('base64')
        })
        await writeFile(path.join(artifactDir, `${name}.png`), Buffer.from(image, 'base64'))
        const tabImage = await app.evaluate(async () => {
          const lanes = globalThis.__hermesDeskE2E.ws.lanes
          const wc = lanes.getActiveTab(lanes.focusedLaneId)?.webContents
          return wc && !wc.isDestroyed() ? (await wc.capturePage()).toPNG().toString('base64') : null
        })
        if (tabImage) await writeFile(path.join(artifactDir, `${name}-tab.png`), Buffer.from(tabImage, 'base64'))
        return [`${name}.png`, ...(tabImage ? [`${name}-tab.png`] : [])]
      },
      async state() { return page.evaluate(() => window.nubAgent.workspace.list()) },
      async send(profile, scenario, label = profile) {
        await page.getByRole('navigation', { name: 'Your agents', exact: true })
          .getByRole('button', { name: profile === 'alpha' ? 'Alpha' : 'Beta', exact: true }).click()
        const input = page.getByRole('textbox', { name: 'Message the agent' })
        await input.fill(`E2E:${scenario} ${label}`)
        await input.press('Enter')
      },
    }
    return harness
  } catch (error) {
    await writeFile(path.join(artifactDir, 'launch-failure.txt'), `${error.stack}\n${logs.join('')}`)
    await close()
    throw error
  }
}

export async function runGoldenPath(options = {}) {
  const h = await launchHarness(options)
  const onSignal = () => { process.exitCode = 130; void h.close() }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const checks = [], screenshots = [], metrics = {
    mcpNavigateToPageEventMs: null, mcpClickToPageEventMs: null,
  }, evidence = {}
  async function check(name, fn) {
    try {
      await fn()
      checks.push({ name, passed: true })
      return true
    } catch (error) {
      checks.push({ name, passed: false, error: error.message })
      return false
    }
  }
  async function capture(name) {
    screenshots.push(...await h.capture(name))
  }
  try {
    const roster = await check('sidebar profiles and spawned serve', async () => {
      await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
      await h.page.getByRole('button', { name: 'Beta', exact: true }).waitFor()
      assert.equal(await h.page.getByRole('button', { name: 'Scratch Fixture', exact: true }).count(), 0)
      metrics.coldStartSidebarMs = performance.now() - h.launchedAt
      evidence.host = await h.page.evaluate(() => window.nubAgent.host.status())
      evidence.settings = await h.page.evaluate(() => window.nubAgent.host.getConfig())
      assert.equal(evidence.host.serve.mode, 'spawned')
      assert.equal(evidence.host.controller, 'ready')
      await capture('01-sidebar')
    })
    let chat = false, browse = false
    if (roster) chat = await check('alpha chat streams fake text', async () => {
      const start = performance.now(), before = h.model.requests.length
      await h.send('alpha', 'chat')
      await waitFor(() => h.model.requests.length > before, 'first model request')
      await h.page.getByRole('group', { name: 'Message actions for Alpha' })
        .getByText('Fake str', { exact: false }).waitFor()
      metrics.firstVisibleTextMs = performance.now() - start
      const visibleAt = Date.now()
      const firstToken = h.model.responses.find(response => response.firstToken)
      metrics.modelFirstTokenMs = firstToken.at - start
      metrics.firstTokenVisibleOverheadMs = metrics.firstVisibleTextMs - metrics.modelFirstTokenMs
      const delta = await h.app.evaluate(() => globalThis.__hermesDeskE2EEvents.find(event => event.name === 'message.delta'))
      assert(delta, 'Hermes did not emit a streamed message.delta')
      metrics.firstTokenRendererOverheadMs = visibleAt - delta.at
      await h.page.getByRole('group', { name: 'Message actions for Alpha' })
        .getByText('Local-only and deterministic.', { exact: false }).waitFor()
      evidence.chatRequests = h.model.requests.length - before
      await capture('02-chat')
    })
    if (chat) browse = await check('model-selected MCP navigate, snapshot and page title', async () => {
      const toggle = h.page.getByRole('button', { name: 'Toggle workspace' })
      if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
      await h.page.getByRole('region', { name: 'Workspace on your Mac' }).waitFor()
      if (options.diagnosticSeedTabs) {
        await h.page.evaluate(url => window.nubAgent.workspace.openTab('profile:alpha', url), `${h.fixture.url}/initial`)
        await waitFor(async () => (await h.state()).lanes.find(lane => lane.id === 'profile:alpha')
          ?.tabs.some(tab => tab.title === PAGE_TITLE), 'diagnostic seeded tab load')
      }
      await h.send('alpha', 'browse')
      const tab = await waitFor(async () => {
        const error = h.model.requests.findLast(request => request.body.messages.some(message =>
          message.role === 'user' && message.content?.includes('E2E:browse alpha')))
          ?.body.messages.findLast(message => message.role === 'tool' && message.content?.includes('{"error":'))
        if (error) throw new Error(`MCP navigation failed: ${error.content}`)
        return (await h.state()).lanes.find(lane => lane.id === 'profile:alpha')
          ?.tabs.find(tab => tab.url === `${h.fixture.url}/alpha`)
      }, 'alpha fixture tab', 35000)
      await h.page.evaluate(id => window.nubAgent.workspace.activate(id), tab.id)
      await h.page.getByRole('group', { name: 'Message actions for Alpha' })
        .getByText(`I browsed "${PAGE_TITLE}" in lane alpha.`, { exact: false }).waitFor()
      const result = h.model.requests.findLast(request => request.body.messages.filter(message => message.role === 'tool').length >= 3)
      assert(result, 'Expected model-selected tool results')
      evidence.alphaToolResults = result.body.messages.filter(message => message.role === 'tool').map(message => message.content)
      assert(evidence.alphaToolResults.slice(0, 2).every(result => !result.includes('{"error":')),
        'Navigate or snapshot returned an error')
      const issued = h.model.responses.findLast(response =>
        response.message?.tool_calls?.[0]?.function.name.endsWith('browser_navigate'))
      metrics.mcpNavigateToPageEventMs = h.fixture.events.find(event => event.type === 'load' && event.lane === 'alpha').at - issued.at
      await capture('03-browser')
    })
    if (browse) await check('MCP click reaches fixture', async () => {
      assert(h.fixture.events.some(event => event.type === 'click' && event.lane === 'alpha'),
        `CDP click did not reach the fixture: ${evidence.alphaToolResults.at(-1)}`)
      const clickRequest = h.model.requests.findLast(request =>
        request.body.messages.some(message => message.tool_calls?.some(call => call.function.name.endsWith('browser_click'))))
      const issued = h.model.responses.findLast(response => response.message?.tool_calls?.[0]?.function.name.endsWith('browser_click'))
      metrics.mcpClickToPageEventMs = h.fixture.events.findLast(event => event.type === 'click').at - issued.at
      evidence.clickRequestSeen = !!clickRequest
    })
    if (browse) await check('ghost cursor paints before agent input', async () => {
      evidence.ghostCursor = await h.app.evaluate(() => globalThis.__hermesDeskE2ECursor)
      assert(evidence.ghostCursor.some(cursor => cursor.opacity === '1' && cursor.label === 'Alpha' && cursor.visible),
        'Overlay cursor was not painted with the agent label')
      await writeFile(path.join(h.artifactDir, '03-ghost-cursor.png'), await readFile(path.join(h.root, 'ghost-cursor.png')))
      screenshots.push('03-ghost-cursor.png')
    })
    if (!browse && chat) {
      evidence.browserFailure = await h.app.evaluate(() => ({
        network: globalThis.__hermesDeskE2ENetwork,
        tabs: globalThis.__hermesDeskE2E.ws.lanes.allLanes().flatMap(lane =>
          globalThis.__hermesDeskE2E.ws.lanes.listTabs(lane.id).map(tab => ({
            laneId: lane.id, url: tab.url, liveUrl: tab.webContents?.getURL(), loading: tab.webContents?.isLoading(),
          }))),
      }))
      evidence.fixtureRequests = h.fixture.requests
      await capture('03-browser-failure')
    }
    if (browse) {
      await check('real user input pauses lane and model sees user_took_control; Resume', async () => {
        if ((await h.state()).control.paused) {
          await h.page.getByRole('button', { name: 'Resume agent' }).click()
        }
        const tab = (await h.state()).lanes.find(lane => lane.id === 'profile:alpha').tabs[0]
        await h.app.evaluate(({ webContents }, id) => {
          const tab = globalThis.__hermesDeskE2E.ws.lanes.getTab(id)
          // Electron native input, not a fabricated takeover event.
          tab.webContents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 })
          tab.webContents.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 })
        }, tab.id)
        await h.page.getByRole('button', { name: 'Resume agent' }).waitFor()
        await capture('04-paused')
        await h.send('alpha', 'takeover')
        await h.page.getByRole('group', { name: 'Message actions for Alpha' })
          .getByText('Takeover result:', { exact: false }).waitFor()
        await waitFor(() => h.model.requests.some(request =>
          request.body.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('user_took_control'))),
        'model takeover result')
        await h.page.getByRole('button', { name: 'Resume agent' }).click()
        assert.notEqual((await h.state()).lanes.find(lane => lane.id === 'profile:alpha').state, 'paused')
      })
      await check('Give to agent and Return to my workspace preserve the user partition', async () => {
        const id = await h.page.evaluate(url => window.nubAgent.workspace.openTab('you', url), `${h.fixture.url}/shared`)
        await h.page.evaluate(id => window.nubAgent.workspace.activate(id), id)
        const partition = await h.app.evaluate((_electron, id) => globalThis.__hermesDeskE2E.ws.lanes.getTab(id).partition, id)
        await h.page.getByRole('button', { name: 'Give to agent', exact: true }).click()
        await h.page.getByRole('button', { name: 'Give tab', exact: true }).click()
        await h.page.getByRole('button', { name: 'Return to my workspace', exact: true }).waitFor()
        await capture('05-shared-tab')
        await h.page.getByRole('button', { name: 'Return to my workspace', exact: true }).click()
        const moved = await h.app.evaluate((_electron, id) => {
          const tab = globalThis.__hermesDeskE2E.ws.lanes.getTab(id)
          return { partition: tab.partition, laneId: tab.laneId, sharedLogin: tab.sharedLogin }
        }, id)
        assert.deepEqual(moved, { partition, laneId: 'you', sharedLogin: false })
      })
      await check('login password never reaches the fake model', async () => {
        await h.page.evaluate(() => window.nubAgent.workspace.resumeAgent('profile:alpha'))
        await h.send('alpha', 'redaction')
        await h.page.getByRole('group', { name: 'Message actions for Alpha' })
          .getByText('Redaction verified: password value hidden.', { exact: false }).waitFor()
        assert(!JSON.stringify(h.model.requests).includes(FAKE_PASSWORD))
        assert(h.model.requests.some(request => request.body.messages.some(message =>
          message.role === 'tool' && /sensitive, value hidden/.test(JSON.stringify(message.content)))))
        const tab = (await h.state()).lanes.find(lane => lane.id === 'profile:alpha')
          .tabs.find(tab => tab.url === `${h.fixture.url}/login`)
        assert(tab, 'Expected the redacted login tab in the Alpha lane')
        await h.page.evaluate(id => window.nubAgent.workspace.activate(id), tab.id)
        await capture('06-redaction')
      })
      await check('beta browsing is isolated from alpha', async () => {
        if (options.diagnosticSeedTabs) {
          await h.page.evaluate(url => window.nubAgent.workspace.openTab('profile:beta', url), `${h.fixture.url}/initial-beta`)
          await waitFor(async () => (await h.state()).lanes.find(lane => lane.id === 'profile:beta')
            ?.tabs.some(tab => tab.title === PAGE_TITLE), 'diagnostic beta seeded tab load')
        }
        await h.send('beta', 'browse')
        await h.page.getByRole('group', { name: 'Message actions for Beta' })
          .getByText(`I browsed "${PAGE_TITLE}" in lane beta.`, { exact: false }).waitFor()
        const state = await h.state()
        const alpha = state.lanes.find(lane => lane.id === 'profile:alpha')
        const beta = state.lanes.find(lane => lane.id === 'profile:beta')
        assert(beta.tabs.some(tab => tab.url === `${h.fixture.url}/beta`))
        assert(alpha.tabs.every(tab => tab.url !== `${h.fixture.url}/beta`))
        assert(beta.tabs.every(tab => !tab.url.endsWith('/alpha') && !tab.url.endsWith('/login')))
        await capture('07-beta')
      })
      await check('alpha and beta stream in parallel without crosstalk', async () => {
        await h.send('alpha', 'parallel', 'alpha-parallel')
        await h.send('beta', 'parallel', 'beta-parallel')
        await waitFor(async () => (await h.app.evaluate(() =>
          globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length >= 2, 'two simultaneous live turns', 5000)
        await h.page.getByRole('group', { name: 'Message actions for Beta' })
          .getByText('Parallel streaming answer for beta-parallel.', { exact: false }).waitFor()
        assert.equal(await h.page.getByRole('group', { name: 'Message actions for Beta' })
          .getByText('Parallel streaming answer for alpha-parallel.', { exact: false }).count(), 0)
        await h.page.getByRole('button', { name: 'Alpha', exact: true }).click()
        await h.page.getByRole('group', { name: 'Message actions for Alpha' })
          .getByText('Parallel streaming answer for alpha-parallel.', { exact: false }).waitFor()
        assert.equal(await h.page.getByRole('group', { name: 'Message actions for Alpha' })
          .getByText('Parallel streaming answer for beta-parallel.', { exact: false }).count(), 0)
        // Visible text precedes message.complete. Finish this scenario before
        // the next submission, or the Stop fixture is steered into the old turn.
        await waitFor(async () => (await h.app.evaluate(() =>
          globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0,
        'parallel turns completed', 5000)
      })
    }
    if (chat) await check('command-period interrupts a live turn and pauses every lane', async () => {
      const before = h.model.requests.length
      await h.send('alpha', 'stop')
      await waitFor(() => h.model.requests.slice(before).some(request => request.body.stream &&
        request.body.messages.some(message => message.role === 'user' &&
          typeof message.content === 'string' && message.content.startsWith('E2E:stop'))), 'slow model request')
      evidence.stop = { activeBefore: await h.app.evaluate(() =>
        globalThis.__hermesDeskE2E.serveClient.getActiveTurns()) }
      assert(evidence.stop.activeBefore.some(turn => turn.profile === 'alpha'), 'No live Alpha turn to interrupt')
      await h.app.evaluate(() => {
        const client = globalThis.__hermesDeskE2E.serveClient
        const call = client.call
        globalThis.__e2eInterrupts = []
        client.call = async (...args) => {
          if (args[0] !== 'session.interrupt') return call(...args)
          const evidence = { sessionId: args[1]?.session_id, at: Date.now() }
          globalThis.__e2eInterrupts.push(evidence)
          try {
            const result = await call(...args)
            evidence.status = result?.status
            evidence.settledAt = Date.now()
            return result
          } catch (error) {
            evidence.rejected = true
            throw error
          }
        }
      })
      await h.page.evaluate(() => {
        window.__e2eStopKeys = []
        window.addEventListener('keydown', event => {
          if (event.code === 'Period') window.__e2eStopKeys.push({
            key: event.key, code: event.code, meta: event.metaKey, consumed: event.defaultPrevented,
          })
        })
      })
      const rpcStart = await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc.length)
      await h.page.keyboard.press('Meta+.')
      await waitFor(async () => (await h.app.evaluate(() =>
        globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'turn interrupted')
      const stopTraffic = await h.app.evaluate((_electron, start) => globalThis.__hermesDeskE2ERpc.slice(start), rpcStart)
      assert(stopTraffic.some(frame => frame.method === 'session.interrupt'), 'Stop sent no interrupt')
      assert(!stopTraffic.some(frame => frame.method === 'session.steer'), 'Stop queued takeover steering')
      const interrupted = await h.app.evaluate(() => globalThis.__hermesDeskE2EEvents
        .filter(event => event.name === 'message.complete' && event.status === 'interrupted'))
      const interruptAt = Math.min(...stopTraffic.filter(frame => frame.method === 'session.interrupt').map(frame => frame.at))
      assert(interrupted.some(event => event.at >= interruptAt &&
        evidence.stop.activeBefore.some(turn => turn.session_id === event.sessionId)),
        'Stop did not reach an interrupted completion')
      const state = await h.state()
      assert(state.lanes.every(lane => lane.state === 'paused'), 'Not every lane was paused')
      await capture('08-stopped')
    })
    await check('no fixture secrets or script errors in model requests', async () => {
      assert(!JSON.stringify(h.model.requests).includes(FAKE_PASSWORD))
      assert.deepEqual(h.model.errors, [])
    })
    if (roster) await check('Computer PiP opens as a completed-capture preview', async () => {
      await h.page.getByRole('button', { name: 'Open computer preview for Alpha' }).click()
      await h.page.getByRole('region', { name: 'Computer capture preview' }).waitFor()
      await h.page.getByText('This preview is not a live Mac feed.', { exact: true }).waitFor()
      await h.page.evaluate(() => window.nubAgent.computer.close())
      if (evidence.stop) assert.deepEqual(await h.app.evaluate(() =>
        globalThis.__hermesDeskE2E.serveClient.getActiveTurns()), [],
      'Stopped turns restarted during subsequent UI activity')
    })
    evidence.background = await h.app.evaluate(({ BrowserWindow, screen }) => {
      const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
      return { enabled: process.env.HERMES_DESK_E2E_BACKGROUND === '1',
        bounds: main.getBounds(), visible: main.isVisible(), focused: main.isFocused(), opacity: main.getOpacity(),
        displays: screen.getAllDisplays().map(display => display.bounds),
        windows: BrowserWindow.getAllWindows().map(win => ({
          title: win.getTitle(), bounds: win.getBounds(), focused: win.isFocused(), opacity: win.getOpacity(),
        })) }
    })
    if (evidence.background.enabled) await check('background E2E windows render without focus or visible desktop content', async () => {
      const { visible, focused, windows } = evidence.background
      assert.equal(visible, true)
      assert.equal(focused, false)
      assert(windows.every(win => !win.focused && win.opacity === 0), 'Background window can disturb the desktop')
    })
    evidence.modelRequests = h.model.requests.length
    evidence.streamingRequests = h.model.requests.filter(request => request.body.stream).length
    evidence.events = await h.app.evaluate(() => globalThis.__hermesDeskE2EEvents)
    evidence.nativeMouseEvents = await h.app.evaluate(() =>
      globalThis.__hermesDeskE2ENetwork.filter(event => event.type === 'mouse'))
    evidence.streamedDeltaCount = evidence.events.filter(event => event.name === 'message.delta').length
    evidence.consoleErrors = h.consoleErrors
    if (evidence.stop) {
      evidence.stop.activeAfter = await h.app.evaluate(() =>
        globalThis.__hermesDeskE2E.serveClient.getActiveTurns())
      evidence.stop.keys = await h.page.evaluate(() => window.__e2eStopKeys)
      evidence.stop.interrupts = await h.app.evaluate(() => globalThis.__e2eInterrupts)
    }
    evidence.rpc = await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc)
    evidence.workspace = await h.state()
    await writeFile(path.join(h.artifactDir, 'model-requests.json'), JSON.stringify(h.model.requests, null, 2))
    await writeFile(path.join(h.artifactDir, 'electron.txt'), h.logs.join(''))
    await writeFile(path.join(h.artifactDir, 'build.txt'), h.buildOutput)
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    await h.close()
  }
  const expectedCheckCount = 13 + (evidence.background?.enabled ? 1 : 0)
  const result = { passed: checks.every(check => check.passed) && checks.length === expectedCheckCount,
    skippedCheckCount: expectedCheckCount - checks.length,
    checks, metrics, screenshots, evidence, diagnosticSettingsAdapter: !!options.diagnosticSettingsAdapter,
    diagnosticSeedTabs: !!options.diagnosticSeedTabs,
    targets: { coldStartSidebarMs: 4000, firstTokenOverheadMs: 50, clickExcludingCursorMs: 150 },
    isolation: 'temporary HOME/HERMES_HOME/userData; empty credential environment; Hermes and shim in macOS loopback-only IP sandbox; Electron requests restricted to loopback; reserved backend binds denied' }
  await writeFile(path.join(h.artifactDir, 'result.json'), JSON.stringify(result, null, 2))
  return result
}
