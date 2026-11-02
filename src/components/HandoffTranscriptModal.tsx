import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { enterSends } from '../lib/composer-enter'
import { AppModal } from './AppModal'
import { AgentMascot } from './agent-identity'
import { MessageBody } from './MessageBody'
import { displayUserPrompt } from '../lib/peer-roster'
import { buildHandoffTranscript, handoffReplyTarget, type HandoffTranscriptEntry } from '../lib/agents/handoff-transcript'
import type { HandoffStrip } from '../lib/agents/rooms'
import type { ChatMessage } from '../lib/agents/types'
import type { MentionMember } from '../lib/mentions'

/**
 * The full conversation behind a hand-off strip, opened by clicking a pill:
 * who asked what, each member's reply (or where it stands), nested
 * hand-offs indented under the reply that made them, then the wrap-up.
 * Opens scrolled to the member whose pill was clicked.
 */
export function HandoffTranscriptModal({
  open,
  rowId,
  focusTurnId,
  strips,
  threadStrips,
  messages,
  agentName,
  mentions,
  onJump,
  onReply,
  onClose,
}: {
  open: boolean
  /** Row of the message that handed off (the strip's key). */
  rowId: string | null
  /** The clicked pill's turn — scrolled into view on open. */
  focusTurnId: string | null
  strips: ReadonlyMap<string, HandoffStrip>
  /** Strips incl. human-started turns: threads follow-ups' answers. */
  threadStrips?: ReadonlyMap<string, HandoffStrip> | null
  messages: readonly ChatMessage[]
  agentName?: (id: string) => string
  mentions?: MentionMember[]
  /** Scroll the chat to a row (the modal closes first). */
  onJump?: (rowId: string) => void
  /** Send a reply into this hand-off (the room's own send, as a reply to
   *  `target` so the server routes it to that member). Absent: read-only. */
  onReply?: (text: string, target: ChatMessage) => void
  onClose: () => void
}) {
  const entries = useMemo(() => {
    if (!open || !rowId) return []
    return buildHandoffTranscript(rowId, strips, new Map(messages.map((m) => [m.id, m])), {
      threadStrips,
      ordered: messages,
    })
  }, [open, rowId, strips, threadStrips, messages])
  // The member whose pill opened the modal is who the user wants to talk to.
  const focusMember = useMemo(() => {
    const e = focusTurnId ? entries.find((x) => x.turnId === focusTurnId) : undefined
    return e ? (e.kind === 'status' ? e.memberId : (e.message.fromAgentId ?? null)) : null
  }, [entries, focusTurnId])
  const target = useMemo(() => handoffReplyTarget(entries, focusMember), [entries, focusMember])
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const inputId = useId()
  useEffect(() => {
    if (!open) setDraft('')
  }, [open])
  const send = () => {
    const text = draft.trim()
    if (!text || !target || !onReply) return
    const mention = target.mention ? `@${target.mention.name}` : null
    onReply(mention && !text.includes(mention) ? `${mention} ${text}` : text, target.message)
    setDraft('')
    inputRef.current?.focus()
  }
  // A reply lands at the bottom: follow it there.
  const lastKey = entries.length ? entries[entries.length - 1]!.kind + String(entries.length) : ''
  useEffect(() => {
    if (!open || !lastKey || !onReply) return
    const list = listRef.current
    const scroller = list?.parentElement
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [open, lastKey, onReply])

  const strip = rowId ? strips.get(rowId) : undefined
  const title = strip
    ? `Hand-off to ${strip.pills.map((p) => p.name).join(', ')}`
    : 'Hand-off'

  const listRef = useRef<HTMLOListElement | null>(null)
  useEffect(() => {
    if (!open || !focusTurnId) return
    // After the modal's enter frame so the target has layout.
    const id = window.requestAnimationFrame(() => {
      const el = listRef.current?.querySelector(`[data-turn-id="${CSS.escape(focusTurnId)}"]`)
      if (el instanceof HTMLElement) el.scrollIntoView?.({ block: 'start' })
    })
    return () => window.cancelAnimationFrame(id)
  }, [open, focusTurnId, entries.length])

  const nameOf = (id: string | undefined) => (id && agentName ? agentName(id) : 'Agent')

  const replyBox =
    onReply && target ? (
      <form
        className="flex flex-col gap-1.5 border-t border-[var(--ca-border)] px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <label htmlFor={inputId} className="text-[11px] leading-none text-[var(--ca-ink-muted)]">
          {target.mention
            ? `To ${target.mention.name}`
            : `Replying to ${target.message.role === 'user' ? 'you' : nameOf(target.message.fromAgentId)}`}
        </label>
        {/* Field and button share one row and one height, so they line up
            top and bottom while the field grows upward with the draft. */}
        <div className="flex items-end gap-2">
          <textarea
            id={inputId}
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && enterSends()) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="Reply in this hand-off…"
            aria-label="Reply in this hand-off"
            className="block max-h-32 min-h-[38px] min-w-0 flex-1 resize-none rounded-xl border border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-3.5 py-2 text-[14px] leading-5 text-[var(--ca-ink)] outline-none focus:border-[var(--ca-focus-ring)]"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="h-[38px] shrink-0 rounded-xl bg-[var(--ca-primary-fill)] px-4 text-[13px] font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    ) : null

  return (
    <AppModal open={open} onClose={onClose} title={title} size="lg" footer={replyBox}>
      {/* The body reserves an 8px scrollbar gutter on the right (index.css
          scrollbar width), so the right padding is 8px short of the left to
          keep the cards centred under the header. */}
      <ol ref={listRef} className="flex flex-col gap-3 py-4 pl-5 pr-3" data-testid="handoff-transcript">
        {entries.length === 0 && (
          <li className="text-[13px] text-[var(--ca-ink-muted)]">
            This hand-off&apos;s messages aren&apos;t loaded any more.
          </li>
        )}
        {entries.map((e, i) => (
          <Entry
            key={e.kind === 'message' ? e.rowId : `status-${e.turnId ?? e.memberId}-${i}`}
            entry={e}
            nameOf={nameOf}
            mentions={mentions}
            focused={Boolean(focusTurnId) && e.turnId === focusTurnId}
            onJump={
              onJump && e.kind === 'message'
                ? () => {
                    onClose()
                    onJump(e.rowId)
                  }
                : undefined
            }
          />
        ))}
      </ol>
    </AppModal>
  )
}

/** How far each nesting level steps in. */
const INDENT_PX = 16

function Entry({
  entry,
  nameOf,
  mentions,
  focused,
  onJump,
}: {
  entry: HandoffTranscriptEntry
  nameOf: (id: string | undefined) => string
  mentions?: MentionMember[]
  focused: boolean
  onJump?: () => void
}) {
  const depth = Math.min(entry.depth, 4)
  const indent = { marginLeft: `${depth * INDENT_PX}px` }
  // One rail per ancestor, from the gap above down this row, so a nested
  // reply visibly hangs off the message that handed it off.
  const rails = Array.from({ length: depth }, (_, k) => (
    <span
      key={k}
      aria-hidden="true"
      className="pointer-events-none absolute -bottom-px -top-[13px] w-px bg-[var(--ca-border-strong)]"
      style={{ left: `${-(k * INDENT_PX) - INDENT_PX / 2 - 1}px` }}
    />
  ))
  // The focused row swaps its border for the accent instead of stacking a
  // ring on top of it (a ring around a dashed border reads as two outlines).
  const edge = focused ? 'border-solid border-[var(--ca-primary)]' : ''

  if (entry.kind === 'status') {
    return (
      <li
        data-turn-id={entry.turnId ?? undefined}
        data-state={entry.state}
        data-focused={focused || undefined}
        style={indent}
        className={`relative flex min-w-0 items-center gap-2 rounded-2xl border border-dashed border-[var(--ca-border-strong)] px-3.5 py-2.5 text-[12px] leading-4 ${edge}`}
      >
        {rails}
        <span className="flex shrink-0">
          <AgentMascot agentId={entry.memberId} size={16} />
        </span>
        <span className="shrink-0 whitespace-nowrap font-semibold text-[var(--ca-ink)]">{entry.name}</span>
        {/* Status text can come from the server; it must never widen the modal. */}
        <span className="min-w-0 truncate text-[var(--ca-ink-muted)]" title={entry.label}>
          {entry.label}
        </span>
      </li>
    )
  }

  const m = entry.message
  const isUser = m.role === 'user'
  const who = isUser ? 'You' : nameOf(m.fromAgentId)
  const time = formatTime(m.createdAt)
  return (
    <li
      data-turn-id={entry.turnId ?? undefined}
      data-focused={focused || undefined}
      style={indent}
      className={`relative rounded-2xl border border-[var(--ca-border)] px-3.5 py-2.5 ${
        isUser ? 'bg-[var(--ca-primary-soft)]' : ''
      } ${edge}`}
    >
      {rails}
      <div className="mb-1 flex items-center gap-2 text-[12px] leading-4">
        {!isUser && m.fromAgentId && (
          <span className="flex shrink-0">
            <AgentMascot agentId={m.fromAgentId} size={16} />
          </span>
        )}
        <span className="font-semibold text-[var(--ca-ink)]">{who}</span>
        {time && <span className="text-[var(--ca-ink-muted)]">{time}</span>}
        {onJump && (
          <button
            type="button"
            onClick={onJump}
            className="-mr-2 ml-auto rounded-full px-2 py-0.5 text-[11px] text-[var(--ca-ink-muted)] hover:bg-[var(--ca-primary-soft)] hover:text-[var(--ca-ink)]"
          >
            Show in chat
          </button>
        )}
      </div>
      <div className="text-[14px] leading-relaxed text-[var(--ca-ink)]">
        <MessageBody
          content={isUser ? displayUserPrompt(m.content) : m.content}
          variant={isUser ? 'plain' : 'markdown'}
          mentions={mentions}
        />
      </div>
    </li>
  )
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
