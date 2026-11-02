/** Opt-in, bounded renderer metadata. No persistence, payloads or raw identities. */
import { setRenderFailureReporter } from './render-capture-bridge'

const CAPTURE_MS = 5 * 60_000
const MAX_ENTRIES = 128
type Phase = 'idle' | 'recording' | 'stopped' | 'failed' | 'expired'
type Event = 'thread' | 'commit' | 'scroll' | 'resize' | 'follow' | 'intent' | 'failure'
const events: readonly Event[] = ['thread', 'commit', 'scroll', 'resize', 'follow', 'intent', 'failure']
const numbers = ['epoch', 'rows', 'scrollTop', 'scrollHeight', 'clientHeight'] as const
const flags = ['active', 'sending', 'loading', 'finding', 'focusJump', 'away', 'pinned', 'reduced', 'hidden', 'dateChanged'] as const
const components = ['ChatPanel', 'TranscriptRow', 'MessageBody', 'MessengerComposer', 'App', 'Root', 'ErrorBoundary'] as const
type Metadata = Partial<Record<typeof numbers[number], number> & Record<typeof flags[number], boolean>> & {
  skin?: 'messenger' | 'classic'
}
interface Entry {
  seq: number
  atMs: number
  event: Event
  data: Metadata
  failure?: 'maximum-depth' | 'renderer-error' | 'unhandled-rejection'
  components?: string[]
}

let phase: Phase = 'idle'
let entries: Entry[] = []
let sequence = 0
let started = 0
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()
const bounded = (value: number) => Math.max(-10_000_000, Math.min(10_000_000, Math.round(value)))
const notify = () => { for (const listener of listeners) listener() }
const onError = (event: ErrorEvent) => renderCapture.fail(event.error ?? event.message)
const onRejection = () => renderCapture.fail(undefined, undefined, 'unhandled-rejection')

function detach() {
  setRenderFailureReporter(undefined)
  if (typeof window === 'undefined') return
  window.removeEventListener('error', onError)
  window.removeEventListener('unhandledrejection', onRejection)
}
function clear(next: Phase = 'idle') {
  clearTimeout(timer)
  timer = undefined
  detach()
  entries = []
  sequence = 0
  phase = next
  notify()
}
function finish(next: Phase) {
  clearTimeout(timer)
  detach()
  phase = next
  // A frozen receipt is also temporary: at most five more minutes in memory.
  timer = setTimeout(() => clear('expired'), CAPTURE_MS)
  notify()
}

export const renderCapture = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getPhase: () => phase,
  isRecording: () => phase === 'recording',
  start() {
    clear()
    started = performance.now()
    phase = 'recording'
    setRenderFailureReporter(renderCapture.fail)
    timer = setTimeout(() => finish('stopped'), CAPTURE_MS)
    if (typeof window !== 'undefined') {
      window.addEventListener('error', onError)
      window.addEventListener('unhandledrejection', onRejection)
    }
    notify()
  },
  stop() { if (phase === 'recording') finish('stopped') },
  clear: () => clear(),
  record(event: Event, input: Record<string, unknown> = {}) {
    if (phase !== 'recording' || !events.includes(event)) return false
    const data: Metadata = {}
    for (const key of numbers) {
      const value = input[key]
      if (typeof value === 'number' && Number.isFinite(value)) data[key] = bounded(value)
    }
    for (const key of flags) {
      if (typeof input[key] === 'boolean') data[key] = input[key]
    }
    if (input.skin === 'messenger' || input.skin === 'classic') data.skin = input.skin
    entries.push({ seq: ++sequence, atMs: bounded(performance.now() - started), event, data })
    if (entries.length > MAX_ENTRIES) entries.shift()
    // Do not notify React on every commit/scroll: capture cannot drive renders.
    return true
  },
  fail(error: unknown, componentStack?: string, kind?: 'unhandled-rejection') {
    if (phase !== 'recording') return
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    renderCapture.record('failure')
    const entry = entries[entries.length - 1]
    entry.failure = kind ?? (/Maximum update depth|Minified React error #185/i.test(message)
      ? 'maximum-depth' : 'renderer-error')
    // Retain only known static component names, never stack URLs, paths or text.
    const stack = typeof componentStack === 'string' ? componentStack.slice(0, 8192) : ''
    entry.components = components.filter(name => new RegExp(`\\bat ${name}(?:\\s|\\()`).test(stack))
    finish('failed')
  },
  read() {
    return { version: 1, phase, maxEntries: MAX_ENTRIES, entries: entries.map(entry => ({
      ...entry, data: { ...entry.data }, ...(entry.components ? { components: [...entry.components] } : {}),
    })) }
  },
}
