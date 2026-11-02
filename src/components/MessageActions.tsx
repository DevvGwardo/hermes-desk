import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  clipReplySnippet,
  groupReactions,
  MORE_EMOJI,
  QUICK_REACTIONS,
  replyPreviewFromMessage,
} from '../lib/message-actions'
import type { ChatMessage, MessageReaction, MessageReplyTo } from '../lib/agents'
import { getState } from '../lib/agents/store'
import { genUiSummaryText } from '../lib/search-index'
import { Icon } from './ui/icons'
import { Tooltip } from './ui/Tooltip'

export function replyPreviewForMessage(msg: ChatMessage): MessageReplyTo {
  const base = replyPreviewFromMessage(msg)
  if (base.snippet || msg.role !== 'agent') return base
  return {
    ...base,
    snippet: clipReplySnippet(genUiSummaryText(msg.toolEvents)),
  }
}

import '../styles/skin-messenger.css'


function SmileyPlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 5.6v4.8M5.6 8h4.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function ArrowReplyIcon({ outgoing }: { outgoing: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={outgoing ? undefined : { transform: 'scaleX(-1)' }}
    >
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

/** A4: stacked-bubbles glyph for the Reply-in-thread action. */
function ThreadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="5.5" width="9" height="6.5" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 3.2h7A1.3 1.3 0 0113.8 4.5v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}


function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="5.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.5 10.5V3.8A1.3 1.3 0 014.8 2.5h6.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.4 3.3a1.4 1.4 0 012 2L5.6 12.1 3 12.9l.8-2.6 6.6-7z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function AskAgainIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M12.6 7.2A4.7 4.7 0 104.1 10.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12.9 3.9v3.4H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function HoverBtn({
  label,
  onClick,
  expanded,
  disabled,
  children,
}: {
  label: string
  onClick?: () => void
  expanded?: boolean
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip content={label} side="top" disabled={expanded}>
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : 'menu'}
      disabled={disabled}
      onClick={onClick}
      className="sand-message-hover-actions__button grid size-7 place-items-center rounded-full text-[var(--ca-ink-muted)] hover:bg-[var(--ca-primary-soft)] hover:text-[var(--ca-ink)] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
    >
      {children}
    </button>
    </Tooltip>
  )
}

function ReactionPicker({
  myEmoji,
  onSelect,
  onClose,
}: {
  myEmoji?: string
  onSelect: (emoji: string) => void
  onClose: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDoc(e: globalThis.MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const q = query.trim().toLowerCase()
  const filtered = MORE_EMOJI.map((cat) => ({
    ...cat,
    emojis: q ? cat.emojis.filter((e) => e.includes(q) || cat.label.toLowerCase().includes(q)) : cat.emojis,
  })).filter((cat) => cat.emojis.length > 0)

  return (
    <div
      ref={rootRef}
      className={`sand-reaction-picker absolute bottom-full z-30 mb-1 rounded-xl border border-[var(--ca-border)] bg-[var(--ca-card)] p-1 shadow-[var(--ca-shadow-soft)] ${
        expanded ? 'w-[18rem]' : 'flex items-center gap-0.5'
      }`}
      role="group"
      aria-label="Add reaction"
      data-esc-layer
    >
      {expanded ? (
        <div>
          <input
            autoFocus
            aria-label="Search emoji"
            placeholder="Search emoji"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="mb-1 w-full border-b border-[var(--ca-border)] bg-transparent px-2 py-1 text-[12px] outline-none"
          />
          <div className="sand-emoji-picker__results max-h-56 overflow-y-auto">
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-center text-[12px] text-[var(--ca-ink-muted)]">No emoji found</p>
            )}
            {filtered.map((cat) => (
              <div key={cat.id} className="mb-1">
                <div className="px-1.5 pt-1 text-[10px] uppercase tracking-wider text-[var(--ca-ink-muted)]">
                  {q ? 'Results' : cat.label}
                </div>
                <div className="flex flex-wrap px-0.5">
                  {cat.emojis.map((emoji) => (
                    <button
                      key={`${cat.id}-${emoji}`}
                      type="button"
                      aria-label={emoji}
                      aria-pressed={myEmoji === emoji}
                      onClick={() => onSelect(emoji)}
                      className={`grid size-8 place-items-center rounded-md text-base hover:bg-[var(--ca-primary-soft)] ${
                        myEmoji === emoji ? 'bg-[var(--ca-primary-soft)]' : ''
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={emoji}
              aria-pressed={myEmoji === emoji}
              onClick={() => onSelect(emoji)}
              className={`grid size-7 place-items-center rounded-md text-base hover:bg-[var(--ca-primary-soft)] ${
                myEmoji === emoji ? 'bg-[var(--ca-primary-soft)]' : ''
              }`}
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            aria-label="More emoji"
            onClick={() => setExpanded(true)}
            className="sand-reaction-picker__more grid size-7 place-items-center rounded-md text-[var(--ca-ink-muted)] hover:bg-[var(--ca-primary-soft)] hover:text-[var(--ca-ink)]"
          >
            <SmileyPlusIcon />
          </button>
        </>
      )}
    </div>
  )
}

function reactorLabel(author: MessageReaction['author']): string {
  if (author === 'user') return 'You'
  const agents = getState().agents
  const hit = agents.find((a) => a.id === author)
  return hit?.name ?? author
}

export function ReactionPills({
  reactions,
  onToggle,
  align = 'start',
}: {
  reactions: MessageReaction[]
  onToggle?: (emoji: string) => void
  align?: 'start' | 'end'
}) {
  const grouped = groupReactions(reactions)
  if (grouped.length === 0) return null
  return (
    <div
      className={`sand-reaction-pills mt-1 flex flex-wrap gap-1 ${
        align === 'end' ? 'justify-end' : 'justify-start'
      }`}
    >
      {grouped.map((g) => {
        const who = g.reactors.map(reactorLabel).join(' and ')
        return (
          <button
            key={g.emoji}
            type="button"
            aria-label={`${who} reacted with ${g.emoji}. Toggle your ${g.emoji} reaction`}
            aria-pressed={g.isMine}
            disabled={!onToggle}
            onClick={() => onToggle?.(g.emoji)}
            className={`sand-reaction-pill inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[13px] leading-none ${
              g.isMine
                ? 'border-[var(--ca-primary)]/40 bg-[var(--ca-primary-soft)]'
                : 'border-[var(--ca-border)] bg-[var(--ca-hover)]'
            } ${onToggle ? 'hover:scale-105' : 'cursor-default'}`}
          >
            <span aria-hidden>{g.emoji}</span>
            {g.count > 1 && (
              <span className="text-[10px] text-[var(--ca-ink-muted)]">{g.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function MessageActionAnchor({
  msg,
  children,
  speakerName,
  onReply,
  onReplyInThread,
  onReact,
  onCopy: onCopyProp,
  onEdit,
  onAskAgain,
  onRetry,
  onBranch,
  retryBusy,
  wide = false,
  skin = 'classic',
}: {
  msg: ChatMessage
  children: ReactNode
  speakerName: string
  onReply?: () => void
  /** A4: open (or start) this message's reply-thread pane. */
  onReplyInThread?: () => void
  onReact?: (emoji: string | null) => void
  onCopy?: () => void | Promise<void>
  /** Your message: put its text back in the composer to change and resend. */
  onEdit?: () => void
  /** The latest reply: send the prompt behind it again for a fresh answer. */
  onAskAgain?: () => void
  onRetry?: () => void
  onBranch?: () => void
  retryBusy?: boolean
  wide?: boolean
  skin?: 'messenger' | 'classic'
}) {
  const [hovered, setHovered] = useState(false)
  /** The pointer is over the message: a blur mustn't hide the bar then. */
  const pointerInside = useRef(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [tapOpen, setTapOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [actionsBelow, setActionsBelow] = useState(false)
  const isUser = msg.role === 'user'
  const canAct = msg.role === 'user' || msg.role === 'agent'
  const fallbackCopyText = !onCopyProp && msg.role === 'agent' ? genUiSummaryText(msg.toolEvents) : ''
  const onCopy = useMemo(
    () =>
      onCopyProp ??
      (fallbackCopyText
        ? async () => {
            if (window.nubAgent?.clipboard?.writeText) {
              await window.nubAgent.clipboard.writeText(fallbackCopyText)
            } else {
              if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
              await navigator.clipboard.writeText(fallbackCopyText)
            }
          }
        : undefined),
    [onCopyProp, fallbackCopyText],
  )
  const myEmoji = msg.reactions?.find((r) => r.author === 'user')?.emoji
  // Touch devices have no hover: a tap on the bubble toggles the action
  // toolbar (long-press contextmenu stays as the alternate path). Desktop
  // keeps hover-only so a click never pops the toolbar over a selection.
  const hasHover = useMemo(() => {
    try {
      return window.matchMedia('(hover: hover)').matches
    } catch {
      return true
    }
  }, [])
  // Android long-press fires contextmenu, then sometimes a click — swallow
  // that first click so it doesn't instantly close the menu it just opened.
  const suppressTapRef = useRef(false)
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null)
  // Copy confirms in place (a check), and keeps the bar up while it shows.
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copiedTimer = useRef<number | null>(null)
  const copyAttempt = useRef(0)
  useEffect(
    () => () => {
      copyAttempt.current += 1
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
    },
    [],
  )
  const open = hovered || pickerOpen || menu != null || tapOpen || copied

  useLayoutEffect(() => {
    if (!open || skin !== 'messenger') return
    const anchor = rootRef.current
    if (!anchor) return
    const scroller = anchor.closest('[data-testid="chat-scroller"]')
    const place = () => {
      const box = anchor.getBoundingClientRect()
      const bounds = scroller?.getBoundingClientRect()
      const height = toolbarRef.current?.getBoundingClientRect().height || 32
      const top = Math.max(0, bounds?.top ?? 0)
      const bottom = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight)
      setActionsBelow(box.top - height - 4 < top && box.bottom + height + 4 <= bottom)
    }
    place()
    scroller?.addEventListener('scroll', place, { passive: true })
    window.addEventListener('resize', place)
    return () => {
      scroller?.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
    }
  }, [open, skin])

  useEffect(() => {
    if (!menu && !tapOpen) return
    function onDoc(e: globalThis.MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) {
        setMenu(null)
        setTapOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menu, tapOpen])

  // The right-click menu works from the keyboard: it takes focus on its
  // first item, Esc closes it (stopped here, so the app and the chat's own
  // Esc don't also act) and focus goes back to where it was, unless an
  // item moved it on purpose (Reply, Edit focus the composer).
  const menuRef = useRef<HTMLDivElement>(null)
  const menuOpen = menu != null
  useEffect(() => {
    if (!menuOpen) return
    const prev = document.activeElement as HTMLElement | null
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setMenu(null)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const now = document.activeElement
      if ((!now || now === document.body) && prev?.isConnected) prev.focus()
    }
  }, [menuOpen])

  if (!canAct) return <>{children}</>

  function pick(emoji: string) {
    onReact?.(emoji)
    setPickerOpen(false)
    setMenu(null)
  }

  function onContext(e: MouseEvent) {
    const sel = window.getSelection()
    if (sel && sel.toString().length > 0) return
    e.preventDefault()
    const MENU_W = 176
    const MENU_H = 280
    const vw = window.innerWidth
    const vh = window.innerHeight
    const x = Math.min(e.clientX, vw - MENU_W - 8)
    const y = Math.min(e.clientY, vh - MENU_H - 8)
    setMenu({ x: Math.max(8, x), y: Math.max(8, y) })
    setPickerOpen(false)
    suppressTapRef.current = true
  }

  async function copy() {
    const attempt = ++copyAttempt.current
    setCopied(false)
    setCopyFailed(false)
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
    try {
      const pending = onCopy?.()
      if (pending) await pending
    } catch {
      if (attempt === copyAttempt.current) setCopyFailed(true)
      return
    }
    if (attempt !== copyAttempt.current) return
    setCopied(true)
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1400)
  }

  const replyLabel = `Reply to ${speakerName}`

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      role="group"
      aria-label={`Message actions for ${speakerName}`}
      className={`sand-message-action-anchor relative w-fit max-w-[min(42rem,88%)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ca-primary)] ${
        open ? 'sand-message-action-anchor--menu-open' : ''
      }`}
      data-msg-role={isUser ? 'user' : 'agent'}
      data-wide={wide || undefined}
      onPointerEnter={() => {
        pointerInside.current = true
        setHovered(true)
      }}
      onPointerLeave={() => {
        pointerInside.current = false
        if (!pickerOpen && !menu) setHovered(false)
      }}
      onFocusCapture={() => setHovered(true)}
      // Focus leaving the message hides its bar (tabbing on left every bar
      // up, piling over the messages above), unless the pointer is still on
      // it or its picker / menu is open.
      onBlurCapture={(e) => {
        if (rootRef.current?.contains(e.relatedTarget as Node | null)) return
        if (!pointerInside.current && !pickerOpen && !menu) setHovered(false)
      }}
      onContextMenu={onContext}
      onPointerDown={(e) => {
        suppressTapRef.current = false
        if (skin === 'messenger' && e.pointerType === 'touch' && !(e.target as HTMLElement).closest('button, a, input, textarea')) {
          swipeStartRef.current = { x: e.clientX, y: e.clientY }
        }
      }}
      onPointerUp={(e) => {
        const start = swipeStartRef.current
        swipeStartRef.current = null
        if (onReply && start && Math.abs(e.clientX - start.x) > 56 && Math.abs(e.clientY - start.y) < 40 && !window.getSelection()?.toString()) {
          suppressTapRef.current = true
          onReply()
        }
      }}
      onPointerCancel={() => { swipeStartRef.current = null }}
      onClick={(e) => {
        // Swallow the click Android fires right after a long-press
        // contextmenu, so it can't close the menu it just opened.
        if (suppressTapRef.current) {
          suppressTapRef.current = false
          return
        }
        if (hasHover) return
        // Tapping the bubble toggles the action toolbar on touch. Leave
        // links, controls, reaction pills and the toolbar itself alone.
        if (menu != null) {
          setMenu(null)
          return
        }
        const t = e.target as HTMLElement
        if (
          t.closest('a') ||
          t.closest('button') ||
          t.closest('.sand-reaction-pill') ||
          t.closest('.sand-message-hover-actions')
        ) {
          return
        }
        if (window.getSelection()?.toString()) return
        setTapOpen((v) => !v)
      }}
    >
      {children}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
      {copyFailed && <p role="status" className="mt-1 text-[11px] text-[var(--ca-ink-muted)]">
        Could not copy. Select the text and copy it manually.
      </p>}
      <ReactionPills
        reactions={msg.reactions ?? []}
        align={isUser ? 'end' : 'start'}
        onToggle={onReact ? (emoji) => onReact(emoji) : undefined}
      />
      {open && (
        <div
          ref={toolbarRef}
          data-placement={actionsBelow ? 'below' : 'above'}
          className={`sand-message-hover-actions absolute bottom-full z-20 ${skin === 'messenger' ? 'messenger-message-actions' : 'mb-1'} flex items-center gap-0.5 rounded-full border border-[var(--ca-border)] bg-[var(--ca-hover)] px-0.5 py-0.5 ${
            isUser ? 'left-0' : 'right-0'
          }`}
          role="toolbar"
          aria-label={`Message actions for ${speakerName}`}
        >
          {onReact && (
            <div className="relative">
              <HoverBtn
                label="Add reaction"
                expanded={pickerOpen}
                onClick={() => {
                  setPickerOpen((v) => !v)
                }}
              >
                <Icon name="emoji" size={16} />
              </HoverBtn>
              {pickerOpen && (
                <div className={isUser ? 'absolute right-0' : 'absolute left-0'}>
                  <ReactionPicker
                    myEmoji={myEmoji}
                    onSelect={pick}
                    onClose={() => setPickerOpen(false)}
                  />
                </div>
              )}
            </div>
          )}
          {onReply && (
            <HoverBtn label={replyLabel} onClick={onReply}>
              <Icon name="reply" size={16} />
            </HoverBtn>
          )}
          {onReplyInThread && skin !== 'messenger' && (
            <HoverBtn label="Reply in thread" onClick={onReplyInThread}>
              <ThreadIcon />
            </HoverBtn>
          )}
          {onCopy && (
            <HoverBtn label={copied ? 'Copied' : 'Copy'} onClick={copy}>
              <Icon name={copied ? 'check' : 'copy'} size={16} />
            </HoverBtn>
          )}
          {onEdit && skin !== 'messenger' && (
            <HoverBtn label="Edit and resend" onClick={onEdit}>
              <PencilIcon />
            </HoverBtn>
          )}
          {onAskAgain && skin !== 'messenger' && (
            <HoverBtn label="Ask again" onClick={onAskAgain}>
              <AskAgainIcon />
            </HoverBtn>
          )}
          {onRetry && skin !== 'messenger' && <HoverBtn label={retryBusy ? 'Retrying…' : 'Retry'} disabled={retryBusy} onClick={onRetry}><Icon name="retry" size={16} /></HoverBtn>}
          {onBranch && skin !== 'messenger' && <HoverBtn label="Branch" onClick={onBranch}><Icon name="branch" size={16} /></HoverBtn>}
          {skin === 'messenger' && (onReplyInThread || onEdit || onAskAgain || onRetry || onBranch) && (
            <HoverBtn label="More message actions" expanded={menu !== null} onClick={() => {
              const rect = rootRef.current?.getBoundingClientRect()
              if (rect) setMenu({
                x: Math.max(8, Math.min(rect.right - 176, window.innerWidth - 184)),
                y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 288)),
              })
            }}><Icon name="more" size={16} /></HoverBtn>
          )}
        </div>
      )}
      {menu && createPortal(
        <div
          ref={menuRef}
          className="fixed z-40 min-w-[11rem] rounded-xl border border-[var(--ca-border)] bg-[var(--ca-card)] py-1 shadow-[var(--ca-shadow)]"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          aria-label="Message actions"
          data-esc-layer
          onKeyDown={(e) => {
            const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
            const at = items.indexOf(document.activeElement as HTMLElement)
            const go = (i: number) => {
              e.preventDefault()
              items[(i + items.length) % items.length]?.focus()
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowRight') go(at + 1)
            else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') go(at - 1)
            else if (e.key === 'Home') go(0)
            else if (e.key === 'End') go(items.length - 1)
            else if (e.key === 'Tab') setMenu(null)
          }}
        >
          {onReact && (
            <div className="flex items-center gap-0.5 border-b border-[var(--ca-border)] px-1 py-1">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="menuitem"
                  aria-label={emoji}
                  className="grid size-7 place-items-center rounded-md text-base hover:bg-[var(--ca-primary-soft)]"
                  onClick={() => pick(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
          {onReply && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--ca-primary-soft)]"
              onClick={() => {
                onReply()
                setMenu(null)
              }}
            >
              <ArrowReplyIcon outgoing={isUser} />
              Reply
            </button>
          )}
          {onReplyInThread && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--ca-primary-soft)]"
              onClick={() => {
                onReplyInThread()
                setMenu(null)
              }}
            >
              <ThreadIcon />
              Reply in thread
            </button>
          )}
          {onCopy && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--ca-primary-soft)]"
              onClick={() => {
                copy()
                setMenu(null)
              }}
            >
              <CopyIcon />
              Copy
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--ca-primary-soft)]"
              onClick={() => {
                onEdit()
                setMenu(null)
              }}
            >
              <PencilIcon />
              Edit and resend
            </button>
          )}
          {onAskAgain && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--ca-primary-soft)]"
              onClick={() => {
                onAskAgain()
                setMenu(null)
              }}
            >
              <AskAgainIcon />
              Ask again
            </button>
          )}
          {onRetry && (
            <button type="button" role="menuitem" disabled={retryBusy} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--ca-primary-soft)] disabled:opacity-50" onClick={() => { onRetry(); setMenu(null) }}>
              <AskAgainIcon />
              Retry
            </button>
          )}
          {onBranch && (
            <button type="button" role="menuitem" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--ca-primary-soft)]" onClick={() => { onBranch(); setMenu(null) }}>
              <ThreadIcon />
              Branch
            </button>
          )}
        </div>,
        rootRef.current?.closest('[data-skin]') ?? document.body,
      )}
    </div>
  )
}
