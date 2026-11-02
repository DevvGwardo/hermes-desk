/**
 * Per-conversation transcript freshness (review pass 2, #3): re-selecting a
 * thread that was hydrated moments ago must not refetch it. PR #60 stopped the
 * refresh storm by only loading empty threads; refreshing cached threads on
 * every selection brought part of it back. Selection now skips a thread that
 * hydrated within TRANSCRIPT_FRESH_MS (aligned with App's FOCUS_REFRESH_MIN_MS)
 * and debounces the rest by SELECTION_REFRESH_DEBOUNCE_MS.
 *
 * Behind (2026-10-04): a cached thread paints from cache, and the refresh
 * used to land a second or two later with the newer rows popping in and no
 * hint that anything was loading — most visible on a phone, where the app
 * sits in the background while replies settle elsewhere. The conversation
 * sync feed already says when the server has a newer turn than the cache
 * holds ({@link cachedTranscriptBehind}); such a thread fetches at once
 * (no debounce, freshness ignored) and the chat shows where the new
 * messages will land until they do.
 */
import type { ChatMessage, Conversation } from './types'

export const TRANSCRIPT_FRESH_MS = 10_000
export const SELECTION_REFRESH_DEBOUNCE_MS = 250
/** The sync row's `lastTurnAt` is stamped a moment after the turn row's
 *  `createdAt` (touchConversationForTurn runs after createTurn), and a local
 *  send's touch uses the device clock. Anything inside this margin is the
 *  same turn, not a newer one. */
export const LAST_TURN_SKEW_MS = 5_000

const hydratedAt = new Map<string, number>()
/** The sync row's `lastUsedAt` (ms) the last successful fetch started from.
 *  A turn that adds no rows (blank, system) moves `lastTurnAt` without ever
 *  giving the cache a newer stamp; once fetched against, it is not "behind"
 *  again until the row moves past it. */
const fetchedThrough = new Map<string, number>()

/** Record a successful transcript fetch for this conversation. `lastUsedAt`
 *  is the sync row's value when the fetch STARTED. */
export function markTranscriptFresh(
  conversationId: string,
  now: number = Date.now(),
  lastUsedAt?: string,
): void {
  hydratedAt.set(conversationId, now)
  const through = lastUsedAt ? Date.parse(lastUsedAt) : Number.NaN
  if (!Number.isNaN(through)) {
    fetchedThrough.set(conversationId, Math.max(through, fetchedThrough.get(conversationId) ?? 0))
  }
}

export function isTranscriptFresh(conversationId: string, now: number = Date.now()): boolean {
  const at = hydratedAt.get(conversationId)
  return at !== undefined && now - at < TRANSCRIPT_FRESH_MS
}

function isReal(m: ChatMessage): boolean {
  return m.role === 'user' || m.role === 'agent'
}

/**
 * True when the sync feed proves the cached transcript is missing something
 * the server has:
 *   - the row's `lastUsedAt` (server `lastTurnAt`) is newer than the newest
 *     server-stamped cached row, or
 *   - the newest cached reply was persisted mid-stream and no turn is live
 *     any more (it settled while this device was away).
 *
 * Conservative by design: a group, a thread with no server-stamped rows, or
 * one whose tail is a local row (an optimistic send, an outbox bubble) is
 * "not known to be behind" — the normal refresh still runs, without the
 * placeholder.
 */
export function cachedTranscriptBehind(
  conv: Pick<Conversation, 'id' | 'lastUsedAt' | 'hermesSessionId' | 'target'> | undefined,
  messages: readonly ChatMessage[],
  opts: { live: boolean },
): boolean {
  if (!conv?.hermesSessionId || conv.target.type === 'group') return false
  let tail: ChatMessage | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isReal(messages[i])) {
      tail = messages[i]
      break
    }
  }
  if (!tail?.turnCreatedAt) return false
  if (!opts.live && tail.role === 'agent' && tail.streaming) return true
  const newest = Date.parse(tail.turnCreatedAt)
  const lastUsed = Date.parse(conv.lastUsedAt)
  if (Number.isNaN(newest) || Number.isNaN(lastUsed)) return false
  const through = fetchedThrough.get(conv.id)
  if (through !== undefined && lastUsed <= through) return false
  return lastUsed - newest > LAST_TURN_SKEW_MS
}

export type SelectionRefresh = 'full' | 'behind' | 'transcript' | 'skip'

/**
 * What a selection should fetch: an empty (unknown) thread → the full load
 * (transcript + live-turn state) immediately; a cached thread the sync feed
 * says is behind → the transcript page immediately, freshness ignored; any
 * other cached thread → the transcript page only, unless it is still fresh.
 */
export function selectionRefreshPlan(
  conversationId: string,
  hasCachedRows: boolean,
  now: number = Date.now(),
  behind = false,
): SelectionRefresh {
  if (!hasCachedRows) return 'full'
  if (behind) return 'behind'
  return isTranscriptFresh(conversationId, now) ? 'skip' : 'transcript'
}

/** Test hook. */
export function resetTranscriptFreshness(): void {
  hydratedAt.clear()
  fetchedThrough.clear()
}
