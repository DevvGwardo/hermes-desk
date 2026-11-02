import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createServeRestProxy, SERVE_TOKEN_HEADER } = require('./serve-auth.cjs')
const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })

async function fixture(handler, verifyPeer = async () => true) {
  const received = []
  const server = createServer((request, response) => { received.push(request.url); handler(request, response) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const proxy = await createServeRestProxy({ baseUrl: `http://127.0.0.1:${server.address().port}`,
    auth: { token: 'OBVIOUSLY_FAKE_FAILURE_TOKEN' }, verifyPeer })
  cleanups.push(() => proxy.close())
  return { received, proxy, get: () => fetch(`${proxy.baseUrl}/api/profiles`,
    { headers: { [SERVE_TOKEN_HEADER]: proxy.auth.token } }) }
}

describe('safe renderer REST failure categories', () => {
  it('distinguishes peer refusal without sending any backend credential or error detail', async () => {
    const { get, received } = await fixture((_req, res) => res.end('unused'), async () => false)
    const response = await get()
    expect(response.status).toBe(502)
    expect(response.headers.get('X-Hermes-Serve-Failure')).toBe('peer-unverified')
    expect(await response.json()).toEqual({ error: 'Serve request unavailable' })
    expect(received).toEqual([])
  })

  it.each([
    ['http', 'upstream-http', (res) => { res.writeHead(503); res.end('FAKE private upstream detail') }],
    ['html', 'invalid-response', (res) => { res.setHeader('Content-Type', 'text/html'); res.end('FAKE private page') }],
    ['json', 'invalid-response', (res) => { res.setHeader('Content-Type', 'application/json'); res.end('{FAKE malformed body') }],
    ['oversized', 'response-too-large', (res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ value: 'x'.repeat(6 * 1024 * 1024) })) }],
  ])('categorizes %s failure while withholding the response body', async (_label, category, reply) => {
    const { get } = await fixture((_req, res) => reply(res))
    const response = await get()
    expect(response.status).toBe(502)
    expect(response.headers.get('X-Hermes-Serve-Failure')).toBe(category)
    expect(await response.json()).toEqual({ error: 'Serve request unavailable' })
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Hermes-Serve-Failure')
  })

  it('retains unauthenticated refusal and leaves successful JSON/empty replies without a failure category', async () => {
    let empty = false
    const { get, received, proxy } = await fixture((_req, res) => {
      if (empty) { res.writeHead(204); res.end(); return }
      res.setHeader('Content-Type', 'application/json'); res.end('{"profiles":[]}')
    })
    const denied = await fetch(`${proxy.baseUrl}/api/profiles`)
    expect(denied.status).toBe(403)
    expect(denied.headers.get('X-Hermes-Serve-Failure')).toBe('forbidden')
    expect(received).toEqual([])
    const success = await get()
    expect(success.headers.get('X-Hermes-Serve-Failure')).toBeNull()
    expect(await success.json()).toEqual({ profiles: [] })
    empty = true
    const noContent = await get()
    expect(noContent.status).toBe(204)
    expect(noContent.headers.get('X-Hermes-Serve-Failure')).toBeNull()
  })

  it('times out a hung verifier without sending backend credentials', async () => {
    const { get, received } = await fixture((_req, res) => res.end('unused'), () => new Promise(() => {}))
    const response = await get()
    expect(response.status).toBe(502)
    expect(response.headers.get('X-Hermes-Serve-Failure')).toBe('timeout')
    expect(received).toEqual([])
  })

  it('classifies verifier exceptions without echoing their details', async () => {
    const { get } = await fixture((_req, res) => res.end('unused'), async () => { throw new Error('FAKE private verifier detail') })
    const response = await get()
    expect(response.headers.get('X-Hermes-Serve-Failure')).toBe('peer-unverified')
    expect(await response.json()).toEqual({ error: 'Serve request unavailable' })
  })

  it('refuses an oversized request before creating an authenticated upstream request', async () => {
    const { proxy, received } = await fixture((_req, res) => res.end('unused'))
    const response = await fetch(`${proxy.baseUrl}/api/profiles`, {
      method: 'POST', headers: { [SERVE_TOKEN_HEADER]: proxy.auth.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'FAKE', unused: 'x'.repeat(2 * 1024 * 1024) }),
    })
    expect(response.status).toBe(502)
    expect(response.headers.get('X-Hermes-Serve-Failure')).toBe('request-too-large')
    expect(received).toEqual([])
  })

  it('keeps the 16-operation cap and does not forward forged failure headers on success', async () => {
    const gates = []
    const { get, received, proxy } = await fixture((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('X-Hermes-Serve-Failure', 'FAKE upstream string')
      res.end('{"profiles":[]}')
    }, () => new Promise(resolve => gates.push(resolve)))
    const pending = Array.from({ length: 16 }, () => get())
    await vi.waitFor(() => expect(gates).toHaveLength(16))
    const busy = await get()
    expect(busy.status).toBe(503)
    expect(busy.headers.get('X-Hermes-Serve-Failure')).toBe('busy')
    expect(received).toEqual([])
    gates.forEach(resolve => resolve(true))
    const replies = await Promise.all(pending)
    expect(replies.every(reply => reply.status === 200 && !reply.headers.get('X-Hermes-Serve-Failure'))).toBe(true)
    expect(received).toHaveLength(16)
    const forbidden = await fetch(`${proxy.baseUrl}/api/env/reveal`, { headers: { [SERVE_TOKEN_HEADER]: proxy.auth.token } })
    expect(forbidden.status).toBe(403)
    expect(received).toHaveLength(16)
  })
})
