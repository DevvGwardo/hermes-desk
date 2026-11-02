import { beforeEach, describe, expect, it, vi } from 'vitest'

const serveSend = vi.fn()
vi.mock('../hermes-rest', () => ({
  serveGetDetailed: vi.fn(),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))

import { isAgentConfigPathWritable, nestDotted, patchAgentConfig, readDotted } from '../agent-config'

beforeEach(() => serveSend.mockReset())

describe('agent config allowlist', () => {
  it('nests dotted paths', () => {
    expect(nestDotted({ 'a.b': 1, 'a.c': 2, d: 3 })).toEqual({ a: { b: 1, c: 2 }, d: 3 })
    expect(readDotted({ a: { b: 1 } }, 'a.b')).toBe(1)
    expect(readDotted({ a: 1 }, 'a.b')).toBeUndefined()
  })

  it('allows only listed paths', () => {
    expect(isAgentConfigPathWritable('timezone')).toBe(true)
    expect(isAgentConfigPathWritable('approvals.mode')).toBe(true)
    for (const p of ['model.default', 'security.redact_secrets', 'hooks_auto_accept', 'terminal.backend', 'security.allow_private_urls', 'approvals']) {
      expect(isAgentConfigPathWritable(p)).toBe(false)
    }
  })

  it('refuses a patch containing any disallowed path without calling the agent', async () => {
    const res = await patchAgentConfig({ timezone: 'Europe/Paris', 'model.default': 'x' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('model.default')
    expect(serveSend).not.toHaveBeenCalled()
  })

  it('sends a nested config body', async () => {
    serveSend.mockResolvedValue({ ok: true, data: {} })
    await patchAgentConfig({ 'privacy.redact_pii': true, timezone: 'America/New_York' })
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/config', {
      config: { privacy: { redact_pii: true }, timezone: 'America/New_York' },
    })
  })
})
