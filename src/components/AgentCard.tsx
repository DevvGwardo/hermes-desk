import { useState } from 'react'
import { AgentMascot, agentColor as mascotColor } from './AgentMascot'
import type { AgentPresence as RosterPresence, RosterAgent } from '../lib/agents/roster'
type AgentPresence = RosterPresence | 'error'
import { Icon } from './ui/icons'
import { Button } from './ui/Button'
import { Tooltip } from './ui/Tooltip'
import '../styles/skin-messenger-sidebar.css'

export function agentColor(agent: RosterAgent): string {
  return mascotColor(agent, agent.id)
}

function localAvatar(agent: RosterAgent): string | null {
  const url = agent.ui_meta?.avatar ?? agent.avatarUrl
  // This local-only sidebar must not fetch hosted avatar URLs.
  const profile = agent.hermesProfile ?? (agent.id === 'local-hermes' ? 'default' : agent.id.replace(/^profile:/, ''))
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) return null
  return url && !/^(?:https?:|data:|blob:|file:|\/\/)/i.test(url) ? `hd-avatar://${profile}/` : null
}

export function AgentAvatar({
  agent, size = 40, presence = 'idle', paused = true, bob = false, lookAtCursor = false, flight = true,
}: {
  agent: RosterAgent
  size?: number
  presence?: AgentPresence
  paused?: boolean
  bob?: boolean
  lookAtCursor?: boolean
  /** Home avatar: app cues may fly this Pip out to a message or approval card. */
  flight?: boolean
}) {
  const source = localAvatar(agent)
  const sourceKey = `${source}:${agent.ui_meta?.avatar ?? agent.avatarUrl ?? ''}`
  const [failedSource, setFailedSource] = useState<string | null>(null)
  return (
    <span className={`hd-agent-avatar${bob ? ' sidebar-orb-bob' : ''}`}
      data-orb-motion={paused ? (bob ? 'bob' : 'still') : 'engine'}
      style={{ width: size, height: size, backgroundColor: `${agentColor(agent)}18` }}>
      {source && sourceKey !== failedSource ? (
        <img key={sourceKey} src={source} alt="" aria-hidden="true" width={size} height={size} onError={() => setFailedSource(sourceKey)} />
      ) : (
        <AgentMascot agentId={agent.id} profile={agent} size={size} presence={presence}
          reducedMotion={paused} lookAtCursor={lookAtCursor} flight={flight} />
      )}
    </span>
  )
}

const presenceLabels: Record<AgentPresence, string> = {
  idle: 'Idle', thinking: 'Thinking', tool: 'Using a tool',
  browsing: 'Browsing', 'waiting-approval': 'Waiting for approval',
  error: 'Needs attention',
}

export function AgentCard({
  agent, presence, onOpenInfo, compact = false, paused = false,
}: {
  agent: RosterAgent
  presence: AgentPresence
  onOpenInfo: () => void
  compact?: boolean
  paused?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const detailsId = `agent-card-${agent.id.replace(/[^a-z0-9_-]/gi, '-')}`
  return <div>
    <Tooltip content={compact ? `About ${agent.ui_meta?.display_name ?? agent.name}`
      : `${expanded ? 'Hide' : 'Show'} summary for ${agent.ui_meta?.display_name ?? agent.name}`}
      side={compact ? 'right' : 'top'} className="desk-tooltip-anchor-block">
    <button type="button" className="hd-agent-card" data-presence={presence}
      aria-label={`About ${agent.name}`}
      aria-expanded={compact ? undefined : expanded} aria-controls={compact ? undefined : detailsId}
      onClick={() => compact ? onOpenInfo() : setExpanded(v => !v)}
      style={{ display: 'flex', flexDirection: 'row', height: compact ? 56 : 64,
        padding: compact ? '8px 0' : '12px 8px', gap: compact ? 0 : 8,
        justifyContent: compact ? 'center' : undefined, width: compact ? '100%' : undefined, textAlign: 'left' }}>
      <AgentAvatar agent={agent} size={compact ? 36 : 40} presence={presence} paused={paused} lookAtCursor />
      {!compact && <span style={{ minWidth: 0, flex: 1 }}>
        <strong style={{ display: 'block', fontSize: 'var(--desk-type-13)', lineHeight: 'var(--desk-leading-13)' }}>{agent.ui_meta?.display_name ?? agent.name}</strong>
        <span className="hd-agent-presence" style={{ display: 'block', fontSize: 'var(--desk-type-11)', lineHeight: 'var(--desk-leading-11)', color: 'var(--desk-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span>{presenceLabels[presence]}</span>{agent.model && <> · <span title="Last loaded profile default, not this chat’s reported session model">{agent.model}</span></>}
        </span>
      </span>}
      {!compact && <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={16} />}
    </button>
    </Tooltip>
    {!compact && expanded && <div id={detailsId} className="px-2 pb-2 text-xs">
      {agent.persona?.title && <p className="mb-2 text-[var(--desk-text-secondary)]">{agent.persona.title}</p>}
      <Button onClick={onOpenInfo}>Open agent info</Button>
    </div>}
  </div>
}
