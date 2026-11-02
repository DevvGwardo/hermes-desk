import { useMemo, useRef } from 'react'
import type { ChatMessage } from '../../lib/agents/types'
import { threadGroups, type ThreadGroup } from '../../lib/threading'

/** Re-point cached structure at current objects so streaming replies stay live. */
function withCurrentMessages(
  groups: ThreadGroup[],
  messages: ChatMessage[],
): ThreadGroup[] {
  const byId = new Map<string, ChatMessage>()
  for (const m of messages) byId.set(m.id, m)
  const cur = (m: ChatMessage) => byId.get(m.id) ?? m
  return groups.map((g) => ({
    root: cur(g.root),
    all: g.all.map(cur),
    replies: g.replies.map(cur),
  }))
}

export function useThreadGroups(messages: ChatMessage[]) {
  // A4 threading: ONE grouping pass per `messages` change drives the
  // collapsed transcript, the reply-chip counts, the root lookup, and the
  // thread pane. Per-row lookups consume the precomputed groups — no regroup
  // per row or per streaming tick. No stored state — chains are recomputed
  // from replyTo links.
  //
  // C3 (docs/CHAT_LOAD_AND_MOTION_SPEC.md): groups depend only on reply
  // links, so cache them on the message ids + replyTo targets. A streaming
  // tick grows the tail bubble's content but changes no id — the grouping
  // pass (and its O(n) snippet index) is skipped entirely until a new
  // message id or reply link shows up.
  //
  // The cache holds STRUCTURE only (ids, collapse set, counts). Message
  // objects are always read from the current `messages`: a streaming reply
  // keeps its id while its content grows, so a cached object is the empty
  // placeholder — the reply stayed invisible until a refresh or a new id.
  interface ThreadDerived {
    groups: ReturnType<typeof threadGroups>
    collapsed: Set<string>
    repliesByRoot: Map<string, number>
    rootIdByMessage: Map<string, string>
  }
  const threadDerivedCache = useRef<{ key: string; value: ThreadDerived } | null>(null)
  const threadGroupKey = messages
    .map((m) => `${m.id}>${m.replyTo?.id ?? ''}:${m.replyTo?.thread === true ? 't' : 'q'}`)
    .join('|')
  const computeThreadDerived = (): ThreadDerived => {
    const groups = threadGroups(messages)
    const collapsed = new Set<string>()
    const repliesByRoot = new Map<string, number>()
    const rootIdByMessage = new Map<string, string>()
    for (const g of groups) {
      if (g.replies.length > 0) repliesByRoot.set(g.root.id, g.replies.length)
      for (const member of g.all) rootIdByMessage.set(member.id, g.root.id)
      for (const r of g.replies) collapsed.add(r.id)
    }
    return { groups, collapsed, repliesByRoot, rootIdByMessage }
  }
  const threadDerived: ThreadDerived =
    threadDerivedCache.current?.key === threadGroupKey
      ? threadDerivedCache.current.value
      : computeThreadDerived()
  threadDerivedCache.current = { key: threadGroupKey, value: threadDerived }
  const { repliesByRoot } = threadDerived
  const topLevel = useMemo(
    () => messages.filter((m) => !threadDerived.collapsed.has(m.id)),
    [messages, threadDerived],
  )
  const threadGroupsMemo = useMemo(
    () => withCurrentMessages(threadDerived.groups, messages),
    [messages, threadDerived],
  )

  return { repliesByRoot, topLevel, threadGroupsMemo, rootIdByMessage: threadDerived.rootIdByMessage }
}
