/**
 * Connect apps hub: the Marketplace home starts with a "Your workspace" row
 * (Routines, Files, Tasks, Skills) that used to live at the top of the
 * sidebar. A tile closes the hub, then opens its surface.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Marketplace } from '../Marketplace'
import { hubShortcuts } from '../HubShortcuts'

vi.mock('../FatCatIcon', () => ({ FatCatIcon: () => null }))

afterEach(() => cleanup())

function openHub(shortcuts = hubShortcuts({
  onOpenRoutines: vi.fn(),
  routinesActiveCount: 2,
  onOpenFiles: vi.fn(),
  onOpenTasks: vi.fn(),
  onOpenSkills: vi.fn(),
})) {
  const onClose = vi.fn()
  render(
    <Marketplace open agents={[]} onClose={onClose} onAdd={vi.fn(async () => {})} onOpenAgent={vi.fn()} shortcuts={shortcuts} />,
  )
  return { onClose, shortcuts }
}

describe('Connect apps hub', () => {
  it('is titled Connect apps and leads with the workspace tiles, in order', () => {
    openHub()
    expect(screen.getByRole('dialog', { name: 'Connect apps' })).toBeTruthy()
    const row = screen.getByRole('region', { name: 'Your workspace' })
    const labels = within(row).getAllByRole('button').map((b) => b.querySelector('.mk-hub__label')?.textContent)
    expect(labels).toEqual(['Routines', 'Files', 'Tasks', 'Skills'])
    expect(within(row).getByTestId('hub-routines').textContent).toContain('2 active')
    // The workspace row comes before the store's sections.
    const agents = screen.getByRole('region', { name: 'Agents' })
    expect(row.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a tile closes the hub and opens its surface', () => {
    const { onClose, shortcuts } = openHub()
    fireEvent.click(screen.getByTestId('hub-routines'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(shortcuts[0]!.onSelect).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('hub-tasks'))
    expect(shortcuts.find((s) => s.id === 'tasks')!.onSelect).toHaveBeenCalledTimes(1)
  })

  it('leaves out what is unreachable, and the row when nothing is', () => {
    openHub(hubShortcuts({ onOpenRoutines: vi.fn(), onOpenFiles: vi.fn() }))
    expect(screen.queryByTestId('hub-tasks')).toBeNull()
    expect(screen.queryByTestId('hub-skills')).toBeNull()
    expect(screen.getByTestId('hub-routines').textContent).toContain('Scheduled')
    cleanup()
    openHub([])
    expect(screen.queryByRole('region', { name: 'Your workspace' })).toBeNull()
  })

  it('hides the workspace row while searching', () => {
    openHub()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'research' } })
    expect(screen.queryByRole('region', { name: 'Your workspace' })).toBeNull()
  })
})
