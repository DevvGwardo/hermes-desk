import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
const require = createRequire(import.meta.url)
const { setProfileTimezone } = require('./profile-timezone.cjs')

describe('scoped profile time zone REST adapter', () => {
  it('writes only the selected profile, then requires exact saved-value read-back', async () => {
    const endpoint = { baseUrl: 'http://127.0.0.1:9188', auth: { token: 'obviously-fake' } }
    const request = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ timezone: 'Europe/London' })
    await expect(setProfileTimezone('alpha', 'Europe/London', endpoint, () => true, request)).resolves.toBe(true)
    expect(request.mock.calls).toEqual([
      ['/api/config?profile=alpha', { ...endpoint, timezonePatch: { profile: 'alpha', timezone: 'Europe/London' } }],
      ['/api/config?profile=alpha&include_defaults=false', endpoint],
    ])
  })
  it.each(['../alpha', '', 'alpha?profile=beta'])('rejects invalid profile %s before contacting serve', async profile => {
    const request = vi.fn()
    await expect(setProfileTimezone(profile, 'UTC', {}, () => true, request)).rejects.toThrow('Invalid')
    expect(request).not.toHaveBeenCalled()
  })
  it('refuses invalid zones and a stale endpoint before any write', async () => {
    const request = vi.fn()
    await expect(setProfileTimezone('alpha', 'Invalid/Zone', {}, () => true, request)).rejects.toThrow('IANA')
    await expect(setProfileTimezone('alpha', 'UTC', {}, () => false, request)).rejects.toThrow('changed')
    expect(request).not.toHaveBeenCalled()
  })
  it.each([
    [{ ok: false }, { timezone: 'UTC' }],
    [{ ok: true }, { timezone: 'Europe/London' }],
    [{ ok: true }, {}],
  ])('never reports success on unconfirmed writes or mismatched read-back', async (ack, config) => {
    const request = vi.fn().mockResolvedValueOnce(ack).mockResolvedValueOnce(config)
    await expect(setProfileTimezone('alpha', 'UTC', {}, () => true, request)).rejects.toThrow()
  })
  it('does not read another endpoint after the acknowledged write races a restart', async () => {
    let current = true
    const request = vi.fn(async () => { current = false; return { ok: true } })
    await expect(setProfileTimezone('alpha', 'UTC', {}, () => current, request)).rejects.toThrow('changed after writing')
    expect(request).toHaveBeenCalledOnce()
  })
})
