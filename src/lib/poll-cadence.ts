/**
 * Activity-aware polling cadence.
 *
 * Every poll that reaches www.maiavm.com is a Vercel function invocation plus
 * Redis commands on the platform side. A window left open and untouched used
 * to poll the conversation list every 5s (~1,000 requests/hour per window).
 * Pollers now ask this module how long to wait:
 *
 * - hidden document → don't poll (resume triggers an immediate refresh);
 * - active (input within ACTIVE_WINDOW_MS and window focused) → the caller's
 *   base interval;
 * - idle / unfocused → IDLE_INTERVAL_MS, then DORMANT_INTERVAL_MS after
 *   DORMANT_AFTER_MS without input.
 *
 * Returning from idle (any input, focus, or visibility resume) fires
 * `onWake` listeners so pollers refresh at once — freshness when someone is
 * looking, near-zero traffic when nobody is.
 */

export const ACTIVE_WINDOW_MS = 2 * 60 * 1000
export const IDLE_INTERVAL_MS = 60 * 1000
export const DORMANT_AFTER_MS = 10 * 60 * 1000
export const DORMANT_INTERVAL_MS = 5 * 60 * 1000

type WakeListener = () => void

let lastActiveAt = Date.now()
let installed = false
const wakeListeners = new Set<WakeListener>()

function wake() {
  for (const fn of [...wakeListeners]) {
    try { fn() } catch { /* one listener must not stop the others */ }
  }
}

function now(): number {
  return Date.now()
}

function docHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function windowFocused(): boolean {
  if (typeof document === 'undefined') return true
  // Android WebView / mobile: hasFocus() is unreliable; visibility is what matters there.
  try {
    return document.hasFocus() || /Android|iPhone|iPad/i.test(navigator.userAgent)
  } catch {
    return true
  }
}

/** Record user activity; fires wake listeners when coming back from idle. */
export function noteActivity(at: number = now()): void {
  const wasIdle = at - lastActiveAt >= ACTIVE_WINDOW_MS
  lastActiveAt = at
  if (wasIdle) {
    wake()
  }
}

function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const onInput = () => noteActivity()
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focus']) {
    window.addEventListener(ev, onInput, { passive: true, capture: true })
  }
  document.addEventListener('visibilitychange', () => {
    if (!docHidden()) {
      lastActiveAt = now()
      wake()
    }
  })
}

/** Subscribe to "user is back" (after idle, focus, or visibility resume). */
export function onWake(fn: WakeListener): () => void {
  install()
  wakeListeners.add(fn)
  return () => wakeListeners.delete(fn)
}

/**
 * Delay before the next poll, or `null` when the document is hidden (callers
 * skip and rely on the wake/visibility refresh).
 */
export function pollDelay(baseMs: number, opts: { live?: boolean; at?: number } = {}): number | null {
  install()
  if (docHidden()) return null
  if (opts.live) return baseMs
  const idleFor = (opts.at ?? now()) - lastActiveAt
  if (idleFor < ACTIVE_WINDOW_MS && windowFocused()) return baseMs
  if (idleFor < DORMANT_AFTER_MS) return Math.max(baseMs, IDLE_INTERVAL_MS)
  return Math.max(baseMs, DORMANT_INTERVAL_MS)
}

/**
 * Run `tick` on an activity-aware cadence. `tick` runs once immediately
 * unless `immediate: false`. Wake (user back) runs it at once. Returns stop().
 */
export function startAdaptivePoll(
  tick: () => void | Promise<void>,
  baseMs: number,
  opts: { immediate?: boolean; live?: () => boolean } = {},
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false

  const schedule = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    const d = pollDelay(baseMs, { live: opts.live?.() })
    // Hidden: re-check visibility at the dormant cadence; wake fires on resume.
    timer = setTimeout(run, d ?? DORMANT_INTERVAL_MS)
  }
  const run = async () => {
    timer = null
    if (stopped) return
    if (!docHidden() && !running) {
      running = true
      try {
        await tick()
      } catch {
        /* pollers own their error handling; keep the loop alive */
      } finally {
        running = false
      }
    }
    schedule()
  }
  const offWake = onWake(() => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = null
    void run()
  })

  if (opts.immediate === false) schedule()
  else void run()

  return () => {
    stopped = true
    offWake()
    if (timer) clearTimeout(timer)
  }
}

/** Test helper. */
export function __resetPollCadenceForTests(at: number = now()): void {
  lastActiveAt = at
  wakeListeners.clear()
}
