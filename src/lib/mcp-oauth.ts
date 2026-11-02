/**
 * MCP OAuth completion.
 *
 * Dashboard flows (`POST /api/mcp/servers/{name}/auth` → `{flow_id, status,
 * authorization_url}`) are polled at `GET /api/mcp/oauth/flows/{flow_id}`
 * until `approved` / `error`; a user cancel sends `DELETE` on the same path
 * (frees the per-server slot so a retry doesn't 409).
 *
 * The desktop's maiavm path (Electron relays the loopback callback itself)
 * returns no flow id — there we poll the tool probe until it succeeds.
 */

import { serveGetDetailed, serveSend } from './hermes-rest'
import { mcpListServerTools, type McpTool } from './mcp'

export type McpOAuthState = 'starting' | 'authorization_required' | 'approved' | 'error' | 'expired' | 'timeout' | 'cancelled'

export interface McpOAuthFlowSnapshot {
  status: McpOAuthState | string
  error?: string
  tools: McpTool[]
}

export function parseFlowSnapshot(raw: unknown): McpOAuthFlowSnapshot {
  const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const tools = Array.isArray(d.tools)
    ? d.tools
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string')
        .map((t) => ({ name: String(t.name), ...(typeof t.description === 'string' ? { description: t.description } : {}) }))
    : []
  return {
    status: typeof d.status === 'string' ? d.status : 'starting',
    ...(typeof d.error === 'string' && d.error ? { error: d.error } : {}),
    tools,
  }
}

export async function getMcpOAuthFlow(flowId: string): Promise<McpOAuthFlowSnapshot | null> {
  const res = await serveGetDetailed<unknown>(`/api/mcp/oauth/flows/${encodeURIComponent(flowId)}`)
  if (res.data) return parseFlowSnapshot(res.data)
  if ((res.status ?? res.error?.status) === 404) return { status: 'expired', tools: [] }
  return null
}

export async function cancelMcpOAuthFlow(flowId: string): Promise<boolean> {
  const res = await serveSend('DELETE', `/api/mcp/oauth/flows/${encodeURIComponent(flowId)}`)
  return res.ok
}

export interface PollOptions {
  intervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
  onUpdate?: (s: McpOAuthFlowSnapshot) => void
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const TERMINAL = new Set(['approved', 'error', 'expired'])

/** Poll a dashboard flow until it settles (or times out / is aborted). */
export async function waitForMcpOAuth(flowId: string, opts: PollOptions = {}): Promise<McpOAuthFlowSnapshot> {
  const interval = opts.intervalMs ?? 2000
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000)
  const sleep = opts.sleep ?? defaultSleep
  let misses = 0
  for (;;) {
    if (opts.signal?.aborted) return { status: 'cancelled', tools: [] }
    const snap = await getMcpOAuthFlow(flowId)
    if (snap) {
      misses = 0
      opts.onUpdate?.(snap)
      if (TERMINAL.has(snap.status)) return snap
    } else if (++misses >= 5) {
      return { status: 'error', error: 'Lost contact with your agent during sign-in.', tools: [] }
    }
    if (Date.now() >= deadline) return { status: 'timeout', tools: [] }
    await sleep(interval)
    if (opts.signal?.aborted) return { status: 'cancelled', tools: [] }
  }
}

/**
 * No flow id (desktop maiavm relay): the callback lands via Electron, so
 * "done" = the tool probe succeeds. Polls until ok / timeout / abort.
 */
export async function waitForMcpToolsReady(
  name: string,
  opts: Omit<PollOptions, 'onUpdate'> = {},
): Promise<{ ok: boolean; tools: McpTool[]; cancelled?: boolean }> {
  const interval = opts.intervalMs ?? 4000
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000)
  const sleep = opts.sleep ?? defaultSleep
  for (;;) {
    if (opts.signal?.aborted) return { ok: false, tools: [], cancelled: true }
    const probe = await mcpListServerTools(name)
    if (probe.ok) return { ok: true, tools: probe.tools }
    if (Date.now() >= deadline) return { ok: false, tools: [] }
    await sleep(interval)
  }
}

/** Plain status line for the plugin row. */
export function oauthStateLabel(state: string): string {
  switch (state) {
    case 'starting':
      return 'Starting sign-in…'
    case 'authorization_required':
      return 'Waiting for you to finish signing in…'
    case 'approved':
      return 'Signed in'
    case 'expired':
      return 'Sign-in expired — try again'
    case 'timeout':
      return 'Sign-in took too long — try again'
    case 'cancelled':
      return 'Sign-in cancelled'
    default:
      return 'Sign-in failed'
  }
}
