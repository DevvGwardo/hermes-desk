import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { TabSummary } from '../../lib/desktop-bridge'
import { AppModal } from '../AppModal'
import { Icon } from '../ui/icons'
import { Tooltip } from '../ui/Tooltip'
import '../../styles/workspace.css'

export interface WorkspaceNavProps {
  tab: TabSummary | null
  disabled?: boolean
  active?: boolean
  visible?: boolean
  canGive?: boolean
  onNavigate: (urlOrQuery: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onAskAgent?: (tab: TabSummary) => void
  onReader?: (tab: TabSummary) => void
  onCopySignIn?: () => void
  onGiveToAgent: () => void
  onReturnToUser: () => void
}

export function WorkspaceNav({
  tab, disabled, active = true, visible = true, canGive, onNavigate, onBack, onForward, onReload,
  onAskAgent, onReader, onCopySignIn, onGiveToAgent, onReturnToUser,
}: WorkspaceNavProps) {
  const [address, setAddress] = useState(tab?.url ?? '')
  const [more, setMore] = useState(false)
  const addressInput = useRef<HTMLInputElement>(null)
  const editing = useRef(false)
  const previousTabId = useRef(tab?.id)
  useEffect(() => {
    if (previousTabId.current !== tab?.id) editing.current = false
    previousTabId.current = tab?.id
    if (!editing.current) setAddress(tab?.url ?? '')
  }, [tab?.id, tab?.url])
  const unavailable = disabled || !tab
  useEffect(() => { setMore(false) }, [visible, tab?.id])

  useEffect(() => {
    if (!active || unavailable) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.shiftKey ||
          !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'l' ||
          document.querySelector('[role="dialog"][aria-modal="true"], [data-esc-layer]')) return
      event.preventDefault()
      addressInput.current?.focus()
      addressInput.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, unavailable])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = address.trim()
    // URL parsing, the search engine and URL policy belong to main.
    if (!unavailable && value) {
      editing.current = false
      onNavigate(value)
    }
  }

  return (
    <nav className="workspace-nav" aria-label="Browser navigation">
      <Tooltip content="Go back" side="top"><button type="button" className="workspace-icon-button" aria-label="Back" disabled={unavailable || !tab?.canGoBack} onClick={onBack}><Icon name="back" size={18} /></button></Tooltip>
      <Tooltip content="Go forward" side="top"><button type="button" className="workspace-icon-button" aria-label="Forward" disabled={unavailable || !tab?.canGoForward} onClick={onForward}><Icon name="forward" size={18} /></button></Tooltip>
      <Tooltip content="Reload page" side="top"><button type="button" className="workspace-icon-button" aria-label="Reload" disabled={unavailable} onClick={onReload}><Icon name="reload" size={18} /></button></Tooltip>
      <form className="workspace-address-form" onSubmit={submit}>
        <input
          ref={addressInput}
          type="text"
          aria-label="Workspace address"
          aria-keyshortcuts="Meta+L Control+L"
          title="Focus address (⌘L / Ctrl+L)"
          placeholder="Search or enter a URL"
          value={address}
          onChange={event => {
            editing.current = event.target.value !== (tab?.url ?? '')
            setAddress(event.target.value)
          }}
          onFocus={() => { editing.current = address !== (tab?.url ?? '') }}
          onBlur={() => { editing.current = false; setAddress(tab?.url ?? '') }}
          onKeyDown={event => {
            if (event.key === 'Escape' && address !== (tab?.url ?? '')) {
              event.preventDefault()
              event.stopPropagation()
              editing.current = false
              setAddress(tab?.url ?? '')
            }
          }}
          disabled={unavailable}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </form>
      {tab?.sharedLogin
        ? <button type="button" className="workspace-action-button" disabled={unavailable} onClick={onReturnToUser}>Return to my workspace</button>
        : tab?.laneId === 'you' && <button type="button" className="workspace-action-button" disabled={unavailable || !canGive} onClick={onGiveToAgent}>Give to agent</button>}
      <Tooltip content="More workspace actions" side="top" disabled={more}><button type="button" className="workspace-icon-button" aria-label="More workspace actions" aria-haspopup="dialog" aria-expanded={more} disabled={unavailable} onClick={() => setMore(true)}><Icon name="more" size={18} /></button></Tooltip>
      <AppModal open={more} onClose={() => setMore(false)} title="More workspace actions">
        <div className="desk-theme workspace-more-actions">
          <button type="button" className="workspace-action-button" disabled={unavailable || !onAskAgent} onClick={() => { setMore(false); if (tab) onAskAgent?.(tab) }}><Icon name="sparkle" size={16} />Ask agent about this page</button>
          <button type="button" className="workspace-action-button" disabled={unavailable || !onReader} onClick={() => { setMore(false); if (tab) onReader?.(tab) }}><Icon name="reader" size={16} />Reader preview</button>
          {onCopySignIn && <button type="button" className="workspace-action-button" disabled={unavailable} onClick={() => { setMore(false); onCopySignIn() }}><Icon name="lock" size={16} />Copy sign-in</button>}
        </div>
      </AppModal>
    </nav>
  )
}
