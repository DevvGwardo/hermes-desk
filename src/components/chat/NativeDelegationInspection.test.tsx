import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeDelegationInspection } from './NativeDelegationInspection'
import type { NativeDelegationSnapshot } from '../../lib/agents/native-delegation'

const data: NativeDelegationSnapshot = { generation: 'generation-1', subagents: [
  { subagent_id: 'child-1', goal: 'Fixture child', status: 'running', accepting_steer: true },
], delegations: [] }
const actions = () => ({ list: vi.fn().mockResolvedValue(data),
  tail: vi.fn().mockResolvedValue({ available: false, text: '', truncated: false }),
  interrupt: vi.fn().mockResolvedValue(false), steer: vi.fn().mockResolvedValue(false) })
afterEach(cleanup)
async function open() {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Inspect delegated tasks' })))
  fireEvent.click(screen.getByRole('button', { name: 'Fixture child' }))
}
it('reads explicitly, preserves rejected drafts, and never reports accepted controls as completion/delivery', async () => {
  const api = actions()
  render(<NativeDelegationInspection actions={api} />)
  expect(api.list).not.toHaveBeenCalled()
  await open()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Read live transcript' })))
  expect(screen.getByText(/Live transcript unavailable/)).toBeVisible()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Local steer' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Queue steering' })))
  expect(screen.getByRole('textbox')).toHaveValue('Local steer')
  expect(api.steer).toHaveBeenCalledWith('child-1', 'Local steer', 'generation-1')
  api.steer.mockResolvedValue(true)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Queue steering' })))
  expect(screen.getByText(/queued, not confirmed delivered/)).toBeVisible()
  expect(screen.getByRole('textbox')).toHaveValue('')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Request stop' })))
  expect(screen.getByText(/No controllable live child found/)).toBeVisible()
  api.interrupt.mockResolvedValue(true)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Request stop' })))
  expect(screen.getByText(/acknowledged the interrupt, not completion/)).toBeVisible()
})
it('fences uncertain controls until inspection and disables offline mutations', async () => {
  const api = actions()
  api.steer.mockRejectedValue(new Error('Lost acknowledgment'))
  const view = render(<NativeDelegationInspection actions={api} />)
  await open()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Preserve me' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Queue steering' })))
  expect(screen.getByRole('textbox')).toHaveValue('Preserve me')
  expect(screen.getByRole('button', { name: 'Request stop' })).toBeDisabled()
  expect(api.steer).toHaveBeenCalledTimes(1)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh delegated tasks' })))
  expect(screen.getByRole('button', { name: 'Request stop' })).toBeEnabled()
  view.rerender(<NativeDelegationInspection actions={api} offline />)
  expect(screen.getByRole('button', { name: 'Request stop' })).toBeDisabled()
})
it('coalesces reads and discards slow responses when the inspector is closed', async () => {
  const api = actions()
  let release!: (value: NativeDelegationSnapshot) => void
  api.list.mockImplementation(() => new Promise(resolve => { release = resolve }))
  const view = render(<NativeDelegationInspection actions={api} />)
  fireEvent.click(screen.getByRole('button', { name: 'Inspect delegated tasks' }))
  fireEvent.click(screen.getByRole('button', { name: 'Contacting Hermes…' }))
  expect(api.list).toHaveBeenCalledTimes(1)
  view.unmount()
  render(<NativeDelegationInspection actions={actions()} />)
  await act(async () => release(data))
  expect(screen.queryByText('Fixture child')).toBeNull()
})
