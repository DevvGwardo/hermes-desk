'use strict'

/**
 * Dashboard route allowlist (defense in depth).
 *
 * The hermes dashboard exposes ~250 REST routes behind ONE token; a handful of
 * them can read or replace the platform LLM key, open a shell, or switch off
 * every safety setting. The app only ever needs the routes below, so every
 * dashboard call — Electron main (`vmRestHandle`, `dashboardRequest`,
 * `dashboardRaw`) and the renderer (`hermes-rest.ts` serve* + `vmDashboard`,
 * `vm-fs-http.ts` `vmDashboardJson`/`vmDashboardRaw`) — is checked against
 * this list. Anything else is refused with BLOCKED before a request is made.
 *
 * This file is the source of truth. `src/lib/dashboard-routes.ts` carries an
 * identical copy for the renderer (Vite cannot import CommonJS source);
 * `src/lib/__tests__/dashboard-routes.test.ts` fails if the two drift, and
 * `src/lib/__tests__/dashboard-routes-scan.test.ts` fails when code uses an
 * `/api/…` literal that is not registered here. The maiavm.com dashboard proxy
 * must enforce the same list server-side (docs/maiavm-proxy-hardening.md).
 *
 * Pattern syntax: literal segments; `:x` = exactly one non-empty segment;
 * `**` (last segment only) = zero or more further segments. Query strings are
 * ignored. Methods: array of verbs, or '*' for any.
 */

/** Routes the renderer may call (via nubVmRest, the maiavm proxy or local serve). */
/** @typedef {[string | string[], string][]} RouteList */
/** @type {RouteList} */
const DASHBOARD_ROUTES = [
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
/** @type {RouteList} */
const INTERNAL_ROUTES = [
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
/** @type {RouteList} */
const DASHBOARD_DENY = [
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
/** @type {RouteList} */
const PLATFORM_ROUTES = [
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

const BLOCKED_ERROR = 'blocked by Nub Agent'

function blockedResult() {
  return { ok: false, status: 403, error: BLOCKED_ERROR }
}

/**
 * Pathname of an `/api/…` request path, or null when it is not a safe,
 * canonical path (traversal, encoded separators/dots, backslashes, empty or
 * doubled segments, trailing slash).
 * @param {unknown} path
 */
function canonicalApiPath(path) {
  if (typeof path !== 'string' || path.length > 2000) return null
  const pathname = path.split(/[?#]/)[0]
  if (!pathname.startsWith('/api/')) return null
  if (/%2e|%2f|%5c|%00/i.test(pathname)) return null
  if (pathname.includes('\\') || pathname.includes('\0')) return null
  const segs = pathname.slice(1).split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null
  return pathname
}

/** @param {string} pattern @param {string} pathname */
function matchPattern(pattern, pathname) {
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

/** @param {string | string[]} methods @param {string} method */
function methodMatches(methods, method) {
  return methods === '*' || methods.includes(method)
}

/** @param {RouteList} list @param {string} method @param {string} pathname */
function inList(list, method, pathname) {
  return list.some(([methods, pattern]) => methodMatches(methods, method) && matchPattern(pattern, pathname))
}

/**
 * True when `method path` may be sent to the VM dashboard. `internal: true`
 * additionally admits the main-process-only file/preview routes.
 * @param {unknown} method
 * @param {unknown} path
 * @param {{ internal?: boolean }} [opts]
 */
function isDashboardRouteAllowed(method, path, opts) {
  const m = typeof method === 'string' ? method.toUpperCase() : ''
  const pathname = canonicalApiPath(path)
  if (!m || !pathname) return false
  if (inList(DASHBOARD_DENY, m, pathname)) return false
  if (inList(DASHBOARD_ROUTES, m, pathname)) return true
  return Boolean(opts && opts.internal) && inList(INTERNAL_ROUTES, m, pathname)
}

/** Path-only membership (any method) — used by the literal scan test.
 * @param {unknown} pathname
 */
function isKnownApiPath(pathname) {
  const p = canonicalApiPath(pathname)
  if (!p) return false
  const any = (/** @type {RouteList} */ list) => list.some(([, pattern]) => matchPattern(pattern, p))
  return any(DASHBOARD_ROUTES) || any(INTERNAL_ROUTES) || any(PLATFORM_ROUTES)
}

module.exports = {
  DASHBOARD_ROUTES,
  INTERNAL_ROUTES,
  DASHBOARD_DENY,
  PLATFORM_ROUTES,
  BLOCKED_ERROR,
  blockedResult,
  canonicalApiPath,
  matchPattern,
  isDashboardRouteAllowed,
  isKnownApiPath,
}
