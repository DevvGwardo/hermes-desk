import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVoiceMeter, VOICE_BAND_COUNT } from '../voice-meter'

class FakeAnalyser {
  frequencyBinCount = 512
  fftSize = 0
  /** bin index of the injected tone (see binForHz). */
  toneBin = -1
  getByteFrequencyData(data: Uint8Array) {
    data.fill(4) // quiet room floor
    if (this.toneBin >= 0 && this.toneBin < data.length) data[this.toneBin] = 210
  }
  disconnect() {}
}

class FakeSource {
  connect() {}
  disconnect() {}
}

/** 48000 Hz context + fftSize 1024 → ~46.875 Hz/bin */
const binForHz = (hz: number) => Math.round(hz / (48000 / 1024))

let analyser: FakeAnalyser

function installAudio(toneHz: number | null) {
  analyser = new FakeAnalyser()
  analyser.toneBin = toneHz === null ? -1 : binForHz(toneHz)
  const AudioContext = class {
    sampleRate = 48000
    state: AudioContextState = 'running'
    createMediaStreamSource() {
      return new FakeSource() as unknown as MediaStreamAudioSourceNode
    }
    createAnalyser() {
      return analyser as unknown as AnalyserNode
    }
    close() {
      this.state = 'closed'
      return Promise.resolve()
    }
  }
  ;(window as unknown as { AudioContext?: unknown }).AudioContext = AudioContext
}

beforeEach(() => {
  vi.useFakeTimers()
  installAudio(null)
})

afterEach(() => {
  vi.useRealTimers()
  delete (window as unknown as { AudioContext?: unknown }).AudioContext
})

describe('createVoiceMeter — real EQ bands', () => {
  it('emits VOICE_BAND_COUNT levels and settles to zeros on stop', () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream
    const frames: number[][] = []
    const meter = createVoiceMeter(stream, (levels) => frames.push(levels))
    expect(meter).not.toBeNull()

    vi.advanceTimersByTime(80)
    vi.advanceTimersByTime(80)
    expect(frames.length).toBeGreaterThan(0)
    expect(frames[frames.length - 1]).toHaveLength(VOICE_BAND_COUNT)

    meter?.stop()
    expect(frames[frames.length - 1].every((v) => v === 0)).toBe(true)
  })

  it('separation: a ~1.2kHz tone lights the 1000–2000 Hz band, not the bass or treble', () => {
    installAudio(1172) // bin 25 → band 1000–2000
    const stream = { getTracks: () => [] } as unknown as MediaStream
    const frames: number[][] = []
    createVoiceMeter(stream, (levels) => frames.push(levels))

    vi.advanceTimersByTime(80)
    vi.advanceTimersByTime(80)
    vi.advanceTimersByTime(80)
    const settled = frames[frames.length - 1]

    // Bands: 60-170, 170-310, 310-600, 600-1000, 1000-2000, 2000-4000, 4000-8000, 8000-12000
    expect(settled[4]).toBeGreaterThan(0.5) // 1000–2000 Hz lit by the tone
    expect(settled[0]).toBeLessThan(0.2) // 60–170 Hz stays quiet
    expect(settled[7]).toBeLessThan(0.2) // 8–12 kHz stays quiet
  })

  it('different pitch lights a different band — real EQ, not volume', () => {
    installAudio(8800) // bin ~188 → 8–12 kHz band
    const stream = { getTracks: () => [] } as unknown as MediaStream
    const frames: number[][] = []
    createVoiceMeter(stream, (levels) => frames.push(levels))

    vi.advanceTimersByTime(80)
    vi.advanceTimersByTime(80)
    vi.advanceTimersByTime(80)
    const settled = frames[frames.length - 1]

    expect(settled[7]).toBeGreaterThan(0.5) // 8–12 kHz lit
    expect(settled[0]).toBeLessThan(0.2) // bass band stays quiet
  })

  it('stays quiet across all bands when the mic produces no signal', () => {
    installAudio(null) // pure floor
    const stream = { getTracks: () => [] } as unknown as MediaStream
    const frames: number[][] = []
    createVoiceMeter(stream, (levels) => frames.push(levels))

    vi.advanceTimersByTime(80)
    vi.advanceTimersByTime(80)
    const settled = frames[frames.length - 1]
    for (const v of settled) expect(v).toBeLessThan(0.1)
  })

  it('returns null when Web Audio is unavailable (no crash)', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext
    const stream = { getTracks: () => [] } as unknown as MediaStream
    const meter = createVoiceMeter(stream, () => {})
    expect(meter).toBeNull()
  })

  it('stops the interval on stop()', () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream
    const frames: number[][] = []
    const meter = createVoiceMeter(stream, (levels) => frames.push(levels))
    meter?.stop()
    const before = frames.length
    vi.advanceTimersByTime(400)
    expect(frames.length).toBe(before)
  })
})