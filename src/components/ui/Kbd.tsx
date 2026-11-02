import type { ComponentPropsWithoutRef } from 'react'

export function Kbd({ className, ...props }: ComponentPropsWithoutRef<'kbd'>) {
  return <kbd {...props} className={['desk-kbd', className].filter(Boolean).join(' ')} />
}
