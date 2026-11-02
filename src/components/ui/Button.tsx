import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Icon } from './icons'

export type ButtonProps = Omit<ComponentPropsWithRef<'button'>, 'children'> & {
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
}

export function Button({
  children, variant = 'secondary', size = 'md', loading = false,
  disabled, className, type = 'button', ...props
}: ButtonProps) {
  return <button {...props} type={type} disabled={disabled || loading}
    aria-busy={loading || props['aria-busy']}
    className={['desk-button', className].filter(Boolean).join(' ')}
    data-variant={variant} data-size={size}>
    {loading && <Icon name="reload" size={16} className="desk-spinner" />}
    {children}
  </button>
}
