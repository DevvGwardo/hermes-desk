import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GroupEditor, GROUP_USAGE_NOTICE_KEY } from '../GroupEditor'
import type { Agent } from '../../lib/agents'

function agent(id: string, name: string, extra?: Partial<Agent>): Agent {
  return { id, name, status: 'running', region: 'remote', createdAt: '', summary: '', ...extra }
}

const agents = [
  agent('nub', 'Nub'),
  agent('bob', 'CoderBob'),
  agent('cos', 'Chief of Staff', { role: 'orchestrator' }),
]

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  }
})

beforeEach(() => {
  window.localStorage.removeItem(GROUP_USAGE_NOTICE_KEY)
})

afterEach(() => {
  cleanup()
})

describe('GroupEditor', () => {
  it('does not apply an old creation error to a new pending creation', async () => {
    let reject!: (error: Error) => void
    const onCreate = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail }))
      .mockImplementationOnce(() => new Promise<void>(() => {}))
    const props = { agents, onClose() {}, onCreate }
    const { rerender } = render(<GroupEditor {...props} open />)
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    rerender(<GroupEditor {...props} open={false} />)
    rerender(<GroupEditor {...props} open />)
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await act(async () => reject(new Error('Old creation failed')))
    expect(screen.queryByText('Old creation failed')).toBeNull()
    expect((screen.getByRole('button', { name: 'Creating…' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('auto-names from the picked members and creates with a blank name', async () => {
    const onCreate = vi.fn()
    render(<GroupEditor open agents={agents} chiefRouting onClose={() => {}} onCreate={onCreate} />)
    const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
    expect(name.placeholder).toBe('Nub and CoderBob')

    fireEvent.click(screen.getByRole('button', { name: /Chief of Staff/ }))
    expect(name.placeholder).toBe('Nub, CoderBob and Chief of Staff')
    expect(screen.getByTestId('group-chief-hint').textContent).toContain('Chief of Staff leads this room')

    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ name: '', memberAgentIds: ['nub', 'bob', 'cos'] }),
    )
  })

  it('a roster refresh while open keeps the typed name and picked members', () => {
    const { rerender } = render(<GroupEditor open agents={agents} chiefRouting onClose={() => {}} onCreate={() => {}} />)
    const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Launch crew' } })
    fireEvent.click(screen.getByRole('button', { name: /Chief of Staff/ }))
    expect(name.placeholder).toBe('Nub, CoderBob and Chief of Staff')

    // A sync or status change hands down a new array with the same agents.
    rerender(
      <GroupEditor open agents={agents.map((a) => ({ ...a }))} chiefRouting onClose={() => {}} onCreate={() => {}} />,
    )
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Launch crew')
    expect(name.placeholder).toBe('Nub, CoderBob and Chief of Staff')
  })

  it('reopening still starts fresh', () => {
    const { rerender } = render(<GroupEditor open agents={agents} chiefRouting onClose={() => {}} onCreate={() => {}} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Launch crew' } })
    rerender(<GroupEditor open={false} agents={agents} chiefRouting onClose={() => {}} onCreate={() => {}} />)
    rerender(<GroupEditor open agents={agents} chiefRouting onClose={() => {}} onCreate={() => {}} />)
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('')
  })

  it('names the account Chief as the lead even when it is not picked', () => {
    render(<GroupEditor open agents={agents} chiefRouting onClose={() => {}} onCreate={() => {}} />)
    // Defaults pick Nub and CoderBob; the Chief of Staff leads without joining.
    expect(screen.getByTestId('group-chief-hint').textContent).toContain(
      'Chief of Staff leads this room without being a member',
    )
  })

  it('hides the Chief hint when rooms are off or not known yet (R24)', () => {
    for (const chiefRouting of [false, undefined]) {
      const { unmount } = render(
        <GroupEditor open agents={agents} chiefRouting={chiefRouting} onClose={() => {}} onCreate={() => {}} />,
      )
      fireEvent.click(screen.getByRole('button', { name: /Chief of Staff/ }))
      expect(screen.queryByTestId('group-chief-hint')).toBeNull()
      unmount()
    }
  })

  it('shows the usage notice once, until dismissed', () => {
    const { unmount } = render(<GroupEditor open agents={agents} onClose={() => {}} onCreate={() => {}} />)
    expect(screen.getByTestId('group-usage-notice').textContent).toContain('each member that answers is a separate request')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('group-usage-notice')).toBeNull()
    unmount()
    render(<GroupEditor open agents={agents} onClose={() => {}} onCreate={() => {}} />)
    expect(screen.queryByTestId('group-usage-notice')).toBeNull()
  })
})
