import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { CopyPermissionModal } from '../CopyPermissionModal'

afterEach(() => {
  cleanup()
})

describe('CopyPermissionModal', () => {
  it('dismisses on Escape', () => {
    const onDismiss = vi.fn()
    render(<CopyPermissionModal open detail={undefined} onChoice={() => {}} onDismiss={onDismiss} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape while closed', () => {
    const onDismiss = vi.fn()
    render(<CopyPermissionModal open={false} detail={undefined} onChoice={() => {}} onDismiss={onDismiss} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('moves focus into the dialog on open and restores it on close', () => {
    const ui = (open: boolean) => (
      <>
        <button>trigger</button>
        <CopyPermissionModal open={open} detail={undefined} onChoice={() => {}} onDismiss={() => {}} />
      </>
    )
    const { getByText, getByRole, rerender } = render(ui(false))
    const trigger = getByText('trigger')
    trigger.focus()
    rerender(ui(true))
    expect(document.activeElement).toBe(getByRole('dialog'))
    rerender(ui(false))
    expect(document.activeElement).toBe(trigger)
  })

  it('wraps Tab from the last action back to the first', () => {
    const { getByText } = render(
      <CopyPermissionModal open detail={undefined} onChoice={() => {}} onDismiss={() => {}} />,
    )
    // DOM order inside the dialog: Always, Once, Never.
    getByText('Never').focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(getByText('Always'))
  })

  it('wraps Shift+Tab from the first action to the last', () => {
    const { getByText } = render(
      <CopyPermissionModal open detail={undefined} onChoice={() => {}} onDismiss={() => {}} />,
    )
    getByText('Always').focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(getByText('Never'))
  })

  it('pulls focus that leaked outside the dialog back inside', () => {
    const { getByRole, getByText } = render(
      <>
        <button>background</button>
        <CopyPermissionModal open detail={undefined} onChoice={() => {}} onDismiss={() => {}} />
      </>,
    )
    // The scrim "Dismiss" button is outside the dialog box; Tab must not land there.
    getByRole('button', { name: 'Dismiss' }).focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(getByText('Always'))
  })
})
