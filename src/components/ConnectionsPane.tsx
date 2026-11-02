/** Compatibility for unmerged callers. Hermes Desk has no messaging connections. */
export function ConnectionsPane({ active }: { active: boolean; onOpenMarketplace?: () => void }) {
  return active ? <p className="text-xs text-[var(--ca-ink-muted)]">Hermes Desk connects only to local Hermes serve. There are no messaging connections.</p> : null
}
