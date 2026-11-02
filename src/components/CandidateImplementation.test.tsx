import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangeAttempt, ChangeBridge, ChangeResult, WorkspaceReview } from '../lib/self-modification'
import { CandidateImplementation } from './CandidateImplementation'

afterEach(cleanup)
const attempt: ChangeAttempt = { id: 'fixture-attempt', state: 'prepared', epoch: 0,
  requestedAt: '2026-10-12T12:00:00.000Z', statusAt: '2026-10-12T12:00:00.000Z',
  cancelledAt: null, preparation: null, execution: null, validation: null }
const result: WorkspaceReview = { ok: true, workspaceId: 'fixture', baselineHead: 'a'.repeat(40),
  files: Array.from({ length: 13 }, (_, index) => ({ path: `file-${index}.txt`, status: 'unchanged',
    beforeSha256: 'b'.repeat(64), afterSha256: 'b'.repeat(64), binary: false, truncated: false, diff: null })) }
function props() {
  const empty = async (): Promise<ChangeResult> => ({ ok: true, revision: 0, changes: [] })
  const bridge: ChangeBridge = { list: vi.fn(empty), create: vi.fn(empty), cancel: vi.fn(empty), reopen: vi.fn(empty),
    prepare: vi.fn(empty), implement: vi.fn(empty), validate: vi.fn(empty), preview: vi.fn(empty), authority: vi.fn(empty), seal: vi.fn(empty), boundBuild: vi.fn(empty),
    nativeInputs: vi.fn(async () => ({ ok: false, code: 'unavailable', error: 'Fixture unavailable.' } as const)),
    selectRepository: vi.fn(async () => ({ ok: true, selection: null } as const)),
    review: vi.fn(async () => result) }
  return { changeId: 'fixture-change', attempt, bridge, disabled: false, onImplement: vi.fn() }
}
describe('candidate-only implementation UI', () => {
  it('does not infer an endpoint, model or context consent; submits only the explicit bounded choice', async () => {
    const p = props()
    render(<CandidateImplementation {...p} />)
    const run = screen.getByRole('button', { name: 'Request candidate implementation' })
    expect(run).toBeDisabled()
    expect(screen.getByLabelText('Local model port')).toHaveValue(null)
    expect(screen.getByLabelText('Model name')).toHaveValue('')
    expect(p.bridge.implement).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Local model port'), { target: { value: '8080' } })
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'fixture-model' } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose candidate context files' }))
    const first = (await screen.findAllByRole('checkbox'))[0]
    expect(first).not.toBeChecked()
    fireEvent.click(first)
    fireEvent.click(run)
    expect(p.onImplement).toHaveBeenCalledExactlyOnceWith({ port: 8080, model: 'fixture-model', files: ['file-0.txt'] })
    expect(screen.getByText(/Native confirmation is required/)).toBeVisible()
  })
  it('caps context selection at twelve files', async () => {
    render(<CandidateImplementation {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose candidate context files' }))
    const boxes = await screen.findAllByRole('checkbox')
    boxes.slice(0, 12).forEach(box => fireEvent.click(box))
    expect(boxes[12]).toBeDisabled()
    fireEvent.click(boxes[0])
    expect(boxes[12]).toBeEnabled()
  })
  it('does not offer execution for a request without prepared source', () => {
    render(<CandidateImplementation {...props()} attempt={{ ...attempt, state: 'requested' }} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('keeps failure and completion distinct from validation or activation', () => {
    const execution = { operationId: 'op', ownerPid: 1, stage: 'implemented' as const, port: 8080,
      model: 'fixture-model', files: ['note.txt'], inputDigest: 'a'.repeat(64), calls: 1,
      outputDigest: 'b'.repeat(64), error: null }
    const p = props()
    const view = render(<CandidateImplementation {...p} attempt={{ ...attempt, state: 'implemented', execution }} />)
    expect(screen.getByText('Candidate edits recorded. Not tested, previewed, approved or activated.')).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    view.rerender(<CandidateImplementation {...p} attempt={{ ...attempt, state: 'failed',
      execution: { ...execution, stage: 'failed', error: 'Fixture interruption' } }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Fixture interruption')
    expect(screen.getByText(/Provider completion and cost may be unknown/)).toBeVisible()
  })
  it('fences a file-list callback after attempt replacement', async () => {
    let finish!: (value: WorkspaceReview) => void
    const p = props()
    p.bridge.review = vi.fn<ChangeBridge['review']>(() => new Promise<WorkspaceReview>(resolve => { finish = resolve }))
    const view = render(<CandidateImplementation {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose candidate context files' }))
    view.rerender(<CandidateImplementation {...p} attempt={{ ...attempt, id: 'new-attempt' }} />)
    await act(async () => { finish(result) })
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText('Reading candidate files…')).not.toBeInTheDocument()
  })
  it('shows a failed review without enabling inference', async () => {
    const p = props()
    p.bridge.review = vi.fn<ChangeBridge['review']>(async () => ({ ok: false, code: 'ownership', error: 'Workspace changed' }))
    render(<CandidateImplementation {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose candidate context files' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace changed')
    expect(screen.getByRole('button', { name: 'Request candidate implementation' })).toBeDisabled()
  })
})
