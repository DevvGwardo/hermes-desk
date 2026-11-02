import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import * as mcp from '../../lib/mcp'
import * as catalog from '../../lib/mcp-catalog'
import * as oauth from '../../lib/mcp-oauth'
import { Marketplace } from '../Marketplace'

vi.mock('../../lib/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mcp')>()
  return {
    ...actual,
    mcpAvailable: () => true,
    mcpListServers: vi.fn(),
    mcpAddServer: vi.fn(),
    mcpStartAuth: vi.fn(),
    mcpListServerTools: vi.fn(),
    mcpRemoveServer: vi.fn(),
    mcpSetEnabled: vi.fn(),
    mcpTestServer: vi.fn(),
  }
})
vi.mock('../../lib/mcp-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mcp-catalog')>()
  return { ...actual, listMcpCatalog: vi.fn(), installMcpCatalogEntry: vi.fn() }
})
vi.mock('../../lib/mcp-oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mcp-oauth')>()
  return { ...actual, waitForMcpOAuth: vi.fn(), cancelMcpOAuthFlow: vi.fn(), waitForMcpToolsReady: vi.fn() }
})
vi.mock('../../lib/maiavm-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/maiavm-api')>()
  return { ...actual, resolveNubApiConnection: vi.fn(async () => null) }
})

function stubMotion() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  })
}

const n8n = catalog.parseCatalogEntry({
  name: 'n8n', description: 'Workflows', transport: 'stdio', auth_type: 'api_key',
  required_env: [{ name: 'N8N_BASE_URL', prompt: 'n8n instance URL', required: true }, { name: 'N8N_API_KEY', prompt: 'n8n API key', required: true }],
})!
const linear = catalog.parseCatalogEntry({ name: 'linear', description: 'Issues and projects', transport: 'http', auth_type: 'oauth', url: 'https://mcp.linear.app/mcp' })!

beforeEach(() => {
  cleanup()
  stubMotion()
  vi.mocked(mcp.mcpAddServer).mockReset()
  vi.mocked(mcp.mcpListServers).mockResolvedValue({ servers: [] })
  vi.mocked(catalog.listMcpCatalog).mockResolvedValue({ kind: 'ok', entries: [linear, n8n] })
  vi.mocked(mcp.mcpListServerTools).mockResolvedValue({ ok: true, tools: [{ name: 'list_issues' }] })
})

/** The unified Marketplace with plugins on (the old Plugins dialog's home). */
function renderMarket(extra: Partial<ComponentProps<typeof Marketplace>> = {}) {
  return render(
    <Marketplace
      open
      agents={[]}
      onClose={() => {}}
      onAdd={async () => {}}
      onOpenAgent={() => {}}
      pluginsEnabled
      {...extra}
    />,
  )
}

const search = (value: string) =>
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search plugins and agents' }), { target: { value } })

describe('Marketplace plugins (was the Plugins dialog)', () => {
  it('uses the hermes catalog for plugins (plus kept presets)', async () => {
    renderMarket()
    await waitFor(() => expect(screen.getByText('Linear')).toBeTruthy())
    search('n8n')
    expect(screen.getByText('n8n')).toBeTruthy()
    search('memory')
    expect(screen.getByText('Memory')).toBeTruthy()
    search('gmail')
    expect(screen.queryByText('Gmail')).toBeNull()
  })

  it('falls back to built-in presets when the catalog 404s', async () => {
    vi.mocked(catalog.listMcpCatalog).mockResolvedValue({ kind: 'unsupported' })
    renderMarket()
    await waitFor(() => expect(screen.getByText('Gmail')).toBeTruthy())
  })

  it('one search covers plugins and agents', async () => {
    renderMarket()
    await waitFor(() => expect(screen.getByText('Linear')).toBeTruthy())
    search('i')
    expect(screen.getByRole('region', { name: 'Plugins' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy()
  })

  it('API-key catalog entries open a setup page, then install', async () => {
    vi.mocked(catalog.installMcpCatalogEntry).mockResolvedValue({ ok: true, background: true })
    renderMarket()
    await waitFor(() => expect(screen.getByText('Linear')).toBeTruthy())
    search('n8n')
    fireEvent.click(screen.getByRole('button', { name: 'Add n8n' }))
    fireEvent.change(await screen.findByLabelText('n8n instance URL'), { target: { value: 'https://n8n.example.com' } })
    const key = screen.getByLabelText('n8n API key') as HTMLInputElement
    expect(key.type).toBe('password')
    fireEvent.change(key, { target: { value: 'k1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add plugin' }))
    await waitFor(() =>
      expect(catalog.installMcpCatalogEntry).toHaveBeenCalledWith(n8n, { N8N_BASE_URL: 'https://n8n.example.com', N8N_API_KEY: 'k1' }),
    )
    await waitFor(() => expect(screen.getByText('n8n added.')).toBeTruthy())
  })

  it('"N installed" opens Manage plugins', async () => {
    vi.mocked(mcp.mcpListServers).mockResolvedValue({ servers: [{ name: 'linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth' }] })
    renderMarket()
    fireEvent.click(await screen.findByRole('button', { name: 'Your plugins' }))
    expect(await screen.findByText('Manage plugins')).toBeTruthy()
    expect(screen.getByText('linear')).toBeTruthy()
  })

  it('custom server form sends API key and env vars', async () => {
    vi.mocked(mcp.mcpAddServer).mockResolvedValue({ ok: true })
    renderMarket({ initialView: 'installed' })
    fireEvent.click(await screen.findByRole('button', { name: '+ Custom server' }))
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'tool' } })
    fireEvent.change(screen.getByLabelText('Stdio command'), { target: { value: 'npx' } })
    fireEvent.change(screen.getByLabelText('Environment variables'), { target: { value: 'TOOL_KEY=abc\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await waitFor(() =>
      expect(mcp.mcpAddServer).toHaveBeenCalledWith('tool', expect.objectContaining({ command: 'npx', env: { TOOL_KEY: 'abc' } })),
    )

    fireEvent.click(screen.getByRole('button', { name: '+ Custom server' }))
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'api' } })
    fireEvent.change(screen.getByLabelText('HTTPS endpoint'), { target: { value: 'https://x/mcp' } })
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sekret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await waitFor(() =>
      expect(mcp.mcpAddServer).toHaveBeenLastCalledWith('api', expect.objectContaining({ url: 'https://x/mcp', bearerToken: 'sekret' })),
    )
  })

  it('rejects malformed env lines before calling the agent', async () => {
    renderMarket({ initialView: 'installed' })
    fireEvent.click(await screen.findByRole('button', { name: '+ Custom server' }))
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'tool' } })
    fireEvent.change(screen.getByLabelText('Environment variables'), { target: { value: 'oops' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await waitFor(() => expect(screen.getByText(/KEY=VALUE/)).toBeTruthy())
    expect(mcp.mcpAddServer).not.toHaveBeenCalled()
  })

  it('OAuth: opens the sign-in page, polls the flow, then auto-tests', async () => {
    vi.mocked(mcp.mcpListServers).mockResolvedValue({ servers: [{ name: 'linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth' }] })
    vi.mocked(mcp.mcpStartAuth).mockResolvedValue({ ok: true, flowId: 'f1', authorizationUrl: 'https://linear.app/oauth' })
    let finish: (v: oauth.McpOAuthFlowSnapshot) => void = () => {}
    vi.mocked(oauth.waitForMcpOAuth).mockImplementation(
      (_id, opts) =>
        new Promise((resolve) => {
          opts?.onUpdate?.({ status: 'authorization_required', tools: [] })
          finish = resolve
        }),
    )
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderMarket({ initialView: 'installed' })
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://linear.app/oauth', '_blank', 'noopener'))
    await waitFor(() => expect(screen.getByText('Waiting for you to finish signing in…')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeTruthy()
    expect(oauth.waitForMcpOAuth).toHaveBeenCalledWith('f1', expect.anything())
    finish({ status: 'approved', tools: [] })
    await waitFor(() => expect(screen.getByText('Signed in')).toBeTruthy())
    await waitFor(() => expect(mcp.mcpListServerTools).toHaveBeenCalledWith('linear'))
  })

  it('OAuth cancel sends DELETE for the flow', async () => {
    vi.mocked(mcp.mcpListServers).mockResolvedValue({ servers: [{ name: 'linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth' }] })
    vi.mocked(mcp.mcpStartAuth).mockResolvedValue({ ok: true, flowId: 'f2', authorizationUrl: 'https://linear.app/oauth' })
    vi.mocked(oauth.waitForMcpOAuth).mockImplementation(() => new Promise(() => {}))
    vi.mocked(oauth.cancelMcpOAuthFlow).mockResolvedValue(true)
    vi.spyOn(window, 'open').mockReturnValue(null)
    renderMarket({ initialView: 'installed' })
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel sign-in' }))
    expect(oauth.cancelMcpOAuthFlow).toHaveBeenCalledWith('f2')
    await waitFor(() => expect(screen.getByText('Sign-in cancelled')).toBeTruthy())
  })

  it('plugins off: agents only, no installed control', () => {
    renderMarket({ pluginsEnabled: false })
    expect(screen.getByRole('searchbox', { name: 'Search agents' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Your plugins' })).toBeNull()
  })
})
