/**
 * After a specialist side chat finishes, fold the result into the parent
 * turn (Grok CheckSubagent). Does not block the composer — the parent already
 * has the user message and can keep talking while the worker runs.
 */

import {
  getMessagesForConversation,
  getState,
  subscribe,
} from './agents/store'
import type { Conversation, SubagentRun } from './agents/types'
import { parentContinuationPrompt } from './peer-roster'
import { isPlaceholderResult, usableSubagentBody } from './subagent-result'
import { waitForSubagent } from './subagent-status'

const inflight = new Set<string>()
const continued = new Set<string>()
const knownStatus = new Map<string, SubagentRun['status']>()
let watching = false
let stopWatch: (() => void) | null = null

export function resetSubagentContinuations(): void {
  inflight.clear()
  continued.clear()
  knownStatus.clear()
  stopWatch?.()
}

function lastUserAsk(conversationId: string): string {
  const msgs = getMessagesForConversation(conversationId)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m?.role !== 'user') continue
    const text = m.content.trim()
    if (!text || text.startsWith('[Desktop]')) continue
    return text
  }
  return ''
}

function waitUntilParentIdle(conversationId: string, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unsub()
      resolve()
    }
    const check = () => {
      const streaming = (getMessagesForConversation(conversationId) ?? []).some((m) => m.streaming)
      if (!streaming || Date.now() - started > timeoutMs) finish()
    }
    const unsub = subscribe(check)
    check()
    if (!settled) timer = setTimeout(finish, timeoutMs)
  })
}

function bodyWorthContinuing(run: SubagentRun): string | null {
  const body = usableSubagentBody(run)
  if (!body || body === '(no result)' || isPlaceholderResult(body)) return null
  return body
}

function continuationKey(conversationId: string, run: SubagentRun, body: string): string {
  return `${conversationId}:${run.label ?? run.kind}:${run.status}:${body}`
}

export async function continueAfterSubagent(args: {
  runId: string
  userText: string
  conversation: Conversation
  send: (text: string) => Promise<unknown>
}): Promise<SubagentRun | null> {
  if (continued.has(args.runId) || inflight.has(args.runId)) {
    return getState().subagentsById[args.runId] ?? null
  }
  inflight.add(args.runId)
  let key: string | null = null
  try {
    let done: SubagentRun
    try {
      done = await waitForSubagent(args.runId, 600_000)
    } catch {
      done = getState().subagentsById[args.runId] ?? ({ id: args.runId } as SubagentRun)
    }
    if (continued.has(args.runId)) return done
    const body = bodyWorthContinuing(done)
    if (!body) return done
    key = continuationKey(args.conversation.id, done, body)
    if (continued.has(key) || inflight.has(key)) return done
    inflight.add(key)
    const promptUser = args.userText.trim() || lastUserAsk(args.conversation.id)
    await waitUntilParentIdle(args.conversation.id)
    if (continued.has(args.runId) || continued.has(key)) return done
    continued.add(args.runId)
    continued.add(key)
    await args.send(parentContinuationPrompt(done, promptUser))
    return done
  } finally {
    inflight.delete(args.runId)
    if (key) inflight.delete(key)
  }
}

/** When a `delegate_task` child actually finishes, prompt the parent to summarize. */
export function startDelegateContinuations(
  send: (conversation: Conversation, prompt: string) => Promise<unknown>,
): () => void {
  if (watching) return stopWatch ?? (() => {})
  watching = true
  for (const run of Object.values(getState().subagentsById)) {
    knownStatus.set(run.id, run.status)
  }
  const unsub = subscribe(() => {
    for (const run of Object.values(getState().subagentsById)) {
      const prev = knownStatus.get(run.id)
      knownStatus.set(run.id, run.status)
      if (run.source !== 'delegate_task') continue
      if (run.status !== 'completed' && run.status !== 'failed') continue
      if (prev === run.status || prev === undefined) continue
      if (continued.has(run.id) || inflight.has(run.id)) continue
      const conv = getState().conversations.find((c) => c.id === run.conversationId)
      if (!conv) continue
      void continueAfterSubagent({
        runId: run.id,
        userText: lastUserAsk(conv.id),
        conversation: conv,
        send: (prompt) => send(conv, prompt),
      })
    }
  })
  stopWatch = () => {
    unsub()
    watching = false
    stopWatch = null
  }
  return stopWatch
}
