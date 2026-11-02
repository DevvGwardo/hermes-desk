import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Kbd } from './Kbd'

export interface TooltipProps {
  children: ReactElement<{ 'aria-describedby'?: string }>
  content: string
  shortcut?: ReactNode
  side?: 'top' | 'bottom' | 'right'
  portal?: boolean
  disabled?: boolean
  className?: string
}

/** Focus + hover, hoverable content, Escape dismissal. Keep outside clipped containers. */
export function Tooltip({ children, content, shortcut, side = 'bottom', portal = true, disabled = false, className }: TooltipProps) {
  const id = useId()
  const anchor = useRef<HTMLSpanElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, side: side as 'top' | 'bottom' | 'right' | 'left' })
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const open = !disabled && Boolean(content.trim()) && (hovered || focused) && !dismissed
  const clearTimers = () => {
    clearTimeout(hoverTimer.current)
    clearTimeout(leaveTimer.current)
  }
  useEffect(() => () => {
    clearTimeout(hoverTimer.current)
    clearTimeout(leaveTimer.current)
  }, [])
  const enter = (immediate = false) => {
    if (disabled || !content.trim()) return
    clearTimers()
    setDismissed(false)
    if (immediate) setHovered(true)
    else hoverTimer.current = setTimeout(() => setHovered(true), 200)
  }
  const leave = () => {
    clearTimers()
    leaveTimer.current = setTimeout(() => setHovered(false), 120)
  }
  const dismiss = () => {
    clearTimers()
    setHovered(false)
    setDismissed(true)
  }
  useLayoutEffect(() => {
    if (!open || !portal) return
    const place = () => {
      const rect = anchor.current!.getBoundingClientRect()
      const tooltip = bubble.current!.getBoundingClientRect()
      const below = rect.bottom + 6
      const above = rect.top - tooltip.height - 6
      const right = rect.right + 6
      const placedSide = side === 'right' ? (right + tooltip.width <= window.innerWidth - 8 ? 'right' : 'left')
        : side === 'top' ? (above >= 8 ? 'top' : 'bottom')
          : (below + tooltip.height <= window.innerHeight - 8 ? 'bottom' : 'top')
      setPosition({
        left: Math.max(8, Math.min(side === 'right'
          ? (placedSide === 'right' ? right : rect.left - tooltip.width - 6)
          : rect.left + (rect.width - tooltip.width) / 2, window.innerWidth - tooltip.width - 8)),
        top: Math.max(8, Math.min(side === 'right' ? rect.top + (rect.height - tooltip.height) / 2
          : placedSide === 'top' ? above : below, window.innerHeight - tooltip.height - 8)),
        side: placedSide,
      })
    }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open, portal, side, content, shortcut])
  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        clearTimeout(hoverTimer.current)
        clearTimeout(leaveTimer.current)
        setHovered(false)
        setDismissed(true)
      }
    }
    // A hover-only tooltip must dismiss even when focus is elsewhere.
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  const description = [children.props['aria-describedby'], open ? id : undefined].filter(Boolean).join(' ') || undefined
  const tooltip = open && <span ref={bubble} className="desk-tooltip" id={id} role="tooltip" data-side={portal ? position.side : side}
    onMouseEnter={() => enter(true)} onMouseLeave={leave}
    style={portal ? { position: 'fixed', left: position.left, top: position.top, bottom: 'auto', right: 'auto', transform: 'none' } : undefined}>
    <span className="desk-tooltip-content">{content}</span>{shortcut && <Kbd>{shortcut}</Kbd>}
  </span>
  return <span ref={anchor} className={['desk-tooltip-anchor', className].filter(Boolean).join(' ')}
    onMouseEnter={() => enter()} onMouseLeave={leave}
    onFocus={() => { clearTimeout(hoverTimer.current); setFocused(true); setDismissed(false) }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false) }}
    onClickCapture={dismiss}
    onKeyDown={event => {
      if (event.key !== 'Escape' || !open) return
      dismiss()
      // Transient menus should still close on the first Escape.
      if (!event.currentTarget.closest('[role="menu"], [role="dialog"]:not([aria-modal="true"])')) event.stopPropagation()
    }}>
    {cloneElement(children, { 'aria-describedby': description })}
    {tooltip && (portal ? createPortal(tooltip, document.body) : tooltip)}
  </span>
}
