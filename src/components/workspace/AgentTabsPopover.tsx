import { useEffect, useRef } from 'react'
import type { LaneSummary } from '../../lib/desktop-bridge'
import { laneAgent, laneLabel } from '../../lib/workspace/types'
import type { WorkspaceAgent } from '../../lib/workspace/types'
import '../../styles/workspace.css'

export interface AgentTabsPopoverProps {
  lanes: LaneSummary[]
  agents: WorkspaceAgent[]
  focusedLaneId: string
  onJump: (laneId: string, tabId?: string) => void
  onClose: () => void
}

const liveLabels = { idle: 'Idle', acting: 'Agent acting', paused: 'Paused by you' } as const

export function AgentTabsPopover({ lanes, agents, focusedLaneId, onJump, onClose }: AgentTabsPopoverProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    root.current?.querySelector<HTMLButtonElement>('button')?.focus()
    function keyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    function outside(event: PointerEvent) {
      if (!(event.target instanceof Element)) return
      if (root.current?.contains(event.target) || event.target.closest('[aria-controls="workspace-agent-tabs"]')) return
      onClose()
    }
    document.addEventListener('keydown', keyDown)
    document.addEventListener('pointerdown', outside)
    return () => {
      document.removeEventListener('keydown', keyDown)
      document.removeEventListener('pointerdown', outside)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [onClose])

  return (
    <div className="workspace-agent-popover" id="workspace-agent-tabs" ref={root} role="dialog" aria-label="Agent tabs">
      <div className="workspace-popover-heading">
        <strong>All browser lanes</strong>
        <button type="button" className="workspace-icon-button" aria-label="Close agent tabs" onClick={onClose}>×</button>
      </div>
      <div className="workspace-lane-list">
        {lanes.length === 0 && <p className="workspace-muted">No tabs yet. Open a tab to start browsing.</p>}
        {lanes.map(lane => {
          const current = lane.tabs.find(tab => tab.active) ?? lane.tabs[0]
          const color = laneAgent(lane.id, agents)?.color ?? lane.color
          return (
            <button type="button" className="workspace-lane" aria-label={`${laneLabel(lane, agents)} · ${lane.tabs.length} ${lane.tabs.length === 1 ? 'tab' : 'tabs'} · ${current?.url || 'No tabs open'} · ${liveLabels[lane.state]}`} data-focused={lane.id === focusedLaneId} key={lane.id} onClick={() => onJump(lane.id, current?.id)}>
              <span className="workspace-lane-title">
                <span style={{ color }}>{laneLabel(lane, agents)}</span>
                <span className="workspace-lane-count">{lane.tabs.length} {lane.tabs.length === 1 ? 'tab' : 'tabs'}</span>
              </span>
              <span className="workspace-lane-url">{current?.url || 'No tabs open'}</span>
              <span className="workspace-lane-state" data-state={lane.state}>{liveLabels[lane.state]}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
