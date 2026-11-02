// Actual Electron, Hermes sessions and UI, with only temporary profiles and a loopback fake model.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

export async function runRoomAcceptance() {
  delete process.env.HERMES_DESK_E2E_VISIBLE
  const out = path.join(artifacts, `local-rooms-${Date.now()}`)
  await mkdir(out, { recursive: true })
  const report = { checks: [], failure: null, errors: [] }
  let h
  try {
    h = await launchHarness()
    let { page } = h
    assert(h.env.HERMES_HOME.startsWith(`${h.root}${path.sep}`))
    await page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
    report.runtime = { kind: h.runtimeKind, source: h.source,
      version: (await page.evaluate(() => window.nubAgent.host.status())).serve.version }
    // Only this harness's seeded default profile is changed, never a user's profile.
    await h.app.evaluate(async () => {
      const result = await globalThis.__hermesDeskE2E.serveClient.call('profiles.configure', {
        name: 'default', ui_meta: { display_name: 'Chief', orchestrator: true },
      })
      if (result.ui_meta === false) throw new Error('Could not configure the temporary Chief')
    })
    await page.reload()
    await page.getByRole('button', { name: 'Chief', exact: true }).waitFor()
    const welcome = page.getByRole('dialog', { name: 'Welcome to Hermes Desk', exact: true })
    if (await welcome.isVisible()) {
      await welcome.getByRole('button', { name: 'Start using Hermes Desk', exact: true }).click()
    }
    const journal = name => page.evaluate(name => {
      const value = JSON.parse(localStorage.getItem('maia:agents-store:v2') || 'null')?.value
      return value?.conversations.find(c => c.target.type === 'group' && c.title === name)?.localRoom ?? null
    }, name)
    const rpc = () => h.app.evaluate(() => globalThis.__hermesDeskE2ERpc)
    const backendEpoch = () => h.app.evaluate(() =>
      globalThis.__hermesDeskE2EEvents.findLast(event => event.name === 'gateway.ready')?.epoch)
    const createRoom = async name => {
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Chats', exact: true }).click()
      await page.locator('.desk-chats-actions').getByRole('button', { name: 'New shared room', exact: true }).click()
      const editor = page.getByRole('dialog', { name: 'Create group', exact: true })
      await editor.getByRole('textbox', { name: 'Name', exact: true }).fill(name)
      for (const member of ['Chief', 'Alpha', 'Beta']) {
        const button = editor.getByRole('button', { name: new RegExp(`^${member} (?:Add|Added)$`) })
        const selected = await button.getAttribute('aria-pressed') === 'true'
        if (selected !== (member !== 'Chief')) await button.click()
      }
      await editor.getByTestId('group-chief-hint').waitFor()
      await editor.getByRole('button', { name: 'Create group', exact: true }).click()
      await editor.waitFor({ state: 'hidden' })
      await waitFor(() => page.evaluate(name => {
        const value = JSON.parse(localStorage.getItem('maia:agents-store:v2') || 'null')?.value
        return value?.conversations.find(c => c.id === value.selectedConversationId)?.title === name
      }, name), `select created room ${name}`, 5000)
      await page.getByRole('textbox', { name: 'Message the agent', exact: true }).waitFor()
      assert(await page.getByRole('textbox', { name: 'Message the agent', exact: true }).isEnabled())
    }
    const send = async text => {
      const input = page.getByRole('textbox', { name: 'Message the agent', exact: true })
      await input.fill(text)
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await waitFor(() => page.evaluate(text => {
        const value = JSON.parse(localStorage.getItem('maia:agents-store:v2') || 'null')?.value
        const room = value?.conversations.find(c => c.id === value.selectedConversationId)?.localRoom
        return room?.messages.findLast(m => m.speakerKind === 'human')?.text === text
      }, text), 'room durably accepts the new ask', 5000)
    }
    const settled = name => waitFor(async () => {
      const state = await journal(name)
      return state?.turns.length === 4 && state.turns.every(t => t.status === 'sent') ? state : null
    }, 'Chief delegation, two specialists and settled wrap', 45000)
    const latestSettled = name => waitFor(async () => {
      const state = await journal(name)
      const root = state?.messages.findLast(m => m.speakerKind === 'human')
      const turns = state?.turns.filter(t => t.rootId === root?.id)
      return turns?.length === 4 && turns.every(t => t.status === 'sent') ? state : null
    }, `${name}'s current root settles`, 45000)
    const pending = async name => {
      const bindings = Object.values((await journal(name)).bindings)
      return h.app.evaluate(async (_electron, bindings) => (await Promise.all(bindings.map(b =>
        globalThis.__hermesDeskE2E.serveClient.call('session.events.since',
          { session_id: b.runtimeId, profile: b.profile, last_seen: 0 })))).flatMap(reply => reply.open_requests ?? []), bindings)
    }
    const permission = () => page.getByRole('region', { name: 'Local tool permissions' })
    const deny = () => permission().getByRole('button', { name: /^(?:Don't allow|Deny once)$/ }).click()
    const openRoom = async name => {
      await page.getByRole('button', { name: 'Chats', exact: true }).click()
      await page.getByRole('list', { name: 'Chats', exact: true })
        .getByRole('button', { name: new RegExp(`^${name}(?:\\s|$)`) }).click()
    }

    await createRoom('Acceptance room')
    await send('E2E:room acceptance')
    const first = await settled('Acceptance room')
    const bindings = Object.values(first.bindings)
    assert.equal(bindings.length, 3)
    assert.equal(new Set(bindings.map(b => b.runtimeId)).size, 3)
    assert.deepEqual(bindings.map(b => b.profile).sort(), ['alpha', 'beta', 'default'])
    assert.equal(first.messages.filter(m => m.speakerKind === 'human').length, 1)
    const speakers = first.messages.filter(m => m.speakerKind === 'agent').map(m => m.speakerId)
    assert.equal(speakers.length, 4)
    assert.equal(speakers[0], 'profile:default')
    assert.equal(speakers.at(-1), 'profile:default')
    assert.deepEqual(speakers.slice(1, -1).sort(), ['profile:alpha', 'profile:beta'])
    await page.getByTestId('chat-scroller').getByText('Room outcome: Alpha and Beta completed their independent checks.', { exact: true }).waitFor()
    await page.getByTestId('stop-turn').waitFor({ state: 'hidden' })
    const specialistRequests = h.model.requests.filter(r => r.body.stream &&
      /You are (Alpha|Beta)\./.test(r.body.messages.findLast(m => m.role === 'user')?.content ?? ''))
    const specialistCompletions = h.model.responses.filter(r => r.streaming &&
      /^\[(Alpha|Beta)\]/.test(r.message?.content ?? ''))
    assert.equal(specialistRequests.length, 2)
    assert.equal(specialistCompletions.length, 2)
    assert(Math.max(...specialistRequests.map(r => r.at)) < Math.min(...specialistCompletions.map(r => r.at)),
      'Both specialist model requests must start before either finishes')
    const submitted = (await rpc()).filter(frame => frame.method === 'prompt.submit')
    assert.equal(submitted.length, 4)
    assert.equal(submitted.at(-1).profile, 'default')
    report.checks.push('UI creates a room; account Chief delegates to overlapping isolated Alpha/Beta sessions and wraps once')
    await page.screenshot({ path: path.join(out, 'room.png') })

    await h.send('alpha', 'chat', 'dm-isolation')
    await page.getByText('Fake streaming answer for dm-isolation. Local-only and deterministic.', { exact: true }).first().waitFor()
    await page.getByTestId('stop-turn').waitFor({ state: 'hidden' })
    const dm = (await rpc()).filter(frame => frame.method === 'prompt.submit').at(-1)
    assert(!bindings.some(b => b.runtimeId === dm.sessionId))
    assert.equal(await page.getByText('Room outcome: Alpha and Beta completed their independent checks.', { exact: true }).count(), 0)
    await openRoom('Acceptance room')
    const beforeReload = (await rpc()).filter(frame => frame.method === 'prompt.submit').length
    await page.reload()
    await page.getByTestId('chat-scroller').getByText('Room outcome: Alpha and Beta completed their independent checks.', { exact: true }).waitFor()
    const reloaded = (await journal('Acceptance room')).bindings
    for (const [member, before] of Object.entries(first.bindings)) {
      const { lastSeen, ...identity } = before
      const { lastSeen: current, ...restored } = reloaded[member]
      assert.deepEqual(restored, identity)
      assert(current >= lastSeen, 'Reload must not rewind a live replay cursor')
    }
    assert.equal((await rpc()).filter(frame => frame.method === 'prompt.submit').length, beforeReload)
    report.checks.push('DM uses another session; room bindings and displayed history survive reload without resubmission')

    await createRoom('Second room')
    await send('E2E:room second')
    const second = await settled('Second room')
    assert(Object.values(second.bindings).every(b => !bindings.some(old => old.storedId === b.storedId || old.runtimeId === b.runtimeId)))
    report.checks.push('A second room has separate stored and runtime bindings for every profile')

    const modelBefore = h.model.requests.length
    await send('E2E:roomstop cancellation')
    await waitFor(() => h.model.requests.slice(modelBefore).filter(r => r.body.stream &&
      /You are (Alpha|Beta)\./.test(r.body.messages.findLast(m => m.role === 'user')?.content ?? '')).length === 2,
    'two real room members awaiting cancellation', 45000)
    const beforeStop = (await rpc()).length
    await page.getByTestId('stop-turn').click()
    await page.getByTestId('stop-turn').waitFor({ state: 'hidden' })
    const interrupted = (await rpc()).slice(beforeStop).filter(frame => frame.method === 'session.interrupt')
    assert.deepEqual(interrupted.map(frame => frame.profile).sort(), ['alpha', 'beta'])
    const stopped = await waitFor(async () => {
      const state = await journal('Second room')
      const root = state.messages.findLast(m => m.speakerKind === 'human')
      const turns = state.turns.filter(t => t.rootId === root.id)
      return turns.filter(t => t.status === 'cancelled').length === 2 && !turns.some(t => ['queued', 'running'].includes(t.status)) ? state : null
    }, 'durable room cancellation')
    assert.equal(stopped.messages.filter(m => m.text.includes('must be interrupted')).length, 0)
    report.checks.push('Stop interrupts both actual member sessions and durably settles the room without a cancelled answer')

    await openRoom('Acceptance room')
    await send('E2E:roomapprove first-room')
    await waitFor(async () => (await pending('Acceptance room')).length === 2, 'two first-room approvals')
    const firstCard = await permission().innerText()
    assert.match(firstCard, /(?:Alpha|Beta) (?:needs approval|requests permission)/)
    await openRoom('Second room')
    await send('E2E:roomapprove second-room')
    await waitFor(async () => (await pending('Second room')).length === 2, 'two second-room approvals')
    const asks = [...await pending('Acceptance room'), ...await pending('Second room')]
    assert.equal(new Set(asks.map(ask => ask.id)).size, 4)
    await openRoom('Acceptance room')
    assert.equal(await permission().innerText(), firstCard)
    const responseStart = (await rpc()).length
    await deny()
    await waitFor(async () => (await pending('Acceptance room')).length === 1, 'only the answered request is removed')
    assert.equal((await pending('Second room')).length, 2)
    await deny()
    await latestSettled('Acceptance room')
    await openRoom('Second room')
    for (let remaining = 1; remaining >= 0; remaining--) {
      await deny()
      await waitFor(async () => (await pending('Second room')).length === remaining, 'second-room approval queue drains')
    }
    await latestSettled('Second room')
    const responses = (await rpc()).slice(responseStart).filter(frame => frame.method === 'approval.response')
    assert.equal(responses.length, 4)
    assert(responses.every(frame => frame.choice === 'deny'))
    assert.deepEqual(responses.map(frame => frame.requestId).sort(), asks.map(ask => ask.id).sort())
    report.checks.push('Four actual approvals across two rooms retain member identity; switching and denying drain only their owning queues')

    const beforeRestart = await journal('Acceptance room')
    const oldEpoch = await backendEpoch()
    assert(oldEpoch)
    const submitCount = (await rpc()).filter(frame => frame.method === 'prompt.submit').length
    await page.evaluate(() => window.nubAgent.host.restartServe())
    const restartedEpoch = await waitFor(async () => {
      const epoch = await backendEpoch()
      return epoch && epoch !== oldEpoch ? epoch : null
    }, 'backend restarts into a new epoch', 45000)
    const recovered = await journal('Acceptance room')
    for (const [id, binding] of Object.entries(recovered.bindings)) {
      assert.equal(binding.storedId, beforeRestart.bindings[id].storedId)
      assert.equal(binding.profile, beforeRestart.bindings[id].profile)
    }
    assert.equal((await rpc()).filter(frame => frame.method === 'prompt.submit').length, submitCount)
    const beforeAppRestart = await journal('Second room')
    const oldOrigin = new URL(page.url()).origin
    await h.restartApp({ newOrigin: true })
    page = h.page
    assert.notEqual(new URL(page.url()).origin, oldOrigin)
    await page.getByRole('navigation', { name: 'Your agents', exact: true }).getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
    const restartedWelcome = page.getByRole('dialog', { name: 'Welcome to Hermes Desk', exact: true })
    if (await restartedWelcome.isVisible()) await restartedWelcome.getByRole('button', { name: 'Start using Hermes Desk', exact: true }).click()
    await openRoom('Second room')
    await page.getByTestId('chat-scroller').getByText('Room outcome: Alpha and Beta completed their independent checks.', { exact: true }).first().waitFor()
    const appEpoch = await waitFor(async () => {
      const epoch = await backendEpoch()
      return epoch && epoch !== restartedEpoch ? epoch : null
    }, 'new Electron owns a new backend epoch', 45000)
    const restarted = await journal('Second room')
    assert.deepEqual(restarted.messages.map(m => m.id), beforeAppRestart.messages.map(m => m.id))
    for (const [id, binding] of Object.entries(restarted.bindings)) assert.equal(binding.storedId, beforeAppRestart.bindings[id].storedId)
    assert.equal((await rpc()).filter(frame => frame.method === 'prompt.submit').length, 0)
    await send('E2E:room after-full-restart')
    const resumed = await latestSettled('Second room')
    for (const [id, binding] of Object.entries(resumed.bindings)) {
      assert.equal(binding.epoch, appEpoch)
      assert.equal(binding.storedId, beforeAppRestart.bindings[id].storedId)
      assert.notEqual(binding.runtimeId, beforeAppRestart.bindings[id].runtimeId)
    }
    report.checks.push('Backend and full Electron/backend restarts recover stored sessions and history without replaying submissions; new work still completes')

    const native = await page.evaluate(() => window.nubAgent.roomJournal.read())
    assert(native.ok && native.revision > 0)
    assert(JSON.parse(native.value).conversations.some(c => c.title === 'Second room'))
    report.checks.push('App-owned atomic room checkpoints survive a full restart on a different renderer origin')

    for (const scenario of ['roomcrash', 'roomapprove']) {
      await send(`@Alpha E2E:${scenario} abrupt-${scenario}`)
      const active = await waitFor(async () => {
        const state = await journal('Second room')
        const root = state?.messages.findLast(m => m.speakerKind === 'human')
        const turn = state?.turns.find(t => t.rootId === root?.id && t.status === 'running')
        return turn && (scenario === 'roomcrash' ? turn.partialText.includes('Partial crash fixture') : (await pending('Second room')).length === 1)
          ? { state, root, turn } : null
      }, `actual ${scenario} before abrupt backend death`, 45000)
      const oldRequests = scenario === 'roomapprove' ? await pending('Second room') : []
      const responseStart = (await rpc()).length
      const currentModelCalls = () => h.model.requests.filter(request => {
        if (!request.body.stream) return false
        const prompt = request.body.messages.findLast(m => m.role === 'user')?.content ?? ''
        const trigger = prompt.lastIndexOf('[This turn answers ')
        return prompt.slice(trigger < 0 ? 0 : trigger).includes(`E2E:${scenario} abrupt-${scenario}`)
      }).length
      const modelCallCount = currentModelCalls()
      const submissions = (await rpc()).filter(frame => frame.method === 'prompt.submit').length
      const epoch = await backendEpoch()
      const killedPid = await h.crashServe()
      await waitFor(async () => {
        const next = await backendEpoch()
        return next && next !== epoch
      }, 'automatic backend recovery after SIGKILL', 45000)
      const recoveredCrash = await waitFor(async () => {
        const state = await journal('Second room')
        const turn = state?.turns.find(t => t.id === active.turn.id)
        return turn && !['queued', 'running'].includes(turn.status) ? state : null
      }, 'interrupted work reconciles without resubmission', 45000)
      report.crash = { scenario, killedPid, before: active.state, after: recoveredCrash,
        events: await h.app.evaluate(() => globalThis.__hermesDeskE2EEvents) }
      assert.equal((await rpc()).filter(frame => frame.method === 'prompt.submit').length, submissions)
      assert.equal(currentModelCalls(), modelCallCount, 'The backend must not independently auto-continue this room request')
      assert.deepEqual(recoveredCrash.messages.filter(m => m.speakerKind === 'human').map(m => m.id),
        active.state.messages.filter(m => m.speakerKind === 'human').map(m => m.id))
      assert(!recoveredCrash.messages.some(m => m.rootId === active.root.id && m.speakerKind === 'agent'))
      assert.equal((await pending('Second room')).length, 0)
      await permission().waitFor({ state: 'hidden' })
      assert(!(await rpc()).slice(responseStart).some(frame => frame.method === 'approval.response' &&
        oldRequests.some(request => request.id === frame.requestId)))
      await send(`E2E:room recovered-${scenario}`)
      await latestSettled('Second room')
      report.checks.push(`SIGKILL fixture-owned backend ${killedPid} during ${scenario === 'roomcrash' ? 'streaming partial reply' : 'tool approval'}: no resubmission, stale card or phantom completion; fresh work resumes`)
      ;(report.crashes ??= []).push({ scenario, killedPid, rootId: active.root.id,
        status: recoveredCrash.turns.find(t => t.id === active.turn.id).status })
      delete report.crash
    }

    const usagePanel = page.getByTestId('room-usage')
    await usagePanel.locator('summary').click()
    const budgetInput = usagePanel.getByRole('spinbutton', { name: 'Per-request token budget' })
    await budgetInput.fill('1')
    await usagePanel.getByRole('button', { name: 'Save token budget', exact: true }).click()
    await waitFor(async () => (await journal('Second room')).tokenBudget === 1, 'budget is durably saved')
    const beforeBudget = (await rpc()).filter(frame => frame.method === 'prompt.submit').length
    await send('E2E:room budget-pauses-delegation')
    const paused = await waitFor(async () => {
      const state = await journal('Second room')
      const root = state.messages.findLast(m => m.speakerKind === 'human')
      const turns = state.turns.filter(t => t.rootId === root.id)
      return turns.length === 3 && turns[0].status === 'sent' && turns.slice(1).every(t => t.status === 'queued') ? state : null
    }, 'reported tokens pause the two delegated members', 45000)
    assert(paused.turns.some(t => t.usage?.total > 0))
    assert.equal((await rpc()).filter(frame => frame.method === 'prompt.submit').length, beforeBudget + 1)
    await usagePanel.getByRole('status').waitFor()
    await budgetInput.fill('1000')
    await usagePanel.getByRole('button', { name: 'Save token budget', exact: true }).click()
    const budgetResumed = await latestSettled('Second room')
    assert.equal(budgetResumed.tokenBudget, 1000)
    for (const id of ['profile:default', 'profile:alpha', 'profile:beta'])
      assert(budgetResumed.turns.some(t => t.memberId === id && t.usage?.total > 0))
    assert.equal((await rpc()).filter(frame => frame.method === 'prompt.submit').length, beforeBudget + 4)
    const savedBudget = await page.evaluate(() => JSON.parse(window.nubAgent.roomJournal.read().value))
    assert.equal(savedBudget.conversations.find(c => c.title === 'Second room').localRoom.tokenBudget, 1000)
    report.checks.push('Actual reported usage is attributed to all three members; a durable one-token request budget pauses delegation, and raising it resumes exactly the queued work')

    assert.deepEqual(h.consoleErrors, [])
    assert.deepEqual(h.model.errors, [])
    const network = (await h.network()).filter(e => e.type === 'request')
    assert(network.every(e => e.cancel || new URL(e.url).hostname === '127.0.0.1' ||
      ['file:', 'data:', 'devtools:', 'about:', 'blob:'].includes(new URL(e.url).protocol)))
    report.checks.push('No renderer/model errors; all allowed network requests stay on loopback')
  } catch (error) {
    report.failure = String(error.stack ?? error)
  } finally {
    try {
      report.errors = h?.consoleErrors ?? []
      if (h && report.failure) {
        report.hostStates = await h.app.evaluate(() => globalThis.__hermesDeskE2EHostStates).catch(() => [])
        await writeFile(path.join(out, 'electron.txt'), h.logs.join(''))
        await writeFile(path.join(out, 'visible-ui.txt'), await h.page.locator('body').innerText().catch(() => 'Renderer unavailable'))
        await h.page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
        report.host = await h.page.evaluate(() => window.nubAgent.host.status()).catch(() => null)
        report.rooms = await h.page.evaluate(() => {
          const value = JSON.parse(localStorage.getItem('maia:agents-store:v2') || 'null')?.value
          return { selectedConversationId: value?.selectedConversationId,
            conversations: value?.conversations.map(c => ({ id: c.id, title: c.title, target: c.target,
              bindings: c.localRoom?.bindings, turns: c.localRoom?.turns.map(t => ({ id: t.id, member: t.memberId, status: t.status, error: t.error })) })) }
        }).catch(() => null)
        report.modelTrace = h.model.requests.map(r => {
          const prompt = r.body.messages?.findLast(m => m.role === 'user')?.content ?? ''
          const trigger = prompt.lastIndexOf('[This turn answers ')
          return { at: r.at, member: /You are (\w+)\./.exec(prompt)?.[1],
            scenario: /E2E:\S+ \S+/.exec(trigger < 0 ? prompt : prompt.slice(trigger))?.[0] }
        })
      }
      await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
    } finally { await h?.close() }
  }
  return { out, ...report }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runRoomAcceptance()
  console.log(JSON.stringify(report, null, 2))
  if (report.failure) process.exitCode = 1
}
