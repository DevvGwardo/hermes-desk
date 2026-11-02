import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OfflineBanner } from './OfflineBanner'

afterEach(cleanup)

describe('OfflineBanner', () => {
  it('only shows offline, opens Diagnostics, and guards overlapping retries', async () => {
    let finish!: () => void
    const onRetry = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const onDiagnostics = vi.fn()
    const view = render(<OfflineBanner offline={false} onRetry={onRetry} onDiagnostics={onDiagnostics} />)
    expect(screen.queryByRole('status')).toBeNull()
    view.rerender(<OfflineBanner offline onRetry={onRetry} onDiagnostics={onDiagnostics} />)
    expect(screen.getByRole('status').textContent).toContain('You can keep drafting')
    fireEvent.click(screen.getByText('Diagnostics'))
    expect(onDiagnostics).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByText('Reconnect'))
    expect(screen.getByText('Reconnecting…').hasAttribute('disabled')).toBe(true)
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce())
    finish()
    await waitFor(() => expect(screen.getByText('Reconnect').hasAttribute('disabled')).toBe(false))
    expect(onRetry).toHaveBeenCalledOnce()
  })
  it('keeps drafts available after a failed reconnect', async () => {
    render(<OfflineBanner offline onRetry={vi.fn(async () => { throw new Error('fixture offline') })} onDiagnostics={vi.fn()} />)
    fireEvent.click(screen.getByText('Reconnect'))
    expect(await screen.findByText('Still disconnected. You can keep drafting; send when Hermes reconnects.')).toBeTruthy()
    expect(screen.getByText('Reconnect').hasAttribute('disabled')).toBe(false)
  })
})
