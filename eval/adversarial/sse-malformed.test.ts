/**
 * Adversarial SSE tests — feed the app's REAL stream parser hostile
 * chunk sequences and assert it degrades to recoverable states instead
 * of throwing or corrupting valid data.
 *
 * Module under attack:
 *   - src/lib/hermes-stream.ts  (local hermes OpenAI-compatible SSE)
 *
 * The deploy-gateway parser this file once also covered
 * (src/lib/agents/deploy-stream.ts) was removed with the local-only
 * product. Its cases are deleted rather than faked — the local
 * OpenAI-compatible parser below is the app's real SSE surface.
 *
 * Error conventions observed in the module (tests match them):
 *   - hermes-stream: malformed JSON frames are skipped silently; reader
 *     errors surface via cb.onError AND a `{ok:false,error}` result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamChatCompletion } from '../../src/lib/hermes-stream'

const VM_URL = 'https://vm-adversarial.example.maiavm.com'

function deltaFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`
}

describe('hermes-stream streamChatCompletion hostile sequences', () => {
  beforeEach(() => {
    // Force the fetch path: no desktop bridge installed.
    delete (window as unknown as { nubAgent?: unknown }).nubAgent
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(chunks: string[]): void {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c))
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        body,
      })),
    )
  }

  function stubFailingFetch(err: Error): void {
    const encoder = new TextEncoder()
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      // Error asynchronously (from pull) — a synchronous error() in start()
      // would discard already-enqueued chunks per the streams spec.
      pull(controller) {
        pulls += 1
        if (pulls === 1) {
          controller.enqueue(encoder.encode(`${deltaFrame('partial')}\n\n`))
          return
        }
        controller.error(err)
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        body,
      })),
    )
  }

  async function run(opts?: {
    chunks?: string[]
    failWith?: Error
  }): Promise<{
    result: Awaited<ReturnType<typeof streamChatCompletion>>
    deltas: string[]
    errors: Error[]
  }> {
    if (opts?.failWith) stubFailingFetch(opts.failWith)
    else stubFetch(opts?.chunks ?? [])
    const deltas: string[] = []
    const errors: Error[] = []
    const result = await streamChatCompletion(
      VM_URL,
      { message: 'ping' },
      {
        onDelta: (t) => deltas.push(t),
        onError: (e) => errors.push(e),
      },
    )
    return { result, deltas, errors }
  }

  it('keeps valid events around an invalid JSON frame split across chunk boundaries', async () => {
    // One corrupted frame (unquoted JSON string literal) deliberately cut
    // mid-token across two reads.
    const { result, deltas, errors } = await run({
      chunks: [
        `${deltaFrame('Hel')}\n\ndata: {"choices":[{"delta":{"con`,
        'tent":BROKEN}}]}\n\n',
        `${deltaFrame('lo')}\n\ndata: [DONE]\n\n`,
      ],
    })
    expect(deltas.join('')).toBe('Hello')
    expect(result.ok).toBe(true)
    expect(errors).toEqual([])
  })

  it('streams a ~5MB single-token delta within time budget', async () => {
    const big = 'y'.repeat(5_000_000)
    const t0 = performance.now()
    const { result, deltas } = await run({ chunks: [`${deltaFrame(big)}\n\ndata: [DONE]\n\n`] })
    const ms = performance.now() - t0
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toHaveLength(5_000_000)
    expect(result.ok).toBe(true)
    expect(result.content).toHaveLength(5_000_000)
    expect(ms).toBeLessThan(5_000)
  })

  it('delivers every token on mixed LF/CRLF framing (LF boundaries)', async () => {
    const { deltas } = await run({
      chunks: [`${deltaFrame('one')}\r\n\n${deltaFrame('two')}\r\n\ndata: [DONE]\n\n`],
    })
    expect(deltas.join('')).toBe('onetwo')
  })

  it('delivers every token on pure-CRLF framing (spec-compliant server)', async () => {
    const { result, deltas } = await run({
      chunks: [`${deltaFrame('A')}\r\n\r\n${deltaFrame('B')}\r\n\r\ndata: [DONE]\r\n\r\n`],
    })
    expect(deltas.join('')).toBe('AB')
    expect(result.ok).toBe(true)
  })

  it('ignores id:/retry: lines on the OpenAI path and still parses the payload', async () => {
    const { deltas } = await run({
      chunks: [`id: 42\nretry: ${'9'.repeat(64)}\n${deltaFrame('z')}\n\ndata: [DONE]\n\n`],
    })
    expect(deltas.join('')).toBe('z')
  })

  it('premature end mid-frame keeps prior tokens, reports ok via alive-content convention', async () => {
    const { result, deltas, errors } = await run({
      chunks: [`${deltaFrame('safe')}\n\ndata: {"choices":[{"d`],
    })
    expect(deltas.join('')).toBe('safe')
    expect(errors).toEqual([]) // silent-close convention: no onError for parse loss
    expect(result.ok).toBe(true)
    expect(result.content).toBe('safe')
  })

  it('reader crash mid-stream fires cb.onError and returns ok:false recoverable result', async () => {
    const { result, deltas, errors } = await run({
      failWith: new Error('ECONNRESET mid-stream'),
    })
    expect(deltas.join('')).toBe('partial')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('ECONNRESET')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ECONNRESET')
    expect(result.content).toBe('partial')
  })
})
