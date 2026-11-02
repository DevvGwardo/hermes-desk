import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sttBridgeAvailable, sttStatus, transcribeAudio } from '../stt'

type Bridge = Window['nubAgent']

function installBridge(bridge: Bridge | null) {
  Object.defineProperty(window, 'nubAgent', {
    configurable: true,
    value: bridge,
  })
}

beforeEach(() => {
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
})

describe('stt bridge', () => {
  it('detects the Electron preload bridge', () => {
    installBridge({ sttTranscribe: vi.fn() } as unknown as Bridge)
    expect(sttBridgeAvailable()).toBe(true)
  })

  it('reports unavailable when the bridge is absent (plain browser)', () => {
    installBridge(null)
    expect(sttBridgeAvailable()).toBe(false)
    expect(sttBridgeAvailable(window)).toBe(false)
  })

  it('probes main-process model status', async () => {
    installBridge({
      sttStatus: vi.fn().mockResolvedValue({ ok: true, model: 'ggml-small.en.bin' }),
    } as unknown as Bridge)
    const status = await sttStatus()
    expect(status.ok).toBe(true)
    expect(status.model).toBe('ggml-small.en.bin')
  })

  it('surfaces a failed status probe', async () => {
    installBridge({
      sttStatus: vi.fn().mockResolvedValue({ ok: false, error: 'no local whisper model' }),
    } as unknown as Bridge)
    const status = await sttStatus()
    expect(status.ok).toBe(false)
    expect(status.error).toContain('no local whisper model')
  })

  it('passes mic bytes + mimeType and returns the transcript', async () => {
    const transcribe = vi.fn().mockResolvedValue({ ok: true, text: 'ship the cube', model: 'x' })
    installBridge({ sttTranscribe: transcribe } as unknown as Bridge)
    const bytes = new Uint8Array([1, 2, 3])
    const text = await transcribeAudio(bytes, 'audio/webm')
    expect(text).toBe('ship the cube')
    expect(transcribe).toHaveBeenCalledWith(bytes, 'audio/webm')
  })

  it('throws when the main process fails', async () => {
    installBridge({
      sttTranscribe: vi.fn().mockResolvedValue({ ok: false, error: 'whisper exit 1' }),
    } as unknown as Bridge)
    await expect(transcribeAudio(new Uint8Array([1]), 'audio/webm')).rejects.toThrow('whisper exit 1')
  })

  it('throws when there is no bridge to call', async () => {
    installBridge(null)
    await expect(transcribeAudio(new Uint8Array([1]), 'audio/webm')).rejects.toThrow(/unavailable/)
  })
})