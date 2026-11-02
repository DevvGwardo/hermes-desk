/**
 * Small shared helpers for the agent-management surfaces (profiles,
 * personality, chat history, capabilities, kanban over REST).
 *
 * - `isHostedAgent()` — true when this device is linked to a hosted VM
 *   (desktop Nub link or web/mobile deploy session). Hosted VMs are driven
 *   over dashboard REST only; the local `hermes` CLI bridge is a fallback for
 *   a local install, never for a VM.
 * - `restFailureText()` — turn a dashboard failure into plain words. A 404
 *   means the agent predates the route; a 409 is shown with the dashboard's
 *   own reason when it gave one.
 */

/** Retained for shared panes: a local agent is never a hosted VM. */
export async function isHostedAgent(): Promise<boolean> {
  return false
}

export const NEEDS_UPDATE_TEXT = 'Your agent needs an update for this.'

/** The agent's computer didn't answer (restarting, crashed, or stopped). */
export const AGENT_DOWN_TEXT = 'Your agent isn’t reachable right now. It may be restarting, so try again in a minute.'

/**
 * The platform's dashboard proxy answers 502 `{ error: "Upstream error" }`
 * when the VM doesn't (hermes-deploy dashboard/[...path]/route.ts), and a
 * gateway timeout is 504. Those reached Settings verbatim ("Upstream error").
 */
function isAgentDown(status: number | undefined, msg: string): boolean {
  return status === 502 || status === 504 || /^upstream error$/i.test(msg) || /^bad gateway$/i.test(msg)
}

/** Messages that carry no information for a person (transport labels). */
function isOpaque(msg: string): boolean {
  return (
    !msg ||
    /^HTTP \d{3}$/.test(msg) ||
    /^dashboard \d{3}$/i.test(msg) ||
    msg === 'dashboard not ready' ||
    msg === 'dashboard_unreachable' ||
    msg === 'not_linked'
  )
}

export function restFailureText(
  res: { status?: number; error?: string } | null | undefined,
  fallback = 'Something went wrong. Try again.',
): string {
  const status = res?.status
  const msg = (res?.error ?? '').trim()
  if (status === 404) return NEEDS_UPDATE_TEXT
  if (status === 409) {
    return isOpaque(msg)
      ? 'Your agent is busy or still starting up. Try again in a moment.'
      : msg
  }
  if (status === 401) return 'This device needs to be linked to your agent again.'
  if (status === 403) return 'Your agent refused this request.'
  if (isAgentDown(status, msg)) return AGENT_DOWN_TEXT
  if (status === 503 && isOpaque(msg)) return AGENT_DOWN_TEXT
  if (/timed out/i.test(msg)) return 'Your agent took too long to answer. Try again.'
  if (!status && (msg === 'Agent unavailable' || msg === 'not_linked' || msg === 'dashboard_unreachable')) {
    return 'Your agent is not reachable right now.'
  }
  return isOpaque(msg) ? fallback : msg
}
