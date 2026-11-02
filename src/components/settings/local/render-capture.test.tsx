import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DiagnosticsPane } from './DiagnosticsPane'
import { testStatus } from './test-fixtures'
import { renderCapture } from '../../../lib/render-capture'

afterEach(() => { cleanup(); renderCapture.clear(); vi.useRealTimers() })
const props = { config: null, status: testStatus(), host: null, busy: false, save: vi.fn(), refresh: vi.fn() }

describe('local render capture controls', () => {
  it('offers an explicit memory-only opt-in instead of silently collecting chat diagnostics', () => {
    render(<DiagnosticsPane {...props} />)
    expect(screen.getByRole('button', { name: 'Start render capture' })).toBeEnabled()
    expect(screen.getByText(/five minutes.*memory only/i)).toBeVisible()
    expect(screen.queryByLabelText('Captured render metadata')).toBeNull()
  })

  it('starts, stops, inspects and clears locally without clipboard, disk or network access', () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const fetch = vi.spyOn(globalThis, 'fetch')
    render(<DiagnosticsPane {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start render capture' }))
    expect(renderCapture.isRecording()).toBe(true)
    act(() => { renderCapture.record('commit', { rows: 48 }) })
    fireEvent.click(screen.getByRole('button', { name: 'Stop render capture' }))
    expect(screen.getByLabelText('Captured render metadata')).toHaveTextContent('"rows": 48')
    fireEvent.click(screen.getByRole('button', { name: 'Clear render capture' }))
    expect(screen.queryByLabelText('Captured render metadata')).toBeNull()
    expect(renderCapture.read().entries).toEqual([])
    expect(writeText).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    storage.mockRestore()
    fetch.mockRestore()
  })

  it('does not arm capture from an invalidated Settings opening', () => {
    render(<DiagnosticsPane {...props} isCurrent={() => false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start render capture' }))
    expect(renderCapture.isRecording()).toBe(false)
  })

  it('keeps capture active across Settings closure, and expires an inspected receipt', () => {
    vi.useFakeTimers()
    const view = render(<DiagnosticsPane {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start render capture' }))
    view.unmount()
    expect(renderCapture.isRecording()).toBe(true)
    renderCapture.record('commit', { rows: 50 })
    render(<DiagnosticsPane {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect render capture' }))
    expect(screen.getByLabelText('Captured render metadata')).toHaveTextContent('"rows": 50')
    act(() => { vi.advanceTimersByTime(10 * 60_000) })
    expect(screen.queryByLabelText('Captured render metadata')).toBeNull()
    expect(renderCapture.read().entries).toEqual([])
  })
})
