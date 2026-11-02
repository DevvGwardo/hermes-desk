import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Component } from 'react'
import { ErrorBoundary } from '../ErrorBoundary'
import { renderCapture } from '../../lib/render-capture'

/* -------------------------------------------------------------- */
/* Helper: a component that throws on render                      */
/* -------------------------------------------------------------- */
class Bomb extends Component<{ message?: string }> {
  render(): React.ReactNode {
    throw new Error(this.props.message ?? 'boom')
  }
}

/* Spy that suppresses console.error during tests                  */
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  cleanup()
  renderCapture.clear()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  cleanup()
})

/* -------------------------------------------------------------- */
/* Tests                                                           */
/* -------------------------------------------------------------- */
describe('ErrorBoundary', () => {
  it('shows fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <Bomb message="test error" />
      </ErrorBoundary>,
    )

    expect(screen.getByText('Something went wrong')).toBeTruthy()
    expect(screen.getByText('test error')).toBeTruthy()
  })

  it('renders a Reload button that calls window.location.reload', () => {
    const reloadSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { reload: reloadSpy },
      writable: true,
    })

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )

    const btn = screen.getByRole('button', { name: /reload/i })
    expect(btn).toBeTruthy()
    fireEvent.click(btn)
    expect(reloadSpy).toHaveBeenCalledOnce()
  })

  it('does not propagate the error to the parent', () => {
    const { container } = render(
      <ErrorBoundary>
        <Bomb message="caught" />
      </ErrorBoundary>,
    )

    // The boundary rendered its own fallback, not a crash
    expect(container.querySelector('[data-testid="parent-fallback"]')).toBeNull()
    expect(screen.getByText('Something went wrong')).toBeTruthy()
  })

  it('calls onError callback with the error and info', () => {
    const onError = vi.fn()

    render(
      <ErrorBoundary onError={onError}>
        <Bomb message="callback test" />
      </ErrorBoundary>,
    )

    expect(onError).toHaveBeenCalledOnce()
    const [err, info] = onError.mock.calls[0]!
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('callback test')
    expect(info).toHaveProperty('componentStack')
  })

  it('renders custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<div data-testid="custom">custom</div>}>
        <Bomb />
      </ErrorBoundary>,
    )

    expect(screen.getByTestId('custom')).toBeTruthy()
    expect(screen.queryByText('Something went wrong')).toBeNull()
  })

  it('freezes an opted-in receipt and displays only allowlisted metadata alongside the fallback', async () => {
    renderCapture.start()
    renderCapture.record('scroll', { rows: 50 })
    render(<ErrorBoundary><Bomb message="Maximum update depth exceeded FAKE error detail" /></ErrorBoundary>)
    expect(renderCapture.getPhase()).toBe('failed')
    expect(await screen.findByText('Captured render metadata (memory only)')).toBeTruthy()
    const receipt = JSON.stringify(renderCapture.read())
    expect(receipt).toContain('maximum-depth')
    expect(receipt).not.toContain('FAKE error detail')
    fireEvent.click(screen.getByRole('button', { name: 'Clear render capture' }))
    expect(screen.queryByText('Captured render metadata (memory only)')).toBeNull()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })
})
