import type { Transition } from 'framer-motion'

/** Shared nubapp v2 motion presets — honour reduced motion at call sites. */
export const pageEase = [0.22, 1, 0.36, 1] as const

/** Fast overlay tween — springs + backdrop-blur made every modal feel heavy. */
export const modalTween: Transition = {
  duration: 0.12,
  ease: [0.2, 0.8, 0.2, 1],
}

/** Dialog open: a short ease-out (expo-like) so the panel lands quickly and
 *  settles, with a small scale + rise. Close is faster and ease-in: leaving
 *  should never hold the user up. Tweens, not springs (see modalTween). */
export const modalEnter: Transition = {
  duration: 0.22,
  ease: [0.16, 1, 0.3, 1],
}

export const modalExit: Transition = {
  duration: 0.14,
  ease: [0.4, 0, 1, 1],
}

export const softTap = {
  whileHover: { scale: 1.03 },
  whileTap: { scale: 0.92 },
}
