import { beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../hermes-rest', async (orig) => ({
  ...(await orig<typeof import('../hermes-rest')>()),
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))

const mcpListServerTools = vi.fn()
vi.mock('../mcp', async (orig) => ({
  ...(await orig<typeof import('../mcp')>()),
  mcpListServerTools: (...a: unknown[]) => mcpListServerTools(...a),
}))

import { cancelMcpOAuthFlow, getMcpOAuthFlow, oauthStateLabel, waitForMcpOAuth, waitForMcpToolsReady } from '../mcp-oauth'

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
  mcpListServerTools.mockReset()
})

const sleep = async () => {}

describe('dashboard OAuth flow polling', () => {
  it('polls until approved and returns tools', async () => {
    serveGetDetailed
      .mockResolvedValueOnce({ data: { flow_id: 'f', status: 'authorization_required' }, status: 200 })
      .mockResolvedValueOnce({ data: { flow_id: 'f', status: 'approved', tools: [{ name: 'search', description: 'd' }] }, status: 200 })
    const updates: string[] = []
    const out = await waitForMcpOAuth('f', { sleep, onUpdate: (s) => updates.push(s.status) })
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/mcp/oauth/flows/f')
    expect(out).toMatchObject({ status: 'approved', tools: [{ name: 'search', description: 'd' }] })
    expect(updates).toEqual(['authorization_required', 'approved'])
  })

  it('stops on error with the reason', async () => {
    serveGetDetailed.mockResolvedValue({ data: { status: 'error', error: 'access_denied' }, status: 200 })
    expect(await waitForMcpOAuth('f', { sleep })).toMatchObject({ status: 'error', error: 'access_denied' })
  })

  it('404 → expired', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 404 })
    expect((await getMcpOAuthFlow('f'))?.status).toBe('expired')
    expect((await waitForMcpOAuth('f', { sleep })).status).toBe('expired')
  })

  it('abort → cancelled; cancel sends DELETE', async () => {
    const ctl = new AbortController()
    serveGetDetailed.mockImplementation(async () => {
      ctl.abort()
      return { data: { status: 'authorization_required' }, status: 200 }
    })
    expect((await waitForMcpOAuth('f', { sleep, signal: ctl.signal })).status).toBe('cancelled')
    serveSend.mockResolvedValue({ ok: true, data: { ok: true } })
    expect(await cancelMcpOAuthFlow('f')).toBe(true)
    expect(serveSend).toHaveBeenCalledWith('DELETE', '/api/mcp/oauth/flows/f')
  })

  it('times out', async () => {
    serveGetDetailed.mockResolvedValue({ data: { status: 'authorization_required' }, status: 200 })
    expect((await waitForMcpOAuth('f', { sleep, timeoutMs: 0 })).status).toBe('timeout')
  })
})

describe('desktop relay (no flow id)', () => {
  it('waits for the tool probe to succeed', async () => {
    mcpListServerTools
      .mockResolvedValueOnce({ ok: false, tools: [], error: 'needs sign-in' })
      .mockResolvedValueOnce({ ok: true, tools: [{ name: 't' }] })
    expect(await waitForMcpToolsReady('gmail', { sleep })).toEqual({ ok: true, tools: [{ name: 't' }] })
  })
})

it('labels', () => {
  expect(oauthStateLabel('authorization_required')).toMatch(/Waiting/)
  expect(oauthStateLabel('approved')).toBe('Signed in')
  expect(oauthStateLabel('weird')).toBe('Sign-in failed')
})
