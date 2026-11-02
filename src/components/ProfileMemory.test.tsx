import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProfileMemory } from './ProfileMemory'
import { memoryRecoveryCommands, memoryReviewRequest } from '../lib/profile-memory'

const get = vi.fn()
vi.mock('../lib/hermes-rest', async original => ({
  ...(await original<typeof import('../lib/hermes-rest')>()), serveGet: (...args: unknown[]) => get(...args),
}))
beforeEach(() => {
  get.mockReset()
  get.mockResolvedValue({ active: '', builtin_files: { memory: 120, user: 20 }, providers: [] })
})
afterEach(() => { cleanup(); delete window.nubAgent })
it('shows scoped disk status and prepares a review without writes or implicit execution', async () => {
  const prepare = vi.fn()
  render(<ProfileMemory profile="alpha" onPrepareReview={prepare} />)
  await screen.findByText('Built-in memory · 120 B facts, 20 B about you')
  expect(get).toHaveBeenCalledWith('/api/memory?profile=alpha')
  expect(screen.getByText(/content-edit RPCs do not accept a profile or session/)).toBeVisible()
  expect(screen.getByText(/not memory contents/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Prepare memory review in chat' }))
  expect(prepare).toHaveBeenCalledWith('alpha')
  expect(get).toHaveBeenCalledTimes(1)
  expect(memoryReviewRequest()).toContain('Do not add, replace, remove, reset, or configure memory.')
  expect(memoryRecoveryCommands('alpha')).toEqual({ status: 'hermes -p alpha memory status', chat: 'hermes -p alpha' })
  expect(memoryRecoveryCommands('../other')).toBeNull()
})
it('copies only the explicit profile command and does not run it', async () => {
  const copy = vi.fn().mockResolvedValue(undefined)
  window.nubAgent = { clipboard: { writeText: copy } } as unknown as NonNullable<typeof window.nubAgent>
  render(<ProfileMemory profile="beta" />)
  await screen.findByText('Built-in memory · 120 B facts, 20 B about you')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy profile CLI command' })))
  expect(copy).toHaveBeenCalledWith('hermes -p beta')
  expect(screen.getByText('Command copied. Nothing was run.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Prepare memory review in chat' })).toBeDisabled()
})
it('does not turn a failed status read into empty memory and retries explicitly', async () => {
  get.mockResolvedValueOnce(null)
  render(<ProfileMemory profile="alpha" />)
  await screen.findByRole('alert')
  expect(screen.queryByText(/nothing saved yet/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry memory status' }))
  await screen.findByText('Built-in memory · 120 B facts, 20 B about you')
  expect(get).toHaveBeenCalledTimes(2)
})
it('discards slow responses across Alpha→Beta→Alpha and on close', async () => {
  let release!: (value: unknown) => void
  get.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const view = render(<ProfileMemory profile="alpha" />)
  view.rerender(<ProfileMemory profile="beta" />)
  await screen.findByText('Built-in memory · 120 B facts, 20 B about you')
  view.rerender(<ProfileMemory profile="alpha" />)
  await screen.findByText('Built-in memory · 120 B facts, 20 B about you')
  await act(async () => release({ active: 'stale-provider', builtin_files: {}, providers: [] }))
  expect(screen.queryByText(/Stale-provider/)).toBeNull()
  expect(get.mock.calls.every(([path]) => path.includes('profile='))).toBe(true)
  view.unmount()
})
it('fails closed for an invalid profile instead of silently reading the launch home', async () => {
  render(<ProfileMemory profile="../other" onPrepareReview={vi.fn()} />)
  await screen.findByText('Select a valid profile.')
  expect(get).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Prepare memory review in chat' })).toBeNull()
})
