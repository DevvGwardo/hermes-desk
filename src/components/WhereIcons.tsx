/**
 * Where-is-the-agent-running icons (clean-room, inline SVG).
 *
 * Matches the app's inline-icon style (ReplyQuote.tsx): 16x16 viewBox,
 * stroke currentColor, aria-hidden — the accessible name lives on the
 * wrapping pill via aria-label.
 *
 * VM = server rack, local computer = desktop monitor.
 */

export function VmServerIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="2"
        y="2.5"
        width="12"
        height="4"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="2"
        y="9.5"
        width="12"
        height="4"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="4.4" cy="4.5" r="0.75" fill="currentColor" />
      <circle cx="4.4" cy="11.5" r="0.75" fill="currentColor" />
    </svg>
  )
}

export function LocalComputerIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="2"
        y="2.5"
        width="12"
        height="8.5"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M5.5 13.5h5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}
