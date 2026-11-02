import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isDashboardNotReady,
  listServeCronJobs,
  resetDashboardNotReady,
} from '../hermes-rest'

beforeEach(() => {
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
  resetDashboardNotReady()
  ;(window as unknown as { nubAgent: unknown }).nubAgent = {
    serveConfig: async () => ({ present: true, baseUrl: 'http://127.0.0.1:19120' }),
  }
})

afterEach(() => {
  resetDashboardNotReady()
  vi.unstubAllGlobals()
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
})

describe('statusFromRest DNS gap (hermes-rest.ts:55-65) DNS-GAP-DOC', () => {
  it('a failed local fetch retries without arming the conflict TTL', async () => {
    // DNS-GAP-DOC: statusFromRest returns undefined for DNS-shaped inputs
    // (no numeric status, no "dashboard NNN" / bare 403|404|409 token), so the
    // 409-TTL arms ONLY on real 409 and DNS failures fall through to the
    // ?profile=all retry uncached with isDashboardNotReady() staying false.
    const fetchMock = vi.fn(async () => { throw new TypeError('fetch failed') })
    vi.stubGlobal('fetch', fetchMock)
    expect(await listServeCronJobs()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:19120/api/cron/jobs?profile=all', expect.objectContaining({ method: 'GET' }))
    expect(isDashboardNotReady()).toBe(false)
  })
  it('real 409 still arms the TTL (contrast pin)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: 'Synthetic conflict' }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await listServeCronJobs()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(isDashboardNotReady()).toBe(true)
  })
})

describe('isDashboardDnsError absence pin', () => {
  it('does not exist yet (do NOT create it in src/)', async () => {
    const mod = (await import('../hermes-rest')) as unknown as Record<string, unknown>
    expect(mod.isDashboardDnsError).toBeUndefined()
  })
})

describe.skip('isDashboardDnsError (future classifier — SKIPPED, proposed shape)', () => {
  // Proposed predicate for a future batch (not implemented):
  // export function isDashboardDnsError(input: unknown): boolean {
  //   const msg = typeof input === 'string' ? input
  //     : input instanceof Error ? (input.cause ? `${input.message} ${String(input.cause)}` : input.message)
  //     : String((input as { error?: unknown })?.error ?? input ?? '');
  //   return /ENOTFOUND|getaddrinfo|EAI_AGAIN|fetch failed/i.test(msg);
  // }
  it('flags ENOTFOUND/getaddrinfo/fetch-failed, rejects 409/403 bodies', () => {
    const isDashboardDnsError = (input: unknown): boolean => {
      const msg =
        typeof input === 'string'
          ? input
          : input instanceof Error
            ? input.cause
              ? `${input.message} ${String(input.cause)}`
              : input.message
            : String((input as { error?: unknown })?.error ?? input ?? '')
      return /ENOTFOUND|getaddrinfo|EAI_AGAIN|fetch failed/i.test(msg)
    }
    expect(isDashboardDnsError('getaddrinfo ENOTFOUND x')).toBe(true)
    expect(isDashboardDnsError(new TypeError('fetch failed'))).toBe(true)
    expect(isDashboardDnsError({ error: 'dashboard 409' })).toBe(false)
  })
})
