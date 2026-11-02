import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatSessionContext } from './ChatSessionContext'
import type { SessionContextSnapshot } from '../../lib/agents/session-context'
const data: SessionContextSnapshot = { used: 800, maximum: 32000, estimated: true, source: 'local_estimate',
  categories: [{ id: 'memory', label: 'Memory', tokens: 40 }],
  files: [{ label: 'SOUL.md', path: '/alpha/SOUL.md', tokens: 50, loaded: true, status: 'loaded' }] }
const props = { profile: 'alpha', open: true, onToggle: vi.fn() }
afterEach(cleanup)
describe('native context inspection', () => {
  it('reads only on request and distinguishes estimates from prompt snapshots and billing', async () => {
    const inspect = vi.fn().mockResolvedValue(data)
    render(<ChatSessionContext {...props} onInspectContext={inspect} />)
    expect(inspect).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Inspect chat context' })))
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(screen.getByText('800 tokens')).toBeTruthy()
    expect(screen.getByText(/not billing/)).toBeTruthy()
    expect(screen.getByText('Memory')).toBeTruthy()
    expect(screen.getByText(/not a snapshot of the cached prompt/)).toBeTruthy()
  })
  it('reports failure, permits retry, and disables offline reads without claiming empty context', async () => {
    const inspect = vi.fn().mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValue(data)
    const view = render(<ChatSessionContext {...props} onInspectContext={inspect} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Inspect chat context' })))
    expect(screen.getByRole('alert').textContent).toContain('unavailable')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Inspect chat context' })))
    view.rerender(<ChatSessionContext {...props} onInspectContext={inspect} offline />)
    expect((screen.getByRole('button', { name: 'Refresh chat context' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/last reported, not live/)).toBeTruthy()
    expect(inspect).toHaveBeenCalledTimes(2)
  })
  it.each(['profile', 'close'] as const)('discards slow results across %s changes and reopening', async mode => {
    let resolve!: (value: SessionContextSnapshot) => void
    const inspect = vi.fn(() => new Promise<SessionContextSnapshot>(r => { resolve = r }))
    const view = render(<ChatSessionContext {...props} onInspectContext={inspect} />)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect chat context' }))
    fireEvent.click(screen.getByRole('button', { name: 'Inspecting context…' }))
    expect(inspect).toHaveBeenCalledTimes(1)
    view.rerender(<ChatSessionContext {...props} profile={mode === 'profile' ? 'beta' : 'alpha'} open={mode !== 'close'} onInspectContext={inspect} />)
    view.rerender(<ChatSessionContext {...props} onInspectContext={inspect} />)
    await act(async () => resolve(data))
    expect(screen.queryByText('800 tokens')).toBeNull()
    expect(screen.getByRole('button', { name: 'Inspect chat context' })).toBeTruthy()
  })
})
