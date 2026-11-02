import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Agent } from '../../lib/agents'
import { Marketplace } from '../Marketplace'
import { MARKETPLACE_LISTINGS, SHELVES } from '../../lib/marketplace/catalog'
import { ROUTINE_RECIPES } from '../../lib/marketplace/routines'

// The mascot engine needs matchMedia/rAF; these tests are about the sheet.
vi.mock('../FatCatIcon', () => ({ FatCatIcon: () => null }))

afterEach(() => cleanup())

const base = { status: 'running' as const, region: 'remote', createdAt: '2026-09-27T00:00:00Z', summary: '' }
const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({ ...base, id, name, ...extra })

function open(agents: Agent[] = [], onAdd = vi.fn(async () => {})) {
  const onOpenAgent = vi.fn()
  render(<Marketplace open agents={agents} onClose={() => {}} onAdd={onAdd} onOpenAgent={onOpenAgent} />)
  return { onAdd, onOpenAgent }
}
const rowOf = (slug: string) => document.querySelector(`[data-slug="${slug}"]`) as HTMLElement
/** Home previews 6 agents; the rest are one "View all" away. */
const allAgents = () => fireEvent.click(screen.getByRole('button', { name: 'View all' }))

describe('Marketplace', () => {
  it('shows agents as rows: mascot, name, "by Nub", one line, Add', () => {
    open()
    expect(screen.getByText('Agents')).toBeTruthy()
    expect(screen.getAllByTestId('mk-row').length).toBe(6)
    allAgents()
    expect(screen.getAllByTestId('mk-row').length).toBe(MARKETPLACE_LISTINGS.length)
    // The full list is grouped under the shelf names.
    for (const shelf of SHELVES) expect(screen.getByRole('heading', { name: shelf.title })).toBeTruthy()
    const row = rowOf('web-researcher')
    expect(row.textContent).toContain('Web Researcher')
    expect(row.textContent).toContain('by Nub')
    expect(within(row).getByRole('button', { name: 'Add Web Researcher' })).toBeTruthy()
  })

  it('Add creates the agent with the listing profile, shows progress, then Added', async () => {
    let finish: () => void = () => {}
    const onAdd = vi.fn(() => new Promise<void>((r) => (finish = r)))
    open([], onAdd)
    allAgents()
    fireEvent.click(screen.getByRole('button', { name: 'Add Writer' }))
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ name: 'Writer', role: 'specialist' }))
    expect(within(rowOf('writer')).getByRole('status', { name: 'Adding Writer' })).toBeTruthy()
    // A second tap while adding does nothing.
    expect(within(rowOf('writer')).queryByRole('button', { name: 'Add Writer' })).toBeNull()
    await act(async () => finish())
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('an agent you already have reads Added', () => {
    open([agent('w1', 'Writer')])
    allAgents()
    expect(within(rowOf('writer')).getByTestId('mk-added').textContent).toContain('Added')
  })

  it('a failed Add says why on the row and can be retried', async () => {
    const onAdd = vi.fn(async () => {
      throw new Error('not linked: pair first')
    })
    open([], onAdd)
    allAgents()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add Coder' })))
    expect(within(rowOf('coder')).getByRole('alert').textContent).toBe('Pair this device with your agent first.')
    expect(within(rowOf('coder')).getByRole('button', { name: 'Add Coder' })).toBeTruthy()
  })

  it('reads Added as soon as the agent is on the roster; a setup refusal later says why', async () => {
    let refuse: (err: Error) => void = () => {}
    const ready = new Promise<void>((_, reject) => (refuse = reject))
    const onAdd = vi.fn(async () => ({ ready }))
    const props = { open: true, onClose: () => {}, onAdd, onOpenAgent: vi.fn() }
    const { rerender } = render(<Marketplace {...props} agents={[]} />)
    allAgents()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add Coder' })))
    // The roster now has it (local insert); the VM setup is still running.
    rerender(<Marketplace {...props} agents={[agent('k1', 'Coder')]} />)
    expect(within(rowOf('coder')).getByTestId('mk-added')).toBeTruthy()
    // Refused → rolled back off the roster, the row explains and offers Add again.
    rerender(<Marketplace {...props} agents={[]} />)
    await act(async () => refuse(new Error('Your agent refused this request.')))
    expect(within(rowOf('coder')).getByRole('alert').textContent).toBe('Your agent refused this request.')
    expect(within(rowOf('coder')).getByRole('button', { name: 'Add Coder' })).toBeTruthy()
  })

  it('never adds a second Chief of Staff', () => {
    const { onOpenAgent } = open([agent('c1', 'Ava', { role: 'orchestrator' })])
    const row = rowOf('chief-of-staff')
    expect(row.textContent).toContain('You have one')
    expect(within(row).queryByRole('button', { name: /^Add/ })).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'About Chief of Staff' }))
    expect(screen.getByTestId('mk-detail').textContent).toContain('Ava is already your Chief of Staff')
    fireEvent.click(screen.getByRole('button', { name: 'Open Ava' }))
    expect(onOpenAgent).toHaveBeenCalledWith('c1')
  })

  it('search filters rows and says when nothing matches', () => {
    open()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agents' }), { target: { value: 'hacker' } })
    expect(screen.getAllByTestId('mk-row').map((r) => r.getAttribute('data-slug'))).toEqual(['hn-scout'])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agents' }), { target: { value: 'zzzz' } })
    expect(screen.getByText('Nothing matches “zzzz”.')).toBeTruthy()
  })

  it('opening a row shows the detail page; Open chat goes to an added agent', () => {
    const { onOpenAgent } = open([agent('x1', 'X Growth Analyst')])
    fireEvent.click(screen.getByRole('button', { name: 'About X Growth Analyst' }))
    const detail = screen.getByTestId('mk-detail')
    expect(detail.textContent).toContain('X / Twitter (public)')
    fireEvent.click(within(detail).getByRole('button', { name: 'Open chat' }))
    expect(onOpenAgent).toHaveBeenCalledWith('x1')
    fireEvent.click(within(detail).getByRole('button', { name: '‹ Back to Marketplace' }))
    expect(screen.getByTestId('marketplace')).toBeTruthy()
  })

  describe('routines', () => {
    function openWithRoutines() {
      const onUseRoutine = vi.fn()
      render(
        <Marketplace
          open
          agents={[]}
          onClose={() => {}}
          onAdd={vi.fn(async () => {})}
          onOpenAgent={vi.fn()}
          onUseRoutine={onUseRoutine}
        />,
      )
      return onUseRoutine
    }

    it('has no Routines section without a way to use one', () => {
      open()
      expect(screen.queryByRole('region', { name: 'Routines' })).toBeNull()
      expect(screen.getByPlaceholderText('Search agents')).toBeTruthy()
    })

    it('lists ready-made routines with their schedule in words', () => {
      openWithRoutines()
      const section = screen.getByRole('region', { name: 'Routines' })
      expect(within(section).getAllByTestId('mk-routine-row')).toHaveLength(4)
      expect(rowOf('morning-briefing').textContent).toContain('Weekdays at 9:00 AM')
      expect(screen.getByPlaceholderText('Search agents and routines')).toBeTruthy()
      fireEvent.click(within(section).getByRole('button', { name: 'View all' }))
      expect(screen.getAllByTestId('mk-routine-row')).toHaveLength(ROUTINE_RECIPES.length)
    })

    it('Use hands the editor a new routine to review (nothing is created here)', () => {
      const onUseRoutine = openWithRoutines()
      fireEvent.click(within(rowOf('weekly-wrap-up')).getByRole('button', { name: 'Use Weekly wrap-up' }))
      expect(onUseRoutine).toHaveBeenCalledWith({
        name: 'Weekly wrap-up',
        prompt: expect.stringContaining('this week'),
        schedule: '0 17 * * 5',
      })
    })

    it('the detail page shows exactly what will run', () => {
      const onUseRoutine = openWithRoutines()
      fireEvent.click(screen.getByRole('button', { name: 'About Morning briefing' }))
      const detail = screen.getByTestId('mk-routine-detail')
      expect(detail.textContent).toContain(ROUTINE_RECIPES[0]!.prompt)
      fireEvent.click(within(detail).getByRole('button', { name: 'Use this routine' }))
      expect(onUseRoutine).toHaveBeenCalledTimes(1)
    })

    it('search finds routines too', () => {
      openWithRoutines()
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hacker' } })
      expect(screen.getByRole('region', { name: 'Routines' })).toBeTruthy()
      expect(rowOf('hn-digest')).toBeTruthy()
    })
  })
})
