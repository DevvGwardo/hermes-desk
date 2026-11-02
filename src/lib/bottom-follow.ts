/**
 * Stick-to-bottom that glides instead of hopping.
 *
 * The transcript used to pin by assigning `scrollTop = scrollHeight` whenever
 * content grew. Every streamed line (≈24px) and every arriving message moved
 * the whole transcript in one frame — the "messages jump when they load".
 * Native `scrollTo({ behavior: 'smooth' })` is no fix: each call restarts the
 * animation, so a stream of tokens fought it (C5 in
 * docs/CHAT_LOAD_AND_MOTION_SPEC.md removed it for that reason).
 *
 * This follower eases toward the CURRENT bottom every frame (exponential,
 * τ ≈ 70ms: ~95% of the way in ~200ms). New growth only moves the target, so
 * a stream becomes one continuous glide rather than a series of hops or
 * restarted animations. Big jumps (opening a thread, a jump larger than the
 * viewport) and reduced motion still snap.
 */

const TAU_MS = 70

export interface BottomFollower {
  /** Ease to the bottom (or snap, when `instant()` says so). */
  follow(): void
  /** Jump to the bottom now. */
  snap(): void
  stop(): void
}

export function createBottomFollower(
  el: HTMLElement,
  opts: {
    /** Still allowed to follow (stick-to-bottom armed, no find / jump). */
    canFollow: () => boolean
    /** Snap instead of glide (reduced motion, just opened the thread). */
    instant: () => boolean
  },
): BottomFollower {
  let raf = 0
  let last = 0

  const stop = () => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    last = 0
  }

  const snap = () => {
    stop()
    el.scrollTop = el.scrollHeight
  }

  const step = (t: number) => {
    raf = 0
    if (!opts.canFollow()) {
      last = 0
      return
    }
    const target = el.scrollHeight - el.clientHeight
    const cur = el.scrollTop
    const diff = target - cur
    if (diff <= 0.5) {
      last = 0
      return
    }
    // A jump bigger than the viewport (a long reply landing at once, a big
    // hydrate) would glide through content nobody asked to watch.
    if (diff > el.clientHeight * 1.5) {
      snap()
      return
    }
    const dt = last ? Math.min(t - last, 64) : 16
    last = t
    const move = Math.max(1, diff * (1 - Math.exp(-dt / TAU_MS)))
    el.scrollTop = cur + Math.min(move, diff)
    // Scroll offsets snap to device pixels; if the write did not move us,
    // finish exactly rather than stall a fraction short of the bottom.
    if (el.scrollTop === cur) {
      el.scrollTop = target
      last = 0
      return
    }
    raf = requestAnimationFrame(step)
  }

  const follow = () => {
    if (opts.instant() || typeof requestAnimationFrame !== 'function') {
      snap()
      return
    }
    if (!raf) raf = requestAnimationFrame(step)
  }

  return { follow, snap, stop }
}
