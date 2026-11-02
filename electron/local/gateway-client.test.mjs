import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createGatewayClient } = require('./gateway-client.cjs')

describe('gateway diagnostics', () => {
  it('GETs only unauthenticated loopback /health and returns bounded presence', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      version: 'fake-version', api_server_key: 'obviously-fake-key',
    })))
    const client = createGatewayClient({ fetchImpl })
    expect(await client.health()).toEqual({ state: 'up', url: 'http://127.0.0.1:8642', version: 'fake-version' })
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8642/health',
      expect.objectContaining({ method: 'GET', redirect: 'error' }))
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('headers')
  })

  it('reports down without forwarding response bodies or network errors', async () => {
    for (const fetchImpl of [
      async () => new Response('obviously-fake-secret', { status: 503 }),
      async () => { throw new Error('obviously-fake-secret') },
      async () => new Response('not-json'),
    ]) {
      const health = await createGatewayClient({ fetchImpl }).health()
      expect(health.state).toBe('down')
      expect(JSON.stringify(health)).not.toContain('obviously-fake-secret')
    }
  })
})
