import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SEND_TIMING_SAMPLES,
  clearSendTimings,
  formatSendTiming,
  getSendTimings,
  startSendTiming,
} from '../send-timings'

afterEach(() => {
  clearSendTimings()
  vi.restoreAllMocks()
})

function fakeClock(start = 1000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('send timings', () => {
  it('records each step relative to the POST, first mark wins', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const clock = fakeClock()
    const h = startSendTiming('poll', clock.now)
    clock.advance(120)
    h.mark('postHeaders')
    h.setTurnId('turn_1')
    clock.advance(80)
    h.mark('eventsResponse')
    clock.advance(400)
    h.mark('firstDelta')
    clock.advance(50)
    h.mark('firstDelta') // ignored
    clock.advance(1000)
    h.settle('ok')
    h.settle('error') // ignored

    const [s] = getSendTimings()
    expect(s).toMatchObject({
      turnId: 'turn_1',
      transport: 'poll',
      postHeadersMs: 120,
      eventsResponseMs: 200,
      firstDeltaMs: 600,
      settledMs: 1650,
      outcome: 'ok',
    })
    expect(getSendTimings()).toHaveLength(1)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]?.[0])).toBe(
      '[send-timing] poll turn=turn_1 post=120ms events=200ms first=600ms settle=1650ms ok',
    )
  })

  it('keeps only the newest samples', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    for (let i = 0; i < SEND_TIMING_SAMPLES + 7; i++) {
      const h = startSendTiming('sse')
      h.setTurnId(`t${i}`)
      h.settle('ok')
    }
    const all = getSendTimings()
    expect(all).toHaveLength(SEND_TIMING_SAMPLES)
    expect(all[0]?.turnId).toBe('t7')
    expect(all.at(-1)?.turnId).toBe(`t${SEND_TIMING_SAMPLES + 6}`)
  })

  it('formats missing steps as dashes and omits events for sse', () => {
    expect(formatSendTiming({ turnId: null, transport: 'sse', at: 0, settledMs: 5, outcome: 'error' })).toBe(
      '[send-timing] sse turn=? post=- first=- settle=5ms error',
    )
  })

  it('returns copies', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    startSendTiming('sse').settle('ok')
    getSendTimings()[0]!.settledMs = 999
    expect(getSendTimings()[0]?.settledMs).not.toBe(999)
  })
})
