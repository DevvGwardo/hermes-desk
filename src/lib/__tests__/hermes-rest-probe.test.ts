import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markNotificationsRead, probeNotifications, probeResize, probeTranscriptTail, readNotifications, resetAllProbes } from '../hermes-rest'

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  resetAllProbes()
  ;(window as unknown as { nubAgent: unknown }).nubAgent = { serveConfig: async () => ({ present: true, baseUrl: 'http://127.0.0.1:19120' }) }
  fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  resetAllProbes()
  vi.unstubAllGlobals()
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
})

describe('local capability probes', () => {
  it.each([probeTranscriptTail])('uses and caches one loopback JSON GET', async (probe) => {
    expect(await probe()).toBe(true)
    expect(await probe()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('http://127.0.0.1:19120/api/'), expect.objectContaining({ method: 'GET', credentials: 'omit' }))
  })
  it.each([probeTranscriptTail])('does not treat HTML as a supported API', async (probe) => {
    fetchMock.mockResolvedValue(new Response('<html>fixture</html>', { headers: { 'Content-Type': 'text/html' } }))
    expect(await probe()).toBe(false)
  })
  it('never probes hosted machine resize', async () => {
    expect(await probeResize('fake-instance')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('keeps the notification feed local without contacting the legacy bus', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 502 }))
    expect(await probeNotifications()).toBe(false)
    expect(await readNotifications()).toBeNull()
    expect(await markNotificationsRead(['local-fixture'])).toBe(false)
    resetAllProbes()
    expect(await probeNotifications()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
