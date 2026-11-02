import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalRoomEngine } from '../../lib/agents/local-rooms'
import { RoomUsage } from './RoomUsage'
afterEach(cleanup)
function journal(outcome?: 'error' | 'timeout') {
  const room = new LocalRoomEngine('room', [{ id: 'alpha', profile: 'alpha', name: 'Alpha' }], 'Room')
  room.setTokenBudget(20)
  room.setBinding('alpha', { profile: 'alpha', runtimeId: 'runtime', storedId: 'stored', lastSeen: 0 })
  room.send('@Alpha fixture')
  const turn = room.takeReady()[0]!
  room.recordUsage('alpha', { input: 10, output: 10, total: 20 })
  if (outcome) room.complete(turn.id, outcome === 'error' ? { error: 'Model failed' } : { timeout: true })
  return room.state
}
it('shows member accounting, a reported-token limit and honest unknown pricing', () => {
  render(<RoomUsage journal={journal()} memberName={() => 'Alpha'} />)
  expect(screen.getByLabelText('Member token usage').textContent).toContain('Alpha: 20 total (10 input, 10 output)')
  expect(screen.getByText(/Cost estimate unavailable/)).toBeTruthy()
  expect((screen.getByLabelText('Per-request token budget') as HTMLInputElement).value).toBe('20')
})
it('retains the edited budget on a rejected save and allows a confirmed retry', async () => {
  const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  render(<RoomUsage journal={journal()} memberName={() => 'Alpha'} onSetBudget={save} />)
  fireEvent.change(screen.getByLabelText('Per-request token budget'), { target: { value: '100' } })
  await act(async () => { fireEvent.click(screen.getByText('Save token budget')) })
  expect(screen.getByRole('alert').textContent).toContain('No paused work was resumed')
  await act(async () => { fireEvent.click(screen.getByText('Save token budget')) })
  expect(save.mock.calls).toEqual([[100], [100]])
  expect(screen.queryByRole('alert')).toBeNull()
})
it.each(['error', 'timeout'] as const)('explains a budget-blocked %s retry without claiming queued work or automatic retry', outcome => {
  const state = journal(outcome)
  const { rerender } = render(<RoomUsage journal={state} memberName={() => 'Alpha'} />)
  expect(screen.getByRole('status').textContent).toContain('Raise the limit before retrying failed members')
  expect(screen.getByRole('status').textContent).toContain('not retried automatically')
  expect(screen.getByTestId('room-usage').querySelector('summary')?.textContent).toContain('Budget reached')
  expect(screen.queryByText(/Stop to cancel them/)).toBeNull()
  rerender(<RoomUsage journal={{ ...state, tokenBudget: 100 }} memberName={() => 'Alpha'} />)
  expect(screen.queryByRole('status')).toBeNull()
})
