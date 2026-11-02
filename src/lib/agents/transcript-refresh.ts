/**
 * Open-thread transcript refetch gate (desktop refresh loop + MobileChat).
 *
 * Both shells used to re-download the open thread's newest page on every
 * tick (15s desktop, 5s phone) whether or not anything happened. The
 * conversation sync feed (`GET /api/chat/sync`, already polled) reports what
 * changed: a new turn moves the row's `lastTurnAt` (→ `lastUsedAt`), a
 * settled turn rewrites its `preview`, and a running turn shows in `live`
 * (→ `liveTurns`). The gate refetches only when that signature moved, while
 * a turn is live (bounded by `liveMinMs`), or after `safetyMs` as a backstop
 * for anything the feed does not carry.
 */

import type { LiveTurn } from './store'

/** Backstop refetch when the sync feed reported nothing for the open thread. */
export const TRANSCRIPT_SAFETY_REFRESH_MS = 60_000

interface ConversationLike {
  id: string
  lastUsedAt?: string
  preview?: string
  title?: string
}

/** What the sync feed tells us about one conversation, as a comparable string. */
export function transcriptSignature(
  conv: ConversationLike | undefined,
  live: LiveTurn | undefined,
): string {
  if (!conv) return ''
  return [
    conv.lastUsedAt ?? '',
    conv.preview ?? '',
    live ? `${live.turnId}:${live.status}` : '',
  ].join('\u0001')
}

export type RefetchReason = 'changed' | 'live' | 'safety' | null

export class TranscriptRefreshGate {
  private readonly seen = new Map<string, { sig: string; at: number }>()
  private readonly opts: { safetyMs?: number; liveMinMs: number }

  constructor(opts: { safetyMs?: number; liveMinMs: number }) {
    this.opts = opts
  }

  /**
   * Decide whether to refetch `conversationId` now. A conversation seen for
   * the first time is only recorded (opening a thread already loads its
   * transcript, see useAgentRuntime). Call {@link markFetched} after a fetch.
   */
  check(conversationId: string, sig: string, live: boolean, now: number): RefetchReason {
    const prev = this.seen.get(conversationId)
    if (!prev) {
      this.seen.set(conversationId, { sig, at: now })
      return null
    }
    const since = now - prev.at
    if (sig !== prev.sig) return 'changed'
    if (live && since >= this.opts.liveMinMs) return 'live'
    if (since >= (this.opts.safetyMs ?? TRANSCRIPT_SAFETY_REFRESH_MS)) return 'safety'
    return null
  }

  markFetched(conversationId: string, sig: string, now: number): void {
    this.seen.set(conversationId, { sig, at: now })
  }
}
