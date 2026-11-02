import { beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))

import {
  catalogDisplayName,
  filterMarketItems,
  installMcpCatalogEntry,
  isCatalogEnvKeyDenied,
  listMcpCatalog,
  marketItemsFromCatalog,
  parseCatalogEntry,
} from '../mcp-catalog'
import { MCP_PRESETS } from '../mcp-presets'

const entries = [
  { name: 'linear', description: 'Issues', transport: 'http', auth_type: 'oauth', required_env: [], url: 'https://mcp.linear.app/mcp', needs_install: false, installed: false, enabled: false },
  { name: 'n8n', description: 'Workflows', transport: 'stdio', auth_type: 'api_key', required_env: [
    { name: 'N8N_BASE_URL', prompt: 'n8n instance URL', required: true },
    { name: 'N8N_API_KEY', prompt: 'n8n API key', required: true },
  ], url: null, needs_install: true, installed: false, enabled: false },
  { name: 'unreal-engine', description: 'Editor', transport: 'http', auth_type: 'none', required_env: [], url: 'http://127.0.0.1:1/mcp' },
  { name: 'figma', description: 'Design', transport: 'http', auth_type: 'oauth', required_env: [], url: 'https://mcp.figma.com/mcp', installed: true },
]

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
})

describe('listMcpCatalog', () => {
  it('parses entries, hides desktop-only ones, sorts by name', async () => {
    serveGetDetailed.mockResolvedValue({ data: { entries, diagnostics: [] }, status: 200 })
    const res = await listMcpCatalog()
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/mcp/catalog')
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.entries.map((e) => e.name)).toEqual(['figma', 'linear', 'n8n'])
      expect(res.entries[2].requiredEnv).toHaveLength(2)
      expect(res.entries[0].installed).toBe(true)
    }
  })

  it('404 → unsupported so the panel falls back to presets', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 404, error: { kind: 'unavailable', status: 404, message: 'HTTP 404' } })
    expect(await listMcpCatalog()).toEqual({ kind: 'unsupported' })
  })

  it('parse rejects nameless rows', () => {
    expect(parseCatalogEntry({ description: 'x' })).toBeNull()
  })
})

describe('installMcpCatalogEntry', () => {
  const n8n = parseCatalogEntry(entries[1])!
  const linear = parseCatalogEntry(entries[0])!

  it('sends only declared env and polls background installs', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true, name: 'n8n', background: true, action: 'mcp-install-n8n-1' } })
    serveGetDetailed.mockResolvedValue({ data: { running: false, exit_code: 0, lines: [] }, status: 200 })
    const res = await installMcpCatalogEntry(n8n, { N8N_BASE_URL: 'https://n8n.example.com', N8N_API_KEY: ' k ' }, { sleep: async () => {} })
    expect(serveSend).toHaveBeenCalledWith('POST', '/api/mcp/catalog/install', {
      name: 'n8n',
      env: { N8N_BASE_URL: 'https://n8n.example.com', N8N_API_KEY: 'k' },
      enable: true,
    })
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/actions/mcp-install-n8n-1/status?lines=40')
    expect(res).toMatchObject({ ok: true, background: true })
  })

  it('refuses undeclared keys and missing required ones without calling the agent', async () => {
    expect((await installMcpCatalogEntry(n8n, { OPENAI_API_KEY: 'x' })).ok).toBe(false)
    expect((await installMcpCatalogEntry(n8n, { N8N_API_KEY: 'x' })).error).toMatch(/n8n instance URL/)
    expect(serveSend).not.toHaveBeenCalled()
  })

  it('synchronous install for OAuth entries', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true, name: 'linear', background: false } })
    expect(await installMcpCatalogEntry(linear)).toEqual({ ok: true, background: false })
  })

  it('surfaces the agent’s error', async () => {
    serveSend.mockResolvedValue({ ok: false, data: null, status: 400, error: 'bad key' })
    expect(await installMcpCatalogEntry(linear)).toEqual({ ok: false, error: 'bad key' })
  })

  it('denies LLM/agent keys even if declared', () => {
    expect(isCatalogEnvKeyDenied('OPENAI_API_KEY')).toBe(true)
    expect(isCatalogEnvKeyDenied('HERMES_HOME')).toBe(true)
    expect(isCatalogEnvKeyDenied('N8N_BASE_URL')).toBe(false)
  })
})

describe('market items', () => {
  it('uses the catalog and keeps only presets that work without a platform client', () => {
    const items = marketItemsFromCatalog(entries.map(parseCatalogEntry).filter((e) => e != null), MCP_PRESETS)
    const ids = items.map((i) => i.id)
    expect(ids).toContain('linear')
    expect(ids).toContain('memory')
    expect(ids).toContain('sequential-thinking')
    expect(ids).not.toContain('gmail')
    expect(ids.filter((i) => i === 'linear')).toHaveLength(1)
    expect(items.find((i) => i.id === 'n8n')?.signIn).toBe('key')
    expect(items.find((i) => i.id === 'linear')?.signIn).toBe('oauth')
    expect(filterMarketItems('work', items).map((i) => i.id)).toEqual(['n8n'])
  })

  it('display names', () => {
    expect(catalogDisplayName('hugging_face')).toBe('Hugging Face')
    expect(catalogDisplayName('n8n')).toBe('n8n')
  })
})
