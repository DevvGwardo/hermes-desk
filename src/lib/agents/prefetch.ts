/**
 * Transcript prefetch policy: which conversations to warm, and when.
 *
 * Opening a conversation whose messages are cached paints in one frame;
 * opening one that isn't waits on a server round trip (~350 ms measured
 * through the production topology, tools/blueprint/conversation-switch.mjs
 * in hermes-deploy). Two warm-ups close that gap without selecting anything:
 *
 *   - hover intent: a pointer (or keyboard focus) resting on a sidebar row
 *     for HOVER_INTENT_MS starts that row's fetch, so the click lands on a
 *     warm cache;
 *   - post-boot: once the open conversation has loaded, the next
 *     WARM_COUNT most recent threads without cached rows are fetched,
 *     WARM_CONCURRENCY at a time.
 *
 * Both go through transport.prefetchTranscript, which shares the selection
 * path's single-flight fetch and never polls live-turn state.
 */
import { cachedTranscriptBehind } from './transcript-freshness'
import type { ChatMessage, Conversation } from './types'

export const HOVER_INTENT_MS = 60
export const WARM_COUNT = 4
export const WARM_CONCURRENCY = 2
/** Let the open conversation's own fetch go first. */
export const WARM_DELAY_MS = 600
/** Give up waiting for the open conversation after this long. */
export const WARM_MAX_WAIT_MS = 8_000

/** Sidebar order: pinned first, then most recently used. */
function sidebarOrder(a: Conversation, b: Conversation): number {
  const pin = Number(!!b.pinned) - Number(!!a.pinned)
  if (pin !== 0) return pin
  return a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : 0
}

/**
 * The conversations worth warming after boot, in sidebar order: synced agent
 * threads that aren't open, aren't hidden, have no turn in flight and have
 * no cached messages yet (a cached thread already opens instantly).
 */
export function pickWarmConversations(
  conversations: readonly Conversation[],
  opts: {
    selectedId: string | null
    liveIds: ReadonlySet<string>
    hasCachedRows: (conversationId: string) => boolean
    limit?: number
  },
): string[] {
  const limit = opts.limit ?? WARM_COUNT
  return conversations
    .filter(
      (c) =>
        c.id !== opts.selectedId &&
        !c.hiddenFromSidebar &&
        c.target.type === 'agent' &&
        Boolean(c.hermesSessionId) &&
        !opts.liveIds.has(c.id) &&
        !opts.hasCachedRows(c.id),
    )
    .sort(sidebarOrder)
    .slice(0, limit)
    .map((c) => c.id)
}

/** Settle time after a sync-feed change before warming behind threads. */
export const BEHIND_WARM_DELAY_MS = 1_200

/**
 * Cached threads the sync feed says moved past their cache (a turn from
 * another device, or a reply that settled while this one was away), in
 * sidebar order. Same eligibility as {@link pickWarmConversations} except
 * the cache requirement is inverted: these HAVE rows, just old ones.
 * `skip(id, lastUsedAt)` drops a thread already warmed at that position.
 */
export function pickBehindConversations(
  conversations: readonly Conversation[],
  opts: {
    selectedId: string | null
    liveIds: ReadonlySet<string>
    messagesFor: (conversationId: string) => readonly ChatMessage[]
    skip?: (conversationId: string, lastUsedAt: string) => boolean
    limit?: number
  },
): string[] {
  const limit = opts.limit ?? WARM_COUNT
  return conversations
    .filter(
      (c) =>
        c.id !== opts.selectedId &&
        !c.hiddenFromSidebar &&
        c.target.type === 'agent' &&
        Boolean(c.hermesSessionId) &&
        !opts.liveIds.has(c.id),
    )
    .sort(sidebarOrder)
    .slice(0, limit)
    .filter(
      (c) =>
        !opts.skip?.(c.id, c.lastUsedAt) &&
        cachedTranscriptBehind(c, opts.messagesFor(c.id), { live: false }),
    )
    .map((c) => c.id)
}

/** Prefetch only when it's cheap for the user: online, not in data-saver. */
export function canPrefetchOnThisConnection(
  nav: { onLine?: boolean; connection?: { saveData?: boolean } } | undefined = typeof navigator ===
  'undefined'
    ? undefined
    : (navigator as Navigator & { connection?: { saveData?: boolean } }),
): boolean {
  if (!nav) return false
  if (nav.onLine === false) return false
  return nav.connection?.saveData !== true
}

/** Run `fn` over `items`, at most `concurrency` at once. Never rejects. */
export async function runLimited<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!
      try {
        await fn(item)
      } catch {
        /* one failed prefetch never blocks the rest */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker))
}
