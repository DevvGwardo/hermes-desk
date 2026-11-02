import { useEffect, useRef, useState } from 'react'
import type { WorkspaceAgent } from '../../lib/workspace/types'
import type { TabSummary } from '../../lib/desktop-bridge'
import { getWorkspaceBridge } from '../../lib/desktop-bridge'

export function CopySignInDialog({ tab, agents, selectedAgentId, onClose }: {
  tab: TabSummary
  agents: WorkspaceAgent[]
  selectedAgentId?: string | null
  onClose(): void
}) {
  const [profile, setProfile] = useState(agents.find(agent => agent.id === selectedAgentId)?.profile ?? agents[0]?.profile ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLElement>(null)
  const picker = useRef<HTMLSelectElement>(null)
  const busy = useRef(false)
  let origin = ''
  try { const url = new URL(tab.url); if (/^https?:$/.test(url.protocol)) origin = url.origin } catch { /* Empty tab. */ }
  useEffect(() => {
    const previous = document.activeElement
    picker.current?.focus()
    function keyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || (event.key !== 'Escape' && event.key !== 'Tab')) return
      const dialog = root.current
      if (!dialog) return
      const focusedModal = document.activeElement?.closest('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')
      if (focusedModal && focusedModal !== dialog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!busy.current) onClose()
        return
      }
      const controls = dialog.querySelectorAll<HTMLElement>('select:not(:disabled), button:not(:disabled)')
      const first = controls[0], last = controls[controls.length - 1]
      if (!first) {
        event.preventDefault()
        dialog.focus()
      } else if (!dialog.contains(document.activeElement) || document.activeElement === dialog || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first)?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keyDown)
    return () => {
      document.removeEventListener('keydown', keyDown)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [onClose])
  async function copy() {
    const bridge = getWorkspaceBridge()
    if (!bridge || !origin || !agents.some(agent => agent.profile === profile) || busy.current) return
    busy.current = true
    setPending(true)
    setError('')
    try {
      await bridge.copySignIn(origin, tab.laneId, `profile:${profile}`)
      onClose()
    } catch {
      setError('Sign-in was not copied. Check the native consent dialog and try again.')
    } finally { busy.current = false; setPending(false) }
  }
  return (
    <div className="workspace-dialog-scrim">
      <section ref={root} tabIndex={-1} className="workspace-give-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-copy-title" aria-busy={pending}>
        <h2 id="workspace-copy-title">Copy sign-in</h2>
        <p className="workspace-dialog-page">{origin}</p>
        <p className="workspace-sharing-notice">Copies only this host’s cookies into the agent’s private lane. A native consent dialog will ask you to approve this site.</p>
        <label className="workspace-field">Agent
          <select ref={picker} value={profile} disabled={pending} onChange={event => setProfile(event.target.value)}>
            {agents.map(agent => <option key={agent.profile} value={agent.profile}>{agent.name}</option>)}
          </select>
        </label>
        {error && <p className="workspace-error" role="alert">{error}</p>}
        <div className="workspace-dialog-actions">
          <button type="button" className="workspace-action-button" disabled={pending} onClick={onClose}>Cancel</button>
          <button type="button" className="workspace-primary-button" disabled={pending || !profile || !origin} onClick={() => void copy()}>{pending ? 'Waiting for consent…' : 'Review copy'}</button>
        </div>
      </section>
    </div>
  )
}
