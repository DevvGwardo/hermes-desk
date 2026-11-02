import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useEverOpened } from '../use-ever-opened'

describe('useEverOpened', () => {
  it('starts false when the panel has never opened', () => {
    const { result } = renderHook(() => useEverOpened(false))
    expect(result.current).toBe(false)
  })

  it('starts true when already open on first render (mounted while open)', () => {
    const { result } = renderHook(() => useEverOpened(true))
    expect(result.current).toBe(true)
  })

  it('locks in true after the first open and never flips back', () => {
    const { result, rerender } = renderHook(({ open }) => useEverOpened(open), {
      initialProps: { open: false },
    })
    expect(result.current).toBe(false)
    act(() => rerender({ open: true }))
    expect(result.current).toBe(true)
    // closing must NOT unmount the panel — state stays true
    act(() => rerender({ open: false }))
    expect(result.current).toBe(true)
    // and re-opening keeps it true
    act(() => rerender({ open: true }))
    expect(result.current).toBe(true)
  })

  it('does not spam effects when open stays false', () => {
    const spy = vi.fn()
    const { rerender } = renderHook(({ open }) => useEverOpened(open), {
      initialProps: { open: false },
    })
    spy()
    act(() => rerender({ open: false }))
    act(() => rerender({ open: false }))
    expect(spy).toHaveBeenCalledTimes(1) // no re-render from our hook's own setState
  })
})
