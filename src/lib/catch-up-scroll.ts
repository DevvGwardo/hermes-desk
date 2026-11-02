/**
 * Where the transcript should land when a catch-up batch arrives: rows the
 * server had that this device's cache did not (opening a cached thread that
 * was behind, or a turn from another device landing while the chat is open).
 *
 * Stick-to-bottom used to carry the view straight to the end of the batch,
 * snapping when it was taller than 1.5 viewports, so a long reply that
 * settled while the phone was away appeared already scrolled past its start.
 * A batch that does not fit on screen now lands with its FIRST row near the
 * top of the viewport (messaging-app "unread" behavior); the reader scrolls
 * on from there and the "Latest" pill offers the rest. A batch that fits
 * returns null: normal following brings all of it into view.
 */

/** Gap kept above the first new row so its sender line is not flush. */
export const CATCH_UP_TOP_PAD_PX = 16

export function catchUpScrollTarget(input: {
  /** First new row's top, in scroller content coordinates. */
  rowTop: number
  scrollHeight: number
  clientHeight: number
  /** Current scrollTop: never scroll the reader upward past where they are. */
  scrollTop: number
  pad?: number
}): number | null {
  const pad = input.pad ?? CATCH_UP_TOP_PAD_PX
  const maxScroll = Math.max(0, input.scrollHeight - input.clientHeight)
  const target = Math.max(0, input.rowTop - pad)
  // Everything new fits below the current fold once at the bottom.
  if (target >= maxScroll - 2) return null
  // The first new row is already at/above the top of the view: following
  // to it would move the reader backward.
  if (target <= input.scrollTop) return null
  return target
}
