import { useId } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'

export type SectionProps = Omit<ComponentPropsWithoutRef<'section'>, 'title'> & {
  title: string
  description?: ReactNode
  action?: ReactNode
  headingLevel?: 2 | 3 | 4
}

export function Section({ title, description, action, headingLevel = 2, className, children, ...props }: SectionProps) {
  const headingId = useId()
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4'
  return <section {...props} aria-labelledby={headingId}
    className={['desk-section', className].filter(Boolean).join(' ')}>
    <div className="desk-section-header">
      <div><Heading id={headingId} className="desk-section-title">{title}</Heading>
        {description && <p className="desk-section-description">{description}</p>}</div>
      {action}
    </div>
    {children}
  </section>
}
