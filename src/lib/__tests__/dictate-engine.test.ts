import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendTranscript,
  DICTATE_MAX_MS,
  DictateEngine,
  initialDictateStatus,
  nextDictateStatus,
  pickAudioMimeType,
  type DictateStatus,
} from '../dictate'

type FakeInstance = {
  state: 'inactive' | 'recording'
  timeslice: number
  options?: MediaRecorderOptions
  stopCall: () => void
  emitStop: () => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let instances: FakeInstance[] = []
let lastStreamTracks: Array<{ stop: ReturnType<typeof vi.fn> }> = []

function installCapture(
  opts: { supported?: string[]; getUserMedia?: () => Promise<MediaStream> } = {},
) {
  const supported = opts.supported ?? ['audio/webm;codecs=opus', 'audio/webm']
  instances = []
  let recorder: MediaRecorder | null = null

  class FakeMediaRecorder {
    static isTypeSupported = (type: string) => supported.includes(type)
    state: 'inactive' | 'recording' = 'inactive'
    ondataavailable: ((ev: BlobEvent) => void) | null = null
    onerror: ((ev: Event) => void) | null = null
    onstop: (() => void) | null = null
    timeslice = 0
    options?: MediaRecorderOptions
    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      this.options = options
      recorder = this as unknown as MediaRecorder
      instances.push(this as unknown as FakeInstance)
    }
    start(timeslice?: number) {
      this.timeslice = timeslice ?? 0
      this.state = 'recording'
    }
    stop() {
      if (this.state !== 'recording') return
      this.state = 'inactive'
      const blob = new Blob([new Uint8Array([9, 8, 7])], { type: this.options?.mimeType ?? 'audio/webm' })
      this.ondataavailable?.({ data: blob } as BlobEvent)
      this.onstop?.()
    }
  }
  ;(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder
  ;(window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder

  const getUserMedia = opts.getUserMedia ?? (async () => {
    lastStreamTracks = [{ stop: vi.fn() }, { stop: vi.fn() }]
    return { getTracks: () => lastStreamTracks } as unknown as MediaStream
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })

  return {
    instances,
    getRecorder: () => recorder,
  }
}

beforeEach(() => {
  lastStreamTracks = []
  instances = []
  vi.restoreAllMocks()
  delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder
  delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices
})

afterEach(() => {
  vi.useRealTimers()
})

describe('moment helpers', () => {
  it('picks the first supported Grok-parity mime candidate', () => {
    installCapture({ supported: ['audio/webm;codecs=opus', 'audio/webm'] })
    expect(pickAudioMimeType()).toBe('audio/webm;codecs=opus')
  })

  it('falls through to a bare webm/mp4 when the codec variant is unsupported', () => {
    installCapture({ supported: ['audio/webm'] })
    expect(pickAudioMimeType()).toBe('audio/webm')
  })

  it('returns null when MediaRecorder is missing', () => {
    delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder
    expect(pickAudioMimeType()).toBeNull()
  })

  it('starts unavailable without MediaRecorder, idle with it (handoff from dictate.test.ts)', () => {
    delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder
    expect(initialDictateStatus()).toBe('unavailable')
    installCapture()
    expect(initialDictateStatus()).toBe('idle')
  })

  it('keeps the appendTranscript spacing contract', () => {
    expect(appendTranscript('', ' ship the cube ')).toBe('ship the cube')
    expect(appendTranscript('ship', 'the cube')).toBe('ship the cube')
    expect(appendTranscript('ship the ', 'cube')).toBe('ship the cube')
    expect(appendTranscript('ship', ', please')).toBe('ship, please')
  })

  it('transitions status like the recorder state machine', () => {
    check('idle', 'start', 'listening')
    check('listening', 'transcribe', 'processing')
    check('processing', 'stop', 'idle')
    check('idle', 'deny', 'denied')
    expect(nextDictateStatus('denied', 'start')).toBe('denied')
    expect(nextDictateStatus('unavailable', 'stop')).toBe('unavailable')
    expect(nextDictateStatus('idle', 'error')).toBe('idle')
    function check(cur: DictateStatus, ev: Parameters<typeof nextDictateStatus>[1], out: DictateStatus) {
      expect(nextDictateStatus(cur, ev)).toBe(out)
    }
  })
})

describe('DictateEngine — local whisper recorder', () => {
  it('records, stops, and commits a transcript (Grok flow)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const capture = installCapture()
    const transcribe = vi.fn().mockResolvedValue('ship the cube')
    const onFinal = vi.fn()
    const statuses: DictateStatus[] = []
    const engine = new DictateEngine({
      transcribe,
      hooks: { onStatus: (s) => statuses.push(s), onFinal },
    })

    await engine.start()
    expect(engine.getState().status).toBe('listening')
    expect(capture.getRecorder()?.state).toBe('recording')
    expect((capture.getRecorder() as unknown as { timeslice?: number })?.timeslice).toBe(1000) // Grok-parity 1s slices

    vi.setSystemTime(1_001_000) // a real 1s take
    await engine.stop()
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(onFinal).toHaveBeenCalledWith('ship the cube')
    expect(engine.getState().status).toBe('idle')
    expect(statuses).toEqual(['listening', 'processing', 'idle'])
  })

  it('discards a sub-500ms tap silently (no transcribe, no error)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    installCapture()
    const transcribe = vi.fn()
    const onFinal = vi.fn()
    const engine = new DictateEngine({ transcribe, hooks: { onFinal } })

    await engine.start()
    await engine.stop() // elapsed ~0ms
    expect(transcribe).not.toHaveBeenCalled()
    expect(onFinal).not.toHaveBeenCalled()
    expect(engine.getState().status).toBe('idle')
  })

  it('surfaces denied when the user refuses the mic', async () => {
    installCapture({
      getUserMedia: () => Promise.reject(new DOMException('permission', 'NotAllowedError')),
    })
    const engine = new DictateEngine({ transcribe: vi.fn() })
    await engine.start()
    expect(engine.getState().status).toBe('denied')
  })

  it('recover: a capture error returns to idle', async () => {
    installCapture({
      getUserMedia: () => Promise.reject(new Error('device busy')),
    })
    const engine = new DictateEngine({ transcribe: vi.fn() })
    await engine.start()
    expect(engine.getState().status).toBe('idle')
  })

  it('cancel aborts tracks without transcribing (unmount safety)', async () => {
    installCapture()
    const transcribe = vi.fn()
    const engine = new DictateEngine({ transcribe })
    await engine.start()
    engine.cancel()
    expect(transcribe).not.toHaveBeenCalled()
    expect(engine.getState().status).toBe('idle')
    for (const t of lastStreamTracks) expect(t.stop).toHaveBeenCalled()
  })

  it('auto-stops at the max recording ceiling and commits', async () => {
    installCapture()
    const transcribe = vi.fn().mockResolvedValue('long take')
    const onFinal = vi.fn()
    const engine = new DictateEngine({
      transcribe,
      maxRecordingMs: 300,
      minAudioMs: 100,
      hooks: { onFinal },
    })
    await engine.start()
    await sleep(420)
    await sleep(50)
    expect(engine.getState().status).toBe('idle')
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(onFinal).toHaveBeenCalledWith('long take')
  })

  it('a failed transcription recovers to idle without committing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_000_000)
    installCapture()
    const transcribe = vi.fn().mockRejectedValue(new Error('whisper missing'))
    const onFinal = vi.fn()
    const engine = new DictateEngine({ transcribe, hooks: { onFinal } })
    await engine.start()
    vi.setSystemTime(3_001_000)
    await engine.stop()
    expect(engine.getState().status).toBe('idle')
    expect(onFinal).not.toHaveBeenCalled()
  })

  it('ignores start while already processing, and stop while processing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(4_000_000)
    installCapture()
    let resolveTranscribe!: (text: string) => void
    const transcribe = vi.fn().mockImplementation(() => new Promise<string>((r) => (resolveTranscribe = r)))
    const engine = new DictateEngine({ transcribe })
    await engine.start()
    vi.setSystemTime(4_001_000)
    const stopP = engine.stop() // processing now
    expect(engine.getState().status).toBe('processing')
    await engine.start() // ignored while processing
    expect(engine.getState().status).toBe('processing')
    // Flush completeTake's continuations (recorder-stop await, blob.arrayBuffer)
    // so the transcribe mock is actually invoked (its resolver is held).
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(typeof resolveTranscribe).toBe('function')
    resolveTranscribe('done')
    await stopP
    expect(engine.getState().status).toBe('idle')
  })

  it('defaults max ceiling to the Grok 300s voice-max-recording cap', () => {
    const engine = new DictateEngine({ transcribe: vi.fn() })
    expect(DICTATE_MAX_MS).toBe(300_000)
    expect(engine.getState().status).toBe('idle')
  })
})
describe('dictateDeniedCopy', () => {
  it('points each shell at the setting that actually controls the mic', async () => {
    const { dictateDeniedCopy, DICTATE_DENIED_COPY, DICTATE_DENIED_WEB_COPY, DICTATE_DENIED_PHONE_COPY } =
      await import('../dictate')
    expect(dictateDeniedCopy({ desktop: true, nativePhone: false })).toBe(DICTATE_DENIED_COPY)
    expect(dictateDeniedCopy({ desktop: false, nativePhone: false })).toBe(DICTATE_DENIED_WEB_COPY)
    expect(dictateDeniedCopy({ desktop: false, nativePhone: true })).toBe(DICTATE_DENIED_PHONE_COPY)
    expect(DICTATE_DENIED_WEB_COPY).not.toMatch(/System Settings/)
  })
})
