/**
 * Attach MCP servers to a desktop-created specialist (Grok custom-bot plugins).
 * Not shown for Hermes profiles — those own the global config.yaml map.
 */

import { useEffect, useState } from 'react'
import { mcpListServers, type McpServer } from '../lib/mcp'
import type { AgentMcpServer } from '../lib/agents/types'

interface AgentMcpAttachProps {
  selected: AgentMcpServer[]
  onChange: (next: AgentMcpServer[]) => void
  /** Render nothing when extra tools can't work here (browser tab). */
  hideWhenUnavailable?: boolean
  disabled?: boolean
  className?: string
}

export function AgentMcpAttach({ selected, onChange, hideWhenUnavailable = false, disabled = false, className }: AgentMcpAttachProps) {
  const [servers, setServers] = useState<McpServer[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void mcpListServers().then((res) => {
      if (cancelled) return
      setServers(res.servers)
      setError(res.error ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const selectedNames = new Set(selected.map((s) => s.name))

  const toggle = (server: McpServer) => {
    if (disabled) return
    if (selectedNames.has(server.name)) {
      onChange(selected.filter((s) => s.name !== server.name))
      return
    }
    onChange([...selected, { name: server.name, ...(server.url ? { url: server.url } : {}) }])
  }

  // In a browser tab MCP isn't reachable at all. Say nothing rather than
  // show a card whose only content is "you can't use this here".
  const desktopOnly = !!error && servers.length === 0 && /desktop app/i.test(error)
  if (desktopOnly && hideWhenUnavailable) return null

  return (
    <div className={className}>
      <div className="mb-0.5 text-[11px] font-medium text-[var(--ca-ink-muted)]">Extra tools</div>
      <p className="mb-1.5 text-[10px] leading-4 text-[var(--ca-ink-muted)]">
        Give this agent extra tools to work with.
      </p>
      {error && servers.length === 0 ? (
        <p className="text-[11px] text-[var(--ca-ink-muted)]">
          {/desktop app/i.test(error)
            ? 'Extra tools need the desktop app. Open this agent in the desktop app instead of a browser tab.'
            : error}
        </p>
      ) : servers.length === 0 ? (
        <p className="text-[11px] text-[var(--ca-ink-muted)]">No extra tools installed yet.</p>
      ) : (
        <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
          {servers.map((s) => {
            const on = selectedNames.has(s.name)
            return (
              <label
                key={s.name}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-[var(--ca-hover)]"
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled}
                  onChange={() => toggle(s)}
                  className="accent-[var(--ca-primary)]"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--ca-ink)]">
                  {s.name}
                </span>
                <span className="shrink-0 text-[9px] uppercase tracking-wider text-[var(--ca-ink-muted)]">
                  {s.transport ?? s.type ?? (s.url ? 'http' : 'stdio')}
                </span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}
