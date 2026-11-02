/**
 * Mic EQ meter for the dictation chip. Drives the `.ca-voice-bars` heights from
 * the REAL microphone input (getUserMedia stream) via a Web Audio AnalyserNode —
 * frequency-domain FFT magnitudes split into 8 log-spaced bands (true EQ look,
 * not a single volume number). Smoothed per band, throttled to ~12Hz.
 *
 * Returns null (the chip falls back to a quiet settled look) when Web Audio
 * is unavailable — never throws.
 */

export interface VoiceMeter {
  stop: () => void
}

/** Number of bars the chip renders — one per EQ band. */
export const VOICE_BAND_COUNT = 8

/** Log-ish band edges in Hz covering the speech range (8 bands between them). */
const BAND_EDGES_HZ = [60, 170, 310, 600, 1000, 2000, 4000, 8000, 12000]

export function createVoiceMeter(
  stream: MediaStream,
  onBands: (levels: number[]) => void,
): VoiceMeter | null {
  const w = window as unknown as {
    AudioContext?: new () => AudioContext
    webkitAudioContext?: new () => AudioContext
  }
  const Ctor = w.AudioContext ?? w.webkitAudioContext
  if (typeof Ctor !== 'function') return null

  let ctx: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let analyser: AnalyserNode | null = null
  let timer = 0
  let stopped = false

  try {
    ctx = new Ctor()
    source = ctx.createMediaStreamSource(stream)
    analyser = ctx.createAnalyser()
    analyser.fftSize = 1024 // ~43Hz/bin at 44.1k — decent low-end resolution
    source.connect(analyser)

    const binHz = ctx.sampleRate / analyser.fftSize
    const bands = BAND_EDGES_HZ.slice(0, -1).map((lo, i) => {
      const hi = BAND_EDGES_HZ[i + 1]
      const start = Math.max(0, Math.floor(lo / binHz))
      const end = Math.min(
        analyser!.frequencyBinCount - 1,
        Math.max(start + 1, Math.ceil(hi / binHz)),
      )
      return { start, end, span: end - start + 1 }
    })

    const freq = new Uint8Array(analyser.frequencyBinCount)
    const smooth = new Array<number>(bands.length).fill(0)

    timer = window.setInterval(() => {
      if (stopped || !analyser) return
      analyser.getByteFrequencyData(freq)
      const out = new Array<number>(bands.length)
      for (let b = 0; b < bands.length; b++) {
        // Peak within the band — reads like an EQ VU meter (a strong partial
        // lights its own bar instead of washing the average out).
        let peak = 0
        for (let i = bands[b].start; i <= bands[b].end; i++) {
          if (freq[i] > peak) peak = freq[i]
        }
        // Perceptual curve: compressed boost (^0.6) so normal speech sits in
        // the middle of the range and only loud input tops out — no pegging.
        const raw = peak <= 4 ? 0 : Math.min(1, peak / 255)
        const value = Math.max(0, Math.min(1, Math.pow(raw, 0.6) * 1.1))
        smooth[b] = smooth[b] * 0.55 + value * 0.45
        out[b] = smooth[b]
      }
      onBands(out)
    }, 80)
  } catch {
    return null
  }

  return {
    stop() {
      stopped = true
      window.clearInterval(timer)
      try {
        source?.disconnect()
      } catch {
        /* already gone */
      }
      try {
        analyser?.disconnect()
      } catch {
        /* already gone */
      }
      try {
        if (ctx && ctx.state !== 'closed') void ctx.close()
      } catch {
        /* already closed */
      }
      onBands(new Array<number>(BAND_EDGES_HZ.length - 1).fill(0))
    },
  }
}