/**
 * Renderer copy of electron/dashboard-routes.cjs (the source of truth — read
 * its header). Vite cannot import CommonJS source, so the lists are
 * duplicated; src/lib/__tests__/dashboard-routes.test.ts asserts both files
 * hold identical lists and identical decisions. Edit BOTH when adding a route.
 */

export type RouteMethods = readonly string[] | '*'
export type RouteRule = readonly [RouteMethods, string]

/** Routes the renderer may call (via nubVmRest, the maiavm proxy or local serve). */
export const DASHBOARD_ROUTES: readonly RouteRule[] = [
  // Health / status / stats
  [['GET'], '/api/status'],
  [['GET'], '/api/health'],
  [['GET'], '/api/system/stats'],
  [['GET'], '/api/analytics/usage'],
  [['GET'], '/api/logs'],
  [['GET'], '/api/hermes/update/check'],
  [['GET'], '/api/actions/:x/status'],
  // Config (writes are key-allowlisted in src/lib/agent-config.ts)
  [['GET', 'PUT'], '/api/config'],
  // Env (writes are key-allowlisted in src/lib/messaging.ts)
  [['GET', 'PUT', 'DELETE'], '/api/env'],
  // Chat websocket (hermes serve JSON-RPC)
  [['GET'], '/api/ws'],
  // Skills
  [['GET', 'POST'], '/api/skills'],
  [['PUT'], '/api/skills/toggle'],
  [['GET'], '/api/skills/content'],
  [['GET'], '/api/skills/hub/official'],
  [['GET'], '/api/skills/hub/search'],
  [['GET'], '/api/skills/hub/preview'],
  [['GET'], '/api/skills/hub/scan'],
  [['POST'], '/api/skills/hub/install'],
  [['POST'], '/api/skills/hub/uninstall'],
  [['POST'], '/api/skills/hub/update'],
  // Routines (cron)
  [['GET', 'POST'], '/api/cron/jobs'],
  [['GET', 'PUT', 'DELETE'], '/api/cron/jobs/:x'],
  [['POST'], '/api/cron/jobs/:x/pause'],
  [['POST'], '/api/cron/jobs/:x/resume'],
  [['POST'], '/api/cron/jobs/:x/trigger'],
  [['GET'], '/api/cron/jobs/:x/runs'],
  [['GET'], '/api/cron/delivery-targets'],
  [['GET'], '/api/cron/blueprints'],
  [['POST'], '/api/cron/blueprints/instantiate'],
  // Memory
  [['GET'], '/api/memory'],
  [['GET'], '/api/memory/pending'],
  [['POST'], '/api/memory/pending/:x/approve'],
  [['POST'], '/api/memory/pending/:x/reject'],
  [['POST'], '/api/memory/reset'],
  [['PUT'], '/api/memory/provider'],
  [['GET', 'PUT'], '/api/memory/providers/:x/config'],
  [['POST'], '/api/memory/providers/:x/setup'],
  [['POST'], '/api/memory/providers/:x/oauth/start'],
  [['GET'], '/api/memory/providers/:x/oauth/status'],
  // MCP
  [['GET', 'POST'], '/api/mcp/servers'],
  [['DELETE'], '/api/mcp/servers/:x'],
  [['POST'], '/api/mcp/servers/:x/test'],
  [['POST'], '/api/mcp/servers/:x/auth'],
  [['PUT'], '/api/mcp/servers/:x/enabled'],
  [['GET'], '/api/mcp/catalog'],
  [['POST'], '/api/mcp/catalog/install'],
  [['GET', 'DELETE'], '/api/mcp/oauth/flows/:x'],
  // Messaging
  [['GET'], '/api/messaging/platforms'],
  [['PUT'], '/api/messaging/platforms/:x'],
  [['POST'], '/api/messaging/platforms/:x/test'],
  [['GET', 'POST', 'DELETE'], '/api/messaging/telegram/onboarding/**'],
  [['GET', 'POST', 'DELETE'], '/api/messaging/whatsapp/onboarding/**'],
  [['GET'], '/api/pairing'],
  [['POST'], '/api/pairing/approve'],
  [['POST'], '/api/pairing/revoke'],
  [['POST'], '/api/pairing/clear-pending'],
  [['POST'], '/api/pairing/deny'],
  [['POST'], '/api/gateway/restart'],
  [['POST'], '/api/gateway/start'],
  [['POST'], '/api/gateway/stop'],
  // Agents (profiles)
  [['GET', 'POST'], '/api/profiles'],
  [['PATCH', 'DELETE'], '/api/profiles/:x'],
  [['GET', 'PUT'], '/api/profiles/:x/soul'],
  [['PUT'], '/api/profiles/:x/description'],
  // Chat history
  [['GET'], '/api/sessions'],
  [['GET'], '/api/sessions/search'],
  [['GET', 'PATCH', 'DELETE'], '/api/sessions/:x'],
  [['GET'], '/api/sessions/:x/messages'],
  [['GET'], '/api/sessions/:x/mutation-snapshot'],
  [['GET'], '/api/sessions/:x/export'],
  // Tools
  [['GET'], '/api/tools/toolsets'],
  [['PUT'], '/api/tools/toolsets/:x'],
  [['GET'], '/api/tools/toolsets/:x/config'],
  [['PUT'], '/api/tools/toolsets/:x/env'],
  [['GET'], '/api/tools/computer-use/status'],
  [['GET'], '/api/computer/status'],
  [['GET'], '/api/computer/screenshot'],
  // Tasks board plugin
  [['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], '/api/plugins/kanban/**'],
  // Troubleshooting
  [['POST'], '/api/ops/doctor'],
  [['POST'], '/api/ops/security-audit'],
  // Nub dashboard extensions
  [['GET'], '/api/transcripts/tail'],
  [['GET'], '/api/notifications'],
  [['POST'], '/api/notifications/read'],
  [['GET', 'POST', 'DELETE'], '/api/instances/:x/resize'],
  [['GET', 'POST', 'DELETE'], '/api/instances/:x/browser/jobs/**'],
]

/**
 * Main-process-only routes: file access and previews. Paths are validated by
 * nub-link's vmPath() before they get here, and writes prefer the maiavm fs
 * remap. The renderer can never reach these through nubVmRest.
 */
export const INTERNAL_ROUTES: readonly RouteRule[] = [
  [['GET'], '/api/fs/list'],
  [['GET'], '/api/fs/read-text'],
  [['GET'], '/api/fs/read-data-url'],
  [['GET'], '/api/fs/default-cwd'],
  [['GET'], '/api/fs/root'],
  [['GET'], '/api/fs/git-root'],
  [['POST'], '/api/fs/write-text'],
  [['POST'], '/api/files/upload'],
  [['GET'], '/api/preview/**'],
]

/**
 * Never callable, even if someone adds a matching allow entry later. Checked
 * before the allowlist.
 */
export const DASHBOARD_DENY: readonly RouteRule[] = [
  ['*', '/api/env/reveal'],
  ['*', '/api/config/raw'],
  ['*', '/api/model/**'],
  ['*', '/api/providers/**'],
  ['*', '/api/credentials/**'],
  ['*', '/api/tools/terminal/**'],
  ['*', '/api/tools/toolsets/:x/post-setup'],
  ['*', '/api/tools/toolsets/:x/provider'],
  ['*', '/api/tools/toolsets/:x/model'],
  ['*', '/api/tools/toolsets/:x/models'],
  ['*', '/api/ops/hooks'],
  ['*', '/api/ops/import'],
  // Red team sweep 3 (M-1): the backup zip holds every secret on the VM and
  // import-upload runs `hermes import --force` past the config key allowlist.
  ['*', '/api/ops/backup'],
  ['*', '/api/ops/backup/**'],
  ['*', '/api/ops/import-upload'],
  ['*', '/api/ops/debug-share'],
  ['*', '/api/ops/config-migrate'],
  ['*', '/api/ops/dump'],
  [['POST'], '/api/hermes/update'],
  ['*', '/api/dashboard/agent-plugins/**'],
  ['*', '/api/local-models/**'],
  ['*', '/api/profiles/:x/open-terminal'],
  ['*', '/api/pty'],
  ['*', '/api/console'],
]

/**
 * maiavm.com's own platform API (served by www.maiavm.com, never forwarded
 * to the VM dashboard). Listed so the literal scan can tell them apart.
 */
export const PLATFORM_ROUTES: readonly RouteRule[] = [
  ['*', '/api/instances/**'],
  ['*', '/api/nub/**'],
  ['*', '/api/usage/resets'],
  ['*', '/api/link-preview'],
  ['*', '/api/llm/usage'],
  ['*', '/api/chat/**'],
  ['*', '/api/invite/**'],
  ['*', '/api/skills'],
  // Settings → Account / Billing / API keys (src/lib/platform-account.ts)
  ['*', '/api/profile'],
  ['*', '/api/billing/overview'],
  ['*', '/api/billing/portal'],
  ['*', '/api/billing/recover'],
  ['*', '/api/llm/keys'],
  ['*', '/api/llm/keys/:x'],
  // Quickstart curl text shown in the keys pane (never fetched by the app)
  ['*', '/api/v1/chat/completions'],
]

export const BLOCKED_ERROR = 'blocked by Nub Agent'

export function blockedResult(): { ok: false; status: 403; error: string } {
  return { ok: false, status: 403, error: BLOCKED_ERROR }
}

/**
 * Pathname of an `/api/…` request path, or null when it is not a safe,
 * canonical path (traversal, encoded separators/dots, backslashes, empty or
 * doubled segments, trailing slash).
 */
export function canonicalApiPath(path: unknown): string | null {
  if (typeof path !== 'string' || path.length > 2000) return null
  const pathname = path.split(/[?#]/)[0]
  if (!pathname.startsWith('/api/')) return null
  if (/%2e|%2f|%5c|%00/i.test(pathname)) return null
  if (pathname.includes('\\') || pathname.includes('\0')) return null
  const segs = pathname.slice(1).split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null
  return pathname
}

export function matchPattern(pattern: string, pathname: string): boolean {
  const pat = pattern.slice(1).split('/')
  const segs = pathname.slice(1).split('/')
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]
    if (p === '**') return i === pat.length - 1 && segs.length >= i
    if (i >= segs.length) return false
    if (p === ':x') continue
    if (p !== segs[i]) return false
  }
  return segs.length === pat.length
}

function methodMatches(methods: RouteMethods, method: string): boolean {
  return methods === '*' || methods.includes(method)
}

function inList(list: readonly RouteRule[], method: string, pathname: string): boolean {
  return list.some(([methods, pattern]) => methodMatches(methods, method) && matchPattern(pattern, pathname))
}

/**
 * True when `method path` may be sent to the VM dashboard. `internal: true`
 * additionally admits the main-process-only file/preview routes.
 */
export function isDashboardRouteAllowed(
  method: unknown,
  path: unknown,
  opts?: { internal?: boolean },
): boolean {
  const m = typeof method === 'string' ? method.toUpperCase() : ''
  const pathname = canonicalApiPath(path)
  if (!m || !pathname) return false
  if (inList(DASHBOARD_DENY, m, pathname)) return false
  if (inList(DASHBOARD_ROUTES, m, pathname)) return true
  return Boolean(opts?.internal) && inList(INTERNAL_ROUTES, m, pathname)
}

/** Path-only membership (any method) — used by the literal scan test. */
export function isKnownApiPath(pathname: string): boolean {
  const p = canonicalApiPath(pathname)
  if (!p) return false
  const any = (list: readonly RouteRule[]) => list.some(([, pattern]) => matchPattern(pattern, p))
  return any(DASHBOARD_ROUTES) || any(INTERNAL_ROUTES) || any(PLATFORM_ROUTES)
}
