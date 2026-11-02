/**
 * Edit-and-resend and Ask again for the chat transcript.
 *
 * The conversation lives on the agent (hermes keeps the session), so neither
 * action rewrites history: Ask again sends the same prompt as a new turn, and
 * Edit puts a sent message back in the composer to change and send as a new
 * one. What the transcript shows stays what the agent remembers, and a reload
 * never brings back rows the app had hidden.
 */
import { isReplyPartRow } from './agents/answer-placement'
import type { ChatMessage } from './agents'

/** The prompt a reply answered: the last user message that is not an answer
 *  typed to a question the agent asked mid-turn. */
function isPrompt(m: ChatMessage): boolean {
  return m.role === 'user' && !m.answerAt && !m.pending
}

/**
 * Which reply offers Ask again, and the prompt it resends. Only the newest
 * reply to the newest prompt: an older answer was followed by more
 * conversation, so "again" would no longer mean the same question. Not while
 * that reply is still streaming, and not on a failed turn (it has Retry).
 */
export function askAgainTarget(messages: readonly ChatMessage[]): { rowId: string; prompt: ChatMessage } | null {
  let promptIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isPrompt(messages[i]!)) {
      promptIdx = i
      break
    }
  }
  if (promptIdx < 0) return null
  const prompt = messages[promptIdx]!
  if (!prompt.content.trim()) return null
  for (let i = messages.length - 1; i > promptIdx; i--) {
    const m = messages[i]!
    // An agent-to-agent note ("from Ops Runner") is not a reply to you.
    if (m.role !== 'agent' || isReplyPartRow(m) || (m.fromAgentId && m.toAgentId)) continue
    if (m.streaming || m.error) return null
    return { rowId: m.id, prompt }
  }
  return null
}

/** Composer text after Edit: the message replaces an empty draft, and goes
 *  under anything already typed so Edit never throws work away. */
export function draftAfterEdit(draft: string, text: string): string {
  return draft.trim() ? `${draft.trimEnd()}\n\n${text}` : text
}

/** Files a prompt carried that still sit on the agent computer, so Ask again
 *  sends them too. */
export function resendableAttachments(
  m: ChatMessage,
): { name: string; path: string; kind: 'file' | 'image'; size?: number }[] {
  return (m.attachments ?? []).flatMap((a) =>
    a.path ? [{ name: a.name, path: a.path, kind: a.kind, ...(a.size !== undefined ? { size: a.size } : {}) }] : [],
  )
}
