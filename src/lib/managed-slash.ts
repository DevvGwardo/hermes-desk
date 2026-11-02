/**
 * Slash commands Nub Agent does NOT forward to the agent.
 *
 * ChatPanel passes any unknown `/command` straight to hermes. Some of those
 * would repoint the platform-managed model, swap providers or credentials,
 * or flip approvals globally — settings the platform owns. Those are stopped
 * in the composer with a plain notice instead.
 *
 * Names verified against hermes `hermes_cli/commands.py` COMMAND_REGISTRY
 * (exact-match lookup on name or alias, case-insensitive, leading `/` optional).
 * `/provider`, `/fallback`, `/auth`, `/login` and `/logout` are not hermes
 * commands today; they stay listed defensively so a future hermes (or plugin)
 * command with those names can never slip through.
 */

export const MANAGED_SETTING_NOTICE = 'That setting is managed by Nub Agent'

const MANAGED_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  // Model / provider
  'model', // switch model (session or --global)
  'provider',
  'fast', // provider priority tier
  'moa', // mixture-of-agents: runs other models
  'reasoning', // reasoning effort
  'fallback',
  'codex-runtime', // alias: codex_runtime — swaps the model runtime
  // Credentials / accounts / billing
  'auth',
  'login',
  'logout',
  'subscription', // alias: upgrade — Nous plan
  'upgrade',
  'topup', // Nous billing portal
  // Global config / approvals
  'config',
  'yolo', // skip all approvals
  'approvals', // persistent approval mode (Settings owns this)
  'snapshot', // alias: snap — restores Hermes config/state
  'snap',
  'import', // imports a profile archive (config + model)
  'update', // updates the agent install (platform-managed)
])

/** Command word of a `/cmd args` draft, normalized (lowercase, `_`→`-`); null when not a slash command. */
export function slashCommandName(text: string): string | null {
  const t = text.trimStart()
  if (!t.startsWith('/')) return null
  const word = t.slice(1).split(/\s+/)[0] ?? ''
  const name = word.split('@')[0]!.toLowerCase().replace(/_/g, '-')
  return name || null
}

/** True when `text` is a slash command that changes a platform-managed setting. */
export function isManagedSlashCommand(text: string): boolean {
  const name = slashCommandName(text)
  return name !== null && MANAGED_SLASH_COMMANDS.has(name)
}

export function managedSlashCommands(): string[] {
  return [...MANAGED_SLASH_COMMANDS].sort()
}
