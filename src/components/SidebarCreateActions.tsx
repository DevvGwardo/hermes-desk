import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Icon } from './ui/icons'

export function SidebarCreateActions({ compact, onNewConversation, onCreateGroup }: {
  compact: boolean
  onNewConversation: () => void
  onCreateGroup?: () => void
}) {
  return <div className="hd-new-chat-actions">
    {compact
      ? <IconButton className="hd-new-chat" size="md" aria-label="New chat" tooltipPortal tooltipSide="right"
        onClick={onNewConversation}><Icon name="plus" size={18} /></IconButton>
      : <Button className="hd-new-chat" onClick={onNewConversation}><Icon name="plus" size={18} />New chat</Button>}
    {!compact && onCreateGroup && <IconButton aria-label="New shared room" onClick={onCreateGroup}>
      <Icon name="users" size={18} />
    </IconButton>}
  </div>
}
