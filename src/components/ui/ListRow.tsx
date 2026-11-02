import type { ComponentPropsWithRef, ReactNode } from 'react'

export type ListRowProps = Omit<ComponentPropsWithRef<'button'>, 'children' | 'title'> & {
  title: string
  description?: ReactNode
  meta?: ReactNode
  leading?: ReactNode
  trailing?: ReactNode
  selected?: boolean
}

/** Native button, not a partial ARIA listbox. Put rows in a labelled nav or list. */
export function ListRow({
  title, description, meta, leading, trailing, selected = false, className, type = 'button', ...props
}: ListRowProps) {
  return <button {...props} type={type}
    aria-current={props['aria-current'] ?? (selected ? 'true' : undefined)}
    className={['desk-list-row', className].filter(Boolean).join(' ')} data-selected={selected}>
    {leading && <span className="desk-list-row-leading">{leading}</span>}
    <span className="desk-list-row-content">
      <span className="desk-list-row-title">{title}</span>
      {description && <span className="desk-list-row-description">{description}</span>}
      {meta && <span className="desk-list-row-meta">{meta}</span>}
    </span>
    {trailing && <span className="desk-list-row-trailing">{trailing}</span>}
  </button>
}
