import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabSummary, WorkspaceBridge } from '../../lib/desktop-bridge'
import { CopySignInDialog } from './CopySignInDialog'

const tab: TabSummary = {
  id: 't_fixture', laneId: 'you', title: 'Fixture sign-in',
  url: 'https://signin.fixture.invalid/account',
  state: 'idle', controller: 'user', createdBy: 'user',
  sharedLogin: false, discarded: false, active: true,
  canGoBack: false, canGoForward: false,
}
const agents = [{ id: 'fixture-agent', name: 'Fixture Scout', color: '#91bbec', profile: 'fixture-scout' }]

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function setup() {
  const copySignIn = vi.fn<WorkspaceBridge['copySignIn']>().mockResolvedValue(undefined)
  vi.stubGlobal('nubAgent', { workspace: { copySignIn } })
  const onClose = vi.fn()
  const view = render(<><button type="button">Background action</button></>)
  const background = screen.getByRole('button', { name: 'Background action' })
  background.focus()
  view.rerender(<>
    <button type="button">Background action</button>
    <CopySignInDialog tab={tab} agents={agents} selectedAgentId="fixture-agent" onClose={onClose} />
  </>)
  const dialog = screen.getByRole('dialog', { name: 'Copy sign-in' })
  const picker = within(dialog).getByRole('combobox', { name: 'Agent' })
  const review = within(dialog).getByRole('button', { name: 'Review copy' })
  return { view, dialog, picker, review, background, copySignIn, onClose }
}

function key(target: HTMLElement, value: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })
  fireEvent(target, event)
  return event
}

describe('CopySignInDialog keyboard recovery', () => {
  it.each([false, true])('wraps focus at the dialog boundary (Shift=%s)', shift => {
    const { picker, review } = setup()
    const from = shift ? picker : review
    from.focus()
    expect(key(from, 'Tab', shift).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(shift ? review : picker)
  })

  it.each([false, true])('recovers focus that escaped the dialog (Shift=%s)', shift => {
    const { background, picker, review } = setup()
    background.focus()
    expect(key(background, 'Tab', shift).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(shift ? review : picker)
  })

  it.each([false, true])('contains keys with all controls disabled and recovers after failure (Shift=%s)', async shift => {
    const { dialog, picker, review, background, copySignIn, onClose } = setup()
    let reject!: (reason: Error) => void
    copySignIn.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail }))
    fireEvent.click(review)
    expect(picker.hasAttribute('disabled')).toBe(true)
    expect(within(dialog).getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true)
    background.focus()
    expect(key(background, 'Tab', shift).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(dialog)
    expect(dialog.getAttribute('aria-busy')).toBe('true')
    expect(key(dialog, 'Escape').defaultPrevented).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    expect(copySignIn).toHaveBeenCalledExactlyOnceWith('https://signin.fixture.invalid', 'you', 'profile:fixture-scout')
    await act(async () => reject(new Error('obviously fake private consent detail')))
    expect(within(dialog).getByRole('alert').textContent).toBe('Sign-in was not copied. Check the native consent dialog and try again.')
    expect(screen.queryByText(/obviously fake private consent detail/)).toBeNull()
    expect(picker.hasAttribute('disabled')).toBe(false)
    expect(dialog.getAttribute('aria-busy')).toBe('false')
    expect(key(dialog, 'Tab', shift).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(shift ? review : picker)
    expect(review.hasAttribute('disabled')).toBe(false)
    await act(async () => { fireEvent.click(review) })
    expect(copySignIn).toHaveBeenCalledTimes(2)
    expect(copySignIn).toHaveBeenNthCalledWith(2, 'https://signin.fixture.invalid', 'you', 'profile:fixture-scout')
    expect(onClose).toHaveBeenCalledOnce()
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })

  it('consumes Escape and dismisses an idle dialog even if focus escaped', () => {
    const { background, onClose, copySignIn } = setup()
    background.focus()
    expect(key(background, 'Escape').defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledOnce()
    expect(copySignIn).not.toHaveBeenCalled()
  })

  it.each(['dialog', 'alertdialog'] as const)('does not consume keys owned by another modal %s', role => {
    const { onClose, copySignIn } = setup()
    render(<section role={role} aria-modal="true" aria-label="Foreground fixture"><button type="button">Foreground action</button></section>)
    const foreground = screen.getByRole('button', { name: 'Foreground action' })
    foreground.focus()
    expect(key(foreground, 'Tab').defaultPrevented).toBe(false)
    expect(key(foreground, 'Escape').defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(foreground)
    expect(onClose).not.toHaveBeenCalled()
    expect(copySignIn).not.toHaveBeenCalled()
  })

  it('yields to an already-consumed key', () => {
    const { background, onClose } = setup()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    event.preventDefault()
    fireEvent(background, event)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('restores focus and releases its keyboard listener on unmount', () => {
    const { view, picker, background, onClose } = setup()
    expect(document.activeElement).toBe(picker)
    view.rerender(<><button type="button">Background action</button></>)
    expect(document.activeElement).toBe(background)
    expect(key(background, 'Tab').defaultPrevented).toBe(false)
    expect(key(background, 'Escape').defaultPrevented).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })
})
