import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as rest from '../../lib/hermes-rest'
import * as activeTransport from '../../lib/agents/active-transport'
import type { AgentTransport } from '../../lib/agents/transport'
import { HermesSurfacesPanel } from '../HermesSurfacesPanel'

vi.mock('../../lib/hermes-rest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/hermes-rest')>()
  return {
    ...actual,
    serveGet: vi.fn(),
    listServeSkills: vi.fn(),
    toggleServeSkill: vi.fn(),
    getServeMemory: vi.fn(),
    listServeMemoryPending: vi.fn(),
    resolveServeMemoryPending: vi.fn(),
    serveAuth: vi.fn(async () => ({ baseUrl: 'nub-vm://dashboard', token: 'vm' })),
  }
})

vi.mock('../../lib/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/memory')>()
  return { ...actual, getMemoryToggles: vi.fn(async () => null), canViewMemoryFiles: () => false }
})

vi.mock('../../lib/skills-hub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/skills-hub')>()
  return { ...actual, listOfficialSkills: vi.fn(async () => ({ kind: 'ok', skills: [], hiddenCount: 0 })) }
})

vi.mock('../../lib/skill-setup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/skill-setup')>()
  return {
    ...actual,
    getEnvStatus: vi.fn(async () => ({})),
    loadSkillSetup: vi.fn(async () => ({
      needsSetup: true,
      fields: [{ name: 'NOTION_API_KEY', prompt: 'Notion API key', isSet: false, denied: false }],
      missingEnv: ['NOTION_API_KEY'],
      missingCommands: [],
      missingFiles: [],
    })),
    getSkillRequirements: vi.fn(async (name: string) =>
      name === 'notion'
        ? { platforms: null, env: [{ name: 'NOTION_API_KEY', prompt: 'Notion API key' }], commands: [], credentialFiles: [] }
        : { platforms: null, env: [], commands: [], credentialFiles: [] },
    ),
  }
})

vi.mock('../../lib/agents/active-transport', () => ({
  getActiveTransport: vi.fn(),
}))

function stubMotion() {
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
}

beforeEach(() => {
  cleanup()
  stubMotion()
  vi.clearAllMocks()
  vi.mocked(rest.serveGet).mockResolvedValue({ ok: true })
  vi.mocked(rest.listServeSkills).mockResolvedValue([])
  vi.mocked(rest.toggleServeSkill).mockResolvedValue(true)
  vi.mocked(rest.getServeMemory).mockResolvedValue({ active: '', providers: [], builtinFiles: { memory: 3072, user: 1024 } })
  vi.mocked(rest.listServeMemoryPending).mockResolvedValue(null)
  vi.mocked(rest.resolveServeMemoryPending).mockResolvedValue({ ok: true })
  vi.mocked(activeTransport.getActiveTransport).mockResolvedValue({
    transport: {} as AgentTransport,
    mode: 'mock',
    source: 'mock',
  })
})

describe('HermesSurfacesPanel skills', () => {
  it('renders skill rows with name, description, and on/off — not JSON', async () => {
    vi.mocked(rest.listServeSkills).mockResolvedValue([
      { name: 'web', description: 'Browse the web', enabled: true },
    ])
    render(<HermesSurfacesPanel open onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('web')).toBeTruthy()
    })
    expect(screen.getByText('Browse the web')).toBeTruthy()
    const toggle = screen.getByRole('button', { name: 'web skill' })
    expect(toggle.textContent).toBe('on')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText(/\{.*"name":"web"/)).toBeNull()
    expect(screen.queryByText('No skills reported.')).toBeNull()
  })

  it('toggle calls PUT /api/skills/toggle and reflects state', async () => {
    let enabled = true
    vi.mocked(rest.listServeSkills).mockImplementation(async () => [
      { name: 'web', description: 'Browse the web', enabled },
    ])
    vi.mocked(rest.toggleServeSkill).mockImplementation(async (_name, next) => {
      enabled = next
      return true
    })
    render(<HermesSurfacesPanel open onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'web skill', pressed: true })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'web skill' }))
    await waitFor(() => {
      expect(rest.toggleServeSkill).toHaveBeenCalledWith('web', false)
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'web skill', pressed: false }).textContent).toBe('off')
    })
  })

  it('empty skills offer the gallery, not a /skills chat hint', async () => {
    render(<HermesSurfacesPanel open onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('No skills on this agent yet')).toBeTruthy()
    })
    expect(screen.queryByText(/isn't possible|Manage skills on the agent/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add skills' }))
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Add skills' })).toBeTruthy()
    })
  })

  it('hides installed skills that can’t run on a hosted agent', async () => {
    vi.mocked(rest.listServeSkills).mockResolvedValue([
      { name: 'imessage', description: 'Mac only', enabled: true, category: 'apple' },
      { name: 'web', description: 'Browse the web', enabled: true },
    ])
    render(<HermesSurfacesPanel open onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('web')).toBeTruthy()
    })
    expect(screen.queryByText('imessage')).toBeNull()
  })

  it('shows Needs setup for a skill missing its key and opens the Connect drawer', async () => {
    vi.mocked(rest.listServeSkills).mockResolvedValue([
      { name: 'notion', description: 'Notion', enabled: true },
      { name: 'web', description: 'Browse the web', enabled: true },
    ])
    render(<HermesSurfacesPanel open onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Needs setup' })).toBeTruthy()
    })
    expect(screen.getAllByRole('button', { name: 'Needs setup' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Needs setup' }))
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Connect Notion' })).toBeTruthy()
    })
    await waitFor(() => {
      expect(screen.getByLabelText('Notion API key')).toBeTruthy()
    })
  })

  it('uses upstream readiness fields when the agent reports them', async () => {
    vi.mocked(rest.listServeSkills).mockResolvedValue([
      { name: 'web', description: 'Browse the web', enabled: true, setup_needed: true, missing_env: ['WEB_KEY'] },
    ])
    render(<HermesSurfacesPanel open onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Needs setup' })).toBeTruthy()
    })
  })

  it('offline / no-serve still shows the requires-serve banner', async () => {
    vi.mocked(rest.serveGet).mockResolvedValue(null)
    render(<HermesSurfacesPanel open onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText(/Could not reach the agent VM dashboard/)).toBeTruthy()
    })
    expect(screen.getByText(/need the VM dashboard hostname/)).toBeTruthy()
    expect(screen.queryByText('Open this agent to add skills')).toBeNull()
  })
})

describe('HermesSurfacesPanel deploy skills', () => {
  it('renders read-only skill rows from the deploy transport when serve is down', async () => {
    vi.mocked(rest.serveGet).mockResolvedValue(null)
    vi.mocked(activeTransport.getActiveTransport).mockResolvedValue({
      transport: {
        listSkills: vi.fn(async () => [
          { name: 'web', description: 'Browse the web', category: 'browse' },
        ]),
      } as unknown as AgentTransport,
      mode: 'api',
      source: 'deploy@https://nub.example',
    })
    render(<HermesSurfacesPanel open onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('web')).toBeTruthy()
    })
    expect(screen.getByText('Browse the web')).toBeTruthy()
    expect(screen.getByText(/Read-only/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'web skill' })).toBeNull()
    expect(screen.queryByText(/Could not reach the agent VM dashboard/)).toBeNull()
  })

  it('shows a read-only empty state when the deploy agent has no skills', async () => {
    vi.mocked(rest.serveGet).mockResolvedValue(null)
    vi.mocked(activeTransport.getActiveTransport).mockResolvedValue({
      transport: { listSkills: vi.fn(async () => []) } as unknown as AgentTransport,
      mode: 'api',
      source: 'deploy@https://nub.example',
    })
    render(<HermesSurfacesPanel open onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('No skills reported on this agent')).toBeTruthy()
    })
    expect(screen.queryByText('Open this agent to add skills')).toBeNull()
    expect(screen.queryByText(/Could not reach the agent VM dashboard/)).toBeNull()
  })
})

describe('HermesSurfacesPanel memory', () => {
  it('shows the real hermes memory status, not "Provider: none"', async () => {
    render(<HermesSurfacesPanel open onClose={() => {}} initialTab="memory" />)
    await waitFor(() => {
      expect(screen.getByText('Built-in memory · 3 KB facts, 1 KB about you')).toBeTruthy()
    })
    expect(screen.queryByText('none')).toBeNull()
    expect(screen.queryByText('[object Object]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('shows Approve / Reject only when pending memory exists', async () => {
    vi.mocked(rest.listServeMemoryPending).mockResolvedValue([
      { id: 'p1', preview: 'remember the deploy host' },
    ])
    render(<HermesSurfacesPanel open onClose={() => {}} initialTab="memory" />)
    await waitFor(() => {
      expect(screen.getByText('remember the deploy host')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => {
      expect(rest.resolveServeMemoryPending).toHaveBeenCalledWith('p1', 'approve')
    })
  })
})
