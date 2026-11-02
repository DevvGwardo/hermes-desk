// Real Electron + real sandboxed Hermes + the existing deterministic fake model.
// Run sequentially: node tools/blueprint/perf.mjs
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron } from 'playwright-core'
import { launchHarness, repo, sandboxPolicy, waitFor } from '../../tests/e2e/harness.mjs'
import { createReport } from './lib/report.mjs'

const require = createRequire(import.meta.url)
const bp = createReport('perf')
bp.report.commit = process.env.BP_COMMIT || execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const out = bp.dir('perf')
const COUNT = 5
const samples = { spawned: [], attached: [], token: [], click: [], frames: [], rss: [] }
const httpErrors = []
bp.report.findings = []
bp.report.notYetTested = ['Optional 30-minute simulated memory churn', 'Packaged lifecycle',
  'Foreground frame pacing (all test windows stay invisible and nonfocusable)']
process.env.HERMES_DESK_E2E_VISIBLE = '0'
process.env.HERMES_DESK_E2E_BACKGROUND = '1'

function check(name, ok, detail, source, fix, size = 'M') {
  if (!bp.check(name, ok, detail)) bp.report.findings.push({
    id: `BP-PERF-${bp.report.findings.length + 1}`, userSees: name,
    check: name, measured: detail, suspectedSource: source, suggestedFix: fix, size,
  })
}
function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return { n: 0, median: null, p95: null }
  return { n: sorted.length, median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * .95) - 1] }
}
function timing(name, rows, key, limit, source, fix) {
  const values = rows.map(row => row[key])
  const summary = stats(values)
  bp.measure(name, { ...summary, samples: values }, 'ms', 'Five sequential trials; nearest-rank p95; failed/unavailable trials remain null')
  check(name, rows.length === COUNT && summary.n === COUNT && summary.p95 < limit,
    { targetMs: limit, ...summary, trials: rows }, source, fix)
}
function collect(h) {
  h.page.on('console', message => { if (message.type() === 'error') bp.consoleError(message.text()) })
  h.page.on('response', response => {
    if (response.status() < 400) return
    const url = new URL(response.url())
    httpErrors.push({ status: response.status(), path: url.pathname })
  })
}
function errors(h) {
  for (const error of h.consoleErrors) bp.consoleError(`pageerror: ${error}`)
}
async function screenshot(h, name) {
  const file = path.join(out, `${name}.png`)
  const png = await h.page.screenshot({ path: file, scale: 'device' })
  const evidence = await h.app.evaluate(({ nativeImage }, data) => {
    const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
    const pixels = image.toBitmap(), colors = new Set()
    for (let i = 0; i < pixels.length; i += 4 * 97) colors.add(pixels.subarray(i, i + 3).toString('hex'))
    return { size: image.getSize(), sampledColors: colors.size }
  }, png.toString('base64'))
  bp.measure(`Screenshot ${name}`, { file, ...evidence,
    deviceScaleFactor: await h.page.evaluate(() => devicePixelRatio) }, 'pixels',
  'Native window scale, Playwright device pixels; BGRA bitmap sampled every 97 pixels')
  check(`The ${name} capture contains rendered content`, evidence.sampledColors > 20,
    evidence, 'electron/main.cjs', 'Inspect renderer loading and window capture.', 'S')
}
async function visualChecks(h) {
  const result = await h.page.evaluate(() => {
    const pill = document.querySelector('.messenger-header-pill')
    const trailing = document.querySelector('.messenger-header-trailing')
    const a = pill.getBoundingClientRect(), b = trailing.getBoundingClientRect()
    const overlapWidth = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    const overlapHeight = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    const style = getComputedStyle(pill)
    const rgb = value => value.match(/[\d.]+/g).map(Number)
    const blend = (top, bottom) => top.slice(0, 3).map((value, i) => value * (top[3] ?? 1) + bottom[i] * (1 - (top[3] ?? 1)))
    const stack = []
    for (let node = pill; node; node = node.parentElement) stack.unshift(rgb(getComputedStyle(node).backgroundColor))
    let background = [255, 255, 255]
    for (const color of stack) background = blend(color, background)
    const foreground = blend(rgb(style.color), background)
    const lum = color => color.map(value => {
      const s = value / 255
      return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
    const l = [lum(foreground), lum(background)].sort((x, y) => x - y)
    return { overlapWidth, overlapHeight, overlapArea: overlapWidth * overlapHeight,
      pill: a.toJSON(), controls: b.toJSON(), contrast: (l[1] + .05) / (l[0] + .05),
      color: style.color, background, opacity: style.opacity }
  })
  check('The chat title does not overlap header notification and workspace controls', result.overlapArea === 0,
    result, 'src/styles/skin-messenger.css:171', 'Reserve header space for trailing controls instead of overlaying the centered title.', 'S')
  check('The chat title meets 4.5:1 text contrast', result.contrast >= 4.5, result,
    'src/styles/skin-messenger.css', 'Raise foreground/background contrast for the header title.', 'S')
}
async function tabScreenshot(h, name, tabId) {
  const image = await h.app.evaluate(async (_electron, id) => {
    const wc = globalThis.__hermesDeskE2E.ws.lanes.getTab(id).webContents
    return (await wc.capturePage()).toPNG().toString('base64')
  }, tabId)
  const png = Buffer.from(image, 'base64'), file = path.join(out, `${name}-tab.png`)
  await writeFile(file, png)
  bp.measure(`Native tab screenshot ${name}`, { file, width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
    'pixels', 'Sibling WebContentsView captured independently; app-renderer screenshots do not composite browser tabs')
}
async function sidebar(h) {
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  await h.page.getByRole('button', { name: 'Beta', exact: true }).waitFor()
  return performance.now() - h.launchedAt
}
async function idle(h) {
  await waitFor(() => h.app.evaluate(() => globalThis.__hermesDeskE2E.serveClient.getActiveTurns().length === 0),
    'all real serve turns complete', 45000)
}

async function firstToken(h, trial) {
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).click()
  const input = h.page.getByRole('textbox', { name: 'Message the agent' })
  await input.fill(`E2E:chat token-${trial}`)
  await h.page.evaluate(() => {
    const groups = () => [...document.querySelectorAll('[role=group]')]
      .filter(node => node.getAttribute('aria-label') === 'Message actions for Alpha')
    const old = new Set(groups())
    window.__bpToken = { visibleAt: null, submittedAt: null }
    const observer = new MutationObserver(() => {
      if (groups().some(node => !old.has(node) && node.textContent.includes('Fake str'))) {
        window.__bpToken.visibleAt = performance.timeOrigin + performance.now()
        observer.disconnect()
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    window.__bpTokenObserver = observer
    document.addEventListener('keydown', function submit(event) {
      if (event.key !== 'Enter') return
      window.__bpToken.submittedAt = performance.timeOrigin + performance.now()
      document.removeEventListener('keydown', submit, true)
    }, true)
  })
  const before = h.model.responses.length
  try {
    await input.press('Enter')
    await h.page.waitForFunction(() => window.__bpToken.visibleAt !== null)
    const observed = await h.page.evaluate(() => window.__bpToken)
    const first = await waitFor(() => h.model.responses.slice(before).find(row => row.firstToken), 'provider first content chunk')
    const providerAt = performance.timeOrigin + first.at
    samples.token.push({ trial, providerMs: providerAt - observed.submittedAt,
      visibleMs: observed.visibleAt - observed.submittedAt, overheadMs: observed.visibleAt - providerAt })
    await idle(h)
  } catch (error) {
    samples.token.push({ trial, overheadMs: null, error: error.message })
  } finally {
    await h.page.evaluate(() => window.__bpTokenObserver?.disconnect())
  }
}

async function frames(h, trial) {
  // Reuse the existing fake model's chat scenario. A long one-word label makes
  // a 4-KiB answer, emitted in its normal eight-character/15-ms content chunks.
  const label = `frame-${trial}-${'stream'.repeat(683)}`
  await h.page.evaluate(() => {
    const data = window.__bpFrames = { intervals: [], previous: null, running: false }
    const old = new Set(document.querySelectorAll('[role=group]'))
    const observer = new MutationObserver(() => {
      if (!data.running && [...document.querySelectorAll('[role=group]')].some(node =>
        !old.has(node) && node.getAttribute('aria-label') === 'Message actions for Alpha' &&
        node.textContent.includes('Fake str'))) {
        data.running = true
        const frame = at => {
          if (!data.running) return
          if (data.previous !== null) data.intervals.push(at - data.previous)
          data.previous = at
          requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
        observer.disconnect()
      }
    })
    observer.observe(document.body, { childList: true, characterData: true, subtree: true })
    window.__bpFrameObserver = observer
  })
  const before = h.model.responses.length
  try {
    await h.send('alpha', 'chat', label)
    await waitFor(() => h.model.responses.slice(before).some(row => row.streaming && row.message?.content?.includes(label)),
      'complete long fake-model answer', 45000)
    await idle(h)
    const data = await h.page.evaluate(() => {
      window.__bpFrames.running = false
      window.__bpFrameObserver.disconnect()
      return window.__bpFrames.intervals
    })
    samples.frames.push({ trial, answerCharacters: label.length + 57, ...stats(data),
      max: data.length ? Math.max(...data) : null, over50ms: data.filter(value => value > 50).length, intervals: data })
    if (trial === 1) await screenshot(h, '02-long-stream')
  } catch (error) {
    samples.frames.push({ trial, n: 0, median: null, p95: null, error: error.message })
  } finally {
    await h.page.evaluate(() => { window.__bpFrames.running = false; window.__bpFrameObserver.disconnect() })
  }
}

async function mcpClick(h, trial) {
  // User-opened initialized tab is legitimate setup, not proof of the first
  // empty agent-tab initialization path. No Settings or takeover adapter.
  const lane = `click-${trial}`
  await h.page.evaluate(() => window.nubAgent.workspace.resumeAgent('profile:alpha'))
  const tabId = await h.page.evaluate(url => window.nubAgent.workspace.openTab('profile:alpha', url), `${h.fixture.url}/${lane}`)
  await waitFor(() => h.fixture.events.some(row => row.type === 'load' && row.lane === lane), 'click fixture loaded')
  await h.page.evaluate(id => window.nubAgent.workspace.activate(id), tabId)
  const entry = h.entries.find(([profile]) => profile === 'alpha')[1]
  const { createConnection } = await import('node:net')
  const client = createConnection(entry.args.at(-1))
  client.on('error', () => {})
  const pending = new Map()
  let buffer = '', sequence = 0
  client.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n'), frame = JSON.parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      pending.get(frame.id)?.(frame)
    }
  })
  function rpc(method, params) {
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timeout`)) }, 35000)
      pending.set(id, frame => { clearTimeout(timer); pending.delete(id); resolve(frame) })
      client.write(`${JSON.stringify({ id, method, params: { profile: 'alpha', ...params } })}\n`)
    })
  }
  try {
    await once(client, 'connect')
    const hello = await rpc('hello', { shimVersion: 'blueprint', pid: process.pid, token: entry.env.HERMES_DESK_MCP_TOKEN })
    if (hello.error) throw new Error(`hello: ${hello.error.code}`)
    const snap = await rpc('tools/call', { name: 'browser_snapshot', arguments: {}, callId: `snapshot-${trial}` })
    const ref = snap.result?.content?.find(row => row.type === 'text')?.text
      .split('\n').find(line => line.includes('Record click'))?.match(/ref=(e\d+)/)?.[1]
    if (!ref) throw new Error(`snapshot: ${snap.error?.code || snap.result?.content?.[0]?.text || 'missing ref'}`)
    // Observe, never change, the real overlay paint wait. Subtract only its
    // measured duration; do not blindly subtract the spec's nominal 250 ms.
    await h.app.evaluate(() => {
      const overlay = globalThis.__hermesDeskE2E.ws.parts.overlay
      const original = overlay.waitFrame
      globalThis.__bpOriginalWaitFrame = original
      globalThis.__bpPaintWaitMs = 0
      overlay.waitFrame = async (...args) => {
        const start = performance.now()
        try { return await original.apply(overlay, args) }
        finally { globalThis.__bpPaintWaitMs += performance.now() - start }
      }
    })
    const start = performance.now()
    const result = await rpc('tools/call', { name: 'browser_click', arguments: { ref }, callId: `click-${trial}` })
    const waitMs = await h.app.evaluate(() => {
      const overlay = globalThis.__hermesDeskE2E.ws.parts.overlay
      overlay.waitFrame = globalThis.__bpOriginalWaitFrame
      return globalThis.__bpPaintWaitMs
    })
    const event = h.fixture.events.find(row => row.type === 'click' && row.lane === lane)
    const failure = result.error?.code || (result.result?.isError ? result.result.content[0].text : null)
    samples.click.push({ trial, elapsedMs: event ? event.at - start : null,
      overlayWaitMs: waitMs, excludingAnimationMs: event && !failure ? event.at - start - waitMs : null,
      result: failure || 'clicked', pageEvent: Boolean(event) })
    if (trial === 1) {
      await screenshot(h, '03-mcp-click')
      await tabScreenshot(h, '03-mcp-click', tabId)
    }
  } catch (error) {
    samples.click.push({ trial, excludingAnimationMs: null, pageEvent: false, error: error.message })
  } finally {
    client.destroy()
    await h.page.evaluate(id => window.nubAgent.workspace.closeTab(id), tabId)
  }
}

async function memory(h) {
  for (const profile of ['gamma', 'delta', 'epsilon']) {
    const home = path.join(h.env.HERMES_HOME, 'profiles', profile)
    const { mkdir, copyFile } = await import('node:fs/promises')
    await mkdir(home, { recursive: true })
    for (const file of ['config.yaml', '.env']) await copyFile(path.join(h.env.HERMES_HOME, 'profiles/alpha', file), path.join(home, file))
    await writeFile(path.join(home, 'SOUL.md'), `Disposable ${profile} benchmark agent.\n`)
    await writeFile(path.join(home, 'profile.yaml'), `ui_meta:\n  display_name: ${profile[0].toUpperCase() + profile.slice(1)}\n`)
  }
  await h.page.reload()
  await sidebar(h)
  await h.page.getByRole('button', { name: 'Gamma', exact: true }).waitFor()
  const profiles = ['default', 'alpha', 'beta', 'gamma', 'delta', 'epsilon']
  for (const profile of profiles) for (let index = 0; index < 3; index++) {
    await h.page.evaluate(({ lane, url }) => window.nubAgent.workspace.openTab(lane, url),
      { lane: `profile:${profile}`, url: `${h.fixture.url}/rss-${profile}-${index}` })
  }
  await waitFor(() => h.fixture.events.filter(row => row.type === 'load' && row.lane.startsWith('rss-')).length === 18,
    'all eighteen real fixture tabs loaded')
  await idle(h)
  const population = await h.app.evaluate(() => {
    const lanes = globalThis.__hermesDeskE2E.ws.lanes
    return lanes.allLanes().filter(lane => lane.kind === 'agent').map(lane => ({
      lane: lane.id, tabs: lanes.listTabs(lane.id).map(tab => ({
        live: Boolean(tab.webContents && !tab.webContents.isDestroyed()), discarded: tab.discarded,
        throttled: tab.webContents?.getBackgroundThrottling(),
      })),
    }))
  })
  const ready = population.length === 6 && population.every(row => row.tabs.length === 3 && row.tabs.every(tab => tab.live && !tab.discarded))
  check('Six agents retain three live tabs each at idle', ready, population,
    'electron/local/workspace/lanes.cjs', 'Correct tab limits or initialization so all eighteen fixture tabs stay live.')
  for (let trial = 1; trial <= COUNT; trial++) {
    // Explicit idle sampling window, not an app-ready sleep.
    await delay(1000)
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,rss='], { encoding: 'utf8' })
      .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
    const serves = (await readFile(path.join(h.root, 'serve-pids.txt'), 'utf8')).trim().split('\n').map(Number)
    const owned = new Set([h.app.process().pid])
    for (const row of rows) if (serves.includes(row[2])) owned.add(row[0])
    let changed
    do {
      changed = false
      for (const [pid, ppid] of rows) if (owned.has(ppid) && !owned.has(pid)) { owned.add(pid); changed = true }
    } while (changed)
    const processes = rows.filter(row => owned.has(row[0])).map(([pid, ppid, pgid, rssKiB]) => ({ pid, ppid, pgid, rssKiB }))
    samples.rss.push({ trial, bytes: processes.reduce((sum, row) => sum + row.rssKiB * 1024, 0), processes })
  }
  const summary = stats(samples.rss.map(row => row.bytes))
  bp.measure('Idle total RSS, six agents and eighteen tabs', { ...summary, samples: samples.rss }, 'bytes',
    'Five one-second-spaced ps RSS snapshots; entire Electron descendant tree plus detached owned Hermes process groups; excludes the Node harness/fake provider')
  check('Six agents with three tabs each use less than 1.2 GB idle RSS',
    ready && summary.n === COUNT && summary.p95 < 1_200_000_000, { targetBytes: 1_200_000_000, ...summary },
    'electron/local/workspace/views.cjs:113', 'Profile per-view memory and reduce idle renderer or backend footprint.')
  await screenshot(h, '04-six-agents-eighteen-tabs')
  const tabId = await h.app.evaluate(() => {
    const lanes = globalThis.__hermesDeskE2E.ws.lanes
    return lanes.getActiveTab(lanes.focusedLaneId).id
  })
  await tabScreenshot(h, '04-six-agents-eighteen-tabs', tabId)
}

async function attached(h) {
  const settingsFile = path.join(h.root, 'userData/settings.json')
  const config = JSON.parse(await readFile(settingsFile, 'utf8'))
  const { freeServePort } = require('../../electron/local/hermes-host.cjs')
  const port = await freeServePort(9300)
  const source = process.env.HERMES_E2E_SOURCE || '/Users/devgwardo/.hermes/hermes-agent'
  const token = 'obviously-fake-blueprint-attached-serve-token'
  await h.app.close()
  const backend = spawn('/usr/bin/sandbox-exec', ['-p', sandboxPolicy(h.root, source),
    path.join(h.root, 'bin/hermes'), 'serve', '--host', '127.0.0.1', '--port', String(port)],
  { cwd: h.root, env: { ...h.env, HERMES_DESKTOP: '1', HERMES_DASHBOARD_SESSION_TOKEN: token },
    detached: true, stdio: 'ignore' })
  let app
  try {
    await waitFor(async () => {
      if (backend.exitCode !== null) throw new Error('Disposable attached backend exited')
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
          headers: { 'X-Hermes-Session-Token': token }, signal: AbortSignal.timeout(1000) })
        return response.ok
      } catch { return false }
    }, 'external isolated real serve ready', 30000)
    await writeFile(settingsFile, JSON.stringify({ ...config, serve: { mode: 'attach', port } }))
    for (let trial = 1; trial <= COUNT; trial++) {
      const start = performance.now()
      app = await electron.launch({ executablePath: require('electron'),
        args: [path.join(h.root, 'entry.cjs'), '--force-device-scale-factor=2'], cwd: h.root,
        env: { ...h.env, HERMES_DASHBOARD_SESSION_TOKEN: token }, timeout: 45000 })
      const page = await waitFor(() => app.windows().find(win => win.url().startsWith(h.env.VITE_DEV_SERVER_URL)), 'attached renderer')
      page.on('console', message => { if (message.type() === 'error') bp.consoleError(message.text()) })
      page.on('pageerror', error => bp.consoleError(`pageerror: ${error.message}`))
      page.on('response', response => {
        if (response.status() >= 400) httpErrors.push({ status: response.status(), path: new URL(response.url()).pathname })
      })
      const result = await waitFor(async () => {
        const status = await app.evaluate(() => globalThis.__hermesDeskE2E.hermesHost.status())
        const populated = await page.getByRole('button', { name: 'Alpha', exact: true }).count() > 0 &&
          await page.getByRole('button', { name: 'Beta', exact: true }).count() > 0
        if (status.serve.state === 'up' && status.serve.mode === 'attached' && populated) return { ms: performance.now() - start, status }
        if (status.serve.state === 'down' && status.serve.detail) return { ms: null, refusalMs: performance.now() - start, status }
        return false
      }, 'attached sidebar or explicit attach refusal', 10000)
      samples.attached.push({ trial, ...result })
      if (trial === 1) {
        await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).waitFor()
        await screenshot({ app, page }, '05-attached-refusal')
      }
      await app.close()
      app = null
    }
  } finally {
    if (app) await app.close()
    try { process.kill(-backend.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    if (backend.exitCode === null) await Promise.race([once(backend, 'exit'), delay(3000)])
    try { process.kill(-backend.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}

let current
try {
  bp.measure('Machine model', execFileSync('/usr/sbin/sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).trim(),
    'model', 'sysctl hw.model')
  bp.measure('macOS', execFileSync('/usr/bin/sw_vers', [], { encoding: 'utf8' }).trim(), 'version', 'sw_vers')
  bp.measure('Physical memory', Number(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' })), 'bytes', 'sysctl hw.memsize')
  bp.measure('Automation hook', '__hermesDesk is absent in this checkout; existing window.nubAgent IPC and the disposable main-only E2E seam are used',
    'scope', 'No product hook or product code added')
  for (let trial = 1; trial <= COUNT; trial++) {
    console.log(`\nSequential spawned trial ${trial}/${COUNT}`)
    current = await launchHarness()
    collect(current)
    samples.spawned.push({ trial, ms: await sidebar(current) })
    if (trial === 1) {
      await screenshot(current, '01-sidebar')
      await visualChecks(current)
    }
    await firstToken(current, trial)
    await frames(current, trial)
    const toggle = current.page.getByRole('button', { name: 'Toggle workspace' })
    if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
    await mcpClick(current, trial)
    errors(current)
    if (trial !== COUNT) { await current.close(); current = null }
  }
  await memory(current)
  await attached(current)
} catch (error) {
  check('Performance evidence completes without a harness interruption', false, error.stack,
    'tools/blueprint/perf.mjs', 'Resolve the recorded harness/environment interruption and rerun.', 'S')
} finally {
  if (current) {
    try { await current.close() } catch (error) {
      check('Performance fixtures and processes cleanly shut down', false, error.message,
        'tests/e2e/harness.mjs', 'Reap only the owned fixture processes.', 'S')
    }
  }
  timing('Spawned serve populates the sidebar within four seconds', samples.spawned, 'ms', 4000,
    'electron/local/hermes-host.cjs:221', 'Profile cold backend initialization and roster hydration.')
  timing('Attached serve populates the sidebar within 1.5 seconds', samples.attached, 'ms', 1500,
    'electron/local/hermes-host.cjs:187', 'Design authenticated peer attachment or explicitly revise the unsupported attach promise.')
  timing('First visible token adds less than 50 ms to the fake provider first chunk', samples.token, 'overheadMs', 50,
    'src/lib/agents/hermes-local-transport.ts', 'Profile serve emission, IPC and streaming message batching.')
  bp.measure('First-token workflow latency', { provider: stats(samples.token.map(row => row.providerMs)),
    visible: stats(samples.token.map(row => row.visibleMs)), trials: samples.token }, 'ms',
  'Renderer Enter capture to provider first content chunk and first assistant DOM text mutation; common epoch clocks, no polling latency in timestamps')
  bp.measure('Attached-serve refusal latency', stats(samples.attached.map(row => row.refusalMs)), 'ms',
    'Five cold Electron processes with an independently ready real isolated serve; refusal timing is NOT sidebar readiness timing')
  timing('An MCP click reaches the page within 150 ms excluding measured overlay wait', samples.click, 'excludingAnimationMs', 150,
    'electron/local/workspace/takeover.cjs', 'Distinguish agent-generated CDP input from genuine user takeover.')
  bp.measure('Renderer frame intervals during five long answers', {
    trials: samples.frames.map(({ intervals, ...row }) => row),
    pooled: stats(samples.frames.flatMap(row => row.intervals || [])),
    perTrialP95: stats(samples.frames.map(row => row.p95)),
  }, 'ms', 'requestAnimationFrame intervals from first content mutation until the real serve turn completes; no invented frame-time SLO')
  check('Five long answers finish while the renderer continues producing frames',
    samples.frames.length === COUNT && samples.frames.every(row => row.n > 2),
    samples.frames.map(({ intervals, ...row }) => row), 'electron/main.cjs',
    'Inspect live-turn background throttling and streaming renderer stalls.')
  check('No console errors', bp.report.console.length === 0, bp.report.console,
    'electron/serve-auth.cjs:247', 'Preserve useful upstream status codes; handle unsupported notification and mark-read routes without noisy failed requests.')
  bp.measure('Failed renderer HTTP requests', httpErrors, 'responses', 'Response status and path only, never authentication headers or query values')
  await writeFile(path.join(out, 'samples.json'), JSON.stringify(samples, null, 2))
  bp.finish()
}
