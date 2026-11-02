import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AgentInfo } from '../AgentInfo'
import type { Agent, Group } from '../../lib/agents'

vi.mock('../../lib/hermes-rest', () => ({
  listServeCronJobs: vi.fn(async () => []),
  serveGet: vi.fn(async () => null),
  probeResize: vi.fn(async () => false),
  getResizeStatus: vi.fn(async () => null),
  cancelResize: vi.fn(async () => true),
  scheduleResize: vi.fn(async () => true),
}))

const base = { status: 'running' as const, region: 'remote', createdAt: '2026-09-27T00:00:00Z', summary: '' }
const chief: Agent = { ...base, id: 'c', name: 'Ava', role: 'orchestrator', persona: { title: 'Chief of Staff', description: '' } }
const penny: Agent = { ...base, id: 'p', name: 'Penny', persona: { title: 'Copywriter', description: '' } }
const bob: Agent = { ...base, id: 'b', name: 'CoderBob' }
const group: Group = {
  id: 'grp1',
  name: 'Launch crew',
  memberAgentIds: ['c', 'p'],
  primaryAgentId: 'c',
  summary: 'Group room',
  createdAt: '2026-09-27T00:00:00Z',
}

function renderGroup(props: Partial<Parameters<typeof AgentInfo>[0]> = {}) {
  return render(
    <AgentInfo
      agent={chief}
      group={group}
      members={[chief, penny]}
      allAgents={[chief, penny, bob]}
      open
      onClose={() => {}}
      onUpdateProfile={vi.fn()}
      onUpdateGroup={vi.fn()}
      routines={[]}
      {...props}
    />,
  )
}

// Unmount after every test too: without it the last test's tree outlives the
// file, and React's scheduler runs after jsdom teardown ("window is not
// defined" on slow CI runners).
afterEach(() => {
  cleanup()
})

beforeEach(() => {
  cleanup()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

describe('AgentInfo group mode', () => {
  it('allows clearing a custom room name to use member-based naming', () => {
    const onUpdateGroup = vi.fn()
    renderGroup({ onUpdateGroup })
    const name = screen.getByLabelText('Group name')
    fireEvent.change(name, { target: { value: '' } })
    fireEvent.blur(name)
    expect(onUpdateGroup).toHaveBeenCalledWith(group.id, { name: '' })
  })
  it('shows an asynchronous edit failure and allows retry without changing another room', async () => {
    let reject!: (error: Error) => void
    const onUpdateGroup = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
    const view = renderGroup({ onUpdateGroup })
    const name = screen.getByLabelText('Group name')
    fireEvent.change(name, { target: { value: 'Renamed crew' } })
    fireEvent.blur(name)
    expect((name as HTMLInputElement).disabled).toBe(true)
    await act(async () => reject(new Error('Fixture save failed')))
    expect(screen.getByRole('alert').textContent).toContain('Fixture save failed')
    expect((name as HTMLInputElement).disabled).toBe(false)
    fireEvent.blur(name)
    expect(onUpdateGroup).toHaveBeenCalledTimes(2)
    view.rerender(<AgentInfo agent={null} group={{ ...group, id: 'other', name: 'Other room' }}
      allAgents={[chief, penny]} open onClose={() => {}} onUpdateGroup={onUpdateGroup} />)
    await act(async () => reject(new Error('Old room error')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByLabelText('Group name') as HTMLInputElement).value).toBe('Other room')
  })
  it("shows the group, not the primary member's profile editor", () => {
    renderGroup()
    const section = screen.getByTestId('group-info')
    expect(within(section).getByLabelText('Group name')).toBeTruthy()
    // The placeholder summary isn't shown as a purpose.
    expect((within(section).getByLabelText('Group purpose') as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryByLabelText('Agent name')).toBeNull()
    expect(section.textContent).toContain('Members · 2 · Ava leads')
    expect(section.textContent).toContain('Copywriter')
  })

  it('names the account Chief of Staff as the lead when it is not a member', () => {
    renderGroup({
      agent: penny,
      group: { ...group, memberAgentIds: ['p', 'b'], primaryAgentId: 'p' },
      members: [penny, bob],
    })
    expect(screen.getByTestId('group-info').textContent).toContain(
      'Members · 2 · Ava leads (your Chief of Staff, not a member)',
    )
  })

  it('says everyone answers when the account has no Chief', () => {
    renderGroup({
      agent: penny,
      group: { ...group, memberAgentIds: ['p', 'b'], primaryAgentId: 'p' },
      members: [penny, bob],
      allAgents: [penny, bob],
    })
    expect(screen.getByTestId('group-info').textContent).toContain('no lead, everyone answers')
  })

  it('saves a purpose, which every member reads', () => {
    const onUpdateGroup = vi.fn()
    renderGroup({ onUpdateGroup })
    const purpose = screen.getByLabelText('Group purpose') as HTMLTextAreaElement
    expect(purpose.value).toBe('')
    fireEvent.change(purpose, { target: { value: 'Ship the coffee launch' } })
    fireEvent.blur(purpose)
    expect(onUpdateGroup).toHaveBeenCalledWith('grp1', { summary: 'Ship the coffee launch' })
  })

  it('makes a member the lead, or removes the lead', () => {
    const onSetGroupChief = vi.fn()
    renderGroup({ onSetGroupChief })
    fireEvent.click(screen.getByRole('button', { name: 'Make Penny the Chief of Staff' }))
    expect(onSetGroupChief).toHaveBeenCalledWith('grp1', 'p')
    fireEvent.click(screen.getByRole('button', { name: 'Stop Ava leading' }))
    expect(onSetGroupChief).toHaveBeenCalledWith('grp1', null)
  })

  it('adds and removes members from the desktop', () => {
    const onSetGroupMembers = vi.fn()
    renderGroup({ onSetGroupMembers })
    fireEvent.click(screen.getByRole('button', { name: 'Add or remove' }))
    const editor = screen.getByTestId('group-member-editor')
    fireEvent.click(within(editor).getByLabelText('CoderBob'))
    expect(onSetGroupMembers).toHaveBeenCalledWith('grp1', ['c', 'p', 'b'])
    fireEvent.click(within(editor).getByLabelText('Penny'))
    expect(onSetGroupMembers).toHaveBeenCalledWith('grp1', ['c'])
  })
})

describe('AgentInfo agent mode', () => {
  it('the Chief of Staff switch sets the role', () => {
    const onUpdateProfile = vi.fn()
    render(<AgentInfo agent={penny} open onClose={() => {}} onUpdateProfile={onUpdateProfile} routines={[]} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Chief of Staff' }))
    expect(onUpdateProfile).toHaveBeenCalledWith('p', { role: 'orchestrator' })
  })
})
