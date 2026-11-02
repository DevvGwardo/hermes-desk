import type { ReactNode } from 'react'
import { AgentMascot } from './AgentMascot'
import { Button } from './ui/Button'
import '../styles/desk-tokens.css'

export type EmptyStateKind = 'hermes-not-found' | 'no-profiles' | 'no-conversations' | 'empty-lane'
const copy: Record<EmptyStateKind, [string, string, string]> = {
  'hermes-not-found': ['Hermes not found', 'Install Hermes on this Mac, then check its home and restart serve in Settings.', 'Open Settings'],
  'no-profiles': ['No agents to show', 'Restore a hidden profile, show scratch profiles, or create a local agent.', 'Open Settings'],
  'no-conversations': ['Start a conversation', 'Send this agent a message. Your chat stays in its local Hermes profile.', 'New conversation'],
  'empty-lane': ['This lane is empty', 'Open a tab here. Agent lanes keep their own website sign-ins.', 'Open a tab'],
}
export function EmptyState({ kind, onAction, agentId = 'default', children }: {
  kind: EmptyStateKind; onAction?: () => void; agentId?: string; children?: ReactNode
}) {
  const [title, description, label] = copy[kind]
  return <div className="desk-theme m-auto max-w-64 px-4 py-6 text-center" data-empty-state={kind}>
    <AgentMascot agentId={agentId} size={64} lookAtCursor />
    <h3 className="mt-2 text-[15px] font-semibold">{title}</h3>
    <p className="mb-3 mt-1 text-[12px] leading-4 text-[var(--desk-text-secondary)]">{description}</p>
    {children}
    {onAction && <Button variant="primary" onClick={onAction}>{label}</Button>}
  </div>
}
