/** Hermes owns transcript persistence; no renderer-side retention or hosted API. */
export function ChatRetentionBlock() {
  return <p className="text-xs text-[var(--ca-ink-muted)]">Chat history is stored by local Hermes. Hermes Desk does not upload or prune transcripts.</p>
}
