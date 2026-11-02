import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DictateStatus } from '../../lib/dictate'
import { Icon } from '../ui/icons'
import { IconButton } from '../ui/IconButton'
import '../../styles/skin-messenger.css'

/** Presentation only: ChatPanel keeps draft, upload, submit and STT ownership. */
export function MessengerComposer({
  input,
  tray,
  hasText,
  disabled,
  sendDisabled = false,
  profile,
  model,
  context,
  room = false,
  onCommands,
  onModel,
  onSkills,
  onGenUi,
  onAttach,
  onEmoji,
  onStartDictate,
  onStopDictate,
  dictateStatus,
  dictateIndicator,
  sendLabel = 'Send',
  sendQueued = false,
}: {
  input: ReactNode
  tray?: ReactNode
  hasText: boolean
  disabled?: boolean
  sendDisabled?: boolean
  profile: string
  model: string
  context?: ReactNode
  room?: boolean
  onCommands: () => void
  onModel?: () => void
  onSkills?: () => void
  onGenUi?: () => void
  onAttach?: () => void
  onEmoji: (emoji: string) => void
  onStartDictate: () => void
  onStopDictate: () => void
  dictateStatus: DictateStatus
  dictateIndicator?: ReactNode
  sendLabel?: string
  sendQueued?: boolean
}) {
  const [menu, setMenu] = useState<'commands' | 'emoji' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const micRef = useRef<HTMLButtonElement>(null)
  const holding = useRef(false)
  const held = useRef(false)
  const holdTimer = useRef(0)
  const listening = dictateStatus === 'listening'
  const processing = dictateStatus === 'processing'
  const micAvailable = dictateStatus !== 'unavailable' && dictateStatus !== 'denied'
  const open = menu !== null
  const modelLabel = model.split('/').filter(Boolean).at(-1) || model

  useEffect(() => () => window.clearTimeout(holdTimer.current), [])
  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    const outside = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(null)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, menu])

  function release(cancel = false) {
    window.clearTimeout(holdTimer.current)
    if (!holding.current) return
    holding.current = false
    if (held.current) onStopDictate()
    else if (!cancel) onStartDictate()
    held.current = false
  }
  function closeMenu() {
    setMenu(null)
    rootRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true })
  }

  return (
    <div ref={rootRef} className="messenger-composer">
      {tray}
      {menu && (
        <div
          ref={menuRef}
          className="messenger-composer-menu"
          role="menu"
          aria-label={menu === 'emoji' ? 'Emoji' : 'Composer menu'}
          data-esc-layer
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setMenu(null)
              rootRef.current?.querySelector<HTMLButtonElement>(menu === 'emoji' ? 'button[aria-label="Add emoji"]' : 'button[aria-label="Composer menu"]')?.focus({ preventScroll: true })
            }
            const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
            const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const next = at + (event.key === 'ArrowDown' ? 1 : -1)
              buttons[(next + buttons.length) % buttons.length]?.focus()
            }
          }}
        >
          {menu === 'commands' ? (
            <>
              <button type="button" role="menuitem" onClick={() => { closeMenu(); onCommands() }}>Slash commands</button>
              <button type="button" role="menuitem" disabled={!onModel} onClick={() => { setMenu(null); onModel?.() }}>{context ? 'Model & profile' : 'Model settings'} · {modelLabel}</button>
              {onSkills && <button type="button" role="menuitem" onClick={() => { setMenu(null); onSkills() }}>Profile skills</button>}
              {onGenUi && <button type="button" role="menuitem" onClick={() => { closeMenu(); onGenUi() }}>Prepare GenUI card</button>}
              <button type="button" role="menuitem" disabled={!onAttach || disabled} onClick={() => { closeMenu(); onAttach?.() }}>Attach file</button>
            </>
          ) : ['☺', '👍', '❤️', '🎉', '🙏', '👀'].map((emoji) => (
            <button key={emoji} type="button" role="menuitem" aria-label={`Insert ${emoji}`} onClick={() => { onEmoji(emoji); closeMenu() }}>{emoji}</button>
          ))}
        </div>
      )}
      <div className="messenger-composer-row">
        <IconButton size="md" aria-label="Attach a file" disabled={disabled || !onAttach} onClick={onAttach}><Icon name="paperclip" /></IconButton>
        <div className="messenger-input-field">
          {input}
        </div>
        <IconButton type="submit" size="md" variant="primary" aria-label={sendLabel} aria-pressed={sendQueued || undefined}
          tooltip={sendDisabled ? 'Wait for the files to finish attaching' : sendLabel}
          disabled={disabled || sendDisabled || !hasText || listening || processing}><Icon name="send" /></IconButton>
      </div>
      <div className="messenger-context">
        {context ?? <span title={room ? 'Each member uses its own local Hermes session.' : `${model} · Local Hermes profile: ${profile} · Model selection is read-only here`}>{room ? 'Shared room' : modelLabel} · On this Mac</span>}
        <div className="messenger-composer-extras">
          <IconButton size="xs" aria-label="Composer menu" aria-haspopup="menu" aria-expanded={menu === 'commands'} disabled={disabled} onClick={() => setMenu(menu === 'commands' ? null : 'commands')}><Icon name="more" size={16} /></IconButton>
          <IconButton size="xs" aria-label="Add emoji" aria-haspopup="menu" aria-expanded={menu === 'emoji'} disabled={disabled} onClick={() => setMenu(menu === 'emoji' ? null : 'emoji')}><Icon name="emoji" size={16} /></IconButton>
          {micAvailable && (
          <IconButton
            ref={micRef}
            size="xs"
            aria-label={listening || processing ? 'Stop dictation' : 'Click or hold to dictate'}
            tooltip={processing ? 'Transcribing locally…' : listening ? 'Stop dictation' : 'Click or hold to dictate'}
            disabled={disabled || processing || !micAvailable}
            onPointerDown={(event) => {
              if (event.button !== 0 || disabled || processing) return
              if (listening) { onStopDictate(); return }
              holding.current = true
              held.current = false
              event.currentTarget.setPointerCapture?.(event.pointerId)
              holdTimer.current = window.setTimeout(() => {
                if (!holding.current) return
                held.current = true
                onStartDictate()
              }, 350)
            }}
            onPointerUp={() => release()}
            onPointerCancel={() => release(true)}
            onLostPointerCapture={() => release(true)}
            onClick={(event) => {
              // Pointer takes are handled above; keyboard activation has detail 0.
              if (event.detail === 0) {
                if (listening) onStopDictate()
                else onStartDictate()
              }
            }}
          >
            <Icon name={processing || listening ? 'stop' : 'mic'} size={16} />
          </IconButton>
          )}
        </div>
      </div>
      {(listening || processing || dictateStatus === 'denied') && (
        <div className="messenger-dictate-status" role="status">{dictateIndicator || (processing ? 'Transcribing…' : 'Listening…')}</div>
      )}
    </div>
  )
}
