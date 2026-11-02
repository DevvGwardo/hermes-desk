import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { AppModal } from '../AppModal'

afterEach(() => {
  cleanup()
})

function ui(open: boolean) {
  return (
    <>
      <button>background</button>
      <AppModal open={open} onClose={() => {}} title="Test">
        <button>first</button>
        <button>last</button>
      </AppModal>
    </>
  )
}

// DOM order inside the dialog header+body: Close ×, first, last.
describe('AppModal focus trap', () => {
  const closeButton = (result: { getByRole: (role: string, opts?: Record<string, unknown>) => HTMLElement }) =>
    result.getByRole('button', { name: 'Close' })

  it('wraps Tab from the last focusable back to the dialog close button', () => {
    const result = render(ui(true))
    result.getByText('last').focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(closeButton(result))
  })

  it('wraps Shift+Tab from the close button to the last focusable', () => {
    const result = render(ui(true))
    closeButton(result).focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(result.getByText('last'))
  })

  it('pulls focus that leaked outside the dialog back inside', () => {
    const result = render(ui(true))
    result.getByText('background').focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(closeButton(result))
  })

  it('does not trap Tab while closed', () => {
    const result = render(ui(false))
    const bg = result.getByText('background')
    bg.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(bg)
  })

  it('makes background branches inert and restores the trigger when closed', () => {
    const result = render(ui(false))
    const bg = result.getByText('background')
    bg.focus()
    result.rerender(ui(true))
    expect(bg.inert).toBe(true)
    expect(document.activeElement).toBe(result.getByRole('dialog'))
    result.rerender(ui(false))
    expect(bg.inert).not.toBe(true)
    expect(document.activeElement).toBe(bg)
  })

  it('preserves an existing inert background', () => {
    const existing = (open: boolean) => <>
      <div inert data-testid="already-inert"><button>unavailable</button></div>
      <AppModal open={open} onClose={() => {}} title="Test"><button>first</button></AppModal>
    </>
    const result = render(existing(false))
    const background = result.getByTestId('already-inert')
    background.inert = true
    result.rerender(existing(true))
    result.unmount()
    expect(background.inert).toBe(true)
  })

  it('keeps overlapping modal ownership until the last modal closes', () => {
    const overlapping = (first: boolean, second: boolean) => <>
      <button>background</button>
      <AppModal open={first} onClose={() => {}} title="First"><button>one</button></AppModal>
      <AppModal open={second} onClose={() => {}} title="Second"><button>two</button></AppModal>
    </>
    const result = render(overlapping(true, false))
    const bg = result.getByText('background')
    result.rerender(overlapping(true, true))
    result.rerender(overlapping(false, true))
    expect(bg.inert).toBe(true)
    result.rerender(overlapping(false, false))
    expect(bg.inert).not.toBe(true)
  })

  it('wraps to a closed disclosure summary, not its hidden controls', () => {
    const result = render(<AppModal open onClose={() => {}} title="Test">
      <button>first</button>
      <details><summary>Advanced setup</summary><button>hidden setting</button></details>
    </AppModal>)
    closeButton(result).focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(result.getByText('Advanced setup'))
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(closeButton(result))
  })

  it('still dismisses on Escape', () => {
    const onClose = vi.fn()
    render(
      <AppModal open onClose={onClose} title="Test">
        <button>only</button>
      </AppModal>,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
