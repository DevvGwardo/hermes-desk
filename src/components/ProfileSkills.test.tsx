import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ProfileSkills } from './ProfileSkills'
import { ProfileToolsPanel } from './ProfileToolsPanel'

const get = vi.fn()
vi.mock('../lib/hermes-rest', async original => ({
  ...(await original<typeof import('../lib/hermes-rest')>()), serveGetDetailed: (...args: unknown[]) => get(...args),
}))
const content = `---\nname: imessage\nplatforms: [darwin]\nrequired_environment_variables: [FIXTURE_KEY]\nprerequisites:\n  commands: [fixture-cli]\n---\n# Mac fixture\nCheck before using.`
beforeEach(() => {
  get.mockReset()
  get.mockImplementation(async (path: string) => path.includes('/content?') ? { data: { content } } :
    { data: [{ name: 'imessage', description: 'Mac-only local skill', enabled: true }, { name: 'notes', description: 'Write notes' }] })
})
afterEach(cleanup)

describe('profile installed skill workflow', () => {
  it('keeps disabled installed skills inspectable without permitting a use handoff', async () => {
    get.mockImplementation(async (path: string) => path.includes('/content?') ? { data: { content } } :
      { data: [{ name: 'imessage', enabled: false }] })
    const use = vi.fn()
    render(<ProfileSkills profile="alpha" onUseSkill={use} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect imessage' }))
    await screen.findByText('Declared requirements, not checked')
    expect(screen.getByText('Disabled in Hermes')).toBeTruthy()
    const prepare = screen.getByRole('button', { name: 'Prepare in chat' }) as HTMLButtonElement
    expect(prepare.disabled).toBe(true)
    fireEvent.click(prepare)
    expect(use).not.toHaveBeenCalled()
    expect(screen.getByText(/disabled in Hermes/)).toBeTruthy()
  })
  it('keeps Mac skills, searches locally and reads the selected profile’s instructions without claiming readiness', async () => {
    const use = vi.fn()
    render(<ProfileSkills profile="alpha" onUseSkill={use} />)
    fireEvent.change(screen.getByLabelText('Search installed skills'), { target: { value: 'mac-only' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect imessage' }))
    await screen.findByText('Declared requirements, not checked')
    expect(screen.getByText('FIXTURE_KEY')).toBeTruthy()
    expect(screen.getByText('Command: fixture-cli')).toBeTruthy()
    expect(get).toHaveBeenCalledWith('/api/skills/content?profile=alpha&name=imessage')
    expect(screen.queryByRole('button', { name: 'Inspect notes' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Prepare in chat' }))
    expect(use).toHaveBeenCalledWith('alpha', 'imessage')
  })
  it('reinspecting the same skill does not strand its content in Loading', async () => {
    render(<ProfileSkills profile="alpha" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect imessage' }))
    await screen.findByText('Declared requirements, not checked')
    fireEvent.click(screen.getByRole('button', { name: 'Inspect imessage' }))
    expect(screen.queryByText('Loading skill instructions…')).toBeNull()
  })
  it('discards a slow A response across A→B→A, resets search/details and never reads the launch profile', async () => {
    let release!: (value: unknown) => void
    get.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const { rerender } = render(<ProfileSkills profile="alpha" />)
    rerender(<ProfileSkills profile="beta" />)
    await screen.findByRole('button', { name: 'Inspect notes' })
    await act(async () => release({ data: [{ name: 'stale-alpha' }] }))
    expect(screen.queryByRole('button', { name: 'Inspect stale-alpha' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Search installed skills'), { target: { value: 'notes' } })
    rerender(<ProfileSkills profile="alpha" />)
    await screen.findByRole('button', { name: 'Inspect imessage' })
    expect(screen.getByLabelText('Search installed skills')).toHaveValue('')
    expect(get.mock.calls.every(([path]) => String(path).includes('profile='))).toBe(true)
  })
  it('distinguishes unavailable and empty lists, retries reads, and never invents an install action', async () => {
    get.mockResolvedValueOnce({ data: null }).mockResolvedValueOnce({ data: [] })
    render(<ProfileSkills profile="alpha" />)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Retry skills' }))
    await screen.findByText('Hermes reports no installed skills for this profile.')
    expect(screen.queryByRole('button', { name: /Install|Enable|Prepare/ })).toBeNull()
  })
  it('fails closed for an invalid profile', async () => {
    render(<ProfileSkills profile="../real-user" />)
    await screen.findByText('Select a valid local profile.')
    expect(get).not.toHaveBeenCalled()
  })
  it('retains a content error until retry and restores search focus on close', async () => {
    get.mockImplementation(async path => path.includes('/content?') ? { data: null } : { data: [{ name: 'imessage' }] })
    render(<ProfileSkills profile="alpha" onUseSkill={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect imessage' }))
    await screen.findByText(/Could not load these instructions/)
    expect(screen.queryByRole('button', { name: 'Prepare in chat' })).toBeNull()
    get.mockResolvedValue({ data: { content } })
    fireEvent.click(screen.getByRole('button', { name: 'Retry instructions' }))
    await screen.findByText('Declared requirements, not checked')
    fireEvent.click(screen.getByRole('button', { name: 'Close skill details' }))
    expect(screen.getByLabelText('Search installed skills')).toHaveFocus()
  })
  it('close/reopen drops an old content read and loads current profile data', async () => {
    let release!: (value: unknown) => void
    get.mockImplementation(async path => path.includes('/content?') ?
      new Promise(resolve => { release = resolve }) : { data: [{ name: 'imessage' }] })
    const { rerender } = render(<ProfileToolsPanel open profile="alpha" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect imessage' }))
    await screen.findByText('Loading skill instructions…')
    rerender(<ProfileToolsPanel open={false} profile="alpha" onClose={() => {}} />)
    get.mockResolvedValue({ data: [{ name: 'new-profile-skill' }] })
    rerender(<ProfileToolsPanel open profile="alpha" onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Inspect new-profile-skill' })
    await act(async () => release({ data: { content: 'Abandoned content' } }))
    expect(screen.queryByText('Abandoned content')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Skill details for imessage' })).toBeNull()
  })
})
