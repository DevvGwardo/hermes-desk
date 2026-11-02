import { useEffect, useMemo, useState } from 'react'
import type { ChatMessage, Group, PendingToolPermission } from '../lib/agents'
import type { LocalPrefs } from '../lib/local-prefs'
import { sortRoster, type RosterActivity, type RosterAgent, type RosterConversation } from '../lib/agents/roster'
import { buildHomeActivity } from '../lib/home-activity'
import { AgentAvatar } from './AgentCard'
import { ListRow } from './ui/ListRow'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Icon } from './ui/icons'
import '../styles/desk-pages.css'

const PAGE_SIZE = 30
export function ChatsPage({ agents, groups, conversations, messagesByThreadId, prefs, activityByAgent, pendingPermissions, liveConversationIds, hydrating, onOpenConversation, onNewChat, onCreateGroup }: {
  agents: RosterAgent[]; groups: Group[]; conversations: RosterConversation[]; prefs: Partial<LocalPrefs>
  messagesByThreadId?: Readonly<Record<string, readonly ChatMessage[] | undefined>>
  activityByAgent?: Readonly<Record<string, RosterActivity>>; liveConversationIds?: ReadonlySet<string>; hydrating?: boolean
  pendingPermissions?: readonly PendingToolPermission[]
  onOpenConversation: (id: string) => void; onNewChat: () => void; onCreateGroup?: () => void
}) {
  const [query, setQuery] = useState('')
  const [agentFilter, setAgentFilter] = useState('')
  const [kind, setKind] = useState('all')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const clock = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(clock) }, [])
  const roster = useMemo(() => sortRoster(agents, [], prefs), [agents, prefs])
  const rows = useMemo(() => {
    const model = buildHomeActivity({ agents, groups, conversations, messagesByThreadId, prefs, activityByAgent, pendingPermissions, liveConversationIds, now, limit: conversations.length })
    const seen = new Set<string>()
    const pinned = new Set(conversations.filter(chat => chat.pinned).map(chat => chat.id))
    const term = query.trim().toLocaleLowerCase()
    return model.sections.flatMap(section => section.items).filter(item => {
      if (seen.has(item.conversationId)) return false
      seen.add(item.conversationId)
      return (kind === 'all' || (kind === 'room' ? !!item.groupId : !item.groupId)) &&
        (!agentFilter || item.agentId === agentFilter) && (!term || `${item.title} ${item.who} ${item.preview}`.toLocaleLowerCase().includes(term))
    }).sort((a, b) => Number(pinned.has(b.conversationId)) - Number(pinned.has(a.conversationId)) || b.at - a.at)
  }, [agents, groups, conversations, messagesByThreadId, prefs, activityByAgent, pendingPermissions, liveConversationIds, now, agentFilter, query, kind])
  const agentsById = new Map(agents.map(agent => [agent.id, agent]))
  return <section className="desk-page desk-theme" aria-labelledby="chats-title">
    <header className="desk-page-heading"><div><h1 id="chats-title">Chats</h1><p>Your conversation history, with agents and shared rooms.</p></div>
      <div className="desk-chats-actions">
        {onCreateGroup && <Button variant="ghost" onClick={onCreateGroup}><Icon name="users" size={16} />New shared room</Button>}
        <Button variant="primary" onClick={onNewChat}><Icon name="plus" size={16} />New chat</Button>
      </div></header>
    <div className="desk-chat-filters">
      <label>Search chats<input type="search" placeholder="Search titles, agents, and previews" value={query}
        onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE) }} /></label>
      <label>Agent<select value={agentFilter} onChange={event => { setAgentFilter(event.target.value); setLimit(PAGE_SIZE) }}>
        <option value="">All agents</option>{roster.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select></label>
      <label>Chat type<select value={kind} onChange={event => { setKind(event.target.value); setLimit(PAGE_SIZE) }}>
        <option value="all">All chats</option><option value="agent">Agent chats</option><option value="room">Shared rooms</option>
      </select></label>
    </div>
    <p className="desk-chat-count" role="status">{hydrating ? 'Loading chats…' : `${rows.length} ${rows.length === 1 ? 'chat' : 'chats'}`}</p>
    <ul className="desk-chat-list" aria-label="Chats">{rows.slice(0, limit).map(item => {
      const agent = item.agentId ? agentsById.get(item.agentId) : undefined
      return <li key={item.conversationId}><ListRow title={item.title} meta={item.groupId ? `Shared room · ${item.who}` : item.who}
        description={item.needs === 'approval' ? 'Waiting for your approval' : item.needs === 'answer' ? 'Waiting for your answer' : item.live ? 'Working…' : item.preview || 'No messages yet'}
        leading={item.groupId ? <Icon name="users" /> : agent ? <AgentAvatar agent={agent} size={36} paused flight={false} /> : <Icon name="chat" />}
        trailing={<><Badge count={item.unread} tone="accent" /><time dateTime={item.at ? new Date(item.at).toISOString() : undefined}>{item.when}</time></>}
        onClick={() => onOpenConversation(item.conversationId)} /></li>
    })}</ul>
    {!hydrating && !rows.length && <div className="desk-page-empty"><h2>{query || agentFilter ? 'No matching chats' : kind === 'room' ? 'No shared rooms yet' : 'No chats yet'}</h2>
      <p>{query || agentFilter ? 'Try another search or change the filters.' : kind === 'room' ? 'Create a shared room to work with multiple agents.' : 'Start a fresh chat with an existing agent.'}</p></div>}
    {rows.length > limit && <Button onClick={() => setLimit(value => value + PAGE_SIZE)}>Show more chats</Button>}
  </section>
}
