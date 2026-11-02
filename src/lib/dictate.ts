import { createVoiceMeter, type VoiceMeter } from './voice-meter'

/**
 * Composer dictate — local microphone recording + local whisper transcription
 * (Grok-parity flow, reverse-engineered from the Grok Bot asar).
 *
 * Unlike the old Web Speech API path (which streamed mic audio to a cloud
 * speech service), this engine captures audio with getUserMedia → MediaRecorder
 * and hands the raw bytes to the Electron main process, which transcribes them
 * with a LOCAL whisper.cpp (`whisper-cli`). No renderer network traffic, no
 * webkitSpeechRecognition.
 *
 * State machine mirrors the Grok recorder:
 *   idle → requesting_permission → recording → processing → idle
 * On permission refusal we surface `denied`; on capture/transcription failure
 * we recover to `idle` (recoverable). The <minAudioMs tap discards silently.
 */

export type DictateStatus = 'idle' | 'listening' | 'processing' | 'denied' | 'unavailable'

export const DICTATE_DENIED_COPY = 'Microphone access denied. Enable it in System Settings to dictate.'
/** A browser tab: the permission lives in the site settings, not the OS. */
export const DICTATE_DENIED_WEB_COPY =
  'Microphone access denied. Allow it for this site in your browser settings to dictate.'
/** The Android app: the permission lives in the phone's app settings. */
export const DICTATE_DENIED_PHONE_COPY =
  'Microphone access denied. Allow it for Nub in your phone settings to dictate.'

/** Where the user can actually turn the mic back on, per shell. */
export function dictateDeniedCopy(shell: { desktop: boolean; nativePhone: boolean }): string {
  if (shell.desktop) return DICTATE_DENIED_COPY
  return shell.nativePhone ? DICTATE_DENIED_PHONE_COPY : DICTATE_DENIED_WEB_COPY
}

/** Grok-parity audio constraints (from the extracted asar). */
export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

/** Grok-parity MediaRecorder mime candidates, best first. */
export const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/mp4;codecs=mp4a.40.2',
]

/** Hard cap on a single dictation take (mirrors the Grok `voice-max-recording` policy). */
export const DICTATE_MAX_MS = 300_000
/** Sub-this recordings are silent idle taps — no transcription (Grok discards ~empty audio). */
export const DICTATE_MIN_MS = 500

export function initialDictateStatus(win: unknown = window): DictateStatus {
  const hasMediaRecorder = typeof win === 'object' && win !== null && typeof (win as { MediaRecorder?: unknown }).MediaRecorder === 'function'
  return hasMediaRecorder ? 'idle' : 'unavailable'
}

export function nextDictateStatus(
  current: DictateStatus,
  event: 'start' | 'stop' | 'transcribe' | 'deny' | 'error' | 'unavailable',
): DictateStatus {
  if (event === 'unavailable') return 'unavailable'
  if (event === 'deny') return 'denied'
  if (current === 'denied' || current === 'unavailable') return current
  if (event === 'start') return 'listening'
  if (event === 'transcribe' && current === 'listening') return 'processing'
  if (event === 'stop' || event === 'error') return 'idle'
  return current
}

/** Append a recognized chunk onto the composer draft. */
export function appendTranscript(draft: string, chunk: string): string {
  const add = chunk.replace(/\s+/g, ' ').trim()
  if (!add) return draft
  if (!draft.trim()) return add
  if (/\s$/.test(draft) || /^[,.!?;:]/.test(add)) return `${draft}${add}`
  return `${draft} ${add}`
}

/** Pick the first MediaRecorder-supported mime type, Grok's candidate order. */
export function pickAudioMimeType(
  candidates: readonly string[] = AUDIO_MIME_CANDIDATES,
  win: Window = window,
): string | null {
  const MR = typeof win !== 'undefined' ? (win as Window & { MediaRecorder?: typeof MediaRecorder }).MediaRecorder : undefined
  if (typeof MR !== 'function') return null
  for (const candidate of candidates) {
    try {
      if (MR.isTypeSupported(candidate)) return candidate
    } catch {
      /* unsupported type strings throw — skip */
    }
  }
  return null
}

/** The contract the composer drives. Two engines satisfy it:
 *  the Electron-local whisper recorder (DictateEngine below) and the
 *  platform speech recognizer used on phone/web shells (VoiceInputEngine in
 *  src/mobile/voice-input.ts). Keeping one shape lets ChatPanel swap engines
 *  without knowing which one it got. */
export interface DictateLike {
  getState(): { status: DictateStatus }
  start(): Promise<void>
  stop(): Promise<void>
  cancel(): void
}

export type TranscribeFn = (audio: Uint8Array, mimeType: string) => Promise<string>

export interface DictateEngineHooks {
  /** Status changes (listening/processing/denied/idle/unavailable). */
  onStatus?: (status: DictateStatus) => void
  /** A final transcript chunk (trimmed). Called once per take. */
  onFinal?: (text: string) => void
  /** Live EQ band levels (length = VOICE_BAND_COUNT) while recording. */
  onLevels?: (levels: number[]) => void
  /** Optional invocation log for tests/introspection. */
  onCaptureError?: (error: string) => void
}

type RecordingSession = {
  recorder: MediaRecorder
  stream: MediaStream
  chunks: Blob[]
  startedAtMs: number
  mimeType: string
  ceilingTimer: number
}

/**
 * Local microphone → whisper recorder. Fresh MediaRecorder per take; a used
 * recorder is never reused (mirrors the Grok recorder's per-session instances).
 */
export class DictateEngine {
  private status: DictateStatus = 'idle'
  private session: RecordingSession | null = null
  private meter: VoiceMeter | null = null
  private startRequestId = 0
  private readonly transcribe: TranscribeFn
  private readonly maxRecordingMs: number
  private readonly minAudioMs: number
  private readonly mimeTypes: readonly string[]
  private readonly hooks: DictateEngineHooks

  constructor(options: {
    transcribe: TranscribeFn
    maxRecordingMs?: number
    minAudioMs?: number
    mimeTypes?: readonly string[]
    hooks?: DictateEngineHooks
  }) {
    this.transcribe = options.transcribe ?? (() => Promise.reject(new Error('Local transcription is unavailable.')))
    this.maxRecordingMs = options.maxRecordingMs ?? DICTATE_MAX_MS
    this.minAudioMs = options.minAudioMs ?? DICTATE_MIN_MS
    this.mimeTypes = options.mimeTypes ?? AUDIO_MIME_CANDIDATES
    this.hooks = options.hooks ?? {}
  }

  getState(): { status: DictateStatus } {
    return { status: this.status }
  }

  private setStatus(next: DictateStatus) {
    this.status = next
    this.hooks.onStatus?.(next)
  }

  /** Ask for the mic and start recording. No-op unless idle/error. */
  async start(): Promise<void> {
    if (this.status !== 'idle' && this.status !== 'unavailable') {
      // Also allow start from 'denied' so a re-tap can re-ask for permission.
      if (this.status !== 'denied') return
    }
    if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      this.setStatus('unavailable')
      this.hooks.onCaptureError?.('mediaDevices unavailable')
      return
    }
    const mimeType = pickAudioMimeType(this.mimeTypes)
    if (!mimeType) {
      this.setStatus('unavailable')
      this.hooks.onCaptureError?.('no supported audio mime type')
      return
    }

    const requestId = ++this.startRequestId
    this.setStatus('listening')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS })
    } catch (err) {
      if (requestId !== this.startRequestId) return
      const name = err instanceof DOMException ? err.name : ''
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        this.setStatus('denied')
      } else {
        this.setStatus('idle')
      }
      this.hooks.onCaptureError?.(name || String(err))
      return
    }
    if (requestId !== this.startRequestId) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    this.startRecording(stream, mimeType)
  }

  private startRecording(stream: MediaStream, mimeType: string) {
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, { mimeType })
    } catch (err) {
      stream.getTracks().forEach((track) => track.stop())
      this.setStatus('idle')
      this.hooks.onCaptureError?.(`MediaRecorder unsupported: ${String(err)}`)
      return
    }

    const session: RecordingSession = {
      recorder,
      stream,
      chunks: [],
      startedAtMs: Date.now(),
      mimeType,
      ceilingTimer: 0,
    }
    this.session = session

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) session.chunks.push(ev.data)
    }
    recorder.onerror = () => {
      if (this.session !== session) return
      this.cleanupSession(session)
      this.setStatus('idle')
      this.hooks.onCaptureError?.('recording interrupted')
    }

    try {
      recorder.start(1000) // 1s timeslices — Grok-parity
      session.ceilingTimer = window.setTimeout(() => {
        if (this.session === session) void this.stop()
      }, this.maxRecordingMs)
    } catch (err) {
      this.cleanupSession(session)
      this.setStatus('idle')
      this.hooks.onCaptureError?.(`recorder start failed: ${String(err)}`)
      return
    }
    // Status is already 'listening' from start(); keep it.
    // Live mic level → voice-chip bars (best-effort; falls back to quiet bars).
    try {
      this.meter = createVoiceMeter(stream, (levels) => this.hooks.onLevels?.(levels))
    } catch {
      this.meter = null
    }
  }

  /** Stop recording and transcribe the take locally. Safe to call when idle. */
  async stop(): Promise<void> {
    if (this.status === 'unavailable' || this.status === 'denied') {
      this.setStatus('idle')
      return
    }
    if (this.status === 'processing') return
    const session = this.session
    if (!session) {
      // Might still be requesting permission in start(); let start() settle.
      this.startRequestId += 1
      this.setStatus('idle')
      return
    }
    return this.completeTake(session)
  }

  /** Abort everything (unmount / cancel). No transcription. */
  cancel() {
    this.startRequestId += 1
    if (this.session) {
      this.cleanupSession(this.session)
      this.session = null
    }
    this.setStatus('idle')
  }

  private async completeTake(session: RecordingSession) {
    const elapsed = Date.now() - session.startedAtMs
    if (elapsed < this.minAudioMs) {
      // Silent tap — discard without a transcript (Grok drops ~empty audio).
      this.cleanupSession(session)
      this.session = null
      this.setStatus('idle')
      return
    }

    this.setStatus('processing')
    await new Promise<void>((resolve) => {
      if (session.recorder.state === 'inactive') {
        resolve()
        return
      }
      session.recorder.onstop = () => resolve()
      try {
        session.recorder.stop()
      } catch {
        resolve()
      }
    })

    const blob = this.blobFromChunks(session.chunks, session.mimeType)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    this.cleanupSession(session)
    this.session = null

    if (bytes.length === 0 || this.status !== 'processing') {
      this.setStatus('idle')
      return
    }
    try {
      const text = await this.transcribe(bytes, session.mimeType)
      if (this.status !== 'processing') return
      const trimmed = text.replace(/\s+/g, ' ').trim()
      if (trimmed) this.hooks.onFinal?.(trimmed)
    } catch {
      /* recoverable — return to the compose bar */
    } finally {
      if (this.status === 'processing') this.setStatus('idle')
    }
  }

  private blobFromChunks(chunks: Blob[], mimeType: string): Blob {
    // Opus/webm chunks are recorded in 1s slices; concatenating them produces
    // a container with multiple clusters, which ffmpeg remuxes fine.
    return chunks.length > 0 ? new Blob(chunks, { type: mimeType }) : new Blob([], { type: mimeType })
  }

  private cleanupSession(session: RecordingSession) {
    window.clearTimeout(session.ceilingTimer)
    this.meter?.stop()
    this.meter = null
    if (session.recorder.state !== 'inactive') {
      try {
        session.recorder.stop()
      } catch {
        /* already stopped */
      }
    }
    session.stream.getTracks().forEach((track) => track.stop())
  }
}