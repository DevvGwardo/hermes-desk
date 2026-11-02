import { useEffect, useRef, useState } from 'react'
import type { ChangeAttempt, ChangeBridge, RepositorySelection, WorkspaceReview } from '../lib/self-modification'

const button = 'rounded-lg border border-[var(--ca-border)] px-3 py-2 text-sm hover:bg-[var(--ca-hover)] disabled:opacity-50'

export function SourcePreparation({ changeId, attempt, bridge, disabled, onPrepare }: {
  changeId: string
  attempt: ChangeAttempt
  bridge: ChangeBridge
  disabled: boolean
  onPrepare: (selection: RepositorySelection, baseline: 'head' | 'working-tree') => void
}) {
  const [selection, setSelection] = useState<RepositorySelection | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [workingConfirmed, setWorkingConfirmed] = useState(false)
  const [review, setReview] = useState<WorkspaceReview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const epoch = useRef(0)
  const pending = useRef(false)
  useEffect(() => {
    epoch.current++
    setSelection(null)
    setConfirmed(false)
    setWorkingConfirmed(false)
    setReview(null)
    setError(null)
    return () => { epoch.current++ }
  }, [changeId, attempt.id])

  async function inspect(kind: 'select' | 'review') {
    if (disabled || pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    const owner = epoch.current
    try {
      if (kind === 'select') {
        const result = await bridge.selectRepository()
        if (owner !== epoch.current) return
        if (result.ok) { setSelection(result.selection); setConfirmed(false); setWorkingConfirmed(false) }
        else setError(result.error)
      } else {
        const result = await bridge.review(changeId, attempt.id)
        if (owner !== epoch.current) return
        if (result.ok) setReview(result)
        else { setReview(null); setError(result.error) }
      }
    } catch {
      if (owner === epoch.current) setError('Source inspection could not finish. Existing source and workspaces were retained.')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const prep = attempt.preparation
  useEffect(() => { setReview(null) }, [attempt.execution?.stage])
  return <section aria-label="Isolated source preparation" className="mt-5 border-t border-[var(--ca-border)] pt-4 text-sm">
    <h4 className="font-semibold">Source preparation</h4>
    {attempt.state === 'requested' && <>
      <p className="mt-2 text-[var(--ca-ink-muted)]">Choose and review a local source baseline. Nothing is selected automatically. Copying does not run an agent or app scripts.</p>
      <button className={`${button} mt-3`} disabled={disabled || busy} onClick={() => void inspect('select')}>Choose source repository</button>
      {selection && <div className="mt-3 space-y-2 rounded-lg border border-[var(--ca-border)] p-3">
        <p className="break-all">Source: {selection.root}</p>
        <p className="break-all font-mono text-xs">Committed HEAD: {selection.head}</p>
        <p>{selection.dirtyEntries} dirty/untracked entries will be excluded and preserved in the original checkout.</p>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={confirmed} disabled={disabled || busy} onChange={event => { setConfirmed(event.target.checked); setWorkingConfirmed(false) }} />
          <span>Use committed HEAD only. I understand this excludes all uncommitted and untracked work.</span>
        </label>
        {selection.workingTree && <>
          <details>
            <summary>Review working-tree baseline: {selection.workingTree.fileCount} allowlisted files, {selection.workingTree.changes.length} differences from HEAD</summary>
            <p className="break-all font-mono text-xs">Snapshot: {selection.workingTree.digest}</p>
            <p className="text-xs">Only src, public, electron and fixed package/build declarations; ignored files, secrets and tooling are excluded. Native/persistence bytes are baseline inputs, never proposal-editable.</p>
            {selection.workingTree.changes.map(file => <details key={file.path}>
              <summary>{file.path} · {file.status}{file.binary ? ' · binary' : ''}</summary>
              <p className="break-all text-xs">{file.beforeSha256 ?? 'absent'} → {file.afterSha256 ?? 'absent'}</p>
              {file.diff && <pre className="overflow-auto whitespace-pre text-xs">{file.diff}</pre>}
            </details>)}
          </details>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={workingConfirmed} disabled={disabled || busy}
              onChange={event => { setWorkingConfirmed(event.target.checked); setConfirmed(false) }} />
            <span>Use this reviewed working-tree snapshot, including its allowlisted uncommitted work. Preserve the original checkout unchanged.</span>
          </label>
        </>}
        <button className={button} disabled={disabled || busy || (!confirmed && !workingConfirmed)}
          onClick={() => onPrepare(selection, workingConfirmed ? 'working-tree' : 'head')}>Prepare isolated source</button>
      </div>}
    </>}
    {prep && <div className="mt-3 space-y-2">
      <p className="break-all">Selected source: {prep.source.root}</p>
      <p className="break-all font-mono text-xs">Baseline: {prep.source.head}</p>
      <p>{prep.source.kind === 'head' ? `Committed HEAD only; ${prep.source.dirtyEntries} dirty/untracked entries excluded.` :
        'Explicit reviewed working-tree snapshot. Original dirty work remains untouched.'}</p>
      <p className="break-all font-mono text-xs">Workspace ID: {prep.workspace.id}</p>
      {attempt.state === 'preparing' && <p role="status">Preparing a separate source copy. You can cancel this attempt.</p>}
      {prep.fileCount !== null && <p>{prep.fileCount} baseline files copied. {attempt.execution
        ? 'Implementation history is recorded below. No candidate build scripts have run.'
        : 'No app code has been edited or executed by this workflow.'}</p>}
      {prep.error && <p role="alert">{prep.error}</p>}
      {attempt.state === 'cancelled' && <p>Any existing workspace is retained. This attempt cannot continue.</p>}
      {prep.manifestDigest && <button className={button} disabled={disabled || busy} onClick={() => void inspect('review')}>Review candidate files and diffs</button>}
    </div>}
    {error && <p role="alert" className="mt-3">{error}</p>}
    {busy && <p className="mt-2 text-[var(--ca-ink-muted)]">Reading source information…</p>}
    {review && <div className="mt-4">
      <p className="font-semibold">{review.files.filter(file => file.status !== 'unchanged').length} changed files · {review.files.length} files reviewed</p>
      <p className="mt-1 text-xs text-[var(--ca-ink-muted)]">A file review is not validation, a preview, or approval. Truncated and binary diffs are identified.</p>
      <ul className="mt-3 space-y-2">
        {review.files.map(file => <li key={file.path}>
          <details className="rounded-lg border border-[var(--ca-border)] p-2">
            <summary className="cursor-pointer break-all font-mono text-xs">{file.path} · {file.status}</summary>
            <p className="mt-2 break-all text-xs">Baseline digest: {file.beforeSha256 ?? 'absent'}</p>
            <p className="mt-1 break-all text-xs">Candidate digest: {file.afterSha256 ?? 'absent'}</p>
            {file.binary && <p className="mt-2 text-xs">Binary content changed; no text diff is shown.</p>}
            {file.truncated && <p className="mt-2 text-xs">Diff truncated for display. This is not a complete review.</p>}
            {file.diff && <pre className="mt-2 overflow-x-auto whitespace-pre text-xs">{file.diff}</pre>}
          </details>
        </li>)}
      </ul>
    </div>}
  </section>
}
