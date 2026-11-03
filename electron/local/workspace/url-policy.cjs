'use strict'

const net = require('node:net')
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const LANE_RE = /^(?:you|profile:[a-z0-9][a-z0-9_-]{0,63})$/
const TAB_RE = /^t_[a-z0-9]+$/
const DEFAULT_SEARCH = 'https://www.google.com/search?q={query}'

/**
 * @typedef {object} AgentUrlRules
 * @property {unknown} [deny]
 * @property {unknown} [denyList]
 * @property {unknown} [allow]
 * @property {unknown} [allowList]
 */
/**
 * Workspace URL policy configuration. Collection fields arrive from workspace
 * config JSON; rule values stay unknown until validated against the schema.
 * @typedef {object} UrlPolicyConfig
 * @property {Array<unknown>} [servePorts]
 * @property {Array<unknown>} [appOrigins]
 * @property {() => Array<unknown>} [getAppOrigins]
 * @property {() => {agents?: Record<string, AgentUrlRules>}} [getWorkspaceConfig]
 * @property {Record<string, AgentUrlRules>} [agents]
 * @property {unknown} [searchEngine]
 * @property {boolean} [e2eLoopback] Only the isolated E2E harness sets this.
 */
/**
 * @typedef {object} PolicyContext
 * @property {string} [laneKind]
 * @property {Array<unknown>} [servePorts]
 * @property {Array<unknown>} [appOrigins]
 * @property {unknown} [profile]
 * @property {unknown} [laneId]
 */

/**
 * @param {unknown} raw
 * @returns {URL | null}
 */
function parseHttp(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 16384 || /[\u0000-\u001f\u007f]/.test(raw)) {
    return null
  }
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

/**
 * @param {unknown} hostname
 * @returns {boolean}
 */
function isLoopback(hostname) {
  // WHATWG parsing canonicalizes IPv4 decimal/octal/hex and IPv6 spellings.
  let host
  try { host = new URL(`http://${hostname}/`).hostname.toLowerCase().replace(/\.$/, '') } catch { return false }
  return host === 'localhost' || host.endsWith('.localhost') ||
    /^127\./.test(host) || host === '0.0.0.0' || host === '[::]' || host === '[::1]' ||
    /^\[::(?:ffff:)?(?:7f[0-9a-f]{2}:[0-9a-f]+|0:0|0:1)\]$/.test(host)
}

// Deliberately conservative global-unicast policy. Never use this as a DNS
// preflight: the egress proxy also applies it to *all* answers and dials the
// selected literal, without a second hostname lookup.
/**
 * @param {unknown} address
 * @returns {boolean}
 */
function isPublicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113))
  }
  if (net.isIP(address) !== 6) return false
  // URL canonicalization expands dotted/mapped aliases before classification.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const [first, second = '0'] = canonical.split(':')
  const a = parseInt(first || '0', 16)
  const b = parseInt(second || '0', 16)
  return a >= 0x2000 && a <= 0x3fff &&
    !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) &&
    a !== 0x2002 && !(a === 0x3fff && b < 0x1000)
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isPublicHostname(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (net.isIP(host)) return isPublicAddress(host)
  return host.length <= 253 && host !== 'localhost' && !host.endsWith('.localhost') &&
    host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}

/**
 * @param {URL} url
 * @param {unknown} rule
 * @returns {boolean}
 */
function matchesRule(url, rule) {
  if (typeof rule !== 'string' || !rule || rule.length > 2048) return false
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(2).toLowerCase()
    return url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)
  }
  const parsed = parseHttp(rule)
  if (parsed) {
    return url.origin === parsed.origin && (parsed.pathname === '/' ||
      url.pathname === parsed.pathname || url.pathname.startsWith(`${parsed.pathname.replace(/\/$/, '')}/`))
  }
  return url.host.toLowerCase() === rule.toLowerCase() || url.hostname.toLowerCase() === rule.toLowerCase()
}

/**
 * @param {UrlPolicyConfig} [config]
 */
function createUrlPolicy(config = {}) {
  const current = () => config.getWorkspaceConfig ? { ...config, ...config.getWorkspaceConfig() } : config
  /**
   * @param {unknown} raw
   * @param {PolicyContext} [context]
   */
  function check(raw, context = {}) {
    const url = parseHttp(raw)
    if (!url) return { ok: false, reason: 'Only HTTP(S) URLs without credentials are allowed' }
    if (context.laneKind === 'agent') {
      // The isolated E2E harness serves its fake model on loopback, which an
      // agent lane would otherwise refuse. The caller decides — a packaged app
      // ignores the E2E flags entirely (electron/main.cjs), so this cannot be
      // turned on by an environment variable alone.
      const isE2ELoopback = config.e2eLoopback === true && isLoopback(url.hostname)
      if (!isE2ELoopback) {
        if (!isPublicHostname(url.hostname)) {
          return { ok: false, reason: 'Workspace agents may only reach public network addresses' }
        }
        if (url.port) return { ok: false, reason: 'Workspace agents may only use standard HTTP(S) ports' }
      }
      const ports = new Set([8642, 9119, ...(config.servePorts || []), ...(context.servePorts || [])].map(Number))
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
      if (isLoopback(url.hostname) && ports.has(port)) {
        return { ok: false, reason: 'Workspace agents cannot reach the Hermes control plane' }
      }
      const origins = [...(config.appOrigins || []), ...(context.appOrigins || []),
        ...(config.getAppOrigins ? config.getAppOrigins() : [])]
      if (origins.some((origin) => {
        const app = parseHttp(origin)
        return app && (app.origin === url.origin ||
          (isLoopback(app.hostname) && isLoopback(url.hostname) &&
            app.protocol === url.protocol &&
            (app.port || (app.protocol === 'https:' ? '443' : '80')) ===
            (url.port || (url.protocol === 'https:' ? '443' : '80'))))
      })) return { ok: false, reason: 'Workspace agents cannot reach the app origin' }
      const profile = typeof context.profile === 'string' ? context.profile
        : typeof context.laneId === 'string' ? context.laneId.replace(/^profile:/, '') : ''
      const rules = (current().agents || {})[profile] || {}
      const deny = rules.deny || rules.denyList || []
      const allow = rules.allow || rules.allowList || []
      if (!Array.isArray(deny) || !Array.isArray(allow)) return { ok: false, reason: 'Invalid agent URL rules' }
      if (deny.some((rule) => matchesRule(url, rule))) return { ok: false, reason: 'URL is denied for this agent' }
      if (allow.length && !allow.some((rule) => matchesRule(url, rule))) {
        return { ok: false, reason: 'URL is not on this agent’s allow list' }
      }
    }
    return { ok: true, url: url.href }
  }

  /**
   * @param {unknown} input
   * @param {PolicyContext} [context]
   */
  function resolve(input, context = {}) {
    if (typeof input !== 'string' || input.length > 16384 || /[\u0000-\u001f\u007f]/.test(input)) {
      return { ok: false, reason: 'Invalid URL or search query' }
    }
    const text = input.trim()
    if (!text) return { ok: false, reason: 'Enter a URL or search query' }
    if (/^https?:\/\//i.test(text)) return check(text, context)
    // Host:port is a URL, not a scheme. Arbitrary schemes must never become searches.
    if (!/\s/.test(text) && /^(?:localhost|[^/:]+\.[^/:]+|\[[0-9a-f:]+\])(?::\d+)?(?:\/|$)/i.test(text)) {
      return check(`https://${text}`, context)
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return { ok: false, reason: 'Only HTTP(S) URLs are allowed' }
    /** @type {Record<string, string>} */
    const engines = { duckduckgo: 'https://duckduckgo.com/?q={query}',
      google: DEFAULT_SEARCH, bing: 'https://www.bing.com/search?q={query}' }
    const rawEngine = current().searchEngine || DEFAULT_SEARCH
    const engine = typeof rawEngine === 'string' ? engines[rawEngine] || rawEngine : rawEngine
    if (typeof engine !== 'string' || !engine.includes('{query}')) {
      return { ok: false, reason: 'Invalid search engine' }
    }
    return check(engine.replaceAll('{query}', encodeURIComponent(text)), context)
  }

  return { check, resolve }
}

module.exports = { createUrlPolicy, check: createUrlPolicy().check, parseHttp, isLoopback,
  isPublicAddress, isPublicHostname, PROFILE_RE, LANE_RE, TAB_RE }
