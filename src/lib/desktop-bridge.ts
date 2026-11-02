/**
 * Typed access to the Hermes Desk main-process bridges (window.nubAgent.host /
 * .workspace / .computer). Channel names and semantics:
 * docs/plans/hermes-desk-contracts.md §2. The renderer never holds a Hermes
 * token and never touches a tab's webContents — everything goes through here.
 */

import type { WorkspaceShortcut } from './workspace/features'

export type Unsubscribe = () => void

/** Guarded, seekable local media. URLs are opaque and released with their player. */
export interface MediaBridge {
  open(path: string): Promise<string>
  release(url: string): Promise<void>
}

/** Native selection/copying; never exposes arbitrary destinations or file bytes. */
export interface NativeFilesBridge {
  chooseRoot?(): Promise<{ ok: boolean; data?: string; error?: string }>
  pickMedia(): Promise<string | null>
  saveAs(path: string): Promise<boolean>
  releaseImport(path: string): Promise<void>
}

export interface Health {
  state: 'up' | 'down' | 'starting' | 'unknown'
  url?: string
  version?: string
  detail?: string
}

export type ControllerState = 'off' | 'connecting' | 'ready' | 'error' | 'mismatch'

export interface HostStatus {
  gateway: Health
  serve: Health & { mode?: 'attached' | 'spawned'; port?: number; stderrTail?: string[] }
  controller: ControllerState
  controllerDetail?: string
  computerUse?: 'available' | 'unavailable' | 'unknown'
  computerUseDetail?: string
  installation?: { home: string; homeExists: boolean; binary: string | null; detected: boolean }
}

export interface ConfigDiff {
  ok: boolean
  profiles: string[]
  diff?: string
  backupPath?: string
  error?: string
  cancelled?: boolean
  backups?: Array<{ profile: string; path: string; backupPath: string }>
}

export interface HostBridge {
  status(): Promise<HostStatus>
  restartServe(): Promise<void>
  getConfig(): Promise<HostConfig | null>
  /** null while Hermes is still connecting. */
  sidebarActivity?(): Promise<Record<string, { preview?: string; lastActivityAt?: string; hasSessions: boolean }> | null>
  secretsMetadata?(): Promise<SecretsMetadata>
  revokeOrigin?(origin: string): Promise<SecretsMetadata>
  setProfileSoul?(profile: string, content: string): Promise<void>
  setConfig(patch: HostConfigPatch): Promise<HostConfig>
  auditTail(n: number): Promise<AuditEntry[]>
  enableBrowserControl(profiles: string[]): Promise<ConfigDiff>
  /** Confirmed, backed-up removal; optional for older desktop bridges. */
  disableBrowserControl?(profiles: string[]): Promise<ConfigDiff>
  onStatus(cb: (s: HostStatus) => void): Unsubscribe
}

export interface LocalProfile {
  name: string
  displayName: string
  avatar?: string
  model?: string
  approvalMode?: 'manual' | 'smart' | 'off' | null
  timezone?: string | null
  browsingSetup?: 'ready' | 'tokenless' | 'stale' | 'missing' | 'unknown'
}
export interface SecretsMetadata {
  state: 'ready' | 'locked' | 'unavailable'
  vaults: Array<{ id: string; name: string }>
  defaultVault: string
  approvals: Array<{ origin: string; at: string; scope: 'once' }>
}
export interface AttachmentsBridge {
  pickAndUpload(request: { profile: string; sessionId: string }): Promise<{
    files: Array<{ name: string; path: string; kind: 'image' | 'file'; size: number }>
    error?: string
  }>
}

/** App-local settings plus read-only, credential-free profile metadata. */
export interface HostConfig {
  hermesHome: string
  serve: { mode: 'auto' | 'attach' | 'spawn'; port: number }
  workspace: {
    maxTabsPerAgent: number
    maxLiveViews: number
    downloadsDir: string
    searchEngine: 'duckduckgo' | 'google' | 'bing'
    profiles: Record<string, { allow?: string[]; deny?: string[] }>
    enabledProfiles: string[]
  }
  computer: { source: 'completed-capture'; fps: number; placement: 'docked' | 'floating' }
  appearance: { messengerSkin: boolean }
  secrets?: { defaultVault: string }
  onboarding?: { completed: boolean }
  profiles: LocalProfile[]
  profilesError?: string
  capabilities?: { profileEditing?: boolean; agentConfig?: boolean; secrets?: boolean }
}

/** Enabled profiles change only through confirmed browsing setup/removal. */
export interface HostConfigPatch {
  serve?: Partial<HostConfig['serve']>
  workspace?: Partial<Omit<HostConfig['workspace'], 'enabledProfiles'>>
  computer?: Partial<HostConfig['computer']>
  appearance?: Partial<HostConfig['appearance']>
  secrets?: { defaultVault: string }
  onboarding?: { completed: boolean }
  agent?: { profile: string; approvalMode?: 'manual' | 'smart' | 'off'; timezone?: string; uiMeta?: { display_name?: string; avatar?: string } }
}

export interface AuditEntry {
  ts: string
  agent: string | null
  lane: string | null
  tab: string | null
  action: string
  origin: string | null
  result: string
  durationMs: number
  byUser?: boolean
}

export interface SessionRegistration {
  profile: string
  storedId: string
  runtimeId: string
}

/** `you` or `profile:<name>` */
export type LaneId = string
/** `t_<base36>` */
export type TabId = string

export type TabState = 'idle' | 'loading' | 'agent-acting' | 'user-paused'

export interface TabSummary {
  id: TabId
  laneId: LaneId
  url: string
  title: string
  favicon?: string
  state: TabState
  controller: 'user' | 'agent'
  createdBy: 'user' | 'agent'
  /** true while a user-partition tab is lent to an agent (yellow badge) */
  sharedLogin: boolean
  /** view destroyed to save memory; url/title kept */
  discarded: boolean
  active: boolean
  canGoBack?: boolean
  canGoForward?: boolean
}

export interface LaneSummary {
  id: LaneId
  kind: 'user' | 'agent'
  profile?: string
  label: string
  color?: string
  state: 'idle' | 'acting' | 'paused'
  tabs: TabSummary[]
}

export interface WorkspaceControl {
  laneId: LaneId | null
  owner: 'user' | 'agent'
  paused: boolean
  agentName?: string
  agentColor?: string
}

export interface WorkspaceState {
  lanes: LaneSummary[]
  focusedLaneId: LaneId
  activeTabId: TabId | null
  control: WorkspaceControl
  controller: ControllerState
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WorkspaceBridge {
  setBounds(rect: Rect | null): Promise<void>
  setVisible(visible: boolean): Promise<void>
  list(): Promise<WorkspaceState>
  registerSession(registration: SessionRegistration): Promise<void>
  stopAll(): Promise<void>
  openTab(laneId: LaneId, url?: string): Promise<TabId>
  closeTab(tabId: TabId): Promise<void>
  activate(tabId: TabId): Promise<void>
  focusLane(laneId: LaneId): Promise<void>
  navigate(tabId: TabId, urlOrQuery: string): Promise<void>
  back(tabId: TabId): Promise<void>
  forward(tabId: TabId): Promise<void>
  reload(tabId: TabId): Promise<void>
  giveToAgent(tabId: TabId, profile: string, instruction?: string): Promise<void>
  returnToUser(tabId: TabId): Promise<void>
  resumeAgent(laneId: LaneId): Promise<void>
  takeControl?(tabId: TabId): Promise<void>
  copySignIn(origin: string, fromLane: LaneId, toLane: LaneId): Promise<void>
  clearLaneData?(laneId: LaneId): Promise<void>
  onShortcut?(cb: (shortcut: WorkspaceShortcut) => void): Unsubscribe
  onState(cb: (s: WorkspaceState) => void): Unsubscribe
}

export interface ComputerState {
  open: boolean
  profile?: string
  mode: 'watching' | 'user-control' | 'idle'
  docked?: boolean
  sessionId?: string
  agentName?: string
  agentColor?: string
  captureTs?: number
  source?: 'completed-capture'
  readiness?: 'ready' | 'unavailable' | 'unknown'
  permissions?: { accessibility: boolean | null; screenRecording: boolean | null }
  detail?: string
  lastAction?: { x: number; y: number; color?: string; width?: number; height?: number }
}

export interface ComputerFrame {
  dataUrl: string
  ts: number
  profile?: string
  sessionId?: string
  width?: number | null
  height?: number | null
}

export interface ComputerBridge {
  open(profile: string, options?: { docked: boolean }): Promise<void>
  close(): Promise<void>
  takeControl(): Promise<void>
  paste(): Promise<void>
  onFrame(cb: (frame: ComputerFrame) => void): Unsubscribe
  onState(cb: (s: ComputerState) => void): Unsubscribe
}

interface HermesDeskBridges {
  host?: HostBridge
  workspace?: WorkspaceBridge
  computer?: ComputerBridge
}

function bridges(): HermesDeskBridges {
  if (typeof window === 'undefined') return {}
  return ((window as unknown as { nubAgent?: HermesDeskBridges }).nubAgent ?? {}) as HermesDeskBridges
}

export const getHostBridge = (): HostBridge | null => bridges().host ?? null
export const getWorkspaceBridge = (): WorkspaceBridge | null => bridges().workspace ?? null
export const getComputerBridge = (): ComputerBridge | null => bridges().computer ?? null
