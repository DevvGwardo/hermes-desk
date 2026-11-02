/** Shared runtime queue API, memory-only in the local app. */
import type { MessageReplyTo } from './agents/types'

export const MAX_OUTBOX = 25
export interface OutboxItem {
  id: string
  conversationId: string
  text: string
  replyTo?: MessageReplyTo
  createdAt: string
  attempts: number
  lastError?: string
}
let items: OutboxItem[] = []
const listeners = new Set<() => void>()
function notify(): void { for (const listener of listeners) listener() }
export function readOutbox(): OutboxItem[] { return [...items] }
export function getOutboxSnapshot(): OutboxItem[] { return items }
export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function enqueueOutbox(item: Omit<OutboxItem, 'createdAt' | 'attempts'> & { createdAt?: string }): OutboxItem {
  if (items.length >= MAX_OUTBOX) throw new Error('Message queue is full.')
  const next = { ...item, createdAt: item.createdAt ?? new Date().toISOString(), attempts: 0 }
  items = [...items, next]
  notify()
  return next
}
export function removeOutbox(id: string): boolean {
  const next = items.filter((item) => item.id !== id)
  if (next.length === items.length) return false
  items = next
  notify()
  return true
}
export function markOutboxFailure(id: string, error: string): void {
  items = items.map((item) => item.id === id ? { ...item, attempts: item.attempts + 1, lastError: error } : item)
  notify()
}
export function clearOutbox(): void { items = []; notify() }
export function outboxFor(id: string): OutboxItem[] { return items.filter((item) => item.conversationId === id) }
export function outboxCount(): number { return items.length }
