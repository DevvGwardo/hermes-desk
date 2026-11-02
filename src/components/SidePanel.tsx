/**
 * SidePanel — the docked right sidebar shared by Files, Info and the file
 * preview. It sits beside the chat (the chat shrinks to fit), resizes from its
 * left edge, remembers its width per panel, and goes full-screen on narrow
 * widths. Only one is shown at a time; App decides which.
 */
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { panelBudget, INSPECTOR_MIN_WIDTH } from '../lib/shell-layout'
import { ShellLayoutContext } from '../lib/use-shell-layout'
import '../styles/shell-layout.css'

interface SidePanelProps {
  /** Stable id for tests and for the remembered width. */
  id: string
  title: ReactNode
  /** Small line under the title (a folder path, "Your agent's computer"). */
  subtitle?: ReactNode
  /** Leading glyph next to the title (a file icon). */
  icon?: ReactNode
  /** Shows a back arrow before the title (up a folder, back to the list). */
  onBack?: () => void
  backLabel?: string
  onClose: () => void
  closeLabel?: string
  /** Buttons right of the title, left of the close control. */
  actions?: ReactNode
  /** Pinned under the header, above the scrolling body (search box). */
  toolbar?: ReactNode
  defaultWidth?: number
  /** Keep mounted (state intact) but out of view. */
  hidden?: boolean
  /** Workspace supplies its own header and keeps the viewport unscrolled. */
  chrome?: boolean
  scroll?: boolean
  presentation?: 'docked' | 'main'
  maxWidth?: number
  minWidth?: number
  onWidthChange?: (preferredWidth: number) => void
  children: ReactNode
}

const MIN_WIDTH = 300

export const sidePanelIconButton =
  'nub-touch-44 grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--ca-ink-muted)] transition hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)] disabled:opacity-40'

export function SideIcon({ d, size = 15 }: { d: string; size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

export function readSidePanelWidth(id: string, fallback: number): number {
  try {
    const n = Number(window.localStorage.getItem(`nub:side-panel-width:${id}`))
    return Number.isFinite(n) && n >= MIN_WIDTH ? n : fallback
  } catch {
    return fallback
  }
}

export function SidePanel({
  id,
  title,
  subtitle,
  icon,
  onBack,
  backLabel = 'Back',
  onClose,
  closeLabel = 'Close',
  actions,
  toolbar,
  defaultWidth = 400,
  hidden = false,
  chrome = true,
  scroll = true,
  presentation,
  maxWidth,
  minWidth = MIN_WIDTH,
  onWidthChange,
  children,
}: SidePanelProps) {
  const widthKey = `nub:side-panel-width:${id}`
  const [width, setWidth] = useState(() => readSidePanelWidth(id, defaultWidth))
  const geometry = useContext(ShellLayoutContext)
  const minimum = geometry ? Math.max(minWidth, INSPECTOR_MIN_WIDTH) * geometry.textScale : minWidth
  const budget = geometry ? panelBudget(geometry, width, Math.max(minWidth, INSPECTOR_MIN_WIDTH)) : null
  const mode = presentation ?? budget?.presentation ?? 'docked'
  const maximum = maxWidth ?? budget?.maximum ?? window.innerWidth * 0.7
  const renderedWidth = mode === 'main' ? geometry?.contentWidth && geometry.contentWidth - geometry.navigationWidth : Math.max(minimum, Math.min(width, maximum))
  const asideRef = useRef<HTMLElement | null>(null)
  const resizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => resizeCleanup.current?.(), [])
  useLayoutEffect(() => {
    if (hidden || id === 'workspace' || mode !== 'main') return
    const main = asideRef.current?.closest('.hermes-desk-shell')?.querySelector('main')
    if (!main) return
    const previous = main.inert
    main.inert = true
    return () => { main.inert = previous }
  }, [hidden, id, mode])
  const trigger = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (hidden || id === 'workspace') return
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (id !== 'workspace' && mode === 'main') asideRef.current?.querySelector<HTMLButtonElement>('header button')?.focus()
    return () => {
      if (trigger.current?.isConnected && !trigger.current.closest('[hidden]')) trigger.current.focus({ preventScroll: true })
    }
    // Capture once per opening, not on resize or every streamed update.
  }, [hidden, id])
  const commit = useCallback((next: number) => {
    const bounded = Math.round(Math.max(minimum, Math.min(next, maximum)))
    setWidth(bounded)
    onWidthChange?.(bounded)
    try { window.localStorage.setItem(widthKey, String(bounded)) } catch { /* layout only */ }
  }, [minimum, maximum, onWidthChange, widthKey])

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      resizeCleanup.current?.()
      const right = asideRef.current?.getBoundingClientRect().right ?? window.innerWidth
      let last = width
      const move = (ev: PointerEvent) => {
        last = Math.round(Math.max(minimum, Math.min(right - ev.clientX, maximum)))
        setWidth(last)
        onWidthChange?.(last)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        document.body.style.cursor = ''
        resizeCleanup.current = null
        try {
          window.localStorage.setItem(widthKey, String(last))
        } catch {
          // Width just won't persist.
        }
      }
      document.body.style.cursor = 'col-resize'
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
      resizeCleanup.current = up
    },
    [width, widthKey, minimum, maximum, onWidthChange],
  )

  return (
    <aside
      data-side-panel={id}
      data-presentation={mode}
      hidden={hidden}
      aria-label={typeof title === 'string' ? title : id}
      ref={asideRef}
      style={{ ['--side-panel-w' as string]: `${renderedWidth || width}px`, ['--panel-nav-w' as string]: `${geometry?.navigationWidth ?? 0}px` }}
      className={`${hidden ? 'hidden' : 'flex'} desk-side-panel ca-enter fixed inset-0 z-40 flex-col bg-[var(--ca-card)] md:relative md:inset-auto md:z-30 md:shrink-0 md:border-l md:border-[var(--ca-border)]`}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuemin={minimum}
        aria-valuemax={Math.round(maximum)}
        aria-valuenow={Math.round(renderedWidth || width)}
        aria-valuetext={`${Math.round(renderedWidth || width)} pixels wide`}
        tabIndex={mode === 'docked' ? 0 : -1}
        onDoubleClick={() => commit(defaultWidth)}
        onKeyDown={event => {
          const step = event.shiftKey ? 32 : 16
          const current = renderedWidth || width
          const next = event.key === 'ArrowLeft' ? current + step : event.key === 'ArrowRight' ? current - step
            : event.key === 'Home' ? minimum : event.key === 'End' ? maximum : null
          if (next !== null) { event.preventDefault(); commit(next) }
        }}
        onPointerDown={startResize}
        className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize hover:bg-[var(--ca-primary)]/20 md:block"
      />
      {chrome && <header className="flex min-h-[52px] items-center gap-1 border-b border-[var(--ca-border)] px-2 py-1.5">
        {onBack && (
          <button type="button" aria-label={backLabel} title={backLabel} onClick={onBack} className={sidePanelIconButton}>
            <SideIcon d="M10 3.5 5.5 8l4.5 4.5" />
          </button>
        )}
        {icon && (
          <span aria-hidden className={`shrink-0 text-[15px] ${onBack ? '' : 'pl-1.5'}`}>
            {icon}
          </span>
        )}
        <span className={`min-w-0 flex-1 ${onBack || icon ? '' : 'pl-2'}`}>
          <span className="block truncate text-[14px] font-semibold text-[var(--ca-ink)]">{title}</span>
          {subtitle && <span className="block truncate text-[11px] text-[var(--ca-ink-muted)]">{subtitle}</span>}
        </span>
        {actions}
        <button type="button" aria-label={closeLabel} title={closeLabel} onClick={onClose} className={sidePanelIconButton}>
          <SideIcon d="M4 4l8 8M12 4l-8 8" />
        </button>
      </header>}
      {toolbar}
      <div className={`flex min-h-0 flex-1 flex-col ${scroll ? 'overflow-auto' : 'overflow-hidden'}`}>{children}</div>
    </aside>
  )
}

export default SidePanel
