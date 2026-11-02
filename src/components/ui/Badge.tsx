import type { ComponentPropsWithoutRef } from 'react'
import type { Tone } from './Pill'

export type BadgeProps = ComponentPropsWithoutRef<'span'> & { tone?: Tone; count?: number; max?: number }

/** Count zero is absent. The accessible label always reports the uncapped count. */
export function Badge({ tone = 'neutral', count, max = 99, children, className, ...props }: BadgeProps) {
  if (count !== undefined && count <= 0) return null
  return <span {...props}
    aria-label={props['aria-label'] ?? (count === undefined ? undefined : `${count} unread`)}
    className={['desk-badge', className].filter(Boolean).join(' ')}
    data-tone={tone} data-count={count !== undefined}>
    {count === undefined ? children : count > max ? `${max}+` : count}
  </span>
}
