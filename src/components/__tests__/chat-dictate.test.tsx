import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import { ThreadPane } from '../ThreadPane'
import { DICTATE_DENIED_COPY } from '../../lib/dictate'
import type { ChatMessage } from '../../lib/agents'

let transcribeMock: ReturnType<typeof vi.fn>
let getUserMediaMock: ReturnType<typeof vi.fn>
let lastRecorder: FakeRecorder | null = null

type FakeRecorder = {
  state: 'inactive' | 'recording'
  timeslice: number
  options: { mimeType?: string }
  stop: () => void
  emitDataAndStop: () => void
}

/** Local-stt harness: the Electron bridge (preload) + capture (MediaRecorder). */
function installStt(overrides: { sttOk?: boolean; denyMic?: boolean } = {}) {
  const { sttOk = true, denyMic = false } = overrides
  lastRecorder = null
  transcribeMock = vi.fn().mockResolvedValue({ ok: true, text: 'ship the cube', model: 'ggml-x' })
  getUserMediaMock = vi.fn()

  class FakeMediaRecorder {
    static isTypeSupported = (type: string) => type.startsWith('audio/')
    state: 'inactive' | 'recording' = 'inactive'
    ondataavailable: ((ev: BlobEvent) => void) | null = null
    onstop: (() => void) | null = null
    timeslice = 0
    options: { mimeType?: string }
    constructor(_stream: MediaStream, options: { mimeType?: string } = {}) {
      this.options = options
      lastRecorder = {
        state: 'inactive',
        timeslice: 0,
        options,
        stop: () => this.stop(),
        emitDataAndStop: () => this.stop(),
      }
    }
    start(timeslice?: number) {
      this.timeslice = timeslice ?? 0
      this.state = 'recording'
      if (lastRecorder) {
        lastRecorder.state = this.state
        lastRecorder.timeslice = this.timeslice
      }
    }
    stop() {
      if (this.state !== 'recording') return
      this.state = 'inactive'
      if (lastRecorder) lastRecorder.state = this.state
      const blob = new Blob([new Uint8Array([1, 2, 3])], { type: this.options?.mimeType ?? 'audio/webm' })
      this.ondataavailable?.({ data: blob } as BlobEvent)
      this.onstop?.()
    }
  }
  ;(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder
  ;(window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder

  if (denyMic) {
    getUserMediaMock.mockRejectedValue(new DOMException('permission', 'NotAllowedError'))
  } else {
    getUserMediaMock.mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream)
  }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: getUserMediaMock },
  })

  Object.defineProperty(window, 'nubAgent', {
    configurable: true,
    value: {
      sttStatus: vi.fn().mockResolvedValue(
        sttOk ? { ok: true, model: 'ggml-x' } : { ok: false, error: 'no model' },
      ),
      sttTranscribe: transcribeMock,
    },
  })
}

/** Flush pending microtasks + the mount effect's sttStatus probe. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  cleanup()
  lastRecorder = null
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
  delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder
  delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices
})

afterEach(() => {
  vi.useRealTimers()
})

const messages: ChatMessage[] = [
  {
    id: 'u1',
    threadId: 't1',
    role: 'user',
    content: 'hi',
    createdAt: '2026-08-14T00:00:00Z',
  },
]

const micButton = () => screen.getByRole('button', { name: 'Click or hold to dictate' })
const stopChip = () => screen.getByRole('button', { name: 'Stop dictation' })

describe('ChatPanel dictate — local whisper', () => {
  it('shows the mic when the local STT bridge + model are available', async () => {
    installStt()
    render(<ChatPanel skin="classic" messages={messages} threadKey="t1" onSend={() => {}} />)
    await settle()
    expect(micButton()).toBeTruthy()
  })

  it('hides the mic when the Electron bridge is missing (plain browser)', async () => {
    installStt()
    delete (window as unknown as { nubAgent?: unknown }).nubAgent
    render(<ChatPanel skin="classic" messages={messages} threadKey="t1" onSend={() => {}} />)
    await settle()
    expect(screen.queryByRole('button', { name: 'Click or hold to dictate' })).toBeNull()
  })

  it('hides the mic when the machine has no whisper model', async () => {
    installStt({ sttOk: false })
    render(<ChatPanel skin="classic" messages={messages} threadKey="t1" onSend={() => {}} />)
    await settle()
    expect(screen.queryByRole('button', { name: 'Click or hold to dictate' })).toBeNull()
  })

  it('records locally (getUserMedia → MediaRecorder) and commits the transcript', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    installStt()
    const onSend = vi.fn()
    render(<ChatPanel skin="classic" messages={messages} threadKey="t1" onSend={onSend} />)
    await settle()

    fireEvent.pointerDown(micButton())
    fireEvent.pointerUp(micButton())
    // Wrapped in act so the async getUserMedia → MediaRecorder start settles.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getUserMediaMock).toHaveBeenCalledTimes(1)
    expect(lastRecorder?.state).toBe('recording')
    expect(lastRecorder?.timeslice).toBe(1000)
    expect(stopChip()).toBeTruthy()

    // A >500ms take → release → local transcription → commit into the draft
    await act(async () => {
      vi.advanceTimersByTime(700)
    })
    await act(async () => {
      fireEvent.click(stopChip())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(transcribeMock).toHaveBeenCalledTimes(1)
    const box = screen.getByPlaceholderText('Message the agent…') as HTMLTextAreaElement
    expect(box.value).toBe('ship the cube')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend.mock.calls[0]?.[0]).toBe('ship the cube')
  })

  it('shows Transcribing… while the local engine works, then returns to the mic', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    installStt()
    let releaseTranscribe!: (res: { ok: boolean; text: string }) => void
    transcribeMock.mockImplementation(
      () => new Promise((resolve) => (releaseTranscribe = (res) => resolve(res))),
    )
    render(<ChatPanel skin="classic" messages={messages} threadKey="t1" onSend={() => {}} />)
    await settle()

    fireEvent.pointerDown(micButton())
    fireEvent.pointerUp(micButton())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(700)
    })
    await act(async () => {
      fireEvent.click(stopChip())
      await Promise.resolve()
    })
    expect(screen.getByText('Transcribing…')).toBeTruthy()

    await act(async () => {
      releaseTranscribe({ ok: true, text: 'done' })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(micButton()).toBeTruthy()
  })

  it('a sub-500ms tap discards silently — no transcript, no error state', async () => {
    installStt()
    render(<ChatPanel skin="classic" messages={messages} threadKey="t1" onSend={() => {}} />)
    await settle()
    fireEvent.pointerDown(micButton())
    fireEvent.pointerUp(micButton())
    await act(async () => {
      await Promise.resolve()
      fireEvent.click(stopChip())
      await Promise.resolve()
    })
    // Recorder started then stopped again almost instantly → dropped as a tap.
    expect(transcribeMock).not.toHaveBeenCalled()
    const box = screen.getByPlaceholderText('Message the agent…') as HTMLTextAreaElement
    expect(box.value).toBe('')
    expect(micButton()).toBeTruthy()
  })

  it('shows denied copy when mic permission is refused', async () => {
    installStt({ denyMic: true })
    render(<ChatPanel skin="classic" messages={messages} threadKey="t1" onSend={() => {}} />)
    await settle()
    fireEvent.pointerUp(micButton())
    await settle()
    expect(screen.getByText(DICTATE_DENIED_COPY)).toBeTruthy()
  })

  it('replaces the mic with an in-bar stop chip (no status line below the composer)', async () => {
    installStt()
    const { container } = render(
      <ChatPanel skin="classic" messages={messages} threadKey="t1" onSend={() => {}} />,
    )
    await settle()
    expect(container.querySelector('form p')).toBeNull()

    fireEvent.pointerDown(micButton())
    fireEvent.pointerUp(micButton())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByRole('button', { name: 'Click or hold to dictate' })).toBeNull()
    const chip = stopChip()
    expect(chip.textContent).toContain('Listening…')
    expect(screen.getByRole('status')).toBeTruthy()
    expect(container.querySelector('.ca-voice-bars')).toBeTruthy()
    expect(container.querySelector('form p')).toBeNull()

    fireEvent.click(chip)
    expect(micButton()).toBeTruthy()
  })

  it('keeps the bar order textarea → mic → send', async () => {
    installStt()
    const { container } = render(
      <ChatPanel skin="classic" messages={messages} threadKey="t1" onSend={() => {}} />,
    )
    await settle()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()

    const box = screen.getByPlaceholderText('Message the agent…') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'hi' } })
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeTruthy()

    const bar = container.querySelector('.nub-glass') as HTMLElement
    expect(bar).toBeTruthy()
    const kids = Array.from(bar.children)
    expect(kids.map((k) => k.tagName).join(',')).toBe('TEXTAREA,BUTTON,BUTTON')
    expect(kids[kids.length - 1]).toBe(send)
  })
})

describe('messenger composer — existing local STT path', () => {
  it('holds the mic to dictate and transcribes without replacing the stable Send control', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_000_000)
    installStt()
    const onSend = vi.fn()
    render(<ChatPanel messages={messages} threadKey="t1" onSend={onSend} />)
    await settle()
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toHaveProperty('disabled', true)
    fireEvent.pointerDown(micButton(), { button: 0, pointerId: 1 })
    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(lastRecorder?.state).toBe('recording')
    expect(stopChip()).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(700)
      fireEvent.pointerUp(stopChip(), { pointerId: 1 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(transcribeMock).toHaveBeenCalledOnce()
    expect((screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement).value).toBe('ship the cube')
    expect(screen.getByRole('button', { name: 'Click or hold to dictate' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' })).toBe(send)
    expect(send).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledWith('ship the cube', undefined)
  })

  it('retains mic permission-denied feedback in the messenger composer', async () => {
    installStt({ denyMic: true })
    render(<ChatPanel messages={messages} threadKey="t1" onSend={vi.fn()} />)
    await settle()
    fireEvent.click(micButton(), { detail: 0 })
    await settle()
    expect(screen.getByText(DICTATE_DENIED_COPY)).toBeTruthy()
  })

  it('uses the same local transcription path for a thread reply', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(4_000_000)
    installStt()
    const onSend = vi.fn()
    render(<ThreadPane open onClose={vi.fn()} messages={messages} width={1000} onSend={onSend} title="Thread" />)
    await settle()
    fireEvent.pointerDown(micButton(), { button: 0, pointerId: 1 })
    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(700)
      fireEvent.pointerUp(stopChip(), { pointerId: 1 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(transcribeMock).toHaveBeenCalledOnce()
    expect((screen.getByRole('textbox', { name: 'Reply in thread' }) as HTMLTextAreaElement).value).toBe('ship the cube')
    fireEvent.click(screen.getByRole('button', { name: 'Send thread reply' }))
    expect(onSend).toHaveBeenCalledWith('ship the cube', { replyTo: expect.objectContaining({ id: 'u1', thread: true }) })
  })

  it('cancels a held recording when changing conversations', async () => {
    vi.useFakeTimers()
    installStt()
    const { rerender } = render(<ChatPanel messages={messages} threadKey="t1" onSend={vi.fn()} />)
    await settle()
    fireEvent.pointerDown(micButton(), { button: 0, pointerId: 1 })
    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(lastRecorder?.state).toBe('recording')
    rerender(<ChatPanel messages={[]} threadKey="other-chat" onSend={vi.fn()} />)
    expect(lastRecorder?.state).toBe('inactive')
    expect(transcribeMock).not.toHaveBeenCalled()
    expect((screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement).value).toBe('')
  })
})