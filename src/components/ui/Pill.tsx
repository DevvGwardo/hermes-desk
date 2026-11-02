import type { ComponentPropsWithoutRef } from 'react'

export type Tone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger'
export type PillProps = ComponentPropsWithoutRef<'span'> & { tone?: Tone; dot?: boolean }

/** Non-interactive label. For a disclosure, use Button rather than a clickable span. */
export function Pill({ tone = 'neutral', dot = false, className, children, ...props }: PillProps) {
  return <span {...props} className={['desk-pill', className].filter(Boolean).join(' ')} data-tone={tone}>
    {dot && <span className="desk-status-dot" aria-hidden="true" />}{children}
  </span>
}
