import { useEffect, useState } from 'react'
import { AgentMascot } from './AgentMascot'

/** Same Pip silhouette as the static splash, with motion once React loads. */
const BOOT_ORB_PX = 96

/**
 * Exit choreography, in ms. Sync contract with the `.nub-boot-orb*` block in
 * index.css — change a number here and mirror it there (and vice versa):
 *
 * nub-boot-orb-timing-sync: DROP_MS=380 IRIS_DELAY_MS=260 IRIS_MS=680 UNMOUNT_MS=960
 *
 * Invariant: UNMOUNT_MS >= IRIS_DELAY_MS + IRIS_MS (960 >= 940). The mascot
 * squashes, then drops away into the middle of the screen (shrinks to
 * nothing in place) while the canvas holds; at IRIS_DELAY_MS a circular hole
 * opens from the mascot outward and reveals the app underneath. Same beat as
 * the nub.lol waitlist intro (hermes-deploy nub-intro.tsx). JS only
 * schedules the unmount — every visual lives in CSS.
 */
const UNMOUNT_MS = 960

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * Boot overlay: Pip thinks center-screen while
 * the shell resolves its first data, then — when `visible` goes false — it
 * drops away and irises open onto the app.
 *
 * It follows index.html's static .nub-splash and main.tsx's BootSplash (the
 * 72px app icon) on the same canvas colours, so the chain has no colour jump.
 * Unmounted once the exit ends: the mascot runs a requestAnimationFrame loop,
 * so a merely invisible overlay would keep animating for the whole session.
 */
export function BootOrbSplash({ visible }: { visible: boolean }) {
  const [mounted, setMounted] = useState(visible)
  useEffect(() => {
    if (visible) {
      setMounted(true)
      return
    }
    // Reduced motion drops the drop + iris (index.css), so leave at once.
    const t = window.setTimeout(() => setMounted(false), prefersReducedMotion() ? 0 : UNMOUNT_MS)
    return () => window.clearTimeout(t)
  }, [visible])
  if (!mounted) return null
  const leaving = !visible
  return (
    <div
      className={`nub-boot-orb${leaving ? ' nub-boot-orb--leaving' : ''}`}
      role={leaving ? undefined : 'status'}
      aria-label={leaving ? undefined : 'Loading Hermes Desk'}
      aria-hidden={leaving}
      data-testid="boot-splash"
      style={{ background: 'var(--desk-surface-0, #0e0e10)' }}
    >
      <span className={`nub-boot-orb-mark${leaving ? ' nub-boot-orb-mark--drop' : ''}`}>
        <AgentMascot agentId="default" presence="thinking" size={BOOT_ORB_PX} title="Pip" />
      </span>
    </div>
  )
}
