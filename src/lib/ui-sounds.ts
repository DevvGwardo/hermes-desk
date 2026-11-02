/**
 * Reply cues ("done" / "error"): mirrored from hermes-deploy
 * src/lib/ui-sounds.ts (the web dashboard chat), so both surfaces sound alike.
 *
 * Synthesized with Web Audio rather than shipped as files: no asset bytes, no
 * licensing, nothing to load when a turn ends. Everything is best-effort; any
 * failure (no AudioContext, autoplay policy, storage blocked) is a silent
 * no-op.
 *
 * Etiquette:
 *  - Off switch in Settings (`nub.ui-sounds.v1`, this device only).
 *  - A short reply the reader watched arrive gets no chime (`turnCue`).
 *  - When a system notification was posted, the OS already played its sound,
 *    so the in-app cue stays quiet (lib/use-system-notifications.ts).
 *  - A turn the reader stopped themselves is silent (`markTurnStopped`).
 */

export type UiSound = 'done' | 'error'
export type TurnOutcome = 'done' | 'error' | null

const PREF_KEY = 'nub.ui-sounds.v1'
const LAST_CUE_KEY = 'nub.ui-sounds.last'
/** A 'done' for a reply shorter than this plays only when the tab is not
 *  focused: the viewer was watching it stream. */
export const DONE_CUE_MIN_MS = 5_000
/** Two cues closer than this collapse into one (a burst of turns settling
 *  together after a reconnect). */
const MIN_GAP_MS = 1_500
const MASTER_GAIN = 0.35

// ── Preference ──────────────────────────────────────────────────────

const listeners = new Set<() => void>()

export function uiSoundsEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setUiSoundsEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off')
  } catch {
    // Storage blocked: the toggle still flips for this page via listeners.
  }
  listeners.forEach((l) => l())
  if (on) playUiSound('done') // audible confirmation, and a user gesture
}

/** useSyncExternalStore subscriber: same-tab toggles and other tabs. */
export function subscribeUiSounds(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key === PREF_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

// ── Decision (pure; pinned by src/lib/__tests__/ui-sounds.test.ts) ──

export interface TurnCueInput {
  /** Role of the last transcript row once the turn settled. */
  lastRole: string | undefined
  /** The viewer pressed Stop on this turn. */
  stoppedByUser: boolean
  /** More queued messages will dispatch right away. */
  queued: boolean
  elapsedMs: number
  /** document.hidden || !document.hasFocus() */
  away: boolean
}

export function turnCue(input: TurnCueInput): TurnOutcome {
  if (input.stoppedByUser) return null
  if (input.lastRole === 'error') return 'error'
  if (input.lastRole !== 'assistant') return null
  // A reply with more sends queued behind it stays quiet.
  if (input.queued) return null
  if (input.away || input.elapsedMs >= DONE_CUE_MIN_MS) return 'done'
  return null
}

// ── Stop ────────────────────────────────────────────────────────────

const STOP_WINDOW_MS = 30_000
const stoppedAt = new Map<string, number>()

/** The reader pressed Stop in this conversation: its settle stays silent. */
export function markTurnStopped(conversationId: string): void {
  stoppedAt.set(conversationId, Date.now())
}

/** True once per Stop, within a short window of it. */
export function takeTurnStopped(conversationId: string, now = Date.now()): boolean {
  const at = stoppedAt.get(conversationId)
  stoppedAt.delete(conversationId)
  return at !== undefined && now - at < STOP_WINDOW_MS
}

// ── Dedupe ──────────────────────────────────────────────────────────

const claimed = new Set<string>()
let lastPlayedAt = 0

/** True for the first claim of `key` in this tab and (best-effort) across
 *  tabs. Several provider mounts / tabs observe the same turn settle. */
export function claimCue(key: string): boolean {
  if (claimed.has(key)) return false
  claimed.add(key)
  if (claimed.size > 200) claimed.delete(claimed.values().next().value as string)
  try {
    if (localStorage.getItem(LAST_CUE_KEY) === key) return false
    localStorage.setItem(LAST_CUE_KEY, key)
  } catch {
    // In-tab dedupe still holds.
  }
  return true
}

// ── Synthesis ───────────────────────────────────────────────────────

let ctx: AudioContext | null = null
let unlockInstalled = false

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (ctx) return ctx
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    ctx = new Ctor()
  } catch {
    return null
  }
  return ctx
}

/** Browsers start an AudioContext suspended until a user gesture. Resume it
 *  on the first pointer/key interaction so a cue that fires later, possibly
 *  in a background tab, is audible. Idempotent. */
export function installUiSoundUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined') return
  unlockInstalled = true
  const unlock = () => {
    const c = audioContext()
    if (!c) return
    void c.resume().catch(() => {})
    if (c.state === 'running') {
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('keydown', unlock, true)
    }
  }
  window.addEventListener('pointerdown', unlock, true)
  window.addEventListener('keydown', unlock, true)
}

interface Note {
  freq: number
  at: number // seconds from start
  dur: number // decay length
  gain: number
  type: OscillatorType
}

// 'done': a soft rising fifth (C6 → G6), bell-like decay.
// 'error': a short descending minor third (E5 → C#5), duller and lower.
const CUES: Record<UiSound, Note[]> = {
  done: [
    { freq: 1046.5, at: 0, dur: 0.5, gain: 0.5, type: 'sine' },
    { freq: 1568.0, at: 0.09, dur: 0.7, gain: 0.45, type: 'sine' },
  ],
  error: [
    { freq: 659.3, at: 0, dur: 0.22, gain: 0.45, type: 'triangle' },
    { freq: 554.4, at: 0.13, dur: 0.32, gain: 0.45, type: 'triangle' },
  ],
}

export function playUiSound(kind: UiSound): void {
  if (!uiSoundsEnabled()) return
  const now = Date.now()
  if (now - lastPlayedAt < MIN_GAP_MS) return
  const c = audioContext()
  if (!c) return
  lastPlayedAt = now
  if (c.state === 'running') {
    schedule(c, kind)
    return
  }
  // Suspended (no user gesture yet): resume() can stay pending until the
  // next gesture, so a cue that only gets through late is dropped rather
  // than played as a stale chime minutes after the turn ended.
  c.resume()
    .then(() => {
      if (c.state === 'running' && Date.now() - now < 500) schedule(c, kind)
    })
    .catch(() => {})
}

function schedule(c: AudioContext, kind: UiSound): void {
  try {
    const master = c.createGain()
    master.gain.value = MASTER_GAIN
    const tone = c.createBiquadFilter()
    tone.type = 'lowpass'
    tone.frequency.value = 4_000
    master.connect(tone).connect(c.destination)
    const t0 = c.currentTime + 0.01
    let end = t0
    for (const n of CUES[kind]) {
      const start = t0 + n.at
      const osc = c.createOscillator()
      osc.type = n.type
      osc.frequency.value = n.freq
      const env = c.createGain()
      // 6ms attack avoids a click; exponential decay reads as a struck bell.
      env.gain.setValueAtTime(0.0001, start)
      env.gain.exponentialRampToValueAtTime(n.gain, start + 0.006)
      env.gain.exponentialRampToValueAtTime(0.0001, start + n.dur)
      osc.connect(env).connect(master)
      osc.start(start)
      osc.stop(start + n.dur + 0.02)
      end = Math.max(end, start + n.dur + 0.02)
    }
    // Drop the graph once the last note ends.
    setTimeout(() => {
      tone.disconnect()
      master.disconnect()
    }, (end - c.currentTime) * 1000 + 100)
  } catch {
    // best-effort
  }
}
