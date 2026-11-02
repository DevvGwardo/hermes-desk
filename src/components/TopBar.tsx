import { memo, useEffect, useRef, useState } from 'react'
import { PluginSlot } from '../plugins/PluginHost'
import type { Agent, Conversation, Group } from '../lib/agents'
import type { AgentMascotPresence } from './AgentMascot'
import { activityTime } from '../lib/agents/roster'
import { Icon } from './ui/icons'
import { IconButton } from './ui/IconButton'
import { Button } from './ui/Button'
import { Toolbar } from './ui/Toolbar'
import { HudOrbButton } from './HudOrbButton'
import { NotificationsBell } from './NotificationsBell'
import '../styles/skin-messenger.css'
import '../styles/desk-pages.css'

interface TopBarProps {
  agent: Agent | null
  /** False when another main view covers the retained chat. */
  active?: boolean
  group?: Group | null
  showInfo: boolean
  onToggleInfo: () => void
  showFiles?: boolean
  onToggleFiles?: () => void
  /** True while this conversation's agent is actually working. */
  live?: boolean
  /** Spoken status under the name (Working… / Updating… / tool sentence). */
  statusLine?: string | null
  /** First-paint hydrate — avoid a fake "Select an agent" while the roster loads. */
  hydrating?: boolean
  skin?: 'messenger' | 'classic'
  onToggleWorkspace?: () => void
  workspaceOpen?: boolean
  onOpenComputer?: () => void
  mascotPresence?: AgentMascotPresence
  conversationTitle?: string
  conversations?: Conversation[]
  onSelectConversation?: (id: string) => void
  onNewChat?: () => void
}

/** True when a keyboard event originates inside a text-entry field. */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

export const TopBar = memo(function TopBar({
  agent,
  active = true,
  group,
  showInfo,
  onToggleInfo,
  showFiles,
  onToggleFiles,
  live = false,
  statusLine,
  hydrating = false,
  skin = 'messenger',
  onToggleWorkspace,
  workspaceOpen = false,
  onOpenComputer,
  conversationTitle,
  conversations = [],
  onSelectConversation,
  onNewChat,
}: TopBarProps) {
  const [more, setMore] = useState(false)
  const [recent, setRecent] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const recentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!more) return
    menuRef.current?.querySelector<HTMLButtonElement>('[role="dialog"] button')?.focus()
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMore(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [more])
  useEffect(() => {
    if (!recent) return
    recentRef.current?.querySelector<HTMLButtonElement>('[role="dialog"] button')?.focus()
    const dismiss = (event: PointerEvent) => {
      if (!recentRef.current?.contains(event.target as Node)) setRecent(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [recent])

  const identity = group?.name ?? agent?.name ?? 'Choose an agent'
  const title = conversationTitle && conversationTitle !== 'New conversation' ? conversationTitle : 'New chat'
  const subtitle = hydrating ? 'Loading agents…' : statusLine || (live ? 'Working…' : 'Ready')
  const attention = /approval|permission|waiting|failed|error/i.test(subtitle)
  const recentChats = conversations.filter(chat => !chat.hiddenFromSidebar && !chat.placeholder &&
    (agent ? chat.target.type === 'agent' && chat.target.agentId === agent.id : group ? chat.target.type === 'group' && chat.target.groupId === group.id : true))
    .sort((a, b) => activityTime(b.lastUsedAt) - activityTime(a.lastUsedAt)).slice(0, 8)

  // Alt+Left/Right history nav — skipped inside text fields where the keys
  // move the caret / switch words.
  useEffect(() => {
    if (!active) return
    function onKey(e: globalThis.KeyboardEvent) {
      if (!e.altKey || e.metaKey || e.ctrlKey) return
      if (isTextEntryTarget(e.target)) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('maia:go-back'))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('maia:go-forward'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  return (
    <header data-skin={skin} className="desk-theme messenger-header relative z-20 shrink-0"
      >
      <div className="messenger-header-leading">
        <IconButton aria-label="Toggle sidebar" shortcut="⌘B" tooltipSide="bottom" onClick={() => window.dispatchEvent(new CustomEvent('maia:toggle-sidebar-compact'))}><Icon name="sidebar" /></IconButton>
        <PluginSlot area="titleBar.left" className="flex items-center gap-1" />
      </div>
      <div className="desk-chat-heading">
        <h1 title={title}>{title}</h1>
        <button type="button" className="desk-chat-identity" onClick={onToggleInfo} aria-label={`Show info for ${identity}`} aria-pressed={showInfo} title={`${identity} · ${subtitle}`}>
          <span>{identity}</span><span aria-hidden="true"> · </span><span className="desk-chat-status" data-attention={attention} data-live={live}>{subtitle}</span>
        </button>
      </div>
      <div className="messenger-header-trailing flex items-center gap-1 justify-self-end">
        <PluginSlot area="titleBar.right" className="flex items-center gap-1" />
        {onSelectConversation && <div ref={recentRef} className="relative">
          <IconButton aria-label="Recent chats" aria-haspopup="dialog" aria-expanded={recent} onClick={() => { setMore(false); setRecent(value => !value) }}><Icon name="reply" /></IconButton>
          {recent && <div className="messenger-header-menu" role="dialog" aria-label="Recent chats" data-esc-layer onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRecent(false); recentRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }
          }}>
            {recentChats.map(chat => <Button key={chat.id} onClick={() => { onSelectConversation(chat.id); setRecent(false) }}>{chat.title === 'New conversation' ? 'New chat' : chat.title}</Button>)}
            {!recentChats.length && <p>No chats yet.</p>}
            {onNewChat && <Button onClick={() => { onNewChat(); setRecent(false) }}>New chat</Button>}
          </div>}
        </div>}
        <IconButton aria-label="Toggle workspace" active={workspaceOpen} tooltipSide="bottom" onClick={onToggleWorkspace} disabled={!onToggleWorkspace}><Icon name="workspace" /></IconButton>
        <div ref={menuRef} className="relative">
          <IconButton aria-label="More chat actions" aria-expanded={more} aria-haspopup="dialog" tooltipSide="bottom" onClick={() => { setRecent(false); setMore(value => !value) }}><Icon name="more" /></IconButton>
          {more && <div role="dialog" aria-label="More chat actions" data-esc-layer className="messenger-header-menu absolute right-0 top-full z-30 flex min-w-44 flex-col gap-1 rounded-xl bg-[var(--desk-surface-3)] p-2" onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMore(false); menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }
          }}>
            <Toolbar aria-label="Conversation history">
              <IconButton aria-label="Go back" shortcut="Alt+←" onClick={() => window.dispatchEvent(new CustomEvent('maia:go-back'))}><Icon name="back" /></IconButton>
              <IconButton aria-label="Go forward" shortcut="Alt+→" onClick={() => window.dispatchEvent(new CustomEvent('maia:go-forward'))}><Icon name="forward" /></IconButton>
            </Toolbar>
            {onNewChat && <Button onClick={() => { onNewChat(); setMore(false) }}><Icon name="plus" size={16} />New chat</Button>}
            <Button aria-keyshortcuts="Meta+F" onClick={() => { window.dispatchEvent(new CustomEvent('maia:find-in-chat')); setMore(false) }}><Icon name="search" size={16} />Find in chat<span className="ml-auto text-[11px] text-[var(--ca-ink-muted)]" aria-hidden="true">⌘F</span></Button>
            <Button onClick={() => { onToggleInfo(); setMore(false) }}>Agent details</Button>
            {onToggleFiles && <Button aria-label="Toggle files" aria-pressed={showFiles ?? false} onClick={() => { onToggleFiles(); setMore(false) }}><Icon name="folder" size={16} />Files</Button>}
            {onOpenComputer && <Button onClick={() => { onOpenComputer(); setMore(false) }}><Icon name="computer" size={16} />Computer capture</Button>}
            {window.nubAgent?.hud && <div className="flex items-center gap-2"><HudOrbButton /><span>Pip HUD</span></div>}
            <div className="flex items-center gap-2"><NotificationsBell /><span>Notifications</span></div>
          </div>}
        </div>
      </div>
    </header>
  )
})
