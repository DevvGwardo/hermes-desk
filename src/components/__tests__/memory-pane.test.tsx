import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as rest from '../../lib/hermes-rest'
import * as memory from '../../lib/memory'
import { MemoryPane } from '../MemoryPane'

vi.mock('../../lib/hermes-rest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/hermes-rest')>()
  return {
    ...actual,
    getServeMemory: vi.fn(),
    listServeMemoryPending: vi.fn(),
    resolveServeMemoryPending: vi.fn(),
    serveAuth: vi.fn(),
  }
})
vi.mock('../../lib/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/memory')>()
  return {
    ...actual,
    getMemoryToggles: vi.fn(),
    setMemoryToggle: vi.fn(),
    canViewMemoryFiles: vi.fn(),
    readMemoryFile: vi.fn(),
    resetMemory: vi.fn(),
    getMemoryProviderConfig: vi.fn(),
    saveMemoryProviderConfig: vi.fn(),
    setupMemoryProvider: vi.fn(),
    selectMemoryProvider: vi.fn(),
    startMemoryOAuth: vi.fn(),
    getMemoryOAuthStatus: vi.fn(),
  }
})
vi.mock('../../lib/external-url', () => ({ openExternalUrl: vi.fn() }))

const info: rest.ServeMemoryInfo = {
  active: '',
  providers: [
    { name: 'honcho', description: '', available: true, configured: false, status: 'needs_config' },
    { name: 'holographic', description: '', available: true, configured: true, status: 'ready' },
    { name: 'mem0', description: '', available: false, configured: false, status: 'unavailable' },
    { name: 'openviking', description: '', available: true, configured: false, status: 'needs_config' },
    { name: 'byterover', description: '', available: true, configured: false, status: 'needs_config' },
  ],
  builtinFiles: { memory: 3072, user: 1024 },
}

beforeEach(() => {
  cleanup()
  vi.mocked(rest.getServeMemory).mockResolvedValue(info)
  vi.mocked(rest.listServeMemoryPending).mockResolvedValue(null)
  vi.mocked(rest.resolveServeMemoryPending).mockResolvedValue({ ok: true })
  vi.mocked(rest.serveAuth).mockResolvedValue({ baseUrl: 'nub-vm://dashboard', token: 'vm' })
  vi.mocked(memory.getMemoryToggles).mockResolvedValue({ memoryEnabled: true, userProfileEnabled: true, writeApproval: false })
  vi.mocked(memory.setMemoryToggle).mockResolvedValue({ ok: true, data: null })
  vi.mocked(memory.canViewMemoryFiles).mockReturnValue(true)
  vi.mocked(memory.readMemoryFile).mockImplementation(async (w) => (w === 'memory' ? 'Deploys go to fly.io\n§\nUses pnpm' : ''))
  vi.mocked(memory.resetMemory).mockResolvedValue({ ok: true, deleted: ['MEMORY.md'] })
})

describe('MemoryPane', () => {
  it('shows the built-in summary and three toggles', async () => {
    render(<MemoryPane />)
    await waitFor(() => expect(screen.getByText('Built-in memory · 3 KB facts, 1 KB about you')).toBeTruthy())
    expect((screen.getByLabelText(/Remember facts/) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/Learn about me/) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/Ask before remembering/) as HTMLInputElement).checked).toBe(false)
  })

  it('toggles write through setMemoryToggle', async () => {
    render(<MemoryPane />)
    const box = (await screen.findByLabelText(/Ask before remembering/)) as HTMLInputElement
    fireEvent.click(box)
    await waitFor(() => expect(memory.setMemoryToggle).toHaveBeenCalledWith('writeApproval', true))
    await waitFor(() => expect((screen.getByLabelText(/Ask before remembering/) as HTMLInputElement).checked).toBe(true))
  })

  it('hides the pending section when the route is missing, shows it with items', async () => {
    const { unmount } = render(<MemoryPane />)
    await waitFor(() => expect(screen.getByText('Built-in memory · 3 KB facts, 1 KB about you')).toBeTruthy())
    expect(screen.queryByText('Waiting for your OK')).toBeNull()
    unmount()
    vi.mocked(rest.listServeMemoryPending).mockResolvedValue([{ id: 'p1', preview: 'Likes tea', target: 'user' }])
    render(<MemoryPane />)
    await waitFor(() => expect(screen.getByText('Likes tea')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(rest.resolveServeMemoryPending).toHaveBeenCalledWith('p1', 'reject'))
  })

  it('shows replace details and keeps a 409 item pending with the reason', async () => {
    vi.mocked(rest.listServeMemoryPending).mockResolvedValue([
      { id: 'p2', preview: 'Uses pnpm', oldText: 'Uses npm', action: 'replace', target: 'memory' },
    ])
    vi.mocked(rest.resolveServeMemoryPending).mockResolvedValue({ ok: false, error: 'Couldn’t save this — your agent’s memory may be full.' })
    render(<MemoryPane />)
    await waitFor(() => expect(screen.getByText('Uses pnpm')).toBeTruthy())
    expect(screen.getByText('Replaces: Uses npm')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(screen.getByText(/memory may be full/)).toBeTruthy())
    expect(screen.getByText('Uses pnpm')).toBeTruthy()
  })

  it('viewer lists entries; hidden when files can’t be read', async () => {
    render(<MemoryPane />)
    fireEvent.click(await screen.findByRole('button', { name: 'See what your agent remembers' }))
    await waitFor(() => expect(screen.getByText('Deploys go to fly.io')).toBeTruthy())
    expect(screen.getByText('Uses pnpm')).toBeTruthy()
    cleanup()
    vi.mocked(memory.canViewMemoryFiles).mockReturnValue(false)
    render(<MemoryPane />)
    await waitFor(() => expect(screen.getByText('Built-in memory · 3 KB facts, 1 KB about you')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'See what your agent remembers' })).toBeNull()
  })

  it('Forget everything asks first, then resets', async () => {
    render(<MemoryPane />)
    fireEvent.click(await screen.findByRole('button', { name: 'Forget everything' }))
    expect(memory.resetMemory).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, forget everything' }))
    await waitFor(() => expect(memory.resetMemory).toHaveBeenCalledWith('all'))
    await waitFor(() => expect(screen.getByText('Your agent’s memory was cleared.')).toBeTruthy())
  })

  it('an open memory list empties after Forget everything', async () => {
    render(<MemoryPane />)
    fireEvent.click(await screen.findByRole('button', { name: 'See what your agent remembers' }))
    await waitFor(() => expect(screen.getByText('Deploys go to fly.io')).toBeTruthy())
    vi.mocked(memory.readMemoryFile).mockResolvedValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Forget everything' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, forget everything' }))
    await waitFor(() => expect(screen.queryByText('Deploys go to fly.io')).toBeNull())
    expect(screen.getAllByText('Nothing saved yet.').length).toBe(2)
  })

  it('does not restore forgotten facts when an older viewer read finishes late', async () => {
    let resolve!: (text: string) => void
    let reads = 0
    vi.mocked(memory.readMemoryFile).mockImplementation(which => {
      if (which === 'user' || ++reads > 1) return Promise.resolve('')
      return new Promise<string>(done => { resolve = done })
    })
    render(<MemoryPane />)
    fireEvent.click(await screen.findByRole('button', { name: 'See what your agent remembers' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Forget everything' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, forget everything' }))
    await waitFor(() => expect(screen.getAllByText('Nothing saved yet.')).toHaveLength(2))
    await act(async () => resolve('Obsolete fixture fact before reset'))
    expect(screen.queryByText('Obsolete fixture fact before reset')).toBeNull()
    expect(screen.getAllByText('Nothing saved yet.')).toHaveLength(2)
    expect(reads).toBe(2)
  })

  it.each(['success', 'failure'])('ignores a late %s from a closed viewer after reopening', async outcome => {
    let resolve!: (text: string) => void
    let reject!: (reason: Error) => void
    let reads = 0
    vi.mocked(memory.readMemoryFile).mockImplementation(which => {
      if (which === 'user') return Promise.resolve('')
      if (++reads > 1) return Promise.resolve('Current fixture memory')
      return new Promise<string>((done, fail) => { resolve = done; reject = fail })
    })
    render(<MemoryPane />)
    fireEvent.click(await screen.findByRole('button', { name: 'See what your agent remembers' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide what your agent remembers' }))
    fireEvent.click(screen.getByRole('button', { name: 'See what your agent remembers' }))
    await screen.findByText('Current fixture memory')
    await act(async () => {
      if (outcome === 'success') resolve('Obsolete fixture read from a closed viewer')
      else reject(new Error('Obsolete fixture read failure'))
    })
    expect(screen.queryByText('Obsolete fixture read from a closed viewer')).toBeNull()
    expect(screen.queryByText('Couldn’t open this from your agent.')).toBeNull()
    expect(screen.getByText('Current fixture memory')).toBeTruthy()
    expect(reads).toBe(2)
  })

  it('shows a safe file error, preserves the other file, and recovers on reopening', async () => {
    vi.mocked(memory.readMemoryFile).mockImplementation(which => which === 'memory'
      ? Promise.reject(new Error('obviously fake private memory read detail'))
      : Promise.resolve('Current fixture preference'))
    render(<MemoryPane />)
    fireEvent.click(await screen.findByRole('button', { name: 'See what your agent remembers' }))
    await screen.findByText('Couldn’t open this from your agent.')
    expect(screen.getByText('Current fixture preference')).toBeTruthy()
    expect(screen.queryByText(/obviously fake private memory read detail/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Hide what your agent remembers' }))
    vi.mocked(memory.readMemoryFile).mockImplementation(async which => which === 'memory' ? 'Recovered fixture fact' : 'Current fixture preference')
    fireEvent.click(screen.getByRole('button', { name: 'See what your agent remembers' }))
    await screen.findByText('Recovered fixture fact')
    expect(screen.queryByText('Couldn’t open this from your agent.')).toBeNull()
    expect(screen.getByText('Current fixture preference')).toBeTruthy()
  })

  it('shows supported providers only (no openviking/byterover)', async () => {
    render(<MemoryPane />)
    await waitFor(() => expect(screen.getByText('Honcho')).toBeTruthy())
    expect(screen.getByText('Holographic')).toBeTruthy()
    expect(screen.getByText('Mem0')).toBeTruthy()
    expect(screen.queryByText(/openviking/i)).toBeNull()
    expect(screen.queryByText(/byterover/i)).toBeNull()
  })

  it('connect a provider: schema field → save activates it; no OAuth button on a hosted VM', async () => {
    vi.mocked(memory.getMemoryProviderConfig).mockResolvedValue({
      kind: 'ok',
      config: {
        name: 'honcho',
        label: 'Honcho',
        fields: [
          { key: 'api_key', label: 'Api Key', kind: 'secret', description: 'Honcho API key', placeholder: '', required: false, value: '', isSet: false, options: [], url: 'https://app.honcho.dev', when: null },
          { key: 'baseUrl', label: 'Base', kind: 'text', description: 'Self-hosted URL', placeholder: '', required: false, value: '', isSet: false, options: [], url: '', when: null },
        ],
      },
    })
    vi.mocked(memory.saveMemoryProviderConfig).mockResolvedValue({ ok: true, data: { ok: true, active: 'honcho' } })
    render(<MemoryPane />)
    await waitFor(() => expect(screen.getByText('Honcho')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0])
    const key = (await screen.findByLabelText('Honcho API key')) as HTMLInputElement
    expect(key.type).toBe('password')
    expect(screen.queryByLabelText('Self-hosted URL')).toBeNull()
    expect(screen.queryByRole('button', { name: /Sign in with Honcho/ })).toBeNull()
    fireEvent.change(key, { target: { value: 'hk' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and use' }))
    await waitFor(() => expect(memory.saveMemoryProviderConfig).toHaveBeenCalledWith('honcho', { api_key: 'hk' }))
  })

  it('Honcho sign-in is offered on a local agent and completes by polling', async () => {
    vi.mocked(rest.serveAuth).mockResolvedValue({ baseUrl: 'http://127.0.0.1:9119', token: 't' })
    vi.mocked(memory.getMemoryProviderConfig).mockResolvedValue({ kind: 'ok', config: { name: 'honcho', label: 'Honcho', fields: [] } })
    vi.mocked(memory.startMemoryOAuth).mockResolvedValue({ ok: true, status: { state: 'pending', detail: '', connected: false } })
    vi.mocked(memory.getMemoryOAuthStatus).mockResolvedValue({ state: 'connected', detail: '', connected: true })
    vi.mocked(memory.saveMemoryProviderConfig).mockResolvedValue({ ok: true, data: { ok: true } })
    render(<MemoryPane />)
    await waitFor(() => expect(screen.getByText('Honcho')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Honcho' }))
    await waitFor(() => expect(memory.startMemoryOAuth).toHaveBeenCalledWith('honcho'))
    await waitFor(() => expect(memory.saveMemoryProviderConfig).toHaveBeenCalledWith('honcho', {}))
  })

  it('unavailable providers install first', async () => {
    vi.mocked(memory.getMemoryProviderConfig).mockResolvedValue({ kind: 'ok', config: { name: 'mem0', label: 'Mem0', fields: [] } })
    vi.mocked(memory.setupMemoryProvider).mockResolvedValue({ ok: true })
    vi.mocked(memory.saveMemoryProviderConfig).mockResolvedValue({ ok: true, data: { ok: true } })
    render(<MemoryPane />)
    await waitFor(() => expect(screen.getByText('Mem0')).toBeTruthy())
    const buttons = screen.getAllByRole('button', { name: 'Connect' })
    fireEvent.click(buttons[buttons.length - 1])
    fireEvent.click(await screen.findByRole('button', { name: 'Use this' }))
    await waitFor(() => expect(memory.setupMemoryProvider).toHaveBeenCalledWith('mem0', {}))
    await waitFor(() => expect(memory.saveMemoryProviderConfig).toHaveBeenCalledWith('mem0', {}))
  })

  it('active provider can be turned off', async () => {
    vi.mocked(rest.getServeMemory).mockResolvedValue({ ...info, active: 'holographic' })
    vi.mocked(memory.selectMemoryProvider).mockResolvedValue({ ok: true, data: { ok: true } })
    render(<MemoryPane />)
    await waitFor(() => expect(screen.getByText('In use')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(memory.selectMemoryProvider).toHaveBeenCalledWith(''))
  })

  it('error state when memory can’t load, with Retry', async () => {
    vi.mocked(rest.getServeMemory).mockResolvedValueOnce(null)
    render(<MemoryPane />)
    await waitFor(() => expect(screen.getByText(/Couldn’t load memory from your agent\./)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('Built-in memory · 3 KB facts, 1 KB about you')).toBeTruthy())
  })
})
