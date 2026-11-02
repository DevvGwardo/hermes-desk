import { useSyncExternalStore } from 'react'
import { renderCapture } from '../lib/render-capture'

export function CapturedRenderFailure() {
  const phase = useSyncExternalStore(renderCapture.subscribe, renderCapture.getPhase, renderCapture.getPhase)
  if (phase !== 'failed') return null
  return <details className="w-full max-w-xl text-left">
    <summary>Captured render metadata (memory only)</summary>
    <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(renderCapture.read(), null, 2)}</pre>
    <button type="button" className="mt-2 text-sm underline" onClick={() => renderCapture.clear()}>Clear render capture</button>
  </details>
}
