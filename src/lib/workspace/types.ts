import type { LaneId, LaneSummary, TabSummary, WorkspaceState } from '../desktop-bridge'

export interface WorkspaceAgent {
  id: string
  name: string
  color: string
  profile: string
}

export function agentLaneId(agent: WorkspaceAgent): LaneId {
  return `profile:${agent.profile}`
}

export function laneAgent(laneId: LaneId, agents: WorkspaceAgent[]): WorkspaceAgent | undefined {
  return agents.find(agent => agentLaneId(agent) === laneId)
}

export function laneLabel(lane: LaneSummary, agents: WorkspaceAgent[]): string {
  return lane.kind === 'user' ? 'You' : laneAgent(lane.id, agents)?.name ?? lane.label
}

export function focusedTabs(state: WorkspaceState, selectedLaneId?: LaneId): TabSummary[] {
  const agentLane = state.focusedLaneId === 'you' ? selectedLaneId : state.focusedLaneId
  return [
    ...(agentLane && agentLane !== 'you' ? state.lanes.find(lane => lane.id === agentLane)?.tabs ?? [] : []),
    ...(state.lanes.find(lane => lane.id === 'you')?.tabs ?? []),
  ]
}

export function activeTab(state: WorkspaceState): TabSummary | null {
  return state.lanes.flatMap(lane => lane.tabs).find(tab => tab.id === state.activeTabId) ?? null
}

export function tabStateLabel(tab: TabSummary): string {
  switch (tab.state) {
    case 'agent-acting': return 'Agent acting'
    case 'user-paused': return 'Paused by you'
    case 'loading': return 'Loading'
    default: return tab.discarded ? 'Sleeping tab' : 'Idle'
  }
}

export function faviconSource(favicon?: string): string | undefined {
  // CONTRACT: Main should supply inline raster favicons. Ordinary favicon
  // URLs use a fallback so the renderer never requests a visited site.
  return favicon && /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,/i.test(favicon)
    ? favicon
    : undefined
}
