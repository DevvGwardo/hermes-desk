import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { probeEnvironment, sandboxPolicy, sanitize } from './hermes-desk-phase0.mjs'

const fixture = name => readFileSync(new URL(`../../tests/fixtures/serve-ws/phase0-${name}.jsonl`, import.meta.url), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line))
const calls = (rows, method) => rows.filter(row => row.direction === 'client->server' && row.frame.method === method)
  .map(row => ({
    request: row.frame,
    connection: row.connection,
    response: rows.find(other => other.direction === 'server->client' && !other.frame.method
      && other.connection === row.connection && other.frame.id === row.frame.id)?.frame,
  }))
const events = (rows, type) => rows.filter(row => row.frame.method === 'event' && row.frame.params.type === type)

describe('phase 0 probe safety and captured contracts', () => {
  it('isolates state and credentials and only permits dedicated loopback ports', () => {
    const env = probeEnvironment('/tmp/fake-spike', '/fake/.hermes/hermes-agent', 'fake-session-token')
    expect(env.HERMES_HOME).toBe(`${env.HOME}/.hermes`)
    expect(env.HERMES_RUNTIME_DIR).toMatch(/^\/tmp\/fake-spike\//)
    expect(env.HERMES_DISABLE_LAZY_INSTALLS).toBe('1')
    expect(Object.keys(env).filter(key => /API_KEY|BOT_TOKEN/.test(key))).toEqual([])
    for (const port of [8642, 9119, 9179, 9200]) {
      expect(() => sandboxPolicy('/fake/.hermes/hermes-agent', port)).toThrow()
    }
    const policy = sandboxPolicy('/fake/.hermes/hermes-agent', 9180)
    expect(policy).toContain('(deny file-write* (subpath "/fake/.hermes"))')
    expect(policy).toContain('(deny network-outbound)')
    expect(policy).toContain('(remote ip "localhost:9180")')
    expect(policy).toContain('(deny network-bind)')
    const cleaned = sanitize({
      nested: { ticket: 'fake-ticket', api_key: 'fake-key' },
      text: '/private/tmp/fake-spike fake-session-token sk-obviously-fake-secret-token',
    }, '/tmp/fake-spike', 'fake-session-token')
    expect(cleaned).toEqual({
      nested: { ticket: '[redacted]', api_key: '[redacted]' },
      text: '<TEMP> [redacted] [secret]',
    })
  })

  it('keeps every request correlated and each profile transcript isolated', () => {
    const rows = fixture('baseline')
    for (const row of rows) {
      expect(row.provenance).toBe('unmodified-serve')
      expect(row.frame.jsonrpc).toBe('2.0')
    }
    const creates = calls(rows, 'session.create')
    expect(new Set(creates.map(call => call.response.result.session_id)).size).toBe(creates.length)
    expect(new Set(creates.map(call => call.response.result.stored_session_id)).size).toBe(creates.length)
    for (const { request, response } of creates) {
      const profile = request.params.profile
      expect(response.result.info.profile_name).toBe(profile)
      const list = calls(rows, 'session.list').find(call => call.request.params.profile === profile).response.result
      expect(list.sessions.map(session => session.id)).toEqual([response.result.stored_session_id])
      const resume = calls(rows, 'session.resume').find(call => call.request.params.profile === profile).response.result
      expect(resume.session_id).toBe(response.result.session_id)
      expect(resume.messages).toEqual(response.result.messages)
    }
    for (const row of rows.filter(row => row.direction === 'client->server')) {
      expect(rows.filter(other => other.direction === 'server->client' && !other.frame.method
        && other.connection === row.connection && other.frame.id === row.frame.id)).toHaveLength(1)
    }
  })

  it('records the local-auth rejection and a real error-shaped chat turn, not a fabricated success', () => {
    const rows = fixture('baseline')
    expect(calls(rows, 'browser.controller.register')[0].response.error.code).toBe(4403)
    const submit = calls(rows, 'prompt.submit')[0]
    expect(submit.response.result.user_row_id).toBeGreaterThan(0)
    const sid = submit.request.params.session_id
    const start = events(rows, 'message.start').find(row => row.frame.params.session_id === sid)
    const complete = events(rows, 'message.complete').find(row => row.frame.params.session_id === sid)
    expect(complete.frame.params.seq).toBeGreaterThan(start.frame.params.seq)
    expect(complete.frame.params.payload.status).toBe('error')
    expect(calls(rows, 'tool.invoke')[0].response.error.code).toBe(-32601)
    expect(events(rows, 'tool.start')).toEqual([])
  })

  it('preserves controller ownership, exact command/result ids, cancellation, and peer-to-peer approvals', () => {
    const rows = fixture('harness')
    expect(rows.every(row => row.provenance === 'identity-injected-harness')).toBe(true)
    for (const method of ['browser.controller.heartbeat', 'browser.controller.result', 'browser.controller.detach']) {
      const rpc = calls(rows, method)
      expect(rpc.find(call => call.connection === 'b').response.error.code).toBe(4403)
      expect(rpc.find(call => call.connection === 'a').response.result).toBeDefined()
    }
    const commands = events(rows, 'browser.controller.command')
    for (const row of commands) {
      expect(row.connection).toBe('a')
      expect(row.frame.params.payload.action).toBe('browser_navigate')
      expect(row.frame.params.payload.controller_id).toBeDefined()
    }
    const cancel = events(rows, 'browser.controller.cancel')[0].frame.params.payload
    const command = commands.find(row => row.frame.params.payload.command_id === cancel.command_id)
    expect(command.frame.params.payload.tool_call_id).toBe(cancel.tool_call_id)
    const late = calls(rows, 'browser.controller.result').find(call =>
      call.connection === 'a' && call.request.params.command_id === cancel.command_id)
    expect(late.response.result.accepted).toBe(false)
    const approval = rows.find(row => row.direction === 'server->client' && row.frame.method === 'approval')
    expect(approval.frame.id).toMatch(/^srq-/)
    expect(rows.find(row => row.direction === 'client->server' && row.frame.id === approval.frame.id).frame.result)
      .toEqual({ choice: 'once' })
  })

  it('records readiness-only computer status and contains no transport credentials or real-home paths', () => {
    const status = fixture('computer-status')[0]
    expect(status.response.status).toBe(200)
    expect(status.response.body).toHaveProperty('screen_recording')
    expect(status.response.body).not.toHaveProperty('screenshot')
    expect(status.response.body).not.toHaveProperty('frame')
    for (const name of ['baseline', 'harness', 'computer-status']) {
      const text = JSON.stringify(fixture(name))
      expect(text).not.toMatch(/\/Users\/|\/private\/var\/folders\/|hermes-desk-phase0-/)
      expect(text).not.toMatch(/"(?:token|ticket|api_key|authorization)"\s*:\s*"(?!\[redacted\])/i)
    }
  })
})
