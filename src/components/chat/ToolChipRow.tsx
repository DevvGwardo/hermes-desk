import { memo, useState } from 'react'
import type { ChatMessage } from '../../lib/agents'
import { describeToolActivity } from '../../lib/agents/tool-activity'
import type { HermesToolEvent } from '../../lib/agents/hermes-transport'
import { Icon } from '../ui/icons'
import '../../styles/skin-messenger.css'

// CONTRACT: the shared event shape has no elapsed time yet. Accept optional
// durationMs without synthesizing timings from renderer mount time.
export type ToolChipEvent = NonNullable<ChatMessage['toolEvents']>[number] & HermesToolEvent

export function toolCaption(event: ToolChipEvent): string {
  const done = event.status !== 'running'
  if (done && event.summary?.trim()) return event.summary.trim()
  const activity = describeToolActivity(event.tool)
  if (activity.verb === 'browsing') {
    try {
      const args = JSON.parse(event.args || '{}') as { url?: unknown }
      if (typeof args.url === 'string') {
        const url = new URL(args.url)
        if (url.protocol === 'https:' || url.protocol === 'http:') return `${done ? 'Browsed' : 'Browsing'} ${url.hostname}`
      }
    } catch { /* Malformed tool args are not a render failure. */ }
  }
  if (/^(terminal|bash|shell)$/i.test(event.tool)) {
    let command: unknown
    try { command = JSON.parse(event.args || '{}').command } catch { /* No command available. */ }
    const labels = event.labels?.map(label => label.text ?? label.label ?? '').filter(Boolean).join(' · ')
    return `${done ? 'Ran' : 'Running'} ${typeof command === 'string' && command.trim() ? `\`${command.trim()}\`` : labels || 'terminal'}`
  }
  const caption = event.labels?.map(label => label.text ?? label.label ?? '').filter(Boolean).join(' · ') || event.label?.trim() || activity.text
  return done ? caption.replace(/^Running\b/i, 'Ran').replace(/^Reading\b/i, 'Read').replace(/^Searching\b/i, 'Searched').replace(/^Browsing\b/i, 'Browsed').replace(/^Rendering\b/i, 'Rendered') : caption
}

export const ToolChipRow = memo(function ToolChipRow({ events }: { events: ToolChipEvent[] }) {
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const failures = events.filter(event => event.status === 'failed').length
  const running = events.filter(event => event.status === 'running').length
  const collapsed = expanded === null ? events.every(event => event.status === 'completed') : !expanded
  if (events.length === 0) return null
  return (
    <div className="messenger-tools" data-testid="tool-chip-row">
      <button
        type="button"
        className="messenger-steps"
        data-status={failures ? 'failed' : running ? 'running' : 'completed'}
        aria-label={collapsed ? 'Expand tool activity' : 'Collapse tool activity'}
        aria-expanded={!collapsed}
        onClick={() => setExpanded(collapsed)}
      >
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={14} />
        {events.length} {events.length === 1 ? 'step' : 'steps'}
        {failures > 0 && <span> · {failures} failed</span>}
        {running > 0 && <span> · Working</span>}
      </button>
      {!collapsed && (
        <ul className="messenger-tool-list" aria-label="Tool activity">
          {events.map((event, i) => {
            const activity = describeToolActivity(event.tool)
            const elapsed = event.durationMs !== undefined && Number.isFinite(event.durationMs) && event.durationMs >= 0
              ? `${(event.durationMs / 1000).toFixed(1)}s`
              : null
            return (
              <li key={event.toolCallId || `${event.tool}:${i}`} className="messenger-tool-chip" data-status={event.status}>
                <Icon name={activity.verb === 'browsing' ? 'globe' : /terminal|bash|shell/i.test(event.tool) ? 'terminal' : 'tool'} size={16} />
                <span>{toolCaption(event)}</span>
                {event.exitCode !== undefined && event.exitCode !== 0 && <span>exit {event.exitCode}</span>}
                {elapsed && <span className="messenger-tool-time">· {elapsed}</span>}
                <span role="img" className="messenger-tool-status" aria-label={event.status === 'running' ? 'Running' : event.status === 'failed' ? 'Failed' : 'Completed'}>
                  <Icon name={event.status === 'failed' ? 'x' : event.status === 'running' ? 'tool' : 'check'} size={14} />
                  <span className="sr-only">{event.status === 'running' ? 'Running' : event.status === 'failed' ? 'Failed' : 'Completed'}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
})
