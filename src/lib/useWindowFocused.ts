import { useEffect, useState } from 'react'

/**
 * Tracks window focus so heavy animations (the 60fps orb engines) can pause
 * when the app is in the background. Cheap: one blur/focus/visibility listener.
 *
 * Does not gate input, scrolling, or sending — callers must only pass the
 * result into orb `paused` / `still`.
 */
export function useWindowFocused(): boolean {
  // Electron often reports hasFocus() === false during the first paint even
  // when the window is frontmost (the focus event already fired). Start true
  // and only honor a positive hasFocus() on mount — never freeze every orb
  // because the renderer woke up unfocused.
  const [focused, setFocused] = useState(true)
  useEffect(() => {
    const onFocus = () => setFocused(true)
    const onBlur = () => {
      // Android WebView fires window.blur while the APK is still on screen
      // (keyboard, status bar, orb canvas). Only pause when actually hidden.
      if (document.visibilityState !== 'hidden') return
      if (document.hasFocus()) return
      setFocused(false)
    }
    const onVisibility = () => {
      setFocused(document.visibilityState !== 'hidden')
    }
    if (document.hasFocus()) setFocused(true)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
  return focused
}
