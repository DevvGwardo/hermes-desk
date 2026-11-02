import { createContext, useLayoutEffect, useState, type RefObject } from 'react'
import type { ShellGeometry } from './shell-layout'

export const ShellLayoutContext = createContext<ShellGeometry | null>(null)
export function useShellLayout(root: RefObject<HTMLDivElement | null>): ShellGeometry {
  const [geometry, setGeometry] = useState<ShellGeometry>(() => ({ contentWidth: window.innerWidth, navigationWidth: 240, textScale: 1 }))
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const sidebar = element.querySelector('.hd-sidebar')
    const measure = () => {
      const next = {
        contentWidth: element.getBoundingClientRect().width || window.innerWidth,
        navigationWidth: sidebar?.getBoundingClientRect().width ?? 240,
        textScale: Math.max(1, (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16),
      }
      setGeometry(previous => previous.contentWidth === next.contentWidth && previous.navigationWidth === next.navigationWidth &&
        previous.textScale === next.textScale ? previous : next)
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    if (sidebar) observer?.observe(sidebar)
    const zoom = new MutationObserver(measure)
    zoom.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    window.addEventListener('resize', measure)
    measure()
    return () => { observer?.disconnect(); zoom.disconnect(); window.removeEventListener('resize', measure) }
  }, [root])
  return geometry
}
