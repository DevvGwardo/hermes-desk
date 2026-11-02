/**
 * Whether Enter sends from the chat composer.
 *
 * With a real keyboard, Enter sends and Shift+Enter is a new line. A phone
 * keyboard has no Shift+Enter, so there Enter must be a new line (or a long
 * task could never span lines) and the send button sends. "Touch keyboard"
 * means the primary pointer is coarse AND cannot hover: a laptop with a
 * touchscreen, or a tablet with a trackpad, still hovers and keeps Enter.
 */
export const TOUCH_KEYBOARD_MQ = '(pointer: coarse) and (hover: none)'

export function enterSends(): boolean {
  try {
    return !window.matchMedia(TOUCH_KEYBOARD_MQ).matches
  } catch {
    return true
  }
}
