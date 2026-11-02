/**
 * Streaming chat client for the local hermes-agent api_server
 * (OpenAI Chat Completions SSE — verified against
 * ~/.hermes/hermes-agent/gateway/platforms/api_server.py).
 *
 * Protocol (confirmed from source):
 *   - POST /v1/chat/completions with `stream: true`
 *   - SSE `data:` frames: {choices:[{delta:{content}}]} — text chunks
 *   - Custom `event: hermes.tool.progress` frames with
 *     {tool, emoji, label, toolCallId, status: running|completed}
 *   - Final chunk: {choices:[{delta:{}, finish_reason}]} then `data: [DONE]`
 *   - Response header `X-Hermes-Session-Id` — send it back on later messages
 *     to CONTINUE the same hermes session (conversation continuity, Grok parity).
 *
 * Remote Nub VMs are fetched from the Electron main process
 * (`nubChatStream`) because the VM CORS allowlist is the dashboard origin,
 * not the desktop renderer.
 */

import { isLocalHermesServeUrl } from './maiavm-api'
import { newChatRequestId } from './request-id'

export interface ToolProgressEvent {
  tool: string
  emoji?: string
  label?: string
  toolCallId?: string
  status: 'running' | 'completed'
}

export function upsertToolProgress(
  events: ToolProgressEvent[],
  next: ToolProgressEvent,
): ToolProgressEvent[] {
  const idx = next.toolCallId
    ? events.findIndex((t) => t.toolCallId === next.toolCallId)
    : events.findIndex((t) => t.tool === next.tool && t.status === 'running')
  if (idx >= 0) {
    const copy = events.slice()
    copy[idx] = { ...copy[idx], ...next }
    return copy
  }
  return [...events, next]
}

export interface StreamCallbacks {
  /** Fired once per text delta chunk (may be empty for tool-only frames). */
  onDelta: (text: string) => void
  /** Fired for each hermes.tool.progress event (tool call started/completed). */
  onTool?: (ev: ToolProgressEvent) => void
  /** Fired for SSE `subagent.start` / `subagent.complete` frames. */
  onSubagent?: (ev: { type: string; payload: Record<string, unknown> }) => void
  /**
   * Fired for SSE `browser.*` frames (plan step 2: `browser.progress`
   * {jobId, status, url?, screenshotRef?}). Fetch-SSE path only — the
   * Electron bridge object events have no browser wire shape, so nothing
   * is forwarded there rather than inventing one.
   */
  onBrowser?: (ev: { type: string; payload: Record<string, unknown> }) => void
  /** Fired on the final finish chunk (before [DONE]). */
  onFinish?: (finishReason: string, usage?: Record<string, number>) => void
  /** Fired on any network/parse error mid-stream. */
  onError?: (err: Error) => void
}

export interface StreamResult {
  ok: boolean
  content: string
  finishReason?: string
  /** hermes session id returned by the api_server — persist it on the
   *  conversation and send back as X-Hermes-Session-Id on the next message. */
  sessionId?: string
  error?: string
  toolEvents: ToolProgressEvent[]
}

export const DEFAULT_TIMEOUT_MS = 120_000
/** Headers-only SSE with no frame. Fail before the full-turn budget. */
export const FIRST_TOKEN_MS = 30_000
/** Wall-clock ceiling for a fetch-path turn: the idle budget (kick) owns
 *  liveness; this only caps a pathological stream at 10 minutes. */
export const STREAM_WALL_CLOCK_MAX_MS = 10 * 60_000

function abortError(message = 'stream timed out'): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

function isAbortError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError')
}

/**
 * Idle-budget variant: reject only after `idleMs` with NO progress. `kick()`
 * re-arms the deadline whenever the stream shows life (a token, a tool
 * event). Long tool-running turns are never killed mid-flight by a wall
 * clock; genuinely hung ones still fail.
 */
function raceIdle<T>(
  promise: Promise<T>,
  idleMs: number,
  signal?: AbortSignal,
): { result: Promise<T>; kick: () => void } {
  let timer = 0
  let rejectFn: (err: Error) => void = () => {}
  const arm = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => rejectFn(abortError()), idleMs)
  }
  const result = new Promise<T>((resolve, reject) => {
    rejectFn = reject
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        window.clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
  arm()
  return { result, kick: arm }
}

/** True when chat must go through Electron main (remote Nub VM, CORS). */
export function shouldUseNubChatBridge(baseUrl: string): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.nubAgent?.nubChatStream !== 'function') return false
  return !isLocalHermesServeUrl(baseUrl)
}

async function streamViaNubBridge(
  opts: {
    message: string
    history?: { role: 'user' | 'assistant'; content: string }[]
    sessionId?: string
    signal?: AbortSignal
    timeoutMs?: number
  },
  cb: StreamCallbacks,
): Promise<StreamResult> {
  const toolEvents: ToolProgressEvent[] = []
  let content = ''
  let sessionId = opts.sessionId
  let settled = false
  let sawBody = false
  const requestId = newChatRequestId()
  const firstTokenMs = Math.min(FIRST_TOKEN_MS, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const firstTokenTimer = window.setTimeout(() => {
    if (!sawBody && !settled) void window.nubAgent?.nubChatAbort?.(requestId)
  }, firstTokenMs)
  try {
    const idleHolder: { kick: () => void } = { kick: () => {} }
    // Idle budget, not a wall clock: every delta/tool/subagent event re-arms
    // the deadline, so a turn that is actively working (long tool runs) is
    // never killed at timeoutMs — only a genuinely silent stream is.
    const streamPromise = window.nubAgent!.nubChatStream!(
      {
        message: opts.message,
        history: opts.history,
        sessionId: opts.sessionId,
        requestId,
      },
      (ev) => {
        if (settled) return
        if (ev.type === 'delta' && ev.text) {
          sawBody = true
          idleHolder.kick()
          content += ev.text
          cb.onDelta(ev.text)
        } else if (ev.type === 'tool' && ev.tool && (ev.status === 'running' || ev.status === 'completed')) {
          sawBody = true
          idleHolder.kick()
          const next: ToolProgressEvent = {
            tool: ev.tool,
            status: ev.status,
            ...(ev.emoji ? { emoji: ev.emoji } : {}),
            ...(ev.label ? { label: ev.label } : {}),
            ...(ev.toolCallId ? { toolCallId: ev.toolCallId } : {}),
          }
          const merged = upsertToolProgress(toolEvents, next)
          toolEvents.length = 0
          toolEvents.push(...merged)
          cb.onTool?.(next)
        } else if (ev.type === 'subagent') {
          sawBody = true
          idleHolder.kick()
          cb.onSubagent?.({
            type: ev.event || 'subagent',
            payload: ev.payload ?? {},
          })
        } else if (ev.type === 'session' && ev.sessionId) {
          sessionId = ev.sessionId
        }
      },
    )
    const idle = raceIdle(
      streamPromise,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      opts.signal,
    )
    // Events can fire synchronously during nubChatStream's own setup, before
    // this line runs — route early kicks through a safe no-op until wired.
    idleHolder.kick = idle.kick
    const result = await idle.result
    settled = true
    window.clearTimeout(firstTokenTimer)
    const finalContent = result.content.trim() ? result.content : content
    const silent = !sawBody && !finalContent.trim()
    const error =
      !result.ok && silent && /timed out|empty stream/i.test(result.error || '')
        ? 'no first token'
        : result.error
    if (!result.ok) {
      cb.onError?.(new Error(error || 'nub chat failed'))
    } else {
      cb.onFinish?.('stop')
    }
    return {
      ok: result.ok,
      content: finalContent,
      sessionId: result.sessionId ?? sessionId,
      error,
      toolEvents,
    }
  } catch (err) {
    settled = true
    window.clearTimeout(firstTokenTimer)
    void window.nubAgent?.nubChatAbort?.(requestId)
    const silent = !sawBody && !content.trim()
    const error = isAbortError(err)
      ? silent
        ? 'no first token'
        : 'stream timed out'
      : String((err as Error)?.message ?? err)
    cb.onError?.(new Error(error))
    return {
      ok: false,
      content,
      error,
      toolEvents,
    }
  }
}

/** Streaming POST to an OpenAI-compatible /v1/chat/completions endpoint. */
export async function streamChatCompletion(
  baseUrl: string,
  opts: {
    message: string
    /** History to send (system/user/assistant turns before this message). */
    history?: { role: 'user' | 'assistant'; content: string }[]
    /** hermes session id from a previous turn — enables continuity. */
    sessionId?: string
    model?: string
    /** Bearer token for the VM api_server (Nub link / operator). */
    token?: string
    signal?: AbortSignal
    timeoutMs?: number
  },
  cb: StreamCallbacks,
): Promise<StreamResult> {
  if (shouldUseNubChatBridge(baseUrl)) {
    return streamViaNubBridge(opts, cb)
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
  // Virtual name on the VM api_server. The VM spends Maia's hermes_pk_
  // key on the bundled metered model — never a client-picked model.
  const model = opts.model ?? 'hermes'
  const messages = [
    ...(opts.history ?? []),
    { role: 'user', content: opts.message },
  ]

  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const abortRead = () => {
    controller.abort()
    void reader?.cancel().catch(() => {})
  }
  // Idle budget, not a wall clock (bridge parity): every frame/tool event
  // re-arms the deadline via kick(), so a turn that is actively working is
  // never killed mid-flight — only a genuinely silent stream fails. The
  // wall clock is only a 10-minute ceiling for pathological streams.
  const idleMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let idleTimer = 0
  const kick = () => {
    window.clearTimeout(idleTimer)
    idleTimer = window.setTimeout(abortRead, idleMs)
  }
  kick()
  const wallTimer = window.setTimeout(abortRead, STREAM_WALL_CLOCK_MAX_MS)
  opts.signal?.addEventListener('abort', abortRead, { once: true })

  const toolEvents: ToolProgressEvent[] = []
  let content = ''
  let finishReason = 'finish'
  let sessionId = opts.sessionId
  let firstTokenTimer: number | undefined

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.sessionId ? { 'X-Hermes-Session-Id': opts.sessionId } : {}),
      },
      body: JSON.stringify({ model, messages, stream: true }),
      credentials: 'omit',
      signal: controller.signal,
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      return {
        ok: false,
        content: '',
        error: `api_server ${res.status}: ${bodyText.slice(0, 300)}`,
        toolEvents,
      }
    }

    // Continuity: the api_server returns the session id it created/continued.
    const returned = res.headers.get('X-Hermes-Session-Id')
    if (returned) sessionId = returned

    if (!res.body) {
      return { ok: false, content: '', error: 'no response body', toolEvents }
    }

    const streamReader = res.body.getReader()
    reader = streamReader
    const decoder = new TextDecoder()
    let buffer = ''
    let sawFrame = false
    firstTokenTimer = window.setTimeout(() => {
      // Gated on any first frame — text deltas AND tool/subagent/browser
      // events (all set sawFrame): a turn that started working is alive even
      // when the first tokens are tool calls, not prose.
      if (!sawFrame) abortRead()
    }, Math.min(FIRST_TOKEN_MS, idleMs))

    const handleFrame = (raw: string) => {
      const trimmed = raw.trim()
      if (!trimmed) return
      // Ignore comment keepalive lines (: keepalive)
      if (trimmed.startsWith(':')) return
      if (trimmed === '[DONE]') return

      let data: Record<string, unknown>
      try {
        data = JSON.parse(trimmed)
      } catch {
        return // partial/corrupt frame — skip
      }

      sawFrame = true
      kick()
      const choice = (data.choices as { delta?: { content?: string }; finish_reason?: string }[] | undefined)?.[0]
      if (choice) {
        const deltaText = choice.delta?.content
        if (deltaText) {
          content += deltaText
          cb.onDelta(deltaText)
        }
        if (choice.finish_reason) {
          finishReason = choice.finish_reason
          const usage = (data.usage as Record<string, number> | undefined) ?? undefined
          cb.onFinish?.(finishReason, usage)
        }
      }
    }

    const handleEventFrame = (eventName: string, raw: string) => {
      if (eventName === 'hermes.tool.progress') {
        try {
          const ev = JSON.parse(raw) as ToolProgressEvent
          if (ev && ev.tool) {
            sawFrame = true
            kick()
            const merged = upsertToolProgress(toolEvents, ev)
            toolEvents.length = 0
            toolEvents.push(...merged)
            cb.onTool?.(ev)
          }
        } catch {
          /* ignore malformed tool event */
        }
      } else if (eventName.startsWith('subagent.') || eventName === 'hermes.subagent') {
        try {
          const payload = JSON.parse(raw) as Record<string, unknown>
          const type =
            eventName === 'hermes.subagent' && typeof payload.event === 'string'
              ? payload.event
              : eventName
          sawFrame = true
          kick()
          cb.onSubagent?.({ type, payload })
        } catch {
          /* ignore malformed subagent event */
        }
      } else if (eventName.startsWith('browser.')) {
        try {
          const parsed = JSON.parse(raw) as unknown
          const payload =
            parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : {}
          sawFrame = true
          kick()
          cb.onBrowser?.({ type: eventName, payload })
        } catch {
          /* ignore malformed browser event */
        }
      } else if (raw.trim() && raw.trim() !== '[DONE]') {
        // Default event: still parse as a data chunk
        handleFrame(raw)
      }
    }

    // Parse SSE frames: `event: <name>` lines can precede `data: <json>`.
    for (;;) {
      const { value, done } = await streamReader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Split on the SSE frame boundary \n\n (or \r\n\r\n)
      let boundary: number
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2).replace(/^\r\n/, '')
        let eventName = ''
        const dataLines: string[] = []
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (dataLines.length === 0) continue
        const payload = dataLines.join('\n')
        if (eventName) handleEventFrame(eventName, payload)
        else handleFrame(payload)
      }
    }

    const alive = Boolean(content.trim()) || toolEvents.length > 0
    return {
      ok: alive,
      content,
      finishReason,
      sessionId,
      error: alive ? undefined : sawFrame ? 'empty stream' : 'no first token',
      toolEvents,
    }
  } catch (err) {
    cb.onError?.(err as Error)
    const silent = !content.trim() && toolEvents.length === 0
    return {
      ok: false,
      content,
      error: isAbortError(err)
        ? silent
          ? 'no first token'
          : 'stream timed out'
        : String((err as Error)?.message ?? err),
      toolEvents,
    }
  } finally {
    window.clearTimeout(idleTimer)
    window.clearTimeout(wallTimer)
    if (firstTokenTimer !== undefined) window.clearTimeout(firstTokenTimer)
    opts.signal?.removeEventListener('abort', abortRead)
  }
}
