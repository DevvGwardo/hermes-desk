import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RestoreHiddenMenu } from './RestoreHiddenMenu'
import type { RosterAgent } from '../lib/agents/roster'

afterEach(cleanup)
const agent = {
  id: 'profile:fake', hermesProfile: 'fake', name: 'Fake Hermes',
  ui_meta: { display_name: 'Fake display name' },
} as RosterAgent

describe('Hidden agents', () => {
  it('lists names for known profiles and retains missing profiles as restore options', () => {
    const onRestore = vi.fn()
    render(<RestoreHiddenMenu agents={[agent]} hiddenProfiles={['fake', 'fake-missing']} onRestore={onRestore} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hidden agents' }))
    expect(screen.getByRole('menuitem', { name: 'Fake display name' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'fake-missing' }))
    expect(onRestore).toHaveBeenCalledWith('fake-missing')
  })
  it('Escape closes and restores keyboard focus', () => {
    render(<RestoreHiddenMenu agents={[agent]} hiddenProfiles={['fake']} onRestore={vi.fn()} />)
    const button = screen.getByRole('button', { name: 'Hidden agents' })
    fireEvent.click(button)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(button)
  })
  it('shows an honest empty state and dismisses on outside input', () => {
    render(<RestoreHiddenMenu agents={[]} hiddenProfiles={[]} onRestore={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hidden agents' }))
    expect(screen.getByText('No hidden agents')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
