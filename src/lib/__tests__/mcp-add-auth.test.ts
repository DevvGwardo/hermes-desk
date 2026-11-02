import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __clearVmLinkCache, buildMcpCreateBody, mcpAddServer, mcpStartAuth, parseAuthStart, parseMcpEnvText } from '../mcp'

describe('buildMcpCreateBody (hermes MCPServerCreate)', () => {
  it('URL + API key → auth header + bearer_token', () => {
    expect(buildMcpCreateBody('n', { url: 'https://x/mcp', bearerToken: 'Bearer abc' })).toEqual({
      ok: true,
      body: { name: 'n', url: 'https://x/mcp', auth: 'header', bearer_token: 'abc' },
    })
  })
  it('URL + oauth', () => {
    expect(buildMcpCreateBody('n', { url: 'https://x', auth: 'oauth' })).toEqual({ ok: true, body: { name: 'n', url: 'https://x', auth: 'oauth' } })
  })
  it('stdio + args + env', () => {
    expect(buildMcpCreateBody('n', { command: 'npx', args: '-y pkg', env: { API_KEY: 'k' } })).toEqual({
      ok: true,
      body: { name: 'n', command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: 'k' } },
    })
  })
  it('refuses mixing (hermes would 400)', () => {
    expect(buildMcpCreateBody('n', { url: 'https://x', env: { A: 'b' } }).ok).toBe(false)
    expect(buildMcpCreateBody('n', { command: 'npx', bearerToken: 't' }).ok).toBe(false)
  })
})

describe('parseMcpEnvText', () => {
  it('parses KEY=VALUE lines, ignores blanks/comments, keeps = in values', () => {
    expect(parseMcpEnvText('A=1\n\n# c\nB = "x=y"\n')).toEqual({ ok: true, env: { A: '1', B: 'x=y' } })
  })
  it('rejects bad lines, bad names and loader keys', () => {
    expect(parseMcpEnvText('novalue').ok).toBe(false)
    expect(parseMcpEnvText('1BAD=x').ok).toBe(false)
    expect(parseMcpEnvText('LD_PRELOAD=/x').ok).toBe(false)
    expect(parseMcpEnvText('PATH=/x').ok).toBe(false)
  })
})

describe('parseAuthStart', () => {
  it('reads the dashboard flow snapshot', () => {
    expect(parseAuthStart({ flow_id: 'f1', status: 'authorization_required', authorization_url: 'https://idp/x' })).toEqual({
      ok: true,
      authorizationUrl: 'https://idp/x',
      flowId: 'f1',
      status: 'authorization_required',
    })
  })
  it('status error → not ok', () => {
    expect(parseAuthStart({ flow_id: 'f1', status: 'error', error: 'no DCR' })).toMatchObject({ ok: false, error: 'no DCR' })
  })
  it('maiavm shape', () => {
    expect(parseAuthStart({ authorizationUrl: 'https://a', callbackPort: 8765 })).toEqual({ ok: true, authorizationUrl: 'https://a' })
    expect(parseAuthStart({ alreadyAuthenticated: true })).toEqual({ ok: true, alreadyAuthenticated: true })
  })
})

describe('VM bridge payloads', () => {
  const calls: [string, Record<string, unknown> | undefined][] = []
  beforeEach(() => {
    calls.length = 0
    __clearVmLinkCache()
    ;(window as unknown as { nubAgent: unknown }).nubAgent = {
      nubVmMcp: async (verb: string, payload?: Record<string, unknown>) => {
        calls.push([verb, payload])
        if (verb === 'auth') return { ok: true, data: { flow_id: 'f9', status: 'authorization_required', authorization_url: 'https://idp' } }
        return { ok: true }
      },
    }
  })
  afterEach(() => {
    delete (window as unknown as { nubAgent?: unknown }).nubAgent
    vi.restoreAllMocks()
  })

  it('passes bearer_token and env to the desktop bridge', async () => {
    expect((await mcpAddServer('n8n', { url: 'https://x/mcp', bearerToken: 'tok' })).ok).toBe(true)
    expect(calls[0]).toEqual(['add', expect.objectContaining({ name: 'n8n', url: 'https://x/mcp', auth: 'header', bearer_token: 'tok' })])
    await mcpAddServer('s', { command: 'npx', args: '-y p', env: { K: 'v' } })
    expect(calls[1][1]).toMatchObject({ command: 'npx', env: { K: 'v' } })
    expect(calls[1][1]).not.toHaveProperty('bearer_token')
  })

  it('refuses invalid combos before calling the bridge', async () => {
    expect((await mcpAddServer('s', { url: 'https://x', env: { K: 'v' } })).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('auth returns the flow id for polling', async () => {
    expect(await mcpStartAuth('linear')).toMatchObject({ ok: true, flowId: 'f9', authorizationUrl: 'https://idp' })
  })
})
