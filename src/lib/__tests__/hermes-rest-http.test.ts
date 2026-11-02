import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServeCron, hasAgentTarget, isDashboardNotReady, listServeCronJobs, pauseServeCron, resetAllProbes, serveAuth, serveGet, serveGetDetailed, serveSend, triggerServeCron } from '../hermes-rest'

let fetchMock: ReturnType<typeof vi.fn>
let vmRest: ReturnType<typeof vi.fn>
const response = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  resetAllProbes()
  fetchMock = vi.fn(async () => response(200, { jobs: [{ id: 'fixture-job' }] }))
  vmRest = vi.fn()
  ;(window as unknown as { nubAgent: unknown }).nubAgent = {
    serveConfig: async () => ({ present: true, baseUrl: 'http://127.0.0.1:19120' }),
    nubVmRest: vmRest,
    nubConnection: vi.fn(),
  }
  window.localStorage.setItem('nub:mobile-session', JSON.stringify({ host: 'https://fake.example', instanceId: 'fake-instance', desktopToken: 'FAKE_TOKEN_NOT_REAL' }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  resetAllProbes()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  window.localStorage.clear()
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
})

describe('local-only serve REST', () => {
  it('resolves presence without a token and never consults a VM or paired session', async () => {
    expect(await serveAuth()).toEqual({ baseUrl: 'http://127.0.0.1:19120', token: '' })
    expect(await hasAgentTarget()).toBe(true)
    expect(await listServeCronJobs()).toEqual([{ id: 'fixture-job' }])
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:19120/api/cron/jobs', expect.objectContaining({ method: 'GET', credentials: 'omit', headers: {} }))
    expect(vmRest).not.toHaveBeenCalled()
  })

  it('cron mutations only use the authenticated loopback REST path', async () => {
    fetchMock.mockResolvedValue(response(200, { id: 'fixture-job' }))
    await createServeCron({ name: 'Fixture routine', prompt: 'Synthetic prompt', schedule: '0 9 * * *' })
    await pauseServeCron('fixture-job')
    await triggerServeCron('fixture-job')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:19120/api/cron/jobs',
      'http://127.0.0.1:19120/api/cron/jobs/fixture-job/pause',
      'http://127.0.0.1:19120/api/cron/jobs/fixture-job/trigger',
    ])
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'POST' && init.credentials === 'omit')).toBe(true)
  })

  it.each([403, 409])('does not retry all profiles on a %s cron response', async (status) => {
    fetchMock.mockResolvedValue(response(status, { detail: 'Synthetic unavailable route' }))
    expect(await listServeCronJobs()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(isDashboardNotReady()).toBe(true)
    expect(await listServeCronJobs()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a profile conflict reports its error without blocking other local REST calls', async () => {
    fetchMock.mockResolvedValueOnce(response(409, { detail: 'Profile already exists' }))
    expect(await serveSend('POST', '/api/profiles', { name: 'fixture' }))
      .toMatchObject({ ok: false, status: 409, error: 'Profile already exists' })
    expect(isDashboardNotReady()).toBe(false)
    expect(await listServeCronJobs()).toEqual([{ id: 'fixture-job' }])
  })

  it('rejects secret routes before fetch and reports missing serve without a hosted fallback', async () => {
    expect(await serveGet('/api/env/reveal')).toBeNull()
    delete (window as unknown as { nubAgent?: unknown }).nubAgent
    expect(await hasAgentTarget()).toBe(false)
    expect(await serveGet('/api/skills')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts successful empty writes and rejects HTML fallback pages', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await serveSend('DELETE', '/api/cron/jobs/fixture')).toMatchObject({ ok: true, status: 204 })
    fetchMock.mockResolvedValueOnce(new Response('<html>not JSON</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    expect(await serveGet('/api/skills')).toBeNull()
  })

  it.each(['peer-unverified', 'timeout', 'upstream-http', 'invalid-response', 'response-too-large'] as const)(
    'preserves the allowlisted %s category without reporting private payloads', async failureCategory => {
      fetchMock.mockResolvedValue(new Response('{"error":"Serve request unavailable"}', {
        status: 502, headers: { 'Content-Type': 'application/json', 'X-Hermes-Serve-Failure': failureCategory },
      }))
      expect(await serveGetDetailed('/api/skills')).toMatchObject({
        data: null, status: 502, error: { failureCategory },
      })
    })

  it('drops arbitrary failure-header values and classifies malformed JSON without echoing it', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"Serve request unavailable"}', {
      status: 502, headers: { 'Content-Type': 'application/json', 'X-Hermes-Serve-Failure': 'FAKE private path' },
    }))
    expect((await serveGetDetailed('/api/skills')).error).not.toHaveProperty('failureCategory')
    fetchMock.mockResolvedValueOnce(new Response('{FAKE private body', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const result = await serveGetDetailed('/api/skills')
    expect(result).toMatchObject({ data: null, status: 200, error: { failureCategory: 'invalid-response' } })
    expect(JSON.stringify(result)).not.toContain('FAKE private body')
  })

  it('keeps the renderer deadline and labels transport aborts without exception details', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('FAKE private transport detail', 'AbortError')))
    }))
    const pending = serveGetDetailed('/api/skills')
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await pending
    expect(result.error).toMatchObject({ kind: 'timeout', failureCategory: 'timeout' })
    expect(JSON.stringify(result)).not.toContain('FAKE private transport detail')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('exposes categories for writes but ignores a forged category on a successful response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"Serve request unavailable"}', {
      status: 502, headers: { 'Content-Type': 'application/json', 'X-Hermes-Serve-Failure': 'peer-unverified' },
    }))
    expect(await serveSend('PATCH', '/api/sessions/fixture?profile=alpha', { unread: false, profile: 'alpha' }))
      .toMatchObject({ ok: false, status: 502, failureCategory: 'peer-unverified' })
    fetchMock.mockResolvedValueOnce(new Response('{"skills":[]}', {
      status: 200, headers: { 'Content-Type': 'application/json', 'X-Hermes-Serve-Failure': 'peer-unverified' },
    }))
    expect(await serveGetDetailed('/api/skills')).toEqual({ data: { skills: [] }, status: 200 })
  })
})
