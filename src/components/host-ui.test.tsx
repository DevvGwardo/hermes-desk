import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { sidebarPreview } from './Sidebar'
import { AgentCard } from './AgentCard'
import { EmptyState } from './EmptyState'
import { Onboarding } from './Onboarding'
import FilesPanel from './FilesPanel'
import { CommandPalette } from './CommandPalette'
import { ProfileTools } from './AgentPersonaPanel'
import { SettingsStub } from './SettingsStub'
import { installTestHost, testConfig, testStatus } from './settings/local/test-fixtures'
import type { RosterAgent } from '../lib/agents/roster'

vi.mock('../lib/hermes-rest', async original => ({
  ...(await original<typeof import('../lib/hermes-rest')>()),
  serveGet: vi.fn(async (path: string) => path.includes('/api/skills') ? { skills: [{ name: `Skill for ${path.split('=')[1]}` }] } :
    { active: '', providers: [], builtin_files: { memory: 0, user: 0 } }),
  serveGetDetailed: vi.fn(async (path: string) => ({ data: path.startsWith('/api/skills?') ?
    { skills: [{ name: `Skill for ${path.split('=')[1]}` }] } : null })),
}))
const agent = { id: 'profile:alpha', hermesProfile: 'alpha', name: 'Alpha', status: 'running',
  region: 'local', summary: '', createdAt: '2026-10-06T00:00:00Z', model: 'fake-model' } as RosterAgent
beforeEach(() => { window.localStorage.clear(); Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); delete window.nubAgent })

describe('honest local host surfaces', () => {
  it('never claims no messages when non-desktop sessions or recent activity exist', () => {
    expect(sidebarPreview(agent, undefined, { preview: 'Latest CLI work', hasSessions: true })).toBe('Latest CLI work')
    expect(sidebarPreview(agent, undefined, { lastActivityAt: '2026-10-06T06:00:00Z', hasSessions: true },
      new Date('2026-10-06T12:00:00Z').getTime())).toMatch(/No desktop chats yet.*last active/)
    expect(sidebarPreview(agent, undefined, { hasSessions: true })).toContain('other sessions available')
  })
  it('starts with a 64px Pip footer row and expands only when requested', () => {
    const onOpenInfo = vi.fn()
    const { container } = render(<AgentCard agent={agent} presence="browsing" onOpenInfo={onOpenInfo} />)
    const row = screen.getByRole('button', { name: 'About Alpha' })
    expect(row.style.height).toBe('64px')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-character="owl"]')).toBeTruthy()
    expect(screen.queryByText('Open agent info')).toBeNull()
    fireEvent.click(row); fireEvent.click(screen.getByText('Open agent info'))
    expect(onOpenInfo).toHaveBeenCalledOnce()
  })
  it.each(['hermes-not-found', 'no-profiles', 'no-conversations', 'empty-lane'] as const)('provides a truthful Pip empty state and real action for %s', kind => {
    const onAction = vi.fn()
    const { container } = render(<EmptyState kind={kind} onAction={onAction} />)
    expect(container.querySelector('[data-character="owl"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(onAction).toHaveBeenCalledOnce()
  })
  it('shows first-run detection/profiles, enables only the clicked profile, and remembers a skip', async () => {
    const { host } = installTestHost()
    const config = { ...testConfig(), onboarding: { completed: false } }
    host.getConfig.mockResolvedValue(config)
    host.status.mockResolvedValue({ ...testStatus(), installation: { home: config.hermesHome, homeExists: true, binary: '/fake/hermes', detected: true } })
    const { rerender } = render(<Onboarding onOpenSettings={() => {}} />)
    await screen.findByRole('dialog', { name: 'Welcome to Hermes Desk' })
    expect(host.enableBrowserControl).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: 'Enable browsing' })[1])
    await waitFor(() => expect(host.enableBrowserControl).toHaveBeenCalledWith(['spike-alpha']))
    await screen.findByText(/Browsing enabled/)
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }))
    await waitFor(() => expect(host.setConfig).toHaveBeenCalledWith({ onboarding: { completed: true } }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    host.getConfig.mockResolvedValue({ ...config, onboarding: { completed: true } })
    rerender(<Onboarding onOpenSettings={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('loads Files from the main default root and gives a specific forbidden-folder error', async () => {
    const hermes = vi.fn(async (_kind: string, args: string[]) => args[0] === 'defaultRoot'
      ? { ok: true, data: '/fake/home' } : args[1] === '/fake/outside'
        ? { ok: false, error: 'dir outside home/external roots' } : { ok: true, data: { entries: [] } })
    window.nubAgent = { hermes } as unknown as Window['nubAgent']
    const props = { onClose() {}, onOpenFile() {}, onOpenPhotos() {} }
    const { rerender } = render(<FilesPanel open cwd="/" {...props} />)
    await screen.findByText('No files yet')
    expect(hermes).toHaveBeenCalledWith('fs', ['list', '/fake/home'])
    expect(hermes).not.toHaveBeenCalledWith('fs', ['list', '/'])
    rerender(<FilesPanel open cwd="/fake/outside" {...props} />)
    await screen.findByText('This folder is outside what Hermes Desk can open.')
  })
  it('loads skills A→B→A with explicit profile queries instead of global tools', async () => {
    const { rerender } = render(<ProfileTools profile="alpha" kind="skills" />)
    await screen.findByText('Skill for alpha')
    rerender(<ProfileTools profile="beta" kind="skills" />)
    await screen.findByText('Skill for beta')
    expect(screen.queryByText('Skill for alpha')).toBeNull()
    rerender(<ProfileTools profile="alpha" kind="skills" />)
    await screen.findByText('Skill for alpha')
  })
  it('offers metadata-only vault preference and revocation controls, with unavailable states kept explicit', async () => {
    const { host } = installTestHost()
    const value = { state: 'ready', vaults: [{ id: 'fake-vault', name: 'Fake vault' }], defaultVault: '',
      approvals: [{ origin: 'https://example.invalid', at: '2026-10-06T00:00:00Z', scope: 'once' }] }
    const secretsMetadata = vi.fn(async () => value)
    const revokeOrigin = vi.fn(async () => ({ ...value, approvals: [] }))
    window.nubAgent = { host: { ...host, secretsMetadata, revokeOrigin } } as unknown as Window['nubAgent']
    render(<SettingsStub open initialPane="secrets" onClose={() => {}} />)
    await screen.findByText('Status: ready')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Default vault' })).toHaveProperty('disabled', false))
    fireEvent.change(screen.getByRole('combobox', { name: 'Default vault' }), { target: { value: 'fake-vault' } })
    await waitFor(() => expect(host.setConfig).toHaveBeenCalledWith({ secrets: { defaultVault: 'fake-vault' } }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke https://example.invalid' })).toHaveProperty('disabled', false))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke https://example.invalid' }))
    await screen.findByText('No recent origin consents in this app session.')
    expect(revokeOrigin).toHaveBeenCalledWith('https://example.invalid')
  })
})
describe('local command palette actions', () => {
  it('runs registered reserved commands when optional callbacks are absent, including Files for the current selection', () => {
    const files = vi.fn(), create = vi.fn(), newConversation = vi.fn(), close = vi.fn()
    render(<CommandPalette open onClose={close} agents={[agent]} onJumpToAgent={() => {}}
      commands={[{ id: 'open-files', label: 'Files', run: files }, { id: 'new-agent', label: 'New agent', run: create },
        { id: 'new-conversation', label: 'New conversation', run: newConversation }]} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Actions' }))
    fireEvent.click(screen.getByRole('option', { name: /^Files/ })); fireEvent.click(screen.getByText('New agent')); fireEvent.click(screen.getByText('New conversation'))
    expect(files).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledOnce()
    expect(newConversation).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledTimes(3)
  })
  it('omits unhandled result/actions and prefers explicit callbacks over registered fallbacks', () => {
    const fallback = vi.fn(), callback = vi.fn()
    render(<CommandPalette open onClose={() => {}} agents={[]} onJumpToAgent={() => {}} onOpenFiles={callback}
      files={[{ path: '/fake/file.txt', label: 'Unopenable file' }]}
      commands={[{ id: 'open-files', label: 'Files', run: fallback }, { id: 'toggle-hud', label: 'HUD', run() {} }]} />)
    fireEvent.click(screen.getByText('Files', { selector: '[role="option"] span' }))
    expect(callback).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()
    expect(screen.queryByText('Spawn subagent')).toBeNull()
    expect(screen.queryByText('HUD')).toBeNull()
    expect(screen.queryByText('Unopenable file')).toBeNull()
  })
})
