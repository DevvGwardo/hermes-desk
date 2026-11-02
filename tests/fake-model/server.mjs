import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

export const FIXTURE_VALUE = 'obviously-fake-e2e-password-do-not-use'
export const PAGE_TITLE = 'Hermes Desk Local Fixture'

function userScenario(messages) {
  const index = messages.findLastIndex(message => message.role === 'user' &&
    typeof message.content === 'string' && message.content.includes('E2E:'))
  assert(index >= 0, 'A scripted E2E user prompt is required')
  const prompt = messages[index].content
  // Room backlog is genuine conversation data, not the current scripted action.
  const trigger = prompt.lastIndexOf('[This turn answers ')
  const match = /E2E:(delegatechild|delegate|roomgenui|genui|roomapprove|roomcrash|roomstop|room|chat|skill|parallel|browse|redaction|takeover|stop|tabs|approve|watchdog|media)(?:\s+(\S+))?/.exec(trigger < 0 ? prompt : prompt.slice(trigger))
  assert(match, 'Unknown E2E scenario')
  return { scenario: match[1], label: match[2] || 'alpha', prompt, tail: messages.slice(index + 1) }
}

function roomMember(prompt) {
  const member = /\bYou are (Chief|Alpha|Beta)\./.exec(prompt)?.[1]
  assert(member, 'Expected a named room fixture member')
  return member
}

function toolName(body, action) {
  const names = (body.tools || []).map(tool => tool.function?.name)
    .filter(name => typeof name === 'string' && /hermes.?desk/i.test(name) && name.endsWith(action))
  assert.equal(names.length, 1, `Expected exactly one Hermes Desk ${action} tool`)
  return names[0]
}

function text(message) {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  const line = content.split('\n').find(line => line.startsWith('{"result":') || line.startsWith('{"error":'))
  if (!line) return content
  const decoded = JSON.parse(line)
  return decoded.result ?? decoded.error
}

export function scriptedReply(body, fixtureUrl) {
  const { scenario, label, prompt, tail } = userScenario(body.messages || [])
  const results = tail.filter(message => message.role === 'tool')
  const call = (action, args) => ({
    role: 'assistant', content: null,
    tool_calls: [{ id: `fake_${scenario}_${label}_${results.length}`, type: 'function',
      function: { name: toolName(body, action), arguments: JSON.stringify(args) } }],
  })
  const answer = content => ({ role: 'assistant', content })
  // Hermes's automatic session-title auxiliary request has no tool catalog.
  if (!body.tools) return answer(`Local E2E ${scenario} ${label}`)
  if (scenario === 'genui' || scenario === 'roomgenui') {
    if (results.length) return answer(label === 'toolonly' ? 'Tool-only fixture finished.'
      : `Generated data settled for ${label}.${['buffered', 'outerdm'].includes(label) ? ` ${'Synthetic replay progress. '.repeat(300)}` : ''}`)
    const spec = { version: 1, components: [
      { type: 'stat', title: `${label} agent estimate`, value: '12', detail: 'Synthetic agent-provided data, not live telemetry' },
      { type: 'table', title: `${label} work queue`, columns: ['Task', 'Count'], rows: [['Review draft', 3], ['Local checks', 9]] },
      { type: 'bar_chart', title: `${label} task counts`, items: [{ label: 'Review', value: 3 }, { label: 'Checks', value: 9 }], unit: 'tasks' },
      { type: 'checklist', title: `${label} next steps`, items: [{ id: 'review', label: `${label} review draft` }, { id: 'check', label: `${label} run local checks` }] },
    ] }
    if (label === 'hostile') spec.components[0] = { type: 'html', html: '<img src=https://evil.invalid onerror=alert(1)>', onclick: 'fetch()' }
    return call('render_ui', spec)
  }
  if (scenario === 'room' || scenario === 'roomstop' || scenario === 'roomapprove' || scenario === 'roomcrash') {
    const member = roomMember(prompt)
    if (member === 'Chief') return answer(prompt.includes('Your delegated work has settled.')
      ? 'Room outcome: Alpha and Beta completed their independent checks.'
      : `@Alpha E2E:${scenario} ${label}-alpha-task verify the isolated session. @Beta E2E:${scenario} ${label}-beta-task verify shared context.`)
    if (scenario === 'roomapprove') {
      if (results.length) return answer(`[${member}] ${member} approval settled: ${String(text(results.at(-1))).slice(0, 80)}`)
      assert((body.tools || []).some(tool => tool.function?.name === 'terminal'), 'Expected the terminal tool')
      return { role: 'assistant', content: null, tool_calls: [{ id: `fake_roomapprove_${member}_${label}`, type: 'function',
        function: { name: 'terminal', arguments: JSON.stringify({ command: `rm -r ./hd-e2e-room-${member}-${label}` }) } }] }
    }
    return answer(scenario === 'roomstop'
      ? 'This room answer must be interrupted, not completed.'
      : `[${member}] ${member} result: independent room check completed.`)
  }
  if (scenario === 'chat') return answer(`Fake streaming answer for ${label}. Local-only and deterministic.`)
  if (scenario === 'media') {
    const encoded = /\bHD_MEDIA:([A-Za-z0-9_-]+)/.exec(prompt)?.[1]
    assert(encoded, 'Expected encoded synthetic media paths')
    const paths = JSON.parse(Buffer.from(encoded, 'base64url').toString())
    assert(Array.isArray(paths) && paths.length <= 6 && paths.every(file => typeof file === 'string' && file.startsWith('/')))
    return answer(`Local media fixtures.\n${paths.map(file => `MEDIA:${JSON.stringify(file)}`).join('\n')}`)
  }
  if (scenario === 'delegatechild') return answer(`Native delegated child ${label} completed.`)
  if (scenario === 'delegate') {
    if (results.length) return answer(`Native delegation dispatched for ${label}.`)
    assert((body.tools || []).some(tool => tool.function?.name === 'delegate_task'), 'Expected native delegate_task')
    return { role: 'assistant', content: null, tool_calls: [{ id: `fake_delegate_${label}`, type: 'function',
      function: { name: 'delegate_task', arguments: JSON.stringify({
        tasks: [{ goal: `E2E:delegatechild ${label} isolated native child`, context: 'Local-only lifecycle fixture.' }],
      }) } }] }
  }
  if (scenario === 'skill') {
    if (results.length) return answer(`Native skill result for ${label}: ${text(results.at(-1))}`)
    assert((body.tools || []).some(tool => tool.function?.name === 'skill_view'), 'Expected native skill_view')
    return { role: 'assistant', content: null, tool_calls: [{ id: `fake_skill_${label}`, type: 'function',
      function: { name: 'skill_view', arguments: JSON.stringify({ name: label }) } }] }
  }
  if (scenario === 'parallel') return answer(`Parallel streaming answer for ${label}. Each profile owns its own conversation.`)
  if (scenario === 'watchdog') return answer(`${'Progress continues through this local-only fixture. '.repeat(80)}Long-running reply finished.`)
  if (scenario === 'stop') return answer('This slow answer must be interrupted, not completed.')
  if (scenario === 'approve') {
    // A recursive delete of a relative, nonexistent directory: Hermes gates it behind an approval
    // (the mascot probe denies it), and it would be a no-op inside the sandbox even if approved.
    if (results.length) return answer(`Approval round-trip for ${label}: ${String(text(results.at(-1))).slice(0, 80)}`)
    const terminal = (body.tools || []).map(tool => tool.function?.name).find(name => name === 'terminal')
    assert(terminal, 'Expected the terminal tool')
    return { role: 'assistant', content: null, tool_calls: [{ id: `fake_approve_${label}_0`, type: 'function',
      function: { name: terminal, arguments: JSON.stringify({ command: 'rm -r ./hd-e2e-mascot-approval-probe' }) } }] }
  }
  if (scenario === 'tabs') {
    return results.length ? answer(`Lane ${label}: ${text(results.at(-1))}`) : call('browser_tabs', {})
  }
  if (scenario === 'takeover') {
    return results.length ? answer(`Takeover result: ${text(results.at(-1))}`) : call('browser_snapshot', {})
  }
  if (results.length <= 2 && results.some(result =>
    /^(?:not_enabled|app_unavailable|user_took_control|timeout|blocked_by_policy|tab_closed):/.test(text(result)))) {
    return answer(`Browser tool failed: ${text(results.at(-1))}`)
  }
  if (!results.length) {
    return call('browser_navigate', { url: `${fixtureUrl}/${scenario === 'redaction' ? 'login' : label}` })
  }
  if (results.length === 1) return call('browser_snapshot', {})
  const snapshot = text(results.at(-1))
  assert(!snapshot.includes(FIXTURE_VALUE), 'A fixture password reached the model')
  if (scenario === 'redaction') {
    assert(/sensitive|hidden/i.test(snapshot), 'Expected redacted password field in the snapshot')
    return answer('Redaction verified: password value hidden.')
  }
  if (results.length === 2) {
    const ref = snapshot.split('\n').find(line => /button.*Record click|Record click.*button/i.test(line))
      ?.match(/ref=(e\d+)/)?.[1]
    assert(ref, `No Record click button in snapshot: ${snapshot.slice(0, 1000)}`)
    return call('browser_click', { ref })
  }
  assert(results.some(result => text(result).includes(PAGE_TITLE)), 'Page title missing from real tool results')
  return answer(`I browsed "${PAGE_TITLE}" in lane ${label}.`)
}

export async function startFakeModel({ fixtureUrl, onRequest = () => {}, chunkMs = 15 } = {}) {
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureUrl), 'Only local fixture URLs are supported')
  const requests = [], responses = [], errors = [], active = new Set()
  const delegateGates = new Map()
  const genUiGates = new Map()
  const server = http.createServer(async (request, response) => {
    active.add(response)
    const abort = new AbortController()
    response.once('close', () => { active.delete(response); abort.abort() })
    try {
      if (request.method === 'GET' && request.url.endsWith('/models')) {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'hermes-desk-fake', object: 'model' }] }))
        return
      }
      if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
        response.writeHead(404).end('Only local chat/completions is supported')
        return
      }
      let raw = ''
      for await (const data of request) {
        raw += data
        assert(raw.length < 8 * 1024 * 1024, 'Model request exceeds 8 MiB')
      }
      const body = JSON.parse(raw)
      const receipt = { at: performance.now(), body }
      requests.push(receipt)
      onRequest(receipt)
      const message = scriptedReply(body, fixtureUrl)
      const id = `chatcmpl-fake-${requests.length}`
      const base = { id, created: 1, model: body.model || 'hermes-desk-fake' }
      const finish_reason = message.tool_calls ? 'tool_calls' : 'stop'
      const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      if (!body.stream) {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ ...base, object: 'chat.completion',
          choices: [{ index: 0, message, finish_reason }], usage }))
        responses.push({ at: performance.now(), id, message, streaming: false })
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      response.flushHeaders()
      const send = (delta, finish = null) => response.write(`data: ${JSON.stringify({
        ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`)
      send({ role: 'assistant', content: '' })
      const scripted = userScenario(body.messages)
      if (scripted.scenario === 'roomgenui' && ['recover', 'buffered', 'outerepoch'].includes(scripted.label) && message.tool_calls) {
        // Disconnect the real renderer BEFORE successful MCP completion, then
        // allow Hermes to finish while offline so recovery must replay results.
        await new Promise(resolve => {
          genUiGates.set(scripted.label, resolve)
          abort.signal.addEventListener('abort', resolve, { once: true })
        })
        genUiGates.delete(scripted.label)
        if (abort.signal.aborted) return
      }
      if (scripted.scenario === 'roomgenui' && scripted.label === 'buffered' && !message.tool_calls) {
        // The real render result has completed; withhold prose until native
        // assertions verify it is buffered, then evict the real 512-event cache.
        const gate = `${scripted.label}-final`
        await new Promise(resolve => {
          genUiGates.set(gate, resolve)
          abort.signal.addEventListener('abort', resolve, { once: true })
        })
        genUiGates.delete(gate)
        if (abort.signal.aborted) return
      }
      if (scripted.scenario === 'genui' && scripted.label === 'toolonly' && !message.tool_calls) {
        // A genuine completed tool-only bubble before any assistant text.
        // Hermes retries empty final responses, so release normal final prose
        // only AFTER native tests have exercised that intermediate UI state.
        await new Promise(resolve => {
          genUiGates.set(scripted.label, resolve)
          abort.signal.addEventListener('abort', resolve, { once: true })
        })
        genUiGates.delete(scripted.label)
        if (abort.signal.aborted) return
      }
      if (scripted.scenario === 'roomcrash' && roomMember(scripted.prompt) !== 'Chief') {
        send({ content: 'Partial crash fixture, not a completed answer. ' })
        responses.push({ at: performance.now(), id, firstToken: true })
        try { await delay(30000, undefined, { signal: abort.signal }) } catch { return }
      }
      if (scripted.scenario === 'delegatechild' && !(body.tools || []).some(tool => tool.function?.name === 'delegate_task')) {
        await new Promise(resolve => {
          delegateGates.set(scripted.label, resolve)
          abort.signal.addEventListener('abort', resolve, { once: true })
        })
        delegateGates.delete(scripted.label)
        if (abort.signal.aborted) return
      }
      if (scripted.scenario === 'stop' ||
        (scripted.scenario === 'roomstop' && roomMember(scripted.prompt) !== 'Chief')) {
        try { await delay(30000, undefined, { signal: abort.signal }) } catch { return }
      }
      if (message.tool_calls) {
        const tool = message.tool_calls[0]
        send({ tool_calls: [{ index: 0, id: tool.id, type: 'function',
          function: { name: tool.function.name, arguments: '' } }] })
        for (const part of tool.function.arguments.match(/.{1,12}/gs) || []) {
          if (response.destroyed) return
          send({ tool_calls: [{ index: 0, function: { arguments: part } }] })
          await delay(chunkMs)
        }
      } else {
        const chunks = message.content.match(/.{1,8}/gs) || []
        for (const part of chunks) {
          if (response.destroyed) return
          send({ content: part })
          responses.push({ at: performance.now(), id, firstToken: true })
          await delay(scripted.scenario === 'parallel' || scripted.scenario === 'room' ? 100 : chunkMs)
        }
      }
      if (scripted.scenario === 'genui' && scripted.label === 'outerdm' && !message.tool_calls) {
        // Keep the real DM running (and its runtime identity alive) after >512
        // genuine deltas, until native reload/reconnect reaches raw fallback.
        const gate = 'outerdm-final'
        await new Promise(resolve => {
          genUiGates.set(gate, resolve)
          abort.signal.addEventListener('abort', resolve, { once: true })
        })
        genUiGates.delete(gate)
        if (abort.signal.aborted) return
      }
      if (!response.destroyed) {
        send({}, finish_reason)
        response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [], usage })}\n\n`)
        response.end('data: [DONE]\n\n')
        responses.push({ at: performance.now(), id, message, streaming: true })
      }
    } catch (error) {
      errors.push(error.message)
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error.message, type: 'fake_model_script_error' } }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, responses, errors,
    isGenUiHeld: label => genUiGates.has(label),
    releaseGenUi(label) {
      const release = genUiGates.get(label)
      if (!release) return false
      genUiGates.delete(label)
      release()
      return true
    },
    releaseDelegate(label) {
      const release = delegateGates.get(label)
      if (!release) return false
      delegateGates.delete(label)
      release()
      return true
    },
    async close() {
      for (const response of active) response.destroy()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    } }
}
