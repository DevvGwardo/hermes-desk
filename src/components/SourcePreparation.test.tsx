import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeAttempt, ChangeBridge, ChangeResult, RepositorySelection } from '../lib/self-modification'
import { SourcePreparation } from './SourcePreparation'

const requested: ChangeAttempt = { id: 'attempt-one', state: 'requested', epoch: 0,
  requestedAt: '2026-10-12T12:00:00.000Z', statusAt: '2026-10-12T12:00:00.000Z', cancelledAt: null,
  preparation: null, execution: null, validation: null }
const selection: RepositorySelection = { id: 'selected-repo', root: '/disposable/source', head: 'a'.repeat(40), dirtyEntries: 3 }
let bridge: ChangeBridge
beforeEach(() => {
  const empty = async (): Promise<ChangeResult> => ({ ok: true, revision: 0, changes: [] })
  bridge = { list: vi.fn(empty), create: vi.fn(empty), cancel: vi.fn(empty), reopen: vi.fn(empty),
    selectRepository: vi.fn(async () => ({ ok: true, selection } as const)),
    prepare: vi.fn(empty), implement: vi.fn(empty), validate: vi.fn(empty), preview: vi.fn(empty), authority: vi.fn(empty), seal: vi.fn(empty), boundBuild: vi.fn(empty),
    nativeInputs: vi.fn(async () => ({ ok: false, code: 'unavailable', error: 'Fixture unavailable.' } as const)),
    review: vi.fn<ChangeBridge['review']>(async () => ({ ok: true, workspaceId: 'workspace-one', baselineHead: selection.head, files: [
      { path: 'src/note.txt', status: 'modified', beforeSha256: 'b'.repeat(64), afterSha256: 'c'.repeat(64),
        binary: false, truncated: false, diff: '--- a/src/note.txt\n+++ b/src/note.txt\n-old\n+new\n' },
    ] })) }
})
afterEach(cleanup)

function prepared(): ChangeAttempt {
  return { ...requested, state: 'prepared', preparation: {
    operationId: 'operation-one', ownerPid: 1234,
    source: { root: selection.root, head: selection.head, dirtyEntries: 3, statusDigest: 'd'.repeat(64),
      dev: 1, ino: 2, gitDev: 1, gitIno: 3, kind: 'head', dirtyExcluded: true },
    workspace: { id: 'workspace-one', token: 'owned-token', dev: 1, ino: 4 },
    manifestDigest: 'e'.repeat(64), fileCount: 1, error: null,
  } }
}

describe('explicit isolated-source review UI', () => {
  it('requires native repository selection and explicit acknowledgment that dirty work is excluded', async () => {
    const onPrepare = vi.fn()
    render(<SourcePreparation changeId="change-one" attempt={requested} bridge={bridge} disabled={false} onPrepare={onPrepare} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Prepare isolated source' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Choose source repository' }))
    const button = await screen.findByRole('button', { name: 'Prepare isolated source' })
    expect(button).toBeDisabled()
    expect(screen.getByText(/3 dirty\/untracked entries will be excluded/)).toBeInTheDocument()
    expect(onPrepare).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(button)
    expect(onPrepare).toHaveBeenCalledExactlyOnceWith(selection, 'head')
    expect(bridge.prepare).not.toHaveBeenCalled() // parent owns the journal revision and attempt fence
  })

  it('cancelling the native picker does not create a selection or candidate', async () => {
    vi.mocked(bridge.selectRepository).mockResolvedValue({ ok: true, selection: null })
    const onPrepare = vi.fn()
    render(<SourcePreparation changeId="change-one" attempt={requested} bridge={bridge} disabled={false} onPrepare={onPrepare} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose source repository' }))
    await waitFor(() => expect(bridge.selectRepository).toHaveBeenCalledOnce())
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(onPrepare).not.toHaveBeenCalled()
  })

  it('renders actual file/digest/diff evidence, not a validation or approval claim', async () => {
    render(<SourcePreparation changeId="change-one" attempt={prepared()} bridge={bridge} disabled={false} onPrepare={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review candidate files and diffs' }))
    expect(await screen.findByText('1 changed files · 1 files reviewed')).toBeInTheDocument()
    expect(bridge.review).toHaveBeenCalledExactlyOnceWith('change-one', 'attempt-one')
    fireEvent.click(screen.getByText('src/note.txt · modified'))
    expect(screen.getByText(/Baseline digest:/)).toHaveTextContent('b'.repeat(64))
    expect(screen.getByText(/Candidate digest:/)).toHaveTextContent('c'.repeat(64))
    expect(screen.getByText(/--- a\/src\/note.txt/).textContent).toContain('+new')
    expect(screen.getByText(/not validation, a preview, or approval/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /approve|activate|run agent|install/i })).not.toBeInTheDocument()
  })

  it('labels truncated and binary changes honestly', async () => {
    vi.mocked(bridge.review).mockResolvedValue({ ok: true, workspaceId: 'workspace-one', baselineHead: selection.head,
      files: [{ path: 'binary.bin', status: 'modified', beforeSha256: 'b', afterSha256: 'c', diff: null, binary: true, truncated: true }] })
    render(<SourcePreparation changeId="change-one" attempt={prepared()} bridge={bridge} disabled={false} onPrepare={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review candidate files and diffs' }))
    fireEvent.click(await screen.findByText('binary.bin · modified'))
    expect(screen.getByText('Binary content changed; no text diff is shown.')).toBeInTheDocument()
    expect(screen.getByText('Diff truncated for display. This is not a complete review.')).toBeInTheDocument()
  })

  it('discards a late selection when a different attempt is shown', async () => {
    let release!: (value: Awaited<ReturnType<ChangeBridge['selectRepository']>>) => void
    vi.mocked(bridge.selectRepository).mockReturnValue(new Promise(resolve => { release = resolve }))
    const view = render(<SourcePreparation changeId="change-one" attempt={requested} bridge={bridge} disabled={false} onPrepare={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose source repository' }))
    view.rerender(<SourcePreparation changeId="change-one" attempt={{ ...requested, id: 'attempt-two' }} bridge={bridge} disabled={false} onPrepare={() => {}} />)
    await act(async () => release({ ok: true, selection }))
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/Source: \/disposable\/source/)).not.toBeInTheDocument()
  })

  it('failed ownership review clears prior displayed evidence and preserves the candidate', async () => {
    render(<SourcePreparation changeId="change-one" attempt={prepared()} bridge={bridge} disabled={false} onPrepare={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review candidate files and diffs' }))
    await screen.findByText('1 changed files · 1 files reviewed')
    vi.mocked(bridge.review).mockResolvedValue({ ok: false, code: 'ownership', error: 'Workspace identity changed. Existing work retained.' })
    fireEvent.click(screen.getByRole('button', { name: 'Review candidate files and diffs' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace identity changed')
    expect(screen.queryByText('1 changed files · 1 files reviewed')).not.toBeInTheDocument()
  })

  it('failed and cancelled states retain recorded identities but never offer preparation again', () => {
    const attempt = { ...prepared(), state: 'cancelled' as const }
    render(<SourcePreparation changeId="change-one" attempt={attempt} bridge={bridge} disabled={false} onPrepare={() => {}} />)
    expect(screen.getByText('Any existing workspace is retained. This attempt cannot continue.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Prepare isolated source' })).not.toBeInTheDocument()
    expect(screen.getByText(/Workspace ID: workspace-one/)).toBeInTheDocument()
  })
})
