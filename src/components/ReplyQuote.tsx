import { clipReplySnippet, REPLY_PILL_CHARS, REPLY_QUOTE_CHARS } from '../lib/message-actions'
import type { MessageReplyTo } from '../lib/agents'

function ArrowUpRightIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 12c2.4-1.1 4.2-3.2 5.2-6.2M9.2 5.8H12V8.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function ReplyQuote({
  replyTo,
  variant = 'quote',
  onUser,
}: {
  replyTo: MessageReplyTo
  variant?: 'quote' | 'pill'
  onUser?: boolean
}) {
  const max = variant === 'pill' ? REPLY_PILL_CHARS : REPLY_QUOTE_CHARS
  const label = clipReplySnippet(replyTo.snippet, max) || '(empty)'
  const muted = onUser
    ? 'text-white/90'
    : 'text-[var(--ca-ink-muted)]'
  return (
    <div
      className={`sand-reply-quote flex min-w-0 items-center gap-1.5 ${
        variant === 'pill' ? 'text-[12px]' : 'mb-1.5 text-[12px]'
      } ${muted}`}
    >
      <span className="sand-reply-quote__lead shrink-0 opacity-80">
        <ArrowUpRightIcon size={variant === 'pill' ? 14 : 12} />
      </span>
      <span className="sand-reply-quote__label min-w-0 truncate">{label}</span>
    </div>
  )
}

/** Grok `sand-prompt-reply-pill` — sits above the composer. */
export function ReplyPill({
  replyTo,
  onClear,
}: {
  replyTo: MessageReplyTo
  onClear: () => void
}) {
  return (
    <div
      className="sand-prompt-reply-pill mb-2 flex items-center gap-2 rounded-xl border border-[var(--ca-border)] bg-[var(--ca-hover)] px-2.5 py-1.5"
      role="region"
      aria-label="Replying"
    >
      <span className="sand-prompt-reply-pill__lead shrink-0 text-[var(--ca-ink-muted)]">
        <ArrowUpRightIcon size={14} />
      </span>
      <span className="sand-prompt-reply-pill__body min-w-0 flex-1 truncate text-[12px] text-[var(--ca-ink-muted)]">
        {clipReplySnippet(replyTo.snippet, REPLY_PILL_CHARS) || '(empty)'}
      </span>
      <button
        type="button"
        aria-label="Cancel reply"
        onClick={onClear}
        className="sand-prompt-reply-pill__clear rounded-full p-1 text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]"
      >
        <CloseIcon />
      </button>
    </div>
  )
}
