import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { InlineApproval } from './InlineApproval'
import type { PendingToolPermission } from '../../lib/agents'

afterEach(cleanup)
const ask: PendingToolPermission = {
  id: 'fixture-approval', conversationId: 'fixture-chat', sessionId: 'fixture-session',
  command: 'example command', description: 'Inspect project files', patterns: ['example-pattern'],
  choices: ['once', 'session', 'always', 'deny'], status: 'pending',
}

it('explains broader pattern scope without defaulting focus to an approval', () => {
  render(<InlineApproval ask={ask} agentName="Review assistant" onChoice={vi.fn()} />)
  expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Review assistant')
  expect(screen.getByRole('button', { name: 'Allow for this session' }).closest('details')?.hasAttribute('open')).toBe(false)
  fireEvent.click(screen.getByText('Broader permission'))
  expect(screen.getByText('example-pattern')).toBeTruthy()
  expect(screen.getByText(/These choices allow matching action patterns/)).toBeTruthy()
  expect(screen.getByText('command_allowlist')).toBeTruthy()
})

it('submits only once before backend state paints, then permits retry after a failure', () => {
  const choice = vi.fn()
  const view = render(<InlineApproval ask={ask} onChoice={choice} />)
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
  })
  expect(choice).toHaveBeenCalledExactlyOnceWith('once')
  view.rerender(<InlineApproval ask={{ ...ask, status: 'failed' }} onChoice={choice} />)
  fireEvent.click(screen.getByRole('button', { name: "Don't allow" }))
  expect(choice).toHaveBeenLastCalledWith('deny')
})
