/**
 * Per-message subscriptions for streaming text.
 *
 * The shell (App, TopBar, the ChatPanel body) reads the store's structural
 * snapshot, which a content-only streaming tick does not move. The rows that
 * render a reply's text subscribe here instead, so a tick re-renders the one
 * bubble that grew rather than the whole app (see store.ts getStructuralState).
 */

import { useCallback, useRef, useSyncExternalStore } from 'react'
import { getLiveMessage, subscribe } from './store'
import type { ChatMessage } from './types'

/** `m` with the newest streamed text. Same identity until that text moves. */
export function useLiveMessage(m: ChatMessage): ChatMessage {
  const getSnapshot = useCallback(() => getLiveMessage(m), [m])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** `useLiveMessage` over a list; the array keeps its identity until a row moves. */
export function useLiveMessages(messages: ChatMessage[]): ChatMessage[] {
  const cache = useRef<{ input: ChatMessage[]; output: ChatMessage[] } | null>(null)
  const getSnapshot = useCallback(() => {
    const next = messages.map(getLiveMessage)
    const prev = cache.current
    if (
      prev &&
      prev.input === messages &&
      prev.output.length === next.length &&
      prev.output.every((m, i) => m === next[i])
    ) {
      return prev.output
    }
    const output = next.every((m, i) => m === messages[i]) ? messages : next
    cache.current = { input: messages, output }
    return output
  }, [messages])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
