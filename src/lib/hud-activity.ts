/**
 * hud-activity.ts — what the cat's badge knows, and how it learns it.
 *
 * The HUD window has its own store, loaded once from localStorage: it never
 * sees turns started on Telegram, the phone, the web, or the main window. The
 * MAIN window does — conversation sync's `live` set lights any turn running
 * on any device, and streaming bubbles cover this device's own. So the main
 * window derives a small summary here and relays it through electron main
 * (maia:hud:publishActivity → maia:hud:activity) to the cat. Zero extra
 * server polling: it rides the sync the main window already runs.
 *
 * Two halves:
 *   - HudActivityTracker (main window): live set + live→idle transitions →
 *     "finished"/"failed" events.
 *   - hudBadge (HUD): summary + the keys the user has already seen → the one
 *     badge state to draw.
 */

import type { AgentsState, HydrateStatus } from './agents/store'
import { getHydrateStatus, getState, subscribe } from './agents/store'
import { CLICK_RE, POINT_RE, TYPE_RE } from './hud-protocol'
import { isHudWindow } from './hud'

export interface HudActivityItem {
  id: string
  title: string
}

export interface HudActivityEvent {
  /** Stable per finished turn — the HUD remembers which keys it has shown. */
  key: string
  id: string
  title: string
  preview: string
  status: 'done' | 'error'
  at: number
}

export interface HudActivity {
  v: 1
  working: HudActivityItem[]
  events: HudActivityEvent[]
}

const MAX_EVENTS = 5
const EVENT_TTL_MS = 60 * 60_000
const PREVIEW_MAX = 200

function titleOf(state: AgentsState, id: string): string {
  const c = state.conversations.find((x) => x.id === id)
  const t = c?.title?.trim()
  return t && t !== 'New conversation' ? t : 'Conversation'
}

function previewText(raw: string): string {
  const s = raw
    .replace(POINT_RE, '')
    .replace(CLICK_RE, '')
    .replace(TYPE_RE, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]')
    .replace(/[`*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX - 1) + '…' : s
}

/** Conversations with a turn in flight: streaming bubbles here + server live turns. */
export function liveConversationIds(state: AgentsState, hydrate: Pick<HydrateStatus, 'liveTurns'>): Set<string> {
  const ids = new Set<string>()
  for (const [id, msgs] of Object.entries(state.messagesByThreadId)) {
    if (msgs.some((m) => m.role === 'agent' && m.streaming)) ids.add(id)
  }
  for (const id of Object.keys(hydrate.liveTurns ?? {})) ids.add(id)
  const hidden = new Set(state.conversations.filter((c) => c.hiddenFromSidebar).map((c) => c.id))
  for (const id of hidden) ids.delete(id)
  return ids
}

export class HudActivityTracker {
  private prevLive = new Set<string>()
  private events: HudActivityEvent[] = []

  update(state: AgentsState, hydrate: Pick<HydrateStatus, 'liveTurns'>, now: number = Date.now()): HudActivity {
    const live = liveConversationIds(state, hydrate)
    for (const id of this.prevLive) {
      if (live.has(id)) continue
      if (!state.conversations.some((c) => c.id === id)) continue // deleted, not finished
      const msgs = state.messagesByThreadId[id] ?? []
      const last = [...msgs].reverse().find((m) => m.role === 'agent' && !m.streaming)
      const conv = state.conversations.find((c) => c.id === id)
      const event: HudActivityEvent = {
        key: last ? `${id}:${last.id}` : `${id}:${now}`,
        id,
        title: titleOf(state, id),
        preview: previewText(last?.content || conv?.preview || ''),
        status: last?.error ? 'error' : 'done',
        at: now,
      }
      this.events = [event, ...this.events.filter((e) => e.key !== event.key)]
    }
    this.prevLive = live
    this.events = this.events.filter((e) => now - e.at <= EVENT_TTL_MS).slice(0, MAX_EVENTS)
    return {
      v: 1,
      working: [...live].map((id) => ({ id, title: titleOf(state, id) })),
      events: this.events,
    }
  }
}

export type HudBadge =
  | { kind: 'none' }
  | { kind: 'working'; count: number; title: string }
  | { kind: 'done' | 'error'; event: HudActivityEvent; unseen: number }

/**
 * The single badge the collapsed cat draws. An unseen failure outranks
 * everything (it needs the user); then work in progress; then unseen
 * finishes. Seen events draw nothing.
 */
export function hudBadge(activity: HudActivity | null, seen: ReadonlySet<string>): HudBadge {
  if (!activity) return { kind: 'none' }
  const unseen = activity.events.filter((e) => !seen.has(e.key))
  const failed = unseen.find((e) => e.status === 'error')
  if (failed) return { kind: 'error', event: failed, unseen: unseen.length }
  if (activity.working.length > 0) {
    return { kind: 'working', count: activity.working.length, title: activity.working[0].title }
  }
  if (unseen.length > 0) return { kind: 'done', event: unseen[0], unseen: unseen.length }
  return { kind: 'none' }
}

type HudBridge = {
  publishActivity?: (summary: HudActivity) => Promise<unknown>
}

/**
 * Main window only: publish the summary to the cat whenever it changes
 * (coalesced — streaming deltas fire the store many times a second).
 * Returns a stop function; a no-op outside Electron or inside the HUD.
 */
export function startHudActivityRelay(): () => void {
  if (typeof window === 'undefined' || isHudWindow()) return () => {}
  const hud = (window as unknown as { nubAgent?: { hud?: HudBridge } }).nubAgent?.hud
  if (!hud?.publishActivity) return () => {}
  const tracker = new HudActivityTracker()
  let lastSig = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    const summary = tracker.update(getState(), getHydrateStatus())
    const sig = JSON.stringify(summary)
    if (sig === lastSig) return
    lastSig = sig
    void Promise.resolve(hud.publishActivity?.(summary)).catch(() => {})
  }
  const schedule = () => {
    if (timer == null) timer = setTimeout(flush, 400)
  }
  const unsub = subscribe(schedule)
  flush()
  return () => {
    unsub()
    if (timer != null) clearTimeout(timer)
  }
}
