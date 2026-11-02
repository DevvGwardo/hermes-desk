import { afterEach, describe, expect, it, vi } from 'vitest'
import { shouldUseNubChatBridge, streamChatCompletion } from '../hermes-stream'

describe('shouldUseNubChatBridge', () => {
  afterEach(() => {
    delete window.nubAgent
  })

  it('is false without the desktop bridge', () => {
    expect(shouldUseNubChatBridge('https://agent.example.maiavm.com')).toBe(false)
  })

  it('is false for loopback even with the bridge', () => {
    window.nubAgent = { nubChatStream: vi.fn() } as unknown as Window['nubAgent']
    expect(shouldUseNubChatBridge('http://127.0.0.1:9119')).toBe(false)
    expect(shouldUseNubChatBridge('http://localhost:8080')).toBe(false)
  })

  it('is true for a remote Nub VM when the bridge exists', () => {
    window.nubAgent = { nubChatStream: vi.fn() } as unknown as Window['nubAgent']
    expect(shouldUseNubChatBridge('https://agent-abc.maiavm.com')).toBe(true)
  })
})

describe('streamChatCompletion nub bridge', () => {
  afterEach(() => {
    delete window.nubAgent
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('uses nubChatStream instead of fetch for remote URLs', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const nubChatStream = vi.fn(async (_opts, onEvent) => {
      onEvent?.({ type: 'delta', text: 'from vm' })
      return { ok: true, content: 'from vm' }
    })
    window.nubAgent = { nubChatStream } as unknown as Window['nubAgent']

    const deltas: string[] = []
    const result = await streamChatCompletion(
      'https://agent-abc.maiavm.com',
      { message: 'hey there', token: 'gw' },
      { onDelta: (t) => deltas.push(t) },
    )

    expect(nubChatStream).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(deltas).toEqual(['from vm'])
    expect(result).toMatchObject({ ok: true, content: 'from vm' })
  })

  it('times out a hung nubChatStream so send cannot hang forever', async () => {
    vi.useFakeTimers()
    const nubChatStream = vi.fn((_opts: { requestId?: string }) => new Promise(() => {}))
    const nubChatAbort = vi.fn(async () => ({ ok: true, aborted: 1 }))
    window.nubAgent = { nubChatStream, nubChatAbort } as unknown as Window['nubAgent']

    const pending = streamChatCompletion(
      'https://agent-abc.maiavm.com',
      { message: 'hey there', timeoutMs: 1_000 },
      { onDelta: () => {} },
    )
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending

    expect(result.ok).toBe(false)
    expect(result.error).toBe('no first token')
    expect(nubChatAbort).toHaveBeenCalled()
    const requestId = nubChatStream.mock.calls[0]?.[0]?.requestId
    expect(typeof requestId).toBe('string')
    expect(nubChatAbort).toHaveBeenCalledWith(requestId)
  })

  it('idle budget: keeps a turn alive while deltas keep flowing past timeoutMs', async () => {
    vi.useFakeTimers()
    let onEvent: ((ev: { type: string; text?: string }) => void) | undefined
    let resolveStream: (r: { ok: boolean; content: string }) => void = () => {}
    const nubChatStream = vi.fn((_opts, cb: typeof onEvent) => {
      onEvent = cb
      return new Promise((resolve) => {
        resolveStream = resolve
      })
    })
    const nubChatAbort = vi.fn(async () => ({ ok: true, aborted: 1 }))
    window.nubAgent = { nubChatStream, nubChatAbort } as unknown as Window['nubAgent']

    const deltas: string[] = []
    const pending = streamChatCompletion(
      'https://agent-abc.maiavm.com',
      { message: 'long job', timeoutMs: 1_000 },
      { onDelta: (t) => deltas.push(t) },
    )
    // Stream a token every 500ms for 6s — 12x past the 1s idle budget.
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(500)
      onEvent?.({ type: 'delta', text: `tok${i} ` })
    }
    expect(deltas.length).toBe(12)
    expect(nubChatAbort).not.toHaveBeenCalled()
    // Then go silent — the idle budget must now fire.
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.error).toBe('stream timed out')
    resolveStream({ ok: true, content: '' })
  })

  it('drops late deltas after the nub bridge times out', async () => {
    vi.useFakeTimers()
    let onEvent: ((ev: { type: string; text?: string }) => void) | undefined
    const nubChatStream = vi.fn((_opts, cb: typeof onEvent) => {
      onEvent = cb
      return new Promise(() => {})
    })
    window.nubAgent = { nubChatStream } as unknown as Window['nubAgent']

    const deltas: string[] = []
    const pending = streamChatCompletion(
      'https://agent-abc.maiavm.com',
      { message: 'hey there', timeoutMs: 1_000 },
      { onDelta: (t) => deltas.push(t) },
    )
    onEvent?.({ type: 'delta', text: 'partial' })
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending
    onEvent?.({ type: 'delta', text: 'late' })

    expect(result).toMatchObject({ ok: false, content: 'partial', error: 'stream timed out' })
    expect(deltas).toEqual(['partial'])
  })
})
