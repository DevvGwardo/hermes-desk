import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangeAttempt, ChangeBridge, DeliveryRecord, DeliveryResult, ValidationRecord } from '../lib/self-modification'
import { CandidateValidation } from './CandidateValidation'
afterEach(cleanup)
const digest = 'a'.repeat(64)
const base: ChangeAttempt = { id: 'attempt', state: 'implemented', epoch: 0, requestedAt: 'now', statusAt: 'now',
  cancelledAt: null, preparation: null, execution: null, validation: null }
const validation: ValidationRecord = { operationId: 'operation', ownerPid: 1, scope: 'renderer-only', stage: 'checked',
  sourceDigest: digest, toolchainDigest: digest, checksPassed: true, error: null, preview: null, authority: null, seal: null, boundBuild: null,
  artifact: { id: 'artifact', token: 'token', dev: 0, ino: 1, digest, sourceDigest: digest, toolchainDigest: digest,
    fileCount: 1, scope: 'renderer-only', activationEligible: false } }
const passed: NonNullable<ValidationRecord['authority']> = { operationId: 'authority', ownerPid: 1,
  scope: 'main-preload-test-doubles', stage: 'passed', sourceDigest: digest, rendererDigest: digest,
  definitionDigest: digest, observationDigest: digest, checks: 6, nativeBehaviorVerified: false,
  fullAppQualified: false, error: null }
const sealing: NonNullable<ValidationRecord['seal']> = { operationId: 'seal', ownerPid: 1, scope: 'full-app-inputs',
  stage: 'sealing', sourceDigest: digest, rendererDigest: digest, toolchainDigest: digest, dependencyDigest: digest,
  artifact: null, fullAppQualified: false, error: null }
const inspectedAttempt: ChangeAttempt = { ...base, state: 'checked', validation: { ...validation, boundBuild: {
  operationId: 'bound', ownerPid: 1, scope: 'sealed-graph-renderer', stage: 'passed', inputDigest: digest,
  sourceDigest: digest, dependencyDigest: digest, toolchainDigest: digest, fullAppQualified: false, error: null,
  artifact: { id: 'bound-artifact', token: 'token', dev: 0, ino: 1, rendererDigest: digest, boundDigest: digest,
    fileCount: 1, activationEligible: false },
} } }
const diagnostic = { ok: true as const, nativeInputs: { scope: 'lexical-native-inputs' as const,
  inputDigest: digest, sourceDigest: digest, boundDigest: digest, missing: ['electron/missing.cjs'], missingTotal: 1,
  literalRequires: 1, nonliteralRequires: 0, scannedFiles: 2, skippedFiles: 0, inspectionComplete: false as const, nativeExecuted: false as const,
  fullAppQualified: false as const, activationEligible: false as const } }
function view(attempt = base, disabled = false) {
  const onValidate = vi.fn(), onPreview = vi.fn(), onAuthority = vi.fn(), onSeal = vi.fn(), onBoundBuild = vi.fn()
  const onInspect = vi.fn(async () => ({ ok: false, code: 'unavailable', error: 'Fixture unavailable.' } as const))
  render(<CandidateValidation attempt={attempt} disabled={disabled} onValidate={onValidate} onPreview={onPreview} onAuthority={onAuthority} onSeal={onSeal} onBoundBuild={onBoundBuild} onInspect={onInspect} />)
  return { onValidate, onPreview, onAuthority, onSeal, onBoundBuild }
}
describe('scoped renderer evidence', () => {
  it('shows real bound-input diagnostics only after explicit inspection and denies native readiness', async () => {
    const onInspect = vi.fn(async () => diagnostic)
    render(<CandidateValidation attempt={inspectedAttempt} disabled={false} onValidate={vi.fn()} onPreview={vi.fn()}
      onAuthority={vi.fn()} onSeal={vi.fn()} onBoundBuild={vi.fn()} onInspect={onInspect} />)
    expect(onInspect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect native inputs' }))
    expect(await screen.findByText('electron/missing.cjs')).toBeInTheDocument()
    expect(screen.getByText(/Zero missing paths does not mean a runnable or safe app/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /launch|activate|approve/i })).not.toBeInTheDocument()
  })
  it('discards a late inspection reply after the attempt is cancelled', async () => {
    let resolve!: (value: typeof diagnostic) => void
    const onInspect = () => new Promise<typeof diagnostic>(yes => { resolve = yes })
    const props = { disabled: false, onValidate: vi.fn(), onPreview: vi.fn(), onAuthority: vi.fn(),
      onSeal: vi.fn(), onBoundBuild: vi.fn(), onInspect }
    const rendered = render(<CandidateValidation {...props} attempt={inspectedAttempt} />)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect native inputs' }))
    rendered.rerender(<CandidateValidation {...props} attempt={{ ...inspectedAttempt, state: 'cancelled' }} />)
    await act(async () => { resolve(diagnostic) })
    expect(screen.queryByText('electron/missing.cjs')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('requires an explicit check action and never offers activation', () => {
    const action = view()
    expect(action.onValidate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Run scoped renderer checks' }))
    expect(action.onValidate).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /approve|activate|install/i })).not.toBeInTheDocument()
    expect(screen.getByText(/acceptance criteria and app health are not verified/)).toBeInTheDocument()
  })
  it('a checked renderer is not called a validated app', () => {
    const action = view({ ...base, state: 'checked', validation })
    expect(screen.getByText(/checks alone are not native qualification or activation authority/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open isolated renderer preview' }))
    expect(action.onPreview).toHaveBeenCalledOnce()
    expect(action.onValidate).not.toHaveBeenCalled()
  })
  it('open display disables relaunch and expressly denies verified behavior', () => {
    view({ ...base, state: 'checked', validation: { ...validation, preview: { id: 'preview', ownerPid: 1,
      state: 'open', artifactDigest: digest, rendererReady: true, behaviorVerified: false, error: null } } })
    expect(screen.getByRole('button', { name: 'Open isolated renderer preview' })).toBeDisabled()
    expect(screen.getByText(/Display: open.*Behavior verified: no/)).toBeInTheDocument()
  })
  it('interrupted display can be reopened only through another explicit action', () => {
    view({ ...base, state: 'checked', validation: { ...validation, preview: { id: 'preview', ownerPid: 1,
      state: 'interrupted', artifactDigest: digest, rendererReady: false, behaviorVerified: false, error: 'Not reopened' } } })
    expect(screen.getByRole('button', { name: 'Open isolated renderer preview' })).toBeEnabled()
    expect(screen.getByText(/readiness was not recorded/)).toBeInTheDocument()
  })
  it('failed checks retain evidence but cannot launch a preview', () => {
    view({ ...base, state: 'failed', validation: { ...validation, stage: 'failed', error: 'Candidate changed' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Candidate changed')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('unloaded or saving UI disables the check action', () => {
    view(base, true)
    expect(screen.getByRole('button')).toBeDisabled()
  })
  it('authority observations require their own explicit action', () => {
    const action = view({ ...base, state: 'checked', validation })
    expect(action.onAuthority).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Run isolated authority contracts' }))
    expect(action.onAuthority).toHaveBeenCalledOnce()
    expect(action.onPreview).not.toHaveBeenCalled()
  })
  it('passing fixture contracts are not native behavior or full app health', () => {
    view({ ...base, state: 'checked', validation: { ...validation, authority: {
      operationId: 'authority', ownerPid: 1, scope: 'main-preload-test-doubles', stage: 'passed',
      sourceDigest: digest, rendererDigest: digest, definitionDigest: digest, observationDigest: digest,
      checks: 6, nativeBehaviorVerified: false, fullAppQualified: false, error: null,
    } } })
    expect(screen.getByText('6 independent fixture contracts passed.')).toBeInTheDocument()
    expect(screen.getByText(/Native behavior, dependencies and full app health remain unverified/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run isolated authority contracts' })).not.toBeInTheDocument()
  })
  it('running authority observations block display launch', () => {
    view({ ...base, state: 'checked', validation: { ...validation, authority: {
      operationId: 'authority', ownerPid: 1, scope: 'main-preload-test-doubles', stage: 'running',
      sourceDigest: digest, rendererDigest: digest, definitionDigest: digest, observationDigest: null,
      checks: null, nativeBehaviorVerified: false, fullAppQualified: false, error: null,
    } } })
    expect(screen.getByRole('button', { name: 'Open isolated renderer preview' })).toBeDisabled()
    expect(screen.getByText('Isolated authority observations running…')).toBeInTheDocument()
  })
  it('cancelled intent does not falsely report a worker still running', () => {
    view({ ...base, state: 'cancelled', validation: { ...validation, authority: {
      operationId: 'authority', ownerPid: 1, scope: 'main-preload-test-doubles', stage: 'running',
      sourceDigest: digest, rendererDigest: digest, definitionDigest: digest, observationDigest: null,
      checks: null, nativeBehaviorVerified: false, fullAppQualified: false, error: null,
    } } })
    expect(screen.getByText(/Cancelled. Completion was not acknowledged/)).toBeInTheDocument()
    expect(screen.queryByText('Isolated authority observations running…')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('offers actual sealing only after fixture contracts and only on explicit action', () => {
    const action = view({ ...base, state: 'checked', validation: { ...validation, authority: passed } })
    expect(action.onSeal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Seal full app inputs' }))
    expect(action.onSeal).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /approve|activate|install/i })).not.toBeInTheDocument()
  })
  it('running sealing blocks display and has no retry button', () => {
    view({ ...base, state: 'checked', validation: { ...validation, authority: passed, seal: sealing } })
    expect(screen.getByRole('button', { name: 'Open isolated renderer preview' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Seal full app inputs' })).not.toBeInTheDocument()
    expect(screen.getByText('Copying source, renderer and provisioned dependencies…')).toBeInTheDocument()
  })
  it('records a real full input digest, not native qualification or health', () => {
    const action = view({ ...base, state: 'checked', validation: { ...validation, authority: passed, seal: {
      ...sealing, stage: 'sealed', artifact: { id: 'artifact', token: 'token', dev: 0, ino: 1, digest,
        provenanceDigest: digest, entries: 10, bytes: 100, activationEligible: false },
    } } })
    expect(screen.getByText(`App inputs: ${digest}`)).toBeInTheDocument()
    expect(screen.getByText(/Native qualification remains incomplete/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Verify sealed app inputs' }))
    expect(action.onSeal).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /approve|activate|install/i })).not.toBeInTheDocument()
  })
  it('cancelled sealing retains unknown completion without polling, retry or display', () => {
    view({ ...base, state: 'cancelled', validation: { ...validation, authority: passed, seal: sealing } })
    expect(screen.getByText(/Sealing cancelled. Completion remains unknown/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('copied graph build is a separate explicit action after input sealing', () => {
    const action = view({ ...base, state: 'checked', validation: { ...validation, authority: passed, seal: {
      ...sealing, stage: 'sealed', artifact: { id: 'artifact', token: 'token', dev: 0, ino: 1, digest,
        provenanceDigest: digest, entries: 10, bytes: 100, activationEligible: false },
    } } })
    expect(action.onBoundBuild).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Build against sealed dependencies' }))
    expect(action.onBoundBuild).toHaveBeenCalledOnce()
    expect(action.onSeal).not.toHaveBeenCalled()
  })
  it.each(['checked', 'cancelled'] as const)('a %s pending bound build never offers retry or claims new output is displayed', state => {
    view({ ...base, state, validation: { ...validation, boundBuild: { operationId: 'bound', ownerPid: 1,
      scope: 'sealed-graph-renderer', stage: 'checking', inputDigest: digest, sourceDigest: digest,
      dependencyDigest: digest, toolchainDigest: digest, artifact: null, fullAppQualified: false, error: null } } })
    expect(screen.queryByRole('button', { name: /Build against|Verify bound/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/The display now uses/)).not.toBeInTheDocument()
    if (state === 'checked') expect(screen.getByRole('button', { name: 'Open isolated renderer preview' })).toBeDisabled()
    else expect(screen.getByText(/Bound checks cancelled. Completion remains unknown/)).toBeInTheDocument()
  })
})

describe('guarded frontend delivery UI (synthetic backend responses only)', () => {
  const noRecords = { ok: true as const, records: [] }
  const qualified = { versionId: 'UI-synthetic-version', stage: 'qualified', scope: 'frontend-only-v1',
    createdAt: 'unit-only', qualification: null, approval: null, target: null, outcome: null, error: null } as unknown as DeliveryRecord
  function bridge() {
    return { deliveryStatus: vi.fn().mockResolvedValue({ ...noRecords, authorityAvailable: true, historicalReadOnly: false }),
      qualify: vi.fn().mockResolvedValue(noRecords),
      deliveryReview: vi.fn().mockResolvedValue(noRecords), approve: vi.fn().mockResolvedValue(noRecords),
      selectActivationTarget: vi.fn().mockResolvedValue(noRecords), activate: vi.fn().mockResolvedValue(noRecords) }
  }
  function properties(b: ReturnType<typeof bridge>, revision = 1) {
    return { attempt: inspectedAttempt, disabled: false, onValidate: vi.fn(), onPreview: vi.fn(), onAuthority: vi.fn(),
      onSeal: vi.fn(), onBoundBuild: vi.fn(), onInspect: vi.fn().mockResolvedValue(diagnostic),
      delivery: { bridge: b as unknown as ChangeBridge, changeId: 'change', revision } }
  }
  it('does not qualify, approve, select or activate automatically', () => {
    const b = bridge()
    render(<CandidateValidation {...properties(b)} />)
    for (const action of Object.values(b)) expect(action).not.toHaveBeenCalled()
    expect(screen.getByText(/Generated UI is a separately versioned data-only trusted catalog/)).toBeVisible()
  })
  it('requires explicit delivery record reconciliation before offering a new qualification', async () => {
    const b = bridge()
    b.deliveryStatus.mockResolvedValue({ ...noRecords, authorityAvailable: true, historicalReadOnly: false })
    render(<CandidateValidation {...properties(b)} />)
    expect(screen.getByRole('button', { name: 'Qualify disposable native renderer' })).toBeDisabled()
    expect(b.deliveryStatus).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload delivery records' })) })
    expect(screen.getByRole('button', { name: 'Qualify disposable native renderer' })).toBeEnabled()
    expect(b.qualify).not.toHaveBeenCalled()
  })
  it.each([
    { authorityAvailable: false, historicalReadOnly: true },
    { authorityAvailable: true, historicalReadOnly: true },
    {},
  ])('keeps delivery read-only without an affirmative host authority status: %j', async authority => {
    const b = bridge()
    b.deliveryStatus.mockResolvedValue({ ...noRecords, ...authority })
    render(<CandidateValidation {...properties(b)} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload delivery records' })) })
    expect(screen.getByRole('button', { name: 'Qualify disposable native renderer' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Qualify disposable native renderer' }))
    expect(b.qualify).not.toHaveBeenCalled()
  })
  it('retires loaded delivery authority when the source journal revision changes', async () => {
    const b = bridge()
    b.deliveryStatus.mockResolvedValue({ ...noRecords, authorityAvailable: true, historicalReadOnly: false })
    const view = render(<CandidateValidation {...properties(b)} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload delivery records' })) })
    expect(screen.getByRole('button', { name: 'Qualify disposable native renderer' })).toBeEnabled()
    view.rerender(<CandidateValidation {...properties(b, 2)} />)
    expect(screen.getByRole('button', { name: 'Qualify disposable native renderer' })).toBeDisabled()
    expect(b.deliveryStatus).toHaveBeenCalledOnce()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload delivery records' })) })
    expect(screen.getByRole('button', { name: 'Qualify disposable native renderer' })).toBeEnabled()
    expect(b.qualify).not.toHaveBeenCalled()
  })
  it.each(['qualified', 'approved'] as const)('keeps retained %s records visible but all delivery actions read-only when the host declines authority', async stage => {
    const b = bridge()
    b.deliveryStatus.mockResolvedValue({ ok: true, records: [{ ...qualified, stage }],
      authorityAvailable: false, historicalReadOnly: true })
    render(<CandidateValidation {...properties(b)} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload delivery records' })) })
    expect(screen.getByText(`Version ${qualified.versionId}: ${stage}`)).toBeVisible()
    expect(screen.getByText(/Native delivery authority is unavailable/)).toBeVisible()
    const controls = screen.getAllByRole('button').filter(control =>
      /exact artifact|native approval|renderer target|renderer application/.test(control.textContent ?? ''))
    expect(controls).toHaveLength(2)
    for (const control of controls) expect(control).toBeDisabled()
    expect(b.deliveryReview).not.toHaveBeenCalled()
    expect(b.approve).not.toHaveBeenCalled()
    expect(b.selectActivationTarget).not.toHaveBeenCalled()
    expect(b.activate).not.toHaveBeenCalled()
  })
  it('cannot adopt an old revision authority response after a pending status read', async () => {
    const b = bridge()
    let release!: (value: DeliveryResult) => void
    b.deliveryStatus.mockReturnValueOnce(new Promise<DeliveryResult>(resolve => { release = resolve }))
    const view = render(<CandidateValidation {...properties(b)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reload delivery records' }))
    view.rerender(<CandidateValidation {...properties(b, 2)} />)
    await act(async () => { release({ ...noRecords, authorityAvailable: true, historicalReadOnly: false }) })
    expect(screen.getByRole('button', { name: 'Qualify disposable native renderer' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reload delivery records' })).toBeEnabled()
    expect(b.deliveryStatus).toHaveBeenCalledOnce()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload delivery records' })) })
    expect(screen.getByRole('button', { name: 'Qualify disposable native renderer' })).toBeEnabled()
    expect(b.qualify).not.toHaveBeenCalled()
  })
  it('revokes loaded authority after a lost status acknowledgment until another explicit reconciliation', async () => {
    const b = bridge()
    render(<CandidateValidation {...properties(b)} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload delivery records' })) })
    expect(screen.getByRole('button', { name: 'Qualify disposable native renderer' })).toBeEnabled()
    b.deliveryStatus.mockRejectedValueOnce(new Error('Status acknowledgment lost'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload delivery records' })) })
    expect(screen.getByRole('button', { name: 'Qualify disposable native renderer' })).toBeDisabled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload delivery records' })) })
    expect(screen.getByRole('button', { name: 'Qualify disposable native renderer' })).toBeEnabled()
    expect(b.qualify).not.toHaveBeenCalled()
  })
  it('independent approval remains disabled until exact version/digest review is returned', async () => {
    const b = bridge()
    b.deliveryStatus.mockResolvedValue({ ok: true, records: [qualified], authorityAvailable: true, historicalReadOnly: false })
    b.deliveryReview.mockResolvedValue({ ok: true, records: [qualified], review: { versionId: qualified.versionId,
      artifactDigest: digest, reviewDigest: 'b'.repeat(64), checks: ['synthetic UI unit only'], changes: [],
      healthScope: 'synthetic only', storageScope: 'immutable', catalogScope: 'data-only' } })
    render(<CandidateValidation {...properties(b)} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload delivery records' })) })
    expect(screen.getByRole('button', { name: 'Request independent native approval' })).toBeDisabled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Review exact artifact and diff' })) })
    expect(b.approve).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Request independent native approval' })) })
    expect(b.approve).toHaveBeenCalledWith(1, 'change', inspectedAttempt.id, qualified.versionId, 'b'.repeat(64))
    expect(b.activate).not.toHaveBeenCalled()
  })
  it('unknown acknowledgment disables resubmission until explicit record reconciliation', async () => {
    const b = bridge()
    b.qualify.mockRejectedValue(new Error('lost acknowledgment'))
    render(<CandidateValidation {...properties(b)} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload delivery records' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Qualify disposable native renderer' })) })
    expect(screen.getByText(/Delivery acknowledgment unknown/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Qualify disposable native renderer' })).toBeDisabled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload delivery records' })) })
    expect(b.qualify).toHaveBeenCalledOnce()
    expect(b.deliveryStatus).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Qualify disposable native renderer' })).toBeEnabled()
  })
  it('revision change drops late delivery replies and releases only the reload control', async () => {
    const b = bridge()
    let release!: (value: DeliveryResult) => void
    b.qualify.mockReturnValue(new Promise<DeliveryResult>(resolve => { release = resolve }))
    const view = render(<CandidateValidation {...properties(b)} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload delivery records' })) })
    fireEvent.click(screen.getByRole('button', { name: 'Qualify disposable native renderer' }))
    view.rerender(<CandidateValidation {...properties(b, 2)} />)
    await act(async () => { release({ ok: true, records: [qualified] }) })
    expect(screen.queryByText(/UI-synthetic-version/)).not.toBeInTheDocument()
    expect(screen.getByText(/revision changed while delivery was outstanding/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Reload delivery records' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Qualify disposable native renderer' })).toBeDisabled()
    expect(b.qualify).toHaveBeenCalledOnce()
  })
})
