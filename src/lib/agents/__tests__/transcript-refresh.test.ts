import { describe, expect, it } from 'vitest'
import {
  TRANSCRIPT_SAFETY_REFRESH_MS,
  TranscriptRefreshGate,
  transcriptSignature,
} from '../transcript-refresh'

const conv = { id: 'c1', lastUsedAt: '2026-10-01T00:00:00Z', preview: 'hi' }

describe('transcript refetch gate', () => {
  it('first sight only records (the selection load already fetched)', () => {
    const gate = new TranscriptRefreshGate({ liveMinMs: 5000 })
    expect(gate.check('c1', transcriptSignature(conv, undefined), false, 0)).toBeNull()
  })

  it('quiet thread: no refetch until the safety backstop', () => {
    const gate = new TranscriptRefreshGate({ liveMinMs: 5000 })
    const sig = transcriptSignature(conv, undefined)
    gate.check('c1', sig, false, 0)
    for (const t of [5_000, 15_000, 30_000, TRANSCRIPT_SAFETY_REFRESH_MS - 1]) {
      expect(gate.check('c1', sig, false, t)).toBeNull()
    }
    expect(gate.check('c1', sig, false, TRANSCRIPT_SAFETY_REFRESH_MS)).toBe('safety')
    gate.markFetched('c1', sig, TRANSCRIPT_SAFETY_REFRESH_MS)
    expect(gate.check('c1', sig, false, TRANSCRIPT_SAFETY_REFRESH_MS + 5_000)).toBeNull()
  })

  it('a new turn (lastTurnAt) or settled preview from the sync feed refetches at once', () => {
    const gate = new TranscriptRefreshGate({ liveMinMs: 5000 })
    gate.check('c1', transcriptSignature(conv, undefined), false, 0)
    const moved = transcriptSignature({ ...conv, lastUsedAt: '2026-10-01T00:01:00Z' }, undefined)
    expect(gate.check('c1', moved, false, 100)).toBe('changed')
    gate.markFetched('c1', moved, 200)
    const settled = transcriptSignature({ ...conv, lastUsedAt: '2026-10-01T00:01:00Z', preview: 'done' }, undefined)
    expect(gate.check('c1', settled, false, 300)).toBe('changed')
  })

  it('a live turn keeps the old cadence (bounded by liveMinMs)', () => {
    const gate = new TranscriptRefreshGate({ liveMinMs: 5000 })
    const live = { turnId: 't1', sessionId: 's', status: 'streaming' as const }
    const sig = transcriptSignature(conv, live)
    gate.check('c1', sig, true, 0)
    expect(gate.check('c1', sig, true, 4_000)).toBeNull()
    expect(gate.check('c1', sig, true, 5_000)).toBe('live')
  })

  it('live turn appearing or ending changes the signature', () => {
    const a = transcriptSignature(conv, undefined)
    const b = transcriptSignature(conv, { turnId: 't1', sessionId: 's', status: 'pending' })
    const c = transcriptSignature(conv, { turnId: 't1', sessionId: 's', status: 'streaming' })
    expect(new Set([a, b, c]).size).toBe(3)
    expect(transcriptSignature(undefined, undefined)).toBe('')
  })

  it('tracks conversations independently', () => {
    const gate = new TranscriptRefreshGate({ liveMinMs: 5000 })
    gate.check('c1', 'x', false, 0)
    expect(gate.check('c2', 'y', false, 10)).toBeNull()
    expect(gate.check('c1', 'x2', false, 20)).toBe('changed')
  })
})
