/**
 * UI component shims — the `@hermes/plugin-sdk` design language mapped onto
 * maia's inline `--ca-*` tokens. Deliberately minimal: plugin panes render
 * native-ish controls, not a port of @nous-research/ui (never imported).
 *
 * Bounded stubs (honest gaps): McpTab and ToolsetConfigPanel render a small
 * summary + a link to maia's own surfaces — full Hermes-desktop parity for
 * those two is out of scope.
 */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'

// -- utils -------------------------------------------------------------------

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 5) return 'now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

const PALETTE = ['#1a3d6b', '#2a5280', '#5a7aa0', '#c8a45a', '#8b6f47', '#3e6b4f', '#7a4f8b']

export function profileColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

export function profileColorSoft(name: string): string {
  return `${profileColor(name)}22`
}

export function haptic(_kind?: 'tap' | 'light'): void {
  /* no haptic path on desktop maia */
}

export function Codicon({ name }: { name: string }) {
  const glyphs: Record<string, string> = {
    'add': '+',
    'close': '×',
    'edit': '✎',
    'trash': '🗑',
    'refresh': '⟳',
    'chevron-down': '▾',
    'chevron-right': '▸',
    'mail': '✉',
    'calendar': '📅',
    'clock': '🕐',
    'sparkle': '✦',
    'robot': '🤖',
    'person': '👤',
  }
  return <span aria-hidden="true">{glyphs[name] ?? '•'}</span>
}

// -- primitives --------------------------------------------------------------

const btnBase = 'inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none'

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm' | 'md' }) {
  const styles =
    variant === 'primary'
      ? 'bg-[var(--ca-ink)] text-[var(--ca-card)] hover:bg-[var(--ca-ink-soft)]'
      : variant === 'ghost'
        ? 'text-[var(--ca-ink)] hover:bg-[var(--ca-ink)]/10'
        : 'border border-[var(--ca-ink)]/30 text-[var(--ca-ink)] hover:bg-[var(--ca-ink)]/10'
  return <button className={cn(btnBase, styles, size === 'sm' && 'px-2.5 py-1 text-xs', className)} {...rest} />
}

/* Text-entry focus routes through the single --ca-focus-ring token (2px
 * outline + offset, colour-matched to --ca-primary-text) — never a /30 wash. */
const fieldBase = 'w-full rounded-lg border border-[var(--ca-ink)]/25 bg-[var(--ca-card)] px-2.5 py-1.5 text-sm text-[var(--ca-ink)] placeholder:text-[var(--ca-placeholder)] focus:outline-none focus:border-[var(--ca-focus-ring)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ca-focus-ring)]'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldBase, props.className)} {...props} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, 'min-h-[72px]', props.className)} {...props} />
}

export function Checkbox({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="checkbox" className={cn('size-4 accent-[var(--ca-ink)]', className)} {...rest} />
}

export function Switch({
  checked,
  onChange,
  'aria-label': ariaLabel,
}: {
  checked?: boolean
  onChange?: (checked: boolean) => void
  'aria-label'?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange?.(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-[var(--ca-ink)]' : 'bg-[var(--ca-ink)]/25',
      )}
    >
      <span className={cn('block size-3.5 rounded-full bg-white transition-transform', checked ? 'translate-x-4.5 translate-x-[18px]' : 'translate-x-1')} />
    </button>
  )
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(fieldBase, 'appearance-none pr-7', props.className)} {...props} />
}
export function SelectContent({ children }: { children?: ReactNode }) {
  return <>{children}</>
}
export function SelectItem({ value, children }: { value: string; children?: ReactNode }) {
  return <option value={value}>{children}</option>
}
export function SelectTrigger({ children }: { children?: ReactNode }) {
  return <>{children}</>
}
export function SelectValue() {
  return null
}

export function ScrollArea({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={cn('overflow-auto', className)}>{children}</div>
}

export function EmptyState({ title, description }: { title?: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-8 text-center">
      {title && <p className="text-sm font-medium text-[var(--ca-ink)]">{title}</p>}
      {description && <p className="text-xs text-[var(--ca-ink-muted)]">{description}</p>}
    </div>
  )
}

export function SearchField(props: InputHTMLAttributes<HTMLInputElement>) {
  return <Input type="search" className="max-w-[220px]" {...props} />
}

export function GlyphSpinner() {
  return <span role="status" className="inline-block size-4 animate-spin rounded-full border-2 border-[var(--ca-ink)]/20 border-t-[var(--ca-ink)]" aria-label="Loading" />
}

export function Tip({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <span className="relative inline-flex" title={label}>
      {children ?? label}
    </span>
  )
}

// -- context menu ------------------------------------------------------------

interface ContextMenuProps {
  trigger: ReactNode
  children?: ReactNode
}
export function ContextMenu({ trigger, children }: ContextMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    // Keyboard path: focus the first item on open.
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus({ preventScroll: true })
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    if (items.length === 0) return
    const idx = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      ;(items[idx + 1] ?? items[0]).focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      ;(items[idx - 1] ?? items[items.length - 1]).focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
  }

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center bg-transparent p-0"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          onKeyDown={onMenuKeyDown}
          className="absolute z-40 mt-1 min-w-[160px] rounded-lg border border-[var(--ca-ink)]/15 bg-[var(--ca-card)] p-1 shadow-lg"
        >
          {children}
        </div>
      )}
    </div>
  )
}

export function ContextMenuTrigger({ children }: { children?: ReactNode }) {
  return <>{children}</>
}
export function ContextMenuContent({ children }: { children?: ReactNode }) {
  return <>{children}</>
}
export function ContextMenuItem({
  children,
  onSelect,
  onClick,
}: {
  children?: ReactNode
  onSelect?: () => void
  onClick?: () => void
}) {
  const handle = useCallback(() => {
    onSelect?.()
    onClick?.()
  }, [onSelect, onClick])
  return (
    <button type="button" role="menuitem" onClick={handle} className="block w-full px-3 py-1.5 text-left text-sm text-[var(--ca-ink)] hover:bg-[var(--ca-ink)]/10">
      {children}
    </button>
  )
}
export function ContextMenuSeparator() {
  return <div className="my-1 h-px bg-[var(--ca-ink)]/10" />
}

// -- dialog ------------------------------------------------------------------

interface DialogProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: ReactNode
}
/* The dialog panel's aria-labelledby target — Dialog provides it, DialogTitle consumes it. */
const DialogTitleIdContext = createContext<string>('maia-dialog-title')

export function Dialog({ open = true, onOpenChange, children }: DialogProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const prevFocus = useRef<Element | null>(null)

  useEffect(() => {
    if (!open) return
    // Return focus to whatever opened the dialog.
    prevFocus.current = document.activeElement
    // Initial focus: first focusable control, else the panel itself.
    const panel = panelRef.current
    const target =
      panel?.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? panel
    target?.focus({ preventScroll: true })
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onOpenChange?.(false)
      }
    }
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('keydown', esc, true)
      if (prevFocus.current instanceof HTMLElement) prevFocus.current.focus({ preventScroll: true })
    }
  }, [open, onOpenChange])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-5">
      <div className="absolute inset-0 bg-black/40" onClick={() => onOpenChange?.(false)} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative z-10 w-full max-w-lg rounded-xl bg-[var(--ca-card)] p-5 shadow-xl"
      >
        <DialogTitleIdContext.Provider value={titleId}>{children}</DialogTitleIdContext.Provider>
      </div>
    </div>
  )
}
export function DialogContent({ children }: { children?: ReactNode }) {
  return <>{children}</>
}
export function DialogHeader({ children }: { children?: ReactNode }) {
  return <div className="mb-3">{children}</div>
}
export function DialogTitle({ children }: { children?: ReactNode }) {
  const id = useContext(DialogTitleIdContext)
  return <h2 id={id} className="text-base font-semibold text-[var(--ca-ink)]">{children}</h2>
}
export function DialogDescription({ children }: { children?: ReactNode }) {
  return <p className="mt-1 text-sm text-[var(--ca-ink-muted)]">{children}</p>
}
export function DialogFooter({ children }: { children?: ReactNode }) {
  return <div className="mt-4 flex justify-end gap-2">{children}</div>
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      <DialogFooter>
        <Button onClick={onCancel}>{cancelLabel}</Button>
        <Button variant="primary" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

// -- bounded stubs -----------------------------------------------------------

export function McpTab({ gateway: _gateway }: { gateway?: unknown }) {
  return (
    <EmptyState
      title="MCP servers"
      description="Manage servers from the Plugins button (MCP). The plugin's server list is read-only here."
    />
  )
}

export function ToolsetConfigPanel({ toolset }: { toolset?: string }) {
  return (
    <EmptyState
      title={`${toolset ?? 'Toolset'} configuration`}
      description="Turn this on or off, and connect any account it needs, in Settings → Connections → Skills."
    />
  )
}
