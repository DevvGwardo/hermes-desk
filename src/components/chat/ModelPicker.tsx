import { useId, useMemo, useRef, useState } from 'react'
import type { ModelChoice, ModelOptionsView, ModelSwitchOutcome, ModelSwitchScope } from '../../lib/agents/session-model'

export interface ModelActions {
  load: () => Promise<ModelOptionsView>
  switch: (choice: ModelChoice) => Promise<ModelSwitchOutcome>
}

const SHOWN = 60
const message = (error: unknown) => error instanceof Error && error.message ? error.message : 'Hermes did not answer.'

/** Pick from what Hermes offers this profile; never a free-typed model name. */
export function ModelPicker({ actions, profile, currentModel, currentProvider, offline }: {
  actions: ModelActions
  profile: string
  currentModel?: string
  currentProvider?: string
  offline?: boolean
}) {
  const id = useId()
  const [options, setOptions] = useState<ModelOptionsView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [provider, setProvider] = useState('')
  const [query, setQuery] = useState('')
  const [model, setModel] = useState('')
  const [scope, setScope] = useState<ModelSwitchScope>('session')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const generation = useRef(0)

  const load = async () => {
    const run = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const next = await actions.load()
      if (run !== generation.current) return
      const usable = next.providers.filter((row) => row.models.length)
      const start = usable.find((row) => row.current) ?? usable.find((row) => row.slug === (currentProvider ?? next.provider)) ??
        usable.find((row) => row.authenticated !== false) ?? usable[0]
      setOptions({ ...next, providers: usable })
      setProvider(start?.slug ?? '')
      setModel('')
    } catch (failure) {
      if (run === generation.current) setError(message(failure))
    } finally {
      if (run === generation.current) setLoading(false)
    }
  }

  const row = options?.providers.find((entry) => entry.slug === provider)
  const activeModel = currentModel ?? options?.model
  const activeProvider = currentProvider ?? options?.provider
  const models = useMemo(() => {
    if (!row) return []
    const featured = row.featured.filter((name) => row.models.includes(name))
    const ordered = [...featured, ...row.models.filter((name) => !featured.includes(name))]
    const needle = query.trim().toLowerCase()
    return needle ? ordered.filter((name) => name.toLowerCase().includes(needle)) : ordered
  }, [row, query])

  const submit = async (confirmExpensive = false) => {
    if (!model || !provider) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const outcome = await actions.switch({ model, provider, scope, ...(confirmExpensive ? { confirmExpensive: true } : {}) })
      if (outcome.status === 'confirm') { setConfirm(outcome.message); return }
      setConfirm(null)
      const saved = outcome.scope === 'global' ? ` It is now the default for ${profile}.` : ''
      setStatus(`${outcome.status === 'deferred' ? `Switches to ${model} after the current reply.` : `Switched to ${model}.`}${saved}${outcome.warning ? ` ${outcome.warning}` : ''}`)
      setModel('')
    } catch (failure) {
      setConfirm(null)
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  if (!options) {
    return <div className="chat-model-picker">
      <button type="button" className="chat-model-picker-open" disabled={offline || loading} onClick={() => void load()}>
        {loading ? 'Loading models…' : 'Change model'}
      </button>
      {offline && <p>Reconnect to Hermes to change the model.</p>}
      {error && <p className="chat-session-warning" role="alert">Couldn't load models: {error}</p>}
    </div>
  }

  if (!options.providers.length) {
    return <div className="chat-model-picker">
      <p>Hermes reported no models for {profile}. Set up a provider with <code>hermes model</code>, then try again.</p>
      <button type="button" onClick={() => void load()}>Try again</button>
    </div>
  }

  const unchanged = model === activeModel && provider === activeProvider && scope === 'session'
  return <fieldset className="chat-model-picker" disabled={busy}>
    <legend>Change model</legend>
    <label htmlFor={`${id}-provider`}>Provider</label>
    <select id={`${id}-provider`} value={provider} onChange={(event) => { setProvider(event.target.value); setModel(''); setConfirm(null) }}>
      {options.providers.map((entry) => <option key={entry.slug} value={entry.slug}>
        {entry.name}{entry.current ? ' (current)' : entry.authenticated === false ? ' (not signed in)' : ''}
      </option>)}
    </select>
    {row?.warning && <p className="chat-session-warning">{row.warning}</p>}
    {row?.authenticated === false && <p>This provider isn't signed in. Run <code>hermes model</code> to set it up.</p>}
    <label htmlFor={`${id}-find`}>Model</label>
    <input id={`${id}-find`} type="search" aria-label="Model" value={query} placeholder="Filter models" autoComplete="off" spellCheck={false}
      onChange={(event) => setQuery(event.target.value)} />
    <div className="chat-model-list" role="radiogroup" aria-label={`Models from ${row?.name ?? provider}`}>
      {models.slice(0, SHOWN).map((name) => {
        const unavailable = row?.unavailable.includes(name) ?? false
        const current = name === activeModel && provider === activeProvider
        return <label key={name} data-current={current || undefined} data-unavailable={unavailable || undefined}>
          <input type="radio" name={`${id}-model`} value={name} aria-label={name} checked={model === name} disabled={unavailable}
            onChange={() => { setModel(name); setConfirm(null) }} />
          <span>{name}</span>
          {current && <span className="chat-model-tag">current</span>}
          {unavailable && <span className="chat-model-tag">unavailable</span>}
        </label>
      })}
      {!models.length && <p>No models match.</p>}
    </div>
    {models.length > SHOWN && <p>{models.length - SHOWN} more. Filter to narrow the list.</p>}
    <div className="chat-model-scope" role="radiogroup" aria-label="Apply to">
      <label><input type="radio" name={`${id}-scope`} checked={scope === 'session'} onChange={() => setScope('session')} /> This chat only</label>
      <label><input type="radio" name={`${id}-scope`} checked={scope === 'global'} onChange={() => setScope('global')} /> This chat and new {profile} chats</label>
    </div>
    {confirm ? <div className="chat-model-confirm" role="alertdialog" aria-label="Confirm model switch">
      <p>{confirm}</p>
      <button type="button" onClick={() => void submit(true)}>Switch anyway</button>
      <button type="button" onClick={() => setConfirm(null)}>Cancel</button>
    </div> : <button type="button" className="chat-model-submit" disabled={!model || unchanged || busy}
      onClick={() => void submit()}>{busy ? 'Switching…' : 'Switch model'}</button>}
    {error && <p className="chat-session-warning" role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
  </fieldset>
}
