import type { MessageReplyTo } from '../../lib/agents'
import '../../styles/skin-messenger.css'

export function QuotedReply({
  replyTo,
  sender,
  onJump,
}: {
  replyTo: MessageReplyTo
  sender?: string
  onJump?: (messageId: string) => void
}) {
  const name = sender || (replyTo.role === 'user' ? 'You' : 'Hermes')
  return (
    <button
      type="button"
      className="messenger-quote"
      data-testid="quoted-reply"
      aria-label={`Go to message from ${name}`}
      disabled={!onJump}
      onClick={() => onJump?.(replyTo.id)}
    >
      <span className="messenger-quote-sender">{name}</span>
      <span className="messenger-quote-text">{replyTo.snippet.replace(/\s+/g, ' ').trim() || '(empty)'}</span>
    </button>
  )
}
