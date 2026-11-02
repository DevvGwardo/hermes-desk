import { useRef } from 'react'
import type { ComponentPropsWithoutRef, KeyboardEvent } from 'react'

export type ToolbarProps = Omit<ComponentPropsWithoutRef<'div'>, 'aria-label'> & {
  'aria-label': string
  orientation?: 'horizontal' | 'vertical'
}

/** Arrow/Home/End navigation supplements native Tab; never steals input caret keys. */
export function Toolbar({
  'aria-label': label, orientation = 'horizontal', className, onKeyDown, ...props
}: ToolbarProps) {
  const host = useRef<HTMLDivElement>(null)
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (!(event.target instanceof HTMLElement) || event.target.closest('input, textarea, select, [contenteditable="true"]')) return
    const previous = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
    const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
    if (![previous, next, 'Home', 'End'].includes(event.key)) return
    const buttons = [...(host.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      .filter(button => button.tabIndex >= 0 && !button.closest('[hidden], [inert], [aria-hidden="true"]')
        && button.getClientRects().length > 0 && getComputedStyle(button).visibility === 'visible')
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    if (index < 0 || !buttons.length) return
    const destination = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === previous ? -1 : 1) + buttons.length) % buttons.length
    event.preventDefault()
    buttons[destination].focus()
  }
  return <div {...props} ref={host} role="toolbar" aria-label={label} aria-orientation={orientation}
    data-orientation={orientation} className={['desk-toolbar', className].filter(Boolean).join(' ')}
    onKeyDown={navigate} />
}
