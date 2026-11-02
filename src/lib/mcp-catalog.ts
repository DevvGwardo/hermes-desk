/**
 * Live MCP marketplace — hermes `GET /api/mcp/catalog` (Nous-approved
 * optional-mcps manifests) + `POST /api/mcp/catalog/install {name, env}`.
 *
 * When the agent predates the catalog route (404) the panel falls back to
 * the built-in presets (`mcp-presets.ts`). When the catalog is live, presets
 * it doesn't cover are kept only if they work on a hosted VM without a
 * platform-owned OAuth client (see KEEP_PRESETS_WITH_CATALOG).
 */

import { serveGetDetailed, serveSend } from './hermes-rest'
import type { McpPreset } from './mcp-presets'
import { waitForAction, type ActionOutcome, type WaitOptions } from './skills-hub'

export interface McpCatalogEnv {
  name: string
  prompt: string
  required: boolean
}

export interface McpCatalogEntry {
  name: string
  description: string
  source: string
  transport: string
  authType: 'oauth' | 'none' | 'api_key' | string
  requiredEnv: McpCatalogEnv[]
  url: string | null
  needsInstall: boolean
  installed: boolean
  enabled: boolean
  postInstall: string
}

export type McpCatalogResult =
  | { kind: 'ok'; entries: McpCatalogEntry[] }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

/** Catalog entries that can't work on a hosted VM (desktop app bridges). */
export const HIDDEN_CATALOG_ENTRIES: ReadonlySet<string> = new Set(['unreal-engine'])

/** Presets kept alongside a live catalog: no sign-in, run fine on the VM. */
export const KEEP_PRESETS_WITH_CATALOG: ReadonlySet<string> = new Set(['memory', 'sequential-thinking'])

function isLoopbackUrl(url: string | null): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

export function parseCatalogEntry(raw: unknown): McpCatalogEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (!name) return null
  const env = Array.isArray(o.required_env) ? o.required_env : []
  return {
    name,
    description: typeof o.description === 'string' ? o.description.trim() : '',
    source: typeof o.source === 'string' ? o.source : '',
    transport: typeof o.transport === 'string' ? o.transport : '',
    authType: typeof o.auth_type === 'string' ? o.auth_type : 'none',
    requiredEnv: env
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string')
      .map((e) => ({
        name: String(e.name),
        prompt: typeof e.prompt === 'string' && e.prompt ? e.prompt : String(e.name),
        required: e.required !== false,
      })),
    url: typeof o.url === 'string' && o.url ? o.url : null,
    needsInstall: o.needs_install === true,
    installed: o.installed === true,
    enabled: o.enabled === true,
    postInstall: typeof o.post_install === 'string' ? o.post_install : '',
  }
}

export function catalogEntryUsable(e: McpCatalogEntry): boolean {
  return !HIDDEN_CATALOG_ENTRIES.has(e.name) && !isLoopbackUrl(e.url)
}

export async function listMcpCatalog(): Promise<McpCatalogResult> {
  const res = await serveGetDetailed<{ entries?: unknown[] }>('/api/mcp/catalog')
  if (res.data && Array.isArray(res.data.entries)) {
    const entries = res.data.entries
      .map(parseCatalogEntry)
      .filter((e): e is McpCatalogEntry => e != null && catalogEntryUsable(e))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { kind: 'ok', entries }
  }
  if ((res.status ?? res.error?.status) === 404) return { kind: 'unsupported' }
  return { kind: 'error', message: res.error?.message || 'Couldn’t load the plugin catalog.' }
}

/** Keys never sent through the catalog installer, even when declared. */
const CATALOG_ENV_DENY: readonly RegExp[] = [
  // LLM providers: a catalog entry must never repoint or replace the platform model.
  /^(OPENAI|ANTHROPIC|OPENROUTER|GEMINI|GOOGLE|XAI|DEEPSEEK|NOUS|MISTRAL|GROQ|TOGETHER|FIREWORKS|AZURE_OPENAI|OLLAMA|LMSTUDIO|MINIMAX|KIMI|MOONSHOT|ZAI|GLM|QWEN|DASHSCOPE|CEREBRAS|BEDROCK|VERTEX|COPILOT|OPENCODE)_/,
  /^HERMES_/,
  /^TERMINAL_/,
  /^TOOL_GATEWAY_/,
  /^(PATH|HOME|SHELL|NODE_OPTIONS)$/,
  /^(LD|DYLD)_/,
  /^PYTHON/,
]

export function isCatalogEnvKeyDenied(key: string): boolean {
  return CATALOG_ENV_DENY.some((re) => re.test(key.trim().toUpperCase()))
}

export interface CatalogInstallResult {
  ok: boolean
  error?: string
  /** True when it ran as a background action (git clone + bootstrap). */
  background?: boolean
  outcome?: ActionOutcome
}

/**
 * Install one catalog entry. Only env keys the entry declares are sent
 * (hermes enforces the same), empty values are dropped.
 */
export async function installMcpCatalogEntry(
  entry: Pick<McpCatalogEntry, 'name' | 'requiredEnv'>,
  env: Record<string, string> = {},
  wait: WaitOptions = {},
): Promise<CatalogInstallResult> {
  const declared = new Set(entry.requiredEnv.map((e) => e.name))
  const body: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (!declared.has(k)) return { ok: false, error: `This plugin doesn’t use ${k}.` }
    if (isCatalogEnvKeyDenied(k)) return { ok: false, error: 'Nub Agent manages that setting for you.' }
    if (v.trim()) body[k] = v.trim()
  }
  const missing = entry.requiredEnv.filter((e) => e.required && !body[e.name])
  if (missing.length) return { ok: false, error: `Fill in: ${missing.map((m) => m.prompt).join(', ')}` }

  const res = await serveSend<{ ok?: boolean; background?: boolean; action?: string }>(
    'POST',
    '/api/mcp/catalog/install',
    { name: entry.name, env: body, enable: true },
  )
  if (!res.ok) {
    return { ok: false, error: res.status === 404 ? 'Your agent needs an update for this.' : res.error || 'Install failed on your agent.' }
  }
  if (res.data?.background && typeof res.data.action === 'string') {
    const outcome = await waitForAction(res.data.action, { timeoutMs: 600_000, ...wait })
    return {
      ok: outcome.ok,
      background: true,
      outcome,
      ...(outcome.ok ? {} : { error: outcome.timedOut ? 'Still installing — check back in a minute.' : 'Install failed on your agent.' }),
    }
  }
  return { ok: true, background: false }
}

// ---------------------------------------------------------------------------
// Marketplace list (catalog ∪ kept presets)
// ---------------------------------------------------------------------------

export interface McpMarketItem {
  id: string
  displayName: string
  description: string
  source: 'catalog' | 'preset'
  signIn: 'oauth' | 'key' | 'none'
  entry?: McpCatalogEntry
  preset?: McpPreset
}

/** "hugging_face" → "Hugging Face". */
export function catalogDisplayName(name: string): string {
  const special: Record<string, string> = {
    'aws-knowledge': 'AWS Knowledge',
    'microsoft-learn': 'Microsoft Learn',
    'prisma-postgres': 'Prisma Postgres',
    'wordpress-com': 'WordPress.com',
    gitlab: 'GitLab',
    circleci: 'CircleCI',
    deepwiki: 'DeepWiki',
    paypal: 'PayPal',
    n8n: 'n8n',
    clickup: 'ClickUp',
    motherduck: 'MotherDuck',
  }
  if (special[name]) return special[name]
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function marketItemsFromCatalog(entries: McpCatalogEntry[], presets: McpPreset[]): McpMarketItem[] {
  const items: McpMarketItem[] = entries.map((e) => ({
    id: e.name,
    displayName: catalogDisplayName(e.name),
    description: e.description,
    source: 'catalog',
    signIn: e.authType === 'oauth' ? 'oauth' : e.requiredEnv.length > 0 ? 'key' : 'none',
    entry: e,
  }))
  const have = new Set(items.map((i) => i.id.toLowerCase()))
  for (const p of presets) {
    if (have.has(p.id.toLowerCase()) || !KEEP_PRESETS_WITH_CATALOG.has(p.id)) continue
    items.push({
      id: p.id,
      displayName: p.displayName,
      description: p.description,
      source: 'preset',
      signIn: p.auth === 'oauth' ? 'oauth' : 'none',
      preset: p,
    })
  }
  return items
}

export function filterMarketItems(query: string, items: McpMarketItem[]): McpMarketItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((i) => [i.id, i.displayName, i.description].join(' ').toLowerCase().includes(q))
}
