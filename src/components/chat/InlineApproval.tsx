import { useLayoutEffect, useRef, useState } from 'react'
import type { PendingToolPermission, ToolPermissionChoice } from '../../lib/agents'
import { Button } from '../ui/Button'
import '../../styles/skin-messenger.css'

const LABELS: Record<ToolPermissionChoice, string> = {
  once: 'Allow once', session: 'Allow for this session', always: 'Allow matching actions permanently', deny: "Don't allow",
}

export function InlineApproval({
  ask,
  onChoice,
  agentName,
}: {
  ask: PendingToolPermission
  onChoice: (choice: ToolPermissionChoice, opts?: { optionId?: string }) => void
  agentName?: string
}) {
  const [submitted, setSubmitted] = useState(false)
  const submittedRef = useRef(false)
  useLayoutEffect(() => {
    submittedRef.current = false
    setSubmitted(false)
  }, [ask.id, ask.status])
  const busy = ask.status === 'submitting' || submitted
  const options = ask.options ?? []
  const question = ask.kind === 'question' || options.length > 0
  // Retain the one-time-only boundary for high-stakes requests.
  const choices = ask.choices.filter((choice) => ask.risk !== 'high-stakes' || choice === 'once' || choice === 'deny')
  const submit = (choice: ToolPermissionChoice, opts?: { optionId?: string }) => {
    if (busy || submittedRef.current) return
    submittedRef.current = true
    setSubmitted(true)
    if (opts) onChoice(choice, opts)
    else onChoice(choice)
  }
  return (
    <div className="messenger-inline-approval ca-bubble" data-side="start" data-testid="inline-approval" role="region" aria-label={question ? 'Agent question' : 'Local tool permissions'} aria-busy={busy}>
      <h2>{question ? `${ask.memberName || agentName || 'The agent'} has a question` : `${ask.memberName || agentName || 'The agent'} requests permission`}</h2>
      <p>{ask.description?.trim() || (question ? 'Choose an answer below.' : 'Run an action on your computer.')}</p>
      {!question && <p className="messenger-approval-hint">Allow once applies only to this request. Declining prevents this action; the agent can look for another approach.</p>}
      {ask.command?.trim() && <details><summary>Show requested action</summary><pre>{ask.command.trim()}</pre></details>}
      {ask.risk === 'high-stakes' && <p className="messenger-approval-hint">Money moves need your approval each time. No standing grants.</p>}
      {ask.status === 'failed' && <p role="alert">Your answer didn't go through. Check your connection and try again.</p>}
      <div className="messenger-inline-keyboard" role="group" aria-label={question ? 'Choose an answer' : 'Choose permission'}>
        {options.length > 0 ? options.map((option, i) => (
          <button key={option.id} type="button" disabled={busy} title={option.hint || `Key ${i + 1}`} onClick={() => submit('once', { optionId: option.id })}>
            {option.label}
          </button>
        )) : choices.filter(choice => choice === 'deny' || choice === 'once').sort(choice => choice === 'deny' ? -1 : 1).map((choice) => (
          <Button key={choice} disabled={busy} variant={choice === 'deny' ? 'secondary' : 'primary'} onClick={() => submit(choice)} data-choice={choice}>
            {LABELS[choice]}
          </Button>
        ))}
      </div>
      {!question && choices.some(choice => choice === 'session' || choice === 'always') && <details className="messenger-approval-scope">
        <summary>Broader permission</summary>
        <p>These choices allow matching action patterns, not just the command above. A session grant lasts for this Hermes runtime session. A permanent grant is stored for this agent's Hermes profile.</p>
        {ask.patterns?.length ? <p>Patterns: <code>{ask.patterns.join(', ')}</code></p> : <p>Hermes did not provide the matching pattern. Use Allow once if you are unsure of its scope.</p>}
        <p>To revoke a permanent grant, remove its entry from <code>command_allowlist</code> in this profile's <code>config.yaml</code>, then restart its Hermes session. Closing this card does not revoke it.</p>
        <div className="messenger-inline-keyboard">
          {choices.filter(choice => choice === 'session' || choice === 'always').map(choice => <Button key={choice} disabled={busy} onClick={() => submit(choice)} data-choice={choice}>{LABELS[choice]}</Button>)}
        </div>
      </details>}
      {busy && <p role="status">Sending your decision…</p>}
    </div>
  )
}
