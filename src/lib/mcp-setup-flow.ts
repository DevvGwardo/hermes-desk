/**
 * The work behind the in-chat plugin card (`mcp.setup.request`).
 *
 * Mirrors the official Hermes desktop's setup card over the same dashboard
 * REST routes, reached through the `serve*` helpers:
 *   install   → GET /api/mcp/catalog, POST /api/mcp/catalog/install,
 *               GET /api/actions/{action}/status (git-backed entries)
 *   enable    → mcpSetEnabled (PUT /api/mcp/servers/{name}/enabled)
 *   authorize → POST /api/mcp/servers/{name}/auth, open the sign-in page,
 *               GET /api/mcp/oauth/flows/{id} until approved,
 *               DELETE /api/mcp/oauth/flows/{id} on cancel
 * Returns the outcome `setup_mcp` expects (tools/setup_mcp_tool.py).
 */
import { serveGet, serveGetDetailed, serveSend } from './hermes-rest'
import { mcpSetEnabled } from './mcp'
import type { McpSetupAction, McpSetupOutcome } from './agents/agent-prompts'

export interface CatalogEnv {
  name: string
  prompt?: string
  required?: boolean
}

interface CatalogEntry {
  name: string
  description?: string
  url?: string | null
  required_env?: CatalogEnv[]
}

interface OAuthSnapshot {
  flow_id?: string
  status?: string
  authorization_url?: string | null
  error?: string | null
  tools?: { name?: string }[]
}

export type McpSetupStep =
  | { kind: 'done'; outcome: McpSetupOutcome }
  /** Catalog entry needs keys first — show masked fields, then run again with `env`. */
  | { kind: 'needs-env'; env: CatalogEnv[] }
  /** The user cancelled mid-flow; the caller already answered "declined". */
  | { kind: 'cancelled' }

export interface McpSetupOptions {
  env?: Record<string, string>
  cancelled?: () => boolean
  openUrl?: (url: string) => Promise<void> | void
  /** Test seams. */
  pollMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return []
  return tools
    .map((t) => (t && typeof t === 'object' ? (t as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
}

async function loadCatalogEntry(server: string): Promise<CatalogEntry | null | 'unavailable'> {
  const data = await serveGet<{ entries?: CatalogEntry[] }>('/api/mcp/catalog')
  if (!data || !Array.isArray(data.entries)) return 'unavailable'
  return data.entries.find((e) => e?.name === server) ?? null
}

/** Required catalog keys not yet filled in. */
export function missingCatalogEnv(entry: { required_env?: CatalogEnv[] }, env: Record<string, string> = {}): CatalogEnv[] {
  return (entry.required_env ?? []).filter((e) => e.required !== false && !env[e.name]?.trim())
}

async function install(server: string, opts: McpSetupOptions): Promise<McpSetupStep> {
  const entry = await loadCatalogEntry(server)
  if (entry === 'unavailable') {
    return { kind: 'done', outcome: { status: 'error', server, detail: 'Your agent needs an update for this.' } }
  }
  if (!entry) {
    return { kind: 'done', outcome: { status: 'error', server, detail: `No catalog entry named '${server}'.` } }
  }
  const missing = missingCatalogEnv(entry, opts.env)
  if (missing.length > 0) return { kind: 'needs-env', env: entry.required_env ?? missing }
  const env: Record<string, string> = {}
  for (const e of entry.required_env ?? []) {
    const v = opts.env?.[e.name]?.trim()
    if (v) env[e.name] = v
  }
  const res = await serveSend<{ ok?: boolean; background?: boolean; action?: string }>(
    'POST',
    '/api/mcp/catalog/install',
    { name: server, env, enable: true },
  )
  if (!res.ok) {
    return {
      kind: 'done',
      outcome: {
        status: 'error',
        server,
        detail: res.status === 404 ? 'Your agent needs an update for this.' : res.error || 'Install failed.',
      },
    }
  }
  if (res.data?.background && res.data.action) {
    const sleep = opts.sleep ?? defaultSleep
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000)
    for (;;) {
      if (opts.cancelled?.()) return { kind: 'cancelled' }
      const st = await serveGet<{ running?: boolean; exit_code?: number | null }>(
        `/api/actions/${encodeURIComponent(res.data.action)}/status?lines=1`,
      )
      if (st && st.running === false) {
        if (st.exit_code !== 0 && st.exit_code != null) {
          return { kind: 'done', outcome: { status: 'error', server, detail: 'Install failed.' } }
        }
        break
      }
      if (Date.now() > deadline) {
        return { kind: 'done', outcome: { status: 'error', server, detail: 'Install is taking too long.' } }
      }
      await sleep(opts.pollMs ?? 1500)
    }
  }
  return { kind: 'done', outcome: { status: 'installed', server } }
}

async function authorize(server: string, opts: McpSetupOptions): Promise<McpSetupStep> {
  const started = await serveSend<OAuthSnapshot>('POST', `/api/mcp/servers/${encodeURIComponent(server)}/auth`)
  if (!started.ok || !started.data) {
    return {
      kind: 'done',
      outcome: {
        status: 'error',
        server,
        detail: started.status === 404 ? 'Your agent needs an update for this.' : started.error || 'Sign-in could not start.',
      },
    }
  }
  const snap = started.data
  if (snap.status === 'error') {
    return { kind: 'done', outcome: { status: 'error', server, detail: snap.error || 'Sign-in failed.' } }
  }
  if (snap.authorization_url) await opts.openUrl?.(snap.authorization_url)
  const flowId = snap.flow_id
  if (!flowId || snap.status === 'approved') {
    return { kind: 'done', outcome: { status: 'authorized', server, tools: toolNames(snap.tools) } }
  }
  const sleep = opts.sleep ?? defaultSleep
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000)
  const path = `/api/mcp/oauth/flows/${encodeURIComponent(flowId)}`
  for (;;) {
    if (opts.cancelled?.()) {
      void serveSend('DELETE', path).catch(() => {})
      return { kind: 'cancelled' }
    }
    await sleep(opts.pollMs ?? 2000)
    const cur = await serveGetDetailed<OAuthSnapshot>(path)
    if (cur.status === 404) {
      return { kind: 'done', outcome: { status: 'error', server, detail: 'Sign-in expired. Try again.' } }
    }
    const s = cur.data
    if (s?.status === 'approved') {
      return { kind: 'done', outcome: { status: 'authorized', server, tools: toolNames(s.tools) } }
    }
    if (s?.status === 'error') {
      return { kind: 'done', outcome: { status: 'error', server, detail: s.error || 'Sign-in failed.' } }
    }
    if (Date.now() > deadline) {
      void serveSend('DELETE', path).catch(() => {})
      return { kind: 'done', outcome: { status: 'error', server, detail: 'Sign-in timed out.' } }
    }
  }
}

export async function runMcpSetup(
  server: string,
  action: McpSetupAction,
  opts: McpSetupOptions = {},
): Promise<McpSetupStep> {
  try {
    if (action === 'enable') {
      const res = await mcpSetEnabled(server, true)
      return {
        kind: 'done',
        outcome: res.ok ? { status: 'enabled', server } : { status: 'error', server, detail: res.error || 'Could not turn it on.' },
      }
    }
    if (action === 'authorize') return await authorize(server, opts)
    return await install(server, opts)
  } catch (err) {
    return {
      kind: 'done',
      outcome: { status: 'error', server, detail: err instanceof Error ? err.message : 'Setup failed.' },
    }
  }
}
