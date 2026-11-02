import { useEffect, useRef, useState } from 'react'
import type { ChangeAttempt, ChangeBridge, ImplementationInput } from '../lib/self-modification'

const button = 'rounded-lg border border-[var(--ca-border)] px-3 py-2 text-sm hover:bg-[var(--ca-hover)] disabled:opacity-50'
const field = 'mt-1 w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-bg)] p-2 text-sm'

export function CandidateImplementation({ changeId, attempt, bridge, disabled, onImplement }: {
  changeId: string; attempt: ChangeAttempt; bridge: ChangeBridge; disabled: boolean
  onImplement: (input: ImplementationInput) => void
}) {
  const [files, setFiles] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [port, setPort] = useState('')
  const [model, setModel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const epoch = useRef(0)
  useEffect(() => {
    epoch.current++
    setFiles([])
    setSelected([])
    setBusy(false)
    setError(null)
    return () => { epoch.current++ }
  }, [changeId, attempt.id, attempt.state])
  async function loadFiles() {
    if (disabled || busy) return
    const owner = epoch.current
    setBusy(true)
    setError(null)
    try {
      const result = await bridge.review(changeId, attempt.id)
      if (owner !== epoch.current) return
      if (result.ok) { setFiles(result.files.filter(file => file.afterSha256 && file.editable !== false).map(file => file.path)); setSelected([]) }
      else setError(result.error)
    } catch {
      if (owner === epoch.current) setError('Candidate files could not be read.')
    } finally { if (owner === epoch.current) setBusy(false) }
  }
  const execution = attempt.execution
  if (attempt.state !== 'prepared' && !execution) return null
  return <section aria-label="Candidate implementation" className="mt-5 border-t border-[var(--ca-border)] pt-4 text-sm">
    <h4 className="font-semibold">Candidate implementation</h4>
    {attempt.state === 'prepared' && <form onSubmit={event => {
      event.preventDefault()
      onImplement({ port: Number(port), model: model.trim(), files: selected })
    }}>
      <p className="mt-2 text-[var(--ca-ink-muted)]">Hermes proposes bounded text edits. It has no tools or live profile. Main applies only checked candidate paths; no candidate scripts run.</p>
      <p className="mt-2 text-xs">Supply a tool-free local model server, not an agent gateway. Native confirmation is required before inference. The endpoint may charge you; there is no guaranteed billing cap.</p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label>Local model port<input className={field} type="number" min={1024} max={65535} required value={port}
          disabled={disabled || busy} onChange={event => setPort(event.target.value)} /></label>
        <label>Model name<input className={field} required maxLength={200} value={model}
          disabled={disabled || busy} onChange={event => setModel(event.target.value)} /></label>
      </div>
      <button className={`${button} mt-3`} type="button" disabled={disabled || busy} onClick={() => void loadFiles()}>Choose candidate context files</button>
      <p className="mt-2 text-xs text-[var(--ca-ink-muted)]">Select 1–12 frontend presentation files, at most 64 KiB each and 256 KiB total. Main rejects protected native, persistence, permission, dependency and build-control changes, including new paths. Inspect selected text for secrets before sending.</p>
      {files.length > 0 && <fieldset className="mt-3 max-h-40 space-y-2 overflow-auto rounded-lg border border-[var(--ca-border)] p-3">
        <legend className="px-1 text-xs">Source text to send</legend>
        {files.map(file => <label key={file} className="flex gap-2 font-mono text-xs">
          <input type="checkbox" disabled={disabled || busy || !selected.includes(file) && selected.length >= 12}
            checked={selected.includes(file)} onChange={event => setSelected(current =>
              event.target.checked ? [...current, file] : current.filter(name => name !== file))} />
          <span className="break-all">{file}</span>
        </label>)}
      </fieldset>}
      <button className={`${button} mt-3`} disabled={disabled || busy || !selected.length || !port || !model.trim()}>
        Request candidate implementation
      </button>
    </form>}
    {execution && <div className="mt-3 space-y-2">
      <p>{attempt.state === 'cancelled' ? 'Cancelled. Any partial edits were retained.' :
        execution.stage === 'running' ? 'Hermes is preparing an untrusted proposal. Candidate scripts cannot run.' :
          execution.stage === 'applying' ? 'Main is applying checked candidate edits. Cancellation may retain partial edits.' :
            execution.stage === 'implemented' ? attempt.validation
              ? 'Candidate edits recorded. Renderer evidence and separate frontend-delivery outcomes are shown below; no unrestricted native qualification.'
              : 'Candidate edits recorded. Not tested, previewed, approved or activated.' : 'Implementation failed. Candidate work was retained.'}</p>
      <p className="text-xs">{execution.calls} inference requests recorded before dispatch. Provider completion and cost may be unknown.</p>
      <p className="break-all font-mono text-xs">Input digest: {execution.inputDigest}</p>
      {execution.outputDigest && <p className="break-all font-mono text-xs">Observed source-content digest: {execution.outputDigest}</p>}
      {execution.error && <p role="alert">{execution.error}</p>}
    </div>}
    {busy && <p className="mt-2">Reading candidate files…</p>}
    {error && <p role="alert" className="mt-2">{error}</p>}
  </section>
}
