import { useEffect, useState } from 'react'
import { AgentMascot } from './AgentMascot'

/**
 * TopBar affordance for the floating HUD orb.
 *
 * Before this existed, the orb was reachable only through an unlisted global
 * hotkey (⌘⇧H) or by typing "HUD" into the command palette — so most users
 * never met the cat, and closing the strip (the × in HudShell) destroyed the
 * window with no visible way back.
 *
 * Two rules keep this honest:
 *
 *  - State is READ from main (hud.isOpen() on mount, then the
 *    maia:hud:changed broadcast), never tracked locally. A toggle that kept
 *    its own counter would drift the moment the hotkey or the Window menu
 *    moved the HUD behind its back.
 *  - One click = one invoke = one toggle in main. The renderer deliberately
 *    owns no ⌘⇧H handler (see the note in App.tsx): two owners of the same
 *    toggle meant the orb could open but never close, because the second
 *    call re-created the window the first one had just closed.
 *
 * Renders nothing without the desktop bridge (hosted web / phone shell), so
 * it can never appear as a dead control.
 */
export function HudOrbButton() {
  const bridge = typeof window !== 'undefined' ? window.nubAgent?.hud : undefined
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    // Seed from main: the orb may already be up (hotkeyed from another app)
    // long before this button mounts.
    void Promise.resolve(bridge.isOpen?.())
      .then((isOpen) => {
        if (!cancelled) setOpen(Boolean(isOpen))
      })
      .catch(() => {
        /* bridge gone — stay unpressed rather than lying */
      })
    const off = bridge.onChanged?.((v) => {
      if (v && typeof v.open === 'boolean') setOpen(v.open)
    })
    return () => {
      cancelled = true
      if (typeof off === 'function') off()
    }
  }, [bridge])

  // No bridge = web or phone shell = no orb to open. Returning null here is
  // what keeps this from ever being a dead control in the hosted web build.
  if (!bridge) return null

  const hotkey = window.nubAgent?.platform === 'darwin' ? '⌘⇧H' : 'Ctrl+Shift+H'
  const label = open ? 'Hide Nub orb' : 'Show Nub orb'

  return (
    <button
      type="button"
      data-testid="hud-orb-toggle"
      data-hud-open={open ? '' : undefined}
      aria-pressed={open}
      aria-label={label}
      title={`${label} (${hotkey})`}
      onClick={() => {
        void bridge.toggle?.()
      }}
      className={
        'flex h-8 w-8 items-center justify-center rounded-full border transition ' +
        (open
          ? 'border-[var(--ca-primary)]/40 bg-[var(--ca-primary)]/10 text-[var(--ca-primary-text)]'
          : 'border-[var(--ca-border)] text-[var(--ca-ink-muted)] hover:border-[var(--ca-primary)]/30 hover:text-[var(--ca-ink)]')
      }
    >
      <AgentMascot agentId="" presence="idle" size={20} reducedMotion />
    </button>
  )
}
