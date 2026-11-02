import { useRef } from 'react'
import { faviconSource, laneAgent, tabStateLabel } from '../../lib/workspace/types'
import type { WorkspaceAgent } from '../../lib/workspace/types'
import type { TabSummary } from '../../lib/desktop-bridge'
import { Icon } from '../ui/icons'
import '../../styles/workspace.css'

export interface WorkspaceTabsProps {
  tabs: TabSummary[]
  activeTabId: string | null
  agents: WorkspaceAgent[]
  disabled?: boolean
  onActivate: (tab: TabSummary) => void
  onClose: (tab: TabSummary) => void
  onNewTab: () => void
}

export function WorkspaceTabs({ tabs, activeTabId, agents, disabled, onActivate, onClose, onNewTab }: WorkspaceTabsProps) {
  const list = useRef<HTMLDivElement>(null)
  return (
    <div className="workspace-tabs-row">
      <div className="workspace-tabs" style={{ gridTemplateColumns: tabs.length ? `repeat(${tabs.length}, max-content)` : undefined }}>
      <div ref={list} className="workspace-tab-list" role={tabs.length ? 'tablist' : undefined} aria-label={tabs.length ? 'Workspace tabs' : undefined} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.target instanceof HTMLElement && event.target.getAttribute('role') !== 'tab') return
        event.preventDefault()
        const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [])]
        const index = buttons.indexOf(event.target as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
          (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
        if (tabs[next]) onActivate(tabs[next])
      }}>
        {tabs.map(tab => {
          const agent = laneAgent(tab.laneId, agents)
          const owner = tab.laneId === 'you' ? 'You' : agent?.name ?? tab.laneId.replace(/^profile:/, '')
          const title = tab.title || tab.url || 'New tab'
          const favicon = faviconSource(tab.favicon)
          return (
            <div className="workspace-tab" data-active={tab.id === activeTabId} key={tab.id}>
              <button
                type="button"
                className="workspace-tab-select"
                role="tab"
                tabIndex={tab.id === activeTabId || !tabs.some(candidate => candidate.id === activeTabId) && tab.id === tabs[0]?.id ? 0 : -1}
                aria-selected={tab.id === activeTabId}
                aria-label={`${title} · ${owner} · ${tabStateLabel(tab)}${tab.sharedLogin ? ' · shared login' : ''}`}
                title={tab.url || title}
                disabled={disabled}
                onClick={() => onActivate(tab)}
              >
                {favicon
                  ? <img className="workspace-favicon" src={favicon} alt="" aria-hidden="true" referrerPolicy="no-referrer" />
                  : <Icon name="globe" size={14} />}
                <span className="workspace-tab-title">{title}</span>
                <span className="workspace-owner-badge" style={{ color: agent?.color }}>{owner}</span>
                {tab.sharedLogin && <span className="workspace-shared-login">shared login</span>}
                <span className="workspace-tab-state" data-state={tab.state} title={tabStateLabel(tab)} aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          className="workspace-tab-close"
          style={{ gridColumn: index + 1 }}
          aria-label={`Close ${tab.title || tab.url || 'New tab'}`}
          disabled={disabled}
          onClick={() => onClose(tab)}
        ><Icon name="x" size={14} /></button>
      ))}
      </div>
      <button type="button" className="workspace-icon-button" aria-label="New workspace tab" disabled={disabled} onClick={onNewTab}><Icon name="plus" size={18} /></button>
    </div>
  )
}
