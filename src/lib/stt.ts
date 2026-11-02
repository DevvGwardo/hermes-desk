/**
 * Renderer-side local STT bridge. Talks to the Electron main process
 * (which runs whisper.cpp) via the preload `nubAgent` API. In a plain browser
 * (vite dev without Electron) the bridge is absent → dictate is unavailable.
 */

export interface SttStatus {
  ok: boolean
  model?: string
  error?: string
}

export interface SttTranscribeResult {
  ok: boolean
  text?: string
  error?: string
}

/** True when the Electron preload exposed the local STT bridge. */
export function sttBridgeAvailable(win: Window = window): boolean {
  const bridge = win.nubAgent
  return Boolean(bridge && typeof bridge.sttTranscribe === 'function')
}

/** Probe the main process for a usable whisper model (once-ish at mount). */
export async function sttStatus(win: Window = window): Promise<SttStatus> {
  const bridge = win.nubAgent
  if (!bridge || typeof bridge.sttStatus !== 'function') {
    return { ok: false, error: 'stt unavailable' }
  }
  try {
    const res = await bridge.sttStatus()
    return {
      ok: Boolean(res && res.ok),
      model: res?.model,
      error: res?.error,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Send recorded mic bytes to the main process for local whisper transcription.
 * Throws on failure so the caller can recover to the compose bar.
 */
export async function transcribeAudio(
  audio: Uint8Array,
  mimeType: string,
  win: Window = window,
): Promise<string> {
  const bridge = win.nubAgent
  if (!bridge || typeof bridge.sttTranscribe !== 'function') {
    throw new Error('Local transcription is unavailable.')
  }
  const res: SttTranscribeResult = await bridge.sttTranscribe(audio, mimeType)
  if (!res || !res.ok) {
    throw new Error(res?.error || 'Local transcription failed.')
  }
  return res.text ?? ''
}