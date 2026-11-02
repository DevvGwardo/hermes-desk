import { describe, expect, it, vi } from 'vitest'
import { atom, useValue } from '../atom'
import { render, screen } from '@testing-library/react'

describe('atom', () => {
  it('get/set round-trips', () => {
    const a = atom(1)
    expect(a.get()).toBe(1)
    a.set(2)
    expect(a.get()).toBe(2)
  })

  it('subscribe notifies on referential change only', () => {
    const a = atom<number | object>(1)
    const cb = vi.fn()
    a.subscribe(cb)
    a.set(1) // same value — no notify
    expect(cb).not.toHaveBeenCalled()
    a.set(2)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(2)
  })

  it('unsubscribe stops notifications', () => {
    const a = atom(0)
    const cb = vi.fn()
    const off = a.subscribe(cb)
    off()
    a.set(1)
    expect(cb).not.toHaveBeenCalled()
  })

  it('listen is an alias for subscribe (host.state.profile.listen)', () => {
    const a = atom('default')
    const cb = vi.fn()
    a.listen(cb)
    a.set('travel')
    expect(cb).toHaveBeenCalledWith('travel')
  })
})

describe('useValue', () => {
  function Probe({ a }: { a: ReturnType<typeof atom<number>> }) {
    const v = useValue(a)
    return <div data-testid="probe">{v}</div>
  }

  it('re-renders on atom change', () => {
    const a = atom(1)
    const { rerender } = render(<Probe a={a} />)
    expect(screen.getByTestId('probe').textContent).toBe('1')
    a.set(42)
    rerender(<Probe a={a} />)
    expect(screen.getByTestId('probe').textContent).toBe('42')
  })
})
