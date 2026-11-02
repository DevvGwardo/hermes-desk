import type { ChatMessage } from '../../lib/agents'
import { Icon } from '../ui/icons'
import '../../styles/skin-messenger.css'

/** A reply's content/activity proves pickup, an optimistic empty row does not.
 * CONTRACT: pass pickedUpMessageIds to ChatPanel for exact message.start receipts;
 * the shared ChatMessage shape currently has no delivery/read-receipt field. */
export function inferredPickedUpIds(messages: ChatMessage[]): ReadonlySet<string> {
  const picked = new Set<string>()
  let waiting: ChatMessage[] = []
  for (const message of messages) {
    if (message.role === 'user' && !message.pending) waiting.push(message)
    if (message.role !== 'agent' || message.error) continue
    if (!message.content.trim() && !message.reasoning && !message.toolEvents?.length && !message.hermesRowId) continue
    const remaining: ChatMessage[] = []
    for (const user of waiting) {
      if (user.turnId && message.turnId && user.turnId !== message.turnId) remaining.push(user)
      else picked.add(user.id)
    }
    waiting = remaining
  }
  return picked
}

export function messengerTime(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
}

export function ReadTicks({ pickedUp = false, pending = false }: { pickedUp?: boolean; pending?: boolean }) {
  if (pending) return null
  return (
    <span role="img" className="messenger-read-ticks" aria-label={pickedUp ? 'Picked up by agent' : 'Sent'} data-testid="read-ticks">
      <Icon name={pickedUp ? 'check-double' : 'check'} size={14} />
    </span>
  )
}
