// Actual isolated Electron -> Hermes -> authenticated desktop MCP -> Serve -> UI.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'
import { genUiFromResult, genUiResultFromResult } from '../../electron/local/mcp/genui.mjs'

async function bufferedRoomTiming(h, report) {
  const page = h.page
  const count = () => h.app.evaluate(() => globalThis.__hermesDeskE2ERpc.filter(f => f.method === 'prompt.submit').length)
  const roomJournal = () => page.evaluate(() => {
    const saved = window.nubAgent.roomJournal.read()
    return JSON.parse(saved.value).conversations.find(c => c.title === 'Generated data room').localRoom
  })
  await page.getByRole('button', { name: 'Chats', exact: true }).click()
  await page.getByRole('list', { name: 'Chats', exact: true }).getByRole('button', { name: /^Generated data room(?:\s|$)/ }).click()
  await page.getByRole('checkbox', { name: 'recover review draft', exact: true }).waitFor()
  const before = await count()
  await page.getByRole('textbox', { name: 'Message the agent', exact: true }).fill('@Alpha E2E:roomgenui buffered')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await waitFor(() => h.model.isGenUiHeld('buffered'), 'actual buffered tool-call gate', 45000)
  const initial = await roomJournal()
  const turn = initial.turns.findLast(t => t.status === 'running')
  const binding = initial.bindings[turn.memberId]
  assert(!turn.toolEvents?.length)
  assert.equal(await count(), before + 1)
  // Fixed timing only: hold the ORIGINAL invoke handler before sending this
  // one owning replay RPC. No substituted transport, response, event or DOM.
  await h.app.evaluate(({ ipcMain }, sessionId) => {
    const channel = 'maia:serveSocketSend'
    const original = ipcMain._invokeHandlers.get(channel)
    if (typeof original !== 'function') throw new Error('Native replay timing hook requires the registered socket invoke handler')
    const control = globalThis.__genUiReplayTiming = { held: false, release: null, restore: null }
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, payload) => {
      const frames = String(payload?.data ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
      if (!control.held && frames.some(frame => frame.method === 'session.events.since' && frame.params?.session_id === sessionId)) {
        control.held = true
        return new Promise((resolve, reject) => {
          control.release = () => Promise.resolve(original(event, payload)).then(resolve, reject)
        })
      }
      return original(event, payload)
    })
    control.restore = () => { ipcMain.removeHandler(channel); ipcMain.handle(channel, original) }
  }, binding.runtimeId)
  try {
    await waitFor(() => h.app.evaluate(() => globalThis.__genUiReplayTiming.held), 'real room liveness replay held at native IPC', 45000)
    assert(h.model.releaseGenUi('buffered'))
    await waitFor(() => h.model.isGenUiHeld('buffered-final'), 'real successful MCP result before withheld final prose', 45000)
    const resultMessage = h.model.requests.findLast(r => r.body.messages.some(m => m.role === 'user' &&
      String(m.content).includes('E2E:roomgenui buffered')))?.body.messages.findLast(m => m.role === 'tool')
    const line = String(resultMessage?.content).split('\n').find(line => line.startsWith('{"result":'))
    const expected = genUiResultFromResult(line ? JSON.parse(line) : resultMessage?.content)
    assert(expected?.genuiOccurrence)
    assert(!(await roomJournal()).turns.find(t => t.id === turn.id).toolEvents?.length)
    assert(h.model.releaseGenUi('buffered-final'))
    const replay = await waitFor(() => h.app.evaluate(async (_electron, { binding, turn }) => {
      const replay = await globalThis.__hermesDeskE2E.serveClient.call('session.events.since', {
        profile: binding.profile, session_id: binding.runtimeId, last_seen: turn.startSeq ?? 0,
      })
      return replay.events?.some(event => event.type === 'message.complete') ? replay : null
    }, { binding, turn }), 'actual long model reply completes and truncates backend cache', 45000)
    assert(replay.truncated, 'Native proof requires actual backend cache truncation, not fabricated replay content')
    assert(!replay.events.some(event => event.type === 'tool.complete' && event.payload?.name?.endsWith('render_ui')),
      'The real cache must have evicted render completion while native live data remains buffered')
    assert.equal((await roomJournal()).turns.find(t => t.id === turn.id).status, 'running')
    await h.app.evaluate(() => { globalThis.__genUiReplayTiming.release() })
    await page.getByRole('checkbox', { name: 'buffered review draft', exact: true }).waitFor({ timeout: 45000 })
    await page.getByTestId('stop-turn').waitFor({ state: 'hidden', timeout: 45000 })
    const final = (await roomJournal()).messages.findLast(m => m.roomTurnId === turn.id)
    assert.deepEqual(final.toolEvents[0].genui, expected.genui)
    assert.equal(final.toolEvents[0].genuiOccurrence, expected.genuiOccurrence)
    assert(final.text.startsWith('Generated data settled for buffered.'))
    assert.equal(await count(), before + 1)
    await page.reload()
    await page.getByRole('checkbox', { name: 'buffered review draft', exact: true }).waitFor({ timeout: 45000 })
    assert.equal(await count(), before + 1)
    report.bufferedTiming = { actualBackendCacheTruncated: true, renderAbsentFromReplay: true,
      successfulRenderBeforeWithheldProse: true, retainedComponents: final.toolEvents[0].genui.components.length,
      originalSubmissions: 1, retainedOccurrence: expected.genuiOccurrence, nativeCheckpointAndReload: true }
    report.checks.push('Native held owning replay merges a real buffered successful render after actual backend cache eviction, with one original submission and durable checkpoint/reload')
  } finally {
    await h.app.evaluate(() => { globalThis.__genUiReplayTiming.restore() })
  }
}

async function outerEpochExportTiming(h, report) {
  const page = h.page
  const evidence = report.outerEpochTiming = { stage: 'starting', nativeControlSucceeded: false }
  const rpc = () => h.app.evaluate(() => globalThis.__hermesDeskE2ERpc)
  const journal = () => page.evaluate(() => {
    const saved = window.nubAgent.roomJournal.read()
    return JSON.parse(saved.value).conversations.find(c => c.title === 'Generated data room').localRoom
  })
  const before = (await rpc()).length
  await page.getByRole('textbox', { name: 'Message the agent', exact: true }).fill('@Alpha E2E:roomgenui outerepoch')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await waitFor(() => h.model.isGenUiHeld('outerepoch'), 'real room accepts its original submission before MCP completion', 45000)
  const initial = await journal()
  const turn = initial.turns.findLast(t => t.status === 'running')
  const binding = initial.bindings[turn.memberId]
  evidence.oldEpoch = binding.epoch
  evidence.owner = { turnId: turn.id, runtimeId: binding.runtimeId, storedId: binding.storedId, memberId: turn.memberId }
  await page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Beta', exact: true }).click()
  await page.getByRole('textbox', { name: 'Message the agent', exact: true }).fill('E2E:genui outerdm')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await waitFor(() => h.model.isGenUiHeld('outerdm-final'), 'other-profile real completed render before burst final prose', 45000)
  const dmFrame = (await rpc()).findLast(frame => frame.method === 'prompt.submit' && frame.profile === 'beta')
  const dm = await h.app.evaluate(async (_electron, runtimeId) =>
    globalThis.__hermesDeskE2E.serveClient.call('session.history', { profile: 'beta', session_id: runtimeId }), dmFrame.sessionId)
  assert(dm.messages.some(row => row.role === 'tool' && row.name?.endsWith('render_ui') && row.result === undefined))
  const config = await page.evaluate(() => window.nubAgent.serveConfig())
  // Same durable session as the owning Beta chat; use the real stored identity.
  const storedId = await page.evaluate(() => {
    const value = JSON.parse(localStorage.getItem('maia:agents-store:v2') || 'null')?.value
    return value.conversations.find(c => c.target.type === 'agent' && c.target.agentId === 'profile:beta').hermesSessionId
  })
  const exactUrl = `${config.baseUrl}/api/sessions/${encodeURIComponent(storedId)}/export?profile=beta`
  evidence.exactExportUrl = exactUrl
  const cdp = await page.context().newCDPSession(page)
  let response = { requestId: null, requestedAt: null, finished: false, failed: null }
  const exports = new Map()
  await cdp.send('Network.enable')
  cdp.on('Network.requestWillBeSent', event => {
    if (event.request.url === exactUrl) exports.set(event.requestId,
      { requestId: event.requestId, requestedAt: Date.now(), finished: false, failed: null })
  })
  cdp.on('Network.loadingFinished', event => { const own = exports.get(event.requestId); if (own) own.finished = true })
  cdp.on('Network.loadingFailed', event => { const own = exports.get(event.requestId); if (own) own.failed = event.errorText })
  await page.addInitScript(sessionId => {
    const evidence = window.__genUiOuterRelay = { closes: [], ready: [], frames: [], replayResponses: [] }
    window.__genUiOuterRelayRelease = window.nubAgent.serveSocket.onEvent(event => {
      if (event.type === 'close') evidence.closes.push({ id: event.id, at: Date.now() })
      if (event.type !== 'message') return
      for (const line of event.data.split('\n').filter(Boolean)) {
        const packet = JSON.parse(line)
        const params = packet.params
        if (Array.isArray(packet.result?.events)) evidence.replayResponses.push({
          id: packet.id, socket: event.id, at: Date.now(), epoch: packet.result.epoch,
          latestSeq: packet.result.latest_seq, truncated: packet.result.truncated })
        if (params?.type === 'gateway.ready') evidence.ready.push({ id: event.id, at: Date.now(), epoch: params.payload?.replay_epoch })
        if (params?.session_id === sessionId) evidence.frames.push({ id: event.id, at: Date.now(),
          type: params.type, seq: params.seq, payload: params.payload })
      }
    })
  }, binding.runtimeId)
  // No source/harness/security/permission handler changes. Repository and
  // harness register no onHeadersReceived listener; other webRequest events
  // remain untouched. The filter, lifetime and one held callback are exact.
  await h.app.evaluate(({ BrowserWindow }, { exactUrl, rendererUrl }) => {
    const contents = BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === rendererUrl).webContents
    const wr = contents.session.webRequest
    const control = globalThis.__genUiExportHeaderTiming = { held: false, released: false, release: null,
      statusCode: null, receivedAt: null, releasedAt: null, beforeHeadersJSON: null, afterHeadersJSON: null,
      callbackResultBefore: null, callbackResultAfter: null, restore: () => wr.onHeadersReceived(null) }
    wr.onHeadersReceived({ urls: [exactUrl] }, async (details, callback) => {
      const unchanged = Object.freeze({})
      if (details.url !== exactUrl || control.held) { callback(unchanged); return }
      const replies = await contents.executeJavaScript('window.__genUiOuterRelay?.replayResponses ?? []').catch(() => [])
      const own = replies.findLast(reply => reply.truncated && globalThis.__hermesDeskE2ERpc.some(frame =>
        frame.id === reply.id && frame.socket === reply.socket && frame.profile === 'beta' &&
        frame.method === 'session.events.since' && !String(frame.id).startsWith('hd_main_')))
      // A UI's ordinary historical export is not the affected replay await.
      if (!own) { callback(unchanged); return }
      control.matchedReplay = own
      control.nativeRequestId = details.id
      control.held = true
      control.statusCode = details.statusCode
      control.receivedAt = Date.now()
      control.beforeHeadersJSON = JSON.stringify(details.responseHeaders)
      control.callbackResultBefore = JSON.stringify(unchanged)
      control.release = () => {
        if (control.released) return
        control.afterHeadersJSON = JSON.stringify(details.responseHeaders)
        control.callbackResultAfter = JSON.stringify(unchanged)
        control.releasedAt = Date.now(); control.released = true
        callback(unchanged)
      }
    })
  }, { exactUrl, rendererUrl: page.url() })
  try {
    evidence.stage = 'awaiting genuine truncated replay/export'
    const cached = await h.app.evaluate(async (_electron, sessionId) =>
      globalThis.__hermesDeskE2E.serveClient.call('session.events.since', { profile: 'beta', session_id: sessionId, last_seen: 0 }), dmFrame.sessionId)
    evidence.actualDmCache = { truncated: cached.truncated, events: cached.events.length, latestSeq: cached.latest_seq }
    assert(cached.truncated, 'Native setup requires genuine replay-cache eviction')
    const rpcStart = (await rpc()).length
    await page.reload()
    // Warm the actual imported DM/binding before closing. Closing at profiles.list
    // races lazy thread hydration: that socket's open-set may not include Beta.
    // This ordinary UI export passes unchanged; only a later truncated REPLAY
    // export can satisfy the native callback control's causal predicate.
    await waitFor(() => [...exports.values()].some(request => request.finished),
      'ordinary owning Beta history hydration completes before native reconnect', 15000)
    await page.getByRole('checkbox', { name: 'outerdm review draft', exact: true }).waitFor({ timeout: 15000 })
    const opened = await waitFor(async () => (await rpc()).slice(rpcStart).find(frame =>
      frame.method === 'session.history' && frame.profile === 'beta' && !String(frame.id).startsWith('hd_main_')),
    'fresh real renderer client has observed open and issued its first RPC', 15000)
    assert((await page.evaluate(id => window.nubAgent.serveSocket.close(id), opened.socket)).ok)
    await waitFor(() => h.app.evaluate(() => globalThis.__genUiExportHeaderTiming.held), 'genuine proxy raw-export response headers held', 45000)
    const outstanding = [...exports.values()].filter(request => !request.finished && !request.failed)
    assert.equal(outstanding.length, 1, 'The held original export must identify one unambiguous actual HTTP request')
    response = outstanding[0]
    evidence.stage = 'holding genuine response'
    assert.equal(await h.app.evaluate(() => globalThis.__genUiExportHeaderTiming.statusCode), 200)
    assert(h.model.releaseGenUi('outerepoch'))
    await waitFor(() => page.evaluate(() => window.__genUiOuterRelay.frames.some(f => f.type === 'message.complete')),
      'real room successful render and terminal arrive while other DM export is held', 5000)
    const relayBefore = await page.evaluate(() => window.__genUiOuterRelay)
    const successful = relayBefore.frames.find(f => f.type === 'tool.complete' && f.payload?.name?.endsWith('render_ui'))
    const result = genUiResultFromResult(successful?.payload)
    assert(result?.genuiOccurrence)
    const buffered = (await journal()).turns.find(t => t.id === turn.id)
    assert.equal(buffered.status, 'running')
    assert(!buffered.toolEvents?.length)
    evidence.bufferedOccurrence = result.genuiOccurrence
    evidence.bufferedSequences = relayBefore.frames.filter(f => ['tool.complete', 'message.complete'].includes(f.type)).map(f => f.seq)
    evidence.stage = 'restarting only owned fixture backend'
    evidence.killedFixturePid = await h.crashServe()
    const next = await waitFor(() => page.evaluate(old => window.__genUiOuterRelay.ready.find(r => r.epoch && r.epoch !== old), binding.epoch),
      'real replacement gateway epoch before the existing export timeout', 8000)
    evidence.newEpoch = next.epoch
    const beforeRelease = await waitFor(async () => {
      const current = (await journal()).bindings[turn.memberId]
      return current.epoch === next.epoch ? current : null
    }, 'replacement epoch checkpoint before original export callback release', 1500)
    assert.equal(beforeRelease.epoch, next.epoch)
    assert.equal(beforeRelease.lastSeen, 0)
    evidence.beforeRetiredCallbackRelease = { epoch: beforeRelease.epoch, lastSeen: beforeRelease.lastSeen }
    await h.app.evaluate(() => globalThis.__genUiExportHeaderTiming.release())
    const headers = await h.app.evaluate(() => {
      const { held, released, statusCode, receivedAt, releasedAt, beforeHeadersJSON, afterHeadersJSON,
        callbackResultBefore, callbackResultAfter, matchedReplay, nativeRequestId } = globalThis.__genUiExportHeaderTiming
      return { held, released, statusCode, receivedAt, releasedAt, beforeHeadersJSON, afterHeadersJSON, callbackResultBefore, callbackResultAfter, matchedReplay, nativeRequestId }
    })
    headers.beforeHeadersSHA = createHash('sha256').update(headers.beforeHeadersJSON).digest('hex')
    headers.afterHeadersSHA = createHash('sha256').update(headers.afterHeadersJSON).digest('hex')
    delete headers.beforeHeadersJSON
    delete headers.afterHeadersJSON
    evidence.headers = headers
    evidence.originalRequestAt = response.requestedAt
    assert(headers.releasedAt - response.requestedAt < 10000, 'Release must precede the unchanged original request timeout')
    assert(headers.releasedAt - headers.receivedAt < 10000, 'Original callback must release inside the unchanged export timeout')
    assert.equal(headers.beforeHeadersSHA, headers.afterHeadersSHA)
    assert.equal(headers.callbackResultBefore, headers.callbackResultAfter)
    await waitFor(() => response.finished || response.failed, 'original HTTP response completion after unchanged callback release', 5000)
    evidence.responseFailure = response.failed
    assert(!response.failed, 'Proxy teardown must not destroy the held original response')
    const body = await cdp.send('Network.getResponseBody', { requestId: response.requestId })
    const bytes = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8')
    evidence.responseBodySHA256 = createHash('sha256').update(bytes).digest('hex')
    evidence.originalCdpRequestId = response.requestId
    assert(Array.isArray(JSON.parse(bytes.toString()).messages))
    // Chromium withholds this exact response's body until the original header
    // callback returns; no second request/body substitution is used for a hash.
    evidence.bodyBeforeReleaseUnavailable = true
    await page.evaluate(async () => { for (let i = 0; i < 150; i++) await Promise.resolve() })
    await waitFor(async () => (await rpc()).slice(before).some(frame =>
      frame.method === 'session.events.since' && frame.profile === 'beta' && frame.socket === next.id && !String(frame.id).startsWith('hd_main_')),
    'replacement recovery actually progresses on the genuine new socket', 10000)
    const final = await journal()
    const oldFinal = final.messages.find(m => m.roomTurnId === turn.id)
    assert(!oldFinal?.toolEvents?.some(e => e.genuiOccurrence === result.genuiOccurrence))
    assert(!oldFinal?.text?.includes('Generated data settled for outerepoch.'))
    const relay = await page.evaluate(() => window.__genUiOuterRelay)
    assert(relay.closes.some(close => close.id !== next.id))
    const newFrames = relay.frames.filter(frame => frame.id === next.id)
    const newWatermark = final.bindings[turn.memberId].lastSeen
    assert(newWatermark <= Math.max(0, ...newFrames.map(frame => frame.seq ?? 0)), 'No retired cursor may contaminate replacement epoch')
    const submissions = (await rpc()).slice(before).filter(frame => frame.method === 'prompt.submit')
    assert.equal(submissions.filter(frame => frame.profile === 'alpha').length, 1)
    assert.equal(submissions.filter(frame => frame.profile === 'beta').length, 1)
    evidence.realSocketCloses = relay.closes
    evidence.realGatewayReady = relay.ready
    evidence.newWatermark = newWatermark
    evidence.originalSubmissions = { room: 1, dm: 1 }
    evidence.nativeControlSucceeded = true
    evidence.stage = 'passed without retired settlement/widget/cursor'
    report.checks.push('Native original authenticated export header callback spans real backend/socket/epoch replacement; retired room buffer cannot settle or contaminate the new cursor, and replacement recovery progresses without resubmission')
  } finally {
    evidence.responseFailure = response.failed
    await h.app.evaluate(() => { const control = globalThis.__genUiExportHeaderTiming; control.release?.(); control.restore() })
    await page.evaluate(() => window.__genUiOuterRelayRelease?.()).catch(() => {})
    evidence.relayAtExit = await page.evaluate(() => window.__genUiOuterRelay).catch(() => null)
    evidence.recoveryRpcs = (await rpc()).slice(before).filter(f => ['prompt.submit', 'session.events.since', 'session.history'].includes(f.method))
    await cdp.detach()
  }
}

export async function runGenUiAcceptance() {
  delete process.env.HERMES_DESK_E2E_VISIBLE
  const out = path.join(artifacts, `genui-${Date.now()}`)
  await mkdir(out, { recursive: true })
  const report = { checks: [], screenshots: [], checklistGeometry: [], failure: null }
  let h
  try {
    h = await launchHarness()
    let page = h.page
    const rpcCount = () => h.app.evaluate(() => globalThis.__hermesDeskE2ERpc.filter(f => f.method === 'prompt.submit').length)
    const idle = () => page.getByTestId('stop-turn').waitFor({ state: 'hidden', timeout: 45000 })
    const cards = () => page.locator('[data-genui-type]')
    const screenshot = async name => {
      await page.getByTestId('generated-ui').last().scrollIntoViewIfNeeded()
      // Capture settled existing transcript transitions, not a half-faded row.
      await page.waitForTimeout(500)
      const geometry = await page.locator('.genui-checklist label').evaluateAll(labels => labels.map(label => {
        const input = label.querySelector('input').getBoundingClientRect()
        const text = label.querySelector('span').getBoundingClientRect()
        return Math.abs(input.top + input.height / 2 - text.top - text.height / 2)
      }))
      report.checklistGeometry.push({ name, verticalCenterDifferences: geometry })
      assert(geometry.every(difference => difference <= 2), 'Native single-line checkbox labels must align in both skins')
      await page.screenshot({ path: path.join(out, `${name}.png`) })
      report.screenshots.push(path.join(out, `${name}.png`))
    }
    const openAlpha = () => page.getByRole('navigation', { name: 'Your agents', exact: true })
      .getByRole('button', { name: 'Alpha', exact: true }).click()
    await page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
    const notice = page.getByRole('button', { name: 'Got it', exact: true })
    if (await notice.count()) await notice.click()
    await h.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:')).setSize(1100, 1000)
    })
    report.runtime = { kind: h.runtimeKind, source: h.source }
    assert(h.env.HERMES_HOME.startsWith(`${h.root}${path.sep}`))
    await h.send('alpha', 'genui', 'alpha')
    await page.getByTestId('chat-scroller').getByText('Generated data settled for alpha.', { exact: true }).waitFor({ timeout: 45000 })
    await idle()
    assert.equal(await cards().count(), 4)
    assert.deepEqual(await cards().evaluateAll(nodes => nodes.map(n => n.dataset.genuiType)), ['stat', 'table', 'bar_chart', 'checklist'])
    assert((await page.getByTestId('generated-ui').innerText()).includes('Agent-provided data, not verified'))
    assert((await h.state()).lanes.every(lane => lane.tabs.length === 0), 'Data-only tool must not open a browser tab')
    const modelTools = h.model.requests.flatMap(r => r.body.messages.filter(m => m.role === 'tool'))
    assert(modelTools.some(m => {
      const line = String(m.content).split('\n').find(line => line.startsWith('{"result":'))
      try { return genUiFromResult(line ? JSON.parse(line) : m.content)?.components.length === 4 } catch { return false }
    }), 'Real MCP result must reach the model intact')
    report.checks.push('Real model-selected authenticated render_ui call renders all four types without a browser tab')
    await screenshot('01-messenger')

    const beforeClick = await rpcCount(), modelBeforeClick = h.model.requests.length
    const checkbox = page.getByRole('checkbox', { name: 'alpha review draft', exact: true })
    await checkbox.focus()
    await checkbox.press('Space')
    assert(await checkbox.isChecked())
    await page.waitForTimeout(250)
    assert.equal(await rpcCount(), beforeClick)
    assert.equal(h.model.requests.length, modelBeforeClick)
    report.backendHistory = await h.app.evaluate(async () => {
      const submitted = globalThis.__hermesDeskE2ERpc.findLast(f => f.method === 'prompt.submit' && f.profile === 'alpha')
      const history = await globalThis.__hermesDeskE2E.serveClient.call('session.history', { session_id: submitted.sessionId, profile: 'alpha' })
      return { nativeProjectedRows: history.messages.length, rawResultsOmitted: history.messages.some(row =>
        row.role === 'tool' && row.name?.endsWith('render_ui') && row.result === undefined && row.content === undefined) }
    })
    await page.reload()
    await page.getByRole('checkbox', { name: 'alpha review draft', exact: true }).waitFor({ timeout: 45000 })
    assert(await page.getByRole('checkbox', { name: 'alpha review draft', exact: true }).isChecked())
    assert.equal(await cards().count(), 4)
    assert.equal(await rpcCount(), beforeClick)
    assert((await h.network()).some(request => /\/api\/sessions\/[^/]+\/export\?profile=alpha$/.test(request.url)),
      'Actual hydration must read the owning raw backend export, not renderer-only memory')
    report.checks.push('Raw backend history restores full specs once; keyboard checkbox notes reload without prompts/model calls')

    await page.evaluate(() => window.nubAgent.host.setConfig({ appearance: { messengerSkin: false } }))
    await page.reload()
    await page.getByRole('checkbox', { name: 'alpha review draft', exact: true }).waitFor({ timeout: 45000 })
    assert.equal(await cards().count(), 4)
    await screenshot('02-classic')
    await h.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
      main.setMinimumSize(480, 600)
      main.setSize(640, 900)
    })
    await waitFor(() => page.evaluate(() => window.innerWidth <= 640), 'disposable narrow renderer viewport')
    assert(await cards().evaluateAll(nodes => nodes.every(n => n.scrollWidth <= n.clientWidth + 1)), 'Cards must not overflow at narrow width')
    await screenshot('03-narrow-classic')
    await page.evaluate(() => window.nubAgent.host.setConfig({ appearance: { messengerSkin: true } }))
    await page.reload()
    await page.getByRole('checkbox', { name: 'alpha review draft', exact: true }).waitFor({ timeout: 45000 })
    assert.equal(await cards().count(), 4)
    assert(await cards().evaluateAll(nodes => nodes.every(n => n.scrollWidth <= n.clientWidth + 1)), 'Messenger cards must not overflow at narrow width')
    await screenshot('03b-narrow-messenger')
    report.checks.push('Both skins render the same data at 640px with contained content and aligned native checkboxes')

    await h.send('beta', 'genui', 'beta')
    await page.getByTestId('chat-scroller').getByText('Generated data settled for beta.', { exact: true }).waitFor({ timeout: 45000 })
    await idle()
    assert.equal(await cards().count(), 4)
    assert.equal(await page.getByRole('checkbox', { name: 'alpha review draft', exact: true }).count(), 0)
    assert(!(await page.getByRole('checkbox', { name: 'beta review draft', exact: true }).isChecked()))
    await openAlpha()
    await page.getByRole('checkbox', { name: 'alpha review draft', exact: true }).waitFor()
    assert(await page.getByRole('checkbox', { name: 'alpha review draft', exact: true }).isChecked())
    report.checks.push('Profile and conversation widgets/notes remain isolated')

    await h.send('alpha', 'genui', 'hostile')
    await page.getByTestId('chat-scroller').getByText('Generated data settled for hostile.', { exact: true }).waitFor({ timeout: 45000 })
    await idle()
    assert.equal(await cards().count(), 4)
    assert(h.model.requests.some(r => r.body.messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('bad_args:'))))
    assert.equal(await page.locator('.genui img, .genui script, .genui a, .genui iframe').count(), 0)
    // Consent is fixture-only and still exercises the actual confirmed writer.
    await h.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) })
    assert.equal((await page.evaluate(() => window.nubAgent.host.disableBrowserControl(['alpha']))).ok, true)
    await h.send('alpha', 'genui', 'disabled')
    await page.getByTestId('chat-scroller').getByText('Generated data settled for disabled.', { exact: true }).waitFor({ timeout: 45000 })
    await idle()
    assert.equal(await cards().count(), 4)
    const disabled = h.model.requests.findLast(r => r.body.messages.some(m => m.role === 'user' && String(m.content).includes('E2E:genui disabled')))
      ?.body.messages.findLast(m => m.role === 'tool')
    const disabledLine = String(disabled?.content).split('\n').find(line => line.startsWith('{"error":') || line.startsWith('{"result":'))
    report.disabledResult = disabledLine ? JSON.parse(disabledLine) : disabled?.content
    assert(report.disabledResult?.error || /(?:not_enabled|blocked_by_policy|app_unavailable):/.test(JSON.stringify(report.disabledResult)),
      'Confirmed profile revocation must return an error, never a data spec')
    assert.equal(genUiFromResult(report.disabledResult), null)
    assert.equal((await page.evaluate(() => window.nubAgent.host.enableBrowserControl(['alpha']))).ok, true)
    await page.evaluate(() => window.nubAgent.host.setConfig({ appearance: { messengerSkin: true } }))
    // New sessions must load the newly confirmed MCP credential/config.
    await h.restartApp()
    page = h.page
    await page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
    report.checks.push('Hostile spec and unauthorized-profile tool fail closed and add no widgets')

    await h.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:')).setSize(1100, 900)
    })
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    await page.locator('.desk-chats-actions').getByRole('button', { name: 'New shared room', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Create group', exact: true })
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Generated data room')
    for (const member of ['Alpha', 'Beta']) {
      const button = editor.getByRole('button', { name: new RegExp(`^${member} (?:Add|Added)$`) })
      if (await button.getAttribute('aria-pressed') !== 'true') await button.click()
    }
    await editor.getByRole('button', { name: 'Create group', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    const input = page.getByRole('textbox', { name: 'Message the agent', exact: true })
    await input.fill('@Alpha E2E:roomgenui roomalpha')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.getByRole('checkbox', { name: 'roomalpha review draft', exact: true }).waitFor({ timeout: 45000 })
    await idle()
    assert.equal(await cards().count(), 4)
    const journal = await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('maia:agents-store:v2')).value
      return data.conversations.find(c => c.title === 'Generated data room').localRoom
    })
    assert.equal(journal.messages.filter(m => m.speakerKind === 'agent' && m.toolEvents?.length).length, 1)
    assert.equal(journal.messages.find(m => m.toolEvents?.length).speakerId, 'profile:alpha')
    const durableRoom = await page.evaluate(() => {
      const stored = window.nubAgent.roomJournal.read()
      if (!stored.ok || !stored.value) throw new Error('Native room checkpoint missing')
      return JSON.parse(stored.value).conversations.find(c => c.title === 'Generated data room').localRoom
    })
    assert.deepEqual(durableRoom.messages.find(m => m.toolEvents?.length).toolEvents,
      journal.messages.find(m => m.toolEvents?.length).toolEvents)
    report.nativeRoomCheckpoint = { revisioned: true, owner: 'profile:alpha', components: 4 }
    await screenshot('04-room')
    const roomNoteCount = await rpcCount(), roomModelCount = h.model.requests.length
    await page.getByRole('checkbox', { name: 'roomalpha review draft', exact: true }).press('Space')
    assert(await page.getByRole('checkbox', { name: 'roomalpha review draft', exact: true }).isChecked())
    assert.equal(await rpcCount(), roomNoteCount)
    assert.equal(h.model.requests.length, roomModelCount)
    await input.fill('@Alpha E2E:roomgenui roomalpha')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await waitFor(async () => await page.getByRole('checkbox', { name: 'roomalpha review draft', exact: true }).count() === 2,
      'second identical room render occurrence', 45000)
    await idle()
    assert.equal(await cards().count(), 8)
    assert.deepEqual(await page.getByRole('checkbox', { name: 'roomalpha review draft', exact: true }).evaluateAll(inputs => inputs.map(input => input.checked)),
      [true, false])
    report.roomOccurrences = await page.evaluate(() => {
      const stored = window.nubAgent.roomJournal.read()
      return JSON.parse(stored.value).conversations.find(c => c.title === 'Generated data room').localRoom.messages
        .filter(m => m.speakerKind === 'agent').flatMap(m => m.toolEvents ?? [])
        .map(event => ({ id: event.toolCallId, occurrence: event.genuiOccurrence }))
    })
    assert.equal(report.roomOccurrences.length, 2)
    const providerRoomCalls = h.model.responses.flatMap(response => response.message?.tool_calls ?? [])
      .filter(call => call.id === 'fake_roomgenui_roomalpha_0')
    assert.equal(providerRoomCalls.length, 2)
    assert.equal(providerRoomCalls[0].id, providerRoomCalls[1].id)
    assert.equal(providerRoomCalls[0].function.arguments, providerRoomCalls[1].function.arguments)
    // This installed Hermes suffixes duplicates with _d2. The focused red
    // regression also covers backends which leave the reused ID unchanged.
    report.providerRoomIds = providerRoomCalls.map(call => call.id)
    assert(report.roomOccurrences.every(event => event.occurrence))
    assert.notEqual(report.roomOccurrences[0].occurrence, report.roomOccurrences[1].occurrence)
    const beforeReload = await rpcCount()
    await page.reload()
    await page.getByRole('checkbox', { name: 'roomalpha review draft', exact: true }).nth(1).waitFor({ timeout: 45000 })
    assert.equal(await cards().count(), 8)
    assert.deepEqual(await page.getByRole('checkbox', { name: 'roomalpha review draft', exact: true }).evaluateAll(inputs => inputs.map(input => input.checked)),
      [true, false])
    assert.equal(await rpcCount(), beforeReload)
    report.checks.push('Room checkpoint/reload preserves separate notes for identical payloads and reused provider IDs across two durable occurrences, without backend note calls')

    await h.restartApp()
    page = h.page
    await page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    await page.getByRole('list', { name: 'Chats', exact: true }).getByRole('button', { name: /^Generated data room(?:\s|$)/ }).click()
    await page.getByRole('checkbox', { name: 'roomalpha review draft', exact: true }).nth(1).waitFor({ timeout: 45000 })
    assert.equal(await cards().count(), 8)
    assert.deepEqual(await page.getByRole('checkbox', { name: 'roomalpha review draft', exact: true }).evaluateAll(inputs => inputs.map(input => input.checked)),
      [true, false])

    // Keep the actual app/backend alive while destroying only its renderer.
    // The persisted room is running/submitted and has no recovery tool result.
    const recoveryInput = page.getByRole('textbox', { name: 'Message the agent', exact: true })
    await recoveryInput.fill('@Alpha E2E:roomgenui recover')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await waitFor(() => h.model.isGenUiHeld('recover'),
      'actual backend accepts the room prompt and waits before the MCP tool call', 45000)
    const recovery = await waitFor(() => page.evaluate(() => {
      const stored = window.nubAgent.roomJournal.read()
      const room = JSON.parse(stored.value).conversations.find(c => c.title === 'Generated data room').localRoom
      const turn = room.turns.findLast(t => t.status === 'running' && t.submittedText?.includes('E2E:roomgenui recover'))
      return turn && !turn.toolEvents?.length ? { turn, binding: room.bindings[turn.memberId] } : null
    }), 'durable running/submitted recovery turn before MCP completion', 45000)
    const recoverySubmits = await rpcCount(), rendererUrl = page.url()
    await h.app.evaluate(async ({ BrowserWindow }, url) => {
      await BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url).loadURL('about:blank')
    }, rendererUrl)
    assert.equal(page.url(), 'about:blank')
    assert(h.model.releaseGenUi('recover'))
    const replay = await waitFor(() => h.app.evaluate(async (_electron, recovery) => {
      const reply = await globalThis.__hermesDeskE2E.serveClient.call('session.events.since', {
        profile: recovery.binding.profile, session_id: recovery.binding.runtimeId, last_seen: recovery.turn.startSeq ?? 0,
      })
      return reply.events?.some(event => event.type === 'message.complete' && event.payload?.text === 'Generated data settled for recover.')
        ? reply : null
    }, recovery), 'real backend settles while renderer is disconnected', 45000)
    const completedRender = replay.events.find(event => event.type === 'tool.complete' && event.payload?.name?.endsWith('render_ui'))
    const recoveredResult = genUiResultFromResult(completedRender?.payload)
    assert(recoveredResult?.genuiOccurrence)
    await h.app.evaluate(async ({ BrowserWindow }, url) => {
      await BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === 'about:blank').loadURL(url)
    }, rendererUrl)
    await page.getByRole('checkbox', { name: 'recover review draft', exact: true }).waitFor({ timeout: 45000 })
    await idle()
    assert.equal(await cards().count(), 12)
    assert.equal(await rpcCount(), recoverySubmits)
    const recoveredCheckpoint = await page.evaluate(() => {
      const stored = window.nubAgent.roomJournal.read()
      return JSON.parse(stored.value).conversations.find(c => c.title === 'Generated data room').localRoom.messages.at(-1)
    })
    assert.equal(recoveredCheckpoint.text, 'Generated data settled for recover.')
    assert.deepEqual(recoveredCheckpoint.toolEvents[0].genui, recoveredResult.genui)
    assert.equal(recoveredCheckpoint.toolEvents[0].genuiOccurrence, recoveredResult.genuiOccurrence)
    await page.reload()
    await page.getByRole('checkbox', { name: 'recover review draft', exact: true }).waitFor({ timeout: 45000 })
    assert.equal(await cards().count(), 12)
    assert.equal(await rpcCount(), recoverySubmits)
    report.recovery = { submittedBeforeDisconnect: true, disconnectedBeforeRenderCompletion: true,
      terminalAndSuccessfulResultInBackendReplay: true, widgetsAfterReconnectAndReload: 12,
      finalOccurrence: recoveredResult.genuiOccurrence, submissionsBeforeAndAfter: recoverySubmits }
    report.checks.push('A real submitted room disconnects before render completion; terminal replay preserves the prior successful spec and occurrence through native checkpoint/reload without resubmission')
    await openAlpha()
    await page.getByRole('checkbox', { name: 'alpha review draft', exact: true }).waitFor({ timeout: 45000 })
    assert.equal(await cards().count(), 4)
    assert(await page.getByRole('checkbox', { name: 'alpha review draft', exact: true }).isChecked())
    report.checks.push('Disposable actual app/backend restart restores owning room and DM data with no duplicate cards')
    await screenshot('05-restarted-dm')

    await page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Beta', exact: true }).click()
    await page.getByRole('checkbox', { name: 'beta review draft', exact: true }).waitFor({ timeout: 45000 })
    assert.equal(await cards().count(), 4)
    await h.send('beta', 'genui', 'toolonly')
    await page.getByRole('checkbox', { name: 'toolonly review draft', exact: true }).waitFor({ timeout: 45000 })
    assert.equal(await cards().count(), 8)
    const toolOnlyContainer = page.getByTestId('generated-ui').filter({ has: page.getByRole('heading', { name: 'toolonly agent estimate', exact: true }) })
    assert.equal(await toolOnlyContainer.locator('[data-genui-type]').count(), 4)
    assert.equal(await page.getByTestId('chat-scroller').getByText('Tool-only fixture finished.', { exact: true }).count(), 0)
    await screenshot('06-tool-only-messenger')
    await page.evaluate(() => window.nubAgent.host.setConfig({ appearance: { messengerSkin: false } }))
    await page.reload()
    await page.getByRole('checkbox', { name: 'toolonly review draft', exact: true }).waitFor({ timeout: 45000 })
    assert.equal(await cards().count(), 8)
    assert.equal(await page.getByTestId('chat-scroller').getByText('Tool-only fixture finished.', { exact: true }).count(), 0)
    await screenshot('07-tool-only-classic')
    assert(h.model.releaseGenUi('toolonly'))
    await page.getByTestId('chat-scroller').getByText('Tool-only fixture finished.', { exact: true }).waitFor({ timeout: 45000 })
    await idle()
    assert.equal(await cards().count(), 8)
    report.checks.push('Real completed tool-only output renders and hydrates in both skins before final assistant prose; releasing the model finishes once')

    const dmNotesBefore = await rpcCount(), dmModelBefore = h.model.requests.length
    await page.getByRole('checkbox', { name: 'beta review draft', exact: true }).press('Space')
    assert(await page.getByRole('checkbox', { name: 'beta review draft', exact: true }).isChecked())
    assert.equal(await rpcCount(), dmNotesBefore)
    assert.equal(h.model.requests.length, dmModelBefore)
    await h.send('beta', 'genui', 'beta')
    await page.getByRole('checkbox', { name: 'beta review draft', exact: true }).nth(1).waitFor({ timeout: 45000 })
    await idle()
    assert.equal(await cards().count(), 12)
    assert.deepEqual(await page.getByRole('checkbox', { name: 'beta review draft', exact: true }).evaluateAll(inputs => inputs.map(input => input.checked)),
      [true, false])
    const repeatedDmSubmits = await rpcCount()
    await page.reload()
    await page.getByRole('checkbox', { name: 'beta review draft', exact: true }).nth(1).waitFor({ timeout: 45000 })
    assert.equal(await cards().count(), 12)
    assert.deepEqual(await page.getByRole('checkbox', { name: 'beta review draft', exact: true }).evaluateAll(inputs => inputs.map(input => input.checked)),
      [true, false])
    assert.equal(await rpcCount(), repeatedDmSubmits)
    const providerDmCalls = h.model.responses.flatMap(response => response.message?.tool_calls ?? [])
      .filter(call => call.id === 'fake_genui_beta_0')
    assert.equal(providerDmCalls.length, 2)
    assert.equal(providerDmCalls[0].function.arguments, providerDmCalls[1].function.arguments)
    report.providerDmIds = providerDmCalls.map(call => call.id)
    report.checks.push('Two identical DM renders with reused provider IDs retain separate local notes after actual owning backend history hydration, without model or prompt calls for interaction')

    await bufferedRoomTiming(h, report)
    await outerEpochExportTiming(h, report)
    assert((await h.state()).lanes.every(lane => lane.tabs.length === 0))
    report.modelErrors = h.model.errors
    report.consoleErrors = h.consoleErrors
    report.network = await h.network()
    assert(report.network.every(request => {
      const url = new URL(request.url)
      return ['file:', 'data:', 'devtools:', 'about:', 'blob:'].includes(url.protocol) ||
        (url.hostname === '127.0.0.1' && ['http:', 'ws:'].includes(url.protocol))
    }), 'No remote network calls')
    assert.deepEqual(h.model.errors, [])
    assert.deepEqual(h.consoleErrors, [])
  } catch (error) {
    report.failure = error.stack
    if (h) {
      report.modelErrors = h.model.errors
      report.consoleErrors = h.consoleErrors
      report.toolNames = h.model.requests.map(r => r.body.tools?.map(t => t.function?.name) ?? [])
      report.mcpDiagnostics = h.logs.filter(line => /mcp|render_ui|toolset/i.test(line))
        .map(line => line.replace(/(?:token|auth)[=:]\S+/gi, '[redacted]'))
      await h.page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
    }
    throw error
  } finally {
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
    if (h) await h.close()
    console.log(`Generated UI native evidence: ${out}`)
  }
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  runGenUiAcceptance().catch(error => { console.error(error); process.exitCode = 1 })
}
