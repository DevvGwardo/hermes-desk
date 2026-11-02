import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../hermes-rest', () => ({
  serveGet: vi.fn(),
  serveGetDetailed: vi.fn(),
  serveSend: vi.fn(),
}))
vi.mock('../mcp', () => ({ mcpSetEnabled: vi.fn() }))

import { serveGet, serveGetDetailed, serveSend } from '../hermes-rest'
import { mcpSetEnabled } from '../mcp'
import { missingCatalogEnv, runMcpSetup } from '../mcp-setup-flow'

const sleep = vi.fn(async () => {})

beforeEach(() => {
  vi.mocked(serveGet).mockReset()
  vi.mocked(serveGetDetailed).mockReset()
  vi.mocked(serveSend).mockReset()
  vi.mocked(mcpSetEnabled).mockReset()
})

describe('runMcpSetup enable', () => {
  it('turns the server on', async () => {
    vi.mocked(mcpSetEnabled).mockResolvedValue({ ok: true })
    await expect(runMcpSetup('linear', 'enable')).resolves.toEqual({ kind: 'done', outcome: { status: 'enabled', server: 'linear' } })
    expect(mcpSetEnabled).toHaveBeenCalledWith('linear', true)
  })
  it('reports failure', async () => {
    vi.mocked(mcpSetEnabled).mockResolvedValue({ ok: false, error: 'nope' })
    const step = await runMcpSetup('linear', 'enable')
    expect(step).toEqual({ kind: 'done', outcome: { status: 'error', server: 'linear', detail: 'nope' } })
  })
})

describe('runMcpSetup install', () => {
  it('asks for required keys first, then installs with them', async () => {
    vi.mocked(serveGet).mockResolvedValue({
      entries: [{ name: 'brave', required_env: [{ name: 'BRAVE_API_KEY', prompt: 'Brave key', required: true }] }],
    })
    const first = await runMcpSetup('brave', 'install')
    expect(first).toEqual({ kind: 'needs-env', env: [{ name: 'BRAVE_API_KEY', prompt: 'Brave key', required: true }] })
    expect(serveSend).not.toHaveBeenCalled()

    vi.mocked(serveSend).mockResolvedValue({ ok: true, data: { ok: true, background: false } })
    const second = await runMcpSetup('brave', 'install', { env: { BRAVE_API_KEY: ' k ', OTHER: 'x' } })
    expect(second).toEqual({ kind: 'done', outcome: { status: 'installed', server: 'brave' } })
    expect(serveSend).toHaveBeenCalledWith('POST', '/api/mcp/catalog/install', {
      name: 'brave',
      env: { BRAVE_API_KEY: 'k' },
      enable: true,
    })
  })

  it('polls a background install to completion', async () => {
    vi.mocked(serveGet)
      .mockResolvedValueOnce({ entries: [{ name: 'gh', required_env: [] }] })
      .mockResolvedValueOnce({ running: true })
      .mockResolvedValueOnce({ running: false, exit_code: 0 })
    vi.mocked(serveSend).mockResolvedValue({ ok: true, data: { ok: true, background: true, action: 'mcp-install-gh' } })
    const step = await runMcpSetup('gh', 'install', { sleep })
    expect(step).toEqual({ kind: 'done', outcome: { status: 'installed', server: 'gh' } })
    expect(serveGet).toHaveBeenCalledWith('/api/actions/mcp-install-gh/status?lines=1')
  })

  it('reports a failed background install', async () => {
    vi.mocked(serveGet)
      .mockResolvedValueOnce({ entries: [{ name: 'gh' }] })
      .mockResolvedValueOnce({ running: false, exit_code: 1 })
    vi.mocked(serveSend).mockResolvedValue({ ok: true, data: { background: true, action: 'a' } })
    const step = await runMcpSetup('gh', 'install', { sleep })
    expect(step.kind === 'done' && step.outcome.status).toBe('error')
  })

  it('unknown catalog entry and old agents are errors, not throws', async () => {
    vi.mocked(serveGet).mockResolvedValueOnce({ entries: [] })
    const unknown = await runMcpSetup('zzz', 'install')
    expect(unknown.kind === 'done' && unknown.outcome.status).toBe('error')
    vi.mocked(serveGet).mockResolvedValueOnce(null)
    const old = await runMcpSetup('zzz', 'install')
    expect(old.kind === 'done' && old.outcome.detail).toBe('Your agent needs an update for this.')
  })

  it('missingCatalogEnv ignores optional and filled keys', () => {
    expect(
      missingCatalogEnv(
        { required_env: [{ name: 'A' }, { name: 'B', required: false }, { name: 'C' }] },
        { C: 'x' },
      ).map((e) => e.name),
    ).toEqual(['A'])
  })
})

describe('runMcpSetup authorize', () => {
  it('opens the sign-in page and polls until approved', async () => {
    vi.mocked(serveSend).mockResolvedValue({
      ok: true,
      data: { flow_id: 'f1', status: 'authorization_required', authorization_url: 'https://auth.example/x' },
    })
    vi.mocked(serveGetDetailed)
      .mockResolvedValueOnce({ data: { status: 'authorization_required' }, status: 200 })
      .mockResolvedValueOnce({ data: { status: 'approved', tools: [{ name: 'create_issue' }, {}] }, status: 200 })
    const openUrl = vi.fn()
    const step = await runMcpSetup('linear', 'authorize', { openUrl, sleep })
    expect(serveSend).toHaveBeenCalledWith('POST', '/api/mcp/servers/linear/auth')
    expect(openUrl).toHaveBeenCalledWith('https://auth.example/x')
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/mcp/oauth/flows/f1')
    expect(step).toEqual({ kind: 'done', outcome: { status: 'authorized', server: 'linear', tools: ['create_issue'] } })
  })

  it('cancel deletes the flow', async () => {
    vi.mocked(serveSend).mockResolvedValue({ ok: true, data: { flow_id: 'f1', status: 'authorization_required', authorization_url: 'https://a' } })
    const step = await runMcpSetup('linear', 'authorize', { cancelled: () => true, sleep })
    expect(step).toEqual({ kind: 'cancelled' })
    expect(serveSend).toHaveBeenLastCalledWith('DELETE', '/api/mcp/oauth/flows/f1')
  })

  it('surfaces a flow error and a 404 start', async () => {
    vi.mocked(serveSend).mockResolvedValueOnce({ ok: true, data: { flow_id: 'f', status: 'authorization_required' } })
    vi.mocked(serveGetDetailed).mockResolvedValueOnce({ data: { status: 'error', error: 'denied' }, status: 200 })
    const err = await runMcpSetup('linear', 'authorize', { sleep })
    expect(err).toEqual({ kind: 'done', outcome: { status: 'error', server: 'linear', detail: 'denied' } })
    vi.mocked(serveSend).mockResolvedValueOnce({ ok: false, data: null, status: 404 })
    const old = await runMcpSetup('linear', 'authorize', { sleep })
    expect(old.kind === 'done' && old.outcome.detail).toBe('Your agent needs an update for this.')
  })
})
