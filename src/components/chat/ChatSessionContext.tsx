import { useEffect, useId, useRef, useState } from 'react'
import { modelProviderLabel, modelSelectionCommand, type SessionModelRoute } from '../../lib/agents/session-model'
import { Icon } from '../ui/icons'
import './chat-session-context.css'
import type { SessionContextSnapshot } from '../../lib/agents/session-context'
import { SessionContextInspection } from './SessionContextInspection'
import { NativeDelegationInspection } from './NativeDelegationInspection'
import type { NativeDelegationActions } from '../../lib/agents/native-delegation'
import { ModelPicker, type ModelActions } from './ModelPicker'

interface Props {
  profile: string
  configuredModel?: string
  configuredProvider?: string
  route?: SessionModelRoute
  offline?: boolean
  attention?: boolean
  open: boolean
  onToggle: (open: boolean) => void
  onOpenSettings?: () => void
  onInspectContext?: () => Promise<SessionContextSnapshot>
  delegationActions?: NativeDelegationActions
  /** Absent for shared rooms and side chats: the CLI command is the only route there. */
  modelActions?: ModelActions
}

/** Reported route and configured default are different facts, never a live availability claim. */
export function ChatSessionContext({
  profile, configuredModel, configuredProvider, route, offline, attention,
  open, onToggle, onOpenSettings, onInspectContext, delegationActions, modelActions,
}: Props) {
  const model = route?.model ?? configuredModel ?? 'Profile default'
  const provider = route ? route.provider : configuredProvider
  const source = route ? offline ? 'Last reported' : 'Hermes reported' : 'Profile default'
  const command = modelSelectionCommand(profile)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const detailsId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const current = useRef(command)
  const mounted = useRef(true)
  current.current = command
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setCopyStatus(null) }, [command])
  useEffect(() => { if (open) toggleRef.current?.focus({ preventScroll: true }) }, [open])

  async function copyCommand() {
    if (!command) return
    let status: string
    try {
      if (window.nubAgent?.clipboard?.writeText) await window.nubAgent.clipboard.writeText(command)
      else await navigator.clipboard.writeText(command)
      status = 'Command copied'
    } catch {
      status = 'Could not copy. Select the command above and copy it manually.'
    }
    if (mounted.current && current.current === command) setCopyStatus(status)
  }

  const cli = <>
    {command ? <div className="chat-session-command"><code>{command}</code>
      <button type="button" onClick={() => void copyCommand()}>Copy command</button></div>
      : <p>Choose a valid local profile before changing its model.</p>}
    <p>Desk adopts profile changes on the next turn, not during a running reply. Other profiles stay unchanged.</p>
  </>

  return <div className="chat-session-context" data-attention={attention || undefined}
    onKeyDown={event => {
      if (event.key !== 'Escape' || !open) return
      event.preventDefault()
      event.stopPropagation()
      onToggle(false)
      toggleRef.current?.focus()
    }}>
    <button ref={toggleRef} type="button" className="chat-session-context-toggle" aria-label="Chat model and profile"
      aria-expanded={open} aria-controls={open ? detailsId : undefined} onClick={() => onToggle(!open)}>
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />
      <span className="chat-session-model">{model.split('/').filter(Boolean).at(-1) || model}</span>
      {provider && <span className="chat-session-provider">{modelProviderLabel(provider)}</span>}
      <span className="chat-session-source">{attention ? 'Model needs attention' : source}</span>
    </button>
    {open && <section id={detailsId} className="chat-session-details" aria-label="Chat model and profile details" data-esc-layer>
      <header><strong>Model &amp; profile</strong><button type="button" aria-label="Close model details"
        onClick={() => { onToggle(false); toggleRef.current?.focus() }}>Close</button></header>
      <dl>
        <dt>Profile</dt><dd><code>{profile}</code></dd>
        <dt>Model</dt><dd>{model}</dd>
        <dt>Provider</dt><dd>{modelProviderLabel(provider)}</dd>
        <dt>Source</dt><dd>{source}{offline && ' · offline'}</dd>
      </dl>
      {attention && <p className="chat-session-warning" role="status">
        Hermes reported a model/provider problem. Choose an available model for this profile and provider before retrying.
      </p>}
      <p>Tools run on this Mac. Model requests use your provider and are not necessarily local.</p>
      {/* Sibling keys must differ: a shared key makes React duplicate or drop sections on update. */}
      {onInspectContext && <SessionContextInspection key={`context:${profile}`} inspect={onInspectContext} offline={offline} />}
      {delegationActions && <NativeDelegationInspection key={`delegates:${profile}`} actions={delegationActions} offline={offline} />}
      {modelActions && <ModelPicker key={`model:${profile}`} actions={modelActions} profile={profile}
        currentModel={route?.model ?? configuredModel} currentProvider={provider} offline={offline} />}
      <div className="chat-session-recovery">
        {modelActions ? <details><summary>Or use the CLI</summary>{cli}</details>
          : <><strong>Change this profile’s model in the CLI</strong>{cli}</>}
        {copyStatus && <p role="status">{copyStatus}</p>}
      </div>
      {onOpenSettings && <button type="button" className="chat-session-settings"
        onClick={onOpenSettings}>Open agent settings</button>}
    </section>}
  </div>
}
