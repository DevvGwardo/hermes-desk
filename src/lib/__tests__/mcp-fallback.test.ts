import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rest = vi.hoisted(() => ({ serveGet: vi.fn() }))
vi.mock('../hermes-rest', () => ({
  serveAuth: async () => ({ baseUrl: 'http://127.0.0.1:9', token: 'fixture-token' }),
  serveGet: rest.serveGet,
  servePost: vi.fn(),
  servePut: vi.fn(),
}))
vi.mock('../maiavm-api', () => ({ resolveNubApiConnection: async () => null }))

import { __clearVmLinkCache, mcpAddServer, mcpListServers, mcpRemoveServer } from '../mcp'

const cli = vi.fn()
function serveAnswers(status: number, body: unknown = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

beforeEach(() => {
  __clearVmLinkCache()
  cli.mockReset().mockResolvedValue({ ok: true, data: [] })
  rest.serveGet.mockReset()
  ;(window as unknown as { nubAgent: unknown }).nubAgent = { hermes: cli }
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
})

describe('MCP serve-then-CLI fallback', () => {
  it('does not spawn the CLI when serve lists the servers', async () => {
    rest.serveGet.mockResolvedValue({ servers: [{ name: 'fixture', enabled: true }] })
    const result = await mcpListServers()
    expect(result.servers.map((server) => server.name)).toEqual(['fixture'])
    expect(cli).not.toHaveBeenCalled()
  })

  it('falls back to the CLI list when serve is unreachable', async () => {
    rest.serveGet.mockResolvedValue(null)
    await mcpListServers()
    expect(cli).toHaveBeenCalledWith('mcp', ['list'])
  })

  it.each([400, 409, 422])('keeps a %i refusal instead of writing through the CLI', async (status) => {
    serveAnswers(status, { error: 'fixture refusal' })
    expect(await mcpAddServer('fixture', { url: 'https://mcp.example.test' })).toEqual({ ok: false, error: 'fixture refusal' })
    expect(await mcpRemoveServer('fixture')).toEqual({ ok: false, error: 'fixture refusal' })
    expect(cli).not.toHaveBeenCalled()
  })

  it('still uses the CLI when serve lacks the endpoint', async () => {
    serveAnswers(404)
    expect(await mcpAddServer('fixture', { url: 'https://mcp.example.test' })).toEqual({ ok: true })
    expect(cli).toHaveBeenCalledWith('mcp', ['add', 'fixture', '--url', 'https://mcp.example.test'])
  })

  it('does not retry through the CLI after serve times out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError') }))
    const result = await mcpRemoveServer('fixture')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/did not answer in time/)
    expect(cli).not.toHaveBeenCalled()
  })
})
