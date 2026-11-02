import { useEffect, useRef } from 'react'
import { getActiveTransport } from './active-transport'
import {
  BEHIND_WARM_DELAY_MS,
  WARM_CONCURRENCY,
  WARM_DELAY_MS,
  WARM_MAX_WAIT_MS,
  canPrefetchOnThisConnection,
  pickBehindConversations,
  pickWarmConversations,
  runLimited,
} from './prefetch'
import { getHydrateStatus, getState } from './store'
import type { Conversation } from './types'
import { logger } from '../logger'

/**
 * Post-boot transcript warm-up (prefetch.ts): once the roster, the
 * conversation list and the open thread have loaded, fetch the next few
 * recent threads so the first switches paint from cache. Runs once per
 * runtime.
 *
 * Lifecycle, both measured in the app before this existed as its own hook:
 * - the hydrate flags read false on the very first render, BEFORE hydration
 *   begins, so an attempt re-checks them and waits (up to WARM_MAX_WAIT_MS);
 * - "started" flips only when an attempt actually runs, so a remount whose
 *   cleanup cleared a pending timer (StrictMode in dev) schedules it again
 *   instead of never warming anything.
 */
export function useBootWarmup(opts: {
  selectedConversationId: string | null
  rosterHydrating: boolean
  conversationsHydrating: boolean
}): void {
  const { selectedConversationId, rosterHydrating, conversationsHydrating } = opts
  const startedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (startedRef.current || timerRef.current) return
    if (rosterHydrating || conversationsHydrating) return
    if (!selectedConversationId) return
    if (!canPrefetchOnThisConnection()) return
    const startedAt = Date.now()
    const attempt = () => {
      const h = getHydrateStatus()
      if (
        (h.rosterHydrating || h.conversationsHydrating || h.transcriptLoadingId) &&
        Date.now() - startedAt < WARM_MAX_WAIT_MS
      ) {
        timerRef.current = setTimeout(attempt, 250)
        return
      }
      timerRef.current = null
      startedRef.current = true
      const s = getState()
      const ids = pickWarmConversations(s.conversations, {
        selectedId: s.selectedConversationId,
        liveIds: new Set(Object.keys(getHydrateStatus().liveTurns)),
        hasCachedRows: (id) =>
          (s.messagesByThreadId[id] ?? []).some((m) => m.role === 'user' || m.role === 'agent'),
      })
      if (!ids.length) return
      void getActiveTransport()
        .then(({ transport }) => {
          const prefetch = transport.prefetchTranscript?.bind(transport)
          if (!prefetch) return
          return runLimited(ids, WARM_CONCURRENCY, prefetch)
        })
        .catch((err) => logger.warn('[hermes] boot warm-up failed', err))
    }
    timerRef.current = setTimeout(attempt, WARM_DELAY_MS)
  }, [rosterHydrating, conversationsHydrating, selectedConversationId])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
    },
    [],
  )
}

/**
 * Keep recent cached threads current in the background. When the sync feed
 * moves a thread past its cache (cachedTranscriptBehind) — a turn sent from
 * another device, or a reply that settled while the app was hidden — fetch
 * its newest page, so opening it paints the new turns instead of the old
 * ones followed by a pop. Bounded: the WARM_COUNT most recent threads,
 * WARM_CONCURRENCY at a time, once per thread position (`lastUsedAt`),
 * visible document and a cheap connection only. A live thread is left to its
 * stream; it is picked up after it settles.
 */
export function useBehindWarmup(opts: {
  conversations: readonly Conversation[]
  selectedConversationId: string | null
  conversationsHydrating: boolean
}): void {
  const { conversations, selectedConversationId, conversationsHydrating } = opts
  const warmedRef = useRef(new Map<string, string>())

  useEffect(() => {
    if (conversationsHydrating) return
    const timer = setTimeout(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (!canPrefetchOnThisConnection()) return
      const s = getState()
      const warmed = warmedRef.current
      const ids = pickBehindConversations(s.conversations, {
        selectedId: s.selectedConversationId,
        liveIds: new Set(Object.keys(getHydrateStatus().liveTurns)),
        messagesFor: (id) => s.messagesByThreadId[id] ?? [],
        skip: (id, lastUsedAt) => warmed.get(id) === lastUsedAt,
      })
      if (!ids.length) return
      for (const id of ids) {
        const c = s.conversations.find((x) => x.id === id)
        if (c) warmed.set(id, c.lastUsedAt)
      }
      void getActiveTransport()
        .then(({ transport }) => {
          const prefetch = transport.prefetchTranscript?.bind(transport)
          if (!prefetch) return
          return runLimited(ids, WARM_CONCURRENCY, prefetch)
        })
        .catch((err) => logger.warn('[hermes] behind warm-up failed', err))
    }, BEHIND_WARM_DELAY_MS)
    return () => clearTimeout(timer)
  }, [conversations, selectedConversationId, conversationsHydrating])
}
