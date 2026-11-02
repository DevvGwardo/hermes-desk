'use strict'

/**
 * Environment scrub for processes that run agent code (#160 / #161).
 *
 * The desktop app inherits whatever the user's shell exported — commonly a
 * broad GITHUB_TOKEN / GH_TOKEN. Spawning `hermes` (kanban dispatch starts
 * workers), the task-queue CLI, or git with `env: process.env` hands that
 * credential to every tool call an agent makes. Strip credential-shaped
 * vars the agent has no business inheriting from the desktop process.
 *
 * Deliberately NOT stripped: model-provider keys (ANTHROPIC_API_KEY, …).
 * The hermes CLI falls back to the shell env for those when
 * ~/.hermes/.env does not set them, so removing them would break agents
 * outright. A GitHub token the agent really needs belongs in
 * ~/.hermes/.env as a fine-grained, per-repo, short-expiry PAT (see
 * docs/SECURITY.md §0b) — hermes loads that file itself.
 *
 * Pure Node — no electron imports — unit-testable like bin-guard.
 */

/** Exact names (compared upper-case: Windows env keys are case-insensitive). */
const SCRUBBED_VARS = new Set([
  // GitHub CLI / API credentials.
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITHUB_PAT',
  // App-held secrets: the dashboard session token (main attaches it itself),
  // the dev gateway-dump nonces, and the release signing key.
  'HERMES_DASHBOARD_SESSION_TOKEN',
  'NUB_DUMP_GATEWAY_NONCE',
  'NUB_DUMP_NONCE',
  'MAIA_UPDATE_SIGNING_KEY',
])

/** Prefixes for families of the same credential (GITHUB_PAT_WORK, …). */
const SCRUBBED_PREFIXES = ['GITHUB_PAT_']

/** @param {string} name */
function isScrubbedVar(name) {
  if (typeof name !== 'string') return false
  const upper = name.toUpperCase()
  if (SCRUBBED_VARS.has(upper)) return true
  return SCRUBBED_PREFIXES.some((p) => upper.startsWith(p))
}

/**
 * Copy of `env` without the scrubbed credentials. Never mutates the input.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
function scrubAgentEnv(env = process.env) {
  const out = helperEnv(env)
  for (const key of AGENT_VARS) if (typeof env[key] === 'string') out[key] = env[key]
  return out
}

// No credential-family denylist can enumerate every shell secret. Helpers get
// ordinary process settings only; model keys are an explicit agent-only grant.
const HELPER_VARS = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'TMP', 'TEMP',
  'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'])
const AGENT_VARS = new Set([
  'HERMES_HOME', 'HERMES_CWD', 'HERMES_SERVE_URL', 'HERMES_DISABLE_LAZY_INSTALLS',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY',
  'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY',
])
function helperEnv(env = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && (HELPER_VARS.has(key) || /^LC_[A-Z_]+$/.test(key))) out[key] = value
  }
  return out
}
/**
 * Scrubbed env for our read-only git plumbing: no inherited tokens and no
 * interactive credential prompt (a hostile remote must never pop a dialog
 * or block the main process waiting on a terminal).
 * @param {NodeJS.ProcessEnv} [env]
 */
function gitEnv(env = process.env) {
  return {
    ...helperEnv(env),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  }
}

module.exports = {
  SCRUBBED_VARS,
  SCRUBBED_PREFIXES,
  isScrubbedVar,
  scrubAgentEnv,
  gitEnv,
  helperEnv,
  AGENT_VARS,
}
