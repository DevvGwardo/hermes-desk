import { useEffect, useRef } from 'react'
import { getWorkspaceBridge } from '../../lib/desktop-bridge'
import type { Rect } from '../../lib/desktop-bridge'
import '../../styles/workspace.css'

export interface WorkspaceViewportProps {
  visible?: boolean
  onError?: () => void
}

export function WorkspaceViewport({ visible = true, onError }: WorkspaceViewportProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const bridge = getWorkspaceBridge()
    const element = root.current
    if (!bridge || !element) return
    let frame: number | null = null
    let mounted = true
    let lastRect: Rect | null | undefined
    let lastVisible: boolean | undefined

    function send(action: () => Promise<void>) {
      try {
        void action().catch(() => { if (mounted) onError?.() })
      } catch {
        if (mounted) onError?.()
      }
    }

    function report() {
      frame = null
      if (!mounted) return
      const bounds = element!.getBoundingClientRect()
      const shown = visible && document.visibilityState !== 'hidden' && bounds.width > 0 && bounds.height > 0
      const rect = shown ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null
      if (lastRect === undefined || JSON.stringify(lastRect) !== JSON.stringify(rect)) {
        lastRect = rect
        send(() => bridge!.setBounds(rect))
      }
      if (lastVisible !== shown) {
        lastVisible = shown
        send(() => bridge!.setVisible(shown))
      }
    }

    function schedule() {
      if (frame === null) frame = requestAnimationFrame(report)
    }

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(element)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    document.addEventListener('visibilitychange', schedule)
    schedule()

    return () => {
      mounted = false
      if (frame !== null) cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      document.removeEventListener('visibilitychange', schedule)
      send(() => bridge.setVisible(false))
      send(() => bridge.setBounds(null))
    }
  }, [visible, onError])

  // Page pixels belong exclusively to main's native WebContentsView.
  return <div className="workspace-viewport" ref={root} role="region" aria-label="Native browser viewport" />
}
