import { describe, expect, it, vi } from 'vitest'
import { queryClient, useQuery } from '../query'
import { render, screen, waitFor } from '@testing-library/react'

describe('query cache', () => {
  it('invalidateQueries clears matching keys', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true })
    queryClient.invalidateQueries({ queryKey: ['test', 'x'] })

    // Seed a cache entry through useQuery, then invalidate.
    function Probe() {
      const { data } = useQuery({ queryKey: ['test', 'x'], queryFn: fn })
      return <div data-testid="q">{data ? 'loaded' : 'loading'}</div>
    }
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('q').textContent).toBe('loaded'))
    expect(fn).toHaveBeenCalledTimes(1)

    queryClient.invalidateQueries({ queryKey: ['test', 'x'] })
    expect(queryClient.getQueryData(['test', 'x'])).toBeUndefined()
  })

  it('dedupes identical query keys', async () => {
    const fn = vi.fn().mockResolvedValue(1)
    function A() {
      useQuery({ queryKey: ['dedupe'], queryFn: fn })
      return null
    }
    function B() {
      useQuery({ queryKey: ['dedupe'], queryFn: fn })
      return null
    }
    const { rerender } = render(<A />)
    rerender(<B />)
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1))
  })
})
