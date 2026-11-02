import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../hermes-rest', async (orig) => ({
  ...(await orig<typeof import('../hermes-rest')>()),
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))
const readText = vi.fn()
vi.mock('../fs', async (orig) => ({
  ...(await orig<typeof import('../fs')>()),
  readText: (...args: unknown[]) => readText(...args),
}))

import {
  MEMORY_FILES,
  canViewMemoryFiles,
  getMemoryOAuthStatus,
  getMemoryProviderConfig,
  getMemoryToggles,
  memoryOAuthUsable,
  parseProviderConfig,
  primaryProviderFields,
  readMemoryFile,
  resetMemory,
  saveMemoryProviderConfig,
  selectMemoryProvider,
  setMemoryToggle,
  setupMemoryProvider,
  splitMemoryEntries,
  startMemoryOAuth,
  togglesFromConfig,
} from '../memory'

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
  readText.mockReset()
})
afterEach(() => {
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
})

describe('toggles', () => {
  it('defaults match hermes DEFAULT_CONFIG and read booleans', () => {
    expect(togglesFromConfig({})).toEqual({ memoryEnabled: true, userProfileEnabled: true, writeApproval: false })
    expect(togglesFromConfig({ memory: { memory_enabled: false, write_approval: true } })).toEqual({
      memoryEnabled: false,
      userProfileEnabled: true,
      writeApproval: true,
    })
  })

  it('reads via GET /api/config and writes via the allowlisted patch', async () => {
    serveGetDetailed.mockResolvedValue({ data: { memory: { user_profile_enabled: false } }, status: 200 })
    expect(await getMemoryToggles()).toMatchObject({ userProfileEnabled: false })
    serveSend.mockResolvedValue({ ok: true, data: {} })
    await setMemoryToggle('writeApproval', true)
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/config', { config: { memory: { write_approval: true } } })
    await setMemoryToggle('memoryEnabled', false)
    expect(serveSend).toHaveBeenLastCalledWith('PUT', '/api/config', { config: { memory: { memory_enabled: false } } })
  })

  it('null when config is unreachable', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, error: { kind: 'unavailable', message: 'x' } })
    expect(await getMemoryToggles()).toBeNull()
  })
})

describe('reset', () => {
  it('posts {target} to /api/memory/reset', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true, deleted: ['MEMORY.md', 'USER.md'] } })
    expect(await resetMemory()).toEqual({ ok: true, deleted: ['MEMORY.md', 'USER.md'] })
    expect(serveSend).toHaveBeenCalledWith('POST', '/api/memory/reset', { target: 'all' })
  })
  it('404 → needs an update', async () => {
    serveSend.mockResolvedValue({ ok: false, data: null, status: 404 })
    expect((await resetMemory('user')).error).toMatch(/needs an update/)
  })
})

describe('viewer', () => {
  it('resolves local Hermes home and reads through guarded filesystem IPC', async () => {
    ;(window as unknown as { nubAgent: unknown }).nubAgent = {
      hermes: vi.fn(),
      serveConfig: vi.fn(async () => ({ hermesHome: '/fake/hermes-home' })),
    }
    readText.mockResolvedValue('a\n§\nb')
    expect(canViewMemoryFiles()).toBe(true)
    expect(await readMemoryFile('memory')).toBe('a\n§\nb')
    expect(readText).toHaveBeenCalledWith(`/fake/hermes-home/${MEMORY_FILES.memory}`)
    expect(MEMORY_FILES.user).toBe('memories/USER.md')
  })

  it('a missing local memory file reads as empty', async () => {
    ;(window as unknown as { nubAgent: unknown }).nubAgent = {
      hermes: vi.fn(),
      serveConfig: vi.fn(async () => ({ hermesHome: '/fake/hermes-home' })),
    }
    readText.mockRejectedValue(new Error('ENOENT'))
    expect(canViewMemoryFiles()).toBe(true)
    expect(await readMemoryFile('user')).toBe('')
  })

  it('hidden when neither is available', async () => {
    expect(canViewMemoryFiles()).toBe(false)
    expect(await readMemoryFile('user')).toBeNull()
  })

  it('splits entries on § lines', () => {
    expect(splitMemoryEntries('one\n§\ntwo lines\nhere\n§\n')).toEqual(['one', 'two lines\nhere'])
    expect(splitMemoryEntries('')).toEqual([])
  })

  it('splits only on lone § lines and stays linear on blank-heavy files', () => {
    vi.useRealTimers()
    expect(splitMemoryEntries('a\r\n  §\t\r\nb § c\n§x\n  §')).toEqual(['a', 'b § c\n§x'])
    // The old pattern rescanned a blank stretch from every line start inside it.
    const body = `first${' \n'.repeat(50_000)}second`
    const started = performance.now()
    expect(splitMemoryEntries(`§\n${body}`)).toEqual([body])
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('providers', () => {
  const hindsight = {
    name: 'hindsight',
    label: 'Hindsight',
    fields: [
      { key: 'mode', kind: 'select', value: 'local_embedded', options: [{ value: 'cloud' }], is_set: true },
      { key: 'api_key', kind: 'secret', label: 'API key', description: 'Hindsight Cloud API key', when: { mode: 'cloud' }, url: 'https://ui.hindsight.vectorize.io' },
      { key: 'api_key', kind: 'secret', description: 'API key (optional)', when: { mode: 'local_external' } },
      { key: 'llm_api_key', kind: 'secret', when: { mode: 'local_embedded' } },
      { key: 'bank_id', kind: 'text', value: 'hermes' },
    ],
  }

  it('honors the configured local provider mode instead of forcing cloud', () => {
    const cfg = parseProviderConfig(hindsight, 'hindsight')
    const fields = primaryProviderFields('hindsight', cfg)
    expect(fields.map((f) => [f.key, f.description])).toEqual([['llm_api_key', '']])
  })

  it('saves with fixed values and activates', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true, active: 'hindsight' } })
    await saveMemoryProviderConfig('hindsight', { api_key: 'k' })
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/memory/providers/hindsight/config', { values: { api_key: 'k' } })
    await saveMemoryProviderConfig('mem0', { api_key: 'm' })
    expect(serveSend).toHaveBeenLastCalledWith('PUT', '/api/memory/providers/mem0/config', { values: { api_key: 'm' } })
  })

  it('setup + select + config routes', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true, status: { status: 'needs_config' } } })
    expect(await setupMemoryProvider('mem0')).toEqual({ ok: true, status: 'needs_config' })
    expect(serveSend).toHaveBeenLastCalledWith('POST', '/api/memory/providers/mem0/setup', { values: {} })
    await selectMemoryProvider('')
    expect(serveSend).toHaveBeenLastCalledWith('PUT', '/api/memory/provider', { provider: '' })
    serveGetDetailed.mockResolvedValue({ data: hindsight, status: 200 })
    const res = await getMemoryProviderConfig('hindsight')
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/memory/providers/hindsight/config')
    expect(res.kind).toBe('ok')
    serveGetDetailed.mockResolvedValue({ data: null, status: 404 })
    expect(await getMemoryProviderConfig('x')).toEqual({ kind: 'unsupported' })
  })

  it('honcho oauth start/status', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { state: 'pending', detail: 'waiting', connected: false } })
    expect(await startMemoryOAuth('honcho')).toEqual({ ok: true, status: { state: 'pending', detail: 'waiting', connected: false } })
    expect(serveSend).toHaveBeenCalledWith('POST', '/api/memory/providers/honcho/oauth/start', {})
    serveGetDetailed.mockResolvedValue({ data: { state: 'connected', connected: true }, status: 200 })
    expect(await getMemoryOAuthStatus('honcho')).toMatchObject({ connected: true })
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/memory/providers/honcho/oauth/status')
    expect(memoryOAuthUsable(true)).toBe(false)
    expect(memoryOAuthUsable(false)).toBe(true)
  })
})
