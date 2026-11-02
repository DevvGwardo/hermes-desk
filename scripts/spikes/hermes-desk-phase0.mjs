import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const profiles = ['default', 'spike-alpha', 'spike-beta']
const capabilities = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_press', 'browser_scroll', 'browser_screenshot', 'browser_back', 'browser_tabs', 'browser_tab_activate']

export function probeEnvironment(root, source, token) {
  return {
    HOME: root, HERMES_HOME: path.join(root, '.hermes'),
    HERMES_RUNTIME_DIR: path.join(root, 'runtime'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'), TMPDIR: root,
    PATH: `${path.join(source, 'venv/bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PYTHONPATH: source, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
    HERMES_DASHBOARD_SESSION_TOKEN: token, LANG: 'en_US.UTF-8',
    DO_NOT_TRACK: '1', CUA_TELEMETRY_DISABLED: '1', HERMES_DISABLE_LAZY_INSTALLS: '1',
  }
}

export function sandboxPolicy(source, port) {
  assert(Number.isInteger(port) && port >= 9180 && port <= 9199, 'Only spike ports are allowed')
  const realState = path.dirname(source)
  assert(!/[\\"]/.test(source), 'Unsupported source path')
  return `(version 1)(allow default)
    (deny file-write* (subpath "${realState}"))
    (deny file-read-data (subpath "${realState}"))
    (allow file-read-data (subpath "${source}"))
    (deny network-outbound)
    (allow network-outbound (remote ip "localhost:${port}"))
    (deny network-bind)
    (allow network-bind (local ip "localhost:${port}"))`
}

export function sanitize(value, root, token) {
  if (typeof value === 'string') {
    return value.replaceAll(token, '[redacted]').replaceAll(`/private${root}`, '<TEMP>').replaceAll(root, '<TEMP>')
      .replace(/(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{12,}/g, '[secret]')
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, root, token))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, /^(?:token|ticket|access_token|refresh_token|api_key|authorization)$/i.test(key)
        ? '[redacted]' : sanitize(item, root, token),
    ]))
  }
  return value
}

async function freePort() {
  for (let port = 9180; port <= 9199; port++) {
    const server = net.createServer()
    const available = await new Promise(resolve => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (available) return port
  }
  throw new Error('No free spike port (9180–9199)')
}

// This is only an in-memory probe, never a patch to the installed Hermes tree.
// It deliberately bypasses identity admission, supplies the missing session.profile,
// and invokes the browser registry without a model. Fixtures label these interventions.
const harness = String.raw`
import json, sys, threading
from tui_gateway import server
from tui_gateway.ws import WSTransport
from tui_gateway.transport import bind_transport, reset_transport
from gateway.browser_control_broker import get_browser_control_broker
from gateway.session_context import set_session_vars, clear_session_vars
from tui_gateway.methods_browser_control import _principal_digest

original_init = WSTransport.__init__
def fake_identity(self, *args, **kwargs):
    original_init(self, *args, **kwargs)
    self.auth_identity = {"user_id": "spike-fake-user", "provider": "spike-fake-provider"}
WSTransport.__init__ = fake_identity
server._schedule_agent_build = lambda sid: None
get_browser_control_broker()._command_timeout = 3.0

def control():
    for line in sys.stdin:
        req = json.loads(line)
        sid = req["session_id"]
        session = server._sessions[sid]
        transport = session["transport"]
        token = bind_transport(transport)
        try:
            with server._session_profile_runtime_scope(session):
                op = req["op"]
                if op == "profile":
                    session["profile"] = req["profile"]
                    result = {"profile": session["profile"]}
                elif op == "scope":
                    from agent.secret_scope import get_secret, is_multiplex_active
                    from hermes_constants import get_hermes_home
                    result = {"home": str(get_hermes_home()), "marker": get_secret("SPIKE_ONLY_MARKER"),
                              "multiplex_active": is_multiplex_active()}
                elif op == "approval":
                    from tui_gateway import server_requests
                    result = server_requests.send("approval", sid, {
                        "request_id": "spike-approval", "command": "echo fake-spike",
                        "description": "Synthetic approval; no command will execute",
                        "choices": ["once", "deny"], "tool_name": "terminal"}, timeout=10)
                elif op == "context":
                    tokens = server._set_session_context(session["session_key"], ui_session_id=sid)
                    try:
                        from gateway.session_context import get_session_env
                        result = {k: get_session_env(k, "") for k in (
                            "HERMES_SESSION_ID", "HERMES_UI_SESSION_ID",
                            "HERMES_BROWSER_CONTROL_PRINCIPAL", "HERMES_BROWSER_CONTROL_TRANSPORT_FAMILY")}
                        from tools.browser_extension_router import routed_browser_handler
                        result["route_result"] = routed_browser_handler(
                            "browser_navigate", {"url": "https://example.invalid/spike"},
                            fallback=lambda: "legacy-fallback-sentinel-no-browser-executed")
                    finally:
                        server._clear_session_context(tokens)
                elif op == "navigate":
                    import tools.browser_tool
                    from tools.registry import registry
                    identity = {"user_id": "spike-fake-user", "provider": "spike-fake-provider"}
                    tokens = set_session_vars(
                        session_id=sid, ui_session_id=sid, profile=session["profile"],
                        browser_control_principal=_principal_digest(identity),
                        browser_control_transport_family="cloud-ticket-ws")
                    try:
                        # Exact registry handler, with a fake controller result. No browser opens.
                        from tools.approval_context import _approval_tool_call_id
                        tc = _approval_tool_call_id.set(req["tool_call_id"])
                        try:
                            result = registry.get_entry("browser_navigate").handler({"url": "https://example.invalid/spike"})
                        finally:
                            _approval_tool_call_id.reset(tc)
                    finally:
                        clear_session_vars(tokens)
                else:
                    raise ValueError(op)
                print("SPIKE:" + json.dumps({"control_id": req["control_id"], "result": result}), file=sys.__stdout__, flush=True)
        except Exception as exc:
            print("SPIKE:" + json.dumps({"control_id": req["control_id"],
                "error": {"type": type(exc).__name__, "message": str(exc)}}), file=sys.__stdout__, flush=True)
        finally:
            reset_transport(token)

threading.Thread(target=control, daemon=True).start()
from hermes_cli.main import main
main()
`

class Peer {
  constructor(url, label, records, provenance) {
    this.label = label
    this.records = records
    this.provenance = provenance
    this.nextId = 1
    this.frames = []
    this.pending = new Map()
    this.ws = new WebSocket(url)
    this.ws.addEventListener('message', event => {
      for (const line of String(event.data).split('\n').filter(Boolean)) {
        const frame = JSON.parse(line)
        this.record('server->client', frame)
        this.frames.push(frame)
        if (this.pending.has(frame.id)) {
          this.pending.get(frame.id)(frame)
          this.pending.delete(frame.id)
        }
      }
    })
  }
  record(direction, frame) {
    this.records.push({ connection: this.label, provenance: this.provenance, direction, frame })
  }
  async open() {
    await Promise.race([once(this.ws, 'open'), once(this.ws, 'error').then(() => {
      throw new Error('WebSocket upgrade failed')
    })])
    await this.event('gateway.ready')
  }
  async call(method, params = {}) {
    const frame = { jsonrpc: '2.0', id: this.nextId++, method, params }
    this.record('client->server', frame)
    const answer = new Promise(resolve => this.pending.set(frame.id, resolve))
    this.ws.send(JSON.stringify(frame))
    return Promise.race([answer, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC deadline: ${method}`)), 20000)
      timer.unref()
    })])
  }
  async find(predicate, label, after = 0) {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const found = this.frames.slice(after).find(predicate)
      if (found) return found
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`Frame deadline: ${label}`)
  }
  event(type, after = 0) {
    return this.find(frame => frame.method === 'event' && frame.params.type === type, type, after)
  }
  respond(id, result) {
    const frame = { jsonrpc: '2.0', id, result }
    this.record('client->server', frame)
    this.ws.send(JSON.stringify(frame))
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return
    const closed = once(this.ws, 'close')
    this.ws.close()
    await closed
  }
}

async function run(mode) {
  assert(['baseline', 'harness'].includes(mode))
  assert(process.platform === 'darwin', 'This probe requires the macOS sandbox')
  const source = path.resolve(process.env.HERMES_SPIKE_SOURCE || '/Users/devgwardo/.hermes/hermes-agent')
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-desk-phase0-'))
  const token = randomBytes(32).toString('hex')
  const env = probeEnvironment(root, source, token)
  const port = await freePort()
  const records = [], peers = [], receipts = { mode, port, profiles }
  const stopOnSignal = () => child?.kill('SIGTERM')
  process.once('SIGINT', stopOnSignal)
  process.once('SIGTERM', stopOnSignal)
  let child
  let log = ''
  const controls = new Map()
  let nextControl = 1
  try {
    for (const profile of profiles) {
      const home = profile === 'default' ? env.HERMES_HOME : path.join(env.HERMES_HOME, 'profiles', profile)
      await mkdir(home, { recursive: true })
      await writeFile(path.join(home, '.env'), `SPIKE_ONLY_MARKER=obviously-fake-${profile}\n`)
      await writeFile(path.join(home, 'config.yaml'), `model:\n  provider: custom\n  default: spike-no-model\n  base_url: http://127.0.0.1:${port}/no-model\nbrowser:\n  record_sessions: false\n  extension_control:\n    enabled: true\n    developer_mode: false\nmcp_servers: {}\ncron:\n  enabled: false\ncurator:\n  enabled: false\nmemory:\n  enabled: false\ngateway:\n  multiplex_profiles: false\n`)
    }
    const policy = sandboxPolicy(source, port)
    const args = mode === 'baseline'
      ? ['-B', path.join(source, 'hermes')]
      : ['-B', '-c', harness]
    args.push('serve', '--isolated', '--host', '127.0.0.1', '--port', String(port), '--no-open')
    child = spawn('/usr/bin/sandbox-exec', ['-p', policy, path.join(source, 'venv/bin/python'), ...args],
      { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let lines = ''
    child.stdout.on('data', data => {
      log += data
      lines += data
      const parts = lines.split('\n')
      lines = parts.pop()
      for (const line of parts) {
        if (!line.startsWith('SPIKE:')) continue
        const receipt = JSON.parse(line.slice(6))
        controls.get(receipt.control_id)?.(receipt)
        controls.delete(receipt.control_id)
      }
    })
    child.stderr.on('data', data => { log += data })
    const control = (op, sessionId, extra = {}) => {
      const request = { control_id: nextControl++, op, session_id: sessionId, ...extra }
      const result = new Promise(resolve => controls.set(request.control_id, resolve))
      child.stdin.write(JSON.stringify(request) + '\n')
      return Promise.race([result, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`Control deadline: ${op}`)), 20000)
        timer.unref()
      })])
    }
    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 45000
    let ready = false
    while (Date.now() < deadline && child.exitCode === null) {
      if (log.includes('HERMES_BACKEND_READY')) { ready = true; break }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert(ready, sanitize(log, root, token))
    const url = `${base.replace('http:', 'ws:')}/api/ws?token=${token}`
    const a = new Peer(url, 'a', records, mode === 'baseline' ? 'unmodified-serve' : 'identity-injected-harness')
    const b = new Peer(url, 'b', records, a.provenance)
    peers.push(a, b)
    await Promise.all(peers.map(peer => peer.open()))
    await Promise.all(peers.map(peer => peer.call('client.capabilities', { server_requests: true })))
    const created = await Promise.all(profiles.map((profile, index) => (index === 2 ? b : a).call('session.create', {
      profile, source: 'desktop', title: `Spike ${profile}`,
      messages: [{ role: 'user', content: `Fake seed for ${profile}` }],
    })))
    for (const response of created) assert(response.result?.session_id, JSON.stringify(response))
    receipts.created = created.map(response => response.result)
    receipts.lists = await Promise.all(profiles.map(profile => a.call('session.list', { profile, limit: 10 })))
    receipts.resumed = await Promise.all(created.map((response, index) => a.call('session.resume', {
      profile: profiles[index], session_id: response.result.stored_session_id, lazy: true,
    })))
    const sid = created[1].result.session_id
    const register = { session_id: sid, protocol_version: 1, controller_id: 'hermesdesk:spike',
      browser_profile_id: 'ws-agent-spike-alpha', capabilities }
    receipts.registration = await a.call('browser.controller.register', register)
    if (mode === 'baseline') {
      assert.equal(receipts.registration.error?.code, 4403)
      const from = a.frames.length
      receipts.prompt = await a.call('prompt.submit', { session_id: sid, profile: 'spike-alpha', text: 'Hello, isolated spike.' })
      await a.event('message.complete', from)
      receipts.pending = await a.call('approval.pending', { session_id: sid })
      receipts.noToolInvoke = await a.call('tool.invoke', { session_id: sid, name: 'browser_navigate',
        arguments: { url: 'https://example.invalid/spike' } })
      const response = await fetch(`${base}/api/tools/computer-use/status?profile=spike-alpha`,
        { headers: { 'X-Hermes-Session-Token': token }, signal: AbortSignal.timeout(30000) })
      receipts.computerStatus = { status: response.status, body: await response.json() }
      assert.equal(response.status, 200)
      receipts.display = await a.call('display.status', { profile: 'spike-alpha' })
      receipts.thumbnail = await a.call('display.thumbnail', { profile: 'spike-alpha' })
    } else {
      assert.equal(receipts.registration.error?.code, 4403)
      receipts.scopes = []
      for (const response of created) receipts.scopes.push(await control('scope', response.result.session_id))
      receipts.profileCorrection = await control('profile', sid, { profile: 'spike-alpha' })
      receipts.badCapabilities = await a.call('browser.controller.register', {
        ...register, capabilities: ['navigate', 'snapshot', 'browser_evaluate'],
      })
      assert.equal(receipts.badCapabilities.error?.message, 'no permitted controller capabilities requested')
      receipts.registered = await a.call('browser.controller.register', register)
      assert(receipts.registered.result?.scope, JSON.stringify(receipts.registered))
      receipts.context = await control('context', sid)
      // Resume attaches b to a fanout, but b still cannot heartbeat a's controller.
      receipts.peerResume = await b.call('session.resume', {
        profile: 'spike-alpha', session_id: created[1].result.stored_session_id, lazy: true,
      })
      receipts.foreignHeartbeat = await b.call('browser.controller.heartbeat', { session_id: sid })
      receipts.heartbeat = await a.call('browser.controller.heartbeat', { session_id: sid })
      const from = a.frames.length
      const navigating = control('navigate', sid, { tool_call_id: 'spike-tool-success' })
      const command = (await a.event('browser.controller.command', from)).params.payload
      assert.equal(command.action, 'browser_navigate')
      receipts.foreignResult = await b.call('browser.controller.result', {
        session_id: sid, command_id: command.command_id, ok: true, result: { forged: true },
      })
      receipts.result = await a.call('browser.controller.result', {
        session_id: sid, command_id: command.command_id, ok: true,
        result: { url: 'https://example.invalid/spike', title: 'Fake controller page', success: true },
      })
      receipts.navigation = await navigating
      const fromReject = a.frames.length
      const rejecting = control('navigate', sid, { tool_call_id: 'spike-tool-rejected' })
      const rejectedCommand = (await a.event('browser.controller.command', fromReject)).params.payload
      receipts.rejectedResult = await a.call('browser.controller.result', {
        session_id: sid, command_id: rejectedCommand.command_id, ok: false,
        error: { code: 'user_took_control', message: 'Fake user took control' },
      })
      receipts.rejection = await rejecting
      const fromCancel = a.frames.length
      // The control reader is serial; cancel on a separate thread via detach would
      // hide the cancel event. A short broker timeout emits the real cancellation.
      const timingOut = control('navigate', sid, { tool_call_id: 'spike-tool-timeout' })
      const timeoutCommand = (await a.event('browser.controller.command', fromCancel)).params.payload
      await a.event('browser.controller.cancel', fromCancel)
      receipts.timeout = await timingOut
      receipts.lateResult = await a.call('browser.controller.result', {
        session_id: sid, command_id: timeoutCommand.command_id, ok: true, result: { tooLate: true },
      })
      receipts.foreignDetach = await b.call('browser.controller.detach', { session_id: sid })
      receipts.detach = await a.call('browser.controller.detach', { session_id: sid })
      const fromApproval = a.frames.length
      const approval = control('approval', sid)
      const question = await a.find(frame => frame.method === 'approval', 'approval', fromApproval)
      a.respond(question.id, { choice: 'once' })
      receipts.approval = await approval
    }
    const fixtures = path.join(repo, 'tests/fixtures/serve-ws')
    await mkdir(fixtures, { recursive: true })
    await writeFile(path.join(fixtures, `phase0-${mode}.jsonl`),
      records.map(row => JSON.stringify(sanitize(row, root, token))).join('\n') + '\n')
    if (mode === 'baseline') {
      await writeFile(path.join(fixtures, 'phase0-computer-status.jsonl'), JSON.stringify({
        provenance: 'unmodified-serve-http', request: { method: 'GET',
          path: '/api/tools/computer-use/status?profile=spike-alpha' },
        response: receipts.computerStatus,
      }) + '\n')
    }
    console.log(JSON.stringify(sanitize(receipts, root, token), null, 2))
  } catch (error) {
    console.error(sanitize(log, root, token))
    throw error
  } finally {
    process.removeListener('SIGINT', stopOnSignal)
    process.removeListener('SIGTERM', stopOnSignal)
    await Promise.all(peers.map(peer => peer.close()))
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
    }
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv[2] || 'baseline').catch(error => { console.error(error); process.exitCode = 1 })
}
