import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { modalEnter, modalExit } from '../lib/motion'

export type AppModalSize = 'md' | 'lg' | 'xl' | 'store' | 'settings'

interface AppModalProps {
  open: boolean
  onClose: () => void
  title: string
  /** Extra header row (tabs, search) under the title. */
  toolbar?: ReactNode
  /** Right of the title, left of the close control. */
  actions?: ReactNode
  size?: AppModalSize
  /** Charcoal Grok-style overlay (Plugins). Default is Nub light. */
  tone?: 'light' | 'ink'
  /** Change it to scroll the body back to the top (a page change inside a
   *  multi-page modal, e.g. Marketplace home → View all). */
  contentKey?: string
  /** Pinned under the scrolling body (a reply box). It sits outside the
   *  scroller, so it spans the full width and never scrolls away. */
  footer?: ReactNode
  children: ReactNode
}

const SIZE: Record<AppModalSize, string> = {
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-[920px]',
  /** Grok Bot Marketplace frame (sand-plugins-dialog): a FIXED 800×700,
   *  shrinking only with the window, so pages and loading states never
   *  resize the dialog — only the body scrolls. */
  store: 'max-w-[800px] h-[min(700px,calc(100vh-96px))]',
  /** Settings: one fixed height, so switching sections never moves the
   *  dialog (it used to jump ~140px between a short and a long section). */
  settings: 'max-w-2xl h-[min(680px,calc(100vh-96px))]',
}
const inertOwners = new WeakMap<HTMLElement, { count: number; previous: boolean }>()

/**
 * Centered product modal. Right-rail panels (except Computer) should use this
 * instead of a slide-over so the chat column stays full-width.
 */
export function AppModal({
  open,
  onClose,
  title,
  toolbar,
  actions,
  size = 'md',
  tone = 'light',
  contentKey,
  footer,
  children,
}: AppModalProps) {
  const reduce = useReducedMotion()
  const ink = tone === 'ink'
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [contentKey])

  // Escape dismisses the modal — keyboard users otherwise have no way out.
  // Tab is trapped inside the dialog: with aria-modal="true" the background
  // is hidden from assistive tech, so focus must not leak into it.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'Escape' && e.key !== 'Tab') || e.defaultPrevented || !dialogRef.current ||
        [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
          .filter((dialog) => !dialog.closest('[inert]')).at(-1) !== dialogRef.current) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusables = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      )].filter((element) => {
        const closed = element.closest('details:not([open])')
        return !closed || closed.querySelector('summary')?.contains(element)
      })
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Move focus into the dialog when it opens; restore it when it closes.
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const background: HTMLElement[] = []
    let branch = dialogRef.current?.parentElement
    while (branch?.parentElement && branch !== document.body) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          const owner = inertOwners.get(sibling) ?? { count: 0, previous: sibling.inert }
          owner.count++
          inertOwners.set(sibling, owner)
          background.push(sibling)
          sibling.inert = true
        }
      }
      branch = branch.parentElement
    }
    dialogRef.current?.focus()
    return () => {
      for (const element of background) {
        const owner = inertOwners.get(element)!
        if (--owner.count === 0) {
          element.inert = owner.previous
          inertOwners.delete(element)
        }
      }
      if (prev?.isConnected) prev.focus()
    }
  }, [open])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-5 inert:z-40"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1, transition: reduce ? { duration: 0 } : { duration: 0.2, ease: 'easeOut' } }}
          exit={reduce ? undefined : { opacity: 0, transition: modalExit }}
        >
          <div
            className={`absolute inset-0 ${ink ? 'bg-black/50' : 'nub-scrim'}`}
            onClick={onClose}
          />
          <motion.div
            ref={dialogRef}
            role="dialog"
            data-esc-layer
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            // Open: scale up from 96% and rise 8px while fading in, landing
            // on an ease-out; close: a quicker fade with a slight shrink.
            initial={reduce ? false : { opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: reduce ? { duration: 0 } : modalEnter }}
            exit={reduce ? undefined : { opacity: 0, scale: 0.98, y: 4, transition: modalExit }}
            style={{ transformOrigin: '50% 45%', willChange: 'transform, opacity' }}
            onClick={(e) => e.stopPropagation()}
            className={`relative flex max-h-[86vh] w-full flex-col overflow-hidden rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.28)] ${SIZE[size]} ${
              ink
                ? 'border border-white/10 bg-[#1a1b1e] text-[#f4f4f5]'
                : 'border border-[var(--ca-border)] bg-[var(--ca-card)] text-[var(--ca-ink)]'
            }`}
          >
            <div
              className={`flex items-center justify-between gap-3 px-5 pt-4 ${toolbar ? 'pb-3' : 'pb-3'} ${
                ink || toolbar ? '' : 'border-b border-[var(--ca-border)]'
              }`}
            >
              <h2 className={`text-[17px] font-semibold tracking-tight ${ink ? 'text-white' : 'text-[var(--ca-ink)]'}`}>
                {title}
              </h2>
              <div className="flex items-center gap-1">
                {actions}
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                    ink
                      ? 'text-white/55 hover:bg-white/8 hover:text-white'
                      : 'nub-hover-faint text-[var(--ca-ink-muted)] hover:bg-black/5 hover:text-[var(--ca-ink)]'
                  }`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>
            {toolbar && (
              <div className={`px-5 pb-3 ${ink ? '' : 'border-b border-[var(--ca-border)]'}`}>{toolbar}</div>
            )}
            <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
              {children}
            </div>
            {footer}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
