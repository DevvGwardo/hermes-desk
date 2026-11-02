import { useEffect, useState, type ReactNode } from 'react'

/**
 * A collapsed "Advanced" / "Details" card for Settings. The body mounts only
 * while open, so anything that loads data (billing, API keys) waits for a tap.
 * `defaultOpen` also opens it later, e.g. when a deep link asks for it.
 */
export function Disclosure({
  summary,
  defaultOpen = false,
  children,
  testId,
  className = '',
  plain = false,
}: {
  summary: ReactNode
  defaultOpen?: boolean
  children: ReactNode
  testId?: string
  className?: string
  /** No card chrome: for an "Advanced" group whose rows are cards already. */
  plain?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => {
    if (defaultOpen) setOpen(true)
  }, [defaultOpen])
  return (
    <details
      open={open}
      data-testid={testId}
      className={`${plain ? '' : 'rounded-xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-2'} ${className}`}
    >
      <summary
        className={
          plain
            ? 'cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-[var(--ca-ink-muted)] hover:text-[var(--ca-ink)]'
            : 'cursor-pointer text-[12px] font-medium text-[var(--ca-ink)]'
        }
        onClick={(e) => {
          e.preventDefault()
          setOpen((v) => !v)
        }}
      >
        {summary}
      </summary>
      {open ? <div className="mt-2 space-y-2">{children}</div> : null}
    </details>
  )
}
