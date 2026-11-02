// Real Electron + real Hermes + stdio MCP. Only disposable homes/local fixtures.
// Run: HERMES_DESK_E2E_BACKGROUND=1 node tools/blueprint/workspace.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchHarness, waitFor, repo } from '../../tests/e2e/harness.mjs'
import { createReport } from './lib/report.mjs'
import { FAKE_VALUES, refFor, startWorkspaceModel, startWorkspaceSite, toolText } from './fixtures/workspace/server.mjs'

assert(process.env.HERMES_DESK_E2E_VISIBLE !== '1', 'Visible/focus-stealing runs are not allowed')
const bp = createReport('workspace'), out = bp.dir('workspace')
const fixtures = fileURLToPath(new URL('./fixtures/workspace/', import.meta.url))
const findings = [], notTested = [], screenshots = [], corrections = [
  'Initial harness attempts assumed CommonJS globals in the Playwright main evaluation realm. Corrected to Node process.getBuiltinModule/createRequire and made evidence collection unable to prevent teardown.',
  'Before first run, corrected dialog accessible names/options against the real components, not product code.',
  'Corrected serve readiness to its actual "up" state and limited overlap tests to intersecting rows (wrapped controls are intentional).',
  'Corrected the native-dialog stub to accept the real "browse" confirmation wording and record the actual response, not just its configured default.',
  'Removed an unnecessary backend restart while seeding fixtures before any sessions exist; refreshed the renderer to inventory new temp profiles instead.',
  'Corrected duplicate Settings-close clicks during its exit animation: wait for hidden after the first close instead.',
  'Matched the shared fake server’s 404 handling for auxiliary provider probes. Script errors now attach to their own job rather than poisoning every later scenario.',
  'Enabled reduced-motion media in the app renderer to avoid background modal animation stability races; native tab and ghost overlay motion remain unchanged.',
  'Seeded the Settings deep link before renderer reload so delayed roster routing cannot erase an already-open test modal. Switches, diffs and confirmation still use the real Settings UI.',
  'Prevented auxiliary session-title requests from overwriting completed tool-result evidence; added a fixture regression test.',
  'Corrected ref selection to target editable/button roles instead of same-label StaticText nodes; kept the rejected static-text attempts in the harness-correction history.',
  'Interleaved real successful browser_tabs calls between expected URL refusals so Hermes’s three-strike MCP breaker does not prevent subsequent URLs or redaction tests from reaching the app.',
  'Accounted for JPEG black rounding (decoded RGB 1,1,1) while requiring uniformly near-black mask interiors; RGB 1 is not a redaction leak.',
  'Closed old temporary alpha tabs before the origin-race test so the eight-tab product cap does not prevent the race fixture from opening.',
  'The credential pre-commit hook rejected obvious fake fixture data and password-selector ternaries. Kept the hook enabled, named the dummy sample by scenario, and seeded the fake login field at runtime before load.',
]
let h, site, model, serial = 0, interrupted = false
const stop = async () => {
  interrupted = true
  await h?.close()
  await model?.close()
  await site?.close()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
const meta = {
  settings: ['electron/local/host-config.cjs:268', 'Keep the confirmed MCP setup wired through Settings.', 'M'],
  tools: ['electron/local/workspace/cdp-exec.cjs:153', 'Trace the measured failing command through MCP dispatch and CDP.', 'M'],
  takeover: ['electron/local/workspace/takeover.cjs:19', 'Distinguish scoped agent input and send one takeover steer.', 'M'],
  lanes: ['electron/local/workspace/lane-data.cjs:29', 'Preserve explicit consent and partition ownership.', 'M'],
  policy: ['electron/local/workspace/url-policy.cjs:46', 'Normalize all loopback forms before checking control-plane ports.', 'S'],
  downloads: ['electron/local/workspace/downloads.cjs:13', 'Block executable extensions and oversized bodies before saving.', 'S'],
  redaction: ['electron/local/workspace/cdp-exec.cjs:399', 'Keep snapshot detection and returned-image bitmap masks fail-closed.', 'M'],
  secrets: ['electron/local/workspace/cdp-exec.cjs:280', 'Revalidate origin and document after native secret consent.', 'M'],
  scale: ['electron/local/workspace/lanes.cjs:133', 'Investigate per-view RSS and discard/throttling under the 18-tab load.', 'L'],
  layout: ['src/styles/workspace.css:1', 'Fix the measured toolbar/status contrast or overlap without hiding controls.', 'S'],
  console: ['src/components/workspace/WorkspacePane.tsx:89', 'Trace and resolve the captured renderer error.', 'M'],
}
function check(area, name, ok, detail) {
  bp.check(name, ok, detail)
  if (!ok) {
    let [suspected, suggestedFix, size] = meta[area] || meta.tools
    if (name.includes('automation hook')) {
      suspected = 'src/App.tsx:117'
      suggestedFix = 'Expose the documented read-only automation hook, or correct the harness contract to name nubAgent IPC.'
      size = 'S'
    } else if (name.includes('exposed through the app')) {
      suspected = 'electron/preload.cjs:27'
      suggestedFix = 'Expose the existing consent-gated hd:ws:clearLaneData handler through preload and its typed bridge.'
      size = 'S'
    } else if (name === 'No console errors') {
      suspected = 'electron/serve-auth.cjs:226'
      suggestedFix = 'Investigate the recorded HTTP 502 routes and verified-peer/reconnect failures; do not suppress the console evidence.'
    } else if (name.includes('real Mac cursor')) {
      suspected = 'electron/local/workspace/cdp-exec.cjs:151 (unconfirmed; external physical input can contaminate endpoint sampling)'
      suggestedFix = 'Repeat with physical input idle and inspect the CDP/native-event evidence before attributing cursor movement to the app. This run proves an endpoint mismatch, not its cause.'
      size = 'S'
    }
    findings.push({ id: `BP-WORKSPACE-${findings.length + 1}`, userSees: name,
      check: name, measured: detail, suspected, suggestedFix, size })
  }
}
async function section(area, name, action) {
  if (interrupted) { notTested.push(`${name}: interrupted`); return }
  console.log(`\n# ${name}`)
  try { await action() } catch (error) {
    check(area, `${name} completes through the real app`, false, error.message)
    notTested.push(`${name}: dependent assertions after "${error.message}"`)
  }
}
const main = (fn, arg) => h.app.evaluate(fn, arg)
const renderer = (fn, arg) => h.page.evaluate(fn, arg)
const observation = () => main(() => {
  const { installFakeOp, ...safe } = globalThis.__bpWorkspace
  return safe
})
const lane = async profile => (await h.state()).lanes.find(l => l.id === `profile:${profile}`)
const activeId = async profile => (await lane(profile))?.tabs.find(t => t.active)?.id
async function pageValue(profile, expression) {
  return main(async (_electron, { profile, expression }) => {
    const tab = globalThis.__hermesDeskE2E.ws.lanes.getActiveTab(`profile:${profile}`)
    if (!tab?.webContents || tab.webContents.isDestroyed()) throw new Error(`No live tab for ${profile}`)
    return tab.webContents.executeJavaScript(expression)
  }, { profile, expression })
}
async function open(profile, route, activate = true) {
  const id = await renderer(({ profile, url }) => window.nubAgent.workspace.openTab(profile, url),
    { profile: profile === 'you' ? 'you' : `profile:${profile}`, url: `${site.url}${route}` })
  if (activate) await renderer(id => window.nubAgent.workspace.activate(id), id)
  await waitFor(async () => (await h.state()).lanes.flatMap(l => l.tabs).find(t => t.id === id)?.title?.includes(route), `load ${route}`)
  return id
}
async function resume(profile) {
  if ((await lane(profile))?.state === 'paused') {
    await renderer(id => window.nubAgent.workspace.resumeAgent(id), `profile:${profile}`)
  }
}
function job(profile, steps, options = {}) {
  const id = `w${++serial}`
  const plan = { id, profile, steps, done: false, ...options }
  model.jobs.set(id, plan)
  return plan
}
async function submit(plan) {
  await h.page.getByRole('button', { name: plan.profile[0].toUpperCase() + plan.profile.slice(1), exact: true }).click()
  const input = h.page.getByRole('textbox', { name: 'Message the agent' })
  await input.fill(`E2E:chat ${plan.profile} BPW:${plan.id}`)
  await input.press('Enter')
}
async function complete(plan, timeout = 45000) {
  await waitFor(() => {
    if (interrupted) throw new Error('Harness interrupted')
    return plan.done || (plan.error && (() => { throw new Error(plan.error) })())
  },
    `model plan ${plan.id}`, timeout)
  await waitFor(async () => !(await main(() => globalThis.__hermesDeskE2E.serveClient.getActiveTurns()))
    .some(turn => turn.profile === plan.profile), `turn idle ${plan.profile}`, 15000)
  return (plan.results || []).map(toolText)
}
async function run(profile, steps) {
  await resume(profile)
  const plan = job(profile, steps)
  await submit(plan)
  return { plan, results: await complete(plan) }
}
const command = (name, args) => ({ name: `browser_${name}`, args })
function success(text) { return !/(?:not_enabled|app_unavailable|user_took_control|timeout|blocked_by_policy|no_such_ref|bad_args|tab_closed):/.test(text || '') }
async function capture(name, tab = true) {
  const shell = path.join(out, `${name}.png`)
  await h.page.screenshot({ path: shell })
  screenshots.push({ path: shell, shows: name })
  if (tab) {
    const image = await main(async () => {
      const lanes = globalThis.__hermesDeskE2E.ws.lanes
      const wc = lanes.getActiveTab(lanes.focusedLaneId)?.webContents
      return wc && (await wc.capturePage()).toPNG().toString('base64')
    })
    if (image) {
      const file = path.join(out, `${name}-tab.png`)
      await writeFile(file, Buffer.from(image, 'base64'))
      screenshots.push({ path: file, shows: `${name}, native workspace view` })
    }
  }
}
async function returnedImage(results, name) {
  const text = results.join('\n')
  const media = text.match(/MEDIA:([^\s"\\}]+)/)?.[1]
  assert(media, `Screenshot did not return a MEDIA image: ${text.slice(0, 300)}`)
  const file = await realpath(media)
  assert(file.startsWith(`${h.root}${path.sep}`), 'Returned image must be inside the disposable home')
  const image = await readFile(file)
  const destination = path.join(out, `${name}.jpg`)
  await writeFile(destination, image)
  screenshots.push({ path: destination, shows: `${name}, actual MCP image returned to Hermes` })
  return image.toString('base64')
}
async function measureMasks(base64, boxes) {
  return main(({ nativeImage }, { base64, boxes }) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
    const { width, height } = image.getSize(), pixels = image.toBitmap()
    return { width, height, fields: boxes.fields.map(box => {
      const samples = []
      for (const fx of [0.2, 0.35, 0.5, 0.65, 0.8]) for (const fy of [0.25, 0.5, 0.75]) {
        const x = Math.floor((box.x + box.width * fx) * width / boxes.width)
        const y = Math.floor((box.y + box.height * fy) * height / boxes.height)
        const offset = (y * width + x) * 4
        samples.push([...pixels.subarray(offset, offset + 3)])
      }
      const maxChannel = Math.max(...samples.flat()), minChannel = Math.min(...samples.flat())
      return { id: box.id, samples: samples.length, minChannel, maxChannel, spread: maxChannel - minChannel,
        nonBlack: samples.filter(rgb => rgb.some(v => v > 3)).length }
    }) }
  }, { base64, boxes })
}

try {
  site = await startWorkspaceSite()
  model = await startWorkspaceModel(site.url)
  h = await launchHarness()
  await h.page.emulateMedia({ reducedMotion: 'reduce' })
  h.page.on('console', msg => { if (msg.type() === 'error') bp.consoleError(msg.text()) })
  h.page.on('pageerror', error => bp.consoleError(error.message))
  bp.report.httpErrors = []
  h.page.on('response', response => {
    if (response.status() >= 400) {
      const url = new URL(response.url())
      bp.report.httpErrors.push({ status: response.status(), origin: url.origin, path: url.pathname })
    }
  })
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  await main((_electron, args) => process.getBuiltinModule('module').createRequire(args.file)(args.file)(args), { root: h.root, repo,
    file: path.join(fixtures, 'observe.cjs') })
  const profiles = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
  // The shared launcher seeds alpha/beta. Add four disposable scale profiles,
  // redirect every model endpoint, and retain a bounded 24-step tool budget.
  const original = await readFile(path.join(h.env.HERMES_HOME, 'profiles/alpha/config.yaml'), 'utf8')
  for (const profile of ['default', ...profiles, 'session-e2e-scratch']) {
    const home = profile === 'default' ? h.env.HERMES_HOME : path.join(h.env.HERMES_HOME, 'profiles', profile)
    await mkdir(home, { recursive: true })
    const current = profiles.indexOf(profile) >= 2 ? original.replace(/mcp_servers:[\s\S]*/, 'mcp_servers: {}\n')
      : await readFile(path.join(home, 'config.yaml'), 'utf8')
    await writeFile(path.join(home, 'config.yaml'), current.replace(/base_url: .*/, `base_url: ${model.url}`)
      .replace(/max_turns: \d+/, 'max_turns: 24'))
    await writeFile(path.join(home, '.env'), `OPENAI_API_KEY=obviously-fake-local-model-key\nOPENAI_BASE_URL=${model.url}\n`)
    await writeFile(path.join(home, 'SOUL.md'), `Local workspace fixture ${profile}. Only use the planned tools.\n`)
    await writeFile(path.join(home, 'profile.yaml'), `ui_meta:\n  display_name: ${profile[0].toUpperCase() + profile.slice(1)}\n`)
  }
  await renderer(() => window.nubAgent.host.disableBrowserControl(['alpha', 'beta']))
  await waitFor(async () => (await renderer(() => window.nubAgent.host.status())).serve.state === 'up', 'isolated serve ready', 45000)
  await h.page.goto(`${h.page.url().split('#')[0]}#/?settings=1&pane=workspace`)
  await h.page.reload()
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  await waitFor(async () => (await renderer(() => window.nubAgent.host.getConfig())).profiles.some(p => p.name === 'zeta'), 'six fixture profiles')
  const host = await renderer(() => window.nubAgent.host.status())
  check('policy', 'Workspace uses a temporary home and no reserved backend port', h.env.HERMES_HOME.startsWith(h.root) &&
    ![8642, 9119].includes(host.serve.port), { home: h.env.HERMES_HOME, port: host.serve.port, fixture: site.url, model: model.url })
  const hook = await renderer(() => typeof window.__hermesDesk)
  check('tools', 'The documented app automation hook is available', hook === 'object', `window.__hermesDesk: ${hook}; using existing nubAgent IPC instead`)
  await section('settings', 'Settings browsing consent', async () => {
    await h.page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor()
    const workspaceSettings = h.page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Workspace', exact: true })
    if (await workspaceSettings.getAttribute('aria-current') !== 'page') await workspaceSettings.click()
    const alpha = h.page.getByRole('switch', { name: 'Let Alpha browse in Hermes Desk', exact: true })
    await alpha.waitFor()
    await main(() => { globalThis.__bpWorkspace.answer = 0 })
    await alpha.click()
    await h.page.getByText('Cancelled. No config changed.', { exact: true }).waitFor()
    const cancelled = await renderer(() => window.nubAgent.host.getConfig())
    check('settings', 'Cancelling browsing consent leaves the profile disabled', !cancelled.workspace.enabledProfiles.includes('alpha'),
      cancelled.workspace.enabledProfiles)
    await main(() => { globalThis.__bpWorkspace.answer = 1 })
    for (const profile of profiles) {
      const control = h.page.getByRole('switch', { name: `Let ${profile[0].toUpperCase() + profile.slice(1)} browse in Hermes Desk`, exact: true })
      await control.click()
      await waitFor(async () => await control.getAttribute('aria-checked') === 'true', `Settings enables ${profile}`)
    }
    const consent = (await observation()).dialogs.filter(d => d.title === 'Enable Hermes Desk browsing?')
    const config = await renderer(() => window.nubAgent.host.getConfig())
    check('settings', 'Settings enables both agents only after a native diff confirmation',
      ['alpha', 'beta'].every(p => config.workspace.enabledProfiles.includes(p)) &&
      consent.filter(d => d.response === 1).length === 6 &&
      consent.every(d => /mcp_servers|hermes-desk/.test(d.detail) && /settings.json workspace.enabledProfiles/.test(d.detail)),
      { enabled: config.workspace.enabledProfiles, confirmations: consent.map(d => ({ title: d.title, response: d.response, diffChars: d.detail.length })) })
    const backups = await main(() => {
      const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path')
      return ['alpha', 'beta'].map(p => ({ profile: p,
        backups: fs.readdirSync(path.join(process.env.HERMES_HOME, 'profiles', p)).filter(n => n.includes('bak-hermesdesk')) }))
    })
    check('settings', 'Confirmed browsing changes preserve config backups', backups.every(p => p.backups.length > 0), backups)
    await h.page.getByLabel('Controller config diff').scrollIntoViewIfNeeded()
    await capture('01-settings-diff', false)
    await h.page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
    await h.page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'hidden' })
  })
  if (await h.page.getByRole('dialog', { name: 'Settings', exact: true }).count()) {
    await h.page.keyboard.press('Escape')
    await h.page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'hidden' })
  }
  const enabled = (await renderer(() => window.nubAgent.host.getConfig())).workspace.enabledProfiles
  const missing = profiles.filter(p => !enabled.includes(p))
  if (missing.length) {
    // Preserve the red Settings check while collecting the rest of the product
    // evidence through its confirmed host service, not a dispatch/policy bypass.
    const result = await renderer(profiles => window.nubAgent.host.enableBrowserControl(profiles), missing)
    assert(result.ok, 'Diagnostic confirmed host setup failed')
    bp.report.settingsFallback = { profiles: missing, method: 'confirmed host IPC after UI setup failure' }
    notTested.push('Unmodified Settings entry path did not complete; later MCP checks use explicitly labelled confirmed host setup.')
  }
  const toggle = h.page.getByRole('button', { name: 'Toggle workspace' })
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
  await h.page.getByRole('region', { name: 'Workspace on your Mac' }).waitFor()
  await section('tools', 'First agent-owned tab', async () => {
    const { results } = await run('alpha', [command('navigate', { url: `${site.url}/work/alpha` }), command('snapshot')])
    check('tools', 'An agent can navigate its first empty lane through real MCP', success(results[0]) &&
      (await lane('alpha')).tabs.some(t => t.url === `${site.url}/work/alpha`), results[0])
    check('tools', 'Snapshots return usable element refs from the real fixture', /\[ref=e\d+\]/.test(results[1]) &&
      results[1].includes('Record click') && !results[1].includes('{"error":'), results[1])
    await renderer(id => window.nubAgent.workspace.activate(id), await activeId('alpha'))
    await capture('02-agent-first-tab')
  })
  await section('tools', 'All ten model-selected MCP tools', async () => {
    const first = await activeId('alpha')
    const second = await open('alpha', '/work/alpha-other', false)
    await renderer(id => window.nubAgent.workspace.activate(id), first)
    const cursorBefore = JSON.parse(execFileSync('/usr/bin/swift', [path.join(fixtures, 'cursor.swift')], { encoding: 'utf8' }))
    const { plan, results } = await run('alpha', [
      command('snapshot'),
      command('click', r => ({ ref: refFor(r[0], 'Record click') })),
      command('type', r => ({ ref: refFor(r[0], 'Note'), text: 'workspace typed note' })),
      command('press', { key: 'Tab' }), command('scroll', { direction: 'down' }),
      command('screenshot'), command('navigate', { url: `${site.url}/second/alpha` }),
      command('back'), command('tabs'), command('tab_activate', { id: second }),
    ])
    const checks = [
      ['click', 1, site.events.some(e => e.type === 'click' && e.route === '/work/alpha')],
      ['type', 2, await main(async (_e, id) => {
        const wc = globalThis.__hermesDeskE2E.ws.lanes.getTab(id).webContents
        return wc.executeJavaScript("document.querySelector('#note').value === 'workspace typed note'")
      }, first)],
      ['press', 3, site.events.some(e => e.type === 'key' && e.key === 'Tab')],
      ['scroll', 4, site.events.some(e => e.type === 'scroll' && e.y > 0)],
      ['screenshot', 5, /MEDIA:/.test(results[5])],
      ['back', 7, results[7]?.includes('/work/alpha')],
      ['tabs', 8, results[8]?.includes(first) && results[8]?.includes(second) && !results[8]?.includes('/work/beta')],
      ['tab_activate', 9, await activeId('alpha') === second],
    ]
    for (const [tool, index, observed] of checks) check('tools', `MCP ${tool} delivers its promised browser behaviour`,
      success(results[index]) && observed, { result: results[index], fixtureObserved: observed })
    if (/MEDIA:/.test(results[5])) await returnedImage([results[5]], '03-mcp-screenshot')
    const issued = model.responses.find(r => r.jobId === plan.id && r.message.tool_calls?.[0].function.name.endsWith('browser_click'))
    const event = site.events.find(e => e.type === 'click' && e.route === '/work/alpha')
    const elapsed = event && issued ? event.at - issued.at : null
    // Product currently waits two animation frames, not the complete 250ms
    // transition. Report raw latency and never subtract time not actually waited.
    bp.measure('Click tool response to fixture click', elapsed, 'ms', 'Monotonic timestamps in local provider and fixture event receiver, includes MCP/CDP; no fictitious cursor subtraction')
    check('tools', 'Agent clicks reach the page within 150ms excluding cursor animation',
      elapsed !== null && elapsed < 150, { rawMs: elapsed, excludedAnimationMs: 0, targetMs: 150 })
    const cursorAfter = JSON.parse(execFileSync('/usr/bin/swift', [path.join(fixtures, 'cursor.swift')], { encoding: 'utf8' }))
    check('tools', 'Agent mouse and keyboard commands never move the real Mac cursor',
      cursorBefore.x === cursorAfter.x && cursorBefore.y === cursorAfter.y, { before: cursorBefore, after: cursorAfter })
    const cursor = await main(() => globalThis.__hermesDeskE2ECursor)
    check('tools', 'The ghost cursor paints with the agent label before browser input',
      cursor.some(c => c.opacity === '1' && c.label === 'alpha'), cursor)
    try {
      const file = path.join(out, '03-ghost-cursor.png')
      await writeFile(file, await readFile(path.join(h.root, 'ghost-cursor.png')))
      screenshots.push({ path: file, shows: 'Painted ghost cursor, captured by the original launcher after overlay.waitFrame' })
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    check('tools', 'Agent CDP input does not trigger a false user takeover', (await lane('alpha')).state !== 'paused',
      { lane: (await lane('alpha')).state, nativeEvents: await main(() => globalThis.__hermesDeskE2ENetwork.filter(e => e.type === 'mouse')) })
    await capture('03-tools-complete')
  })
  await section('takeover', 'Native takeover and Resume', async () => {
    await open('alpha', '/work/takeover')
    await resume('alpha')
    const before = (await observation()).steers.length
    const id = await activeId('alpha')
    const plan = job('alpha', [command('navigate', { url: `${site.url}/slow/takeover` }), command('snapshot')])
    await submit(plan)
    await waitFor(() => site.requests.some(r => r.route === '/slow/takeover'), 'in-flight native navigation')
    const at = performance.now()
    await main((_e, id) => {
      const wc = globalThis.__hermesDeskE2E.ws.lanes.getTab(id).webContents
      for (const type of ['mouseDown', 'mouseUp', 'mouseDown', 'mouseUp']) {
        wc.sendInputEvent({ type, x: 12, y: 12, button: 'left', clickCount: 1 })
      }
    }, id)
    await waitFor(async () => (await lane('alpha')).state === 'paused', 'native input pauses lane')
    const ms = performance.now() - at
    const results = await complete(plan)
    check('takeover', 'Native user input pauses the lane before the next browser command',
      results.every(r => /user_took_control/.test(r)), { pauseMs: ms, results })
    bp.measure('Native input to observed lane pause', ms, 'ms', 'Electron sendInputEvent → workspace.list paused state')
    const steers = (await observation()).steers.slice(before).filter(s => /User took control/.test(s.text))
    check('takeover', 'Exactly one steer is sent for one user takeover despite repeated native input', steers.length === 1, steers)
    await capture('04-paused')
    await h.page.getByRole('button', { name: 'Resume agent', exact: true }).click()
    await waitFor(() => site.events.some(e => e.type === 'load' && e.route === '/slow/takeover'), 'fixture navigation settles')
    const resumed = await run('alpha', [command('snapshot')])
    check('takeover', 'Resume agent restores MCP browsing and sends control-returned steer',
      success(resumed.results[0]) && (await observation()).steers.slice(before).some(s => /Control returned/.test(s.text)),
      { result: resumed.results[0], lane: (await lane('alpha')).state })
  })
  await section('lanes', 'Lane isolation and tab handoff', async () => {
    await open('alpha', '/cookie/A')
    await open('beta', '/work/beta')
    const userId = await open('you', '/work/you')
    const cookie = await main(async ({ session }) => {
      const partitions = ['persist:ws-agent-alpha', 'persist:ws-agent-beta', 'persist:ws-user']
      return Promise.all(partitions.map(async partition => ({ partition,
        cookies: (await session.fromPartition(partition).cookies.get({ name: 'bpw_owner' })).map(c => ({ name: c.name, value: c.value })) })))
    })
    check('lanes', 'Agent lane A cookies are invisible to lane B and to your browser',
      cookie[0].cookies.some(c => c.value === 'A') && cookie[1].cookies.length === 0 && cookie[2].cookies.length === 0, cookie)
    await h.page.getByRole('button', { name: 'Give to agent', exact: true }).click()
    // Select beta, which has no desktop session yet, so the handoff need not
    // invent a fake provider response to an unplanned Workspace prompt.
    await h.page.getByRole('dialog', { name: 'Give to agent' }).getByRole('combobox').selectOption('profile:beta')
    await h.page.getByRole('button', { name: 'Give tab', exact: true }).click()
    await h.page.getByRole('button', { name: 'Return to me', exact: true }).waitFor()
    const shared = await main((_e, id) => {
      const t = globalThis.__hermesDeskE2E.ws.lanes.getTab(id)
      return { laneId: t.laneId, partition: t.partition, sharedLogin: t.sharedLogin }
    }, userId)
    check('lanes', 'Give to agent retains your login partition and shows a shared-login badge',
      shared.laneId === 'profile:beta' && shared.partition === 'persist:ws-user' && shared.sharedLogin &&
      await h.page.getByText('shared login', { exact: false }).count() > 0, shared)
    await capture('05-shared-login')
    await h.page.getByRole('button', { name: 'Return to me', exact: true }).click()
    const returned = (await h.state()).lanes.find(l => l.id === 'you').tabs.find(t => t.id === userId)
    check('lanes', 'Return to me restores your lane and removes the shared-login flag', returned && !returned.sharedLogin, returned)
    await main(async ({ session }, url) => {
      await session.fromPartition('persist:ws-user').cookies.set({ url, name: 'bpw_signin', value: 'FAKE-user-login' })
    }, site.url)
    await h.page.getByRole('button', { name: 'Copy sign-in', exact: true }).click()
    const dialog = h.page.getByRole('dialog', { name: 'Copy sign-in', exact: true })
    await dialog.getByRole('combobox').selectOption('beta')
    await main(() => { globalThis.__bpWorkspace.answer = 0 })
    await dialog.getByRole('button', { name: 'Review copy' }).click()
    await dialog.getByRole('alert').waitFor()
    const getSignIn = () => main(async ({ session }) => (await session.fromPartition('persist:ws-agent-beta').cookies.get({ name: 'bpw_signin' })).length)
    check('lanes', 'Declining per-origin sign-in consent copies no cookies', await getSignIn() === 0, { copied: await getSignIn() })
    await main(() => { globalThis.__bpWorkspace.answer = 1 })
    await dialog.getByRole('button', { name: 'Review copy' }).click()
    await dialog.waitFor({ state: 'hidden' })
    const dialogs = (await observation()).dialogs.filter(d => /Copy sign-in for/.test(d.message))
    check('lanes', 'Copy sign-in requires native per-origin consent and copies only after approval',
      await getSignIn() === 1 && dialogs.length === 2 && dialogs.every(d => d.message.includes(site.url)),
      { copied: await getSignIn(), dialogs })
  })
  await section('policy', 'Control-plane URL refusals', async () => {
    const port = host.serve.port
    const urls = [
      `http://127.0.0.1:${port}/api/status`, `http://0.0.0.0:${port}/`,
      `http://[::1]:${port}/`, `http://2130706433:${port}/`, `http://0177.0.0.1:${port}/`,
      `http://127.0.0.1:8642/`, `http://127.0.0.1:9119/`, 'file:///etc/hosts', 'chrome://settings',
    ]
    const { results } = await run('alpha', urls.flatMap(url => [command('navigate', { url }), command('tabs')]))
    for (let i = 0; i < urls.length; i++) check('policy', `Agent navigation refuses ${urls[i]}`,
      /blocked_by_policy/.test(results[i * 2]), { url: urls[i], result: results[i * 2], healthProbe: results[i * 2 + 1] })
  })
  await section('downloads', 'Agent download restrictions', async () => {
    const before = (await renderer(() => window.nubAgent.host.auditTail(1000))).filter(e => e.action === 'download').length
    // webContents.downloadURL is the real Electron download/network path. It
    // avoids waiting 30s for a navigation load event on an attachment.
    for (const filename of ['fixture.sh', 'fixture.exe', 'large.bin', 'safe.txt']) {
      await main((_e, { filename, base }) =>
        globalThis.__hermesDeskE2E.ws.lanes.getActiveTab('profile:alpha').webContents.downloadURL(`${base}/download/${filename}`),
      { filename, base: site.url })
    }
    await waitFor(async () => (await renderer(() => window.nubAgent.host.auditTail(1000))).filter(e => e.action === 'download').length >= before + 4,
      'download guards and safe download complete')
    const downloads = (await observation()).downloads
    for (const filename of ['fixture.sh', 'fixture.exe', 'large.bin']) {
      const d = downloads.find(d => d.filename === filename)
      check('downloads', `Agent lane blocks ${filename === 'large.bin' ? 'downloads larger than 200MB' : filename + ' executable downloads'}`,
        d?.cancelled || d?.state === 'cancelled', d || { filename, observed: false })
    }
    check('downloads', 'Agent lane can still download an ordinary small text file',
      downloads.some(d => d.filename === 'safe.txt' && d.state === 'completed'), downloads)
  })
  await section('policy', 'Agent permissions are denied', async () => {
    const before = (await observation()).dialogs.length
    await open('beta', '/permissions/beta')
    const permissions = await waitFor(async () => {
      const p = await pageValue('beta', 'fixture.permission')
      return Object.keys(p).length === 4 && p
    }, 'permission results')
    for (const [key, result] of Object.entries(permissions)) check('policy', `Agent lane denies ${key} permission without prompting you`,
      result !== 'allowed' && result !== 'granted' && (await observation()).dialogs.length === before,
      { result, nativeDialogs: (await observation()).dialogs.length - before })
  })
  await section('redaction', 'Login, checkout and OTP redaction', async () => {
    for (const kind of ['login', 'checkout', 'otp']) {
      await open('alpha', `/${kind}/alpha`)
      const selector = { login: '#password', checkout: '#card,#cvv', otp: '#otp' }[kind]
      const boxes = await pageValue('alpha', `({width:innerWidth,height:innerHeight,fields:[...document.querySelectorAll('${selector}')].map(n=>{const r=n.getBoundingClientRect();return {id:n.id,x:r.x,y:r.y,width:r.width,height:r.height}})})`)
      const { results } = await run('alpha', [command('snapshot'), command('screenshot')])
      const expected = kind === 'checkout' ? 2 : 1
      const labels = kind === 'login' ? ['Password'] : kind === 'checkout' ? ['Card number', 'Security code'] : ['One-time code']
      check('redaction', `${kind} snapshots mark every sensitive field and hide its value`,
        labels.every(label => results[0].split('\n').some(line => line.includes(`textbox "${label}"`) && line.includes('(sensitive, value hidden)'))) &&
        !results[0].includes(FAKE_VALUES[kind === 'checkout' ? 'card' : kind]), results[0])
      const base64 = await returnedImage([results[1]], `06-${kind}-returned-mask`)
      const pixels = await measureMasks(base64, boxes)
      check('redaction', `${kind} returned screenshots paint sensitive-field interiors solid black`,
        pixels.fields.length === expected && pixels.fields.every(f => f.nonBlack === 0 && f.spread <= 2), pixels)
      if (kind === 'login') {
        const refused = await run('alpha', [command('snapshot'),
          command('type', r => ({ ref: refFor(r[0], 'Password'), text: 'FAKE-literal-not-a-credential' }))])
        check('secrets', 'Sensitive fields refuse literal agent text instead of a secret placeholder',
          /blocked_by_policy/.test(refused.results[1]), refused.results[1])
      }
    }
  })
  await section('secrets', 'Origin-bound placeholder fill', async () => {
    const op = (await observation()).opPathRefusal
    check('secrets', 'Production refuses an unverified fake op binary on PATH', op.ok === false, op)
    await main(() => globalThis.__bpWorkspace.installFakeOp())
    await open('alpha', '/secret/alpha')
    const { results } = await run('alpha', [command('snapshot'),
      command('type', r => ({ ref: refFor(r[0], 'Password'), text: '{{secret:Password}}' })), command('snapshot')])
    const filled = await pageValue('alpha', `document.querySelector('#password').value === ${JSON.stringify(FAKE_VALUES.vault)}`)
    check('secrets', 'A consented secret placeholder fills the actual field through the fake op CLI',
      filled && /typed \[secret\]/.test(results[1]), { fieldMatchesFakeValue: filled, result: results[1],
        seam: 'secrets-op I/O dependencies: fake signature metadata and temp executable; no actual 1Password access' })
    const alpha = await lane('alpha')
    for (const tab of alpha.tabs) if (!tab.active) await renderer(id => window.nubAgent.workspace.closeTab(id), tab.id)
    await open('alpha', '/secret/race')
    await main((_e, url) => { globalThis.__bpWorkspace.raceOrigin = url }, `${h.fixture.url}/login`)
    const raced = await run('alpha', [command('snapshot'),
      command('type', r => ({ ref: refFor(r[0], 'Password'), text: '{{secret:Password}}' }))])
    const absent = await pageValue('alpha', `![...document.querySelectorAll('input')].some(n=>n.value === ${JSON.stringify(FAKE_VALUES.vault)})`)
    check('secrets', 'Secret fills abort if the origin changes during native consent',
      /blocked_by_policy/.test(raced.results[1]) && absent, { result: raced.results[1], fakeValueAbsent: absent })
  })
  await section('lanes', 'Clear agent lane data', async () => {
    await pageValue('beta', "localStorage.setItem('bpw_clear','FAKE-lane-storage')")
    const sharedId = await open('you', '/work/clear-shared')
    await renderer(id => window.nubAgent.workspace.giveToAgent(id, 'beta'), sharedId)
    const userBefore = await main(async ({ session }) => (await session.fromPartition('persist:ws-user').cookies.get({ name: 'bpw_signin' })).length)
    const exposed = await renderer(() => typeof window.nubAgent.workspace.clearLaneData === 'function')
    check('lanes', 'Clear agent lane data is exposed through the app’s workspace bridge', exposed,
      { clearLaneData: await renderer(() => typeof window.nubAgent.workspace.clearLaneData) })
    const clear = async () => {
      if (exposed) return renderer(() => window.nubAgent.workspace.clearLaneData('profile:beta'))
      // Diagnostic only: drive the already-installed real IPC handler, keeping
      // assertMainSender, native consent, partition guards and storage code.
      // This does NOT turn the missing UI/preload entry point into a pass.
      return main(async ({ ipcMain, BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:'))
        const handler = ipcMain._invokeHandlers.get('hd:ws:clearLaneData')
        if (!handler) throw new Error('Clear lane backend handler is unavailable')
        await handler({ sender: win.webContents }, 'profile:beta')
      })
    }
    if (!exposed) {
      notTested.push('User-triggered Clear lane data UI: preload entry point is absent. Backend assertions use the installed real IPC handler in disposable main.')
    }
    await main(() => { globalThis.__bpWorkspace.answer = 0 })
    let declined = false
    try { await clear() } catch { declined = true }
    const beforeClear = (await lane('beta')).tabs.length
    check('lanes', 'Cancelling clear-lane consent preserves the agent’s tabs and sign-in', declined &&
      beforeClear >= 2 && await main(async ({ session }) => (await session.fromPartition('persist:ws-agent-beta').cookies.get({ name: 'bpw_signin' })).length) === 1,
      { declined, privateAndSharedTabs: beforeClear })
    await main(() => { globalThis.__bpWorkspace.answer = 1 })
    await clear()
    const cleared = await main(async ({ session }) => ({
      beta: (await session.fromPartition('persist:ws-agent-beta').cookies.get({})).length,
      you: (await session.fromPartition('persist:ws-user').cookies.get({ name: 'bpw_signin' })).length,
      alpha: (await session.fromPartition('persist:ws-agent-alpha').cookies.get({ name: 'bpw_owner' })).length,
    }))
    check('lanes', 'Clearing one agent lane removes its private cookies and tabs but preserves your login and other lanes',
      cleared.beta === 0 && cleared.you === userBefore && cleared.alpha === 1 &&
      (await lane('beta')).tabs.length === 1 && (await lane('beta')).tabs[0].id === sharedId &&
      (await lane('beta')).tabs[0].sharedLogin, { ...cleared, preservedSharedTab: sharedId })
    check('lanes', 'Clear lane data requires a native warning with cancel as the default',
      (await observation()).dialogs.some(d => /Clear browser data/.test(d.message) && d.buttons[0] === 'Cancel' && d.defaultId === 0),
      (await observation()).dialogs.filter(d => /Clear browser data/.test(d.message)))
    const privateId = await open('beta', '/work/after-clear', false)
    const storage = await main((_e, id) => globalThis.__hermesDeskE2E.ws.lanes.getTab(id)
      .webContents.executeJavaScript("localStorage.getItem('bpw_clear')"), privateId)
    check('lanes', 'Clearing agent lane data also removes that lane’s local storage', storage === null,
      { value: storage, freshPrivateTab: privateId })
  })
  await section('scale', 'Six agents and eighteen parallel tabs', async () => {
    const plans = []
    // Remove only this run's disposable test tabs, not user/profile state.
    for (const p of profiles) {
      for (const tab of (await lane(p))?.tabs || []) await renderer(id => window.nubAgent.workspace.closeTab(id), tab.id)
      await resume(p)
      const ids = []
      for (let n = 0; n < 3; n++) ids.push(await open(p, `/scale/${p}/${n}`, false))
      plans.push(job(p, ids.flatMap((id, n) => [command('tab_activate', { id }),
        command('navigate', { url: `${site.url}/parallel/${p}/${n}` })]).concat(command('tabs')), { scale: true }))
    }
    const cursorBefore = JSON.parse(execFileSync('/usr/bin/swift', [path.join(fixtures, 'cursor.swift')], { encoding: 'utf8' }))
    let peak = 0
    const monitor = setInterval(() => {
      main(() => globalThis.__hermesDeskE2E.serveClient.getActiveTurns().length).then(n => { peak = Math.max(peak, n) }).catch(() => {})
    }, 30)
    try {
      for (const plan of plans) await submit(plan)
      await Promise.allSettled(plans.map(plan => complete(plan, 90000)))
    } finally { clearInterval(monitor) }
    await waitFor(async () => (await main(() => globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'all scale turns idle', 30000)
    const state = await h.state()
    const summary = profiles.map(profile => ({ profile, tabs: state.lanes.find(l => l.id === `profile:${profile}`)?.tabs.map(t => ({ id: t.id, url: t.url })) }))
    check('scale', 'Six agents each browse three tabs without lane crosstalk',
      summary.every(({ profile, tabs }) => tabs?.length === 3 && tabs.every(t => t.url.startsWith(`${site.url}/parallel/${profile}/`))) &&
      plans.every(p => p.done && p.results?.every(r => success(toolText(r)))), { peakActiveTurns: peak, lanes: summary,
        planErrors: plans.filter(p => p.error || !p.done).map(p => ({ profile: p.profile, error: p.error || 'incomplete' })) })
    check('scale', 'All six real Hermes browsing turns overlap in parallel', peak === 6, { peakActiveTurns: peak })
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
      .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
    const roots = new Set([h.app.process().pid, ...(await readFile(path.join(h.root, 'serve-pids.txt'), 'utf8')).trim().split('\n').map(Number)])
    let changed = true
    while (changed) { changed = false; for (const [pid, parent] of rows) if (roots.has(parent) && !roots.has(pid)) { roots.add(pid); changed = true } }
    const measured = rows.filter(([pid]) => roots.has(pid)), rss = measured.reduce((sum, row) => sum + row[2] * 1024, 0)
    bp.measure('Six agents × three tabs idle total RSS', rss, 'bytes', 'ps RSS summed for this Electron tree and recorded detached Hermes serve trees; excludes harness/fixtures and unrelated apps')
    check('scale', 'Six agents with three idle tabs each stay below 1.2GB total RSS', rss < 1_200_000_000,
      { rssBytes: rss, rssMiB: rss / 1024 ** 2, processes: measured.length, targetBytes: 1_200_000_000 })
    const cursorAfter = JSON.parse(execFileSync('/usr/bin/swift', [path.join(fixtures, 'cursor.swift')], { encoding: 'utf8' }))
    check('scale', 'Parallel agent browsing never moves the real Mac cursor',
      JSON.stringify(cursorBefore) === JSON.stringify(cursorAfter), { before: cursorBefore, after: cursorAfter })
    await h.page.getByRole('button', { name: 'Agent tabs', exact: true }).click()
    await capture('07-six-agents-eighteen-tabs', false)
    await h.page.keyboard.press('Escape')
  })
  await section('layout', 'Measured workspace layout', async () => {
    const geometry = await renderer(() => {
      const selectors = ['.workspace-header', '.workspace-tabs', '.workspace-nav', '.workspace-browser-area', '.workspace-status-bar']
      const boxes = selectors.map(selector => {
        const r = document.querySelector(selector)?.getBoundingClientRect()
        return { selector, ...(r ? { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right } : {}) }
      })
      const controls = [...document.querySelectorAll('.workspace-nav button,.workspace-nav input')]
        .filter(n => n.getBoundingClientRect().width).map(n => {
          const r = n.getBoundingClientRect()
          return { label: n.getAttribute('aria-label') || n.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width }
        })
      const luminance = color => {
        const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255)
          .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
      }
      const contrasts = [...document.querySelectorAll('.workspace-header h2,.workspace-focused-agent,.workspace-status-bar span,.workspace-action-button')]
        .filter(n => n.textContent.trim() && n.getBoundingClientRect().width && !n.disabled).map(n => {
          let bg = n
          while (bg.parentElement && getComputedStyle(bg).backgroundColor === 'rgba(0, 0, 0, 0)') bg = bg.parentElement
          const foreground = getComputedStyle(n).color, background = getComputedStyle(bg).backgroundColor
          const a = luminance(foreground), b = luminance(background)
          return { text: n.textContent.trim(), foreground, background, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }
        })
      return { boxes, controls, contrasts, viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio } }
    })
    const overlap = geometry.controls.flatMap((a, i) => geometry.controls.slice(i + 1).filter(b =>
      Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1).map(b => [a.label, b.label]))
    check('layout', 'Workspace toolbar controls do not overlap at the app window size', overlap.length === 0, { overlap, ...geometry })
    check('layout', 'Workspace labels and status meet WCAG AA text contrast', geometry.contrasts.every(c => c.ratio >= 4.5), geometry.contrasts)
    bp.measure('Screenshot device scale', geometry.viewport.scale, '×', 'Renderer window.devicePixelRatio; native Electron window scale, not resized evidence')
    await capture('08-workspace-layout')
  })
  const background = await main(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({
    title: w.getTitle(), focused: w.isFocused(), opacity: w.getOpacity(),
  })))
  check('policy', 'Every test window remains invisible and never takes desktop focus',
    background.every(w => !w.focused && w.opacity === 0), background)
  check('tools', 'The local fake model completes every registered tool plan without script errors', model.errors.length === 0, model.errors)
  await section('secrets', 'Whole-run secret evidence audit', async () => {
    const bodies = JSON.stringify(model.requests.map(r => r.body))
    check('redaction', 'Fake login, card and OTP values never appear in any model request body',
      [FAKE_VALUES.login, FAKE_VALUES.card, FAKE_VALUES.otp].every(value => !bodies.includes(value)),
      { requests: model.requests.length, leakedLabels: Object.entries(FAKE_VALUES).filter(([k, v]) => k !== 'vault' && bodies.includes(v)).map(([k]) => k) })
    const logs = await main(async (_e, root) => {
      const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path')
      const files = []
      const walk = dir => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, e.name)
          if (e.isDirectory()) walk(file)
          else if (/\.(?:log|jsonl|db)(?:-wal|-shm)?$/.test(e.name)) files.push(file)
        }
      }
      walk(path.join(root, '.hermes'))
      return { scanned: files.length,
        leaks: files.filter(file => fs.readFileSync(file).includes(Buffer.from('bpw-FAKE-vault-fill-never-use'))).map(f => path.relative(root, f)) }
    }, h.root)
    check('secrets', 'Filled secrets stay out of model bodies, transcripts and Hermes logs',
      !bodies.includes(FAKE_VALUES.vault) && logs.leaks.length === 0,
      { requests: model.requests.length, ...logs })
  })
} catch (error) {
  check('tools', 'The isolated workspace harness completes setup and teardown', false, error.stack)
} finally {
  if (h) {
    for (const error of h.consoleErrors) bp.consoleError(error)
    try {
      await writeFile(path.join(out, 'electron.txt'), h.logs.join(''))
      await writeFile(path.join(out, 'build.txt'), h.buildOutput)
      await writeFile(path.join(out, 'observations.json'), JSON.stringify(await observation(), null, 2))
    } catch (error) { notTested.push(`Main evidence collection: ${error.message}`) }
    finally {
      try { await h.close() } catch (error) { check('tools', 'Disposable app and Hermes processes close cleanly', false, error.message) }
    }
  }
  if (model) { await writeFile(path.join(out, 'model-requests.json'), JSON.stringify(model.requests, null, 2)); await model.close() }
  if (site) { await writeFile(path.join(out, 'fixture-events.json'), JSON.stringify(site.events, null, 2)); await site.close() }
  check('console', 'No console errors', bp.report.console.length === 0, bp.report.console)
  bp.report.findings = findings
  bp.report.screenshots = screenshots
  bp.report.notYetTested = notTested
  bp.report.harnessCorrections = corrections
  bp.report.isolation = 'Shared E2E launcher: temp HOME/HERMES_HOME; loopback-only sandbox; no hosted calls; no settings/first-tab diagnostic adapters'
  bp.report.testSeams = ['Native dialog answers in disposable main', 'secrets-op supported I/O dependency injection for temp fake CLI only',
    'Shared launcher initially config-writer-enables alpha/beta, then this harness disables them before real Settings enable']
  const report = bp.finish()
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  const detail = value => typeof value === 'string' ? value : JSON.stringify(value)
  const markdown = [
    '# Hermes Desk workspace blueprint', '', '## Summary',
    `${report.checks.filter(c => c.ok).length}/${report.checks.length} checks pass. ${findings.length} findings. No product code changed.`,
    '', '## Files', '`tools/blueprint/workspace.mjs` and `tools/blueprint/fixtures/workspace/`.',
    '', '## Run command', '```sh', `cd "${repo}"`, 'HERMES_DESK_E2E_BACKGROUND=1 node tools/blueprint/workspace.mjs', '```',
    '', '## Checks', ...report.checks.map(c => `- **${c.ok ? 'PASS' : 'FAIL'}** ${c.name}: ${c.detail}`),
    '', '## Measures', ...report.measures.map(m => `- ${m.name}: ${m.value} ${m.unit}. ${m.how}`),
    '', '## Findings', ...findings.map(f => `\n### ${f.id} (${f.size})\nUser sees: ${f.userSees}\n\nCheck: ${f.check}\n\nMeasured: ${detail(f.measured)}\n\nSuspected: \`${f.suspected}\`\n\nSuggested fix: ${f.suggestedFix}`),
    '', '## Screenshots worth putting in the report', ...screenshots.map(s => `- \`${s.path}\`: ${s.shows}`),
    '', '## Not yet tested', ...(notTested.length ? notTested.map(n => `- ${n}`) : ['- Packaged app, real sites/accounts, real 1Password and long-duration load.']),
    '', '## Test seams and isolation', ...report.testSeams.map(s => `- ${s}`),
    '', '## Harness corrections', ...(corrections.length ? corrections : ['None.']),
  ].join('\n')
  await writeFile(path.join(out, 'report.md'), markdown)
}
