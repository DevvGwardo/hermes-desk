// Opt-in red-team receipts plus live checks against an isolated real app.
// node tools/blueprint/security.mjs (run after perf.mjs, never concurrently)
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { launchHarness, repo, waitFor } from '../../tests/e2e/harness.mjs'
import { createReport } from './lib/report.mjs'

const require = createRequire(import.meta.url)
const bp = createReport('security')
bp.report.commit = process.env.BP_COMMIT || execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const out = bp.dir('security')
bp.report.findings = []
bp.report.notYetTested = ['Hostile same-UID isolation is not provided by Unix modes/profile tokens',
  'DNS rebinding and resolved-destination enforcement', 'Packaged app lifecycle and real account authority',
  'Canvas/video/closed-shadow-root secret detection', 'Real credentials, TCC, microphone and 1Password']
process.env.HERMES_DESK_E2E_VISIBLE = '0'
process.env.HERMES_DESK_E2E_BACKGROUND = '1'

function check(name, ok, detail, source, fix, size = 'M') {
  if (!bp.check(name, ok, detail)) bp.report.findings.push({
    id: `BP-SECURITY-${bp.report.findings.length + 1}`, userSees: name,
    check: name, measured: detail, suspectedSource: source, suggestedFix: fix, size,
  })
}
const flags = Object.fromEntries(['HERMES_DESK_REDTEAM_PROBES', 'HERMES_DESK_REDTEAM_ELECTRON',
  'HERMES_DESK_REDACTION_PIXELS', 'HERMES_DESK_TOOL_SEARCH_PROBE', 'HERMES_DESK_REVIEW_BOUNDARIES',
  'HERMES_DESK_MCP_HERMES_LOAD'].map(name => [name, '1']))

async function suites() {
  const receipt = path.join(out, 'vitest.json')
  const args = [path.join(repo, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/redteam',
    'electron/security-invariants.test.mjs', 'electron/local/mcp', 'electron/main.test.mjs',
    'electron/local/hermes-host.test.mjs', 'electron/local/serve-client.test.mjs',
    'electron/serve-peer.test.mjs', 'electron/serve-auth.test.mjs',
    '--maxWorkers=1', '--fileParallelism=false',
    '--reporter=json', `--outputFile=${receipt}`]
  // The Tool Search probe resolves installed read-only source via os.homedir().
  // Every probe creates its own temp state; the runner inherits no provider keys.
  const child = spawn(process.execPath, args, { cwd: repo, env: {
    HOME: os.homedir(), PATH: process.env.PATH, TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8',
    HERMES_DESK_E2E_BACKGROUND: '1', HERMES_DISABLE_LAZY_INSTALLS: '1', ...flags,
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000)
  let code
  try { [code] = await once(child, 'close') } finally { clearTimeout(timer) }
  await writeFile(path.join(out, 'vitest.txt'), output)
  const results = JSON.parse(await readFile(receipt, 'utf8'))
  const tests = results.testResults.flatMap(file => file.assertionResults.map(test => ({ ...test, file: file.name })))
  const fixedNames = {
    'HD-01': 'HD-01: Approved secret fills and their later metadata echoes stay hidden',
    'HD-02': 'HD-02: Form and editable ancestry reach snapshot redaction',
    'HD-03': 'HD-03: Layout changes cannot expose pixels outside stale screenshot masks',
    'HD-04': 'HD-04: Detected transactions require native consent for mouse and keyboard input',
    'HD-05': 'HD-05: Literal loopback aliases cannot reach the agent control plane',
    'HD-07': 'HD-07: MCP bounds aggregate connections, buffers, replies and queued work',
    'HD-08': 'HD-08: Renderer RPC and REST cannot return secret-bearing configuration',
    'HD-09': 'HD-09: Popup external links require default-deny native consent',
    'HD-10': 'HD-10: Serve peer ownership is verified before any token is sent',
    'HD-11': 'HD-11: Concurrent serve socket admissions cannot exceed capacity',
  }
  const hdIds = test => {
    const match = /^HD-(\d\d)(?:\/(\d\d))?/.exec(test.title)
    return match ? match.slice(1).filter(Boolean).map(id => `HD-${id}`) : []
  }
  bp.report.hd06Probes = tests.filter(test => hdIds(test).includes('HD-06')).map(row => ({
    name: row.title, status: row.status, durationMs: row.duration, failures: row.failureMessages,
  }))
  for (const [id, name] of Object.entries(fixedNames)) {
    const rows = tests.filter(test => hdIds(test).includes(id))
    check(name, rows.length > 0 && rows.every(test => test.status === 'passed'),
      { state: rows.length > 0 && rows.every(test => test.status === 'passed') ? 'fixed (bounded probe coverage)' : 'open (verification blocked by failed probes)',
        probes: rows.map(row => ({ name: row.title, status: row.status, durationMs: row.duration, failures: row.failureMessages })) },
      id === 'HD-01' ? 'tests/redteam/hermes-desk.test.ts:78' :
        id === 'HD-05' ? 'electron/local/workspace/url-policy.cjs' :
          ['HD-07'].includes(id) ? 'electron/local/mcp/socket-server.cjs' :
            ['HD-08', 'HD-09', 'HD-10', 'HD-11'].includes(id) ? 'electron/serve-auth.cjs' :
              'electron/local/workspace/cdp-exec.cjs',
      id === 'HD-01' ? 'Update the unowned probe fixture to support bound-node fill CDP calls, then rerun unchanged secret-echo assertions; do not infer a leak from fail-closed refusal.' :
        'Resolve the failing probe without weakening its expected invariant.')
  }
  const other = tests.filter(test => !/^HD-\d/.test(test.title) && !test.file.endsWith('review-boundaries.test.ts'))
  for (const row of other) check(row.title, row.status === 'passed',
    { status: row.status, durationMs: row.duration, failures: row.failureMessages },
    path.relative(repo, row.file), 'Investigate the recorded security invariant failure.')
  const boundaries = tests.filter(test => test.file.endsWith('review-boundaries.test.ts'))
  for (const row of boundaries) {
    // These tests assert the EXPOSURE. A passing exposure receipt is a failing
    // security promise, not evidence of a repaired vulnerability.
    const stderr = row.title.includes('stderr')
    check(stderr ? 'Host diagnostics do not expose credential-shaped stderr tails'
      : 'Hermes discovery rejects launchers in world-writable ancestry',
    false, { state: 'open', exposureProbe: row.title, status: row.status,
      confirmedExposure: row.status === 'passed', failures: row.failureMessages },
    stderr ? 'electron/local/hermes-host.cjs:133' : 'electron/local/hermes-host.cjs:16',
    stderr ? 'Scrub whole stderr records in main before status IPC or omit raw diagnostic exports.'
      : 'Validate trusted launcher provenance, owner and ancestry, then bind validation to execution.')
  }
  check('Every opt-in red-team probe and Electron invariant actually runs',
    [0, 1].includes(code) && tests.length > 0 && tests.every(test => ['passed', 'failed'].includes(test.status)) &&
      boundaries.length === 2 && bp.report.hd06Probes.length > 0 &&
      Object.keys(fixedNames).every(id => tests.some(test => hdIds(test).includes(id))),
    { exitCode: code, flags, passed: tests.filter(test => test.status === 'passed').length,
      total: tests.length, omitted: tests.filter(test => !['passed', 'failed'].includes(test.status)).map(test => test.title) },
    'tests/redteam', 'Enable every opt-in flag and resolve missing/failing probes.', 'S')
  bp.measure('Security suite', { total: tests.length, passed: tests.filter(test => test.status === 'passed').length,
    flags, receipt, command: [process.execPath, ...args] }, 'tests',
  'Vitest JSON assertions, sequential workers; exposure receipts are separately marked open')
}

async function exchange(socketPath, frames, { expectClose = false } = {}) {
  const client = createConnection(socketPath)
  let buffer = '', closed = false
  const replies = []
  client.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n')
      replies.push(JSON.parse(buffer.slice(0, newline)))
      buffer = buffer.slice(newline + 1)
    }
  })
  client.on('error', () => {})
  client.on('close', () => { closed = true })
  try {
    await once(client, 'connect')
    for (const frame of frames) {
      const before = replies.length
      client.write(typeof frame === 'string' ? frame : `${JSON.stringify(frame)}\n`)
      await waitFor(() => replies.length > before || closed, 'MCP reply or connection close', 10000)
    }
    if (expectClose) await waitFor(() => closed, 'rejected socket closed', 2000)
    return { replies, closed }
  } finally { client.destroy() }
}

async function live() {
  const h = await launchHarness()
  h.page.on('console', message => { if (message.type() === 'error') bp.consoleError(message.text()) })
  let app
  try {
    await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
    await h.app.close()
    // Main-only observation of the app's own synthetic per-launch token.
    // Never send the comparison token to a renderer or return it in evidence.
    const entryFile = path.join(h.root, 'entry.cjs')
    const entry = await readFile(entryFile, 'utf8')
    const anchor = 'const result = globalThis.__hermesDeskE2E = boot(ctx)'
    if (!entry.includes(anchor)) throw new Error('Existing E2E launcher boot anchor changed')
    await writeFile(entryFile, entry.replace(anchor, `const setEndpoint = ctx.serveAuth.setEndpoint
  ctx.serveAuth.setEndpoint = async options => {
    globalThis.__bpServeToken = options.auth.token
    return setEndpoint.call(ctx.serveAuth, options)
  }
  ${anchor}`))
    app = await electron.launch({ executablePath: require('electron'),
      args: [entryFile, '--force-device-scale-factor=2'], cwd: h.root, env: h.env, timeout: 45000 })
    const page = await waitFor(() => app.windows().find(win => win.url().startsWith(h.env.VITE_DEV_SERVER_URL)), 'security renderer')
    const consoleErrors = []
    const httpErrors = []
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`))
    page.on('response', response => {
      if (response.status() >= 400) httpErrors.push({ status: response.status(), path: new URL(response.url()).pathname })
    })
    await page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Beta', exact: true }).waitFor()
    const rendererScan = async () => {
      const seen = new WeakSet(), strings = [], skipped = []
      let objects = 0, properties = 0
      function walk(value, label, depth = 0) {
        if (typeof value === 'string') { strings.push([label, value]); return }
        if (value === null || !['object', 'function'].includes(typeof value) || seen.has(value)) return
        if (depth > 8 || objects >= 25000) { skipped.push(label); return }
        seen.add(value); objects++
        let descriptors
        try { descriptors = Object.getOwnPropertyDescriptors(value) } catch { skipped.push(label); return }
        for (const [key, descriptor] of Object.entries(descriptors)) {
          properties++
          if ('value' in descriptor) walk(descriptor.value, `${label}.${key}`, depth + 1)
          else if (depth === 0) {
            // Window storage/location getters are known read-only. Do not
            // execute arbitrary application getter/function code.
            if (['localStorage', 'sessionStorage', 'location', 'document'].includes(key)) {
              try { walk(value[key], `${label}.${key}`, depth + 1) } catch { skipped.push(label + '.' + key) }
            }
          }
        }
      }
      walk(window, 'window')
      for (const [name, storage] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]]) {
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index)
          strings.push([`${name}.${key}`, storage.getItem(key)])
        }
      }
      strings.push(['document.cookie', document.cookie], ['document.html', document.documentElement.outerHTML],
        ['location.href', location.href])
      const bridge = {}
      for (const [name, request] of Object.entries({
        serveConfig: () => window.nubAgent.serveConfig(),
        hostStatus: () => window.nubAgent.host.status(),
        hostConfig: () => window.nubAgent.host.getConfig(),
        workspace: () => window.nubAgent.workspace.list(),
      })) {
        try { bridge[name] = await request() } catch (error) { bridge[name] = { error: error.message } }
      }
      strings.push(['bridge.responses', JSON.stringify(bridge)])
      let databaseCount = 0, indexedRecords = 0
      if (indexedDB.databases) for (const info of await indexedDB.databases()) {
        if (!info.name) continue
        databaseCount++
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(info.name)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        try {
          for (const store of db.objectStoreNames) {
            const records = await new Promise((resolve, reject) => {
              const request = db.transaction(store).objectStore(store).getAll()
              request.onsuccess = () => resolve(request.result)
              request.onerror = () => reject(request.error)
            })
            indexedRecords += records.length
            strings.push([`indexedDB.${info.name}.${store}`, JSON.stringify(records)])
          }
        } finally { db.close() }
      }
      let cacheCount = 0
      for (const name of await caches.keys()) {
        const cache = await caches.open(name)
        for (const request of await cache.keys()) {
          cacheCount++
          strings.push([`cache.${name}.url`, request.url])
          strings.push([`cache.${name}.body`, await (await cache.match(request)).text()])
        }
      }
      return { strings, objects, properties, skipped, databaseCount, indexedRecords, cacheCount }
    }
    const leak = await app.evaluate(async ({ webContents }, scan) => {
      const token = globalThis.__bpServeToken
      const main = webContents.getAllWebContents().find(wc => wc.getURL().startsWith('http://127.0.0.1:'))
      const result = await main.executeJavaScript(`(${scan})()`)
      const variants = token ? [token, encodeURIComponent(token), Buffer.from(token).toString('base64')] : []
      // Values are compared IN MAIN and discarded. Evidence contains paths and
      // counts only, never the synthetic token or renderer storage contents.
      return { tokenPresentInMain: typeof token === 'string' && token.length >= 32,
        matches: result.strings.filter(([, value]) => typeof value === 'string' &&
          variants.some(variant => value.includes(variant))).map(([label]) => label),
        objects: result.objects, properties: result.properties, strings: result.strings.length,
        skippedCount: result.skipped.length, skippedExamples: result.skipped.slice(0, 10), databaseCount: result.databaseCount,
        indexedRecords: result.indexedRecords, cacheCount: result.cacheCount }
    }, rendererScan.toString())
    check('The renderer cannot read the active serve token from globals, bridge responses or storage',
      leak.tokenPresentInMain && leak.matches.length === 0, leak, 'electron/serve-auth.cjs',
      'Keep bearer credentials in main and project all renderer-facing results without credentials.')
    bp.measure('Serve token scan scope', 'Reachable own data descriptors through depth 8/25000 objects, known storage getters, cookies, DOM, IPC, IndexedDB and CacheStorage; JS lexical closures and arbitrary getters are not exhaustively introspectable',
      'scope', 'Exact raw/URL/base64 comparison occurs only in main; no bearer is returned to the harness or renderer')
    const socketPath = await app.evaluate(() => globalThis.__hermesDeskE2E.mcp.status().socketPath)
    const socket = await stat(socketPath), dir = await stat(path.dirname(socketPath))
    check('The MCP socket is private to its owner (0600)', socket.isSocket() && (socket.mode & 0o777) === 0o600,
      { mode: (socket.mode & 0o777).toString(8), socket: socket.isSocket() },
      'electron/local/mcp/socket-server.cjs', 'Apply socket mode 0600 before accepting connections.', 'S')
    check('The MCP directory is private to its owner (0700)', dir.isDirectory() && (dir.mode & 0o777) === 0o700,
      { mode: (dir.mode & 0o777).toString(8), directory: dir.isDirectory() },
      'electron/local/mcp/socket-server.cjs', 'Validate directory ownership and enforce mode 0700.', 'S')
    const hello = token => ({ id: 1, method: 'hello',
      params: { profile: 'alpha', shimVersion: 'blueprint', pid: process.pid, ...(token ? { token } : {}) } })
    for (const [name, token] of [['without a profile token', null], ['with an incorrect profile token', 'obviously-fake-wrong-token']]) {
      const result = await exchange(socketPath, [hello(token), { id: 2, method: 'tools/list', params: { profile: 'alpha' } }])
      check(`MCP hello ${name} refuses admission and subsequent tool listing`,
        result.replies.length === 2 && result.replies.every(reply => reply.error?.code === 'blocked_by_policy'), result,
        'electron/local/mcp/socket-server.cjs', 'Require the correct profile credential before hello admission or tool access.')
    }
    // Read only our disposable config authority. Never persist/log the token.
    const token = h.entries.find(([profile]) => profile === 'alpha')[1].env.HERMES_DESK_MCP_TOKEN
    const admitted = token && await exchange(socketPath, [hello(token)])
    check('A correct disposable profile credential is admitted (negative probes have a live positive control)',
      admitted?.replies[0]?.result?.protocol === 1, { admitted: Boolean(admitted?.replies[0]?.result), response: admitted?.replies[0] },
      'electron/local/mcp/profile-tokens.cjs', 'Restore profile admission before claiming missing/wrong-token refusals as meaningful.')
    const readableToken = JSON.parse(await readFile(path.join(path.dirname(socketPath), 'profile-tokens.json'), 'utf8')).profiles.alpha
    const sameUid = await exchange(socketPath, [hello(readableToken)])
    check('HD-06: MCP profile authority resists hostile code running as the same OS user',
      false, { state: 'open (documented trust-model boundary)', credentialFileReadableBySameUid: Boolean(readableToken),
        readableCredentialAdmitted: sameUid.replies[0]?.result?.protocol === 1, credentialRegressions: bp.report.hd06Probes },
      'electron/local/mcp/profile-tokens.cjs:18', 'Explicitly accept same-UID trust or add an OS identity/sandbox boundary; chmod and bearer tokens are not that boundary.', 'L')
    const { MAX_LINE_BYTES } = require('../../electron/local/mcp/socket-server.cjs')
    const oversize = await exchange(socketPath, ['x'.repeat(MAX_LINE_BYTES + 1)], { expectClose: true })
    check('Oversize NDJSON is refused and its connection is closed',
      oversize.closed && oversize.replies.some(reply => reply.error?.code === 'resource_limit'),
      { sentBytes: MAX_LINE_BYTES + 1, limitBytes: MAX_LINE_BYTES, ...oversize },
      'electron/local/mcp/socket-server.cjs', 'Bound frame bytes before allocation and close the rejected connection.')
    const debug = await app.evaluate(({ app }) => ({
      remoteDebuggingPort: app.commandLine.hasSwitch('remote-debugging-port'),
      argvPort: process.argv.some(arg => /^--remote-debugging-port(?:=|$)/.test(arg)),
      testPipe: app.commandLine.hasSwitch('remote-debugging-pipe'),
    }))
    bp.measure('Playwright-injected debugging', debug, 'switches',
      'playwright-core adds --inspect=0 and --remote-debugging-port=0; this cannot establish the product invariant; plain launch checked separately')
    const csp = await page.evaluate(() => {
      const policy = document.querySelector('meta[http-equiv="Content-Security-Policy" i]')?.content
      const connect = policy?.split(';').map(part => part.trim().split(/\s+/)).find(row => row[0] === 'connect-src')?.slice(1)
      return { policy, connect, origin: location.origin }
    })
    check('The loaded document permits connect-src only to itself and loopback',
      csp.connect?.length === 3 && csp.connect.every(source => ["'self'", 'ws://127.0.0.1:*', 'http://127.0.0.1:*'].includes(source)) &&
        new URL(csp.origin).hostname === '127.0.0.1',
      csp, 'index.html', 'Set an explicit loopback-only connect-src in the loaded production document.', 'S')
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({
      opacity: win.getOpacity(), focusable: win.isFocusable(), focused: win.isFocused(),
    })))
    check('Security probes never show or focus an app window', windows.every(win => win.opacity === 0 && !win.focusable && !win.focused),
      windows, 'tests/e2e/harness.mjs', 'Keep disposable app windows transparent and nonfocusable.', 'S')
    const file = path.join(out, '01-isolated-app.png')
    const png = await page.screenshot({ path: file, scale: 'device' })
    bp.measure('Security screenshot', { file, deviceScaleFactor: await page.evaluate(() => devicePixelRatio),
      width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, 'pixels', 'Real loaded app, forced native scale 2; no page mock')
    for (const error of [...h.consoleErrors, ...consoleErrors]) bp.consoleError(error)
    bp.measure('Failed renderer HTTP requests', httpErrors, 'responses', 'Status and path only; no headers, query values or storage bodies')
    await app.close()
    app = null
    const portReceipt = path.join(h.root, 'plain-launch.json')
    // Reuse the same isolated launcher and real backend sandbox, but without
    // Playwright's injected TCP inspector switches. Observe in main only.
    await writeFile(entryFile, (await readFile(entryFile, 'utf8')).replace(anchor, `${anchor}
  result.ready.then(() => {
    const { app, BrowserWindow } = require('electron')
    require('node:fs').writeFileSync(${JSON.stringify(portReceipt)}, JSON.stringify({
      remoteDebuggingPort: app.commandLine.hasSwitch('remote-debugging-port'),
      argvPort: process.argv.some(arg => /^--remote-debugging-port(?:=|$)/.test(arg)),
      inspector: process.argv.some(arg => /^--inspect(?:=|$)/.test(arg)),
      serveUp: result.hermesHost.status().serve.state === 'up',
      windows: BrowserWindow.getAllWindows().map(win => ({opacity:win.getOpacity(),focusable:win.isFocusable()}))
    }))
    app.quit()
  })`))
    const plain = spawn(require('electron'), [entryFile], { cwd: h.root, env: h.env,
      detached: true, stdio: 'ignore' })
    const timer = setTimeout(() => { try { process.kill(-plain.pid, 'SIGKILL') } catch {} }, 45000)
    let code
    try { [code] = await once(plain, 'close') } finally { clearTimeout(timer) }
    const plainDebug = JSON.parse(await readFile(portReceipt, 'utf8'))
    check('The app does not expose a remote debugging TCP port',
      code === 0 && plainDebug.serveUp && !plainDebug.remoteDebuggingPort && !plainDebug.argvPort && !plainDebug.inspector,
      { exitCode: code, ...plainDebug }, 'electron/main.cjs', 'Remove TCP debugging switches from normal app launch.', 'S')
    check('No console errors', bp.report.console.length === 0, bp.report.console,
      'electron/serve-auth.cjs:247', 'Preserve upstream status codes and handle missing optional APIs gracefully; distinguish teardown connection errors.')
  } finally {
    if (app) await app.close()
    await h.close()
  }
}

try {
  console.log('Running every red-team opt-in and Electron security invariant sequentially')
  await suites()
  await live()
} catch (error) {
  check('Security evidence completes without a harness interruption', false, error.stack,
    'tools/blueprint/security.mjs', 'Resolve the recorded harness/environment interruption and rerun.', 'S')
} finally {
  if (!bp.report.checks.some(row => row.name === 'No console errors')) {
    check('No console errors', false, 'Live renderer collection did not complete; absence of errors is not proven',
      'tools/blueprint/security.mjs', 'Complete the live renderer checks before reporting a clean console.', 'S')
  }
  bp.finish()
}
