// Real Electron + real sandboxed Hermes serve + the existing deterministic local model.
// Run serially: node tools/blueprint/sweep.mjs [--quick]
// --quick is a development sample, NOT the required full 4-size × 2-dock × 2-skin matrix.
// No product files are patched. Server-frame fixtures below prove renderer presentation only,
// never backend approval authority, replay, or a real tool's success.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, copyFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchHarness, waitFor, repo } from '../../tests/e2e/harness.mjs'
import { createReport } from './lib/report.mjs'
import { measureDOM, measurePixels, settleUI, writeContactSheet } from './lib/ui-measure.mjs'

// Never allow the inherited opt-in to show/focus test windows.
delete process.env.HERMES_DESK_E2E_VISIBLE
const quick = process.argv.includes('--quick')
const r = createReport('sweep'), out = r.dir('ui'), measurements = [], shots = [], findings = new Map()
r.report.commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
r.report.mode = quick ? 'quick-development-sample' : 'full'
r.report.fixtureBoundaries = [
  'Real unmodified Electron renderer, real sandboxed Hermes serve, existing fake-model and fixture site.',
  'Roster fixtures are copied only into the disposable HERMES_HOME.',
  'Markdown, tool chips, approval and clarify matrix states use labelled server-frame fixtures on an already real-bound session.',
  'Injected cards are presentation checks, not proof of backend-generated approval/clarify round trips.',
  'When the real Files palette action is a no-op, its check fails and a labelled DOM button click opens the presentation fixture so remaining layout states still run.',
  'Only responses to synthetic bp-approval/bp-clarify IDs are collected in the disposable launcher, never sent to real serve (which has no such pending requests).',
  'Offline state stops/kills only the harness-owned serve. No real home, 8642, 9119, hosted model or OS input.',
]
r.report.harnessCorrections = [
  'Development-only runs corrected a persisted Settings modal, the Files close label, raw-markdown text matching, and mascot/hover/date selector coverage.',
  'Synthetic card responses now stop at the disposable fixture reply collector; sending them to the real backend ledger invalidated early development runs.',
  'The UI matrix varies actual Settings and native window dimensions without reloading an active backend session. Reload/reconnect coverage is explicitly separate.',
  'Palette recovery waits for the exact debounced action row; PiP uses pip.html and HUD uses ?win=hud with the lifecycle-only smoke flag disabled in the disposable process.',
  'The hidden-all roster fixture runs after offline preservation, because hiding every profile clears the selected chat and is not a cached-chat baseline.',
  'Screenshot inspection caught long-answer scrolling to an older fixture; each capture now targets the current unique heading and checks its visible bounds after content-visibility layout settles.',
  'The HUD capture waits for the real HUD shell and mascot, rather than a boot-splash SVG during lazy loading; explicit close avoids the rapid-toggle guard before the offline matrix.',
  'PNG and geometry invariants verify the helper itself; no product code or failing product threshold was changed.',
]
let h, sessionId, socketIds = [], index = 0, fixtureIndex = 0
const sourceHints = {
  contrast: 'src/styles/skin-messenger.css:2; src/index.css:857 (markdown tokens); src/components/settings/local/common.tsx',
  overlap: 'src/styles/skin-messenger.css:178; src/components/TopBar.tsx:88',
  date: 'src/styles/skin-messenger.css:28',
  chrome: 'src/App.tsx:453; src/styles/workspace.css',
  clipped: 'src/components/Sidebar.tsx:507; src/components/SidePanel.tsx:119; src/components/TopBar.tsx',
  mascot: 'src/components/AgentMascot.tsx',
  targets: 'src/components/TopBar.tsx; src/components/workspace/WorkspaceNav.tsx; src/components/settings/local',
  hover: 'src/components/MessageActions.tsx; src/styles/skin-messenger.css:131',
  theme: 'src/components/SettingsStub.tsx; src/components/SidePanel.tsx:119; src/styles/skin-messenger.css:2',
  'tool-running': 'src/components/chat/ToolChipRow.tsx:21',
  onboarding: 'src/App.tsx; src/components/settings/local/HermesPane.tsx',
  console: 'src/lib/hermes-rest.ts; vite.config.ts (local API proxy)',
  'files-palette': 'src/App.tsx:439; src/components/CommandPalette.tsx:446',
  transcript: 'src/components/ChatPanel.tsx; src/index.css:530 (content-visibility)',
  hud: 'src/components/HudShell.tsx; electron/main.cjs (HUD collapse)',
  preview: 'src/components/Sidebar.tsx; src/lib/agents/hermes-profiles.ts',
}
const descriptions = {
  contrast: ['P1', 'Some text cannot be read reliably, including markdown and status text.', 'Scope a complete dark token set to the messenger shell and remove low-opacity text styles.', 'U1'],
  overlap: ['P1', 'The selected-agent pill and header icon buttons occupy the same clickable pixels.', 'Reserve separate non-overlapping header tracks; collapse secondary actions at narrow chat widths.', 'E1'],
  date: ['P2', 'The sticky date pill paints over message words while scrolling.', 'Give the sticky date a dedicated full-width gutter or remove stickiness.', 'U2/U9'],
  chrome: ['P2', 'A white strip appears below the dark workspace.', 'Apply dark chrome to the workspace dock and its Computer launcher, not only WorkspacePane.', 'U4'],
  targets: ['P2', 'Small arrows, switches, and tab controls are difficult to click.', 'Make the interactive boxes at least 28×28 CSS px without enlarging their glyphs.'],
  hover: ['P2', 'Hover actions obscure completed tool chips.', 'Place hover actions in reserved space rather than above the bubble.', 'U10'],
  theme: ['P2', 'Files and Settings switch to bright surfaces inside the dark messenger UI.', 'Apply messenger tokens to modal and side-panel roots.'],
  'tool-running': ['P2', 'A completed terminal chip still reads Running terminal.', 'Derive the caption from tool status and use Ran terminal for completion.', 'U8'],
  'tool-failed': ['P1', 'Successful tool results are presented as Failed.', 'Preserve successful completion status through event normalization.', 'U7'],
  onboarding: ['P2', 'A fresh user sees a chat shell without a local-setup explanation.', 'Add a first-run local setup and connector-status guide.'],
  clarify: ['P1', 'A clarify fixture does not surface the question the user must answer.', 'Check runtime/stored session routing and prompt lifecycle in the local transport.'],
  focus: ['P2', 'Keyboard focus is not visible.', 'Use a consistent high-contrast focus-visible outline on controls.'],
  motion: ['P2', 'Decorative infinite animation continues with reduced motion enabled.', 'Gate infinite CSS animations on prefers-reduced-motion.'],
  console: ['P2', 'The renderer logs errors during normal or offline operations.', 'Handle local endpoint failures with explicit user-facing recovery and no unhandled errors.'],
  'files-palette': ['P2', 'The Files palette action closes Search without opening Files in the local shell.', 'Pass onOpenFiles into CommandPalette, or fall back to the registered action when the optional callback is absent.'],
  transcript: ['P1', 'The transcript is blank after scrolling to the current long answer.', 'Keep the current answer visible as offscreen rows settle their intrinsic heights.'],
  preview: ['P2', 'A profile with a completed live chat still advertises No messages yet.', 'Use the latest session/message metadata in the roster preview.', 'U5'],
}
function promise(name, ok, detail, kind, screenshot) {
  r.check(name, ok, detail)
  if (!ok && kind) {
    const finding = findings.get(kind) ?? { id: `BP-UI-${findings.size + 1}`, kind, checks: [],
      suspected: sourceHints[kind] ?? 'src/App.tsx', size: ['overlap', 'clipped', 'onboarding'].includes(kind) ? 'M' : 'S' }
    const [severity, experience, fix, known] = descriptions[kind] ?? ['P2', name, 'Inspect the measured flow and repair the failing promise.']
    Object.assign(finding, { severity, experience, fix, ...(known ? { known } : {}) })
    finding.checks.push({ name, detail, screenshot })
    findings.set(kind, finding)
  }
}
async function frames(events) {
  await h.app.evaluate(({ BrowserWindow }, { ids, events }) => {
    const main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:'))
    for (const id of ids) for (const frame of events) main.webContents.send('maia:serveSocketEvent',
      { id, type: 'message', data: JSON.stringify({ jsonrpc: '2.0', ...frame }) })
  }, { ids: socketIds, events })
}
const event = (type, payload = {}) => ({ method: 'event', params: { type, session_id: sessionId, payload } })
async function fixtureReply(text, { streaming = false, tools = false } = {}) {
  text = text.replace(/^([^\n]+)/, `$1 · fixture ${++fixtureIndex}`)
  const events = [event('message.start'), event('message.delta', { text })]
  if (tools) events.push(
    event('tool.start', { tool_id: 'bp-terminal', name: 'terminal', args: { command: 'printf fixture' } }),
    event('tool.complete', { tool_id: 'bp-terminal', name: 'terminal', result: { output: 'fixture', exit_code: 0 }, duration_s: 1.2 }),
    event('tool.start', { tool_id: 'bp-browse', name: 'browser_navigate', args: { url: `${h.fixture.url}/alpha` } }),
    event('tool.complete', { tool_id: 'bp-browse', name: 'browser_navigate', result: { title: 'Local fixture' }, duration_s: .8 }))
  if (!streaming) events.push(event('message.complete', { text, status: 'completed' }))
  await frames(events)
  const visiblePrefix = text.split('\n')[0].replace(/^#+\s*/, '').slice(0, 200)
  await h.page.locator('.ca-bubble').filter({ hasText: visiblePrefix }).last().waitFor()
}
async function capture(state, variant, page = h.page) {
  await settleUI(page)
  const name = `${String(++index).padStart(3, '0')}-${variant}-${state}`
  const file = path.join(out, `${name}.png`), start = performance.now()
  const dom = await measureDOM(page), png = await page.screenshot({ path: file })
  const pixels = measurePixels(png, dom)
  const row = { name, state, variant, screenshot: file, dom, pixels }
  measurements.push(row); shots.push({ name, file })
  const tag = `${variant} / ${state}`
  const low = dom.contrasts.filter(c => c.ratio < c.required)
  promise(`${tag}: Visible text meets WCAG AA`, !low.length,
    { sampled: dom.contrasts.length, failures: low.length, worst: low.slice().sort((a, b) => a.ratio - b.ratio).slice(0, 6),
      approximations: dom.unsupported.length }, 'contrast', file)
  promise(`${tag}: Header and toolbar controls do not overlap`, !dom.toolbarOverlaps.length,
    dom.toolbarOverlaps, 'overlap', file)
  promise(`${tag}: Date pills do not cover message text`, !dom.dateOverlaps.length,
    { visibleDates: await page.locator('.messenger-date-pill:visible').count(), overlaps: dom.dateOverlaps }, 'date', file)
  promise(`${tag}: Dark chrome has no light edge or bottom patches`, !pixels.patches.length,
    { sampled: pixels.sampled, patches: pixels.patches.slice(0, 12), total: pixels.patches.length }, 'chrome', file)
  promise(`${tag}: Controls stay inside the window without sideways overflow`, dom.overflow <= 1 && !dom.clipped.length,
    { overflowPx: dom.overflow, clipped: dom.clipped }, 'clipped', file)
  promise(`${tag}: Every visible mascot renders non-blank`, pixels.mascots.every(m => m.nonBlank),
    { instances: pixels.mascots.length, pixels: pixels.mascots.map(m => ({ colours: m.colours, paths: m.paths, nonBlank: m.nonBlank })) }, 'mascot', file)
  promise(`${tag}: Active controls have at least 28px hit targets`, !dom.hitTargets.length,
    dom.hitTargets, 'targets', file)
  promise(`${tag}: Hover actions do not cover tool chips`, !dom.hoverOverlaps.length,
    dom.hoverOverlaps, 'hover', file)
  promise(`${tag}: Messenger auxiliary panels retain dark surfaces`, !dom.messenger || dom.panels.every(p => p.dark),
    { messenger: dom.messenger, panels: dom.panels }, 'theme', file)
  promise(`${tag}: Screenshot uses the window device scale`, Math.abs(pixels.scaleX - dom.viewport.scale) < .05,
    { css: dom.viewport, screenshot: [pixels.width, pixels.height], scale: pixels.scaleX })
  r.measure(`${tag}: measurement and screenshot`, +(performance.now() - start).toFixed(1), 'ms',
    'DOM computed colours/bounds plus Playwright screenshot and independent PNG decode')
  return row
}
async function safe(name, fn) {
  try { return await fn() } catch (error) {
    promise(`${name}: The flow is reachable`, false, error.message, `flow:${name}`)
    r.report.blocked ??= []; r.report.blocked.push({ name, error: error.message })
    if (h) await capture(`${name}-blocked`, 'flow').catch(e => r.consoleError(`capture: ${e.message}`))
  }
}
async function prefs(patch) {
  await h.page.evaluate(patch => {
    const key = 'hermes-desk:local-prefs:v1'
    const previous = JSON.parse(localStorage.getItem(key) || '{}')
    localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, scope: 'client-persisted',
      slice: 'hermes-desk.local-prefs', value: { pinnedOrder: [], hiddenProfiles: [], showScratch: false,
        sessionSources: ['desktop'], ...previous.value, ...patch } }))
    dispatchEvent(new StorageEvent('storage', { key }))
  }, patch)
}
async function setDock(open) {
  const button = h.page.getByRole('button', { name: 'Toggle workspace', exact: true })
  if ((await button.getAttribute('aria-pressed')) !== String(open)) {
    await paletteCommand('Workspace on your Mac')
    await h.page.waitForFunction(open => document.querySelector('[aria-label="Toggle workspace"]')?.getAttribute('aria-pressed') === String(open), open)
  }
}
async function paletteCommand(label) {
  // Real keyboard recovery route, not a forced click through overlapping chrome.
  await h.page.keyboard.press('Meta+k')
  await h.page.getByRole('combobox', { name: 'Search', exact: true }).fill(label)
  await h.page.getByRole('tab', { name: 'Actions', exact: true }).click()
  await h.page.getByRole('option').filter({ has: h.page.getByText(label, { exact: true }) }).click()
  await h.page.getByRole('combobox', { name: 'Search', exact: true }).waitFor({ state: 'hidden' })
}
async function openSettings() {
  // The keyboard route remains drivable when classic's sidebar footer clips.
  // Geometry checks still report the clipped footer instead of force-clicking it.
  await h.page.keyboard.press('Meta+,')
  await h.page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor()
}
async function resize(width, height) {
  const actual = await h.app.evaluate(({ BrowserWindow }, { width, height }) => {
    const main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:'))
    main.setContentSize(width, height)
    return { minimum: main.getMinimumSize(), content: main.getContentSize(), visible: main.isVisible(), focused: main.isFocused() }
  }, { width, height })
  await h.page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], actual.content)
  assert.equal(actual.focused, false, 'Test window must never gain focus')
  return actual
}
const markdown = `# Blueprint field notes

This long answer includes \`inline code\`, **bold text**, and a [local fixture link](http://127.0.0.1/fixture).

| Area | Result | Next step |
| --- | --- | --- |
| Browser | Completed | Review the tool chips |
| Local files | Ready | Open Files |

> The agent should make its current status clear without asking you to remember a previous message.

\`\`\`js
const localOnly = true
console.log('blueprint fixture')
\`\`\`

${Array.from({ length: 12 }, (_, i) => `## Step ${i + 1}\n\nA deterministic paragraph for scroll testing. This reply must remain readable when the workspace is open at the minimum width. The date pill must never cover these words.`).join('\n\n')}
`

try {
  h = await launchHarness()
  r.report.failedResponses = []
  const watchPage = page => {
    page.on('console', msg => { if (msg.type() === 'error') r.consoleError(msg.text()) })
    page.on('pageerror', error => r.consoleError(`pageerror: ${error.message}`))
    page.on('response', response => {
      if (response.status() >= 400) r.report.failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() })
    })
  }
  watchPage(h.page)
  h.app.on('window', watchPage)
  h.page.setDefaultTimeout(6000)
  // Synthetic card replies must not reach an unrelated real pending-request
  // ledger. All real broker calls still use the original handler unchanged.
  await h.app.evaluate(({ ipcMain }) => {
    const channel = 'maia:serveSocketSend', original = ipcMain._invokeHandlers.get(channel)
    if (!original) throw new Error('The real serve relay must exist before installing fixture reply collection')
    globalThis.__bpUiFixtureResponses = []
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, payload) => {
      let frame
      try { frame = JSON.parse(payload?.data) } catch { return original(event, payload) }
      if (!frame.method && /^bp-(approval|clarify)-\d+$/.test(String(frame.id))) {
        globalThis.__bpUiFixtureResponses.push({ id: frame.id, answered: frame.result !== undefined, error: !!frame.error })
        return { ok: true }
      }
      return original(event, payload)
    })
  })
  await h.page.addInitScript(() => {
    window.__bpUiRelay = { ids: [], sessions: {}, runtimeForStored: {} }
    const install = () => {
      if (!window.nubAgent?.serveSocket?.onEvent) { setTimeout(install, 0); return }
      window.nubAgent.serveSocket.onEvent(message => {
      if (message.type !== 'message') return
      const relay = window.__bpUiRelay
      if (!relay.ids.includes(message.id)) relay.ids.push(message.id)
      try {
        const frame = JSON.parse(message.data)
        for (const id of [frame.params?.session_id, frame.result?.session_id, frame.result?.stored_session_id])
          if (id) relay.sessions[id] = message.id
        if (frame.result?.stored_session_id && frame.result?.session_id)
          relay.runtimeForStored[frame.result.stored_session_id] = frame.result.session_id
      } catch { /* Only observe valid JSON session metadata. */ }
      })
    }
    install()
  })
  // Observe the existing relay, without replacing its responses or authorization.
  await h.app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:')).webContents
    globalThis.__bpUiSockets = new Set()
    globalThis.__bpUiSocketForSession = {}
    globalThis.__bpUiSessions = []
    const send = wc.send.bind(wc)
    wc.send = (channel, ...args) => {
      if (channel === 'maia:serveSocketEvent' && args[0]?.type === 'message') {
        globalThis.__bpUiSockets.add(args[0].id)
        try {
          const frame = JSON.parse(args[0].data)
          if (frame.method === 'event' && frame.params?.session_id) globalThis.__bpUiSessions.push(frame.params.session_id)
          const session = frame.params?.session_id || frame.result?.session_id
          if (session) globalThis.__bpUiSocketForSession[session] = args[0].id
        } catch { /* Non-JSON frames are irrelevant to the content-free observer. */ }
      }
      return send(channel, ...args)
    }
  })
  await h.page.reload()
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 30000 })
  r.measure('Cold launch to populated roster', +(performance.now() - h.launchedAt).toFixed(1), 'ms',
    'Existing isolated launchHarness launchedAt to visible Alpha after reload/observer installation; includes instrumentation overhead')
  r.report.automationHook = await h.page.evaluate(() => typeof window.__hermesDesk)
  const first = await capture('fresh-userData-first-run', 'flow')
  const onboarding = await h.page.getByRole('dialog').count()
  promise('First run explains local setup before asking users to chat', onboarding > 0,
    { dialogs: onboarding, freshUserData: true, automationHook: r.report.automationHook }, 'onboarding', first.screenshot)
  // Nine normal profiles plus hidden/scratch cases, all disposable, fake-only.
  const profiles = ['gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
  for (const profile of profiles) {
    const dir = path.join(h.env.HERMES_HOME, 'profiles', profile)
    await mkdir(dir, { recursive: true })
    for (const file of ['config.yaml', '.env', 'SOUL.md']) await copyFile(path.join(h.env.HERMES_HOME, 'profiles/alpha', file), path.join(dir, file))
    await writeFile(path.join(dir, 'profile.yaml'), `ui_meta:\n  display_name: ${profile === 'theta' ? 'Theta Research and Operations' : profile[0].toUpperCase() + profile.slice(1)}\n`)
  }
  await h.page.reload()
  await h.page.locator('.hd-agent-row').nth(8).waitFor({ timeout: 30000 })
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).click()
  await capture('pick-agent-empty-chat', 'flow')
  await safe('hidden-and-scratch', async () => {
    await prefs({ hiddenProfiles: ['theta'] })
    await waitFor(async () => await h.page.locator('.hd-agent-row').count() === 8, 'hidden roster')
    promise('Hidden and scratch agents stay out of the normal roster', await h.page.locator('[data-agent-id="profile:theta"],[data-agent-id="profile:session-e2e-scratch"]').count() === 0,
      { visibleRows: await h.page.locator('.hd-agent-row').count() })
    await capture('hidden-agent', 'flow')
    await h.page.getByRole('button', { name: 'Restore hidden bots', exact: true }).click()
    await h.page.getByRole('menu', { name: 'Hidden bots' }).getByRole('menuitem', { name: 'theta', exact: true }).click()
    await h.page.locator('[data-agent-id="profile:theta"]').waitFor()
    promise('A hidden agent can be restored through the visible menu', await h.page.locator('.hd-agent-row').count() === 9,
      { visibleRows: await h.page.locator('.hd-agent-row').count() })
    await prefs({ hiddenProfiles: [], showScratch: true })
    await h.page.locator('[data-agent-id="profile:session-e2e-scratch"]').waitFor()
    await capture('scratch-agent-visible', 'flow')
    await prefs({ showScratch: false })
  })
  await safe('real-stream', async () => {
    const t = performance.now()
    await h.send('alpha', 'parallel', 'ui-stream')
    await h.page.locator('.ca-bubble').filter({ hasText: 'Parallel streaming answer' }).waitFor({ timeout: 30000 })
    r.measure('Submit to first visible streamed text', +(performance.now() - t).toFixed(1), 'ms',
      'Real UI Enter → real Hermes → existing fake-model → visible bubble text')
    await capture('real-streaming', 'flow')
    await waitFor(async () => !(await h.page.locator('[data-testid="stop-turn"]').count()), 'real turn completes')
    promise('Real Hermes streams a deterministic answer into the selected chat',
      await h.page.getByText('Each profile owns its own conversation.', { exact: false }).count() > 0,
      { modelRequests: h.model.requests.length, modelErrors: h.model.errors })
    const preview = await h.page.locator('[data-agent-id="profile:alpha"]').innerText()
    promise('A profile with a completed live chat does not advertise No messages yet',
      !preview.includes('No messages yet'), { profile: 'alpha', completedRealTurn: true, row: preview }, 'preview')
    await capture('real-answer-completed', 'flow')
  })
  const relay = await h.app.evaluate(() => ({ ids: [...globalThis.__bpUiSockets], sessions: globalThis.__bpUiSessions }))
  socketIds = relay.ids; sessionId = relay.sessions.at(-1)
  assert(sessionId && socketIds.length, 'A real-bound session is required before injecting presentation fixtures')
  await safe('agent-browses', async () => {
    await h.send('alpha', 'browse', 'alpha')
    await h.page.locator('.ca-bubble').filter({ hasText: /I browsed|Browser tool failed/ }).waitFor({ timeout: 45000 })
    await waitFor(async () => !(await h.page.locator('[data-testid="stop-turn"]').count()), 'real browse turn completes')
    const text = await h.page.locator('.ca-bubble').last().innerText()
    promise('An agent browses its local fixture without a tool failure', text.includes('I browsed'),
      { answer: text }, 'browse')
    await capture('agent-browsed', 'flow')
    const state = await h.state()
    const tab = state.lanes.find(l => l.id === 'profile:alpha')?.tabs[0]
    if (tab) {
      await h.app.evaluate(async () => {
        const tab = globalThis.__hermesDeskE2E.ws.lanes.getActiveTab('profile:alpha')
        if (tab?.webContents) tab.webContents.sendInputEvent({ type: 'mouseDown', x: 10, y: 10, button: 'left', clickCount: 1 })
      })
      await h.page.getByRole('button', { name: 'Resume agent' }).waitFor()
      await capture('take-over-paused', 'flow')
      await h.page.getByRole('button', { name: 'Resume agent' }).click()
      await waitFor(async () => !(await h.state()).lanes.find(l => l.id === 'profile:alpha')?.paused, 'lane resumed')
      await capture('resume-agent', 'flow')
    } else promise('A browsed agent lane offers takeover and resume', false, state, 'takeover')
  })
  await safe('files', async () => {
    await h.page.getByRole('button', { name: /Toggle files|^Files$/ }).click()
    await waitFor(async () => await h.page.getByText(/Could not|empty|No files|Files/i).count(), 'Files feedback')
    const fileText = await h.page.locator('body').innerText()
    await capture('files-panel', 'flow')
    promise('Files opens without a loading failure', !/Could not load|couldn.t load|could not list|not available|unavailable|failed to/i.test(fileText),
      { visibleFeedback: fileText.slice(-1400) }, 'files')
    await h.page.locator('[data-side-panel="files"]').getByRole('button', { name: 'Close files', exact: true }).click()
  })
  const sizes = quick ? [[1024, 700]] : [[1440, 900], [1280, 800], [1024, 700], [960, 640]]
  for (const skin of ['messenger', 'classic']) {
    // Use actual Settings publication so the mounted shell reads the saved skin.
    await openSettings()
    await h.page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click()
    const skinToggle = h.page.getByRole('switch', { name: 'Messenger skin' })
    if ((await skinToggle.getAttribute('aria-checked')) !== String(skin === 'messenger')) await skinToggle.click()
    await h.page.waitForFunction(skin => document.querySelector('header[data-skin]')?.getAttribute('data-skin') === skin, skin)
    await h.page.keyboard.press('Escape')
    await h.page.getByRole('button', { name: 'Alpha', exact: true }).click()
    for (const [width, height] of sizes) for (const dock of [false, true]) {
      const variant = `${skin}-${width}x${height}-dock-${dock ? 'open' : 'closed'}`
      await safe(variant, async () => {
      await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 30000 })
      await h.page.getByRole('button', { name: 'Alpha', exact: true }).click()
      await h.page.locator('.ca-bubble').filter({ hasText: /I browsed|Browser tool failed/ }).last().waitFor({ timeout: 30000 })
      await waitFor(async () => !(await h.page.locator('[data-testid="transcript-intro"],[data-testid="transcript-sync"]').count()), 'real transcript ready')
      const actual = await resize(width, height)
      await setDock(dock)
      r.report.matrix ??= []; r.report.matrix.push({ skin, width, height, dock, actual })
      await capture('sidebar-chat', variant)
      await h.page.getByRole('button', { name: 'Theta Research and Operations', exact: true }).click()
      await capture('long-agent-name', variant)
      await h.page.getByRole('button', { name: 'Beta', exact: true }).click()
      await capture('empty-chat-empty-lane', variant)
      await h.page.getByRole('button', { name: 'Alpha', exact: true }).click()
      await h.page.locator('.ca-bubble').filter({ hasText: /I browsed|Browser tool failed/ }).last().waitFor({ timeout: 30000 })
      // Keep the real-bound session alive while varying UI dimensions and
      // Settings. A matrix is not a backend reconnect/lease-ownership test.
      socketIds = await h.page.evaluate(() => window.__bpUiRelay.ids)
      assert(socketIds.length > 0, 'The real session must expose a current renderer socket')
      const ownedSocket = await h.page.evaluate(id => window.__bpUiRelay.sessions[id], sessionId)
      if (ownedSocket) socketIds = [ownedSocket]
      await fixtureReply('Blueprint streaming fixture: working locally.', { streaming: true, tools: true })
      await capture('fixture-stream-and-tools', variant)
      const doneText = `Blueprint completed tools fixture. ${variant}`
      await frames([event('message.complete', { text: doneText, status: 'completed' })])
      await h.page.locator('.ca-bubble').filter({ hasText: doneText }).last().waitFor()
      await settleUI(h.page)
      const tools = await h.page.locator('.messenger-tool-chip').allInnerTexts()
      const completed = await capture('fixture-tools-completed', variant)
      promise(`${variant}: Completed tool chips do not say Failed`, !tools.some(t => /Failed/i.test(t)),
        { toolChips: tools }, 'tool-failed', completed.screenshot)
      promise(`${variant}: Completed chips stop saying Running terminal`, !tools.some(t => /Running terminal/i.test(t)),
        { toolChips: tools }, 'tool-running', completed.screenshot)
      await h.page.locator('.sand-message-action-anchor').filter({ hasText: doneText }).last().hover({ force: true })
      await capture('completed-tool-hover', variant)
      await fixtureReply(markdown)
      await settleUI(h.page)
      // Target this reply, not the oldest same-title fixture in the transcript.
      // Let the browser reveal content-visibility rows before aligning the title.
      const heading = h.page.locator('.ca-bubble h1').filter({ hasText: new RegExp(`^Blueprint field notes · fixture ${fixtureIndex}$`) })
      await heading.scrollIntoViewIfNeeded()
      for (let attempt = 0; attempt < 3; attempt++) {
        await heading.evaluate(el => {
          const scroller = el.closest('.messenger-transcript,.ca-transcript')
          scroller.scrollBy({ top: el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 45,
            behavior: 'instant' })
        })
        await settleUI(h.page)
      }
      const markdownTop = await capture('long-markdown-top', variant)
      const headingBounds = await heading.evaluate(el => {
        const b = el.getBoundingClientRect(), s = el.closest('.messenger-transcript,.ca-transcript').getBoundingClientRect()
        return { text: el.textContent, top: b.top, bottom: b.bottom, transcriptTop: s.top, transcriptBottom: s.bottom,
          visible: el.checkVisibility({ contentVisibilityAuto: true, checkOpacity: true, checkVisibilityCSS: true }) &&
            b.bottom > s.top && b.top < s.bottom && b.right > s.left && b.left < s.right }
      })
      promise(`${variant}: The current long-answer heading stays visible after scrolling`,
        headingBounds.visible, headingBounds, 'transcript', markdownTop.screenshot)
      // A mid-scroll date separator is intentionally sticky; it must not cover text.
      await h.page.locator('.messenger-transcript,.ca-transcript').first().evaluate(el => { el.scrollTop += 180 })
      await capture('long-markdown-scrolled', variant)
      const anchor = h.page.locator('.sand-message-action-anchor').last()
      await anchor.hover({ force: true }).catch(() => {})
      await capture('message-hover', variant)
      // Cards occur during an active reply. This also stops an asynchronous
      // history recheck from replacing a presentation fixture with stored rows.
      await fixtureReply('Blueprint awaiting your response.', { streaming: true })
      await frames([{ id: `bp-approval-${index}`, method: 'approval', params: { session_id: sessionId,
        command: 'printf blueprint-fixture', description: 'Allow this harmless local fixture command?',
        choices: ['once', 'session', 'always', 'deny'], allow_permanent: true, allow_session: true } }])
      await h.page.getByRole('button', { name: /Once|Allow once/i }).first().waitFor()
      await capture('approval-card-fixture', variant)
      await h.page.getByRole('button', { name: /Deny/i }).first().click()
      await h.page.getByTestId('inline-approval').waitFor({ state: 'hidden' }).catch(() => {})
      await fixtureReply('Blueprint awaiting clarification.', { streaming: true })
      const clarifyId = `bp-clarify-${index}`
      await frames([{ id: clarifyId, method: 'clarify', params: { session_id: sessionId,
        questions: [{ qid: 'report', question: 'Which local report should I prepare?', choices: ['Short summary', 'Detailed notes'] }] } }])
      const question = h.page.getByText('Which local report should I prepare?', { exact: false })
      const modernVisible = await question.waitFor().then(() => true).catch(() => false)
      promise(`${variant}: A server-request clarify card is visible`, modernVisible,
        { sessionId, socketCount: socketIds.length, visible: modernVisible }, 'clarify')
      if (!modernVisible) {
        await frames([event('clarify.request', { request_id: clarifyId,
          question: 'Which local report should I prepare?', choices: ['Short summary', 'Detailed notes'] })])
      }
      await question.waitFor().catch(async () => {
        promise(`${variant}: A clarify notification card is visible`, false,
          { sessionId, body: (await h.page.locator('body').innerText()).slice(-1000) }, 'clarify')
      })
      await capture('clarify-card-fixture', variant)
      if (modernVisible) {
        const card = h.page.getByTestId('clarify-prompt')
        await card.getByRole('button', { name: 'Short summary', exact: true }).click()
        if (await card.getByRole('button', { name: 'Send', exact: true }).count())
          await card.getByRole('button', { name: 'Send', exact: true }).click()
        await card.waitFor({ state: 'hidden' })
      }
      await frames([event('clarify.expire', { request_id: clarifyId })])
      await frames([event('message.complete', { text: 'Blueprint fixture cards completed.', status: 'completed' })])
      await openSettings()
      const nav = h.page.getByRole('navigation', { name: 'Settings sections' })
      for (const section of ['Hermes', 'Agents', 'Workspace', 'Secrets', 'Computer', 'Diagnostics', 'Appearance']) {
        await nav.getByRole('button', { name: section, exact: true }).click()
        await capture(`settings-${section.toLowerCase()}`, variant)
      }
      await h.page.keyboard.press('Escape')
      await paletteCommand('Files')
      await settleUI(h.page)
      const filesOpen = await h.page.locator('[data-side-panel="files"]').isVisible()
      const paletteResult = await capture('files-palette-result', variant)
      promise(`${variant}: The Files palette action opens Files`, filesOpen,
        { skin, filesOpen, route: 'actual Cmd+K → Actions → Files' }, 'files-palette', paletteResult.screenshot)
      if (!filesOpen) {
        // Presentation recovery only. Native DOM click invokes the real button
        // handler without claiming that an overlapped pointer target works.
        await h.page.getByRole('button', { name: /Toggle files|^Files$/ }).evaluate(button => button.click())
      }
      await h.page.locator('[data-side-panel="files"]').waitFor()
      await capture('files-panel', variant)
      await h.page.locator('[data-side-panel="files"]').getByRole('button', { name: 'Close files', exact: true }).click()
      if (dock) {
        await h.page.getByRole('button', { name: 'Agent tabs', exact: true }).click()
        await capture('agent-tabs-popover', variant)
        await h.page.keyboard.press('Escape')
      }
      })
    }
  }
  await safe('keyboard-and-motion', async () => {
    await resize(1024, 700); await setDock(false)
    await openSettings()
    const nav = h.page.getByRole('navigation', { name: 'Settings sections' })
    await nav.getByRole('button', { name: 'Hermes', exact: true }).focus()
    await h.page.keyboard.press('ArrowDown')
    promise('Settings arrow keys select and focus the next section',
      await nav.getByRole('button', { name: 'Agents', exact: true }).evaluate(el => el === document.activeElement && el.getAttribute('aria-current') === 'page'),
      await h.page.evaluate(() => ({ focus: document.activeElement?.textContent, current: document.querySelector('[aria-current="page"]')?.textContent })))
    const focus = await h.page.evaluate(() => {
      const s = getComputedStyle(document.activeElement)
      return { outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow }
    })
    promise('Keyboard-focused Settings controls show a focus indicator',
      focus.outline !== 'none' && parseFloat(focus.width) > 0 || focus.shadow !== 'none', focus, 'focus')
    await capture('keyboard-settings-focus', 'flow')
    await h.page.keyboard.press('Escape')
    await h.page.emulateMedia({ reducedMotion: 'reduce' })
    await fixtureReply('Blueprint reduced-motion streaming fixture.', { streaming: true })
    const row = await capture('reduced-motion', 'flow')
    promise('Reduced-motion preference stops decorative infinite animation',
      !row.dom.animations.some(a => a.iterations === Infinity), row.dom.animations, 'motion')
    await frames([event('message.complete', { text: 'Blueprint reduced-motion fixture completed.', status: 'completed' })])
  })
  await safe('pip', async () => {
    await h.page.evaluate(() => window.nubAgent.computer.open('alpha', { docked: false }))
    const pip = await waitFor(() => h.app.windows().find(p => /\/pip\.html/.test(p.url())), 'PiP window')
    pip.on('console', msg => { if (msg.type() === 'error') r.consoleError(`PiP: ${msg.text()}`) })
    pip.on('pageerror', e => r.consoleError(`PiP: ${e.message}`))
    await pip.locator('body').waitFor()
    await capture('computer-pip-empty-capture', 'flow', pip)
    promise('Computer preview honestly labels the last completed capture',
      /last.*capture|completed capture|no capture/i.test(await pip.locator('body').innerText()),
      await pip.locator('body').innerText(), 'pip')
    await h.page.evaluate(() => window.nubAgent.computer.close())
  })
  await safe('hud', async () => {
    await h.app.evaluate(() => { delete process.env.NUB_SMOKE })
    await h.page.evaluate(() => window.nubAgent.hud.open())
    const hud = await waitFor(() => h.app.windows().find(p => /[?&]win=hud/.test(p.url())), 'HUD window')
    try {
      hud.on('console', msg => { if (msg.type() === 'error') r.consoleError(`HUD: ${msg.text()}`) })
      hud.on('pageerror', e => r.consoleError(`HUD: ${e.message}`))
      await hud.locator('[data-hud-shell]').waitFor()
      await hud.locator('[data-nubcat-fg] svg').first().waitFor()
      const row = await capture('hud', 'flow', hud)
      promise('The background HUD renders its mascot',
        row.pixels.mascots.length > 0 && row.pixels.mascots.every(m => m.nonBlank),
        { viewport: row.dom.viewport, mascots: row.pixels.mascots }, 'hud', row.screenshot)
    } finally {
      // Only the HUD renderer may invoke its close channel.
      await hud.evaluate(() => window.nubAgent.hud.close()).catch(error => {
        if (!hud.isClosed()) throw error
      })
      await waitFor(() => !h.app.windows().some(p => /[?&]win=hud/.test(p.url())), 'HUD closed')
    }
  })
  await safe('offline', async () => {
    // Require the currently selected, already-rendered chat as the baseline.
    // Do not select a new backend session or clear selection before stopping it.
    await h.page.locator('.ca-bubble').first().waitFor()
    const bubblesBeforeStop = await h.page.locator('.ca-bubble').count()
    const stoppedAt = performance.now()
    const pids = (await readFile(path.join(h.root, 'serve-pids.txt'), 'utf8')).trim().split('\n').map(Number)
    // Stop supervision first, then kill only these harness-created groups.
    await h.app.evaluate(async () => globalThis.__hermesDeskE2E.hermesHost.stop())
    for (const pid of pids) try { process.kill(-pid, 'SIGTERM') } catch (e) { if (e.code !== 'ESRCH') throw e }
    await h.page.getByText('Hermes serve offline —', { exact: true }).waitFor({ timeout: 20000 })
    r.measure('Serve stop to visible offline banner', +(performance.now() - stoppedAt).toFixed(1), 'ms',
      'Stop harness-owned real serve supervision/process group → renderer offline status')
    for (const skin of ['messenger', 'classic']) {
      await openSettings()
      await h.page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click()
      const toggle = h.page.getByRole('switch', { name: 'Messenger skin' })
      if ((await toggle.getAttribute('aria-checked')) !== String(skin === 'messenger')) await toggle.click()
      await h.page.waitForFunction(skin => document.querySelector('header[data-skin]')?.getAttribute('data-skin') === skin, skin)
      await h.page.keyboard.press('Escape')
      for (const [width, height] of sizes) for (const dock of [false, true]) {
        await resize(width, height); await setDock(dock)
        await capture('offline-banner', `${skin}-${width}x${height}-dock-${dock ? 'open' : 'closed'}`)
      }
    }
    const input = h.page.getByRole('textbox', { name: 'Message the agent' })
    promise('Offline cached chats remain visible and the composer is disabled',
      await input.isDisabled() && await h.page.locator('.ca-bubble').count() > 0,
      { disabled: await input.isDisabled(), bubblesBeforeStop, bubbles: await h.page.locator('.ca-bubble').count() }, 'offline')
  })
  await safe('empty-roster', async () => {
    const names = ['default', 'alpha', 'beta', ...profiles, 'session-e2e-scratch']
    await prefs({ hiddenProfiles: names })
    await h.page.getByText('No agents to show.', { exact: true }).waitFor()
    await capture('no-visible-profiles', 'flow')
    promise('An empty roster explains how to recover',
      /restore|new agent/i.test(await h.page.locator('.hd-sidebar').innerText()),
      await h.page.locator('.hd-sidebar').innerText(), 'empty-copy')
    await prefs({ hiddenProfiles: [] })
  })
  await safe('no-hermes', async () => {
    // Actual discovery failure inside disposable HOME: remove only our wrapper
    // from discovery and remove source/bin from this test Electron's PATH.
    const wrapper = path.join(h.root, 'bin/hermes')
    await rename(wrapper, `${wrapper}.saved`)
    await h.app.evaluate((_electron, root) => { process.env.PATH = `${root}/bin:/usr/bin:/bin:/usr/sbin:/sbin` }, h.root)
    await h.page.evaluate(() => window.nubAgent.host.restartServe()).catch(() => {})
    const status = await h.page.evaluate(() => window.nubAgent.host.status())
    promise('Missing Hermes is diagnosed instead of pretending to connect', status.serve.state === 'down',
      { serve: status.serve }, 'missing-hermes')
    await openSettings()
    await h.page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Hermes', exact: true }).click()
    await capture('no-hermes-discovery', 'flow')
    await rename(`${wrapper}.saved`, wrapper)
  })
  r.report.notYetTested = [
    'Physical zero profiles (Hermes always exposes a default profile; empty-visible-roster uses disposable preferences).',
    'Backend-generated approval/clarify authority round trips; matrix cards are labelled presentation fixtures.',
    'Pointer access to an overlapped Files button is not claimed by the DOM fixture recovery; the real palette no-op and header intersections remain failing checks.',
    'Backend reconnect/session-lease ownership is outside the UI matrix; development reloads exposed unstable fixture bindings, so the measured matrix keeps one real-bound session alive.',
    'True OS focus without an offscreen background window, native file/consent dialogs, permissions, 1Password, live Mac capture.',
    'Collapsed HUD presentation is not asserted: document.hasFocus() may be true while the native test window remains unfocused. The actual expanded or collapsed shell and mascot are measured.',
    'Workspace/chrome content inside native WebContentsViews is not in renderer screenshots; separately captured below.',
    ...(quick ? ['Full window matrix: quick mode tests only 1024×700.'] : []),
  ]
  const tabImages = await h.app.evaluate(async () => {
    const lanes = globalThis.__hermesDeskE2E.ws.lanes
    return Promise.all(lanes.allLanes().flatMap(l => lanes.listTabs(l.id)).filter(t => t.webContents && !t.webContents.isDestroyed())
      .map(async t => ({ id: t.id, lane: t.laneId, png: (await t.webContents.capturePage()).toPNG().toString('base64') })))
  })
  for (const tab of tabImages) {
    const file = path.join(out, `native-${tab.lane.replace(':', '-')}-${tab.id}.png`)
    await writeFile(file, Buffer.from(tab.png, 'base64')); shots.push({ name: `native ${tab.lane}`, file })
  }
  for (let at = 0; at < shots.length; at += 12) {
    const images = await Promise.all(shots.slice(at, at + 12).map(async s => ({
      name: s.name, data: `data:image/png;base64,${(await readFile(s.file)).toString('base64')}`,
    })))
    await writeContactSheet(h.page, images, path.join(out, `contact-${String(at / 12 + 1).padStart(2, '0')}.png`))
  }
} catch (error) {
  promise('UI sweep completes its required flows', false, error.stack, 'harness')
  if (h) await capture('unexpected-blocker', 'flow').catch(() => {})
} finally {
  if (h) {
    for (const e of h.consoleErrors) if (!r.report.console.includes(e)) r.consoleError(e)
    r.report.model = { requests: h.model.requests.length, errors: h.model.errors }
    r.report.fixtureResponses = await h.app.evaluate(() => globalThis.__bpUiFixtureResponses).catch(() => [])
    r.report.backgroundWindows = await h.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map(w => ({ title: w.getTitle(), focused: w.isFocused(), bounds: w.getBounds() }))).catch(() => [])
    await writeFile(path.join(out, 'renderer-build.txt'), h.buildOutput)
    await h.close().catch(e => promise('All isolated test resources clean up', false, e.message, 'cleanup'))
  }
  promise('No console errors', r.report.console.length === 0, r.report.console, 'console',
    measurements.find(row => row.state === 'offline-banner' && row.variant === 'messenger-1024x700-dock-open')?.screenshot)
  r.report.findings = [...findings.values()]
  r.report.screenshots = shots
  await writeFile(path.join(r.dir('data'), 'ui-measurements.json'), JSON.stringify(measurements, null, 2))
  r.finish()
}
