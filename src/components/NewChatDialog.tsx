import { useState } from 'react'
import { AppModal } from './AppModal'
import { AgentAvatar } from './AgentCard'
import { ListRow } from './ui/ListRow'
import { Button } from './ui/Button'
import type { RosterAgent } from '../lib/agents/roster'

export function NewChatDialog({ open, agents, onClose, onChoose, onCreateAgent }: {
  open: boolean; agents: RosterAgent[]; onClose: () => void; onChoose: (id: string) => void; onCreateAgent: () => void
}) {
  const [query, setQuery] = useState('')
  const choices = agents.filter(agent => agent.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <AppModal open={open} onClose={onClose} title="New chat" size="md">
    <div className="desk-theme desk-new-chat">
      <p>Choose the agent for a fresh chat. This does not create or change an agent.</p>
      {agents.length > 6 && <input aria-label="Find an agent" placeholder="Find an agent" value={query} onChange={event => setQuery(event.target.value)} />}
      <ul>{choices.map(agent => <li key={agent.id}><ListRow title={agent.name} leading={<AgentAvatar agent={agent} size={36} paused flight={false} />}
        onClick={() => { onChoose(agent.id); setQuery('') }} /></li>)}</ul>
      {!choices.length && <p>{agents.length ? 'No matching agents.' : 'Add an agent before starting a chat.'}</p>}
      {!agents.length && <Button onClick={() => { onClose(); onCreateAgent() }}>New agent</Button>}
    </div>
  </AppModal>
}
