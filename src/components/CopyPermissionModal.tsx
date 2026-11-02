import { useEffect, useRef } from 'react'
import type { CopyPermissionChoice } from '../lib/copy-permission'
import { hostMachinePhrase } from '../lib/host-label'

interface CopyPermissionModalProps {
  open: boolean
  detail?: string
  onChoice: (choice: CopyPermissionChoice) => void
  onDismiss: () => void
}

/** Grok CopyToBox / CopyFromBox gate: Once / Always / Never. */
export function CopyPermissionModal({ open, detail, onChoice, onDismiss }: CopyPermissionModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Escape dismisses the gate — keyboard users otherwise have no way out.
  // Tab is trapped inside the dialog: with aria-modal="true" the background
  // is hidden from assistive tech, so focus must not leak into it (same
  // behavior as AppModal).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDismiss()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
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
  }, [open, onDismiss])

  // Move focus into the dialog when it opens; restore it when it closes.
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => prev?.focus()
  }, [open])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-6 sm:items-center">
      <button type="button" className="nub-scrim absolute inset-0" aria-label="Dismiss" onClick={onDismiss} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Copy files to the agent computer"
        className="nub-overlay relative w-full max-w-md rounded-2xl px-4 py-3 shadow-2xl outline-none"
      >
        <p className="text-sm font-medium text-[var(--ca-ink)]">
          Allow copying files between {hostMachinePhrase()} and the agent computer?
        </p>
        {detail ? (
          <p className="mt-1 text-[11px] text-[var(--ca-ink-muted)]">{detail}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <button type="button" className="nub-btn-primary px-2.5 py-1 text-[11px]" onClick={() => onChoice('always')}>
            Always
          </button>
          <button
            type="button"
            className="rounded-full border border-[var(--ca-border)] px-2.5 py-1 text-[11px] text-[var(--ca-ink)] hover:bg-[var(--ca-hover)]"
            onClick={() => onChoice('once')}
          >
            Once
          </button>
          <button
            type="button"
            className="rounded-full px-2.5 py-1 text-[11px] text-[var(--ca-ink-muted)] hover:text-[var(--ca-ink)]"
            onClick={() => onChoice('never')}
          >
            Never
          </button>
        </div>
      </div>
    </div>
  )
}
