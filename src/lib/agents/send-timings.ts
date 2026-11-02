/**
 * Send → first-token timings for deploy-transport turns (local only).
 *
 * One sample per `runCubeTurn`: performance.now() at the POST, when its
 * response headers arrive, when the `/events` stream opened (poll transport
 * only), at the first content delta and at settle. Kept in a small in-memory
 * ring (last {@link SEND_TIMING_SAMPLES}) and logged once per turn with
 * console.debug. Nothing is sent over the network.
 *
 * Read it from devtools with `__nubSendTimings()` or import `getSendTimings`.
 */

export const SEND_TIMING_SAMPLES = 50

export type SendTimingMark = 'postHeaders' | 'eventsResponse' | 'firstDelta'

export type SendTimingOutcome = 'ok' | 'error' | 'followed'

/** Milliseconds from the POST start; absent = that step never happened. */
export interface SendTimingSample {
  turnId: string | null
  transport: string
  /** Epoch ms of the POST (for lining samples up with logs). */
  at: number
  postHeadersMs?: number
  eventsResponseMs?: number
  firstDeltaMs?: number
  settledMs?: number
  outcome?: SendTimingOutcome
}

export interface SendTimingHandle {
  setTurnId(turnId: string): void
  /** First call per mark wins; later calls are ignored. */
  mark(name: SendTimingMark): void
  /** Records the sample (once) and logs one line. */
  settle(outcome: SendTimingOutcome): void
  readonly sample: Readonly<SendTimingSample>
}

const samples: SendTimingSample[] = []

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

const FIELD: Record<SendTimingMark, 'postHeadersMs' | 'eventsResponseMs' | 'firstDeltaMs'> = {
  postHeaders: 'postHeadersMs',
  eventsResponse: 'eventsResponseMs',
  firstDelta: 'firstDeltaMs',
}

export function startSendTiming(transport: string, clock: () => number = now): SendTimingHandle {
  const t0 = clock()
  const sample: SendTimingSample = { turnId: null, transport, at: Date.now() }
  let settled = false
  return {
    sample,
    setTurnId(turnId) {
      if (turnId) sample.turnId = turnId
    },
    mark(name) {
      const key = FIELD[name]
      if (settled || sample[key] !== undefined) return
      sample[key] = Math.round(clock() - t0)
    },
    settle(outcome) {
      if (settled) return
      settled = true
      sample.settledMs = Math.round(clock() - t0)
      sample.outcome = outcome
      samples.push(sample)
      if (samples.length > SEND_TIMING_SAMPLES) samples.splice(0, samples.length - SEND_TIMING_SAMPLES)
      try {
        console.debug(formatSendTiming(sample))
      } catch {
        // console unavailable: the ring still has it.
      }
    },
  }
}

export function formatSendTiming(s: SendTimingSample): string {
  const ms = (v: number | undefined) => (v === undefined ? '-' : `${v}ms`)
  return (
    `[send-timing] ${s.transport} turn=${s.turnId ?? '?'} post=${ms(s.postHeadersMs)}` +
    (s.transport === 'poll' ? ` events=${ms(s.eventsResponseMs)}` : '') +
    ` first=${ms(s.firstDeltaMs)} settle=${ms(s.settledMs)} ${s.outcome ?? ''}`
  ).trim()
}

/** Newest last. Copies, so callers can't mutate the ring. */
export function getSendTimings(): SendTimingSample[] {
  return samples.map((s) => ({ ...s }))
}

/** Test helper. */
export function clearSendTimings(): void {
  samples.length = 0
}

if (typeof window !== 'undefined') {
  try {
    ;(window as unknown as { __nubSendTimings?: () => SendTimingSample[] }).__nubSendTimings =
      getSendTimings
  } catch {
    // frozen window (tests / sandboxed shells)
  }
}
