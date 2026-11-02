import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { getWorkspaceBridge } from '../../lib/desktop-bridge'
import type { WorkspaceBridge, TabSummary } from '../../lib/desktop-bridge'
import { useWorkspaceState, workspaceStore } from '../../lib/workspace/store'
import { activeTab, agentLaneId, focusedTabs } from '../../lib/workspace/types'
import type { WorkspaceAgent } from '../../lib/workspace/types'
import { WorkspaceNav } from './WorkspaceNav'
import { WorkspaceStatusBar } from './WorkspaceStatusBar'
import { WorkspaceTabs } from './WorkspaceTabs'
import { WorkspaceViewport } from './WorkspaceViewport'
import { forwardWorkspaceShortcut, getWorkspaceFeatures } from '../../lib/workspace/features'
import type { ReaderPreview as Preview } from '../../lib/workspace/features'
import { Icon } from '../ui/icons'
import '../../styles/workspace.css'

const AgentTabsPopover = lazy(() => import('./AgentTabsPopover').then(module => ({ default: module.AgentTabsPopover })))
const GiveToAgentDialog = lazy(() => import('./GiveToAgentDialog').then(module => ({ default: module.GiveToAgentDialog })))
const CopySignInDialog = lazy(() => import('./CopySignInDialog').then(module => ({ default: module.CopySignInDialog })))
const ReaderPreview = lazy(() => import('./ReaderPreview').then(module => ({ default: module.ReaderPreview })))

export interface WorkspacePaneProps {
  agents: WorkspaceAgent[]
  selectedAgentId?: string | null
  visible?: boolean
  onAskAgent?: (tab: TabSummary) => void
  onReader?: (tab: TabSummary) => void
  onToggleExpanded?: () => void
  onOpenSettings?: () => void
}

export function WorkspacePane({
  agents, selectedAgentId, visible = true, onAskAgent, onReader, onToggleExpanded, onOpenSettings,
}: WorkspacePaneProps) {
  const { state, available, loading, error } = useWorkspaceState()
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [giveRequest, setGiveRequest] = useState<{ tabId: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [copyRequest, setCopyRequest] = useState<{ tabId: string } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [readerOpen, setReaderOpen] = useState(false)
  const [readerLoading, setReaderLoading] = useState(false)
  const [readerError, setReaderError] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const paneRef = useRef<HTMLElement>(null)
  const readerGeneration = useRef(0)
  const selectedAgent = agents.find(agent => agent.id === selectedAgentId)
  const selectedLane = selectedAgent ? agentLaneId(selectedAgent) : 'you'
  const focusedAgent = agents.find(agent => agentLaneId(agent) === state.focusedLaneId)
  const emptyLaneName = focusedAgent?.name ?? state.lanes.find(lane => lane.id === state.focusedLaneId)?.label ?? 'the selected agent'
  const tab = activeTab(state)
  const dialogTab = state.lanes.flatMap(lane => lane.tabs).find(candidate => candidate.id === giveRequest?.tabId && candidate.laneId === 'you')
  const copyTab = state.lanes.flatMap(lane => lane.tabs).find(candidate => candidate.id === copyRequest?.tabId && candidate.laneId === 'you')
  const disabled = !available || loading || !!error
  const canGive = !!tab && tab.laneId === 'you' && agents.length > 0
  const closePopover = useCallback(() => setPopoverOpen(false), [])
  // Bind each close to its opening, even when the same tab is reopened.
  const closeDialog = useCallback(() => setGiveRequest(current => current === giveRequest ? null : current), [giveRequest])
  const boundsError = useCallback(() => setActionError('Could not display the browser view. Please try again.'), [])
  const closeReader = useCallback(() => { readerGeneration.current++; setReaderOpen(false); setPreview(null) }, [])
  const closeCopy = useCallback(() => setCopyRequest(current => current === copyRequest ? null : current), [copyRequest])

  useEffect(() => {
    if (available) return getWorkspaceFeatures()?.onShortcut?.(forwardWorkspaceShortcut)
  }, [available])
  useEffect(() => {
    const dock = paneRef.current?.closest('[data-side-panel="workspace"]')
    if (!expanded || !visible || !dock) return
    dock.setAttribute('data-workspace-expanded', 'true')
    return () => dock.removeAttribute('data-workspace-expanded')
  }, [expanded, visible])
  useEffect(() => {
    closeReader()
    return () => { readerGeneration.current++ }
  }, [tab?.id, tab?.url, visible, closeReader])

  const run = useCallback(async (action: (bridge: WorkspaceBridge) => Promise<unknown>) => {
    const bridge = getWorkspaceBridge()
    if (!bridge) return false
    setActionError(null)
    try {
      await action(bridge)
      return true
    } catch {
      setActionError('The workspace action could not finish. Please try again.')
      return false
    }
  }, [])

  useEffect(() => {
    // Native browser views sit above renderer pixels. Dialogs opened inside
    // chat/plugins must hide the view too, not just App's top-level panels.
    const check = () => setModalOpen(Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')))
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (available) void run(bridge => bridge.focusLane(selectedLane))
  }, [available, selectedLane, run])

  useEffect(() => {
    if (giveRequest && !dialogTab) closeDialog()
    if (copyRequest && !copyTab) closeCopy()
  }, [giveRequest, dialogTab, closeDialog, copyRequest, copyTab, closeCopy])

  useEffect(() => {
    if (!visible) {
      setPopoverOpen(false)
      setGiveRequest(null)
      setCopyRequest(null)
      setExpanded(false)
    }
  }, [visible])

  function activate(candidate: TabSummary) {
    void run(async bridge => {
      await bridge.focusLane(candidate.laneId)
      await bridge.activate(candidate.id)
    })
  }

  function returnTab() {
    if (tab) void run(bridge => bridge.returnToUser(tab.id))
  }

  function openTab() {
    void run(async bridge => {
      const id = await bridge.openTab(state.focusedLaneId)
      await bridge.activate(id)
    })
  }

  function jump(laneId: string, tabId?: string) {
    void run(async bridge => {
      await bridge.focusLane(laneId)
      if (tabId) await bridge.activate(tabId)
      closePopover()
    })
  }

  async function give(tabId: string, profile: string, instruction?: string) {
    const bridge = getWorkspaceBridge()
    if (!bridge) throw new Error('Workspace unavailable')
    setActionError(null)
    try {
      await bridge.giveToAgent(tabId, profile, instruction)
    } catch (error) {
      // The moved tab can unmount the dialog before notification completes.
      setActionError('The tab handoff could not finish. Check the tab’s lane before trying again.')
      throw error
    }
  }

  async function readPage(candidate: TabSummary) {
    if (onReader) return onReader(candidate)
    const bridge = getWorkspaceFeatures()
    const generation = ++readerGeneration.current
    setReaderOpen(true)
    setReaderLoading(true)
    setPreview(null)
    setReaderError('')
    try {
      if (!bridge?.readerPreview) throw new Error('Reader bridge unavailable')
      const result = await bridge.readerPreview(candidate.id)
      if (readerGeneration.current === generation) setPreview(result)
    } catch {
      if (readerGeneration.current === generation) setReaderError('This page could not be read safely. Try reloading it.')
    } finally {
      if (readerGeneration.current === generation) setReaderLoading(false)
    }
  }

  return (
    <section ref={paneRef} className="workspace-pane" data-expanded={expanded} aria-label="Workspace on your Mac" hidden={!visible}>
      <header className="workspace-header">
        <div className="workspace-header-titles">
          <h2>Workspace <span>On this Mac</span></h2>
          {available && !loading && <WorkspaceStatusBar state={state} agents={agents}
            disabled={disabled}
            onResume={laneId => { void run(bridge => bridge.resumeAgent(laneId)) }}
            onTakeControl={getWorkspaceBridge()?.takeControl && tab ? () => { void run(bridge => bridge.takeControl!(tab.id)) } : undefined}
            onOpenSettings={onOpenSettings} />}
        </div>
        {available && <button type="button" className="workspace-action-button" aria-expanded={popoverOpen} aria-controls="workspace-agent-tabs" disabled={disabled} onClick={() => setPopoverOpen(open => !open)}>Agent tabs</button>}
        {available && <button type="button" className="workspace-icon-button" aria-label={expanded ? 'Restore workspace' : 'Expand workspace'} title={expanded ? 'Restore workspace' : 'Expand workspace'} aria-pressed={expanded}
          onClick={() => { if (onToggleExpanded) onToggleExpanded(); else setExpanded(value => !value) }}><Icon name="panel" size={18} /></button>}
      </header>
      {!disabled && tab && <><WorkspaceTabs
        tabs={focusedTabs(state, selectedLane)}
        activeTabId={state.activeTabId}
        agents={agents}
        disabled={disabled}
        onActivate={activate}
        onClose={candidate => { void run(bridge => bridge.closeTab(candidate.id)) }}
        onNewTab={openTab}
      />
      <WorkspaceNav
        tab={tab}
        visible={visible}
        active={visible && !popoverOpen && !readerOpen && !modalOpen}
        disabled={disabled || !!dialogTab || !!copyTab}
        canGive={canGive}
        onNavigate={value => { if (tab) void run(bridge => bridge.navigate(tab.id, value)) }}
        onBack={() => { if (tab) void run(bridge => bridge.back(tab.id)) }}
        onForward={() => { if (tab) void run(bridge => bridge.forward(tab.id)) }}
        onReload={() => { if (tab) void run(bridge => bridge.reload(tab.id)) }}
        onAskAgent={onAskAgent}
        onReader={candidate => { void readPage(candidate) }}
        onCopySignIn={canGive && /^https?:\/\//.test(tab?.url ?? '') ? () => tab && setCopyRequest({ tabId: tab.id }) : undefined}
        onGiveToAgent={() => tab && setGiveRequest({ tabId: tab.id })}
        onReturnToUser={returnTab}
      /></>}
      {(error || actionError) && (
        <div className="workspace-error-banner" role="alert">
          <span>{error || actionError}</span>
          {error && <button type="button" className="workspace-text-button" onClick={() => workspaceStore.refresh()}>Retry</button>}
          {actionError && <button type="button" className="workspace-text-button" onClick={() => setActionError(null)}>Dismiss</button>}
        </div>
      )}
      <div className="workspace-browser-area">
        <WorkspaceViewport visible={visible && available && !loading && !error && !!tab && !popoverOpen && !dialogTab && !copyTab && !readerOpen && !modalOpen} onError={boundsError} />
        <Suspense fallback={<div className="workspace-reader" role="status">Opening reader preview…</div>}>
          {readerOpen && <ReaderPreview preview={preview} loading={readerLoading} error={readerError} onClose={closeReader} />}
        </Suspense>
        {(!available || loading || (!tab && !error)) && (
          <div className="workspace-empty" role="status">
            <Icon name="workspace" size={32} className="workspace-empty-symbol" />
            <strong>{!available ? 'Browser workspace unavailable' : loading ? 'Opening your workspace…' : 'No page open'}</strong>
            <p>{!available ? 'Open Hermes Desk on your Mac to browse alongside your agents. The workspace is not available in web previews.' : loading ? 'Getting your browser lanes ready.' : state.focusedLaneId === 'you'
              ? 'Open a page in your browser lane. Agent tabs stay separate.'
              : `Open a page in ${emptyLaneName}’s browser lane. Agent tabs stay separate from yours.`}</p>
            {available && !loading && <button type="button" className="workspace-primary-button" onClick={openTab}>Open a page</button>}
            {!available && onOpenSettings && <button type="button" className="workspace-action-button" onClick={onOpenSettings}>Workspace settings</button>}
          </div>
        )}
      </div>
      <Suspense fallback={<div className="workspace-dialog-scrim" role="status">Opening workspace controls…</div>}>
        {visible && popoverOpen && available && <AgentTabsPopover
          lanes={state.lanes}
          agents={agents}
          focusedLaneId={state.focusedLaneId}
          onClose={closePopover}
          onJump={jump}
        />}
        {visible && dialogTab && <GiveToAgentDialog key={dialogTab.id} tab={dialogTab} agents={agents} selectedAgentId={selectedAgentId} onGive={give} onClose={closeDialog} />}
        {visible && copyTab && <CopySignInDialog key={copyTab.id} tab={copyTab} agents={agents} selectedAgentId={selectedAgentId} onClose={closeCopy} />}
      </Suspense>
    </section>
  )
}
