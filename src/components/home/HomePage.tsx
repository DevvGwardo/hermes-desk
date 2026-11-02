/**
 * Home (`#/home`): the launch page. Recent work leads, with Pip alongside.
 * Every way out (a row, "Start a session", an agent
 * chip, "All conversations") hands back to the full shell, which App keeps
 * mounted underneath so nothing reloads.
 *
 * Pure view: App owns the data and every navigation.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChatMessage, Group, PendingToolPermission } from '../../lib/agents/types'
import type { LocalPrefs } from '../../lib/local-prefs'
import { presenceFor, sortRoster, type RosterActivity, type RosterAgent, type RosterConversation } from '../../lib/agents/roster'
import { buildHomeActivity, homeGreeting, homeSummary, type HomeActivityItem } from '../../lib/home-activity'
import { readActivityLog, subscribeActivityLog } from '../../lib/activity-log'
import { activityCounts, activityEntries } from '../../lib/home-heatmap'
import { ActivityHeatmap } from './ActivityHeatmap'
import { AgentMascot, agentColor, type AgentMascotPresence } from '../AgentMascot'
import { AgentAvatar } from '../AgentCard'
import { OfflineBanner } from '../OfflineBanner'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Icon } from '../ui/icons'
import { IconButton } from '../ui/IconButton'
import { ListRow } from '../ui/ListRow'
import './home.css'

export const HOME_MASCOT_SIZE = 88
const AGENT_CHIPS = 6
const CLOCK_MS = 60_000

export interface HomePageProps {
  agents: RosterAgent[]
  groups: Group[]
  conversations: RosterConversation[]
  messagesByThreadId?: Readonly<Record<string, readonly ChatMessage[] | undefined>>
  liveConversationIds?: ReadonlySet<string>
  activityByAgent?: Readonly<Record<string, RosterActivity>>
  pendingPermissions?: readonly PendingToolPermission[]
  mascotStates?: Readonly<Record<string, AgentMascotPresence>>
  prefs?: Partial<LocalPrefs>
  hydrating?: boolean
  offline?: boolean
  onRetry?: () => Promise<unknown>
  onDiagnostics?: () => void
  onOpenConversation: (conversationId: string) => void
  /** Open (or start) the agent's chat. */
  onOpenAgent: (agentId: string) => void
  /** Back to the full app, on whatever thread is selected. */
  onOpenApp: () => void
  onStartSession?: () => void
  onCreateAgent?: () => void
  onOpenSearch?: () => void
  onOpenSettings?: () => void
  /** Injected clock for tests. */
  now?: number
}

function needsLabel(item: HomeActivityItem): string | null {
  return item.needs === 'approval' ? 'Waiting for your approval' : item.needs === 'answer' ? 'Waiting for your answer' : null
}

export function HomePage({
  agents, groups, conversations, messagesByThreadId, liveConversationIds, activityByAgent, pendingPermissions, mascotStates, prefs,
  hydrating = false, offline = false, onRetry, onDiagnostics, onOpenConversation, onOpenAgent, onOpenApp,
  onCreateAgent, onStartSession, onOpenSearch, onOpenSettings, now,
}: HomePageProps) {
  // Minute clock: relative times and the heatmap's "today" stay current without
  // rebuilding on every streamed token.
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    if (now !== undefined) return
    const timer = window.setInterval(() => setTick(Date.now()), CLOCK_MS)
    return () => window.clearInterval(timer)
  }, [now])
  const clock = now ?? tick
  const log = useSyncExternalStore(subscribeActivityLog, readActivityLog, readActivityLog)
  // Message days reach the chart through the log (App records them), not by rescanning transcripts here.
  const heatCounts = useMemo(() => activityCounts(activityEntries(conversations), log, clock), [conversations, log, clock])
  const activity = useMemo(() => buildHomeActivity({
    agents, groups, conversations, messagesByThreadId, liveConversationIds, activityByAgent, pendingPermissions, prefs, now: clock,
  }), [agents, groups, conversations, messagesByThreadId, liveConversationIds, activityByAgent, pendingPermissions, prefs, clock])
  const roster = useMemo(() => sortRoster(agents, conversations, prefs), [agents, conversations, prefs])
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const focus = activity.focusAgentId ? agentsById.get(activity.focusAgentId) : undefined
  const presence: AgentMascotPresence = offline ? 'offline' : focus
    ? mascotStates?.[focus.id] ?? presenceFor(activityByAgent?.[focus.id] ?? {}) : 'idle'
  const shown = activity.sections.reduce((count, section) => count + section.items.length, 0)
  const loading = hydrating && activity.total === 0
  const nextWork = activity.sections.find(section => section.id === 'needs-you')?.items[0]
    ?? activity.sections.flatMap(section => section.items).sort((a, b) => b.at - a.at)[0]
  const nextLabel = nextWork?.needs === 'approval' ? 'Review approval'
    : nextWork?.needs === 'answer' ? 'Answer agent' : 'Continue recent chat'
  const primary = useRef<HTMLButtonElement>(null)
  useEffect(() => { primary.current?.focus({ preventScroll: true }) }, [])

  return <main className="hd-home" aria-label="Home" data-testid="home-page">
    {onRetry && onDiagnostics && <OfflineBanner offline={offline} onRetry={onRetry} onDiagnostics={onDiagnostics} />}
    <div className="hd-home-body">
    <div className="hd-home-toolbar">
      {onOpenSearch && <IconButton aria-label="Search" shortcut="⌘K" onClick={onOpenSearch}><Icon name="search" /></IconButton>}
      {onOpenSettings && <IconButton aria-label="Settings" shortcut="⌘," onClick={onOpenSettings}><Icon name="settings" /></IconButton>}
    </div>
    <div className="hd-home-scroll">
      <div className="hd-home-stage">
      <div className="hd-home-column">
        <header className="hd-home-hero">
          <div className="hd-home-mascot" data-presence={presence}
            style={{ ['--hd-home-glow' as string]: focus ? agentColor(focus) : 'var(--desk-accent)' }}>
            <AgentMascot agentId={focus?.id ?? 'default'} profile={focus} size={HOME_MASCOT_SIZE}
              presence={presence} lookAtCursor title={focus ? `${focus.name}, ${presence.replace('-', ' ')}` : 'Pip'} />
          </div>
          <p className="hd-home-date">{new Date(clock).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h1 className="hd-home-greeting">{homeGreeting(clock)}</h1>
          <p className="hd-home-summary" role="status">
            {offline ? 'Hermes is offline. Your recent activity is still here.' :
              loading ? 'Catching up on your activity…' : homeSummary(activity, focus?.name)}
          </p>
          <div className="hd-home-actions">
            {nextWork ? <Button ref={primary} variant="primary" size="lg" className="hd-home-cta"
              onClick={() => onOpenConversation(nextWork.conversationId)}>
              <Icon name={nextWork.needs ? 'reply' : 'chat'} size={18} />{nextLabel}
            </Button> : focus || hydrating || offline ? <Button ref={primary} variant="primary" size="lg" className="hd-home-cta" disabled={!focus || offline}
              onClick={() => { if (onStartSession) onStartSession(); else if (focus) onOpenAgent(focus.id) }}>
              <Icon name="sparkle" size={18} />Start a session
            </Button> : <Button ref={primary} variant="primary" size="lg" className="hd-home-cta" disabled={!onCreateAgent} onClick={() => onCreateAgent?.()}>
              <Icon name="plus" size={18} />Create an agent
            </Button>}
            <Button variant="secondary" size="lg" className="hd-home-secondary" onClick={onOpenApp}>
              All conversations<Icon name="chevron-right" size={16} />
            </Button>
            {nextWork && onStartSession && <Button variant="ghost" size="lg" disabled={offline} onClick={onStartSession}>
              <Icon name="plus" size={16} />New chat
            </Button>}
          </div>
          {roster.length > 1 && <nav className="hd-home-agents" aria-label="Start with an agent">
            {roster.slice(0, AGENT_CHIPS).map((agent) => {
              const busy = presenceFor(activityByAgent?.[agent.id] ?? {})
              return <button key={agent.id} type="button" className="hd-home-agent-chip" data-presence={busy}
                aria-label={`Talk to ${agent.name}`} onClick={() => onOpenAgent(agent.id)}>
                <span className="hd-home-agent-avatar"><AgentAvatar agent={agent} size={24} flight={false} /></span>
                <span>{agent.name}</span>
              </button>
            })}
          </nav>}
        </header>

        <section className="hd-home-activity hd-home-card" aria-labelledby="hd-home-activity-heading" aria-busy={loading || undefined}>
          <header className="hd-home-card-header">
            <h2 id="hd-home-activity-heading" className="hd-home-heading">Recent activity</h2>
            {activity.total > 0 && <button type="button" className="hd-home-link" onClick={onOpenApp}>View all</button>}
          </header>
          {loading ? <ul className="hd-home-list" aria-hidden="true">
            {[0, 1, 2].map((i) => <li key={i} className="hd-home-skeleton" />)}
          </ul> : activity.total === 0 ? <div className="hd-home-empty">
            <p>{roster.length ? 'Nothing here yet. Start a session and your activity will show up here.'
              : 'Create a local agent to begin. If Hermes is missing, open Settings to finish setup.'}</p>
          </div> : activity.sections.map((section) => <div key={section.id} className="hd-home-section" data-section={section.id}>
            <h3 className="hd-home-section-label" id={`hd-home-${section.id}`}>{section.label}</h3>
            <ul className="hd-home-list" aria-labelledby={`hd-home-${section.id}`}>
              {section.items.map((item) => {
                const agent = item.agentId ? agentsById.get(item.agentId) : undefined
                const waiting = needsLabel(item)
                return <li key={item.conversationId}>
                  <ListRow className="hd-home-row" data-conversation-id={item.conversationId} data-needs={item.needs ?? undefined}
                    title={item.title}
                    description={waiting ?? (item.preview || undefined)}
                    meta={item.title === item.who ? undefined : item.who}
                    leading={agent ? <AgentAvatar agent={agent} size={36} flight={false} /> : <span className="hd-home-row-dot" />}
                    trailing={<>
                      {item.live && <span className="hd-home-live" role="img" aria-label="Working now" />}
                      <Badge count={item.unread} tone="accent" />
                      {item.when && <time className="hd-home-when" dateTime={new Date(item.at).toISOString()}>{item.when}</time>}
                    </>}
                    onClick={() => onOpenConversation(item.conversationId)} />
                </li>
              })}
            </ul>
          </div>)}
          {activity.total > shown && <Button variant="ghost" className="hd-home-more" onClick={onOpenApp}>Show all conversations</Button>}
        </section>
        <details className="hd-home-history">
          <summary>Activity history</summary>
          <div className="hd-home-card"><ActivityHeatmap counts={heatCounts} now={clock} /></div>
        </details>
      </div>
      </div>
    </div>
    </div>
  </main>
}
