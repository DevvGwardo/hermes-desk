import { useEffect, useRef, useState } from 'react'
import type { ChangeAttempt, ChangeBridge, DeliveryRecord, DeliveryResult, DeliveryReview, NativeInputsResult } from '../lib/self-modification'

const button = 'rounded-lg border border-[var(--ca-border)] px-3 py-2 text-sm hover:bg-[var(--ca-hover)] disabled:opacity-50'

export function CandidateValidation({ attempt, disabled, onValidate, onPreview, onAuthority, onSeal, onBoundBuild, onInspect, delivery }: {
  attempt: ChangeAttempt; disabled: boolean; onValidate: () => void; onPreview: () => void; onAuthority: () => void
  onSeal: () => void; onBoundBuild: () => void
  onInspect: () => Promise<NativeInputsResult>
  delivery?: { bridge: ChangeBridge; changeId: string; revision: number }
}) {
  const evidence = attempt.validation
  const [inspection, setInspection] = useState<NativeInputsResult | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const inspectionEpoch = useRef(0)
  useEffect(() => {
    inspectionEpoch.current++; setInspection(null); setInspecting(false)
    return () => { inspectionEpoch.current++ }
  }, [attempt.id, attempt.state, evidence?.boundBuild?.artifact?.boundDigest])
  async function inspect() {
    const epoch = ++inspectionEpoch.current
    setInspecting(true); setInspection(null)
    try {
      const result = await onInspect()
      if (epoch === inspectionEpoch.current) setInspection(result)
    } catch {
      if (epoch === inspectionEpoch.current) setInspection({ ok: false, code: 'unavailable',
        error: 'Native input inspection was not acknowledged. No launch or qualification occurred.' })
    } finally { if (epoch === inspectionEpoch.current) setInspecting(false) }
  }
  if (!evidence && attempt.state !== 'implemented') return null
  return <section aria-label="Scoped renderer checks" className="mt-6 border-t border-[var(--ca-border)] pt-5">
    <p className="text-xs font-semibold uppercase tracking-widest text-[var(--ca-ink-muted)]">Renderer only · Separate exact-artifact native consent</p>
    <h4 className="mt-2 text-sm font-semibold">Check the source. Inspect a sealed display.</h4>
    <p className="mt-2 text-sm text-[var(--ca-ink-muted)]">
      Fixed TypeScript, syntax and Vite checks use provisioned dependencies in a private macOS sandbox.
      Candidate build configuration and package scripts are ignored. Native confirmation is required.
    </p>
    <p className="mt-2 text-xs text-[var(--ca-ink-muted)]">
      No installs, network, model calls or live profile. The preview has no app bridge and closes after two minutes.
      Main-process behavior, your acceptance criteria and app health are not verified.
    </p>
    {attempt.state === 'implemented' && <button className={`${button} mt-4`} disabled={disabled}
      onClick={onValidate}>Run scoped renderer checks</button>}
    {evidence && <div className="mt-4 border-l-2 border-[var(--ca-border)] pl-4 text-xs">
      <p role="status">{evidence.stage === 'checking' ? 'Fixed checks running…' :
        evidence.stage === 'building' ? 'Fixed checks passed; renderer build running…' :
          evidence.stage === 'checked' ? 'Scoped checks passed. A sealed renderer artifact was recorded.' : 'Candidate checks or preview failed.'}</p>
      <p className="mt-2 break-all font-mono">Source: {evidence.sourceDigest}</p>
      {evidence.artifact && <p className="mt-2 break-all font-mono">Renderer: {evidence.artifact.digest}</p>}
      {evidence.error && <p role="alert" className="mt-2">{evidence.error}</p>}
      {evidence.preview && <p className="mt-3">
        Display: {evidence.preview.state}. {evidence.preview.rendererReady ? 'Renderer loading was observed.' : 'Renderer readiness was not recorded.'}
        {' '}Behavior verified: no. {evidence.preview.error}
      </p>}
      <p className="mt-3 font-semibold">These checks alone are not native qualification or activation authority. The separate frontend delivery record below owns those decisions.</p>
    </div>}
    {attempt.state === 'checked' && <div className="mt-4 flex flex-wrap gap-2">
      <button className={button} disabled={disabled || evidence?.authority?.stage === 'running' ||
        evidence?.seal?.stage === 'sealing' ||
        evidence?.boundBuild?.stage === 'checking' ||
        ['opening', 'open'].includes(evidence?.preview?.state ?? '')} onClick={onPreview}>Open isolated renderer preview</button>
      {!evidence?.authority && <button className={button} disabled={disabled ||
        ['opening', 'open'].includes(evidence?.preview?.state ?? '')} onClick={onAuthority}>Run isolated authority contracts</button>}
      {evidence?.authority?.stage === 'passed' && (!evidence.seal || evidence.seal.stage === 'sealed') &&
        <button className={button} disabled={disabled || ['opening', 'open'].includes(evidence.preview?.state ?? '')}
          onClick={onSeal}>{evidence.seal ? 'Verify sealed app inputs' : 'Seal full app inputs'}</button>}
      {evidence?.seal?.stage === 'sealed' && (!evidence.boundBuild || evidence.boundBuild.stage === 'passed') &&
        <button className={button} disabled={disabled || ['opening', 'open'].includes(evidence.preview?.state ?? '')}
          onClick={onBoundBuild}>{evidence.boundBuild ? 'Verify bound renderer build' : 'Build against sealed dependencies'}</button>}
      {evidence?.boundBuild?.stage === 'passed' && <button className={button}
        disabled={disabled || inspecting || ['opening', 'open'].includes(evidence.preview?.state ?? '')}
        onClick={() => void inspect()}>Inspect native inputs</button>}
    </div>}
    {(inspecting || inspection) && <div className="mt-5 border-l-2 border-[var(--ca-border)] pl-4 text-xs">
      <p className="font-semibold">Native input diagnostics · No launch authority</p>
      {inspecting ? <p role="status" className="mt-2">Verifying bound inputs and inspecting literal CommonJS paths…</p> :
        inspection?.ok ? <>
          <p role="status" className="mt-2">{inspection.nativeInputs.missingTotal} missing literal native input paths observed.</p>
          <p className="mt-2">Lexical diagnostics only. Comments and strings may match; dynamic, aliased, package and ESM imports
            are not qualified. Zero missing paths does not mean a runnable or safe app. No native code was executed.</p>
          <p className="mt-2">Scan limit: 256 files / 2 MiB. Files scanned: {inspection.nativeInputs.scannedFiles};
            {' '}skipped: {inspection.nativeInputs.skippedFiles}.</p>
          <p className="mt-2 break-all font-mono">Inspected build: {inspection.nativeInputs.boundDigest}</p>
          <ul className="mt-2 space-y-1">{inspection.nativeInputs.missing.map(name => <li key={name} className="break-all font-mono">{name}</li>)}</ul>
          {inspection.nativeInputs.missingTotal > inspection.nativeInputs.missing.length && <p>Only the first 128 paths are shown.</p>}
        </> : <p role="alert" className="mt-2">{inspection?.error}</p>}
    </div>}
    {evidence?.boundBuild && <div className="mt-5 border-l-2 border-[var(--ca-border)] pl-4 text-xs">
      <p className="font-semibold">Copied dependency graph · Renderer build provenance</p>
      <p role="status" className="mt-2">{attempt.state === 'cancelled' && evidence.boundBuild.stage === 'checking' ?
        'Bound checks cancelled. Completion remains unknown; work was retained.' :
        evidence.boundBuild.stage === 'checking' ? 'Fixed renderer checks running against copied dependencies…' :
        evidence.boundBuild.stage === 'passed' ? 'New renderer output is bound to the sealed source and dependency graph.' :
          'Bound checks failed or were interrupted. No app was activated.'}</p>
      <p className="mt-2">{evidence.boundBuild.stage === 'passed' ? 'The display now uses this new renderer, not the earlier output.' :
        'Only successful, acknowledged output can become the displayed renderer.'}
        {' '}
        This binding includes the full app-input identity and build policy. Native behavior and app health remain unverified.</p>
      {evidence.boundBuild.artifact && <>
        <p className="mt-2 break-all font-mono">Bound build: {evidence.boundBuild.artifact.boundDigest}</p>
        <p className="mt-2 break-all font-mono">New renderer: {evidence.boundBuild.artifact.rendererDigest}</p>
      </>}
      {evidence.boundBuild.error && <p role="alert" className="mt-2">{evidence.boundBuild.error}</p>}
    </div>}
    {evidence?.seal && <div className="mt-5 border-l-2 border-[var(--ca-border)] pl-4 text-xs">
      <p className="font-semibold">Full app inputs · Activation-ineligible identity</p>
      <p role="status" className="mt-2">{attempt.state === 'cancelled' && evidence.seal.stage === 'sealing' ?
        'Sealing cancelled. Completion remains unknown; partial work was retained.' :
        evidence.seal.stage === 'sealing' ? 'Copying source, renderer and provisioned dependencies…' :
        evidence.seal.stage === 'sealed' ? 'Full app-input identity recorded. Native qualification remains incomplete.' :
          'Sealing failed or was interrupted. No app was activated.'}</p>
      <p className="mt-2">Source, renderer and the complete provisioned dependency tree are copied, not executed.
        This is not a signed installation package, verified dependency behavior, approval or app health.</p>
      {evidence.seal.artifact && <p className="mt-2 break-all font-mono">App inputs: {evidence.seal.artifact.digest}</p>}
      <p className="mt-2 break-all font-mono">Dependencies: {evidence.seal.dependencyDigest}</p>
      {evidence.seal.error && <p role="alert" className="mt-2">{evidence.seal.error}</p>}
    </div>}
    {evidence?.authority && <div className="mt-5 border-l-2 border-[var(--ca-border)] pl-4 text-xs">
      <p className="font-semibold">Main/preload · Test-double contracts only</p>
      <p role="status" className="mt-2">{attempt.state === 'cancelled' && evidence.authority.stage === 'running' ?
        'Cancelled. Completion was not acknowledged; observations remain unknown.' :
        evidence.authority.stage === 'running' ? 'Isolated authority observations running…' :
        evidence.authority.stage === 'passed' ? `${evidence.authority.checks} independent fixture contracts passed.` :
          'Authority fixture contracts failed or were interrupted.'}</p>
      <p className="mt-2">Candidate main/preload ran under kernel isolation with inert Electron/host adapters.
        VM is not the security boundary. Native behavior, dependencies and full app health remain unverified.</p>
      <p className="mt-2 break-all font-mono">Definitions: {evidence.authority.definitionDigest}</p>
      {evidence.authority.observationDigest && <p className="mt-2 break-all font-mono">Observations: {evidence.authority.observationDigest}</p>}
      {evidence.authority.error && <p role="alert" className="mt-2">{evidence.authority.error}</p>}
    </div>}
    {delivery && evidence?.boundBuild?.stage === 'passed' &&
      <FrontendDelivery key={attempt.id} {...delivery} attempt={attempt} disabled={disabled} />}
  </section>
}

function FrontendDelivery({ bridge, changeId, revision, attempt, disabled }: {
  bridge: ChangeBridge; changeId: string; revision: number; attempt: ChangeAttempt; disabled: boolean
}) {
  const [records, setRecords] = useState<DeliveryRecord[]>([])
  const [review, setReview] = useState<DeliveryReview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [authority, setAuthority] = useState<{
    changeId: string; attemptId: string; revision: number; bridge: ChangeBridge; available: boolean
  } | null>(null)
  const statusReviewed = authority?.changeId === changeId && authority.attemptId === attempt.id &&
    authority.revision === revision && authority.bridge === bridge
  const epoch = useRef(0)
  const outstanding = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; epoch.current++ }
  }, [])
  useEffect(() => {
    epoch.current++; setReview(null); setAuthority(null)
    if (outstanding.current) {
      setUncertain(true)
      setError('The request or revision changed while delivery was outstanding. Reload its retained outcome; do not resubmit.')
    }
    return () => { epoch.current++ }
  }, [attempt.id, attempt.state, revision, changeId, bridge])
  async function action(fn: () => Promise<DeliveryResult>, reconcile = false) {
    if (outstanding.current || disabled || uncertain && !reconcile ||
      !reconcile && (!statusReviewed || !authority?.available)) return
    outstanding.current = true
    const owner = ++epoch.current
    setBusy(true); setError(null)
    try {
      const result = await fn()
      if (owner !== epoch.current) return
      if (result.ok) {
        setRecords(result.records); setReview(result.review ?? null)
        if (reconcile) {
          setUncertain(false)
          setAuthority({ changeId, attemptId: attempt.id, revision, bridge,
            available: result.authorityAvailable === true && result.historicalReadOnly === false })
        }
      } else {
        setError(result.error); setReview(null)
        if (reconcile) setAuthority(null)
        if (result.code !== 'invalid' && result.code !== 'limit') setUncertain(true)
      }
    } catch {
      if (owner === epoch.current) {
        setError('Delivery acknowledgment unknown. Reload delivery records; never resubmit unknown work.')
        setReview(null); setUncertain(true)
        if (reconcile) setAuthority(null)
      }
    } finally {
      outstanding.current = false
      if (alive.current) setBusy(false)
    }
  }
  const current = records.at(-1)
  const unsupported = !bridge.deliveryStatus || !bridge.qualify || !bridge.deliveryReview ||
    !bridge.approve || !bridge.selectActivationTarget || !bridge.activate
  const off = disabled || busy || uncertain || unsupported || !statusReviewed || !authority?.available || attempt.state !== 'checked'
  return <section aria-label="Guarded frontend delivery" className="mt-6 border-t border-[var(--ca-border)] pt-4 text-sm">
    <h4 className="font-semibold">Frontend-only delivery · Immutable trusted native host</h4>
    <p className="mt-2 text-xs">Protected native/preload/security, dependencies/build controls and persistence compatibility cannot change.
      Generated UI is a separately versioned data-only trusted catalog, not JavaScript extensions, plugins or new permissions.</p>
    <p className="mt-2 text-xs">Native health covers disposable window, preload, fixed bridge and renderer readiness, not your acceptance criteria or a live profile.
      Only explicitly selected idle compatible renderer targets can be staged. Packaged/running app bundles are refused; your app is never silently restarted.</p>
    {unsupported && <p role="alert">This desktop host lacks frontend delivery methods. No qualification or activation is available.</p>}
    {!unsupported && (!statusReviewed ?
      <p role="status" className="mt-2 text-xs">Reload delivery records to review retained outcomes before starting delivery.</p> :
      !authority?.available && <p role="status" className="mt-2 text-xs">Native delivery authority is unavailable. Retained records are read-only; no qualification or activation is available.</p>)}
    <div className="mt-3 flex flex-wrap gap-2">
      <button className={button} disabled={disabled || busy || unsupported}
        onClick={() => void action(() => bridge.deliveryStatus!(changeId, attempt.id), true)}>Reload delivery records</button>
      {!current && <button className={button} disabled={off}
        onClick={() => void action(() => bridge.qualify!(revision, changeId, attempt.id))}>Qualify disposable native renderer</button>}
      {current?.stage === 'qualified' && <>
        <button className={button} disabled={off}
          onClick={() => void action(() => bridge.deliveryReview!(revision, changeId, attempt.id))}>Review exact artifact and diff</button>
        <button className={button} disabled={off || !review || review.versionId !== current.versionId}
          onClick={() => void action(() => bridge.approve!(revision, changeId, attempt.id, current.versionId, review!.reviewDigest))}>Request independent native approval</button>
      </>}
      {current?.stage === 'approved' && <>
        <button className={button} disabled={off}
          onClick={() => void action(() => bridge.selectActivationTarget!(revision, changeId, attempt.id, current.versionId))}>Choose compatible idle renderer target</button>
        <button className={button} disabled={off || !current.target}
          onClick={() => void action(() => bridge.activate!(revision, changeId, attempt.id, current.versionId))}>Request staged renderer application</button>
      </>}
    </div>
    {busy && <p role="status" className="mt-3">Waiting for trusted native delivery acknowledgment… Cancellation invalidates authority.</p>}
    {error && <p role="alert" className="mt-3">{error}</p>}
    {review && <div className="mt-3 text-xs">
      <p className="break-all font-mono">Exact review: {review.reviewDigest}</p>
      <p>{review.healthScope}</p>
      <ul>{review.checks.map(check => <li key={check}>{check}</li>)}</ul>
      {review.changes.map(file => <details key={file.path}>
        <summary>{file.path}</summary><p className="break-all">{file.beforeSha256} → {file.afterSha256}</p>
        <pre className="overflow-auto whitespace-pre">{file.diff}</pre>
      </details>)}
    </div>}
    <ol className="mt-3 space-y-3 text-xs">{records.map(record => <li key={record.versionId}>
      <p role="status">Version {record.versionId}: {record.stage}</p>
      <p className="break-all font-mono">Artifact: {record.qualification?.artifactDigest ?? 'Not qualified'}</p>
      {record.qualification?.hostIdentity && <p>Protected host version: {record.qualification.hostIdentity.version}
        {' · '}{record.qualification.hostIdentity.origin.kind}</p>}
      {record.qualification?.runtime && <p className="break-all font-mono">Verified copied runtime:
        {' '}{record.qualification.runtime.sha256} · observed PID {record.qualification.runtime.pid}</p>}
      {record.approval && <p>Exact-artifact approval expires {record.approval.expiresAt}</p>}
      {record.target && <p className="break-all">Selected target: {record.target.root}</p>}
      {record.outcome && <p>{record.outcome.reason}</p>}
      {record.error && <p role="alert">{record.error}</p>}
    </li>)}</ol>
  </section>
}
