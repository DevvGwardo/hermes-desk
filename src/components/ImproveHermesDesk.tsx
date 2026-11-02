import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeResult, ChangeSnapshot } from '../lib/self-modification'
import { AppModal } from './AppModal'
import { SourcePreparation } from './SourcePreparation'
import { CandidateImplementation } from './CandidateImplementation'
import { CandidateValidation } from './CandidateValidation'

const button = 'rounded-lg border border-[var(--ca-border)] px-3 py-2 text-sm hover:bg-[var(--ca-hover)] disabled:opacity-50'
const field = 'mt-2 w-full resize-y rounded-lg border border-[var(--ca-border)] bg-[var(--ca-bg)] p-3 text-sm'

/** A review shell for inert requests. Closing never means cancelling. */
export function ImproveHermesDesk({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<ChangeSnapshot | null>(null)
  // undefined restores the latest record once; null is an explicitly chosen draft.
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined)
  const [request, setRequest] = useState('')
  const [criteria, setCriteria] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [needsReload, setNeedsReload] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const epoch = useRef(0)
  const selectionEpoch = useRef(0)
  const readOwner = useRef<number | null>(null)
  // Superseding a reply never settles its bridge call; hold this until the poll's finally.
  const pollOutstanding = useRef(false)
  const pending = useRef(false)
  // Reopening/polling may refresh records, but only an explicit reload reconciles a mutation.
  const reconciliation = useRef<{ created: boolean } | null>(null)
  const alive = useRef(true)
  const bridge = window.nubAgent?.changes

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; epoch.current++ }
  }, [])

  const reload = useCallback(async (mode: 'open' | 'manual' | 'poll') => {
    if (mode === 'poll' && (pending.current || pollOutstanding.current || readOwner.current !== null || reconciliation.current)) return
    const owner = ++epoch.current
    const selectionOwner = selectionEpoch.current
    readOwner.current = owner
    if (mode === 'poll') pollOutstanding.current = true
    if (mode !== 'poll') {
      setLoading(true)
      if (mode === 'manual' || !reconciliation.current) setError(null)
      setNeedsReload(true)
    }
    try {
      if (!bridge) {
        setError('This build does not provide local change storage. Open an updated desktop build; no browser-only record will be created.')
        return
      }
      const result = await bridge.list()
      if (!alive.current || owner !== epoch.current) return
      if (result.ok) {
        setSnapshot(result)
        const reviewCreated = mode === 'manual' && !pending.current && reconciliation.current?.created &&
          selectionOwner === selectionEpoch.current
        setSelectedId(id => id === null && !reviewCreated ? null :
          result.changes.some(change => change.id === id) ? id : result.changes.at(-1)?.id ?? null)
        if (!pending.current && (mode === 'manual' || !reconciliation.current)) {
          reconciliation.current = null
          setNeedsReload(false)
        }
      } else {
        setError(result.error)
        setNeedsReload(true)
      }
    } catch {
      if (alive.current && owner === epoch.current) {
        setError('Change storage could not be reached. Reload to review saved requests.')
        setNeedsReload(true)
      }
    } finally {
      if (mode === 'poll') pollOutstanding.current = false
      if (readOwner.current === owner) readOwner.current = null
      if (alive.current && owner === epoch.current) setLoading(false)
    }
  }, [bridge])

  useEffect(() => {
    if (open) void reload('open')
    else epoch.current++
    return () => { epoch.current++; readOwner.current = null }
  }, [open, reload])

  const selected = snapshot?.changes.find(change => change.id === selectedId)
  const attempt = selected?.attempts.at(-1)
  const disabled = loading || saving || needsReload || !snapshot || !bridge
  useEffect(() => {
    if (!open || !(['preparing', 'implementing', 'checking'].includes(attempt?.state ?? '') ||
      attempt?.state === 'checked' && attempt.validation?.authority?.stage === 'running' ||
      attempt?.state === 'checked' && attempt.validation?.seal?.stage === 'sealing' ||
      attempt?.state === 'checked' && attempt.validation?.boundBuild?.stage === 'checking' ||
      ['opening', 'open'].includes(attempt?.validation?.preview?.state ?? '')) || saving || loading || needsReload || error) return
    const timer = window.setInterval(() => { void reload('poll') }, 500)
    return () => window.clearInterval(timer)
  }, [open, attempt?.state, attempt?.validation?.preview?.state, attempt?.validation?.authority?.stage, attempt?.validation?.seal?.stage,
    attempt?.validation?.boundBuild?.stage, saving, loading, needsReload, error, reload])

  function selectRequest(id: string | null) {
    selectionEpoch.current++
    setSelectedId(id)
  }

  async function mutate(action: () => Promise<ChangeResult>, created = false) {
    if (!open || disabled || pending.current || reconciliation.current) return
    pending.current = true
    setSaving(true)
    setError(null)
    const owner = ++epoch.current
    const selectionOwner = selectionEpoch.current
    try {
      const result = await action()
      if (!alive.current) return
      if (owner !== epoch.current) {
        reconciliation.current = { created }
        setNeedsReload(true)
        setError('A request finished while this view was closed or reloaded. Reload to review its saved outcome.')
        return
      }
      if (!result.ok) {
        setError(result.error)
        if (result.code !== 'invalid' && result.code !== 'limit') {
          reconciliation.current = { created }
          setNeedsReload(true)
        }
        return
      }
      setSnapshot(result)
      if (created) {
        if (selectionOwner === selectionEpoch.current) setSelectedId(result.changes.at(-1)?.id ?? null)
        setRequest('')
        setCriteria('')
      }
    } catch {
      if (alive.current) {
        reconciliation.current = { created }
        setError('The save acknowledgment was lost. Reload and review saved requests before submitting again. Your draft was retained.')
        setNeedsReload(true)
      }
    } finally {
      pending.current = false
      if (alive.current) setSaving(false)
    }
  }

  return <AppModal open={open} onClose={onClose} title="Improve Hermes Desk" size="xl">
    <div className="border-b border-[var(--ca-border)] px-5 py-4">
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--ca-ink-muted)]">Local request journal · Isolated source preparation</p>
      <p className="mt-2 text-sm">Describe a change. Keep control of what happens next.</p>
      <p className="mt-1 text-sm text-[var(--ca-ink-muted)]">Saving records your request only. No agent runs, code changes, previews or installs are started.</p>
    </div>
    <div className="flex items-center justify-between gap-3 px-5 py-3">
      <p role="status" className="text-sm text-[var(--ca-ink-muted)]">
        {loading ? 'Reading saved requests…' : saving ? 'Saving to local storage…' :
          snapshot ? needsReload ? 'Last loaded records shown. Reload required.' :
            `${snapshot.changes.length} saved request${snapshot.changes.length === 1 ? '' : 's'}` : 'Storage not loaded'}
      </p>
      <button className={button} disabled={loading || saving} onClick={() => void reload('manual')}>Reload requests</button>
    </div>
    {error && <p role="alert" className="mx-5 mb-4 rounded-lg border border-[var(--ca-border)] p-3 text-sm">{error}</p>}
    <div className="grid min-h-[340px] grid-cols-1 border-t border-[var(--ca-border)] sm:grid-cols-[220px_1fr]">
      <nav aria-label="Saved change requests" className="border-b border-[var(--ca-border)] p-3 sm:border-b-0 sm:border-r">
        <button className={`${button} w-full text-left`} aria-current={selectedId === null ? 'true' : undefined}
          disabled={saving} onClick={() => selectRequest(null)}>New request</button>
        {snapshot?.changes.length === 0 && <p className="px-2 py-4 text-sm text-[var(--ca-ink-muted)]">No requests yet.</p>}
        <ul className="mt-3 space-y-1">
          {[...(snapshot?.changes ?? [])].reverse().map(change => <li key={change.id}>
            <button aria-current={selectedId === change.id ? 'true' : undefined}
              className={`w-full rounded-lg p-3 text-left hover:bg-[var(--ca-hover)] ${selectedId === change.id ? 'bg-[var(--ca-primary-soft)]' : ''}`}
              onClick={() => selectRequest(change.id)}>
              <span className="line-clamp-2 break-words text-sm font-medium">{change.request}</span>
              <span className="mt-1 block text-xs text-[var(--ca-ink-muted)]">
                {change.attempts.at(-1)?.state}
              </span>
            </button>
          </li>)}
        </ul>
      </nav>
      <section className="min-w-0 p-5" aria-label={selected ? 'Change detail' : 'New change request'}>
        {selected && attempt ? <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-base font-semibold">{{ requested: 'Request recorded', cancelled: 'Cancelled request',
              preparing: 'Preparing isolated source', prepared: 'Source prepared', implementing: 'Implementing candidate',
              implemented: 'Candidate edits recorded', checking: 'Checking renderer scope', checked: 'Renderer scope checked',
              failed: attempt.validation ? 'Candidate checks or preview failed' : attempt.execution ? 'Implementation failed' : 'Preparation failed' }[attempt.state]}</h3>
            <span className="rounded-full bg-[var(--ca-primary-soft)] px-3 py-1 text-xs">Attempt {selected.attempts.length}</span>
          </div>
          <dl className="mt-5 space-y-4 text-sm">
            <div><dt className="font-semibold">Requested change</dt><dd className="mt-1 whitespace-pre-wrap break-words">{selected.request}</dd></div>
            <div><dt className="font-semibold">Acceptance criteria</dt><dd className="mt-1 whitespace-pre-wrap break-words">{selected.acceptanceCriteria}</dd></div>
            <div><dt className="font-semibold">Development status</dt><dd className="mt-1 text-[var(--ca-ink-muted)]">
              {attempt.state === 'requested' ? 'Not started. This is a saved request, not an executing job.' :
                attempt.state === 'preparing' ? 'Source copying is running. No agent or candidate script is running.' :
                  attempt.state === 'implementing' ? 'Bounded candidate implementation is running. No candidate scripts can run.' :
                    attempt.state === 'implemented' ? 'Candidate text edits are recorded, not validated or approved.' :
                      attempt.state === 'checking' ? 'Fixed renderer checks or build are running. No full app validation or activation.' :
                        attempt.state === 'checked' ? 'Renderer scope checked. This is not a validated app or an activation artifact.' :
                  attempt.state === 'prepared' ? 'Isolated source is prepared. Agent implementation has not started.' :
                    attempt.state === 'failed' ? attempt.validation ? 'Candidate checks or preview failed. Candidate work was retained.' : attempt.execution
                      ? 'Implementation failed or was interrupted. Any candidate edits were retained.'
                      : 'Source preparation failed or was interrupted. Existing work was retained.' :
                      attempt.execution ? 'This attempt is cancelled. Any candidate edits were retained.' : 'This attempt is cancelled. No agent implementation was started.'}
            </dd></div>
            <div><dt className="font-semibold">Evidence</dt><dd className="mt-1 text-[var(--ca-ink-muted)]">
              {attempt.validation ? 'Renderer evidence is recorded below. Native review and renderer-target outcomes belong to separate frontend-delivery records, never unrestricted full-app qualification.' :
                attempt.preparation ? 'Source baseline is recorded. No built artifact, validation results, approval or activation exists.' :
                'Source baseline not selected. No changed files, candidate artifact, validation results, approval or activation exists.'}
            </dd></div>
          </dl>
          <div className="mt-5 flex flex-wrap gap-2">
            {!['cancelled', 'failed'].includes(attempt.state)
              ? <button className={button} disabled={disabled}
                onClick={() => void mutate(() => bridge!.cancel(snapshot!.revision, selected.id, attempt.id))}>Cancel request</button>
              : <button className={button} disabled={disabled}
                onClick={() => void mutate(() => bridge!.reopen(snapshot!.revision, selected.id, attempt.id))}>Reopen request</button>}
          </div>
          <p className="mt-2 text-xs text-[var(--ca-ink-muted)]">
            {['cancelled', 'failed'].includes(attempt.state) ? 'Reopening records a new attempt; it does not run an agent.' : 'Closing this window keeps the request. Cancel explicitly to end this attempt.'}
          </p>
          {bridge && <SourcePreparation key={`${selected.id}:${attempt.id}`} changeId={selected.id} attempt={attempt}
            bridge={bridge} disabled={disabled} onPrepare={(selection, baseline) => void mutate(() =>
              bridge.prepare(snapshot!.revision, selected.id, attempt.id, { selectionId: selection.id, baseline }))} />}
          {bridge && <CandidateImplementation key={`implementation:${selected.id}:${attempt.id}`} changeId={selected.id}
            attempt={attempt} bridge={bridge} disabled={disabled} onImplement={input => void mutate(() =>
              bridge.implement(snapshot!.revision, selected.id, attempt.id, input))} />}
          {bridge && <CandidateValidation attempt={attempt} disabled={disabled}
            delivery={{ bridge, changeId: selected.id, revision: snapshot!.revision }}
            onValidate={() => void mutate(() => bridge.validate(snapshot!.revision, selected.id, attempt.id))}
            onPreview={() => void mutate(() => bridge.preview(snapshot!.revision, selected.id, attempt.id))}
            onAuthority={() => void mutate(() => bridge.authority(snapshot!.revision, selected.id, attempt.id))}
            onSeal={() => void mutate(() => bridge.seal(snapshot!.revision, selected.id, attempt.id))}
            onBoundBuild={() => void mutate(() => bridge.boundBuild(snapshot!.revision, selected.id, attempt.id))}
            onInspect={() => bridge.nativeInputs(snapshot!.revision, selected.id, attempt.id)} />}
          <details className="mt-6 border-t border-[var(--ca-border)] pt-4 text-xs">
            <summary className="cursor-pointer font-semibold">Record and attempt history</summary>
            <p className="mt-3 break-all">Change ID: {selected.id}</p>
            <p className="mt-1">Cancellation epoch: {selected.cancellationEpoch}</p>
            <ol className="mt-3 space-y-3">
              {selected.attempts.map((item, index) => <li key={item.id}>
                <p>Attempt {index + 1}: {item.state}</p>
                <p className="break-all text-[var(--ca-ink-muted)]">{item.id}</p>
                <p>Requested: {item.requestedAt}</p>
                {item.cancelledAt && <p>Cancelled: {item.cancelledAt}</p>}
              </li>)}
            </ol>
          </details>
        </> : <form onSubmit={event => {
          event.preventDefault()
          void mutate(() => bridge!.create(snapshot!.revision, { request, acceptanceCriteria: criteria }), true)
        }}>
          <h3 className="text-base font-semibold">What would you like to improve?</h3>
          <label className="mt-5 block text-sm font-medium">Requested change
            <textarea className={field} rows={4} required maxLength={8000} disabled={saving} value={request}
              onChange={event => { selectRequest(null); setRequest(event.target.value) }} placeholder="Describe the app behavior you want to change." />
          </label>
          <label className="mt-4 block text-sm font-medium">Acceptance criteria
            <textarea className={field} rows={3} required maxLength={4000} disabled={saving} value={criteria}
              onChange={event => { selectRequest(null); setCriteria(event.target.value) }} placeholder="How will you know the change works?" />
          </label>
          <p className="mt-3 text-xs text-[var(--ca-ink-muted)]">Stored only in this app's local data directory. Do not include secrets.</p>
          <button type="submit" className="mt-5 rounded-lg bg-[var(--ca-primary-fill)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--ca-primary-fill-hover)] disabled:opacity-50"
            disabled={disabled || !request.trim() || !criteria.trim()}>Save request</button>
        </form>}
      </section>
    </div>
  </AppModal>
}
