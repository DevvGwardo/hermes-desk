import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Component } from 'react'
import { ErrorBoundary } from '../ErrorBoundary'

const load = vi.hoisted(() => vi.fn())
const gate = vi.hoisted(() => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
})
vi.mock('../CapturedRenderFailure', async () => {
  load()
  await gate.promise
  throw new Error('FAKE optional capture chunk unavailable')
})
class Bomb extends Component {
  render(): React.ReactNode { throw new Error('FAKE original renderer failure') }
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('optional capture UI loading', () => {
  it('retains the error fallback and Reload when the diagnostic chunk fails to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Bomb /></ErrorBoundary>)
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    await act(async () => { gate.release(); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(screen.getByText('Something went wrong')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })
})
