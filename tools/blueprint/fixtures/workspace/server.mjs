// Local-only fixtures. No external assets, real credentials, or provider calls.
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { scriptedReply } from '../../../../tests/fake-model/server.mjs'

export const FAKE_VALUES = {
  login: 'bpw-FAKE-password-never-use',
  card: '4111111111111111',
  otp: '654321',
  vault: 'bpw-FAKE-vault-fill-never-use',
}

function html(route) {
  const kind = route.split('/')[1] || 'work'
  const fields = {
    login: `<label>Email<input type="email" value="fixture@example.invalid"></label>
      <label>Password<input id="password" type="password" autocomplete="current-password"></label>`,
    checkout: `<label>Card number<input id="card" autocomplete="cc-number" value="${FAKE_VALUES.card}"></label>
      <label>Security code<input id="cvv" autocomplete="cc-csc" value="999"></label>`,
    otp: `<p>Verification code</p><label>One-time code<input id="otp" autocomplete="one-time-code" inputmode="numeric" maxlength="6" value="${FAKE_VALUES.otp}"></label>`,
    secret: '<label>Password<input id="password" type="password" autocomplete="current-password"></label>',
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <link rel="icon" href="/favicon.ico"><title>Workspace fixture ${route}</title>
    <style>html{background:#edf2f7;color:#182432;font:16px system-ui}body{margin:28px}
    h1{font-size:24px}label{display:block;margin:18px 0}input{display:block;width:260px;height:34px;background:#fff;color:#182432;border:2px solid #445;padding:4px}
    button{font:inherit;padding:12px;background:#134a75;color:white;border:0;border-radius:6px}
    .spacer{height:1600px}a{display:block;margin:20px 0}</style></head><body>
    <h1>Workspace fixture ${route}</h1><p id="lane">${route}</p>
    <button id="click">Record click</button><form onsubmit="return false">
    ${fields[kind] || '<label>Note<input id="note" aria-label="Note"></label>'}</form>
    <a href="/second${route}">Second page</a><div class="spacer"></div><p>Bottom of fixture</p>
    <script>
      const emit=(type,data={})=>fetch('/event',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({type,route:${JSON.stringify(route)},...data})});
      window.fixture={clicks:0,keys:[],inputs:0,permission:{}};
      ${kind === 'login' ? `document.querySelector('#password').value=${JSON.stringify(FAKE_VALUES.login)};` : ''}
      document.querySelector('#click').onclick=()=>{fixture.clicks++;emit('click')};
      document.addEventListener('keydown',e=>{fixture.keys.push(e.key);emit('key',{key:e.key})});
      document.addEventListener('input',()=>{fixture.inputs++;emit('input')});
      document.addEventListener('scroll',()=>emit('scroll',{y:scrollY}));
      ${kind === 'cookie' ? `document.cookie='bpw_owner=${encodeURIComponent(route.split('/')[2] || 'A')}; Path=/; SameSite=Lax';localStorage.setItem('bpw_owner',${JSON.stringify(route.split('/')[2] || 'A')});` : ''}
      ${kind === 'permissions' ? `
        navigator.geolocation.getCurrentPosition(()=>{fixture.permission.geo='allowed'},e=>{fixture.permission.geo='denied:'+e.code});
        Notification.requestPermission().then(v=>fixture.permission.notifications=v);
        navigator.mediaDevices.getUserMedia({audio:true,video:true}).then(s=>{fixture.permission.media='allowed';s.getTracks().forEach(t=>t.stop())},e=>fixture.permission.media=e.name);
        navigator.requestMIDIAccess().then(()=>fixture.permission.midi='allowed',e=>fixture.permission.midi=e.name);
      ` : ''}
      emit('load');
    </script></body></html>`
}

export async function startWorkspaceSite() {
  const events = [], requests = []
  const server = http.createServer(async (request, response) => {
    const route = new URL(request.url, 'http://fixture.invalid').pathname
    requests.push({ route, at: performance.now() })
    if (route === '/event') {
      let body = ''
      for await (const chunk of request) body += chunk
      events.push({ ...JSON.parse(body), at: performance.now() })
      return response.writeHead(204).end()
    }
    if (route === '/favicon.ico') return response.writeHead(204).end()
    if (route.startsWith('/download/')) {
      const filename = route.split('/').at(-1)
      const large = filename === 'large.bin'
      response.writeHead(200, { 'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': large ? 200 * 1024 * 1024 + 1 : 8 })
      // A declared oversized download must be refused before its body is read.
      if (large) response.write(Buffer.alloc(8))
      else response.end('BPW fake')
      return
    }
    if (route.startsWith('/slow/')) await delay(3000)
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
    response.end(html(route))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: `http://127.0.0.1:${server.address().port}`, events, requests,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

export function toolText(message) {
  const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content)
  const line = content?.split('\n').find(line => line.startsWith('{"result":') || line.startsWith('{"error":'))
  if (!line) return content || ''
  const value = JSON.parse(line)
  return value.result ?? value.error
}

export function refFor(text, label) {
  const line = text.split('\n').find(line => line.includes(`"${label}"`) && /\[ref=e\d+\]/.test(line) &&
    /^(?:\[ref=e\d+\]\s+)?(?:textbox|searchbox|combobox|button|link)\b/i.test(line))
  const ref = line?.match(/ref=(e\d+)/)?.[1]
  assert(ref, `Missing fixture ref: ${label}`)
  return ref
}

// Reuses the existing fake-model reply for ordinary E2E chat, while adding
// registered, bounded tool plans for this harness. Hermes chooses/executes the
// real namespaced MCP tools. We never fabricate a tool response.
export async function startWorkspaceModel(fixtureUrl) {
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureUrl))
  const jobs = new Map(), requests = [], responses = [], errors = []
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url.endsWith('/models')) {
        return response.end(JSON.stringify({ data: [{ id: 'hermes-desk-fake' }] }))
      }
      // Hermes may probe auxiliary routes before selecting the custom model.
      // Match the existing fake server: unknown routes are 404, not script errors.
      if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) return response.writeHead(404).end()
      let raw = ''
      for await (const chunk of request) { raw += chunk; assert(raw.length < 16 * 1024 * 1024) }
      const body = JSON.parse(raw), at = performance.now()
      requests.push({ at, body })
      const index = (body.messages || []).findLastIndex(m => m.role === 'user' &&
        typeof m.content === 'string' && /BPW:\w+/.test(m.content))
      let message, jobId, step
      if (index < 0) message = scriptedReply(body, fixtureUrl)
      else {
        jobId = body.messages[index].content.match(/BPW:(\w+)/)[1]
        const job = jobs.get(jobId)
        assert(job, `Unknown workspace job ${jobId}`)
        if (job.scale) await delay(200)
        const results = body.messages.slice(index + 1).filter(m => m.role === 'tool')
        step = results.length
        if (body.tools) job.results = results
        if (!body.tools || step >= job.steps.length) {
          message = { role: 'assistant', content: `Workspace plan ${jobId} complete.` }
          if (body.tools) job.done = true
        } else {
          const action = job.steps[step]
          const names = body.tools.map(t => t.function?.name).filter(n =>
            /hermes.?desk/i.test(n || '') && n.endsWith(action.name))
          assert.equal(names.length, 1, `MCP catalog missing ${action.name}`)
          const args = typeof action.args === 'function' ? action.args(results.map(toolText)) : action.args || {}
          message = { role: 'assistant', content: null, tool_calls: [{
            id: `bpw_${jobId}_${step}`, type: 'function',
            function: { name: names[0], arguments: JSON.stringify(args) },
          }] }
        }
      }
      responses.push({ at: performance.now(), jobId, step, message })
      const base = { id: `chatcmpl-bpw-${requests.length}`, created: 1, model: 'hermes-desk-fake' }
      const finish = message.tool_calls ? 'tool_calls' : 'stop'
      if (!body.stream) {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ ...base, object: 'chat.completion',
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }))
      } else {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        const delta = message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((t, index) => ({ index, ...t })) } : message
        const send = (delta, finish_reason) => response.write(`data: ${JSON.stringify({
          ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`)
        send(delta, null); send({}, finish); response.end('data: [DONE]\n\n')
      }
    } catch (error) {
      errors.push(error.message)
      const last = requests.at(-1)?.body.messages?.findLast(m => typeof m.content === 'string' && /BPW:\w+/.test(m.content))
      const id = last?.content.match(/BPW:(\w+)/)?.[1]
      if (jobs.has(id)) jobs.get(id).error = error.message
      if (!response.headersSent) response.writeHead(400)
      response.end(JSON.stringify({ error: { message: error.message, type: 'fake_model_script_error' } }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: `http://127.0.0.1:${server.address().port}/v1`, jobs, requests, responses, errors,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
