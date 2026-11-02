import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { TabSummary } from '../../lib/desktop-bridge'
import type { WorkspaceAgent } from '../../lib/workspace/types'
import '../../styles/workspace.css'

export interface GiveToAgentDialogProps {
  tab: TabSummary
  agents: WorkspaceAgent[]
  selectedAgentId?: string | null
  onGive: (tabId: string, profile: string, instruction?: string) => Promise<void>
  onClose: () => void
}

export function GiveToAgentDialog({ tab, agents, selectedAgentId, onGive, onClose }: GiveToAgentDialogProps) {
  const [agentId, setAgentId] = useState(agents.find(agent => agent.id === selectedAgentId)?.id ?? agents[0]?.id ?? '')
  const [instruction, setInstruction] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const busy = useRef(false)
  const agent = agents.find(candidate => candidate.id === agentId)

  useEffect(() => {
    const previous = document.activeElement
    root.current?.querySelector<HTMLSelectElement>('select')?.focus()
    function keyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!busy.current) onClose()
      }
      if (event.key !== 'Tab') return
      const controls = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? [])
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (!first) {
        event.preventDefault()
        root.current?.focus()
      } else if (!root.current?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!agent || busy.current) return
    busy.current = true
    setPending(true)
    setError(null)
    try {
      await onGive(tab.id, agent.profile, instruction.trim() || undefined)
      onClose()
    } catch {
      setError('Could not give this tab to the agent. Please try again.')
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  return (
    <div className="workspace-dialog-scrim">
      <div className="workspace-give-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-give-title" ref={root} tabIndex={-1}>
        <h2 id="workspace-give-title">Give to agent</h2>
        <p className="workspace-dialog-page">{tab.title || tab.url || 'New tab'}</p>
        <p className="workspace-sharing-notice">This tab keeps your sign-in. The agent can use it until you return the tab to your lane.</p>
        <form onSubmit={submit}>
          <label className="workspace-field">
            Agent
            <select value={agentId} disabled={pending || agents.length === 0} onChange={event => setAgentId(event.target.value)}>
              {agents.length === 0 && <option value="">No agents available</option>}
              {agents.map(candidate => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}
            </select>
          </label>
          <label className="workspace-field">
            Instruction (optional)
            <textarea value={instruction} disabled={pending} rows={3} placeholder="What should the agent do on this page?" onChange={event => setInstruction(event.target.value)} />
          </label>
          {error && <p className="workspace-error" role="alert">{error}</p>}
          <div className="workspace-dialog-actions">
            <button type="button" className="workspace-action-button" disabled={pending} onClick={onClose}>Cancel</button>
            <button type="submit" className="workspace-primary-button" disabled={pending || !agent}>{pending ? 'Giving tab…' : 'Give tab'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
