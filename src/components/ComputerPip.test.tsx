import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ComputerPip } from './ComputerPip'
import type { ComputerCaptureFrame, ComputerPreviewState } from './ComputerPip'
import { ComputerPipLauncher } from './ComputerPipLauncher'

const image = 'data:image/png;base64,aGVsbG8='
const base: ComputerPreviewState = {
  open: true, mode: 'watching', profile: 'alan', sessionId: 'runtime-fake-alan', docked: true,
}

function fixture() {
  let state: (value: ComputerPreviewState) => void = () => {}
  let frame: (value: ComputerCaptureFrame) => void = () => {}
  const offState = vi.fn()
  const offFrame = vi.fn()
  const bridge = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    takeControl: vi.fn(async () => {}),
    paste: vi.fn(async () => {}),
    onState: (cb: typeof state) => { state = cb; return offState },
    onFrame: (cb: typeof frame) => { frame = cb; return offFrame },
  }
  vi.stubGlobal('nubAgent', { computer: bridge })
  return { bridge, offState, offFrame,
    state: (value: ComputerPreviewState) => act(() => state(value)),
    frame: (value: ComputerCaptureFrame) => act(() => frame(value)) }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Computer PiP docked preview', () => {
  it('opens docked, labels captures truthfully, updates age, and overlays the agent point', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(20_000)
    const f = fixture()
    render(<ComputerPip profile="alan" agentName="Alan" agentColor="#aa55cc" />)
    await act(async () => {})
    expect(f.bridge.open).toHaveBeenCalledWith('alan', { docked: true })
    expect(screen.getByText('This preview is not a live Mac feed.')).toBeTruthy()
    f.state({ ...base, lastAction: { x: 25, y: 20, color: '#aa55cc' } })
    f.frame({ dataUrl: image, ts: 8000, profile: 'alan', sessionId: 'runtime-fake-alan', width: 100, height: 80 })
    expect(screen.getByText('Last capture · 12s ago')).toBeTruthy()
    const point = screen.getByLabelText("Agent's last action point")
    expect(point.style.left).toBe('25%')
    expect(point.style.top).toBe('25%')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText('Last capture · 13s ago')).toBeTruthy()
    expect(screen.getByText('Watching · drag anywhere · Take control for mouse and keyboard')).toBeTruthy()
  })

  it('subscribes safely, excludes foreign or non-raster frames, clears on session switch, and unsubscribes', async () => {
    const f = fixture()
    const view = render(<ComputerPip profile="alan" />)
    await act(async () => {})
    f.state(base)
    for (const value of [
      { dataUrl: image, ts: 1, profile: 'scout' },
      { dataUrl: image, ts: 1, sessionId: 'foreign-runtime' },
      { dataUrl: 'https://example.invalid/capture.png', ts: 1 },
      { dataUrl: 'data:image/svg+xml;base64,aGVsbG8=', ts: 1 },
    ]) f.frame(value)
    expect(screen.queryByAltText('Last completed computer-use capture')).toBeNull()
    f.frame({ dataUrl: image, ts: 1, sessionId: base.sessionId })
    expect(screen.getByAltText('Last completed computer-use capture')).toBeTruthy()
    f.state({ ...base, sessionId: 'runtime-fake-new' })
    expect(screen.queryByAltText('Last completed computer-use capture')).toBeNull()
    view.unmount()
    expect(f.offState).toHaveBeenCalledOnce()
    expect(f.offFrame).toHaveBeenCalledOnce()
    expect(f.bridge.close).not.toHaveBeenCalled()
  })

  it('delegates controls without clipboard values and disables agent actions after Take control', async () => {
    const f = fixture()
    const onClose = vi.fn()
    render(<ComputerPip profile="alan" onClose={onClose} />)
    await act(async () => {})
    f.state(base)
    fireEvent.click(screen.getByText('Take control'))
    await act(async () => {})
    expect(f.bridge.takeControl).toHaveBeenCalledExactlyOnceWith()
    fireEvent.click(screen.getByText('Paste'))
    await act(async () => {})
    expect(f.bridge.paste).toHaveBeenCalledExactlyOnceWith()
    fireEvent.click(screen.getByLabelText('Float computer preview'))
    await act(async () => {})
    expect(f.bridge.open).toHaveBeenLastCalledWith('alan', { docked: false })
    f.state({ ...base, mode: 'user-control' })
    expect((screen.getByText('Paste') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('Take control') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('You in control · use your Mac’s mouse and keyboard · preview is not live')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Close computer preview'))
    await act(async () => {})
    expect(f.bridge.close).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('handles missing bridge and sanitizes action errors rather than displaying backend details', async () => {
    vi.stubGlobal('nubAgent', undefined)
    const missing = render(<ComputerPip profile="alan" />)
    expect(screen.getByText('Computer preview requires Hermes Desk.')).toBeTruthy()
    expect((screen.getByText('Paste') as HTMLButtonElement).disabled).toBe(true)
    missing.unmount()
    const f = fixture()
    f.bridge.paste.mockRejectedValue(new Error('FAKE_SECRET_ERROR_DO_NOT_USE'))
    render(<ComputerPip profile="alan" />)
    await act(async () => {})
    f.state(base)
    fireEvent.click(screen.getByText('Paste'))
    await act(async () => {})
    expect(screen.getByRole('status').textContent).toContain('Action unavailable')
    expect(screen.queryByText('FAKE_SECRET_ERROR_DO_NOT_USE')).toBeNull()
  })

  it('resets selection on profile change and ignores a late action rejection', async () => {
    const f = fixture()
    let reject: (error: Error) => void = () => {}
    f.bridge.paste.mockImplementation(() => new Promise((_resolve, no) => { reject = no }))
    const view = render(<ComputerPip profile="alan" />)
    await act(async () => {})
    f.state(base)
    fireEvent.click(screen.getByText('Paste'))
    view.rerender(<ComputerPip profile="scout" />)
    await act(async () => reject(new Error('fake late error')))
    expect(f.bridge.open).toHaveBeenLastCalledWith('scout', { docked: true })
    expect(screen.getByRole('status').textContent).toBe('')
    f.state(base)
    expect((screen.getByText('Paste') as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not open after an immediate unmount', async () => {
    const f = fixture()
    const view = render(<ComputerPip profile="alan" />)
    view.unmount()
    await act(async () => {})
    expect(f.bridge.open).not.toHaveBeenCalled()
    expect(f.offState).toHaveBeenCalledOnce()
    expect(f.offFrame).toHaveBeenCalledOnce()
  })
})

describe('Computer PiP launcher', () => {
  it('opens the selected profile, exposes errors safely, and disables without a selection or bridge', async () => {
    const f = fixture()
    const view = render(<ComputerPipLauncher profile="alan" agentName="Alan" />)
    expect(screen.getByLabelText('Open computer preview for Alan').querySelector('svg[aria-hidden="true"]')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Open computer preview for Alan'))
    await act(async () => {})
    expect(f.bridge.open).toHaveBeenCalledExactlyOnceWith('alan')
    f.bridge.open.mockRejectedValue(new Error('FAKE_PRIVATE_ERROR'))
    fireEvent.click(screen.getByLabelText('Open computer preview for Alan'))
    await act(async () => {})
    expect(screen.getByRole('status').textContent).toBe('Computer preview is unavailable.')
    view.rerender(<ComputerPipLauncher />)
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
