import { useEffect, useRef, useState } from 'react'
import { profileName, type RosterAgent } from '../lib/agents/roster'
import { Icon } from './ui/icons'
import { Tooltip } from './ui/Tooltip'
import '../styles/skin-messenger-sidebar.css'

export function RestoreHiddenMenu({
  agents, hiddenProfiles, onRestore, compact = false,
}: {
  agents: readonly RosterAgent[]
  hiddenProfiles: readonly string[]
  onRestore: (profile: string) => void
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('maia:open-hidden-chats', show)
    return () => window.removeEventListener('maia:open-hidden-chats', show)
  }, [])
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  return (
    <div ref={root} className="hd-restore-hidden">
      <Tooltip content="Hidden agents" side="right" disabled={!compact || open} className="desk-tooltip-anchor-block">
      <button ref={trigger} type="button" aria-label="Hidden agents"
        aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((value) => !value)} className="hd-restore-trigger">
        {compact ? <Icon name="back" size={14} /> : 'Hidden agents'}
        {!compact && hiddenProfiles.length > 0 && <span> ({hiddenProfiles.length})</span>}
      </button>
      </Tooltip>
      {open && (
        <div role="menu" aria-label="Hidden agents" className="hd-sidebar-menu" data-esc-layer>
          {hiddenProfiles.map((profile) => {
            const agent = agents.find((a) => profileName(a) === profile || a.id === profile)
            return (
              <button key={profile} type="button" role="menuitem" onClick={() => {
                onRestore(profile)
                if (hiddenProfiles.length === 1) {
                  setOpen(false)
                  trigger.current?.focus()
                }
              }}>{agent?.ui_meta?.display_name ?? agent?.name ?? profile}</button>
            )
          })}
          {hiddenProfiles.length === 0 && <span className="hd-menu-empty">No hidden agents</span>}
        </div>
      )}
    </div>
  )
}
