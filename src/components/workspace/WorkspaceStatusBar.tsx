import type { WorkspaceState } from '../../lib/desktop-bridge'
import { activeTab, laneAgent } from '../../lib/workspace/types'
import type { WorkspaceAgent } from '../../lib/workspace/types'
import { Icon } from '../ui/icons'
import '../../styles/workspace.css'

export interface WorkspaceStatusBarProps {
  state: WorkspaceState
  agents: WorkspaceAgent[]
  onResume: (laneId: string) => void
  onOpenSettings?: () => void
  onTakeControl?: () => void
  disabled?: boolean
}

const controllerLabels = {
  ready: 'Browser connector ready',
  connecting: 'Connecting…',
  off: 'Browsing is off',
  error: 'Browser connector unavailable',
  mismatch: 'Browser connection needs an update',
} as const

export function WorkspaceStatusBar({ state, agents, onResume, onOpenSettings, onTakeControl, disabled }: WorkspaceStatusBarProps) {
  const { control } = state
  const tab = activeTab(state)
  const laneId = tab?.laneId ?? state.focusedLaneId
  const agent = laneAgent(laneId, agents)
  const lane = state.lanes.find(candidate => candidate.id === laneId)
  const name = agent?.name ?? lane?.label ?? 'Agent'
  const laneName = laneId === 'you' ? 'Your browser' : `${name}’s browser`
  const ownsControl = control.laneId === laneId
  const paused = !!tab && (ownsControl ? control.paused : tab.state === 'user-paused')
  const watching = !!tab && (ownsControl ? control.owner === 'agent' : tab.controller === 'agent') && !paused
  const text = !tab ? 'No active page' : paused
    ? 'Paused, you took control'
    : watching ? 'Watching agent' : 'You in control'
  return (
    <div className="workspace-status-bar" data-control={!tab ? 'empty' : paused ? 'paused' : watching ? 'watching' : 'user'}>
      <div className="workspace-control-status" role="status" title={`${laneName} · ${text}`}>
        <Icon name={watching ? 'globe' : 'computer'} size={14} />
        <span className="workspace-lane-name">{laneName}</span>
        <span aria-hidden="true">·</span>
        <span>{text}</span>
        {paused && (
          <button type="button" className="workspace-action-button" disabled={disabled} onClick={() => onResume(laneId)}>Resume agent</button>
        )}
        {watching &&
          <button type="button" className="workspace-action-button" disabled={disabled || !onTakeControl} title={!onTakeControl ? 'Update Hermes Desk to enable the keyboard control action. Native input still takes control.' : undefined} onClick={onTakeControl}>Take control</button>}
      </div>
      {state.controller !== 'ready' && <div className="workspace-connector-status" data-state={state.controller} role="status">
        <span className="workspace-connector-dot" aria-hidden="true" />
        {state.controller === 'off' && onOpenSettings
          ? <button type="button" className="workspace-text-button" onClick={onOpenSettings}>{controllerLabels.off}</button>
          : <span>{controllerLabels[state.controller]}</span>}
      </div>}
    </div>
  )
}
