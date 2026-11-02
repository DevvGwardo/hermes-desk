/**
 * MCP manager client — Grok Bot plugin-manager analogue on Hermes.
 *
 * Grok channels we map:
 *   mcp-list / mcp-catalog / mcp-install     → list + catalog install
 *   mcp-list-server-tools                    → POST /api/mcp/servers/{name}/test
 *   mcp-toggle-tool-disabled (server-level)  → PUT /api/mcp/servers/{name}/enabled
 *   mcp-auth                                 → POST /api/mcp/servers/{name}/auth
 *
 * Live servers come from the linked Maia VM (maiavm MCP + dashboard),
 * then local `hermes serve`, then the Electron `hermes mcp` CLI.
 * A linked VM never falls through to the Mac CLI.
 */

import { serveAuth, serveGet, servePost, servePut } from './hermes-rest'
import { serveTokenHeader } from './serve-bridge'
import { resolveNubApiConnection } from './maiavm-api'
import { hostMachinePhrase } from './host-label'

export interface HermesResult {
  ok: boolean
  code?: number
  data?: unknown
  error?: string
}

export interface McpServer {
  name: string
  status?: string
  type?: string
  transport?: string
  url?: string
  command?: string
  auth?: string
  enabled?: boolean
}

export interface McpTool {
  name: string
  description?: string
}

export interface McpListResult {
  servers: McpServer[]
  error?: string
}

/** maiavm.com returns the literal string "Unauthorized" when a desktop
 *  `nub_desk_…` bearer is ignored (cookie-only instance APIs). Marketplace
 *  catalog is local — this only blocks list/install on the VM. */
export function explainMcpControlPlaneError(raw?: string): string | undefined {
  if (!raw) return undefined
  const text = raw.trim()
  if (
    /^unauthorized$/i.test(text) ||
    /^http 401$/i.test(text)
  ) {
    return 'This Mac is not authorized to manage plugins on your agent. Re-link from Telegram, then tap Refresh.'
  }
  return raw
}

/**
 * Tools/Auth on a linked VM must never dump the Mac's `hermes mcp` roster
 * (`Server 'gmail' not found in config. Available: brain, chrome-data…`).
 * Gmail (and other marketplace remotes) live on the agent box.
 */
export function explainVmPluginActionError(raw?: string): string {
  const text = (raw || '').trim()
  if (/needs_auth|needs sign-in/i.test(text)) {
    return 'This plugin needs sign-in. Tap Auth, finish Google in the browser, then tap Tools again.'
  }
  if (
    !text ||
    text === 'dashboard_unreachable' ||
    /dashboard_unreachable|could not probe tools|ENOTFOUND|getaddrinfo|timed out|fetch failed/i.test(
      text,
    ) ||
    /not found in config/i.test(text)
  ) {
    return (
      `This plugin lives on the agent VM, not ${hostMachinePhrase()}. Tools and Auth talk to the agent over the ` +
      'link — if this still fails, the agent box is down. Ask the agent in chat, or tap Auth again.'
    )
  }
  return explainMcpControlPlaneError(text) || text
}

export interface McpAuthFlow {
  ok: boolean
  authorizationUrl?: string
  /** Dashboard OAuth flow id — poll `/api/mcp/oauth/flows/{id}` for completion. */
  flowId?: string
  /** Dashboard flow status at start (starting | authorization_required | approved | error). */
  status?: string
  /** Already signed in (maiavm path) — go straight to a tool probe. */
  alreadyAuthenticated?: boolean
  error?: string
}

/** Pull url / flow id / status out of either auth response shape. */
export function parseAuthStart(raw: unknown): McpAuthFlow {
  const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const url =
    (typeof d.authorization_url === 'string' && d.authorization_url) ||
    (typeof d.authorizationUrl === 'string' && d.authorizationUrl) ||
    (typeof d.url === 'string' && d.url) ||
    undefined
  const flowId = typeof d.flow_id === 'string' && d.flow_id ? d.flow_id : undefined
  const status = typeof d.status === 'string' ? d.status : undefined
  const err = typeof d.error === 'string' && d.error ? d.error : undefined
  if (status === 'error' || (err && !url && !flowId)) return { ok: false, error: err || 'Sign-in could not start.', flowId, status }
  return {
    ok: true,
    ...(url ? { authorizationUrl: url } : {}),
    ...(flowId ? { flowId } : {}),
    ...(status ? { status } : {}),
    ...(d.alreadyAuthenticated === true ? { alreadyAuthenticated: true } : {}),
  }
}

/** The `hermes(kind, args)` bridge — implemented by the desktop shell. */
type HermesBridge = (kind: string, args: string[]) => Promise<HermesResult>

function getBridge(): HermesBridge | null {
  const w = window as unknown as { nubAgent?: { hermes?: HermesBridge } }
  return w.nubAgent?.hermes ?? null
}

export const mcpAvailable = (): boolean => getBridge() != null || vmMcpBridge() != null

async function vmIsLinked(): Promise<boolean> {
  return Boolean(await resolveNubApiConnection())
}

/** TTL'd link cache — one open fires many mcp actions; the bridge is stable
 *  per open so don't re-resolve it on every call. */
let vmLinkedCache: { at: number; value: boolean } | null = null
const VM_LINK_TTL_MS = 30_000

/** Test-only: drop the link memo. */
export function __clearVmLinkCache(): void {
  vmLinkedCache = null
}

async function vmIsLinkedCached(): Promise<boolean> {
  if (vmLinkedCache && Date.now() - vmLinkedCache.at < VM_LINK_TTL_MS) {
    return vmLinkedCache.value
  }
  const value = await vmIsLinked()
  vmLinkedCache = { at: Date.now(), value }
  return value
}

/** Bounded wait — the loser of a serve/CLI race resolves null. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** How long open waits for serve before falling back to the CLI. */
const MCP_RACE_MS = 2500

export async function mcpExec(args: string[]): Promise<HermesResult> {
  const bridge = getBridge()
  if (!bridge) {
    return {
      ok: false,
      error:
        'MCP needs the desktop app (local Hermes bridge). Open Nub Agent via Electron, not a plain browser tab.',
    }
  }
  try {
    return await bridge('mcp', args)
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
}

/** Normalize whatever shape `hermes mcp list` returns into a server list.
 *  Defensive: accepts array | {servers:[]} | {items:[]} | {data:[]}. */
export function normalizeMcpServers(data: unknown): McpServer[] {
  if (Array.isArray(data)) {
    return (data as unknown[]).map(serverFrom)
  }
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    for (const k of ['servers', 'items', 'data', 'results']) {
      const v = o[k]
      if (Array.isArray(v)) return (v as unknown[]).map(serverFrom)
    }
    const out: McpServer[] = []
    for (const key of Object.keys(o)) {
      const val = o[key]
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const rec = val as Record<string, unknown>
        if (
          typeof rec.type === 'string' ||
          typeof rec.status === 'string' ||
          typeof rec.url === 'string' ||
          typeof rec.transport === 'string'
        ) {
          out.push(serverFrom({ name: key, ...rec }))
        }
      }
    }
    if (out.length > 0) return out
  }
  return []
}

export function serverFrom(raw: unknown): McpServer {
  if (typeof raw === 'string') return { name: raw }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    const name = (r.name ?? r.id ?? r.title ?? r.key) as string | undefined
    const enabled = r.enabled
    return {
      name: name ?? 'unknown',
      status: r.status ? String(r.status) : undefined,
      type: r.type ? String(r.type) : r.transport ? String(r.transport) : undefined,
      transport: r.transport ? String(r.transport) : undefined,
      url: typeof r.url === 'string' && r.url.trim() ? r.url.trim() : undefined,
      command: typeof r.command === 'string' && r.command.trim() ? r.command.trim() : undefined,
      auth: r.auth ? String(r.auth) : undefined,
      enabled: typeof enabled === 'boolean' ? enabled : undefined,
    }
  }
  return { name: 'unknown' }
}

/** `hermes mcp list` → live MCP servers (name + status). */
export async function mcpList(): Promise<McpListResult> {
  const res = await mcpExec(['list'])
  if (!res.ok) return { servers: [], error: res.error ?? `mcp list failed (${res.code})` }
  return { servers: normalizeMcpServers(res.data) }
}

/**
 * Prefer the linked Nub VM (writes /opt/data/config.yaml via maiavm),
 * then serve REST, then the local `hermes mcp` CLI.
 * Grok `sand:mcp-list`.
 */
export async function mcpListServers(): Promise<McpListResult> {
  const vm = await vmMcp('list')
  if (vm?.ok) {
    return { servers: normalizeMcpServers(vm.data) }
  }
  if (vm && vm.error && vm.error !== 'not_linked') {
    return { servers: [], error: explainMcpControlPlaneError(vm.error) }
  }
  if (await vmIsLinkedCached()) {
    return {
      servers: [],
      error: explainMcpControlPlaneError(vm?.error) || 'could not list plugins on the linked VM',
    }
  }
  // Serve answers inside the budget, otherwise the CLI snapshot is
  // authoritative. The CLI spawns a process, so it only starts once serve
  // has failed or run out of time.
  const data = await withTimeout(serveGet<{ servers?: unknown[] }>('/api/mcp/servers'), MCP_RACE_MS)
  if (data && Array.isArray(data.servers)) {
    return { servers: data.servers.map(serverFrom) }
  }
  return mcpList()
}

export async function mcpSetEnabled(
  name: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const n = name.trim()
  if (!n) return { ok: false, error: 'server name is required' }
  const vm = await vmMcp('toggle', { name: n, enabled })
  if (vm?.ok) return { ok: true }
  if (vm && vm.error && vm.error !== 'not_linked') {
    return { ok: false, error: explainMcpControlPlaneError(vm.error) }
  }
  if (await vmIsLinkedCached()) {
    return {
      ok: false,
      error: explainMcpControlPlaneError(vm?.error) || 'enable/disable needs the linked VM',
    }
  }
  const res = await servePut<{ ok?: boolean }>(
    `/api/mcp/servers/${encodeURIComponent(n)}/enabled`,
    { enabled },
  )
  if (!res) return { ok: false, error: 'enable/disable needs hermes serve or a linked VM' }
  return { ok: true }
}

export async function mcpStartAuth(name: string): Promise<McpAuthFlow> {
  const n = name.trim()
  if (!n) return { ok: false, error: 'server name is required' }
  const vm = await vmMcp('auth', { name: n })
  if (vm?.ok) return parseAuthStart(vm.data)
  if (await vmIsLinkedCached()) {
    return { ok: false, error: explainVmPluginActionError(vm?.error) }
  }
  const res = await servePost<Record<string, unknown>>(
    `/api/mcp/servers/${encodeURIComponent(n)}/auth`,
  )
  if (!res) return { ok: false, error: 'MCP auth needs hermes serve or a linked VM' }
  return parseAuthStart(res)
}

export async function mcpListServerTools(
  name: string,
): Promise<{ ok: boolean; tools: McpTool[]; error?: string }> {
  const n = name.trim()
  if (!n) return { ok: false, tools: [], error: 'server name is required' }
  const vm = await vmMcp('test', { name: n })
  if (vm?.ok) {
    return parseToolProbe(vm.data)
  }
  if (await vmIsLinkedCached()) {
    return {
      ok: false,
      tools: [],
      error: explainVmPluginActionError(vm?.error),
    }
  }
  const res = await servePost<{ ok?: boolean; tools?: unknown[]; error?: string }>(
    `/api/mcp/servers/${encodeURIComponent(n)}/test`,
  )
  if (res) {
    const parsed = parseToolProbe(res)
    if (res.ok === false) return { ok: false, tools: parsed.tools, error: res.error ?? 'probe failed' }
    return parsed
  }
  const cli = await mcpTestServer(n)
  if (!cli.ok) return { ok: false, tools: [], error: cli.error }
  return { ok: true, tools: [] }
}

function parseToolProbe(raw: unknown): { ok: boolean; tools: McpTool[]; error?: string } {
  const res = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const list = Array.isArray(res.tools) ? res.tools : []
  const tools = list
    .map((t) => {
      if (typeof t === 'string') return { name: t }
      if (t && typeof t === 'object') {
        const rec = t as Record<string, unknown>
        const tn = typeof rec.name === 'string' ? rec.name : ''
        if (!tn) return null
        return {
          name: tn,
          description: typeof rec.description === 'string' ? rec.description : undefined,
        }
      }
      return null
    })
    .filter((t): t is McpTool => t != null)
  return { ok: true, tools }
}

export interface McpAddOpts {
  /** HTTP/SSE endpoint (--url). Mutually exclusive with command. */
  url?: string
  /** Stdio command, e.g. `npx` (--command). Mutually exclusive with url. */
  command?: string
  /** Extra args for a stdio command (--args); must be appended last. */
  args?: string
  /** Known preset name (--preset). */
  preset?: string
  /** Persist OAuth on HTTP servers (non-interactive; no CLI prompts). */
  auth?: 'oauth' | 'header'
  /** API key sent as `Authorization: Bearer …` (HTTP servers; hermes `bearer_token`). */
  bearerToken?: string
  /** KEY=VALUE environment for stdio servers (hermes `env`). */
  env?: Record<string, string>
}

/** Env keys never passed to a plugin process (loader / interpreter / agent internals). */
const MCP_ENV_DENY: readonly RegExp[] = [/^PATH$/, /^LD_/, /^DYLD_/, /^PYTHON/, /^NODE_OPTIONS$/, /^HERMES_/, /^TERMINAL_/]

export function isMcpEnvKeyDenied(key: string): boolean {
  return MCP_ENV_DENY.some((re) => re.test(key.trim().toUpperCase()))
}

/**
 * Parse the "Environment variables" box: one KEY=VALUE per line (blank lines
 * and `#` comments ignored). Values may contain `=`.
 */
export function parseMcpEnvText(text: string): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
  const env: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) return { ok: false, error: `Use KEY=VALUE on each line (“${line.slice(0, 24)}”)` }
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { ok: false, error: `“${key}” isn’t a valid variable name` }
    if (isMcpEnvKeyDenied(key)) return { ok: false, error: `${key} can’t be set for a plugin` }
    env[key] = value
  }
  return { ok: true, env }
}

/**
 * hermes `MCPServerCreate` body (web_models.py): URL servers take
 * `auth: header` + `bearer_token` (or `auth: oauth`); stdio servers take
 * `args` + `env`. Mixing the two is a 400 upstream, so it's refused here.
 */
export function buildMcpCreateBody(
  name: string,
  opts: McpAddOpts,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const url = opts.url?.trim()
  const command = opts.command?.trim()
  const token = opts.bearerToken?.trim().replace(/^bearer\s+/i, '')
  const env = opts.env && Object.keys(opts.env).length ? opts.env : undefined
  const body: Record<string, unknown> = { name }
  if (url) {
    if (env) return { ok: false, error: 'Environment variables only apply to command-based plugins.' }
    body.url = url
    if (token) {
      body.auth = 'header'
      body.bearer_token = token
    } else if (opts.auth === 'oauth') body.auth = 'oauth'
    return { ok: true, body }
  }
  if (command) {
    if (token) return { ok: false, error: 'An API key header only applies to URL plugins — use environment variables instead.' }
    body.command = command
    const argList = splitMcpArgs(opts.args)
    if (argList.length) body.args = argList
    if (env) body.env = env
    return { ok: true, body }
  }
  return { ok: false, error: 'provide a url or command' }
}

/** Split a marketplace args string into CLI/REST argv tokens. */
export function splitMcpArgs(raw: string | undefined): string[] {
  return (raw ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

type VmMcpVerb = 'list' | 'add' | 'remove' | 'toggle' | 'auth' | 'test'

interface VmMcpPayload {
  name?: string
  url?: string
  command?: string
  args?: string
  auth?: string
  enabled?: boolean
  /** Stdio env (KEY → value). */
  env?: Record<string, string>
  /** HTTP bearer token (sent once; hermes stores it in the agent's .env). */
  bearer_token?: string
}

function vmMcpBridge():
  | ((verb: string, payload?: VmMcpPayload) => Promise<{ ok: boolean; data?: unknown; error?: string }>)
  | null {
  const w = window as unknown as {
    nubAgent?: {
      nubVmMcp?: (
        verb: string,
        payload?: VmMcpPayload,
      ) => Promise<{ ok: boolean; data?: unknown; error?: string }>
    }
  }
  return w.nubAgent?.nubVmMcp ?? null
}

async function vmMcp(
  verb: VmMcpVerb,
  payload?: VmMcpPayload,
): Promise<{ ok: boolean; data?: unknown; error?: string } | null> {
  const fn = vmMcpBridge()
  if (!fn) return null
  try {
    return await fn(verb, payload)
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
}

/** Serve mutations that may still land after we stop waiting. */
const SERVE_MUTATE_TIMEOUT_MS = 30_000

type ServeMutateResult<T> = {
  ok: boolean
  data?: T
  error?: string
  /** Serve answered and refused (validation, conflict), or may have applied
   *  the write after timing out. A CLI retry would double-write or bypass it. */
  final?: boolean
}

async function serveMutate<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<ServeMutateResult<T>> {
  const auth = await serveAuth()
  if (!auth) return { ok: false, error: 'hermes serve is not configured' }
  try {
    const res = await fetch(`${auth.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...serveTokenHeader(auth.token),
      },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(SERVE_MUTATE_TIMEOUT_MS) : undefined,
    })
    const text = await res.text().catch(() => '')
    let json: T | undefined
    try {
      json = text ? (JSON.parse(text) as T) : undefined
    } catch {
      json = undefined
    }
    if (!res.ok) {
      const errObj = json && typeof json === 'object' ? (json as { error?: string; detail?: string }) : null
      return {
        ok: false,
        error: errObj?.error || errObj?.detail || text.slice(0, 240) || `HTTP ${res.status}`,
        final: res.status === 400 || res.status === 409 || res.status === 422,
      }
    }
    return { ok: true, data: json }
  } catch (err) {
    if ((err as Error)?.name === 'TimeoutError') {
      return { ok: false, final: true, error: 'Hermes did not answer in time. Check the plugin list before trying again.' }
    }
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
}

/**
 * `hermes mcp add <name> [--url URL] [--command CMD] [--args ...] [--preset P]`.
 * Linked VMs write the agent box via Nub (`custom-http` job). Local serve REST
 * is next; the CLI is last and must stay non-interactive (`--auth`).
 */
export async function mcpAddServer(
  name: string,
  opts: McpAddOpts = {},
): Promise<{ ok: boolean; error?: string }> {
  const n = name.trim()
  if (!n) return { ok: false, error: 'server name is required' }
  const url = opts.url?.trim()
  const command = opts.command?.trim()
  const argList = splitMcpArgs(opts.args)
  if (!url && !command && !opts.preset?.trim()) {
    return { ok: false, error: 'provide a --url, a --command, or a --preset' }
  }
  const built = url || command ? buildMcpCreateBody(n, opts) : null
  if (built && !built.ok) return { ok: false, error: built.error }
  const token = built?.ok && typeof built.body.bearer_token === 'string' ? built.body.bearer_token : ''
  const env = opts.env && Object.keys(opts.env).length ? opts.env : undefined

  const vm = await vmMcp('add', {
    name: n,
    url,
    command,
    args: opts.args,
    auth: token ? 'header' : opts.auth,
    ...(env ? { env } : {}),
    ...(token ? { bearer_token: token } : {}),
  })
  if (vm?.ok) return { ok: true }
  if (vm && vm.error && vm.error !== 'not_linked') {
    return { ok: false, error: explainMcpControlPlaneError(vm.error) }
  }
  if (await vmIsLinkedCached()) {
    return {
      ok: false,
      error: explainMcpControlPlaneError(vm?.error) || 'could not add this plugin on the linked VM',
    }
  }

  const body: Record<string, unknown> = built?.ok ? built.body : { name: n }
  const posted = await serveMutate('POST', '/api/mcp/servers', body)
  if (posted.ok) return { ok: true }
  if (posted.final) return { ok: false, error: posted.error }
  // The CLI can't take a bearer token non-interactively.
  if (token) return { ok: false, error: posted.error || 'API-key plugins need your agent’s dashboard.' }

  const args = ['add', n]
  if (url) {
    args.push('--url', url)
    if (opts.auth) args.push('--auth', opts.auth)
  } else if (command) {
    args.push('--command', command)
    if (env) args.push('--env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`))
    if (argList.length) args.push('--args', ...argList)
  } else if (opts.preset?.trim()) {
    args.push('--preset', opts.preset.trim())
  }
  const res = await mcpExec(args)
  if (!res.ok) {
    return {
      ok: false,
      error: posted.error || res.error || `mcp add failed (${res.code})`,
    }
  }
  return { ok: true }
}

/** `hermes mcp remove <name>` — removes the named server. */
export async function mcpRemoveServer(
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  const n = name.trim()
  if (!n) return { ok: false, error: 'server name is required' }
  const vm = await vmMcp('remove', { name: n })
  if (vm?.ok) return { ok: true }
  if (await vmIsLinkedCached()) {
    return {
      ok: false,
      error:
        explainMcpControlPlaneError(vm?.error) || 'could not remove this plugin on the linked VM',
    }
  }
  const del = await serveMutate('DELETE', `/api/mcp/servers/${encodeURIComponent(n)}`)
  if (del.ok) return { ok: true }
  if (del.final) return { ok: false, error: del.error }
  const res = await mcpExec(['remove', n])
  if (!res.ok) return { ok: false, error: vm?.error || del.error || res.error || `mcp remove failed (${res.code})` }
  return { ok: true }
}

/** Local `hermes mcp test` — Mac config only. Never call this when a VM is linked. */
export async function mcpTestServer(
  name: string,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  if (await vmIsLinkedCached()) {
    return { ok: false, error: explainVmPluginActionError() }
  }
  const res = await mcpExec(['test', name])
  if (!res.ok) {
    return { ok: false, error: res.error ?? `mcp test failed (${res.code})` }
  }
  const output = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  return { ok: true, output }
}
