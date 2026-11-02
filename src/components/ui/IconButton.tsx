import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Tooltip } from './Tooltip'

export type IconButtonProps = Omit<ComponentPropsWithRef<'button'>, 'aria-label' | 'children' | 'title'> & {
  'aria-label': string
  children: ReactNode
  size?: 'xs' | 'sm' | 'md'
  variant?: 'ghost' | 'primary' | 'danger'
  active?: boolean
  round?: boolean
  tooltip?: string
  shortcut?: ReactNode
  tooltipSide?: 'top' | 'bottom' | 'right'
  tooltipPortal?: boolean
  tooltipDisabled?: boolean
}

export function IconButton({
  'aria-label': label, children, size = 'sm', variant = 'ghost', active, round = false,
  tooltip, shortcut, tooltipSide, tooltipPortal, tooltipDisabled, className, type = 'button', ...props
}: IconButtonProps) {
  if (!label.trim()) throw new Error('IconButton requires a non-empty aria-label')
  return <Tooltip content={tooltip ?? label} shortcut={shortcut} side={tooltipSide} portal={tooltipPortal}
    disabled={tooltipDisabled || props['aria-expanded'] === true || props['aria-expanded'] === 'true'}>
    <button {...props} type={type} aria-label={label}
      aria-pressed={props['aria-pressed'] ?? (active === undefined ? undefined : active)}
      className={['desk-icon-button', className].filter(Boolean).join(' ')}
      data-size={size} data-variant={variant} data-active={active} data-round={round}>
      {children}
    </button>
  </Tooltip>
}
