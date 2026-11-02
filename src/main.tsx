import { StrictMode, lazy, Suspense, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { isHudWindow } from './lib/hud'
import { initTheme } from './lib/theme'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useViewerState } from './lib/image-viewer'

const App = lazy(() => import('./App'))
const HudShell = lazy(() => import('./components/HudShell').then((m) => ({ default: m.HudShell })))
const ImageViewerHost = lazy(() => import('./components/ImageViewer').then((m) => ({ default: m.ImageViewerHost })))

function ImageViewerMount() {
  const open = useViewerState() !== null
  const [wanted, setWanted] = useState(false)
  if (open && !wanted) setWanted(true)
  return wanted ? <Suspense fallback={null}><ImageViewerHost /></Suspense> : null
}

initTheme()
// A saved design preset layers on top of the theme; skip the HUD window, which
// paints its own chrome. Loaded on demand: the preset tables + validator are
// ~11 kB and the boot entry has a hard byte budget.
if (!isHudWindow()) {
  void import('./lib/design-preset').then((module) => module.initDesign()).catch(() => {})
}

function Root() {
  if (isHudWindow()) {
    document.documentElement.setAttribute('data-hud', '')
    return <Suspense fallback={null}><HudShell /></Suspense>
  }
  return (
    <Suspense fallback={<div role="status" aria-label="Loading Hermes Desk">Loading Hermes Desk…</div>}>
      <App />
      <ImageViewerMount />
    </Suspense>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ErrorBoundary><Root /></ErrorBoundary></StrictMode>,
)
