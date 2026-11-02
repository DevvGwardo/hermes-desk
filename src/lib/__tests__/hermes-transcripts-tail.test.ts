import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readTranscriptTails,
  resetNotificationsProbe,
  resetResizeProbe,
  resetTranscriptTailProbe,
} from '../hermes-rest'

/**
 * B1 client contract: `readTranscriptTails` is probe-guarded (no request to
 * an absent route) and shapes hits strictly. Serve auth comes through the
 * desktop bridge (window.nubAgent.serveConfig); fetch is the observable.
 */

type FetchSpy = ReturnType<typeof vi.fn>

let fetchSpy: FetchSpy

function cleanupWindow(): void {
  delete (window as unknown as Record<string, unknown>).nubAgent
}

/** Serve auth resolves via preload's nubAgent.serveConfig (desktop bridge). */
function stubServeAuth(baseUrl = 'http://127.0.0.1:9119'): void {
  ;(window as unknown as Record<string, unknown>).nubAgent = {
    serveConfig: async () => ({ present: true, baseUrl, tokenSource: 'env' }),
  }
}

beforeEach(() => {
  cleanupWindow()
  resetTranscriptTailProbe()
  resetResizeProbe()
  resetNotificationsProbe()
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  cleanupWindow()
  vi.unstubAllGlobals()
})

describe('readTranscriptTails', () => {
  it('returns null and never hits the data route when the probe fails', async () => {
    stubServeAuth()
    fetchSpy.mockImplementation((_url: string, _init?: { method?: string }) =>
      Promise.resolve(new Response(null, { status: 404 })),
    )
    const hits = await readTranscriptTails('inst-1')
    expect(hits).toBeNull()
    // Exactly one network call happened: the GET probe (404 ⇒ unsupported).
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('GET')
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/transcripts/tail')
  })

  it('fetches paged tail entries when supported and drops malformed rows', async () => {
    stubServeAuth()
    let calls = 0
    fetchSpy.mockImplementation((url: string) => {
      calls += 1
      expect(String(url)).toContain('/api/transcripts/tail')
      if (String(url).includes('instanceId=')) {
        expect(String(url)).toContain('instanceId=inst-1')
        expect(String(url)).toContain('limit=300')
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            entries: [
              { sessionId: 's2', text: 'newer hit', at: '2026-08-22T22:00:00Z' },
              { sessionId: 's1', text: 'older hit', at: '2026-08-22T21:00:00Z' },
              { broken: true },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    })
    const hits = await readTranscriptTails('inst-1')
    expect(calls).toBe(2)
    expect(hits).toEqual([
      { sessionId: 's2', text: 'newer hit', at: '2026-08-22T22:00:00Z' },
      { sessionId: 's1', text: 'older hit', at: '2026-08-22T21:00:00Z' },
    ])
  })

  it('caches the probe result across calls', async () => {
    stubServeAuth()
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(null, { status: 404 })))
    await readTranscriptTails('inst-1')
    await readTranscriptTails('inst-1')
    // Second call short-circuits on the cached false probe — still one GET.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
