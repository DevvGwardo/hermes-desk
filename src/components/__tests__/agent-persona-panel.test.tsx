import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../../lib/hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))
vi.mock('../../lib/maiavm-api', async (orig) => ({
  ...(await orig<typeof import('../../lib/maiavm-api')>()),
  resolveNubApiConnection: vi.fn(async () => ({ baseUrl: 'x', token: 't', instanceId: 'inst_main' })),
}))
const removeAgent = vi.fn(async () => {})
vi.mock('../../lib/agents/active-transport', () => ({
  getActiveTransport: async () => ({ transport: { removeAgent } }),
}))

import { AgentPersonaPanel, profileForAgent } from '../AgentPersonaPanel'
import { TONE_PRESETS } from '../../lib/agent-profiles'
import type { Agent } from '../../lib/agents/types'
import { getLocalPrefs } from '../../lib/local-prefs'

const w = window as unknown as { nubAgent?: unknown }

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'inst_helper',
  name: 'Scout',
  status: 'running',
  region: 'remote',
  createdAt: '2026-09-01T00:00:00Z',
  summary: '',
  ...over,
})

let fs: ReturnType<typeof vi.fn>
let setProfileSoul: ReturnType<typeof vi.fn>

beforeEach(() => {
  cleanup()
  window.localStorage.clear()
  serveGetDetailed.mockReset()
  serveSend.mockReset()
  removeAgent.mockClear()
  serveGetDetailed.mockResolvedValue({ data: { content: 'Be nice.', exists: true } })
  fs = vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === 'root') return { ok: true, data: { cwd: '/fake/workspace' } }
    if (args[0] === 'read-text') return { ok: true, data: { content: '# House rules' } }
    return { ok: true }
  })
  setProfileSoul = vi.fn(async () => {})
  w.nubAgent = { hermes: fs, host: { setProfileSoul } }
})
afterEach(() => {
  cleanup()
  delete w.nubAgent
})

describe('profileForAgent', () => {
  it('maps agents to hermes profiles', () => {
    expect(profileForAgent(agent({ hermesProfile: 'scout' }), 'inst_main')).toBe('scout')
    expect(profileForAgent(agent({ id: 'inst_main' }), 'inst_main')).toBe('default')
    expect(profileForAgent(agent({ id: 'profile:coder' }), null)).toBe('coder')
    expect(profileForAgent(agent(), 'inst_main')).toBeNull()
  })
})

describe('AgentPersonaPanel', () => {
  it('edits the personality with a tone preset', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true } })
    render(<AgentPersonaPanel agent={agent({ hermesProfile: 'scout' })} />)
    const box = (await screen.findByLabelText('Personality')) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe('Be nice.'))
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/profiles/scout/soul')
    // Hand-written words count as Custom: the editor is open.
    expect(screen.getByRole('radio', { name: 'Custom' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Concise' }))
    // A preset is one tap: its words show as a preview, not an editor.
    expect(screen.getByRole('radio', { name: 'Concise' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByLabelText('Personality')).toBeNull()
    expect(screen.getByText(TONE_PRESETS[1]!.text)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save personality' }))
    await screen.findByText(/New chats use this personality/)
    expect(setProfileSoul).toHaveBeenCalledWith('scout', TONE_PRESETS[1]!.text)
    expect(serveSend).not.toHaveBeenCalled()
  })

  it('opens on the preset, with no editor and no save button until something changes', async () => {
    serveGetDetailed.mockResolvedValue({ data: { content: TONE_PRESETS[0]!.text, exists: true } })
    render(<AgentPersonaPanel agent={agent({ hermesProfile: 'scout' })} />)
    await screen.findByText(TONE_PRESETS[0]!.text)
    expect(screen.getByRole('radio', { name: 'Friendly' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByLabelText('Personality')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save personality' })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }))
    const box = screen.getByLabelText('Personality') as HTMLTextAreaElement
    expect(box.value).toBe(TONE_PRESETS[0]!.text)
    fireEvent.change(box, { target: { value: 'Talk like a pirate.' } })
    expect(screen.getByRole('button', { name: 'Save personality' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.queryByLabelText('Personality')).toBeNull()
  })

  it('edits project instructions (AGENTS.md)', async () => {
    render(<AgentPersonaPanel agent={agent({ id: 'profile:default' })} />)
    const box = (await screen.findByLabelText('Project instructions')) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe('# House rules'))
    fireEvent.change(box, { target: { value: '# New rules' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }))
    await screen.findByText('Saved.')
    expect(fs).toHaveBeenCalledWith('fs', ['write-text', '/fake/workspace/AGENTS.md', '# New rules'])
  })

  it('never offers delete for the main agent', async () => {
    render(<AgentPersonaPanel agent={agent({ id: 'profile:default' })} />)
    await screen.findByLabelText('Personality')
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull()
  })

  it('hides a helper only after confirming, without deleting a profile or its history', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true } })
    const onDeleted = vi.fn()
    render(<AgentPersonaPanel agent={agent({ hermesProfile: 'scout' })} onDeleted={onDeleted} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Hide Scout…' }))
    expect(serveSend).not.toHaveBeenCalledWith('DELETE', expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Hide agent' }))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(serveSend).not.toHaveBeenCalled()
    expect(removeAgent).not.toHaveBeenCalled()
    expect(getLocalPrefs().hiddenProfiles).toEqual(['scout'])
  })

  it('cancels hiding without changing local visibility', async () => {
    render(<AgentPersonaPanel agent={agent({ hermesProfile: 'scout' })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Hide Scout…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(getLocalPrefs().hiddenProfiles).toEqual([])
    expect(removeAgent).not.toHaveBeenCalled()
  })
})
